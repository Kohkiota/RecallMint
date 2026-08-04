'use server'

import { z } from 'zod'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import { sourceAssets, uploadOperations, type User } from '@/lib/db/schema'
import { getTodayAiUsageGlobal } from '@/lib/ai-usage-counter'
import { logger } from '@/lib/logger'
import { parseDailyLimit } from '../_lib/daily-limit'
import {
  TOTAL_UPLOAD_LIMIT_BYTES,
  LEASE_TTL_MS,
  PREPARED_RETENTION_MS,
} from '../_lib/constants'
import { purgeOperationSourcesForOp } from '@/lib/media/source-purge'

// ②-4a Phase B Task 6(2026-07-31 T6 fencing checkpoint 裁定・OT 確定): claim +
// lease CAS(+ 日次 cap 判定・単一 tx)。spec §2(状態機械 + lease/fencing・冪等
// replay 契約)/ §2.1(claim の atomicity・lock order・source 検証・outcome 設計・
// DB 時計)/ §2.2(prepared takeover・T12b で実装 — 本 file の prepared 分岐)/
// §6.5(R2 staging bounded residual risk・明示受容)。
//
// T12b(2026-08-01): prepared takeover の CAS を追加(下記 prepared 分岐)。旧
// worker が prepared 保存後に死んだ場合、期限切れ lease を新 lease_version で
// 引き継ぐ。旧 worker は publishPreparedUploadTx(T12a)冒頭の fencing
// (status='prepared' AND lease_version=:mine 不一致)で拒否される — 本 file は
// T12a を変更しない・呼ばない(呼出元が takeover 後に
// publishPreparedUpload(operationId, newLeaseVersion)を呼ぶ)。
//
// T14a(2026-08-01・spec §11 deadline/retry/GC grace の非破壊半分): 7 日保持
// cap を追加(下記「7 日保持 cap」コメント)。 非終端(awaiting_sources/claimed/
// prepared)かつ誰も lease を保持していない行が created_at から
// PREPARED_RETENTION_MS を超えて経過していれば、claim/takeover せず fenced に
// terminal_failed + payload NULL へ確定する。 leaseValid な行(concurrently-
// advancing operation)は対象外 — clobber しない。
//
// 改訂(2026-07-31・OT 確定): input_fingerprint 列と fp 一致/不一致分岐は廃止済
// (spec §2)。本 file はそれを前提とし、fp 関連の分岐は一切持たない。
//
// ★ T6 fencing checkpoint(2026-07-31)で Critical 2 件 + 追加 4 件を指摘され全面
// 改訂(旧版からの主要変更):
//   1. [Critical] daily cap を分類より先に見ていたため completed/terminal_failed
//      の冪等 replay が cap 超過時にブロックされていた → 分類を daily cap より
//      前に固定(spec §2 冪等 replay 契約: 再送で cap を再適用しない)。
//   2. [Critical] server 実測サイズ再検査が source_assets を `status='ready'` で
//      フィルタしていたため、finalize 途中(reserved 混在)の集合に対し「ready な
//      ものだけの部分合計」で claim してしまいうる(古い/過小な合計で claim)
//      → 全 source_assets を `status` で絞らず `ORDER BY id FOR UPDATE` でロック
//      し、reserved が 1 件でもあれば `sources_not_ready`(一時的・claim しない)。
//   3. claim 全体を **1 transaction** に統合(旧版は cap 判定・サイズ再検査・CAS を
//      個別クエリとして緩く束ねていた)。`upload_operations` を冒頭で
//      `SELECT … FOR UPDATE` することで、同一行への並行 claim は「後着 tx が
//      ロック待ちでブロック → 先着 commit 後に最新版を読んで分類し直す」という
//      pessimistic locking で解決される(exactly-one-winner の一次的な保証源が
//      optimistic CAS の WHERE 句から SELECT FOR UPDATE の行ロックへ移った)。
//      末尾の CAS UPDATE の WHERE 句(claimable 条件)は**維持**(OT 確定: CAS
//      パターン自体は良い設計として継続採用)し、構造的な安全網(defense in
//      depth)として残す。
//   4. lease/next_retry の時刻比較・設定を app 側 `new Date()` から PostgreSQL
//      `now()` へ統一(Vercel 複数インスタンスの時計ずれで lease 裁定が不整合に
//      なるのを防ぐ。lease の裁定者は PostgreSQL — spec §2.1)。
//   5. `expected_source_count`(T4 が確定させた immutable manifest 列)を独立
//      oracle として使い、検査対象の source_assets の COUNT からは期待値を
//      導出しない(行欠落を検出できるようにするため)。
//   6. outcome を「一時的(sources_not_ready)」と「終端保存(terminal_failed)」に
//      明確分離: 一部 reserved は一時的(operation は現在の status のまま・再送で
//      回復)。全 ready だが合計超過 / 行欠落 / deleting 混在 / byte_size NULL は
//      **終端結果を保存**(同一 idempotency key 再送で同じ結果を返す・
//      awaiting_sources に残して毎回再検査させない)。

// 不正形式の id は定義上 DB に存在し得ない(asset-actions.ts の assetIdSchema と
// 同じ理由: 非 UUID 文字列を素通しすると Postgres cast error で 500 化する)。
const operationIdSchema = z.uuid()

export type ClaimOperationResult =
  | { outcome: 'claimed'; leaseVersion: number }
  | { outcome: 'daily_limit_exceeded'; current: number; limit: number }
  // 一時的: 一部 source_assets がまだ 'reserved'(finalize 未完了)。永続 status を
  // 変更しない(operation は現在の status のまま)— 再送で回復しうる(spec §2.1)。
  | { outcome: 'sources_not_ready' }
  | { outcome: 'already_processing' }
  | { outcome: 'completed'; resultSummary: Record<string, unknown> | null }
  | { outcome: 'already_prepared' }
  // prepared takeover(spec §2.2・T12b): 期限切れ lease の prepared を新
  // lease_version で引き継いだ。呼出元は publishPreparedUpload(operationId,
  // leaseVersion)を呼んで publish する(Gemini は再実行しない)。
  | { outcome: 'prepared_taken_over'; leaseVersion: number }
  // 終端: status='terminal_failed' を保存済み。合計サイズ超過 / source 集合の
  // データ不整合(件数不一致・deleting 混在・byte_size NULL)のいずれも、この形で
  // 同一 idempotency key の再送に対し常に同じ結果を返す(spec §2.1)。
  | {
      outcome: 'terminal_failed'
      lastErrorCode: string | null
      resultSummary: Record<string, unknown> | null
    }
  | { outcome: 'not_found' }
  | { outcome: 'unauthenticated' }

// 終端結果を保存する共通 helper。呼出時点で操作行は手順1の
// `SELECT … FOR UPDATE` によって同一 tx 内でロック保持中のため(他 tx はこの行を
// 書き換えられない)、この UPDATE に status ガード付き WHERE は不要 — id+userId の
// みで安全に一意行を更新できる。
async function persistTerminalFailure(
  tx: TenantTx,
  operationId: string,
  userId: string,
  lastErrorCode: string,
  resultSummary: Record<string, unknown>,
): Promise<ClaimOperationResult> {
  await tx
    .update(uploadOperations)
    // preparedPayload: null(spec §11「terminal_failed・payload NULL 化」)。 この
    // helper が呼ばれる分岐(source 不整合 / T14a 7 日保持 cap)のうち大半は
    // 'prepared' 未到達(payload はまだ null)だが、7 日保持 cap は 'prepared'
    // (payload 保持中)にも適用されるため、ここで一律 NULL 化して保証する。
    .set({ status: 'terminal_failed', preparedPayload: null, lastErrorCode, resultSummary })
    .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, userId)))
  return { outcome: 'terminal_failed', lastErrorCode, resultSummary }
}

// tx 本体。 user (Pick<User,'id'>) と tx を呼出側から受け取るだけで、Clerk 認証や
// withTenantTx を自前で張らない(prepareUploadTx と同型 — iso test が Clerk なしで
// 直接 exercise できるようにする設計)。
export async function claimOperationTx(
  tx: TenantTx,
  user: Pick<User, 'id'>,
  operationId: string,
): Promise<ClaimOperationResult> {
  if (!operationIdSchema.safeParse(operationId).success) {
    return { outcome: 'not_found' }
  }

  // 1. upload_operations を SELECT … FOR UPDATE(spec §2.1 手順1)。この行ロックが
  // commit まで保持されるため、同一 operation への並行 claim は「後着 tx がここで
  // ブロック → 先着 commit 後に最新のコミット済み行を読んで分類し直す」という
  // pessimistic locking で解決する(exactly-one-winner の一次的な保証源)。
  // dbNow は同一 tx 内の now()(transaction snapshot time、tx 内で不変)を
  // JS 側の分類比較にも使い回すための一度きりの取得 — lease の裁定者は
  // PostgreSQL であって app 時計ではない(spec §2.1)。
  const opRows = await tx
    .select({
      status: uploadOperations.status,
      leaseExpiresAt: uploadOperations.leaseExpiresAt,
      nextRetryAt: uploadOperations.nextRetryAt,
      resultSummary: uploadOperations.resultSummary,
      lastErrorCode: uploadOperations.lastErrorCode,
      sourceDocumentId: uploadOperations.sourceDocumentId,
      expectedSourceCount: uploadOperations.expectedSourceCount,
      // T14a 7 日保持 cap の測定対象(spec §11)。 insert 時のみ設定される不変列
      // (他のどの update も書き換えない・constants.ts PREPARED_RETENTION_MS 参照)。
      createdAt: uploadOperations.createdAt,
      // raw sql fragment には drizzle の列型マッパーが付かないため postgres-js は
      // timestamptz のテキスト表現(例 '2026-07-31 10:35:23.907297+00')をそのまま
      // 返す(型付き column なら自動で Date化される — drizzle 標準 column にだけ
      // 適用される mapFromDriverValue が raw sql には無いため)。JS Date へは
      // 明示変換する(下記)。
      dbNow: sql<string>`now()`,
    })
    .from(uploadOperations)
    .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, user.id)))
    .for('update')

  const op = opRows[0]
  if (!op) {
    return { outcome: 'not_found' }
  }
  const dbNow = new Date(op.dbNow)

  // 2. owner/status/lease/next_retry_at を分類(daily cap より前・spec §2.1 手順2 /
  // §2 冪等 replay 契約: completed / terminal_failed は cap を適用せず保存済み
  // 結果をそのまま返す — 再 Gemini call を要しないため)。
  if (op.status === 'completed') {
    return { outcome: 'completed', resultSummary: op.resultSummary ?? null }
  }
  if (op.status === 'terminal_failed') {
    return {
      outcome: 'terminal_failed',
      lastErrorCode: op.lastErrorCode,
      resultSummary: op.resultSummary ?? null,
    }
  }
  const leaseValid =
    op.leaseExpiresAt !== null && op.leaseExpiresAt.getTime() >= dbNow.getTime()

  // 2.5. 7 日保持 cap(spec §11・T14a)。 誰も lease を保持していない
  // (!leaseValid)非終端行(awaiting_sources/claimed/prepared のいずれか — この
  // 時点で completed/terminal_failed は既に return 済み)が、created_at から
  // PREPARED_RETENTION_MS を超えて経過していれば、この呼出でのその後の
  // claim/takeover を行わず fenced に terminal_failed へ確定する。leaseValid な
  // 行(現在進行中のワーカーが存在する = concurrently-advancing operation)は
  // 対象外にし、絶対に clobber しない。 手順1の SELECT…FOR UPDATE でこの行の
  // ロックを保持し続けているため、id+userId のみの WHERE(persistTerminalFailure)
  // で安全に一意行を更新できる。 時刻比較は PostgreSQL dbNow 基準(lease 裁定と
  // 同じ規律・spec §2.1)。
  if (!leaseValid) {
    const ageMs = dbNow.getTime() - op.createdAt.getTime()
    if (ageMs > PREPARED_RETENTION_MS) {
      return persistTerminalFailure(tx, operationId, user.id, 'retention_exceeded', {
        reason: 'retention_exceeded',
        ageMs,
        retentionMs: PREPARED_RETENTION_MS,
      })
    }
  }

  if (op.status === 'claimed' && leaseValid) {
    // lease がまだ有効 = 他の実行が処理中(二重 Gemini 抑止)。
    return { outcome: 'already_processing' }
  }
  if (op.status === 'prepared') {
    // prepared takeover(spec §2.2・T12b)。ここに到達するのは lease が無効
    // (期限切れ/未設定)な prepared のみ — 有効 lease の prepared はこの if の
    // 前段では弾かれない(leaseValid 判定は status==='claimed' 限定)が、
    // 直後の CAS の WHERE 句(lease_expires_at IS NULL OR < now())が有効 lease を
    // 弾くため、結果的に「有効 lease の prepared は takeover しない」という
    // 制約は CAS 自身が担保する(旧実行の書込権を奪わない・spec §2 fencing 冒頭)。
    //
    // Gemini を再実行しない(既存 prepared payload を publish するだけ)ため
    // 日次 cap を適用しない — この分岐は手順3(daily cap 判定)より前で return
    // するので、cap 判定に到達すること自体がない。
    //
    // 時刻比較/設定は PostgreSQL now() 基準(app new Date() は使わない・spec
    // §2.1 fencing 正しさ)。next_retry_at 未到達(T12a の
    // persistPublishRetryCas が記録した publish-retryable backoff)中は
    // takeover せず、まだ backoff 中として already_prepared を返す — 旧
    // worker がまだ owner の可能性がある lease-still-valid のケースと区別する
    // 必要はない(どちらも「取れなかった」で同じ扱い)。
    //
    // 手順1の SELECT…FOR UPDATE でこの行のロックは既に tx 開始から保持して
    // いるため(claim CAS と同じ設計)、この CAS の WHERE 句は defense in
    // depth — 単独の並行 takeover 呼出はここで必ず成功する。複数の同時
    // takeover 呼出は「後着 tx がロック待ちでブロック → 先着 commit 後に
    // 再分類」で exactly-one-winner になる(先着が lease_version を bump 済み
    // = 後着が読む lease_expires_at は新しい未来値 → CAS 不成立
    // → already_prepared)。
    const takenOver = await tx
      .update(uploadOperations)
      .set({
        leaseVersion: sql`${uploadOperations.leaseVersion} + 1`,
        leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_TTL_MS / 1000})`,
        lastErrorCode: null,
        nextRetryAt: null,
      })
      .where(
        and(
          eq(uploadOperations.id, operationId),
          eq(uploadOperations.userId, user.id),
          eq(uploadOperations.status, 'prepared'),
          or(
            isNull(uploadOperations.leaseExpiresAt),
            sql`${uploadOperations.leaseExpiresAt} < now()`,
          ),
          or(
            isNull(uploadOperations.nextRetryAt),
            sql`${uploadOperations.nextRetryAt} <= now()`,
          ),
        ),
      )
      .returning({ leaseVersion: uploadOperations.leaseVersion })

    if (takenOver.length > 0) {
      return { outcome: 'prepared_taken_over', leaseVersion: takenOver[0].leaseVersion }
    }
    // 0 行 = lease がまだ有効、または backoff 未到達、または別 worker が
    // 先に takeover 済み — いずれも「この呼出では取れなかった」として同じ
    // already_prepared に丸める(区別の必要なし・spec §2.2)。
    return { outcome: 'already_prepared' }
  }

  const nextRetryDue = op.nextRetryAt === null || op.nextRetryAt.getTime() <= dbNow.getTime()
  // ここに到達した時点で op.status は 'awaiting_sources' か 'claimed'(かつ上の
  // if で leaseValid=false は確定済み)のいずれか。claim 候補 = awaiting_sources、
  // または claimed かつ lease 期限切れ かつ next_retry_at 到達済み(retryable
  // failure の backoff 待ちでない)。
  const isClaimCandidate = op.status === 'awaiting_sources' || nextRetryDue
  if (!isClaimCandidate) {
    // status='claimed' だが lease 期限切れ かつ next_retry_at 未到来(backoff 待
    // ち)。claim 不可・not-claimable。
    return { outcome: 'not_found' }
  }

  // 3. 日次 Gemini cap 判定 — 実際に Gemini を再実行する claim 候補のみ(spec §2.1
  // 手順3)。上限到達なら claim を試みず(= 以降の UPDATE を発行せず)operation の
  // 現在状態には一切触れない。原子的枠確保は非実装(spec §6.5・実ユーザー 0 で
  // 超過は 1〜2 回許容・増加後再判断)。guard off(limit=null)は
  // upload-guard.ts の runUploadGuardTx と同じ扱い(logger.warn で可視化して素通し)。
  const dailyLimit = parseDailyLimit(process.env.GEMINI_DAILY_LIMIT)
  if (dailyLimit === null) {
    logger.warn({
      event: 'gemini.daily_limit.disabled',
      raw: process.env.GEMINI_DAILY_LIMIT ?? null,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    })
  } else {
    const todayCount = await getTodayAiUsageGlobal(tx)
    if (todayCount >= dailyLimit) {
      return {
        outcome: 'daily_limit_exceeded',
        current: todayCount,
        limit: dailyLimit,
      }
    }
  }

  // 4. この operation に属する全 source_assets を ORDER BY id FOR UPDATE(spec
  // §2.1 手順4・lock order = operation→source_document→source_assets(ID順)→
  // derived(ID順)の一部分列)。status='ready' で絞らない — reserved 行もロック
  // し、欠落(count mismatch)も見えるようにするため。
  if (op.sourceDocumentId === null) {
    // T4 が作る operation は常に source_document_id を確定済み(prepare-upload.ts
    // 手順6-8)。schema 上 nullable なのは将来の別経路のための予約であり、この
    // 経路への到達は想定していない — 防御的にデータ不整合として terminal 化する。
    return persistTerminalFailure(tx, operationId, user.id, 'source_document_missing', {
      reason: 'source_document_missing',
    })
  }
  const assetRows = await tx
    .select({ status: sourceAssets.status, byteSize: sourceAssets.byteSize })
    .from(sourceAssets)
    .where(
      and(
        eq(sourceAssets.sourceDocumentId, op.sourceDocumentId),
        eq(sourceAssets.userId, user.id),
      ),
    )
    .orderBy(sourceAssets.id)
    .for('update')

  // 5. source 集合を検証(全て要求・spec §2.1 手順5)。
  //
  // (a) T4 の immutable expected_source_count と実際の行数が一致するか
  // (検査対象の source_assets の COUNT から期待値を作らない=行欠落を検出する
  // ため)。一致しなければ回復不能なデータ不整合として終端保存。
  if (assetRows.length !== op.expectedSourceCount) {
    return persistTerminalFailure(tx, operationId, user.id, 'source_count_mismatch', {
      reason: 'source_count_mismatch',
      expected: op.expectedSourceCount,
      actual: assetRows.length,
    })
  }
  // (b) deleting・未知状態(='ready'/'reserved' 以外)混在は sources_not_ready と
  // 混同せずデータ不整合として終端保存。
  const hasDeletingOrUnknown = assetRows.some(
    (r) => r.status !== 'ready' && r.status !== 'reserved',
  )
  if (hasDeletingOrUnknown) {
    return persistTerminalFailure(tx, operationId, user.id, 'source_deleting', {
      reason: 'source_deleting',
    })
  }
  // (c) 一部 reserved(finalize 途中)は一時的outcome — 永続status変更なし(spec
  // §2.1: sources_not_ready は永続 status に追加しない・現在の status のまま・
  // 再送で回復しうる)。
  const hasReserved = assetRows.some((r) => r.status === 'reserved')
  if (hasReserved) {
    return { outcome: 'sources_not_ready' }
  }
  // (d) 全行 ready。byte_size IS NOT NULL を要求(通常 finalize が ready 化と
  // 同時に確定させるため NULL は想定外 — 防御的にデータ不整合として終端保存)。
  const missingByteSize = assetRows.some((r) => r.byteSize === null)
  if (missingByteSize) {
    return persistTerminalFailure(tx, operationId, user.id, 'source_byte_size_missing', {
      reason: 'source_byte_size_missing',
    })
  }
  // (e) server 実測 byte_size 合計 ≤ TOTAL_UPLOAD_LIMIT_BYTES。超過は同一
  // operation では回復不能ゆえ終端保存(同一 idempotency key 再送は同じ結果を
  // 返す — awaiting_sources に残して毎回再検査させない)。
  const totalBytes = assetRows.reduce((sum, r) => sum + (r.byteSize ?? 0), 0)
  if (totalBytes > TOTAL_UPLOAD_LIMIT_BYTES) {
    return persistTerminalFailure(tx, operationId, user.id, 'size_exceeded', {
      reason: 'size_exceeded',
      current: totalBytes,
      limit: TOTAL_UPLOAD_LIMIT_BYTES,
    })
  }

  // 6. claim CAS(spec §2.1 手順6)。lease_expires_at の設定・WHERE の lease/
  // next_retry_at 比較はいずれも PostgreSQL の now() 基準(app new Date() は
  // 使わない — fencing 正しさ、spec §2.1)。
  //
  // WHERE の claimable 条件は上の分類(手順2)と同値だが、既に手順1の
  // SELECT…FOR UPDATE でこの行のロックを保持し続けているため、このレースは
  // 分類の時点で実質的に解決済み(他 tx はここまでの間この行を書き換えられない)。
  // それでも CAS 自体(条件付き UPDATE + RETURNING で 0 行なら claim できな
  // かったと判定する設計)は OT 確定で維持する構造的な安全網(defense in
  // depth)— 万一ロックの想定が崩れても不正な claim を防ぐ。
  const claimed = await tx
    .update(uploadOperations)
    .set({
      status: 'claimed',
      leaseVersion: sql`${uploadOperations.leaseVersion} + 1`,
      leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_TTL_MS / 1000})`,
      attemptCount: sql`${uploadOperations.attemptCount} + 1`,
    })
    .where(
      and(
        eq(uploadOperations.id, operationId),
        eq(uploadOperations.userId, user.id),
        or(
          eq(uploadOperations.status, 'awaiting_sources'),
          and(
            eq(uploadOperations.status, 'claimed'),
            or(
              isNull(uploadOperations.leaseExpiresAt),
              sql`${uploadOperations.leaseExpiresAt} < now()`,
            ),
            or(
              isNull(uploadOperations.nextRetryAt),
              sql`${uploadOperations.nextRetryAt} <= now()`,
            ),
          ),
        ),
      ),
    )
    .returning({ leaseVersion: uploadOperations.leaseVersion })

  if (claimed.length > 0) {
    return { outcome: 'claimed', leaseVersion: claimed[0].leaseVersion }
  }

  // 0 行は理論上到達しない(手順1の SELECT…FOR UPDATE でこの行のロックを tx の
  // 間ずっと保持しているため、他 tx がこの行の status/lease を書き換えることは
  // できない)。防御的 fallback として not_found を返す(claim できなかったと
  // 保守的に扱う — 誤って claimed を返すよりも安全)。
  return { outcome: 'not_found' }
}

// getCurrentUser() は「未認証」(Clerk session 無し)を UnauthenticatedError の
// throw で表現し、「session はあるが DB に user 行がまだ無い」(webhook sync race)
// を null 返却で表現する(asset-actions.ts / prepare-upload.ts と同型の helper)。
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

// Server Action entry point。 Clerk 認証 + tenant tx を張って claimOperationTx を
// 呼ぶだけの薄い wrapper(prepareUpload と同型)。
//
// ②-4a Task 14b′(主経路・post-commit): claimOperationTx の 6 terminal_failed
// 分岐(retention_exceeded/source_document_missing/source_count_mismatch/
// source_deleting/source_byte_size_missing/size_exceeded)は同一 ambient tx 内で
// 直接 UPDATE する(fenced tx 自体は変更しない・行ロック保持中ゆえ CAS 不要)ため、
// purge は tx 外(ここ)でしか呼べない。claimOperationTx は fresh 遷移と冪等
// replay(既に completed/terminal_failed だった行を観測しただけ)を型で区別しない
// ため、ここでは outcome が 'completed'/'terminal_failed' なら常に
// purgeOperationSourcesForOp を呼ぶ(冪等・source-purge.ts のコメント参照 —
// 主経路の取りこぼしに対する defense-in-depth にもなる)。
export async function claimOperation(operationId: string): Promise<ClaimOperationResult> {
  const user = await currentUserOrNull()
  if (!user) return { outcome: 'unauthenticated' }

  const result = await withTenantTx(user.id, (tx) => claimOperationTx(tx, user, operationId))
  if (result.outcome === 'completed' || result.outcome === 'terminal_failed') {
    await purgeOperationSourcesForOp(user.id, operationId, 'claim_terminal')
  }
  return result
}
