// source-doc-status — 試験一覧ページ向け OCR 処理状態の DB 層ヘルパー。
//
// 提供する 3 エクスポート (すべて DB 関数):
//   1. getExamStatusMap            — DB 取得 + deriveExamStatuses の組み合わせ
//   2. reconcileStaleProcessing    — best-effort DB cleanup (stale processing → failed)
//   3. hasActiveProcessingUpload   — /app/upload UI guard 用 in-flight 存在判定
//
// pure 層 (STALE_PROCESSING_MS 定数 + deriveExamStatuses 純関数) は
// ./derive-exam-statuses に分離済みで、ここから import して使う。
//
// 設計方針:
//   - 一覧ページの render を絶対に止めないため、DB 関数はすべて例外を握りつぶす。
//   - 表示 fallback (deriveExamStatuses) と DB cleanup (reconcileStaleProcessing) を
//     分離することで、cleanup 失敗時も表示は正しく維持される。

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { sourceDocuments, uploadOperations, uploadRecords } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import {
  PREPARED_RETENTION_MS,
  STALE_PROCESSING_MS,
  deriveExamStatuses,
} from './derive-exam-statuses'

// ---------------------------------------------------------------------------
// isLiveUploadOperationCondition
// ---------------------------------------------------------------------------
// spec §11: an `upload_operations` row is "live" (still resumable) iff it is
// non-terminal (awaiting_sources/claimed/prepared) AND either (a) within
// `PREPARED_RETENTION_MS` of its immutable `created_at`, or (b) currently
// holding a valid lease (`lease_expires_at > now()` — a concurrently-
// advancing operation must never be swept/hidden regardless of age). All
// time comparisons use PostgreSQL `now()` (same discipline as the rest of the
// lease-fencing regime — the DB, not app clocks, is the arbiter).
//
// This condition builds a `WHERE`-fragment only (no I/O) so it composes with
// whichever query calls it. Shared by 3 call sites (rule of three, T14a fix
// round 2): `reconcileStaleProcessing` (source protection, negated form via
// NOT EXISTS below), `getExamStatusMap` (display op-awareness), and
// `scripts/gc-abandoned-operations.ts` (sweep candidate selection — the
// negation of this predicate, i.e. operations that do NOT satisfy it).
//
// Return type: drizzle's `and()`/`or()` are typed `SQL | undefined` in
// general (they can receive filtered-out/undefined branches elsewhere in the
// codebase), but here both arguments are always concrete `SQLWrapper`s, so
// `and(...)` is guaranteed non-undefined at runtime — the `!` below is safe
// and centralizes the assertion in this one place (rather than at every call
// site, notably `not(isLiveUploadOperationCondition())` in
// gc-abandoned-operations.ts, which requires a non-optional `SQLWrapper`).
//
// fix round 3(Codex + canonical Critical, both against real PG17): the lease
// branch MUST be NULL-free. SQL is three-valued — `lease_expires_at > now()`
// evaluates to NULL (not false) when `lease_expires_at IS NULL`, which is the
// **dominant** abandoned state (prepare-upload never sets a lease; every
// retryable-failure path resets `leaseExpiresAt: null`). For an aged-out row
// with a null lease: `false OR NULL = NULL`, so the whole condition is NULL.
// The 3 positive consumers (reconciler NOT EXISTS / getExamStatusMap /
// route.ts) use this un-negated in a WHERE/NOT-EXISTS, where NULL and false
// are both "excluded" — so they were accidentally correct despite the bug.
// But `scripts/gc-abandoned-operations.ts` uses `not(isLiveUploadOperationCondition())`
// as its WHERE predicate: `not(NULL) = NULL`, and Postgres WHERE treats NULL
// as false → the row was silently excluded from the sweep — i.e. the sweep
// found NOTHING for exactly the dominant case it exists to clean. Guarding
// the lease branch with `isNotNull` first (mirroring the `isNull`/`isNotNull`
// pattern already used in claim-operation.ts's CAS WHERE clauses) makes the
// branch a definite `false` when the lease is null, so the whole predicate is
// always a definite true/false — `not(...)` now works correctly. This is a
// no-op for the 3 positive consumers (verified by re-running their iso
// suites unchanged) and fixes the 4th (the sweep).
export function isLiveUploadOperationCondition(): SQL {
  return and(
    inArray(uploadOperations.status, ['awaiting_sources', 'claimed', 'prepared']),
    or(
      sql`${uploadOperations.createdAt} > now() - make_interval(secs => ${PREPARED_RETENTION_MS / 1000})`,
      and(isNotNull(uploadOperations.leaseExpiresAt), sql`${uploadOperations.leaseExpiresAt} > now()`),
    ),
  )!
}

// ---------------------------------------------------------------------------
// getExamStatusMap
// ---------------------------------------------------------------------------
// ユーザーの source_documents から exam ごと最新の 1 行を取得し、
// deriveExamStatuses に委譲する。
//
// D1 (S2.0c): 旧実装は user の source_documents を全件取得し JS 側で exam ごと
// 最新へ畳んでいた。 upload 履歴に比例して読む行が増えるため、
// DISTINCT ON (exam_id) + ORDER BY exam_id, created_at DESC で DB 側に畳み、
// exam 数ぶんの行だけ読む (source_docs_user_exam_created_idx を走査)。
// status で絞り込まないのは従来どおり: 「最新が completed か」を判定するには
// 最新行の status が必要で、 完了済 exam を取りこぼさないため。
//
// T14a fix round 2(Codex P2#1・display op-awareness): reconciler(DB cleanup)を
// window-aware にしただけでは不十分 — 表示 fallback(deriveExamStatuses)は
// 独立に「processing かつ 15 分超 → failed」を計算するため、live な
// upload_operations を持つ source_document でも DB 上は 'processing' のまま
// 正しく残る一方、表示だけが最大 7 日間 "failed" バッジを誤表示しうる。
// ゆえに live な upload_operations を持つ source_document の id 集合を追加で
// 取得し(owner-scope・同じ isLiveUploadOperationCondition 述語)、
// deriveExamStatuses(pure)へ渡して「live op を持つなら stale でも processing」
// 判定をさせる。 legacy(upload_operations 行が無い)source_document は空集合との
// 非包含により今までどおり 15 分超で failed 表示になる(挙動不変)。
//
// best-effort 設計:
//   - DB エラーで一覧ページの render を止めないため全体を try-catch で包む。
//   - 失敗時は空 Map を返す (バッジなし表示)。reconcileStaleProcessing と同じ方針。
//   - live-op 集合の取得は主 query とは別の try-catch に包み、失敗時は空集合
//     (= legacy と同じ「live-op 非考慮」の従来挙動)に degrade する — 主 query が
//     成功している限り、live-op 判定の失敗だけで exam 一覧全体を空 Map にしない。
export async function getExamStatusMap(
  userId: string,
  now: Date = new Date(),
): Promise<Map<string, 'processing' | 'failed'>> {
  try {
    const rows = await withTenantTx(userId, (tx) =>
      tx
        .selectDistinctOn([sourceDocuments.examId], {
          examId: sourceDocuments.examId,
          id: sourceDocuments.id,
          status: sourceDocuments.status,
          createdAt: sourceDocuments.createdAt,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.userId, userId)) // owner-scope 必須
        .orderBy(sourceDocuments.examId, desc(sourceDocuments.createdAt)),
    )

    let liveOpSourceDocumentIds = new Set<string>()
    try {
      const liveRows = await withTenantTx(userId, (tx) =>
        tx
          .selectDistinct({ sourceDocumentId: uploadOperations.sourceDocumentId })
          .from(uploadOperations)
          .where(
            and(eq(uploadOperations.userId, userId), isLiveUploadOperationCondition()),
          ),
      )
      liveOpSourceDocumentIds = new Set(
        liveRows
          .map((r) => r.sourceDocumentId)
          .filter((id): id is string => id !== null),
      )
    } catch (err) {
      logger.warn({ event: 'source_documents.get_status_map.live_ops_failed', userId, err })
    }

    return deriveExamStatuses(rows, now, liveOpSourceDocumentIds)
  } catch (err) {
    // best-effort: 一時的な DB エラーで一覧ページの render を落とさないよう warn のみ。
    // バッジ表示が消えるだけで、exam 一覧自体は正常に表示される。
    logger.warn({ event: 'source_documents.get_status_map.failed', userId, err })
    return new Map()
  }
}

// ---------------------------------------------------------------------------
// reconcileStaleProcessing
// ---------------------------------------------------------------------------
// 15 分以上 'processing' のまま残った source_documents を best-effort で
// status='failed' に変換し、 失敗台帳 (upload_records) に append する。
//
// best-effort 設計:
//   - 全体を try-catch で包み、例外時は logger.warn のみ。throw しない。
//   - 一覧ページの render を落とさないための安全弁。
//   - deriveExamStatuses による表示 fallback が機能するため、この cleanup が
//     失敗しても「表示だけ正しい」状態は維持される。
//
// 二重計上回避:
//   - UPDATE ... RETURNING で実際に processing→failed に変えた行のぶんだけを
//     upload_records に INSERT する (= 0 件更新なら upload_records に触らない)。
//
// T14a(spec §11「stale source 回収統合」): ②-4a の新 prepare→publish flow は
// prepared の再試行が 15 分(STALE_PROCESSING_MS)を跨ぎうる — 「source failed
// → 後から publisher が completed へ戻す」矛盾を避けるため、対象の
// source_document に紐づく upload_operations が **live(非終端: awaiting_sources
// /claimed/prepared)** な行を 1 件でも持つ場合はこの stale sweep の対象から
// 除外する(NOT EXISTS)。 legacy path(upload_operations 行が無い旧 flow)は
// 従来どおり 15 分超で failed 化される — 挙動不変。
//
// fix round 1(Codex P1): この除外は **window-aware**(無条件ではない)。
// claim-operation.ts の 7 日保持 cap(PREPARED_RETENTION_MS)は
// claimOperationTx が実際に呼ばれた時にしか発火しない — ゆえに一度も再 claim
// されない放置 op(例: source を最後まで upload しなかった awaiting_sources)は
// 非終端のまま**永久に**残り、無条件の除外だと対応する stale source_document を
// 永久に保護してしまう(定常的なリーク)。 「再開可能」とみなすのは
// (a) created_at が PREPARED_RETENTION_MS 以内、または (b) 現在有効な lease を
// 保持中(lease_expires_at > now() — concurrently-advancing operation を
// 絶対に sweep しない)のいずれかのみ。 両方外れた(=期限切れかつ 7 日超 =
// 誰かが claim すれば terminal_failed になる状態)非終端行はもはや source を
// 保護しない。 時刻比較は全て PostgreSQL now() 基準。
export async function reconcileStaleProcessing(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const staleThreshold = new Date(now.getTime() - STALE_PROCESSING_MS)

    await withTenantTx(userId, async (tx) => {
      // 1. stale processing 行を failed に UPDATE し、更新行の id / filename /
      //    fileSizeBytes を返す (二重計上回避のため RETURNING 結果のみを起点にする)
      const updated = await tx
        .update(sourceDocuments)
        .set({
          status: 'failed',
          errorMessage: '処理時間の上限を超えたため中断されました',
        })
        .where(
          and(
            eq(sourceDocuments.userId, userId), // owner-scope 必須
            eq(sourceDocuments.status, 'processing'),
            lt(sourceDocuments.createdAt, staleThreshold),
            // T14a: live な upload_operations(非終端)を持つ source_document は
            // 除外する(spec §11)。 相関 subquery も owner-scope を明示する
            // (RLS に加えて query 自体でも user_id を絞る・CLAUDE.md 絶対ルール)。
            notExists(
              tx
                .select({ id: uploadOperations.id })
                .from(uploadOperations)
                .where(
                  and(
                    eq(uploadOperations.userId, userId),
                    eq(uploadOperations.sourceDocumentId, sourceDocuments.id),
                    // window-aware(fix round 1・shared predicate as of fix
                    // round 2): 再開可能な間だけ保護する。
                    isLiveUploadOperationCondition(),
                  ),
                ),
            ),
          ),
        )
        .returning({
          id: sourceDocuments.id,
          filename: sourceDocuments.filename,
          fileSizeBytes: sourceDocuments.fileSizeBytes,
        })

      // 2. 実際に更新された行が 0 件なら upload_records には触らない
      //    (空配列 INSERT は避けつつ、不要な DB round-trip も防ぐ)
      if (updated.length === 0) return

      // 3. 更新した行それぞれについて upload_records に failed 台帳行を append。
      //    markFailed (process.ts) と同じ値の入れ方: pagesProcessed=0, ocrCostYen=0。
      //    月次 quota SUM は status='completed' のみ対象のため、消費には計上されない。
      await tx.insert(uploadRecords).values(
        updated.map((row) => ({
          userId,
          filename: row.filename,
          fileSizeBytes: row.fileSizeBytes,
          pagesProcessed: 0,
          ocrCostYen: 0,
          status: 'failed' as const,
        })),
      )
    })
  } catch (err) {
    // best-effort: cleanup 失敗は warn のみ、throw しない。
    // deriveExamStatuses による表示 fallback が維持されるため影響範囲は最小。
    logger.warn({
      event: 'source_documents.reconcile_stale.failed',
      userId,
      err,
    })
  }
}

// ---------------------------------------------------------------------------
// hasActiveProcessingUpload
// ---------------------------------------------------------------------------
// /app/upload ページの UI guard 用 helper。
// 「current user に、15 分以内に作成された status='processing' の
// source_documents が 1 件でもあるか」 を boolean で返す。
//
// 15 分 window の理由:
//   stale orphan (reconcile 前の死骸: >15 分の processing 残骸) を
//   「in-flight」 と誤判定しないための safety net。
//   process.ts の server-side guard (in-flight check) と同じ条件
//   (STALE_PROCESSING_MS を共有) で揃えることで、 UI guard と server guard の
//   判定が drift しない。
//
// best-effort 設計:
//   この helper は /app/upload の UI guard 用で、 UI guard は advisory な
//   第一層に過ぎず、 真の enforcement は process.ts の server-side guard が担う。
//   helper が DB エラーで失敗した場合は「form を出す」 側に倒し (false を返す)、
//   ユーザーを不当にブロックしない。 実際の重複起動は server-side guard で弾かれる。
//
// index 利用:
//   source_docs_status_idx (user_id, status) を直撃する軽量 query。
//   SELECT は存在判定のみなので最小列 (id) + LIMIT 1 で十分。
export async function hasActiveProcessingUpload(
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    // STALE_PROCESSING_MS (15 分) 以内に作成された processing 行があるか判定。
    // 15 分より古い processing 行は stale orphan (reconcile 待ち) とみなし
    // 「in-flight」として数えない。
    const activeThreshold = new Date(now.getTime() - STALE_PROCESSING_MS)
    const rows = await withTenantTx(userId, (tx) =>
      tx
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(
          and(
            eq(sourceDocuments.userId, userId), // owner-scope 必須
            eq(sourceDocuments.status, 'processing'),
            gte(sourceDocuments.createdAt, activeThreshold), // 15 分以内のみ in-flight 扱い
          ),
        )
        .limit(1),
    )
    return rows.length > 0
  } catch (err) {
    // best-effort: DB エラー時は warn のみ、throw しない。
    // UI guard が失敗しても server-side guard が enforcement を担うため、
    // false (= form を表示) 側に倒してユーザーを不当にブロックしない。
    logger.warn({
      event: 'source_documents.has_active_processing.failed',
      userId,
      err,
    })
    return false
  }
}
