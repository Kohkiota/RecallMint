import { and, eq, sql } from 'drizzle-orm'

import { getNonTenantDb } from '@/lib/db'
import { assets } from '@/lib/db/schema'
import { withTenantTx } from '@/lib/db/tenant-tx'
import {
  recordIntegrationFailure,
  type IntegrationFailureKey,
} from '@/lib/integration-failures'
import { logger } from '@/lib/logger'
import { runReconciler, buildReconcilerDeps, COLLECT_LIMIT_PER_USER } from './asset-gc'
import { deleteObject, DELETE_TIMEOUT_MS } from './r2'

// asset GC cron lane(asset レーン整合 sprint spec §3.3〜§3.5:
// docs/superpowers/specs/2026-08-10-asset-lane-gc-design.md)。core(runReconciler +
// production deps の SQL)は lib/storage/asset-gc.ts(Task 2)で**無改造**のまま置か
// れている(spec §3.1)。本 file は 列挙 → per-user 実行 → 集約 → 台帳 のみを持つ
// (src-sweep.ts と違い、判定 pure 関数は無い — asset_gc の判定は core の SQL 側にある
// ため §3.3a で「boundedness は deps 注入で作る」と裁定済み)。
//
// boundedness(collect の LIMIT・R2 timeout・記帳 quota)は全て deps 側
// (buildReconcilerDeps への collectLimit / deleteObject 注入)で作る(spec §3.3a)。
// 本 lane は deadline を **user 境界でのみ**確認する — core の collect ループ内部には
// 入れない(B-9: core 無改造の帰結)。

// lane 予算(独立定義。src-sweep.ts の SWEEP_* と値が同じでも意味は別 — lane ごとに
// 定数を独立定義する規律により import 共有しない)。
const ASSET_GC_TAIL_RESERVE_MS = 10_000 // 最終 incomplete 行を書くための先取り分
const ASSET_GC_MIN_SLICE_MS = 2_000 // floor。残予算がこれ未満なら次 user を起動しない
// 行 DELETE 失敗の台帳暴走防止(spec §3.3a「受容する停滞シナリオ」— 同一 objectKey の
// 失敗行が連日出ることを手動介入トリガーとして観測可能にする quota)。
const ASSET_GC_MAX_ROW_DELETE_FAILURE_ROWS = 20

// incomplete 行の phase(spec §3.5)。配列順 = 優先順位(より早く諦めた事実を残す)。
// user_error(guard trip・user 単位 throw)が deadline より優先(plan Task 5 記載順)。
// `enumerate`(final review I-2 fix・2026-08-10): user 列挙(app_list_asset_gc_user_ids)
// 自体が失敗した最優先(配列先頭)の失敗様式。列挙が取れない = lane 全体が 0 user で
// 無効化される最も早い段階の失敗であり、他 2 つ(user 単位の後発失敗)より常に優先する。
const ASSET_GC_PHASES = ['enumerate', 'user_error', 'deadline'] as const
type AssetGcPhase = (typeof ASSET_GC_PHASES)[number]

function higherPriorityPhase(
  current: AssetGcPhase | null,
  next: AssetGcPhase,
): AssetGcPhase {
  if (current === null) return next
  return ASSET_GC_PHASES.indexOf(next) < ASSET_GC_PHASES.indexOf(current)
    ? next
    : current
}

// 単位が field ごとに違う(object 数 / user 数)。読み手が取り違えると比較不能な
// 引き算をしてしまうため、各 field に単位を明記する(src-sweep の SrcSweepSummary と
// 同じ規律)。
export type AssetGcSummary = {
  lane: 'asset_gc'
  usersListed: number // user 数(列挙結果 or userScope 指定時は 1)
  usersProcessed: number // user 数(runReconciler が例外なく完了した user)
  usersSkipped: number // user 数(guard trip 含む per-user throw で skip)
  scanned: number // object 数(処理した全 user の scannedAssets 合算)
  referenced: number // object 数
  marked: number // object 数
  cleared: number // object 数
  promoted: number // object 数
  r2DeleteOk: number // object 数
  r2Delete404: number // object 数
  r2DeleteFailed: number // object 数
  rowDeleteOk: number // object 数
  rowDeleteFailed: number // object 数
  deletedLaneProcessed: number // object 数
  selfHealed: number // object 数
  unknownStatus: number // object 数
  phase: string | null
  // 記帳(recordIntegrationFailure)自体の失敗数。台帳 + Discord がこの lane の唯一の
  // 観測点である以上、その経路が壊れた事実は別経路(summary / logger)で見えなければ
  // ならない(src-sweep と同じ規律)。
  recordErrors: number
  graceDaysOverride?: number // override 指定時のみ出現(readback 用。判定はしない)
  userScope?: string // userScope 指定時のみ出現
  error?: string
}

/**
 * asset GC(mark/promote/collect)を日次 cron の 1 lane として実行する(spec
 * §3.3〜§3.5)。
 *
 * **この関数は throw しない契約**: 大域 catch → `summary.error` + `logger.error`。
 * cron runner は summary をそのまま readback に載せる。
 *
 * `now` は時刻注入 — 実 sleep なしで打ち切りを test するため(src-sweep と同じ idiom)。
 */
export async function runAssetGcLane(args: {
  deadlineAt: Date
  graceDays: number
  graceDaysOverride?: number
  userScope?: string
  now?: () => number
}): Promise<AssetGcSummary> {
  const now = args.now ?? Date.now
  const workDeadline = args.deadlineAt.getTime() - ASSET_GC_TAIL_RESERVE_MS
  const slice = () => workDeadline - now()

  let usersListed = 0
  let usersProcessed = 0
  let usersSkipped = 0
  let scanned = 0
  let referenced = 0
  let marked = 0
  let cleared = 0
  let promoted = 0
  let r2DeleteOk = 0
  let r2Delete404 = 0
  let r2DeleteFailed = 0
  let rowDeleteOk = 0
  let rowDeleteFailed = 0
  let deletedLaneProcessed = 0
  let selfHealed = 0
  let unknownStatus = 0
  let recordErrors = 0
  let phase: AssetGcPhase | null = null
  let error: string | undefined
  // per-user の collect 内(runReconciler の recordFailure seam)と、行 DELETE 失敗の
  // 記帳 loop の両方から加算されるため、両方より前で宣言する(spec §3.3a の記帳
  // 上限・quota 超過ぶんも同じ counter に合流させる)。
  let suppressedFailures = 0
  // per-user runReconciler が返した rowDeleteFailures(assetId)を userId 付きで集める
  // (再検索は per-user の tenant tx が要るため userId を保持する)。
  const rowDeleteFailures: { userId: string; assetId: string }[] = []

  // 記帳 1 本ごとに独立の try/catch(不変条件・src-sweep writeRow と同型)。
  // recordIntegrationFailure は notifyOps の production fail-fast throw を伝播するため、
  // 大域 catch だけだと 1 本の記帳失敗が以降の記帳まで巻き込む。
  const writeRow = async (row: {
    key: Extract<IntegrationFailureKey, `r2_gc_${string}`>
    subject: string
    userId?: string
    context: Record<string, unknown>
  }): Promise<void> => {
    try {
      await recordIntegrationFailure({
        key: row.key,
        userId: row.userId,
        subject: row.subject,
        context: row.context,
      })
    } catch (err) {
      recordErrors++
      logger.error({ event: 'asset_gc.record_failed', key: row.key, err })
    }
  }

  try {
    let userIds: string[]
    if (args.userScope) {
      // userScope 指定時は列挙を打たず単一 user 実行(plan Task 5)。
      userIds = [args.userScope]
    } else {
      // pre-tenant site(理由・必読): tenant context を張る前に「GC 作業のある user」を
      // 横断列挙する必要があり、RLS 対象表(assets)を直接読んでいるわけではない。
      // app_list_asset_gc_user_ids()(SECURITY DEFINER・migration 0033)が uuid 集合
      // のみを返す迂回口を提供する(spec §3.2)。得た uuid だけでは他 user の行を読める
      // わけではなく、安全性は「以降の per-user 実行が必ず withTenantTx を張ること」に
      // 依存する(関数コメント参照)。
      //
      // 独自 try/catch(final review I-2 fix): この throw が内側 catch 無しに
      // 大域 catch まで抜けると usersProcessed=0 かつ suppressedFailures=0 のまま
      // summary.error にだけ畳まれ、末尾の `if (phase !== null || suppressedFailures
      // > 0)` が不成立で r2_gc_incomplete が 1 行も書かれない(= lane を無効化する
      // 唯一の失敗が唯一観測できない失敗になる・migration 0033 未適用 / GRANT 漏れ等
      // で現実的に起きうる)。兄弟 2 lane(listing 失敗)と同じく phase 化して必ず
      // 記帳経路に載せる。
      try {
        const rows = await getNonTenantDb().execute<{
          app_list_asset_gc_user_ids: string
        }>(sql`SELECT * FROM public.app_list_asset_gc_user_ids()`)
        userIds = rows.map((r) => r.app_list_asset_gc_user_ids)
      } catch (err) {
        phase = higherPriorityPhase(phase, 'enumerate')
        logger.error({ event: 'asset_gc.enumerate_failed', err })
        userIds = []
      }
    }
    usersListed = userIds.length

    for (const userId of userIds) {
      // deadline 確認は **user 境界のみ**(B-9: core 内部には入れない・spec §3.3a)。
      if (slice() < ASSET_GC_MIN_SLICE_MS) {
        phase = higherPriorityPhase(phase, 'deadline')
        break
      }

      try {
        const deps = buildReconcilerDeps({
          exec: (fn) => withTenantTx(userId, fn),
          userId,
          collectLimit: COLLECT_LIMIT_PER_USER,
          // `slice()` は 1 user の collect batch(最大 COLLECT_LIMIT_PER_USER 件)後半で
          // 負値になりうる(core の collect loop に per-item recheck が無い = spec
          // §3.3a の設計どおり・src-sweep の chunk 単位 recheck とは違う)。
          // `AbortSignal.timeout()` は負値を渡すと**即発火ではなく** `RangeError` を
          // 同期 throw する(Node 24 実測 pin)ため、ここで `Math.max(0, …)` により
          // 0 に clamp する。clamp しないと「呼び出し先(`deleteObject`/r2.ts)が
          // `AbortSignal.timeout()` の呼出ごと try で囲み catch で `{ok:false,
          // status:null}` に正規化している」という**遠隔の catch-all**に正しさを
          // 預けることになり、将来その catch を narrow にする変更でこの lane が
          // silent に壊れうる。clamp すれば局所的に正しい: 0ms timeout は
          // **生成時点ではまだ abort していない**(`AbortSignal.timeout(0).aborted`
          // は生成直後・microtask を挟んでも false・次の macrotask で true になる。
          // 実測 pin)が、次 tick で確実に abort し `deleteObject` が
          // `{ok:false,status:null}` を返す → core が `r2DeleteFailed` として計上・
          // 台帳記帳・asset は `deleting` のまま存置 → 翌日 run が再試行、という
          // degrade 経路になる。
          deleteObject: (key) =>
            deleteObject(key, {
              timeoutMs: Math.max(0, Math.min(DELETE_TIMEOUT_MS, slice())),
            }),
          onRecordError: () => {
            recordErrors++
          },
          // 記帳の上限(spec §3.3a 3 番目の bounding 手段)。R2 削除失敗の記帳
          // (`r2_gc_delete`)は core の collect loop 内で 1 件ずつ notifyOps の
          // fetch(最大 ~3s)を待つため、残 slice が尽きたら書かず suppressed に
          // 畳む — 行 DELETE 失敗の記帳 loop(下記)と同じ guard を、core 側の
          // 記帳経路(asset-gc.ts の recordFailure)にも注入する。
          shouldRecord: () => slice() >= ASSET_GC_MIN_SLICE_MS,
          onSuppressed: () => {
            suppressedFailures++
            phase = higherPriorityPhase(phase, 'deadline')
          },
          log: (msg) => logger.info({ event: 'asset_gc.reconciler', userId, msg }),
        })
        const userSummary = await runReconciler(
          { sweep: true, dryRun: false, graceDays: args.graceDays, userId },
          deps,
        )
        usersProcessed++
        scanned += userSummary.scannedAssets
        referenced += userSummary.referencedAssets
        marked += userSummary.marked
        cleared += userSummary.cleared
        promoted += userSummary.promoted
        r2DeleteOk += userSummary.r2DeleteOk
        r2Delete404 += userSummary.r2Delete404
        r2DeleteFailed += userSummary.r2DeleteFailed
        rowDeleteOk += userSummary.rowDeleteOk
        rowDeleteFailed += userSummary.rowDeleteFailed
        deletedLaneProcessed += userSummary.deletedLaneProcessed
        selfHealed += userSummary.selfHealed
        unknownStatus += userSummary.unknownStatus
        for (const assetId of userSummary.rowDeleteFailures) {
          rowDeleteFailures.push({ userId, assetId })
        }
      } catch (err) {
        // per-user 例外(pre-sweep guard trip 含む)はその user だけ skip し続行する
        // (spec §3.3「trip はその user だけ skip」)。
        usersSkipped++
        phase = higherPriorityPhase(phase, 'user_error')
        logger.error({ event: 'asset_gc.user_error', userId, err })
      }
    }

    // 行 DELETE 失敗の台帳化(B-3): assetId ごとに object_key + status を再検索する。
    // RLS 下でも user_id 条件は query 側にも明示する(CLAUDE.md 絶対ルール)。
    // `suppressedFailures` は per-user loop 側(shouldRecord/onSuppressed)からも
    // 加算されうるため、宣言はこの loop より前(関数冒頭)にある。
    let rowDeleteFailureRows = 0
    for (const { userId, assetId } of rowDeleteFailures) {
      if (rowDeleteFailureRows >= ASSET_GC_MAX_ROW_DELETE_FAILURE_ROWS) {
        suppressedFailures++
        continue
      }
      // 残予算が尽きたら記帳を止め、書けなかった件数を suppressedFailures に畳む
      // (src-sweep.ts:391-400 と同型の guard)。記帳は 1 本ずつ
      // recordIntegrationFailure → notifyOps の fetch(最大 ~3s abort)を待つため、
      // quota 上限(20)まで無条件に回すと最大 20×~3s ≈ 60s を無防備に費やしうる
      // (`ASSET_GC_TAIL_RESERVE_MS` = 10s では足りない)。tail reserve が守るべき
      // 当の行(この run 唯一の観測信号である `r2_gc_incomplete`)を書く前に
      // platform に殺される事態を防ぐ。
      if (slice() < ASSET_GC_MIN_SLICE_MS) {
        phase = higherPriorityPhase(phase, 'deadline')
        suppressedFailures++
        continue
      }
      rowDeleteFailureRows++

      let objectKey: string | null = null
      let status: string | null = null
      try {
        const rows = await withTenantTx(userId, (tx) =>
          tx
            .select({ objectKey: assets.objectKey, status: assets.status })
            .from(assets)
            .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
            .limit(1),
        )
        objectKey = rows[0]?.objectKey ?? null
        status = rows[0]?.status ?? null
      } catch (err) {
        // 再検索の失敗事実を落とさない(B-3): objectKey/status は null のまま記帳する。
        logger.warn({
          event: 'asset_gc.row_delete_lookup_failed',
          userId,
          assetId,
          err,
        })
      }
      await writeRow({
        key: 'r2_gc_row_delete',
        subject: 'asset GC: assets row delete failed',
        userId,
        context: { assetId, objectKey, status },
      })
    }

    // incomplete 行は 1 run 最大 1 行(spec §3.5)。
    if (phase !== null || suppressedFailures > 0) {
      await writeRow({
        key: 'r2_gc_incomplete',
        subject: 'asset GC: run incomplete',
        context: {
          ...(phase !== null ? { phase } : {}),
          usersProcessed,
          usersSkipped,
          ...(suppressedFailures > 0 ? { suppressedFailures } : {}),
        },
      })
    }
  } catch (err) {
    // `String(err)` のみを保持する(src-sweep と同じ規律): エラーオブジェクトを
    // そのまま summary に載せると R2 応答 body / query 文字列等の PII/内部情報が
    // readback 経路(cron summary)へ漏れうるため、テキスト化した最小限のみ残す。
    error = String(err)
    logger.error({ event: 'asset_gc.failed', err })
  }

  return {
    lane: 'asset_gc',
    usersListed,
    usersProcessed,
    usersSkipped,
    scanned,
    referenced,
    marked,
    cleared,
    promoted,
    r2DeleteOk,
    r2Delete404,
    r2DeleteFailed,
    rowDeleteOk,
    rowDeleteFailed,
    deletedLaneProcessed,
    selfHealed,
    unknownStatus,
    phase,
    recordErrors,
    ...(args.graceDaysOverride !== undefined
      ? { graceDaysOverride: args.graceDaysOverride }
      : {}),
    ...(args.userScope !== undefined ? { userScope: args.userScope } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}
