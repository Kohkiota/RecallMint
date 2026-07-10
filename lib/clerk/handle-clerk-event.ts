import 'server-only'
import { eq, sql } from 'drizzle-orm'
import Stripe from 'stripe'
import { getDb } from '@/lib/db'
import {
  users,
  exams,
  studyDays,
  contactMessages,
  aiUsageUsers,
  uploadRecords,
  userSettings,
  studySessions,
  tombstones,
  entityMutations,
  tagCategories,
} from '@/lib/db/schema'
import { stripe, cancelWithRetry } from '@/lib/stripe/client'
import { notifyOps } from '@/lib/ops'
import {
  recordIntegrationFailure,
  type IntegrationFailureKey,
} from '@/lib/integration-failures'
import { syncClerkPublicMetadata } from '@/lib/auth/clerk-metadata'
import { runtimeEnv } from '@/lib/env/runtime-env'
import { type ClerkWebhookEvent } from '@/lib/validation/clerk-webhook'

// cancel 対象 status。canceled / incomplete* / unpaid / paused は skip。
const CANCEL_TARGETS = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
])

export async function handleEvent(evt: ClerkWebhookEvent): Promise<void> {
  const db = getDb()
  if (evt.type === 'user.created') {
    const data = evt.data
    const email = data.email_addresses?.[0]?.email_address ?? 'unknown@example.com'
    // .returning({id}) で INSERT 成立 (新規) と conflict (既存) を区別する。
    // 新規時のみ Clerk publicMetadata を初期 sync (dbUserId + plan='free')。
    // conflict 時 (= webhook re-fire 等で既に users 行が存在) は metadata sync を
    // skip — 既存 metadata の plan 値を 'free' に上書きする race を防ぐ。
    // 復旧経路: conflict path で metadata が欠落した user は (a) 次の user 由来
    // webhook (Stripe subscription 系) で publicMetadata.plan が補填される、
    // (b) consumer 側の getAuthContext() が dbUserId 未設定時に getCurrentUser()
    // へ fallback する設計、 の 2 段で degraded mode を吸収する。 一斉復旧は
    // 別途 backfill (後続 sprint の chore commit) で実施予定。
    const inserted = await db
      .insert(users)
      .values({ clerkId: data.id, email })
      .onConflictDoNothing({ target: users.clerkId })
      .returning({ id: users.id })
    const dbUserId = inserted?.[0]?.id
    if (dbUserId) {
      await syncClerkPublicMetadata({
        clerkId: data.id,
        dbUserId,
        plan: 'free',
      })
    }
    return
  }
  if (evt.type === 'user.deleted') {
    await handleUserDeleted(evt.data.id)
    return
  }
  // 上の if 群で全 discriminated variant を扱い切る。 schema 拡張時はここに到達せず
  // narrow が cover する (型 exhaustive)。
}

async function handleUserDeleted(clerkUserId: string): Promise<void> {
  const db = getDb()

  // §6: SELECT users by clerkId to get internal id and Stripe customer.
  // Using SELECT-first (instead of UPDATE-RETURNING) so Stripe cancel can run
  // before the DB transaction, and unsynced users (SELECT 0 rows) are detected
  // without issuing an UPDATE that would have no effect.
  const rows = await db
    .select({ id: users.id, stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.clerkId, clerkUserId))
    .limit(1)
  const internalUserId = rows[0]?.id
  const customerId = rows[0]?.stripeCustomerId

  // F-5 fix-up (review M-1): users 未同期 (user.created webhook が user.deleted より
  // 遅れて到達した順序逆転 edge case) は internalUserId が引けず、削除処理も台帳記録も
  // 行えない。silent skip させず notifyOps で観測性を確保し、OT が Clerk webhook 配送
  // 順序の異常を検知できるようにする。
  if (!internalUserId) {
    await notifyOps('user.deleted received but users row not synced', {
      clerkUserId,
      environment: runtimeEnv(),
      timestamp: new Date().toISOString(),
    })
    return
  }

  // §6: customerId があれば Stripe sub cancel ループを実行する
  // (transaction 外。Stripe 失敗が記録されても DB transaction は forward-only で実行)。
  // customerId なし = Free プラン user → Stripe ループを skip して transaction へ進む。
  if (customerId) {
    // canceledIds と offset を function スコープで保持し、list 失敗時の
    // error_message に詰める (admin が Stripe Dashboard で残 sub を grep するため)
    const canceledIds: string[] = []
    let offset = 0
    try {
      for await (const sub of stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
      })) {
        offset++
        if (!CANCEL_TARGETS.has(sub.status)) continue
        try {
          await cancelWithRetry(sub.id)
          canceledIds.push(sub.id)
        } catch (err) {
          await recordFailure({
            internalUserId,
            clerkUserId,
            subId: sub.id,
            kind: 'cancel',
            errorMessage: String(err),
          })
        }
      }
    } catch (err) {
      const kind = isCustomerMissing(err) ? 'customer_missing' : 'list'
      const errorMessage =
        kind === 'list'
          ? `page fetch failed at offset ${offset}: ${String(err)}. Canceled before failure: [${canceledIds.join(', ')}]`
          : String(err)
      await recordFailure({
        internalUserId,
        clerkUserId,
        subId: null,
        kind,
        errorMessage,
      })
    }
  }

  // §6 / T3: DB transaction — users の soft delete + GDPR PII scrub + ユーザー
  // 紐付き子テーブルの物理削除。
  //
  // 削除設計の集約コメント (なぜここに 10 テーブルを明示 DELETE するか):
  // - users は soft delete (deleted_at set + email/clerk_id scrub) で物理削除しない
  //   ため、 users.id への FK ON DELETE CASCADE は発火しない。
  // - **Group I (handler 明示 DELETE 必須、 = 本ブロックの 10 件)**: direct user_id FK で
  //   users に cascade するテーブルのうち、 親 cascade chain がないもの。
  //     exams / study_days / contact_messages / ai_usage_users / upload_records /
  //     user_settings / study_sessions / tombstones / entity_mutations / tag_categories
  //   (study_sessions は exam_id が set null = 非経路、 user_id のみが削除 path)
  //   (entity_mutations は S-sync-1 で entity_id FK を撤廃したため、 旧 card_mutations の
  //    時にあった cards cascade chain がなくなり、 Group I に昇格)
  //   (tag_categories は Tag-1 で新設、 試験横断 master のため親 chain なし → Group I)
  // - **Group II (明示 DELETE しない、 親 cascade chain で連鎖)**: cards / source_documents
  //   は exam_id cascade で exams DELETE 時に連鎖、 reviews / answer_events は cards
  //   cascade (= exams chain) で連鎖、 tag_options は category_id cascade で tag_categories
  //   経由で連鎖、 card_tags は card_id / option_id の双方 cascade で連鎖。 ここに二重に書かない。
  // - 網羅性は invariant test (route.test.ts の「user_id direct cascade を持つ全テーブル
  //   が handler の明示 DELETE に含まれる」 検証) が保証。 schema に user_id direct FK
  //   の新テーブルを追加すると invariant test が落ちて気づける。
  //
  // GDPR PII scrub: users 行は audit / correlation のため残置するが、 PII 列
  // (email, clerk_id) を NULL に上書きする。 stripe_customer_id は cus_xxx 単体で
  // 個人特定不能なため correlation key として保持。 NULL 上書きは値レベルで冪等、
  // webhook 再送は上位の clerk_events.event_id dedup で 1 回に絞られる。
  //
  // T3: transient DB error (deadlock / serialization / connection 切断) に対し最大 3 retry。
  // permanent error (整合性違反等) は即中断。両者とも最終失敗時は recordFailure(data_deletion)。
  //
  // 削除順序: Group I は互いに FK 依存なし (全 table が direct user_id FK のみ) なので
  // 任意。 Group II は exams DELETE 時点で同 transaction 内 cascade chain により連鎖
  // 削除される (実行順序は PG が constraint check に従って決定、 ここでの記述順は
  // パフォーマンス heuristic のみ、 正当性に依存しない)。
  await runTransactionWithRetry(
    db,
    async (tx) => {
      await tx
        .update(users)
        .set({ deletedAt: sql`now()`, email: null, clerkId: null })
        .where(eq(users.id, internalUserId))
      await tx.delete(exams).where(eq(exams.userId, internalUserId))
      await tx.delete(studyDays).where(eq(studyDays.userId, internalUserId))
      await tx.delete(contactMessages).where(eq(contactMessages.userId, internalUserId))
      await tx.delete(aiUsageUsers).where(eq(aiUsageUsers.userId, internalUserId))
      await tx.delete(uploadRecords).where(eq(uploadRecords.userId, internalUserId))
      await tx.delete(userSettings).where(eq(userSettings.userId, internalUserId))
      await tx.delete(studySessions).where(eq(studySessions.userId, internalUserId))
      await tx.delete(tombstones).where(eq(tombstones.userId, internalUserId))
      await tx.delete(entityMutations).where(eq(entityMutations.userId, internalUserId))
      await tx.delete(tagCategories).where(eq(tagCategories.userId, internalUserId))
    },
    async (errorMessage) => {
      await recordFailure({
        internalUserId,
        clerkUserId,
        subId: null,
        kind: 'data_deletion',
        errorMessage,
      })
    },
  )
}

// Sprint 2 §6 site 4: 削除フローの失敗を integration_failures 台帳 (真実) に記録し
// つつ Discord へ通知する。旧 recordFailure (廃止した専用 audit table への直書き) を
// recordIntegrationFailure helper 呼び出しに置換した。
//
// 旧 kind → catalog key の写像 (§5): cancel→deletion_cancel / list→deletion_list /
// customer_missing→deletion_customer_missing / data_deletion→deletion_data。
// 4 軸値は catalog から引かれる (呼び出し側は 4 軸を自由文字列で渡さない)。
//
// Discord は byte 不変: subject 2 分岐 (data_deletion → 'user data deletion failure' /
// それ以外 → 'stripe sub cancel failure during deletion') と context (旧 kind 文字列を
// 含む) を verbatim で helper に渡す。context の kind は catalog key ではなく旧 kind 値
// を保持し、既存 Discord payload を一切変えない。
const KIND_TO_KEY: Record<
  'list' | 'cancel' | 'customer_missing' | 'data_deletion',
  IntegrationFailureKey
> = {
  cancel: 'deletion_cancel',
  list: 'deletion_list',
  customer_missing: 'deletion_customer_missing',
  data_deletion: 'deletion_data',
}

async function recordFailure(args: {
  internalUserId: string
  clerkUserId: string
  subId: string | null
  kind: 'list' | 'cancel' | 'customer_missing' | 'data_deletion'
  errorMessage: string
}): Promise<void> {
  // Phase 1 E-3 spec: subject が webhook error と異なる (削除フロー専用) ため
  // notifyWebhookError には乗せず、environment + timestamp を inline 注入して
  // payload baseline を揃える (byte 不変)。
  const subject =
    args.kind === 'data_deletion'
      ? 'user data deletion failure'
      : 'stripe sub cancel failure during deletion'
  await recordIntegrationFailure({
    key: KIND_TO_KEY[args.kind],
    userId: args.internalUserId,
    clerkId: args.clerkUserId,
    stripeSubscriptionId: args.subId ?? undefined,
    errorMessage: args.errorMessage,
    subject,
    context: {
      userId: args.internalUserId,
      clerkId: args.clerkUserId,
      subId: args.subId,
      kind: args.kind,
      error: args.errorMessage,
      environment: runtimeEnv(),
      timestamp: new Date().toISOString(),
    },
  })
}

// customer 削除済み判定。Stripe SDK の error code で narrow。
function isCustomerMissing(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeInvalidRequestError &&
    err.code === 'resource_missing'
  )
}

// §6 / T3: transient DB error 判定 (postgres-js / pg SQLSTATE ベース)。
// transient = 再試行で回復しうるエラー (deadlock / serialization / connection 切断など)。
// permanent = 整合性違反 (23xxx 等) は retry しても無意味なので即中断。
// lib/ai/ocr.ts の isTransientError と同じ「local 非 export 関数」思想で実装。
function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (!code) {
    // code を持たない error = connection 切断系とみなして transient 扱い。
    // pg driver が code を付けない場合があるため、code 不在 = transient が安全側。
    return true
  }
  return (
    code === '40001' || // serialization failure
    code === '40P01' || // deadlock detected
    code.startsWith('08') || // connection exception class
    code === '57P01' || // admin shutdown
    code === '57P02' || // crash shutdown
    code === '57P03'   // cannot connect now
  )
}

// §6 / T3: DB transaction を最大 3 retry (= 合計 4 試行) でラップする local 関数。
// transient error (isTransientDbError=true) のときのみ retry、permanent は即中断。
// backoff: retry1 前 500ms / retry2 前 1000ms / retry3 前 2000ms (ocr.ts callWithRetry と同値構造)。
// transaction は idempotent (UPDATE deleted_at + PII scrub (email/clerkId NULL → NULL = no-op) /
// DELETE WHERE は再実行安全) なので retry 安全。
// Stripe cancel ループと recordFailure 本体はこの wrap 対象外。
const MAX_DB_RETRIES = 3 // 初回 + 3 retries = 合計 4 試行

async function runTransactionWithRetry(
  db: ReturnType<typeof getDb>,
  fn: Parameters<ReturnType<typeof getDb>['transaction']>[0],
  onFailure: (errorMessage: string) => Promise<void>,
): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_DB_RETRIES; attempt++) {
    try {
      await db.transaction(fn)
      return // 成功
    } catch (err) {
      lastErr = err
      const isTransient = isTransientDbError(err)
      if (!isTransient || attempt === MAX_DB_RETRIES) {
        // permanent error または retry 上限到達 → failure を記録して終了
        const totalAttempts = attempt + 1
        const code = (err as { code?: string } | null)?.code
        const diagnosis = code
          ? `pg error code ${code}: ${String(err)}`
          : String(err)
        await onFailure(
          `data deletion failed after ${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'} (${attempt} ${attempt === 1 ? 'retry' : 'retries'}): ${diagnosis}`,
        )
        return
      }
      const backoffMs = 500 * Math.pow(2, attempt) // 500 / 1000 / 2000
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  // ここには到達しないが TypeScript の exhaustiveness 対応
  throw lastErr
}
