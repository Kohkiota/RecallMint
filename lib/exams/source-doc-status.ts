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
  isNull,
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { sourceDocuments, uploadOperations, uploadRecords } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { STALE_PROCESSING_MS, deriveExamStatuses } from './derive-exam-statuses'

// ---------------------------------------------------------------------------
// isLiveUploadOperationCondition
// ---------------------------------------------------------------------------
// ②-4a 単一 invocation spec(2026-08-04)§5: an `upload_operations` row is
// "live" iff it is non-terminal AND currently holding a valid lease
// (`lease_expires_at > now()`). All time comparisons use PostgreSQL `now()`
// (same discipline as the rest of the lease-fencing regime — the DB, not app
// clocks, is the arbiter).
//
// **S-4 の簡素化(仕様変更)**: 旧述語は「(a) `created_at` が
// `PREPARED_RETENTION_MS`(7 日)以内 **または** (b) valid lease」だった。(a) の
// 存在理由は「retryable な prepared operation を後から再 claim して再開できる」
// という旧 prepare→publish flow の resume 機構(旧 spec §11)であり、新経路は
// resume を持たない(失敗は全て terminal・再試行主体は居ない = spec §4.5)ため
// 根拠ごと消滅した。lease だけが「今このオペレーションを進めている invocation が
// 生存している」表明であり、それが唯一の live の定義になる。
// 帰結 = invocation が死んだときの「処理中」表示が **最大 7 日 → 最大 ~15 分**
// (LEASE_TTL_MS)に短縮される。
//
// `PREPARED_RETENTION_MS` 定数そのものは残す(claim-operation.ts の 7 日 cap が
// 旧経路で参照中 — 撤去は S-5)。
//
// This condition builds a `WHERE`-fragment only (no I/O) so it composes with
// whichever query calls it. **Shared by 5 call sites** (count corrected in
// S-4 — the comment said 3 while route.ts and gc-image-assets.ts had already
// been added; anyone assessing a change to this predicate must weigh all 5):
//   1. `reconcileStaleProcessing` (source protection, negated form via
//      NOT EXISTS below)
//   2. `getExamStatusMap` (display op-awareness)
//   3. `app/api/exams/status/route.ts` (poll endpoint — same display awareness)
//   4. `scripts/gc-abandoned-operations.ts` (sweep candidate selection — the
//      negation of this predicate, i.e. operations that do NOT satisfy it)
//   5. `scripts/gc-image-assets.ts` source lane (`opIsLive` in the dry-run
//      preview + the Class A `promoteSourceAssets` NOT EXISTS — a live owning
//      op keeps a `reserved` source_asset out of the destructive lane)
// 5 が最も重い: 判定が false へ倒れると R2 object + 行の削除に繋がる。S-4 の
// lease-only 化で「lease を持たない非終端 op」が守らなくなった影響はそこにも及ぶ
// (該当 script 側にも同趣旨の注記を置いた)。
//
// Return type: drizzle's `and()`/`or()` are typed `SQL | undefined` in
// general (they can receive filtered-out/undefined branches elsewhere in the
// codebase), but here both arguments are always concrete `SQLWrapper`s, so
// `and(...)` is guaranteed non-undefined at runtime — the `!` below is safe
// and centralizes the assertion in this one place (rather than at every call
// site, notably `not(isLiveUploadOperationCondition())` in
// gc-abandoned-operations.ts, which requires a non-optional `SQLWrapper`).
//
// fix round 3(T14a・Codex + canonical Critical, both against real PG17): the
// lease branch MUST be NULL-free. SQL is three-valued — `lease_expires_at >
// now()` evaluates to NULL (not false) when `lease_expires_at IS NULL`, which
// is the **dominant** abandoned state (prepare-upload never sets a lease;
// every retryable-failure path resets `leaseExpiresAt: null`). `not(NULL) =
// NULL`, and Postgres WHERE treats NULL as false → the row would be silently
// excluded from `scripts/gc-abandoned-operations.ts`'s sweep, i.e. the sweep
// would find NOTHING for exactly the dominant case it exists to clean.
// Guarding with `isNotNull` first (mirroring the `isNull`/`isNotNull` pattern
// already used in claim-operation.ts's CAS WHERE clauses) makes the branch a
// definite `false` when the lease is null, so the whole predicate is always a
// definite true/false. **This guard is load-bearing after the S-4
// simplification too** — the lease branch is now the ONLY branch.
export function isLiveUploadOperationCondition(): SQL {
  return and(
    // 'processing' = ②-4a 単一 invocation 経路の実行中状態(spec 2026-08-04 §4.5)。
    // 旧経路の 3 値と併存する(S-5 の旧経路撤去まで)。
    inArray(uploadOperations.status, [
      'awaiting_sources',
      'claimed',
      'prepared',
      'processing',
    ]),
    isNotNull(uploadOperations.leaseExpiresAt),
    sql`${uploadOperations.leaseExpiresAt} > now()`,
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
// fix round 1(Codex P1)/ S-4: この除外は **lease-aware**(無条件ではない)。
// 保護するのは「今このオペレーションを進めている invocation が生存している」
// (= valid lease を持つ)行だけ(isLiveUploadOperationCondition)。 lease が
// 失効 / NULL の非終端行はもはや source を保護しない — 保護し続けると、再開する
// 主体が居ない放置 op が対応する stale source_document を永久に processing で
// 固定してしまう(定常的なリーク)。 時刻比較は全て PostgreSQL now() 基準。
//
// ②-4a 単一 invocation S-4(spec 2026-08-04 §5「reconciler の拡張」): doc を
// failed 化したら **同一 tx で対応する非終端 op も terminal 化する**。 必要な理由:
//   ① 新経路には `after()` の callback が一度も走らない窓(登録直後の
//      hard-death / platform kill)があり、そのとき op を終端化する主体が誰も
//      居ない。 lease 失効後のこの reconciler が唯一の収束点になる(spec §4.4
//      (c)(d))。
//   ② 「doc failed / op 非終端」のねじれを残すと、live-op gate(submit-upload.ts)
//      や GC の候補判定が「まだ実行中」と読める行を見続ける。
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
                    // lease-aware(fix round 1・shared predicate as of fix
                    // round 2 / S-4 で lease 単独へ): 生きている間だけ保護する。
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

      // 2. 実際に更新された行が 0 件なら upload_records にも upload_operations にも
      //    触らない(空配列 INSERT / 無駄な UPDATE を避ける)
      if (updated.length === 0) return

      // 2.5. S-4: failed 化した doc に紐づく **非終端** op を同一 tx で terminal 化する。
      //    prepared_payload(PII/機微)と lease/next_retry の NULL 化は
      //    terminalizeAbandonedOperation(app 層・eslint Block A で lib から import
      //    不可)と同じ不変条件を満たす。
      //
      //    **文 2 自身で生存を再確認する**(fix round 3・Codex P1): 上の文 1 が
      //    NOT EXISTS(live op) を通過したことは、この文 2 の時点でも live op が居ない
      //    ことを意味しない。 PostgreSQL の READ COMMITTED では **同一 tx 内でも文ごとに
      //    スナップショットが進む**ため、文 1 の判定後・文 2 の実行前に別 tx が commit
      //    した再 lease を文 2 は見る。 文 1 が取るのは source_documents の行ロックで
      //    あって upload_operations の行ロックではなく、claimOperationTx は op 行しか
      //    ロックしない — つまり「競合相手が居ない」は**保証されていない**(以前この
      //    comment はそう書いていた)。 論証依存をやめて WHERE の条件にする。
      //
      //    **肯定形で書く理由(3VL 依存を持ち込まない)**: `not(isLiveUploadOperation
      //    Condition())` は **現時点では正しく動く** — 述語が `isNotNull(lease_expires_at)`
      //    を含み NULL-free だからで、NULL lease 行では `true AND false AND NULL = false`
      //    → `not(false) = true` で拾われる(実測で確認済: 否定形へ書き換えても iso は
      //    全 pass する)。 それでも否定形を採らないのは、**その正しさが「別関数の内部に
      //    `isNotNull` が在り続けること」という遠隔の不変条件に依存する**ため。 そこが
      //    将来緩むと、この site は**無言で「1 件も拾わない」に転ぶ**(まさに
      //    gc-abandoned-operations.ts が T14a fix round 3 で踏んだ形)。 肯定形はその依存を
      //    持たない。 危険なのは「今この式が NULL を返す」ことではなく「**この形の依存が
      //    将来壊れる**」こと。
      //    なお肯定形自身の罠は `isNull(...)` 枝の脱落で、こちらは iso の
      //    「lease が NULL の非終端 op も terminal 化する」が検出する。
      await tx
        .update(uploadOperations)
        .set({
          status: 'terminal_failed',
          preparedPayload: null,
          leaseExpiresAt: null,
          nextRetryAt: null,
          lastErrorCode: 'stale_reconciled',
          resultSummary: { reason: 'stale_reconciled' },
        })
        .where(
          and(
            eq(uploadOperations.userId, userId), // owner-scope 必須
            inArray(
              uploadOperations.sourceDocumentId,
              updated.map((row) => row.id),
            ),
            inArray(uploadOperations.status, [
              'awaiting_sources',
              'claimed',
              'prepared',
              'processing',
            ]),
            // 生存していない = lease が無い or 失効済(NULL は「生きていない」側)。
            or(
              isNull(uploadOperations.leaseExpiresAt),
              sql`${uploadOperations.leaseExpiresAt} <= now()`,
            ),
          ),
        )

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
