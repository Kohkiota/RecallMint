// Clerk webhook handler。設計: tech-spec §6 (アカウント削除フロー) / §5 (認証同期)。
//
// Architecture:
// 1. Svix 検証
// 2. clerk_events idempotency INSERT (svix-id PK、duplicate なら 200 即 return)
// 3. user.created → users INSERT ON CONFLICT DO NOTHING (既存挙動維持)
//    user.deleted → Stripe sub cancel + soft delete + 子データ物理削除 (retry 付)
// 4. outer catch で notifyOps explicit (Next.js onRequestError は uncaught 限定 fire)
// 5. 200 強制 return (Clerk リトライ抑止、recovery は deletion_failures + 手動)

import { Webhook } from 'svix'
import { eq, sql } from 'drizzle-orm'
import Stripe from 'stripe'
import { getDb } from '@/lib/db'
import {
  users,
  clerkEvents,
  deletionFailures,
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
import { logger } from '@/lib/logger'
import { stripe, cancelWithRetry } from '@/lib/stripe'
import { notifyOps, notifyWebhookError } from '@/lib/ops'
import { syncClerkPublicMetadata } from '@/lib/auth/clerk-metadata'
import {
  clerkWebhookEventSchema,
  type ClerkWebhookEvent,
} from '@/lib/validation/clerk-webhook'
import { requireWebhookSecret } from '@/lib/env/webhook-secret-gate'

export const runtime = 'nodejs'

// cancel 対象 status。canceled / incomplete* / unpaid / paused は skip。
const CANCEL_TARGETS = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
])

export async function POST(req: Request) {
  // T-A8 (audit §10.3 (b) #17): 3-tier env-aware gate に統一。
  // production = env 必須 (helper throw → Next.js 500、 既存 wire format と一致)、
  // preview = logger.warn + '' fallback (既存 svix verify が空文字で fail → 400)、
  // local / dev = silent '' (既存 svix verify が空文字で fail → 400)。
  const secret = requireWebhookSecret('CLERK_WEBHOOK_SECRET', 'Clerk webhook')

  const svixId = req.headers.get('svix-id')
  const svixTs = req.headers.get('svix-timestamp')
  const svixSig = req.headers.get('svix-signature')
  if (!svixId || !svixTs || !svixSig) {
    return new Response('missing svix headers', { status: 400 })
  }

  const payload = await req.text()

  let verified: unknown
  try {
    const wh = new Webhook(secret)
    verified = wh.verify(payload, {
      'svix-id': svixId,
      'svix-timestamp': svixTs,
      'svix-signature': svixSig,
    })
  } catch {
    return new Response('invalid signature', { status: 400 })
  }

  // audit §10.3 (b) #10: payload を zod schema で safeParse して narrowed type を得る。
  // 未対応 type (e.g. session.created) / 必須 field 欠落 / Clerk 側 schema drift は
  // ここで弾き、 200 + logger.warn で吸収 (Clerk 再送ループ回避、 既存 wire format 不変)。
  const parsed = clerkWebhookEventSchema.safeParse(verified)
  if (!parsed.success) {
    logger.warn({
      event: 'webhook.clerk.unknown_event_type',
      svixId,
      // verified.type を best-effort で抽出 (string なら log、 不明なら undefined)。
      type:
        typeof verified === 'object' && verified !== null && 'type' in verified
          ? (verified as { type?: unknown }).type
          : undefined,
      issues: parsed.error.issues,
    })
    return new Response('ok', { status: 200 })
  }
  const evt = parsed.data

  const db = getDb()

  // clerk_events idempotency. svix-id を PK として INSERT、
  // duplicate なら 200 即 return (Clerk が同一 message を再配信した場合の skip)。
  const inserted = await db
    .insert(clerkEvents)
    .values({ eventId: svixId, type: evt.type })
    .onConflictDoNothing({ target: clerkEvents.eventId })
    .returning({ id: clerkEvents.eventId })
  if (inserted.length === 0) {
    return new Response('duplicate', { status: 200 })
  }

  // user.deleted / user.created は evt.data.id を持つ (schema で narrow 済)。
  // outer catch で userId を通知に含めて切り分け (Vercel logs / Neon SELECT) を簡素化。
  const userId = evt.data.id

  try {
    await handleEvent(evt)
    return new Response('ok', { status: 200 })
  } catch (err) {
    // outer catch で notifyWebhookError 経由 (Stripe 側
    // と payload shape 統一、env/timestamp 自動付与)。
    await notifyWebhookError({
      handler: 'clerk',
      eventId: svixId,
      eventType: evt.type,
      err,
      userId,
    })
    return new Response('handler error swallowed', { status: 200 })
  }
}

async function handleEvent(evt: ClerkWebhookEvent): Promise<void> {
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
  // 遅れて到達した順序逆転 edge case) は deletion_failures.user_id uuid NOT NULL に
  // 書けず audit 不可。silent skip させず notifyOps で観測性を確保し、OT が Clerk
  // webhook 配送順序の異常を検知できるようにする。
  if (!internalUserId) {
    await notifyOps('user.deleted received but users row not synced', {
      clerkUserId,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
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
  // 削除設計の集約コメント (なぜここに 8 テーブルを明示 DELETE するか):
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

/**
 * §6: deletion_failures 書き込み + notifyOps の合成。
 * DB 書き込み (audit、真実) → notifyOps (人通知、best-effort) の順。
 * notifyOps 自身が throw しない設計なので順序による副作用なし。
 *
 * F-5: deletion_failures が Option A (uuid user_id + clerk_id text) に切替済。
 *   internalUserId (users.id 内部 UUID、grouping/template 一貫性) と
 *   clerkUserId (Clerk Dashboard で grep 用) を別 column に書く。
 *
 * kind='data_deletion': DB transaction 失敗 (subId=null)。subject は別文言。
 * kind∈{list,cancel,customer_missing}: Stripe cancel 失敗。subject は既存文言 (byte 不変)。
 */
async function recordFailure(args: {
  internalUserId: string
  clerkUserId: string
  subId: string | null
  kind: 'list' | 'cancel' | 'customer_missing' | 'data_deletion'
  errorMessage: string
}): Promise<void> {
  const db = getDb()
  await db.insert(deletionFailures).values({
    userId: args.internalUserId,
    clerkId: args.clerkUserId,
    subId: args.subId,
    failureKind: args.kind,
    errorMessage: args.errorMessage,
  })
  // Phase 1 E-3 spec: recordFailure は subject が webhook error と異なる (削除フロー
  // 専用の per-sub cancel 失敗) ため notifyWebhookError には乗せない。代わりに
  // environment + timestamp を inline 注入し、payload baseline を揃える。
  const subject =
    args.kind === 'data_deletion'
      ? 'user data deletion failure'
      : 'stripe sub cancel failure during deletion'
  await notifyOps(subject, {
    userId: args.internalUserId,
    clerkId: args.clerkUserId,
    subId: args.subId,
    kind: args.kind,
    error: args.errorMessage,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    timestamp: new Date().toISOString(),
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
