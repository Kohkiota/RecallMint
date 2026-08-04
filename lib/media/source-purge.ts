import 'server-only'
// source-purge — ②-4a Task 14b′(2026-08-03・OT 確定)主経路: op が terminal
// (completed または terminal_failed)になった直後に、その op の source_assets を
// 同期的に purge する共有 helper。
//
// 新軸(risk 反転・OT 確定): source(OCR 元画像)は著作物の疑いゆえ R2 に残さない。
// provenance(asset_derivations)消失は許容 / source が R2 に消え残ることは
// 受容しない(最優先)。
//
// 契約(brief §層1 = 主経路):
//   1. tx: 当該 source_document の 'reserved'|'ready' な source_assets を
//      status='deleting' へ mark(bulk UPDATE・owner-scope・I/O なし・
//      object_key 保全)。grace は無い(呼出元は「まさに今 terminal になった」
//      ことを既に知っているため — scripts/gc-image-assets.ts の網が担う grace
//      付き判定とは別レイヤー)。
//   2. tx commit 後: mark した source を collect(R2 DELETE → 行 DELETE)。
//      R2/行 DELETE 失敗は `integration_failures` に記録し、行は 'deleting' の
//      まま残す(loud failure・網が拾う)。
//
// net-safe 順序(絶対不変・brief「Hard constraints」): mark(deleting・行残す)
// → R2 DELETE → 行 DELETE。行を R2 より先に消さない(fact-finding 経路 C 型
// orphan = 行消滅で row 駆動網が発見不能、を絶対に作らない)。
//
// scripts/gc-image-assets.ts の source lane(網)と同じ decouple 契約に倣うが、
// 呼出元が異なる(app runtime の Server Action = tenant-scoped `withTenantTx`
// 経由 / script = operator 権限の `getAdminDb()` 経由)ため関数は独立している
// (RLS-P3 の getDb 封じ込め: `getDb` は lib/db/ 内部限定・app 層は
// `withTenantTx(userId, fn)` を使う。scripts/** は operator tooling として
// `getAdminDb()` を使う例外)。rule of three(呼出箇所 2 = 共通化しない・CLAUDE.md
// 簡潔性規律)により、この 2 実装を無理に 1 module へ統合しない。
//
// 詳細: .superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/task-14b-prime-brief.md

import { and, eq, inArray } from 'drizzle-orm'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { sourceAssets, uploadOperations } from '@/lib/db/schema'
import { deleteObject } from '@/lib/storage/r2'
import { recordIntegrationFailure } from '@/lib/integration-failures'
import { logger } from '@/lib/logger'

// ②-4a Task 14b′ observability fix(2026-08-03・OT 指示): purge は成功時に無言
// だった — stg smoke が「purge が走って速かった」と「purge が一度も呼ばれて
// いない」を区別できないのは、新軸の中核 action として受容できない。5つの
// terminal action それぞれが渡す trigger を union 型(string でなく)にすることで、
// 呼出側の追加漏れを typecheck が強制する(この union が本 task の completeness
// 保証そのもの)。
export type SourcePurgeTrigger =
  | 'publish_completed'
  | 'publish_terminal'
  | 'claim_terminal'
  | 'stage_terminal'
  | 'abandon'
  | 'supersede'

// R2/行とも実際に削除できた source の識別子(PII/画像内容は含まない・uuid と
// R2 key のみ)。stg smoke の「何が消えたか」証跡。
export type PurgedSourceAsset = {
  sourceAssetId: string
  objectKey: string
}

export type PurgeOperationSourcesSummary = {
  marked: number
  r2DeleteOk: number
  r2Delete404: number
  r2DeleteFailed: number
  rowDeleteOk: number
  rowDeleteFailed: number
  reclaimed: PurgedSourceAsset[]
}

/**
 * 当該 sourceDocument 配下の 'reserved'|'ready' な source_assets を無条件で
 * purge する。呼出元(action 層)は「op が terminal になった直後」にのみ呼ぶ
 * (post-commit・fenced tx 自体は変更しない — brief「主経路は各 action が terminal
 * 遷移の commit 後に呼ぶ」)。冪等: 対象が無ければ何もしない(重複呼出は安全)。
 *
 * `trigger`: どの terminal action がこの呼出を発火させたか(observability
 * fix・2026-08-03)。ログにのみ使う(purge の判定/削除ロジックには一切影響しない)。
 */
export async function purgeOperationSources(
  userId: string,
  sourceDocumentId: string,
  trigger: SourcePurgeTrigger,
): Promise<PurgeOperationSourcesSummary> {
  const summary: PurgeOperationSourcesSummary = {
    marked: 0,
    r2DeleteOk: 0,
    r2Delete404: 0,
    r2DeleteFailed: 0,
    rowDeleteOk: 0,
    rowDeleteFailed: 0,
    reclaimed: [],
  }

  // 1. mark(bulk UPDATE・grace 無し・object_key 保全)。
  const marked = await withTenantTx(userId, (tx) =>
    tx
      .update(sourceAssets)
      .set({ status: 'deleting' })
      .where(
        and(
          eq(sourceAssets.sourceDocumentId, sourceDocumentId),
          eq(sourceAssets.userId, userId),
          inArray(sourceAssets.status, ['reserved', 'ready']),
        ),
      )
      .returning({ id: sourceAssets.id }),
  )
  summary.marked = marked.length

  // 2. collect(commit 後の fresh read・この sourceDocument 配下の 'deleting' 全件
  // — 今回 mark した分に加え、前回の main-path 呼出が R2/行 DELETE に失敗して
  // 'deleting' のまま残した分も一緒に拾う。冪等かつ取りこぼしを縮める)。
  const candidates = await withTenantTx(userId, (tx) =>
    tx
      .select({ id: sourceAssets.id, objectKey: sourceAssets.objectKey })
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.sourceDocumentId, sourceDocumentId),
          eq(sourceAssets.userId, userId),
          eq(sourceAssets.status, 'deleting'),
        ),
      ),
  )

  for (const sa of candidates) {
    const res = await deleteObject(sa.objectKey)
    if (!res.ok) {
      // R2 失敗: 行を deleting のまま存置し台帳記録(scripts/gc-image-assets.ts
      // の source lane と同じ decouple 契約・key='r2_gc_delete_source' を共用)。
      // 台帳書込自体が throw しても握って続行する(1 件の失敗が purge 全体を
      // 止めない・per-source isolation)。
      summary.r2DeleteFailed++
      try {
        await recordIntegrationFailure({
          key: 'r2_gc_delete_source',
          userId,
          errorMessage: `R2 delete failed (status=${res.status ?? 'null'})`,
          subject: 'R2 GC: source object delete failed',
          context: { sourceAssetId: sa.id, objectKey: sa.objectKey },
        })
      } catch (err) {
        logger.error({
          event: 'source_purge.record_failure_threw',
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
      // Codex fix(2026-08-03 review): `.returning()` で実際に影響した行を見る。
      // 並行 purge(design が明示的に許容する冪等 replay / defense-in-depth の
      // 二重呼出・例 abandon-operation.ts の 'abandoned'/'completed' 両分岐)が
      // 同じ 'deleting' candidate を select しうる — 先着の DELETE だけが行に
      // 効き、後着は 0 行 DELETE になる。Drizzle は 0 行 DELETE で throw しない
      // ため、`.returning()` を見ずに rowDeleteOk++/reclaimed.push すると
      // 後着が「自分が reclaim した」と誤って報告してしまう(telemetry の目的
      // そのものに反する)。0 行 = 他の並行呼出が既に消していた(R2 側の 404 と
      // 対称の状況)ため、silent に何もカウントしない(loud failure ではない —
      // エラーではなく正常な race の帰結)。
      const deletedRows = await withTenantTx(userId, (tx) =>
        tx
          .delete(sourceAssets)
          .where(and(eq(sourceAssets.id, sa.id), eq(sourceAssets.userId, userId)))
          .returning({ id: sourceAssets.id }),
      )
      if (deletedRows.length > 0) {
        summary.rowDeleteOk++
        // R2+行とも実際に消えた source のみ reclaimed(観測用・識別子+R2 key
        // のみ、PII/画像内容を含まない)。
        summary.reclaimed.push({ sourceAssetId: sa.id, objectKey: sa.objectKey })
      }
    } catch (err) {
      summary.rowDeleteFailed++
      logger.error({
        event: 'source_purge.row_delete_failed',
        sourceAssetId: sa.id,
        objectKey: sa.objectKey,
        err,
      })
    }
  }

  // success-path observability(2026-08-03 OT 指示): purge は従来 成功時に無言
  // だった — stg smoke が「purge が走って速かった」と「一度も呼ばれていない」を
  // 区別できないのは新軸の中核 action として受容できない。failure は既に
  // recordIntegrationFailure + logger.error(上記)で trace 済のためここでは
  // 二重報告しない — ここは「呼ばれたこと自体」+ 成功実績の trace。
  if (summary.marked === 0 && candidates.length === 0) {
    // mark 対象も既存 'deleting' 残置もゼロ = 呼ばれたが purge すべき source が
    // 無かった(「呼ばれて何もしなかった」を「呼ばれていない」と区別する)。
    logger.info({ event: 'source_purge.noop', trigger, userId, sourceDocumentId })
  } else {
    logger.info({
      event: 'source_purge.done',
      trigger,
      userId,
      sourceDocumentId,
      marked: summary.marked,
      r2DeleteOk: summary.r2DeleteOk,
      r2Delete404: summary.r2Delete404,
      r2DeleteFailed: summary.r2DeleteFailed,
      rowDeleteOk: summary.rowDeleteOk,
      rowDeleteFailed: summary.rowDeleteFailed,
      reclaimed: summary.reclaimed,
    })
  }

  return summary
}

/**
 * operationId しか手元に無い呼出元(claim/abandon/stage の action wrapper)向けの
 * 薄いラッパー。terminal 遷移の commit 直後に呼ぶ post-commit read として、
 * upload_operations.source_document_id を引き直してから purgeOperationSources
 * を呼ぶ(fenced tx 自体は変更しない・「post-commit at the action level」の
 * 契約を保つ)。sourceDocumentId が無い(FK が SET NULL 済 = source_document が
 * 既に削除された)場合は no-op(purge 対象が無い)。
 *
 * 「fresh transition か idempotent replay(冪等再送)か」は区別しない —
 * purgeOperationSources は冪等(対象が無ければ何もしない)なので、terminal を
 * 観測するたびに毎回呼んでも安全かつ無害(主経路の取りこぼしに対する
 * defense-in-depth にもなる)。区別のために ClaimOperationResult 等の型を
 * 拡張しない、という簡潔性規律に基づく判断(report 参照)。
 *
 * `trigger`: purgeOperationSources へそのまま透過する(observability fix・
 * 2026-08-03)。
 */
export async function purgeOperationSourcesForOp(
  userId: string,
  operationId: string,
  trigger: SourcePurgeTrigger,
): Promise<void> {
  const rows = await withTenantTx(userId, (tx) =>
    tx
      .select({ sourceDocumentId: uploadOperations.sourceDocumentId })
      .from(uploadOperations)
      .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, userId))),
  )
  const sourceDocumentId = rows[0]?.sourceDocumentId
  if (sourceDocumentId) {
    await purgeOperationSources(userId, sourceDocumentId, trigger)
  } else {
    // sourceDocumentId が無い(FK が SET NULL 済 = source_document が既に
    // 削除された)= purge 対象が無い呼出。「呼ばれたが対象が無かった」を
    // 「呼ばれていない」と区別するための trace(observability fix)。
    logger.info({
      event: 'source_purge.noop',
      trigger,
      userId,
      operationId,
      reason: 'source_document_null',
    })
  }
}
