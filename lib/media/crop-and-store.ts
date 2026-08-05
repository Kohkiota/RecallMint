// crop-and-store — 単一 figure の server crop + R2 条件付き PUT + assets 行 +
// asset_derivations provenance 保存。②-4a Task 10(docs/superpowers/specs/
// 2026-07-30-ocr-2-4a-image-figure-crop-design.md §7.3/§10・Global Constraint)。
//
// スコープ: 1 figure を crop して保存する「原子的な単位操作」のみ。prepared_payload
// 全体を走査して figure を列挙する orchestration は呼出元
// (app/(app)/app/upload/_lib/upload-pipeline.ts の crop phase)の責務。
//
// PURE ではない(lib/media/domain/ に置かない理由): R2 I/O(PUT + 412 時の GET)・
// sharp decode/encode・DB 書込(withTenantTx)を行う usecase 層。crop-geometry.ts
// (T9・pure)の座標算術のみを呼ぶ。
//
// 「crop-derived asset は prepared_payload commit 後にのみ作る」という時系列の
// 不変条件(Global Constraint)は、**呼出元の phase 順序**が担保する — S-5 の旧経路
// 撤去で、operation を読んで status='prepared' を確認していた旧 entry
// (`cropFigureAndStore`)ごと無くなった。最終的な正しさの gate は publish tx の
// fencing(`publishPreparedUploadTx` の lease_version CAS)であり、それは不変。

import 'server-only'

import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { and, eq } from 'drizzle-orm'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { assets, assetDerivations } from '@/lib/db/schema'
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

// T14a fix round 2(Codex P2#2・spec §11 deadline): hard CPU-time bound on the
// sharp pipeline itself. The crop-phase caller (upload-pipeline.ts) only checks
// the remaining time budget BEFORE starting a
// crop (soft pre-crop gate via `CROP_MIN_REMAINING_MS`) — without a hard cap
// on the pipeline that already started, a single pathological decode/extract/
// encode could still run past the operation's crop-phase deadline. `.timeout()`
// makes libvips itself abort processing after N seconds (throws an error
// containing "timeout", caught by the existing try/catch below and mapped to
// `crop_failed` — no new outcome variant needed). Provisional value —
// revisit after cutover measurement (2026-08-02 OT: don't pre-tune time
// budgets before real usage data).
const CROP_SHARP_TIMEOUT_SEC = 30

// この crop pipeline の識別子(asset_derivations.pipeline_version)。 decode
// (auto-rotate 禁止)/ extract(toCropRect 由来の整数 px rect)/ webp encode
// (quality/lossless 固定)の組み合わせを指す。 これらのいずれかを変更する場合は
// 値を上げる(過去の provenance 行との区別のため)。
export const CROP_PIPELINE_VERSION = 'crop-v1'

// ②-4a 単一 invocation 経路(spec 2026-08-04 §2・Task S-3)の crop 入力。
// source は R2 に置かず、request body で受け取ったバイトを invocation のメモリの
// まま crop する。
export interface CropFigureFromBufferInput {
  userId: string
  // decode 検証済みの source 実バイト(呼出元が保持しているもの)。
  sourceBytes: Buffer
  // decode 済み source の寸法 = box_2d(0-1000 正規化)を px へ戻す分母。
  // 呼出元の decode 結果由来(client 申告値ではない)。
  sourceWidth: number
  sourceHeight: number
  // prepared payload の figure.sourceId。本 entry では DB 解決に使わず log にのみ
  // 出す(どの source 画像で失敗したかの forensics)。
  sourceId: string
  figureAssetId: string
  box2d: Box2d
  detectTarget: string
}

export type CropAndStoreOutcome =
  | { outcome: 'stored' }
  | { outcome: 'reused' }
  // toCropRect が退化と判定(null)、または sharp extract が対象領域を画像外と
  // 判定して throw した(spec §16 の「crop失敗」計上対象・T16 が集計)。
  | { outcome: 'crop_failed' }
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
// Important#2 fix(canonical 指摘): 呼出元が「この figure を完了として計上して
// よいか」を判定するための分類。ここでは事実の分類のみを提供する(retry engine・
// backoff policy は実装しない — 新経路に retry は無い)。
//
// - success: この figure の crop は完了している('reused' も「既に完了済」を
//   意味するため success 扱い)。
// - terminal: 同じ入力(同一 figureAssetId/box2d/source)を再試行しても状態は
//   変わらない(figure 単位で確定的に crop できない、またはしてはいけない)。
//   spec §16 の「crop失敗」等の計上対象。
// - retryable: 一時的な外部要因(R2 の技術的失敗)。 再試行で成功しうる
//   (単一 invocation 経路は再試行しないため、呼出元は exclude に倒す)。
//
// S-5(旧経路撤去)で 'caller_error' 級は消えた: それを返していた分岐
// (not_prepared / source_not_ready / source_unreadable)は、operation 行と旧
// source 台帳を読んでいた旧 entry `cropFigureAndStore` に固有だった。
// ---------------------------------------------------------------------------
export type CropOutcomeClass = 'success' | 'terminal' | 'retryable'

export const CROP_OUTCOME_CLASS: Record<CropAndStoreOutcome['outcome'], CropOutcomeClass> = {
  stored: 'success',
  reused: 'success',
  crop_failed: 'terminal',
  forbidden: 'terminal',
  hash_mismatch: 'terminal',
  error: 'retryable',
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
//
async function writeCropAssetRows(
  userId: string,
  objectKey: string,
  bytes: Buffer,
  hash: string,
  rect: CropRect,
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
 * 1 figure を crop して保存する(spec §7.3/§10・制約#1-9 準拠)。source 行の SELECT も
 * R2 GET も**行わず**、呼出元が持っているバイトと decode 済み寸法をそのまま受け取る。
 *
 * 手順: ① toCropRect(T9・pure・唯一の rect 算出点)② sharp decode(auto-rotate
 * 禁止・limitInputPixels)→ extract(rect そのもの)→ webp encode(quality/lossless
 * 固定)③ 条件付き PUT(If-None-Match: *)④ 412 なら実体 GET + SHA-256 照合 → 分岐
 * (制約#5)⑤ assets + asset_derivations を 1 tx で INSERT(status='ready' で直接確定
 * — crop-derived asset に reserved 状態は存在しない)。
 *
 * 決定性(制約#3): figureAssetId・box2d・sourceId は prepared_payload に固定済み
 * (正規化時 UUIDv4 発行)。 source の実バイトは受領後 immutable。 sharp は
 * auto-rotate しない(`.rotate()` を一切呼ばない — sharp は明示 `.rotate()` 呼出時
 * のみ EXIF Orientation を見て autoOrient() する仕様であり、呼ばなければ EXIF に
 * 関わらずデコード時の生ピクセル配置のまま出力される。 decode 検証
 * (source-image-verify.ts)の寸法も同じ「.rotate() を呼ばない」経路のため、box_2d
 * の座標系(decoded 寸法基準)と一致する)。 `.withMetadata()` も呼ばない(既定で
 * EXIF/ICC 等の可変メタデータを出力に含めない = 出力バイトが画素データのみで決まる)。
 * webp の quality/lossless は上記モジュール定数で固定。 これらにより同一入力から常に
 * 同一バイト列が生成され、conditional PUT の再試行が idempotent に機能する。
 *
 * `asset_derivations.source_asset_id` は書かない(S-5 の migration 0032 で列ごと drop
 * 済み — source を R2/DB に置かない設計に参照先が存在しない)。
 */
export async function cropFigureFromBuffer(
  args: CropFigureFromBufferInput,
): Promise<CropAndStoreOutcome> {
  const { userId, sourceBytes, sourceId, figureAssetId, box2d, detectTarget } = args

  // 制約#2: この 1 回の toCropRect 呼出の戻り値だけを、以降 sharp extract の
  // 入力と asset_derivations の監査メタの両方に使う(再計算・再導出しない)。
  const rect = toCropRect(box2d, args.sourceWidth, args.sourceHeight)
  if (rect === null) return { outcome: 'crop_failed' }

  let cropBytes: Buffer
  try {
    cropBytes = await sharp(sourceBytes, { limitInputPixels: CROP_DECODE_MAX_PIXELS })
      .timeout({ seconds: CROP_SHARP_TIMEOUT_SEC })
      .extract({ left: rect.left, top: rect.top, width: rect.cropW, height: rect.cropH })
      .webp({ quality: CROP_WEBP_QUALITY, lossless: CROP_WEBP_LOSSLESS })
      .toBuffer()
  } catch {
    // corrupt source / limitInputPixels 超過 / extract 領域が画像外(丸め等の
    // 極端な境界ケース)/ CROP_SHARP_TIMEOUT_SEC 超過(T14a fix round 2・spec §11
    // hard per-crop bound)。 toCropRect 自体は退化を null で弾いているが、 sharp
    // 側の実際の decode 結果 + 処理時間に対する最終防御として catch する。
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
    figureAssetId,
    detectTarget,
  )
}
