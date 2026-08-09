// Clerk webhook handler。設計: tech-spec §6 (アカウント削除フロー) / §5 (認証同期)。
//
// Architecture:
// 1. Svix 検証
// 2. clerk_events idempotency INSERT (svix-id PK、duplicate なら 200 即 return)
// 3. user.created → users INSERT ON CONFLICT DO NOTHING (既存挙動維持)
//    user.deleted → Stripe sub cancel + soft delete + 子データ物理削除 (retry 付)
// 4. outer catch で notifyOps explicit (Next.js onRequestError は uncaught 限定 fire)
// 5. 200 強制 return (Clerk リトライ抑止、recovery は integration_failures + 手動)

import { Webhook } from 'svix'
import { getNonTenantDb } from '@/lib/db'
import { clerkEvents } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { notifyWebhookError } from '@/lib/ops'
import { clerkWebhookEventSchema } from '@/lib/validation/clerk-webhook'
import { requireWebhookSecret } from '@/lib/env/webhook-secret-gate'
import { handleEvent } from '@/lib/clerk/handle-clerk-event'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  // ②-4b §2 (spec §3.2): 退会 prefix purge の予算原点。予算は守るべき境界と同じ
  // 原点から測る — 守る対象は本 route 全体の maxDuration: 60 なので handler 入口で
  // 取り、引数で handleEvent → handleUserDeleted へ伝播する (省略可にしない:
  // 渡し忘れが silent に誤った原点になるのを型で防ぐ)。
  const handlerStart = Date.now()

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

  // RLS-P3 (Task 1): event dedup — clerk_events は user_id を持たない構造的
  // non-tenant table (tenant context を張らず app-role で読み書きする)。
  const db = getNonTenantDb()

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
    await handleEvent(evt, handlerStart)
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
