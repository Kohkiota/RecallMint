// 画像 GC v2 reconciler (Task G5) — 状態ベース遅延 GC の本体。
// 参照ゼロの asset を mark(orphaned_at set)→ grace 超で promote(deleting)→
// collect(R2 実体削除 + assets 行 DELETE)する手動 script(spec §4.4/§4.5 = 正本)。
//
// ⚠ PREREQUISITE(必読・順序厳守): 本 reconciler は「card_asset_refs 行が無い asset
//   = 未参照」と定義する。以下の両方が満たされた環境でのみ実行すること:
//     (a) task W1(handleImages が同 tx で refs を書く seam)が DEPLOY 済み
//     (b) backfill script(scripts/backfill-card-asset-refs.ts)が実行済み
//   deploy 順序(plan): W1 deploy → backfill 実行 → reconciler 運用開始。
//   W1 未 deploy(refs が live 維持されない)または backfill 未実行だと、実利用中の
//   画像が cards.images にのみ存在し card_asset_refs に無い状態になり、reconciler は
//   それを未参照とみなす — この状態で --sweep すると参照中 asset の R2 object + 行を
//   削除してしまう。必ず --dry-run を先に実行し backfill-divergence 出力を確認せよ。
//   下記 runtime pre-sweep guard は「refs 完全未投入」の明白ケースのみ backstop する
//   (部分的 stale は検知不能 — それは deploy 順序 + dry-run divergence で担保)。
//
// 実行(`--conditions=react-server` は必須フラグ — 下記注記参照):
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts                        # mark のみ(orphaned_at set/clear)
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep                # mark + promote + collect(本回収)
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep --dry-run      # 一切 write せず予告集計のみ
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep --user <id>    # 対象 user 限定(stg 検証)
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep --grace-days N # grace 上書き(既定 30)
//   (--user は値必須。値なし / 別 flag が続くと fail-fast で exit 1 — 全 user 誤爆防止)
//
// ②-4a Task 14b: 上記いずれの `--sweep` 呼出も source lane(source_assets の GC)を
// 自動的に含む(`--sweep` 無しでは asset lane の mark-only 同様、source lane も
// 何もしない)。source lane 専用フラグは無い — 同じ `--sweep`/`--dry-run`/`--user`/
// `--grace-days` を共有する。破壊操作ゆえ本番相当データに対しては必ず先に
// `--sweep --dry-run --user <id>` で予告を確認してから本実行すること
// (下記 SOURCE LANE 節 §RETAIN 不変条件も参照)。
//
// `--conditions=react-server` は必須(seed-perf-exam.ts / backfill-card-asset-refs.ts
// と同様)。本 script は getAdminDb()(@/lib/db)・recordIntegrationFailure(→ @/lib/db)を
// 経由して DB に接続し、@/lib/storage/r2 も含めいずれも `import 'server-only'` を
// 持つため、tsx をそのまま実行すると runtime guard で throw する。このフラグで
// server-only package が empty.js(no-op)に解決され script が正常起動する
// (vitest.config.ts の server-only alias stub と同原理)。
//
// 前提(spec §4.11-5): backfill(scripts/backfill-card-asset-refs.ts)完了後の環境
// でのみ走らせる。refs が無い世界では全 asset が未参照に見え、誤って全 orphan を
// mark してしまう。migration(refs table)→ backfill → 本 reconciler の順。
//
// decouple 順序(絶対不変・spec §4.4/§4.6): R2 DELETE → success-equivalent 確認 →
// THEN assets 行 DELETE。逆順(行 DELETE 先)は object_key を喪失させ R2 に永久
// orphan を残す。R2 失敗は行を deleting のまま存置 + integration_failures に積み、
// 次 asset へ続行(1 件失敗が run 全体を止めない)。
//
// 状態機械の語彙 SSoT は lib/media/domain/asset-state.ts(G2 domain)。本 script は
// per-asset の判定をその純粋関数(isSweepEligible / canSweepDelete /
// shouldClearUnreferenced)に委ね、判定ロジックを inline 再実装しない。
//
// prod 誤爆ガード: production 環境で --grace-days が既定(30)未満は reject(exit 1)。
// in-flight / offline-pending mutation の全収を防ぐ。
//
// 安全性: dry-run は write を一切行わない(mark/promote/R2 DELETE/行 DELETE/台帳
// 記録すべて skip し、予告集計のみ出力)。production 実行は OT が手動(env を対象
// 環境用に切替えた上で本 script を実行)。
//
// ②-4a Task 14b(source lane 追加): 本 script に `source_assets` の GC lane を追加
// (spec §6.4「共通化」決定)。asset lane(上記)とは別ライフサイクル
// (source_assets に unreferenced_at 列/deleted state は無い・reserved→ready→
// deleting のみ)ゆえ、mark フェーズは無く promote(単文 UPDATE)→ collect(R2
// DELETE → 行 DELETE)のみ。適格判定(reserved-stale / ready-terminal)は
// lib/media/domain/source-asset-state.ts(G2 asset-state.ts とは別 module)。
// live-op 除外は isLiveUploadOperationCondition(lib/exams/source-doc-status.ts・
// T14a が NULL-safe 化した共有述語)を SQL WHERE に直接埋め込み再利用する(JS 側で
// 再実装しない)。
//
// **②-4a S-4(2026-08-05)で source lane の保護範囲が狭まった**(gc-abandoned-
// operations.ts:11-19 と同趣旨の注記): 共有述語から 7 日 window(created_at 基準)が
// 外れ、live = 「非終端 かつ valid lease」だけになった。 ゆえに **lease を持たない
// 非終端 op(= 旧経路の `awaiting_sources` — prepare-upload は lease を発行しない)は
// 所有 source_asset を守らなくなり**、Class A(reserved-not-live)の margin
// `SOURCE_RESERVED_NET_GRACE_MS`(16 分)超で **R2 object + 行の削除対象に昇格する**
// (旧: 最大 7 日保護)。 方向は T14b′ の新軸(source は R2 に残さない)と同じだが、
// 本 lane は破壊操作ゆえ、S-5 の旧経路撤去まではこの点を意識して走らせること
// (`--dry-run` 既定で対象を確認してから本実行する)。source lane は `--sweep`(dry-run 込み)でのみ走る(asset lane の
// mark-only 相当の概念が無いため、`--sweep` 無しでは何もしない)。既存 asset lane
// の挙動・DI・CLI flag 処理は変更しない(追加のみ)。
// 詳細: .superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/task-14b-brief.md

import { and, eq, exists, inArray, isNull, isNotNull, notExists, or, sql } from 'drizzle-orm'
import { getAdminDb } from '@/lib/db'
import { assets, cardAssetRefs, sourceAssets, uploadOperations } from '@/lib/db/schema'
import {
  isSweepEligible,
  canSweepDelete,
  shouldClearUnreferenced,
  type AssetStatus,
} from '@/lib/media/domain/asset-state'
import {
  isSourceAssetGcEligible,
  type OwningOpInfo,
  type OwningOperationStatus,
  type SourceAssetStatus,
} from '@/lib/media/domain/source-asset-state'
import { isLiveUploadOperationCondition } from '@/lib/exams/source-doc-status'
// deleteObject(@/lib/storage/r2)は top-level import しない — r2.ts は module-eval
// 時に R2 env(R2_ACCOUNT_ID 等)を fail-fast 検証するため、R2 実削除が起きない
// mark-only / dry-run 実行でも import しただけで throw する。実 sweep-collect
// (sweep && !dryRun)のときだけ main() が dynamic import で取得する(下記参照)。
import { recordIntegrationFailure } from '@/lib/integration-failures'
import { logger } from '@/lib/logger'

// grace の既定日数(spec §2-5 / §4.5)。--grace-days で上書き可能だが、production
// では 30 未満を prod ガードで拒否する。
export const DEFAULT_GRACE_DAYS = 30

// collect 候補取得の 1 batch あたり上限。全 user sweep で candidate 集合が Postgres
// の bind パラメータ上限を大きく下回るよう分割する(backfill script の
// ASSET_LOOKUP_BATCH_SIZE と同規律)。
export const COLLECT_BATCH_SIZE = 1000

// collect が処理する 1 asset の最小情報。判定は G2 domain 関数に渡す(status /
// unreferencedAt)。object_key は R2 DELETE の対象。
export type CollectCandidate = {
  id: string
  userId: string
  objectKey: string
  status: string
  unreferencedAt: Date | null
}

// ---------------------------------------------------------------------------
// DI deps — 各操作は SQL 表現(mark/promote は bulk UPDATE、collect は per-asset
// primitive)。dry-run では write 系(markSet/markClear/promote/deleteObject/
// restoreToReady/markDeleted/deleteAssetRow/recordFailure)は core 側で呼ばない。
// ---------------------------------------------------------------------------
export type ReconcilerDeps = {
  // scan 全体の観測用: 対象 asset 総数と参照ありの数(dry-run summary で使う)。
  countScannedAssets: () => Promise<{ scanned: number; referenced: number }>

  // mark set: 参照ゼロ + 未マークの reserved|ready を orphaned_at=now() に。
  // WHERE は G2 shouldMarkUnreferenced の意味論(status IN ('reserved','ready')
  // AND unreferenced_at IS NULL AND NOT EXISTS refs)を SQL で表現したもの。
  // 影響行数(= set 件数)を返す。
  markSet: () => Promise<number>
  // mark clear: 再参照された(EXISTS refs)マーク済み(unreferenced_at IS NOT NULL)
  // を orphaned_at=NULL に。G2 shouldClearUnreferenced の意味論。影響行数を返す。
  markClear: () => Promise<number>

  // promote: grace 超 + 参照ゼロの reserved|ready を status='deleting' に(単文
  // UPDATE で TOCTOU 最小化・spec §4.4)。grace 境界は G2 isSweepEligible と同じ
  // strict older(unreferenced_at < now() - graceDays days)を SQL で表現。影響行数
  // (= promote 件数)を返す。本実行のみ呼ぶ(dry-run は write せず下記 preview を使う)。
  promote: (graceDays: number) => Promise<number>
  // dry-run 限定の promote 予告候補: 参照ゼロ + マーク済みの reserved|ready(まだ
  // grace 未判定)を返す。core が G2 isSweepEligible で 1 件ずつ grace 適格を判定し、
  // 「本実行なら promote されるであろう件数」を write ゼロで予告する。
  fetchPromoteCandidates: () => Promise<{ unreferencedAt: Date | null }[]>

  // pre-sweep guard(--sweep のみ・promote 前)の材料: card_asset_refs 行数と、
  // cards.images に UUIDv4(isAssetKey)image key が 1 つでも存在するか。core が
  // 「refs 空 かつ UUID image key あり」= refs 完全未投入(W1 未 deploy or backfill
  // 未実行)を検知して sweep を abort する backstop に使う。--user 指定時は同 user に
  // scope する(guard も owner-scope query 規律に整合)。mark-only / dry-run では
  // 呼ばれない(dry-run が operator の観測手段)。
  checkRefsPopulated: () => Promise<{ refRowCount: number; hasUuidImageKeys: boolean }>

  // collect 候補: status IN ('deleting','deleted') の asset を取得。ループ直前に
  // 呼ぶ(promote 直後の最新 snapshot)。
  fetchCollectCandidates: () => Promise<CollectCandidate[]>
  // collect ループ直前の fresh 参照再読み: 候補 asset のうち現在参照が存在する
  // asset_id 集合を返す(TOCTOU 防御 = mark/promote 時点の判定を信用しない)。
  fetchReferencedAssetIds: (assetIds: string[]) => Promise<Set<string>>

  // self-heal: deleting asset に参照が戻った → status='ready' + unreferenced_at=NULL。
  restoreToReady: (assetId: string) => Promise<void>
  // R2 成功後の crash マーカー: status='deleting' → 'deleted'(decouple の中間状態)。
  markDeleted: (assetId: string) => Promise<void>
  // 行 DELETE(最終掃除)。refs→assets RESTRICT が最後の防衛(refs 残存なら DB 拒否)。
  deleteAssetRow: (assetId: string) => Promise<void>

  // R2 実体削除(never-throw・2xx/404 = ok:true)。
  deleteObject: (objectKey: string) => Promise<{ ok: boolean; status: number | null }>
  // R2 失敗の台帳記録(key='r2_gc_delete')。DB 側失敗は積まない(script 出力で可視)。
  recordFailure: (args: {
    userId: string
    assetId: string
    objectKey: string
    status: string
    errorMessage: string
  }) => Promise<void>

  // dry-run 限定の backfill 乖離検査(cards.images 内 UUID key 総数 vs refs 行数)。
  // 乖離大 = backfill 漏れ疑いの観測材料。毎 run の jsonb 全読は本末転倒ゆえ
  // dry-run のときだけ呼ぶ(未実装環境は undefined で省略可)。
  countRefDivergence?: () => Promise<{ imageUuidKeys: number; refRows: number }>

  log: (msg: string) => void
}

export type ReconcilerOptions = {
  sweep: boolean
  dryRun: boolean
  graceDays: number
  userId?: string
  // 「現在時刻」の注入口(既定 = new Date())。dry-run promote 予告の grace 適格判定
  // (isSweepEligible)が参照する now を固定でき、境界テストを決定的にする。本実行の
  // promote は DB `now()` で判定するため本値は影響しない(dry-run preview 専用)。
  now?: Date
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
export type ReconcilerSummary = {
  scannedAssets: number
  referencedAssets: number
  marked: number // set 件数
  cleared: number
  promoted: number
  // collect 内訳
  r2DeleteOk: number // 2xx で ok:true
  r2Delete404: number // 404 で ok:true(不在 = 望む end-state)
  r2DeleteFailed: number // ok:false = 台帳記録した件数
  rowDeleteOk: number // 行 DELETE 成功
  rowDeleteFailed: number // 行 DELETE 失敗(RESTRICT 等 → logger.error 済)
  deletedLaneProcessed: number // 'deleted' 発見(R2 済 crash マーカー)= 行 DELETE のみ
  selfHealed: number // 参照復活で ready 戻し
  unknownStatus: number // AssetStatus union 外の status 行(CHECK なしの防衛)
  // forensic: 実際に回収した (assetId, objectKey) 一覧。
  reclaimed: { assetId: string; objectKey: string }[]
  // 行 DELETE 失敗の assetId(台帳に積まないため summary に明示)。
  rowDeleteFailures: string[]
  // dry-run 限定: backfill 乖離観測(未実行なら null)。
  refDivergence: { imageUuidKeys: number; refRows: number } | null
}

function emptySummary(): ReconcilerSummary {
  return {
    scannedAssets: 0,
    referencedAssets: 0,
    marked: 0,
    cleared: 0,
    promoted: 0,
    r2DeleteOk: 0,
    r2Delete404: 0,
    r2DeleteFailed: 0,
    rowDeleteOk: 0,
    rowDeleteFailed: 0,
    deletedLaneProcessed: 0,
    selfHealed: 0,
    unknownStatus: 0,
    reclaimed: [],
    rowDeleteFailures: [],
    refDivergence: null,
  }
}

// status が AssetStatus union に属するか(CHECK なし列の防衛判定)。union 外は
// warn して collect 対象から外す。
const KNOWN_STATUSES: readonly AssetStatus[] = [
  'reserved',
  'ready',
  'deleting',
  'deleted',
]
function isKnownStatus(status: string): status is AssetStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(status)
}

// ---------------------------------------------------------------------------
// DI core
// ---------------------------------------------------------------------------
export async function runReconciler(
  opts: ReconcilerOptions,
  deps: ReconcilerDeps,
): Promise<ReconcilerSummary> {
  const summary = emptySummary()

  const { scanned, referenced } = await deps.countScannedAssets()
  summary.scannedAssets = scanned
  summary.referencedAssets = referenced

  // --- mark(常時実行・orphaned_at のみ書込) -------------------------------
  // dry-run は write せず「set/clear の対象になる件数」を予告として集計する。
  // 予告集計は referenced 差分で近似せず、markSet/markClear と同一 WHERE を持つ
  // dry-run 用 count に委ねるのが本来だが、本 script は「実 UPDATE の影響行数」を
  // 正とする(dry-run では UPDATE を打たず count 差分の見積りを出さない — spec は
  // dry-run を「予告のみ」と定義。過剰な count を足すより write ゼロを厳守する)。
  if (!opts.dryRun) {
    summary.marked = await deps.markSet()
    summary.cleared = await deps.markClear()
  }

  // --- dry-run 限定: backfill 乖離検査 -------------------------------------
  if (opts.dryRun && deps.countRefDivergence) {
    summary.refDivergence = await deps.countRefDivergence()
  }

  if (!opts.sweep) {
    logSummary(deps, opts, summary)
    return summary
  }

  // --- pre-sweep guard(FIX 8・destructive な promote/collect の前) ---------
  // refs 完全未投入(card_asset_refs が空 かつ cards.images に UUID image key あり)
  // = W1 未 deploy または backfill 未実行の明白ケース。この状態では実利用中の画像が
  // 未参照に見え、--sweep が参照中 asset の R2 object + 行を削除しうる。abort する。
  // ※部分的 stale は検知不能(それは deploy 順序 + dry-run divergence で担保)。
  // ※dry-run は gate しない(operator が refs 未投入環境で予告を観測する手段ゆえ)。
  if (!opts.dryRun) {
    const refsState = await deps.checkRefsPopulated()
    if (refsState.refRowCount === 0 && refsState.hasUuidImageKeys) {
      throw new Error(
        'card_asset_refs is empty but cards.images contains UUID image keys — ' +
          'refs are not populated (W1 not deployed or backfill not run). ' +
          'Aborting --sweep to avoid deleting referenced assets. ' +
          'Run the backfill and ensure W1 is live, then retry.',
      )
    }
  }

  // --- promote(grace 超 + 参照ゼロ → deleting) ---------------------------
  // 本実行: 単文 UPDATE(spec §4.4 = TOCTOU 最小化ゆえ per-row loop にしない)。
  // dry-run: write せず、G2 isSweepEligible で 1 件ずつ grace 適格を判定して
  //          「本実行なら promote されるであろう件数」を予告する(preview のみ)。
  if (!opts.dryRun) {
    summary.promoted = await deps.promote(opts.graceDays)
  } else {
    const now = opts.now ?? new Date()
    const cands = await deps.fetchPromoteCandidates()
    summary.promoted = cands.filter((c) =>
      isSweepEligible(c.unreferencedAt, opts.graceDays, now),
    ).length
  }

  // --- collect(deleting/deleted の per-asset 処理) -----------------------
  const candidates = await deps.fetchCollectCandidates()

  // ループ直前に refs を fresh 再読(TOCTOU 防御 = mark/promote 時点の判定を信用
  // しない。窓を collect ループ長に縮小)。空配列なら空集合。
  const candidateIds = candidates.map((c) => c.id)
  const referencedNow = candidateIds.length
    ? await deps.fetchReferencedAssetIds(candidateIds)
    : new Set<string>()

  for (const asset of candidates) {
    // 未知 status(CHECK なし列の防衛): AssetStatus union 外は warn して skip。
    if (!isKnownStatus(asset.status)) {
      summary.unknownStatus++
      logger.warn({
        event: 'gc.collect.unknown_status',
        assetId: asset.id,
        status: asset.status,
      })
      continue
    }

    // collect 対象は deleting|deleted のみ(G2 canSweepDelete)。promote 済でない
    // reserved|ready がここに来ることは fetchCollectCandidates の WHERE 上ないが、
    // 防衛として domain 判定で確認する(judgment を inline 再実装しない)。
    if (!canSweepDelete(asset.status)) {
      logger.warn({
        event: 'gc.collect.non_sweep_status',
        assetId: asset.id,
        status: asset.status,
      })
      continue
    }

    const hasRefs = referencedNow.has(asset.id)

    // self-heal は deleting lane 限定(spec §4.4)。deleting は R2 実体が未削除ゆえ
    // ready に戻せば参照が生きる。deleted(= R2 実体が既に消えた crash マーカー)に
    // 参照が付いていても ready に戻してはならない — R2 object 不在の壊れた ready を
    // 生む。deleted+refs は下の collectDeleteRow に落とし、RESTRICT / logger.error で
    // 異常を表面化させる(silent に broken ready を鋳造しない)。
    if (hasRefs && asset.status === 'deleting') {
      // fresh 参照が復活した deleting asset → ready に戻す(誤収阻止)。判定は G2
      // shouldClearUnreferenced(hasRefs=true かつ現在マーク済み)。
      // ※deleting 中は handleImages が弾くため通常起きない = promote と handleImages
      //   並走 race の最終防衛線。R2 は叩かない。
      if (shouldClearUnreferenced(hasRefs, asset.unreferencedAt)) {
        if (!opts.dryRun) await deps.restoreToReady(asset.id)
        summary.selfHealed++
        deps.log(
          `self-heal: asset=${asset.id} refs reappeared → restored to ready`,
        )
        continue
      }
      // hasRefs だが unreferencedAt が null(mark 未実行で deleting になった稀な
      // 状態: user 削除 lane 由来)。参照が実在する以上、収集してはならない。
      // status='ready' に戻す(unreferenced_at は既に null)。
      if (!opts.dryRun) await deps.restoreToReady(asset.id)
      summary.selfHealed++
      deps.log(
        `self-heal: asset=${asset.id} refs present on deleting (no orphaned_at) → restored to ready`,
      )
      continue
    }

    // --- deleted lane(R2 済 crash マーカー): 行 DELETE のみ ----------------
    if (asset.status === 'deleted') {
      summary.deletedLaneProcessed++
      await collectDeleteRow(asset, opts, deps, summary)
      continue
    }

    // --- deleting lane: R2 DELETE → success-equivalent → deleted → 行 DELETE -
    // decouple 順序厳守。R2 失敗は行存置(deleting のまま)+ 台帳 + 次 asset へ。
    if (opts.dryRun) {
      // dry-run は R2 も DB も叩かず、回収予定として reclaimed に積むのみ。
      summary.reclaimed.push({ assetId: asset.id, objectKey: asset.objectKey })
      continue
    }

    const res = await deps.deleteObject(asset.objectKey)
    if (!res.ok) {
      // R2 失敗: 行を deleting のまま存置し台帳記録。次 asset へ続行。
      summary.r2DeleteFailed++
      // recordFailure(recordIntegrationFailure → notifyOps)は Ops config 欠落時
      // (例: OPS_DISCORD_WEBHOOK_URL 未設定)に fail-fast で throw する
      // (integration-failures helper が notifyOps の throw を意図的に伝播)。この
      // throw を runReconciler の外に出すと 1 asset の台帳書込失敗が run 全体を中断し、
      // 「1 件の R2 失敗はその asset を deleting のまま残し、記録できる範囲で記録して
      // 続行する」per-asset isolation を破る。ゆえに握って logger.error + 続行する
      // (asset は deleting のまま = 次 run が再試行)。
      try {
        await deps.recordFailure({
          userId: asset.userId,
          assetId: asset.id,
          objectKey: asset.objectKey,
          status: asset.status,
          errorMessage: `R2 delete failed (status=${res.status ?? 'null'})`,
        })
      } catch (err) {
        logger.error({
          event: 'gc.collect.record_failure_threw',
          assetId: asset.id,
          objectKey: asset.objectKey,
          err,
        })
      }
      continue
    }

    if (res.status === 404) summary.r2Delete404++
    else summary.r2DeleteOk++

    // success-equivalent 確認済 → crash マーカーを立ててから行 DELETE。
    await deps.markDeleted(asset.id)
    await collectDeleteRow(asset, opts, deps, summary)
  }

  logSummary(deps, opts, summary)
  return summary
}

// 行 DELETE の共通処理(deleted lane / deleting lane 成功後の双方から呼ぶ)。
// RESTRICT 拒否等の失敗は台帳に積まず logger.error + summary に assetId を明示
// (次 run が再試行 = 状態から収束)。dry-run は呼ばれない経路(caller が guard)。
async function collectDeleteRow(
  asset: CollectCandidate,
  opts: ReconcilerOptions,
  deps: ReconcilerDeps,
  summary: ReconcilerSummary,
): Promise<void> {
  if (opts.dryRun) {
    summary.reclaimed.push({ assetId: asset.id, objectKey: asset.objectKey })
    return
  }
  try {
    await deps.deleteAssetRow(asset.id)
    summary.rowDeleteOk++
    summary.reclaimed.push({ assetId: asset.id, objectKey: asset.objectKey })
  } catch (err) {
    // refs→assets RESTRICT で万一 refs 残存なら拒否される。台帳でなく logger。
    summary.rowDeleteFailed++
    summary.rowDeleteFailures.push(asset.id)
    logger.error({
      event: 'gc.collect.row_delete_failed',
      assetId: asset.id,
      objectKey: asset.objectKey,
      err,
    })
  }
}

function logSummary(
  deps: ReconcilerDeps,
  opts: ReconcilerOptions,
  s: ReconcilerSummary,
): void {
  deps.log(
    `done. mode=${opts.sweep ? 'sweep' : 'mark'} dryRun=${opts.dryRun} ` +
      `grace=${opts.graceDays}d user=${opts.userId ?? 'all'} | ` +
      `scanned=${s.scannedAssets} referenced=${s.referencedAssets} ` +
      `marked=${s.marked} cleared=${s.cleared} promoted=${s.promoted} | ` +
      `r2Ok=${s.r2DeleteOk} r2_404=${s.r2Delete404} r2Failed=${s.r2DeleteFailed} ` +
      `rowDeleteOk=${s.rowDeleteOk} rowDeleteFailed=${s.rowDeleteFailed} ` +
      `deletedLane=${s.deletedLaneProcessed} selfHealed=${s.selfHealed} ` +
      `unknownStatus=${s.unknownStatus} reclaimed=${s.reclaimed.length}`,
  )
  if (s.rowDeleteFailures.length > 0) {
    deps.log(
      `row DELETE failures (assetIds, not in ledger): ${s.rowDeleteFailures.join(', ')}`,
    )
  }
  if (s.refDivergence) {
    deps.log(
      `[dry-run] backfill divergence: imageUuidKeys=${s.refDivergence.imageUuidKeys} refRows=${s.refDivergence.refRows}`,
    )
  }
}

// =============================================================================
// SOURCE LANE(②-4a Task 14b′・source_assets の GC・**網 = 二次防御**)
// =============================================================================
// 2026-08-03 軸反転(OT 確定): source(OCR 元画像)は著作物の疑いゆえ R2 に残さない
// (risk 軸 = provenance 消失は許容 / source が消え残ることは受容しない)。旧 T14b
// (retention GC)はこのファイルが唯一の GC 経路だったが、今は **主経路**
// (lib/media/source-purge.ts の purgeOperationSources・op が terminal になった
// commit 直後に同期 purge する)が主役で、この source lane は主経路の取りこぼし
// (process 中断・claim-lost 放置 op 等)だけを拾う**二次防御**に降格した。
//
// mark フェーズは無い(source_assets に unreferenced_at 列が無い)ため promote
// (単文 UPDATE)→ collect(deleting → R2 DELETE → 行 DELETE)のみ。
//
// 旧軸で存在した RETAIN 方向のガードは全て撤去した(brief「撤回する guard」節):
//   - Finding 1(asset_derivations 子行を持つ source を RETAIN)撤去 — provenance
//     消失は新軸で許容。hasDerivations 引数・EXISTS 列は無くなった。
//   - Finding 5(self-heal・collect 直前の derivation 再検証で ready に戻す)撤去
//     — 同じ理由。fetchDerivedSourceAssetIds/restoreSourceToReady/selfHealed は
//     無くなった。
//   - completed-retain(Class B は旧 terminal_failed 限定)撤去 — completed も
//     Class B の対象に含める(grace 無し・即時)。
// grace は Class A(reserved-not-live)にのみ残る。旧 30 日(retention 目的)は
// 廃止し、in-flight op を巻き込まないための分単位 margin
// (SOURCE_RESERVED_NET_GRACE_MS)に置き換えた(brief「grace 新値」節・値の
// derivation は同定数のコメント参照)。Class B(terminal-op ready)は grace 無し
// (op terminal = 処理完了ゆえ即時)。
//
// grace の CLI 化はしない(YAGNI): 旧 30 日 retention grace は運用者が意図的に
// 調整しうる値だったが、この margin は system 定数(lease TTL + retry backoff)
// からの導出値であり operator が任意値を選ぶ性質のものではない。ゆえに
// `--grace-days` は asset lane 専用のまま維持し(既存 prod ガード
// parseGraceDays の 30 日 floor もそのため不変・下記 main() 参照)、source lane
// は独立した固定定数を使う。stg 検証は source_assets.created_at を直接 SQL で
// 過去日付に UPDATE する既存手法(T14b report §5.1)で足りる。
//
// 適格判定の語彙 SSoT は lib/media/domain/source-asset-state.ts(pure)。dry-run
// preview はその pure 関数を通し、本実行の promote は同じ意味論を SQL で表現する
// (asset lane の isSweepEligible/promote と同じ二重表現パターン)。
// ---------------------------------------------------------------------------

// 網の Class A(reserved-not-live)専用 margin。導出: LEASE_TTL_MS(15分・
// app/(app)/app/upload/_lib/constants.ts)+ RETRYABLE_BACKOFF_MS(1分・同 file)
// = 16分。in-flight op(claim/takeover 直後の lease 保持中、または retryable
// failure 後の backoff 待ち)の reserved source を巻き込まないための最小値
// (brief「網の reserved-not-live promote にのみ margin」)。値をこの file に
// 直書きするのは lib/media/domain/ を app/ 層から独立させる既存の層分離を保つ
// ため(pure domain module は app/ の定数を import しない）。app 側の値が変われば
// この定数も見直す(2 箇所の直書きの同期は運用上のトレードオフとして許容)。
export const SOURCE_RESERVED_NET_GRACE_MS = 16 * 60 * 1000

// promote 候補(dry-run preview 用)。所有 op の情報を LEFT JOIN で取得し、pure
// isSourceAssetGcEligible に渡す形へ変換する。
export type SourcePromoteCandidate = {
  id: string
  objectKey: string
  status: SourceAssetStatus
  createdAt: Date
  op: OwningOpInfo
}

// collect 候補(deleting のみ・source_assets に 'deleted' crash-marker state は無い)。
export type SourceCollectCandidate = {
  id: string
  userId: string
  objectKey: string
}

export type SourceReconcilerDeps = {
  // 本実行の promote: Class A(reserved-not-live・SOURCE_RESERVED_NET_GRACE_MS
  // margin 込み)/ Class B(ready・op completed|terminal_failed・grace 無し)を
  // 単文 UPDATE の WHERE に埋め込む(TOCTOU 最小化・asset lane の promote と同じ
  // 規律)。影響行数を返す。dry-run では呼ばない。
  promoteSourceAssets: () => Promise<number>
  // dry-run 限定の予告候補: reserved|ready 全件 + 所有 op 情報。core が
  // isSourceAssetGcEligible で 1 件ずつ判定し write ゼロで予告する。
  fetchSourcePromoteCandidates: () => Promise<SourcePromoteCandidate[]>
  // collect 候補: status='deleting' の source_asset。promote 直後の最新 snapshot。
  fetchSourceCollectCandidates: () => Promise<SourceCollectCandidate[]>
  // R2 実体削除(never-throw・2xx/404 = ok:true。asset lane と同じ契約を再利用)。
  deleteObject: (objectKey: string) => Promise<{ ok: boolean; status: number | null }>
  // 行 DELETE(最終掃除)。source_assets に refs RESTRICT は無い(asset lane と非対称)。
  deleteSourceAssetRow: (id: string) => Promise<void>
  // R2 失敗の台帳記録(key='r2_gc_delete_source')。
  recordFailure: (args: {
    userId: string
    sourceAssetId: string
    objectKey: string
    errorMessage: string
  }) => Promise<void>
  log: (msg: string) => void
}

export type SourceReconcilerOptions = {
  dryRun: boolean
  userId?: string
  // dry-run preview の grace 判定に使う「現在時刻」の注入口(既定 = new Date())。
  // 本実行の promote は DB `now()` で判定するため影響しない(asset lane と同型)。
  now?: Date
}

export type SourceReconcilerSummary = {
  promoted: number // 実 promote 件数(dry-run は予告件数)
  r2DeleteOk: number
  r2Delete404: number
  r2DeleteFailed: number
  rowDeleteOk: number
  rowDeleteFailed: number
  reclaimed: { id: string; objectKey: string }[]
  rowDeleteFailures: string[]
}

function emptySourceSummary(): SourceReconcilerSummary {
  return {
    promoted: 0,
    r2DeleteOk: 0,
    r2Delete404: 0,
    r2DeleteFailed: 0,
    rowDeleteOk: 0,
    rowDeleteFailed: 0,
    reclaimed: [],
    rowDeleteFailures: [],
  }
}

export async function runSourceReconciler(
  opts: SourceReconcilerOptions,
  deps: SourceReconcilerDeps,
): Promise<SourceReconcilerSummary> {
  const summary = emptySourceSummary()

  // --- promote(Class A: reserved-not-live + margin / Class B: ready + op
  //     completed|terminal_failed・grace 無し → deleting) ------------------
  // dry-run: write せず pure isSourceAssetGcEligible で「本実行なら promote
  // されるであろう件数」を予告する(asset lane の isSweepEligible 予告と同型の
  // SQL/pure 二重表現)。
  if (!opts.dryRun) {
    summary.promoted = await deps.promoteSourceAssets()
  } else {
    const now = opts.now ?? new Date()
    const promoteCandidates = await deps.fetchSourcePromoteCandidates()
    const eligible = promoteCandidates.filter((c) =>
      isSourceAssetGcEligible(c.status, c.createdAt, SOURCE_RESERVED_NET_GRACE_MS, now, c.op),
    )
    summary.promoted = eligible.length
    summary.reclaimed.push(...eligible.map((c) => ({ id: c.id, objectKey: c.objectKey })))
  }

  // --- collect(deleting の per-source 処理: R2 DELETE → success-equivalent → 行 DELETE)
  // dry-run/本実行いずれも候補取得は行う(review fix round Finding 3・Codex): dry-run
  // が promote 予告のみを返すと、前 run の R2 失敗/crash で残置された既存 deleting 行
  // (実 --sweep なら collect される)を見落とし preview の安全性が損なわれる。
  const candidates = await deps.fetchSourceCollectCandidates()

  for (const sa of candidates) {
    if (opts.dryRun) {
      // write ゼロ: 予告として reclaimed に積むのみ(R2/行 DELETE は一切呼ばない)。
      summary.reclaimed.push({ id: sa.id, objectKey: sa.objectKey })
      continue
    }

    const res = await deps.deleteObject(sa.objectKey)
    if (!res.ok) {
      // R2 失敗: 行を deleting のまま存置し台帳記録。次 source へ続行(asset lane と
      // 同じ per-source isolation: 台帳書込の throw も握って続行する)。
      summary.r2DeleteFailed++
      try {
        await deps.recordFailure({
          userId: sa.userId,
          sourceAssetId: sa.id,
          objectKey: sa.objectKey,
          errorMessage: `R2 delete failed (status=${res.status ?? 'null'})`,
        })
      } catch (err) {
        logger.error({
          event: 'gc.source_collect.record_failure_threw',
          sourceAssetId: sa.id,
          objectKey: sa.objectKey,
          err,
        })
      }
      continue
    }

    if (res.status === 404) summary.r2Delete404++
    else summary.r2DeleteOk++

    // decouple 順序厳守: R2 success-equivalent 確認済 → THEN 行 DELETE。
    try {
      await deps.deleteSourceAssetRow(sa.id)
      summary.rowDeleteOk++
      summary.reclaimed.push({ id: sa.id, objectKey: sa.objectKey })
    } catch (err) {
      summary.rowDeleteFailed++
      summary.rowDeleteFailures.push(sa.id)
      logger.error({
        event: 'gc.source_collect.row_delete_failed',
        sourceAssetId: sa.id,
        objectKey: sa.objectKey,
        err,
      })
    }
  }

  if (opts.dryRun) {
    deps.log(
      `[dry-run] source: would promote ${summary.promoted} source_asset(s), ` +
        `would collect ${candidates.length} pre-existing deleting source_asset(s) ` +
        `user=${opts.userId ?? 'all'}`,
    )
  } else {
    logSourceSummary(deps, opts, summary)
  }
  return summary
}

function logSourceSummary(
  deps: SourceReconcilerDeps,
  opts: SourceReconcilerOptions,
  s: SourceReconcilerSummary,
): void {
  deps.log(
    `done. source: user=${opts.userId ?? 'all'} | ` +
      `promoted=${s.promoted} | r2Ok=${s.r2DeleteOk} ` +
      `r2_404=${s.r2Delete404} r2Failed=${s.r2DeleteFailed} rowDeleteOk=${s.rowDeleteOk} ` +
      `rowDeleteFailed=${s.rowDeleteFailed} reclaimed=${s.reclaimed.length}`,
  )
  if (s.rowDeleteFailures.length > 0) {
    deps.log(
      `source row DELETE failures (sourceAssetIds, not in ledger): ${s.rowDeleteFailures.join(', ')}`,
    )
  }
}

// ---------------------------------------------------------------------------
// production deps 束縛(source lane)。iso test(tests/integration/pg/)が
// getFixtureOwnerDb() を注入して実 SQL を直接叩けるよう export する
// (scripts/gc-abandoned-operations.ts の buildProductionDeps と同じ理由・
// select/update/delete は drizzle の TSchema generic に依存しないため
// getAdminDb() の型と構造的に両立する)。
// ---------------------------------------------------------------------------
type SourceGcDb = Pick<ReturnType<typeof getAdminDb>, 'select' | 'update' | 'delete'>

export function buildSourceProductionDeps(
  db: SourceGcDb,
  userId: string | undefined,
  deleteObject: SourceReconcilerDeps['deleteObject'],
): SourceReconcilerDeps {
  return {
    fetchSourcePromoteCandidates: async () => {
      // reserved|ready 全件 + 所有 op 情報を LEFT JOIN で取得(grace 判定は core が
      // pure isSourceAssetGcEligible で行う)。1 upload:1 op:1 source_document の
      // 前提により op JOIN で行が増殖しない(dry-run 予告専用・非authoritative
      // なので万一の重複も破壊操作には影響しない)。
      const rows = await db
        .select({
          id: sourceAssets.id,
          objectKey: sourceAssets.objectKey,
          status: sourceAssets.status,
          createdAt: sourceAssets.createdAt,
          opStatus: uploadOperations.status,
          opIsLive: sql<boolean>`COALESCE(${isLiveUploadOperationCondition()}, false)`,
        })
        .from(sourceAssets)
        .leftJoin(
          uploadOperations,
          and(
            eq(uploadOperations.sourceDocumentId, sourceAssets.sourceDocumentId),
            eq(uploadOperations.userId, sourceAssets.userId),
          ),
        )
        .where(
          and(
            inArray(sourceAssets.status, ['reserved', 'ready']),
            userId ? eq(sourceAssets.userId, userId) : undefined,
          ),
        )
      return rows.map((r) => ({
        id: r.id,
        objectKey: r.objectKey,
        status: r.status as SourceAssetStatus,
        createdAt: r.createdAt,
        op:
          r.opStatus === null
            ? null
            : { status: r.opStatus as OwningOperationStatus, isLive: r.opIsLive },
      }))
    },
    promoteSourceAssets: async () => {
      // Class A(stale reserved-not-live・isStaleReservedEligible の SQL 表現):
      // op が live でない(NOT EXISTS)AND created_at が SOURCE_RESERVED_NET_GRACE_MS
      // 超。op 不在(source_document_id が SET NULL 等)は NOT EXISTS が真 →
      // eligible(防御既定)。旧軸の completed 明示除外(review fix round Finding 2)
      // は撤去 — completed は isLiveUploadOperationCondition() の対象 status
      // 集合に含まれず isLive は元々偽なので、明示除外しなくても NOT EXISTS が
      // 真になり同じ結果になる(source-asset-state.ts コメント参照)。
      const classA = and(
        eq(sourceAssets.status, 'reserved'),
        sql`${sourceAssets.createdAt} < now() - (${SOURCE_RESERVED_NET_GRACE_MS} * interval '1 millisecond')`,
        notExists(
          db
            .select({ id: uploadOperations.id })
            .from(uploadOperations)
            .where(
              and(
                eq(uploadOperations.sourceDocumentId, sourceAssets.sourceDocumentId),
                eq(uploadOperations.userId, sourceAssets.userId),
                isLiveUploadOperationCondition(),
              ),
            ),
        ),
      )

      // Class B(terminal-op ready・isTerminalOpReadyEligible の SQL 表現・grace
      // 無し): op が status IN ('completed','terminal_failed') の行を持つ
      // (EXISTS)。旧軸は terminal_failed 限定で completed を RETAIN していたが、
      // 新軸(brief 冒頭)はそれが最重要の違反だったため completed も含める。
      // op 不在は EXISTS が偽 → NOT eligible(finalize 済 source を守る保守的
      // 防御既定)。
      //
      // 不変条件の pin(Codex review Minor・2026-08-03): この非対称
      // (Class A は op 不在→eligible / Class B は op 不在→非適格)が安全なのは、
      // `ready` な source_asset は必ず所有 op と共に作られ、cascade でしか
      // 一緒に消えない(schema 上 op 単独削除で ready source だけが残ることは
      // 現状無い)という不変条件があるからに限る。将来 op だけを削除して ready
      // source を残す経路が生まれた場合、その source は Class B に一切引っかから
      // ず永久に残る — この一文が偽になった時点でこの分岐を見直すこと。
      const classB = and(
        eq(sourceAssets.status, 'ready'),
        exists(
          db
            .select({ id: uploadOperations.id })
            .from(uploadOperations)
            .where(
              and(
                eq(uploadOperations.sourceDocumentId, sourceAssets.sourceDocumentId),
                eq(uploadOperations.userId, sourceAssets.userId),
                inArray(uploadOperations.status, ['completed', 'terminal_failed']),
              ),
            ),
        ),
      )

      const rows = await db
        .update(sourceAssets)
        .set({ status: 'deleting' })
        .where(
          and(or(classA, classB), userId ? eq(sourceAssets.userId, userId) : undefined),
        )
        .returning({ id: sourceAssets.id })
      return rows.length
    },
    fetchSourceCollectCandidates: async () => {
      const rows = await db
        .select({
          id: sourceAssets.id,
          userId: sourceAssets.userId,
          objectKey: sourceAssets.objectKey,
        })
        .from(sourceAssets)
        .where(
          and(
            eq(sourceAssets.status, 'deleting'),
            userId ? eq(sourceAssets.userId, userId) : undefined,
          ),
        )
      return rows
    },
    deleteSourceAssetRow: async (id: string) => {
      await db.delete(sourceAssets).where(eq(sourceAssets.id, id))
    },
    deleteObject,
    recordFailure: async ({ userId: uid, sourceAssetId, objectKey, errorMessage }) => {
      await recordIntegrationFailure({
        key: 'r2_gc_delete_source',
        userId: uid,
        errorMessage,
        subject: 'R2 GC: source object delete failed',
        context: { sourceAssetId, objectKey },
      })
    },
    log: (msg) => console.log(`[gc-image-assets:source] ${msg}`),
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing(pure・testable)
// ---------------------------------------------------------------------------
/**
 * `--user` は必ず非 flag の値を伴う(footgun 防止・backfill script parseUserFlag と
 * 同契約)。値欠落 / 別 flag が続く場合は fail-fast で throw(main が exit 1 に変換)。
 * `--user` 無し = 全 user 対象(意図的、許容)。
 */
export function parseUserFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--user')
  if (idx === -1) return undefined
  const next = argv[idx + 1]
  if (!next || next.startsWith('-')) {
    throw new Error('--user requires a userId value (e.g. --user <userId>)')
  }
  return next
}

/**
 * `--grace-days N` を解釈する(既定 DEFAULT_GRACE_DAYS)。値欠落 / 非数値 / 負数は
 * fail-fast で throw。**prod ガード**: production 環境(VERCEL_ENV or NODE_ENV が
 * 'production')で既定未満の grace を指定したら reject する(in-flight /
 * offline-pending mutation の全収を防ぐ)。
 */
export function parseGraceDays(
  argv: string[],
  env: { VERCEL_ENV?: string; NODE_ENV?: string },
): number {
  const idx = argv.indexOf('--grace-days')
  if (idx === -1) return DEFAULT_GRACE_DAYS
  const raw = argv[idx + 1]
  if (!raw || raw.startsWith('-')) {
    throw new Error('--grace-days requires a non-negative integer value')
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--grace-days must be a non-negative integer (got: ${raw})`)
  }
  const isProd =
    env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production'
  if (isProd && n < DEFAULT_GRACE_DAYS) {
    throw new Error(
      `production guard: --grace-days ${n} < ${DEFAULT_GRACE_DAYS} rejected ` +
        `(prevents sweeping in-flight/offline-pending mutations)`,
    )
  }
  return n
}

// ---------------------------------------------------------------------------
// production deps 束縛(§4.4 SQL を drizzle で実装)。
// ---------------------------------------------------------------------------

// 未参照 EXISTS probe: card_asset_refs.asset_id = assets.id の存在。mark/promote の
// WHERE 節で共有する(spec §4.4 の NOT EXISTS(SELECT 1 FROM card_asset_refs …))。
function refsExists(assetId: unknown) {
  return sql`EXISTS (SELECT 1 FROM ${cardAssetRefs} r WHERE r.asset_id = ${assetId})`
}

// CLI entry: production deps を bind して runReconciler を呼ぶ。test import 経路
// では走らないよう process.argv[1] guard(backfill script 踏襲)。
async function main(): Promise<void> {
  const argv = process.argv
  const sweep = argv.includes('--sweep')
  const dryRun = argv.includes('--dry-run')
  const userId = parseUserFlag(argv)
  const graceDays = parseGraceDays(argv, {
    VERCEL_ENV: process.env.VERCEL_ENV,
    NODE_ENV: process.env.NODE_ENV,
  })

  const db = getAdminDb()

  // --user 指定時は owner-scope の追加 WHERE を各 SQL に足す(CLAUDE.md Clerk-3)。
  const userScope = userId ? sql` AND ${assets.userId} = ${userId}::uuid` : sql``

  // R2 実削除は sweep-collect の本実行(sweep && !dryRun)でのみ起きる。この経路の
  // ときだけ @/lib/storage/r2 を dynamic import する(module-eval の R2 env fail-fast
  // を実削除しない run に持ち込まない)。それ以外は「呼ばれたら throw する」stub を
  // 注入する — mark-only / dry-run では core が deleteObject を一切呼ばない設計ゆえ、
  // この stub は決して発火しない(万一の配線ミスは loud に露見する)。
  const willDeleteFromR2 = sweep && !dryRun
  const deleteObject: ReconcilerDeps['deleteObject'] = willDeleteFromR2
    ? (await import('@/lib/storage/r2')).deleteObject
    : async () => {
        throw new Error(
          'deleteObject invoked on a non-collect run (mark-only/dry-run) — ' +
            'r2 module intentionally not loaded; this indicates a wiring bug',
        )
      }

  await runReconciler(
    { sweep, dryRun, graceDays, userId },
    {
      countScannedAssets: async () => {
        // 対象 asset 総数と、参照ありの数(EXISTS refs)を 1 回で数える。
        const rows = await db.execute<{ scanned: number; referenced: number }>(sql`
          SELECT
            COUNT(*)::int AS scanned,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM ${cardAssetRefs} r WHERE r.asset_id = ${assets.id}
            ))::int AS referenced
          FROM ${assets}
          WHERE TRUE${userScope}
        `)
        return {
          scanned: Number(rows[0]?.scanned ?? 0),
          referenced: Number(rows[0]?.referenced ?? 0),
        }
      },
      markSet: async () => {
        // G2 shouldMarkUnreferenced の SQL 表現:
        //   status IN ('reserved','ready') AND unreferenced_at IS NULL AND NOT EXISTS refs
        // postgres-js drizzle は update に rowCount を持たないため .returning() の
        // 行数で影響件数を得る(backfill script が select 系で count を数える規律に整合)。
        const rows = await db
          .update(assets)
          .set({ unreferencedAt: sql`now()` })
          .where(
            and(
              inArray(assets.status, ['reserved', 'ready']),
              isNull(assets.unreferencedAt),
              sql`NOT ${refsExists(assets.id)}`,
              userId ? eq(assets.userId, userId) : undefined,
            ),
          )
          .returning({ id: assets.id })
        return rows.length
      },
      markClear: async () => {
        // G2 shouldClearUnreferenced の SQL 表現:
        //   unreferenced_at IS NOT NULL AND EXISTS refs
        const rows = await db
          .update(assets)
          .set({ unreferencedAt: null })
          .where(
            and(
              isNotNull(assets.unreferencedAt),
              refsExists(assets.id),
              userId ? eq(assets.userId, userId) : undefined,
            ),
          )
          .returning({ id: assets.id })
        return rows.length
      },
      promote: async (grace) => {
        // G2 isSweepEligible の SQL 表現(strict older): status IN ('reserved','ready')
        //   AND unreferenced_at < now() - interval AND NOT EXISTS refs。
        const rows = await db
          .update(assets)
          .set({ status: 'deleting' })
          .where(
            and(
              inArray(assets.status, ['reserved', 'ready']),
              sql`${assets.unreferencedAt} < now() - (${grace} * interval '1 day')`,
              sql`NOT ${refsExists(assets.id)}`,
              userId ? eq(assets.userId, userId) : undefined,
            ),
          )
          .returning({ id: assets.id })
        return rows.length
      },
      fetchPromoteCandidates: async () => {
        // dry-run 予告用: 参照ゼロ + マーク済みの reserved|ready(grace 未判定)。
        // grace 適格判定は core が G2 isSweepEligible で行う(write ゼロ)。
        const rows = await db
          .select({ unreferencedAt: assets.unreferencedAt })
          .from(assets)
          .where(
            and(
              inArray(assets.status, ['reserved', 'ready']),
              isNotNull(assets.unreferencedAt),
              sql`NOT ${refsExists(assets.id)}`,
              userId ? eq(assets.userId, userId) : undefined,
            ),
          )
        return rows
      },
      checkRefsPopulated: async () => {
        // pre-sweep guard 材料。--user 指定時は両問い合わせを同 user に scope する。
        // UUID image key の存在は EXISTS で早期打切り(全 jsonb 展開を避ける)。
        // UUIDv4 判別は divergence 検査と同じ緩い正規表現(観測/backstop 用途)。
        const refUserScope = userId
          ? sql` WHERE ${cardAssetRefs.userId} = ${userId}::uuid`
          : sql``
        const imgUserScope = userId ? sql` AND c.user_id = ${userId}::uuid` : sql``
        const refRows = await db.execute<{ n: number }>(sql`
          SELECT COUNT(*)::int AS n FROM ${cardAssetRefs}${refUserScope}
        `)
        const hasKeyRows = await db.execute<{ present: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1
            FROM cards c, jsonb_array_elements(c.images) AS elem
            WHERE elem->>'key' ~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'${imgUserScope}
          ) AS present
        `)
        return {
          refRowCount: Number(refRows[0]?.n ?? 0),
          hasUuidImageKeys: Boolean(hasKeyRows[0]?.present),
        }
      },
      fetchCollectCandidates: async () => {
        const rows = await db
          .select({
            id: assets.id,
            userId: assets.userId,
            objectKey: assets.objectKey,
            status: assets.status,
            unreferencedAt: assets.unreferencedAt,
          })
          .from(assets)
          .where(
            and(
              inArray(assets.status, ['deleting', 'deleted']),
              userId ? eq(assets.userId, userId) : undefined,
            ),
          )
        return rows as CollectCandidate[]
      },
      fetchReferencedAssetIds: async (assetIds) => {
        const found = new Set<string>()
        for (let i = 0; i < assetIds.length; i += COLLECT_BATCH_SIZE) {
          const batch = assetIds.slice(i, i + COLLECT_BATCH_SIZE)
          const rows = await db
            .selectDistinct({ assetId: cardAssetRefs.assetId })
            .from(cardAssetRefs)
            .where(inArray(cardAssetRefs.assetId, batch))
          for (const r of rows) found.add(r.assetId)
        }
        return found
      },
      restoreToReady: async (assetId) => {
        await db
          .update(assets)
          .set({ status: 'ready', unreferencedAt: null })
          .where(eq(assets.id, assetId))
      },
      markDeleted: async (assetId) => {
        await db
          .update(assets)
          .set({ status: 'deleted' })
          .where(eq(assets.id, assetId))
      },
      deleteAssetRow: async (assetId) => {
        await db.delete(assets).where(eq(assets.id, assetId))
      },
      deleteObject,
      recordFailure: async ({ userId, assetId, objectKey, status, errorMessage }) => {
        await recordIntegrationFailure({
          key: 'r2_gc_delete',
          userId,
          errorMessage,
          subject: 'R2 GC: object delete failed',
          context: { assetId, objectKey, status },
        })
      },
      countRefDivergence: async () => {
        // dry-run 限定。cards.images(jsonb 配列)内 UUIDv4 key の総数 vs refs 行数。
        // 乖離大 = backfill 漏れ疑いの観測材料(spec §4.11-5)。全 jsonb 読みは重い
        // ため dry-run のみ。UUIDv4 判別は SQL 正規表現(isAssetKey と同 version=4 /
        // variant=8-b の緩い版 — 観測用途ゆえ厳密一致不要)。
        // --user 指定時は両カウントを同 user に絞る(reconciler 全体の owner-scope に
        // 整合)。全 user で数えると targeted stg 検証が偽の乖離を報告するため。
        const imgUserScope = userId ? sql` AND c.user_id = ${userId}::uuid` : sql``
        const refUserScope = userId
          ? sql` WHERE ${cardAssetRefs.userId} = ${userId}::uuid`
          : sql``
        const imgRows = await db.execute<{ n: number }>(sql`
          SELECT COUNT(*)::int AS n
          FROM cards c, jsonb_array_elements(c.images) AS elem
          WHERE elem->>'key' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'${imgUserScope}
        `)
        const refRows = await db.execute<{ n: number }>(sql`
          SELECT COUNT(*)::int AS n FROM ${cardAssetRefs}${refUserScope}
        `)
        return {
          imageUuidKeys: Number(imgRows[0]?.n ?? 0),
          refRows: Number(refRows[0]?.n ?? 0),
        }
      },
      log: (msg) => console.log(`[gc-image-assets] ${msg}`),
    },
  )

  // --- source lane(②-4a Task 14b′・網 = 二次防御) --------------------------
  // asset lane の mark-only 相当の概念が無い(source_assets に unreferenced_at 列
  // 無し)ため、--sweep 無しでは何もしない。--sweep --dry-run は write ゼロで予告
  // のみ(asset lane と同じ deleteObject stub の使い回し — willDeleteFromR2 の
  // 判定は asset/source 両lane で共通)。`--grace-days` は asset lane 専用のまま
  // (source lane の margin は SOURCE_RESERVED_NET_GRACE_MS 固定・CLI 化しない —
  // 上記 SOURCE LANE コメント参照)。
  if (sweep) {
    await runSourceReconciler(
      { dryRun, userId },
      buildSourceProductionDeps(db, userId, deleteObject),
    )
  }
}

// process.argv[1] が本 file のとき = CLI 起動。test import 時は走らない。
if (process.argv[1]?.endsWith('gc-image-assets.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[gc-image-assets] fatal:', err)
      process.exit(1)
    })
}
