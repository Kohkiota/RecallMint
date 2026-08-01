// crop-and-store — 単一 figure の server crop + R2 条件付き PUT + assets 行 +
// asset_derivations provenance 保存。②-4a Task 10(docs/superpowers/specs/
// 2026-07-30-ocr-2-4a-image-figure-crop-design.md §7.3/§10・Global Constraint)。
//
// スコープ(brief 明記): 1 figure を crop して保存する「原子的な単位操作」のみ。
// prepared_payload 全体を走査して figure を列挙する orchestration(source_id →
// source_assets 解決を含む fan-out・publish への配線)は T12 の責務(本 file は
// 呼ばない・呼ばれない)。
//
// PURE ではない(lib/media/domain/ に置かない理由): R2 I/O(GET/PUT)・sharp
// decode/encode・DB 書込(withTenantTx)を行う usecase 層。crop-geometry.ts
// (T9・pure)の座標算術のみを呼ぶ。
//
// なぜ「operation status='prepared' 確認」を本 file 自身が行うか(Global
// Constraint「crop-derived asset は prepared commit 後のみ」): 呼出側(将来の
// T12)を信用せず、本関数自身が入口で保証する — 呼出側のバグで prepared 前に
// 呼ばれても構造的に何も作らない。T12 の publish fencing(lease_version CAS)を
// 代替するものではない(そちらが最終的な正しさの gate — 本チェックは「prepared
// commit より前に crop 資産を作らない」という時系列順序のみを保証する単発の
// 事前確認であり、確認後に operation が状態遷移しても再チェックしない。次点の
// 権威 gate は T12)。

import 'server-only'

import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { and, eq } from 'drizzle-orm'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { assets, assetDerivations, sourceAssets, uploadOperations } from '@/lib/db/schema'
import { getObject, putObject } from '@/lib/storage/r2'
import { logger } from '@/lib/logger'
import { toCropRect, type Box2d, type CropRect } from './domain/crop-geometry'

// ---------------------------------------------------------------------------
// decode bomb 防御(app/(app)/app/upload/_lib/source-image-verify.ts の
// DECODE_MAX_PIXELS と同値・同根拠)。 lib/ は app/ を import できない
// (eslint Block A: LIB_NO_APP_IMPORTS)ため値を再定義する — レイヤー境界を跨ぐ
// import はできず、rule of three(簡潔性規律)は同一レイヤー内の重複にのみ適用
// されるため、この重複は意図的(層境界を跨ぐ定数は複製し、コメントで出典を残す)。
// ---------------------------------------------------------------------------
const CROP_DECODE_MAX_PIXELS = 40_000_000

// ---------------------------------------------------------------------------
// webp 出力の固定パラメータ(制約#3: quality/lossless は FIXED constants)。
// 同一 source + 同一 crop rect から常に同一バイト列を生成する(retry の
// re-PUT が idempotent である前提)ためには、これらの値が実行のたびに変わらない
// ことが必須 — 実際の数値の最適性そのものは本 task の範囲外(将来値を変える場合は
// CROP_PIPELINE_VERSION を上げて provenance に区別を残す)。
// quality=90: 試験問題の図版は文字・線画を含み判読性が重要なため sharp 既定値
// (80)より高めに設定。lossless=false: 可逆はファイルサイズが数倍に膨らむため
// 不採用(スキャン画像は lossy でも実用上の劣化は小さい)。
// ---------------------------------------------------------------------------
const CROP_WEBP_QUALITY = 90
const CROP_WEBP_LOSSLESS = false

// この crop pipeline の識別子(asset_derivations.pipeline_version)。 decode
// (auto-rotate 禁止)/ extract(toCropRect 由来の整数 px rect)/ webp encode
// (quality/lossless 固定)の組み合わせを指す。 これらのいずれかを変更する場合は
// 値を上げる(過去の provenance 行との区別のため)。
export const CROP_PIPELINE_VERSION = 'crop-v1'

export interface CropFigureInput {
  userId: string
  operationId: string
  // prepared payload の figure.sourceId(source_assets.source_id と照合)。
  sourceId: string
  // prepared payload の figure.assetId(UUIDv4・stage 時発行済 — 新規 assets 行の
  // PK になる。retry は同じ値を渡すことで同一 object key に収束する)。
  figureAssetId: string
  box2d: Box2d
  // 解決済み target 文字列(question_text / explanation_text / option:<uid>)。
  // asset_derivations.detect_target にそのまま保存する(spec §13 の語彙)。
  detectTarget: string
}

export type CropAndStoreOutcome =
  | { outcome: 'stored' }
  | { outcome: 'reused' }
  // toCropRect が退化と判定(null)、または sharp extract が対象領域を画像外と
  // 判定して throw した(spec §16 の「crop失敗」計上対象・T16 が集計)。
  | { outcome: 'crop_failed' }
  // operation が見つからない / 他 user 所有 / status !== 'prepared'。
  | { outcome: 'not_prepared' }
  // 対応する source_assets 行が見つからない、または status !== 'ready'
  // (claim/stage 後の GC/GDPR race・通常は到達しない防御的分岐)。
  | { outcome: 'source_not_ready' }
  // source object の R2 GET が失敗(never-throw 契約の null 正規化を受けた)。
  | { outcome: 'source_unreadable' }
  // 412 + 実体 hash 不一致(同一 key に別内容が書き込まれている・データ破損 or
  // バグ)。 loud fail — 自分の metadata を書かない。
  | { outcome: 'hash_mismatch' }
  // 412 + 既存 assets 行が deleting|deleted(GC 回収確定済 — 復活させない)。
  | { outcome: 'forbidden' }
  // R2 PUT の技術的失敗、または既存行が ready/deleting/deleted のいずれでもない
  // 未知の status(crop-derived asset は常に 'ready' で INSERT するため到達しない
  // 想定・防御的 fail-closed)。
  | { outcome: 'error' }

// ---------------------------------------------------------------------------
// Important#2 fix(canonical 指摘): T12 が「全 figure 終端」を判定するために
// 各 outcome を再試行してよいか/確定として計上してよいかを知る必要がある。
// ここでは事実の分類のみを提供する(retry engine・backoff policy は実装しない
// — それは T12/T14 の責務・YAGNI)。
//
// - success: この figure の crop は完了している('reused' も「既に完了済」を
//   意味するため success 扱い)。
// - terminal: 同じ入力(同一 figureAssetId/box2d/source)を再試行しても状態は
//   変わらない(figure 単位で確定的に crop できない、またはしてはいけない)。
//   spec §16 の「crop失敗」等の計上対象(T16 が集計)。
// - retryable: 一時的な外部要因(R2 の技術的失敗)。 再試行で成功しうる。
// - caller_error: 呼出前提(operation/source の状態)が満たされていない —
//   crop 自体の失敗ではなく、呼出側(T12)が別途正しく扱うべき state/race。
// ---------------------------------------------------------------------------
export type CropOutcomeClass = 'success' | 'terminal' | 'retryable' | 'caller_error'

export const CROP_OUTCOME_CLASS: Record<CropAndStoreOutcome['outcome'], CropOutcomeClass> = {
  stored: 'success',
  reused: 'success',
  crop_failed: 'terminal',
  forbidden: 'terminal',
  hash_mismatch: 'terminal',
  source_unreadable: 'retryable',
  error: 'retryable',
  not_prepared: 'caller_error',
  source_not_ready: 'caller_error',
}

export function classifyCropOutcome(outcome: CropAndStoreOutcome['outcome']): CropOutcomeClass {
  return CROP_OUTCOME_CLASS[outcome]
}

// ---------------------------------------------------------------------------
// CropRect.origBbox/clampedBbox は tuple(制約#7: jsonb 列は Record<string,
// unknown> 型)。 Gemini/検出ドメインの語彙(box_2d = [y_min, x_min, y_max,
// x_max])をそのまま key 名にした object へ変換するだけ — 値の再計算はしない
// (toCropRect の戻り値をそのまま構造変換するのみ)。
// ---------------------------------------------------------------------------
function box2dToJsonb(box: Box2d): Record<string, unknown> {
  const [yMin, xMin, yMax, xMax] = box
  return { y_min: yMin, x_min: xMin, y_max: yMax, x_max: xMax }
}

type SourceInfo = { id: string; objectKey: string; width: number; height: number }

type GuardResult =
  | { outcome: 'ok'; source: SourceInfo }
  | { outcome: 'not_prepared' }
  | { outcome: 'source_not_ready' }

// operation status='prepared' 確認 + source_assets(sourceDocumentId 経由)解決を
// 1 read-only tx にまとめる(いずれも guard であり CAS/FOR UPDATE は不要 — 権威的な
// fencing は T12 publish の役割。 ここでの読取は「時系列順序の事前確認」)。
async function loadPreparedSource(
  userId: string,
  operationId: string,
  sourceId: string,
): Promise<GuardResult> {
  return withTenantTx(userId, async (tx) => {
    const opRows = await tx
      .select({
        status: uploadOperations.status,
        sourceDocumentId: uploadOperations.sourceDocumentId,
      })
      .from(uploadOperations)
      .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, userId)))

    const op = opRows[0]
    if (!op || op.status !== 'prepared' || op.sourceDocumentId === null) {
      return { outcome: 'not_prepared' }
    }

    const srcRows = await tx
      .select({
        id: sourceAssets.id,
        objectKey: sourceAssets.objectKey,
        width: sourceAssets.width,
        height: sourceAssets.height,
        status: sourceAssets.status,
      })
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.sourceDocumentId, op.sourceDocumentId),
          eq(sourceAssets.sourceId, sourceId),
          eq(sourceAssets.userId, userId),
        ),
      )

    const src = srcRows[0]
    // width/height は 'ready' なら finalize(T5)が同時確定させた非 null 値のはず
    // (schema 上は nullable — 防御的に null も未 ready 扱いする)。
    if (!src || src.status !== 'ready' || src.width === null || src.height === null) {
      return { outcome: 'source_not_ready' }
    }

    return {
      outcome: 'ok',
      source: { id: src.id, objectKey: src.objectKey, width: src.width, height: src.height },
    }
  })
}

type WriteOutcome =
  | { outcome: 'stored' }
  | { outcome: 'reused' }
  | { outcome: 'hash_mismatch' }
  | { outcome: 'forbidden' }
  | { outcome: 'error' }

// Important#1 fix(canonical+Codex 独立指摘・concurrent double-invocation race):
// 2 つの呼出が同じ figureAssetId を並行処理しうる(例: T12 の lease-takeover で
// 同一 operation+payload を 2 worker が跨って処理した場合、両方が同じ
// figureAssetId 集合を持つ)。 呼出前の SELECT(412 分岐の existingRows チェック
// 等)は TOCTOU を閉じない — この INSERT 文自体で race-safe にする。
//
// `ON CONFLICT (id) DO NOTHING` + `RETURNING`(try/catch でなくこちらを選ぶ理由:
// race-safe だが Postgres error code(23505)に依存しない・DB 方言に閉じた
// 標準的な idempotent insert パターン)。 0 行 = 別の並行呼出が先に確定させた
// (or 既存行が何らかの理由で残っている)ため、412 分岐(呼出元)と全く同じ
// 意味論を適用する: hash 不一致は状態に関わらず最優先 loud fail / ready+一致=
// reused(この場合 asset_derivations は INSERT しない — 既に完了済のはず)/
// deleting|deleted=forbidden / それ以外は fail-closed。
//
// **重要な区別**: plan の Global Constraint「cards に ON CONFLICT 不使用・重複は
// loud fail」は publish tx の cards 行に対するものであり、crop-derived
// **assets** には適用されない — figureAssetId は同一 figure(同一 source+box2d)
// に対して 1 対 1 に決定的に定まるため、conflict は「同一内容の正当な再試行」
// であり意図的に idempotent 再利用可能(既存の 412 分岐と対称的な設計)。
async function writeCropAssetRows(
  userId: string,
  objectKey: string,
  bytes: Buffer,
  hash: string,
  rect: CropRect,
  sourceAssetId: string,
  figureAssetId: string,
  detectTarget: string,
): Promise<WriteOutcome> {
  return withTenantTx(userId, async (tx) => {
    const inserted = await tx
      .insert(assets)
      .values({
        id: figureAssetId,
        userId,
        objectKey,
        mime: 'image/webp',
        byteSize: bytes.length,
        width: rect.cropW,
        height: rect.cropH,
        hash,
        status: 'ready',
        readyAt: new Date(),
      })
      .onConflictDoNothing({ target: assets.id })
      .returning({ id: assets.id })

    if (inserted.length === 0) {
      // conflict: 別の並行呼出(or 何らかの理由の既存行)が先に確定していた。
      // 412 分岐と同じ判定を、実際に確定した行に対して適用する。
      const existingRows = await tx
        .select({ status: assets.status, hash: assets.hash })
        .from(assets)
        .where(and(eq(assets.id, figureAssetId), eq(assets.userId, userId)))
      const existing = existingRows[0]

      if (!existing) {
        // ON CONFLICT が発火した(=衝突する行が存在した)のに同一 tx 内の
        // 直後 SELECT で見えない、は通常起きない(RLS/owner scope の不一致等)
        // — fail-closed。
        logger.warn({ event: 'ocr.crop.conflict_row_not_found', assetId: figureAssetId })
        return { outcome: 'error' }
      }
      if (existing.hash !== hash) {
        logger.warn({ event: 'ocr.crop.insert_conflict_hash_mismatch', assetId: figureAssetId })
        return { outcome: 'hash_mismatch' }
      }
      if (existing.status === 'ready') {
        return { outcome: 'reused' }
      }
      if (existing.status === 'deleting' || existing.status === 'deleted') {
        logger.warn({ event: 'ocr.crop.insert_conflict_forbidden', assetId: figureAssetId })
        return { outcome: 'forbidden' }
      }
      logger.warn({
        event: 'ocr.crop.insert_conflict_unexpected_status',
        assetId: figureAssetId,
        status: existing.status,
      })
      return { outcome: 'error' }
    }

    await tx.insert(assetDerivations).values({
      assetId: figureAssetId,
      userId,
      sourceAssetId,
      // 制約#2/#7: toCropRect の戻り値(rect)からのみ導出する — 独立再計算しない。
      origBbox: box2dToJsonb(rect.origBbox),
      paddingPct: rect.paddingPct,
      clampedBbox: box2dToJsonb(rect.clampedBbox),
      cropW: rect.cropW,
      cropH: rect.cropH,
      detectTarget,
      pipelineVersion: CROP_PIPELINE_VERSION,
    })
    return { outcome: 'stored' }
  })
}

/**
 * 1 figure を crop して保存する(spec §7.3/§10・制約#1-9 準拠)。
 *
 * 手順: ① operation status='prepared' 確認 + source_assets 解決(guard read)
 * ② R2 GET(source の実バイト取得)③ toCropRect(T9・pure・唯一の rect 算出点)
 * ④ sharp decode(auto-rotate 禁止・limitInputPixels)→ extract(rect そのもの)
 * → webp encode(quality/lossless 固定)⑤ 条件付き PUT(If-None-Match: *)
 * ⑥ 412 なら HEAD 相当(GET)+ SHA-256 照合 → 分岐(制約#5)⑦ assets +
 * asset_derivations を 1 tx で INSERT(status='ready' で直接確定 — crop-derived
 * asset に reserved 状態は存在しない)。
 *
 * 決定性(制約#3): figureAssetId・box2d・sourceId は prepared_payload に固定
 * 済み(stage 時 UUIDv4 発行・retry 再利用)。 source の実バイトは finalize
 * (T5)後 immutable。 sharp は auto-rotate しない(.rotate() を一切呼ばない —
 * sharp は明示 `.rotate()` 呼び出し時のみ EXIF Orientation を見て
 * autoOrient() を行う仕様であり、呼ばなければ EXIF に関わらずデコード時の
 * 生ピクセル配置のまま出力される。 T5 finalize の寸法検証も同じ「.rotate() を
 * 呼ばない」decode 経路のため、box_2d の座標系(decoded 寸法基準)と一致する)。
 * .withMetadata() も呼ばない(既定で EXIF/ICC 等の可変メタデータを出力に
 * 含めない — 出力バイトが画素データのみで決まる)。 webp の quality/lossless は
 * 上記モジュール定数で固定。 これらにより同一入力から常に同一バイト列が
 * 生成され、conditional PUT の再試行が idempotent に機能する。
 */
export async function cropFigureAndStore(input: CropFigureInput): Promise<CropAndStoreOutcome> {
  const { userId, operationId, sourceId, figureAssetId, box2d, detectTarget } = input

  const guard = await loadPreparedSource(userId, operationId, sourceId)
  if (guard.outcome !== 'ok') return { outcome: guard.outcome }
  const { source } = guard

  const srcObj = await getObject(source.objectKey)
  if (srcObj === null) {
    logger.warn({ event: 'ocr.crop.source_unreadable', figureAssetId, sourceId })
    return { outcome: 'source_unreadable' }
  }

  // 制約#2: この 1 回の toCropRect 呼出の戻り値だけを、以降 sharp extract の
  // 入力と asset_derivations の監査メタの両方に使う(再計算・再導出しない)。
  const rect = toCropRect(box2d, source.width, source.height)
  if (rect === null) return { outcome: 'crop_failed' }

  let cropBytes: Buffer
  try {
    cropBytes = await sharp(srcObj.bytes, { limitInputPixels: CROP_DECODE_MAX_PIXELS })
      .extract({ left: rect.left, top: rect.top, width: rect.cropW, height: rect.cropH })
      .webp({ quality: CROP_WEBP_QUALITY, lossless: CROP_WEBP_LOSSLESS })
      .toBuffer()
  } catch {
    // corrupt source / limitInputPixels 超過 / extract 領域が画像外(丸め等の
    // 極端な境界ケース)。 toCropRect 自体は退化を null で弾いているが、 sharp
    // 側の実際の decode 結果に対する最終防御として catch する。
    logger.warn({ event: 'ocr.crop.sharp_pipeline_failed', figureAssetId, sourceId })
    return { outcome: 'crop_failed' }
  }

  const contentHash = createHash('sha256').update(cropBytes).digest('hex')
  const objectKey = `users/${userId}/${figureAssetId}.webp`

  const putResult = await putObject(objectKey, cropBytes, 'image/webp', { ifNoneMatch: true })

  if (putResult === 'error') return { outcome: 'error' }

  if (putResult === 'precondition_failed') {
    // 既に同じ key が存在する(このバイトの初回書込ではない)。 実体を取得し
    // hash 照合してから分岐する(制約#5)。
    const existing = await getObject(objectKey)
    if (existing === null) {
      logger.warn({ event: 'ocr.crop.precondition_get_failed', assetId: figureAssetId })
      return { outcome: 'error' }
    }
    const existingHash = createHash('sha256').update(existing.bytes).digest('hex')

    if (existingHash !== contentHash) {
      // 不一致は状態に関わらず最優先の loud fail(brief 記載順どおり)—
      // 同一 key に別内容が存在するのは決定的パイプラインの前提が破れている。
      logger.warn({ event: 'ocr.crop.hash_mismatch', assetId: figureAssetId })
      return { outcome: 'hash_mismatch' }
    }

    const existingRows = await withTenantTx(userId, (tx) =>
      tx
        .select({ status: assets.status })
        .from(assets)
        .where(and(eq(assets.id, figureAssetId), eq(assets.userId, userId))),
    )
    const existingAsset = existingRows[0]

    if (existingAsset) {
      if (existingAsset.status === 'ready') {
        // hash 一致 + ready = このバイトの保存は既に完了済み(assets +
        // asset_derivations とも完了している前提 — 本 pipeline は両者を同一 tx
        // で確定するため、ready ならどちらも存在する)。 再書込不要。
        return { outcome: 'reused' }
      }
      if (existingAsset.status === 'deleting' || existingAsset.status === 'deleted') {
        // GC 回収確定後の asset id を復活させない(制約#5)。
        logger.warn({ event: 'ocr.crop.forbidden_deleted_asset', assetId: figureAssetId })
        return { outcome: 'forbidden' }
      }
      // crop-derived asset は常に 'ready' で直接 INSERT する設計(reserved 経由
      // なし)ため、他の status は到達しない想定 — fail-closed。
      logger.warn({
        event: 'ocr.crop.unexpected_asset_status',
        assetId: figureAssetId,
        status: existingAsset.status,
      })
      return { outcome: 'error' }
    }
    // hash 一致 + 行が存在しない = crash-recovery(前回試行が R2 PUT 成功後・
    // DB INSERT 前に中断した)。 バイトは既に正しく R2 にあるため、そのまま
    // 下の INSERT へ進む(cropBytes は自分が算出したもの = existing と
    // byte-identical であることを hash 一致で確認済み)。
  }

  return writeCropAssetRows(
    userId,
    objectKey,
    cropBytes,
    contentHash,
    rect,
    source.id,
    figureAssetId,
    detectTarget,
  )
}
