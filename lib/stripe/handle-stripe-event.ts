import 'server-only'
import type Stripe from 'stripe'
import { eq, sql } from 'drizzle-orm'
import { stripe } from '@/lib/stripe/client'
import { getDb, type DB } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { users } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import {
  applyDeleted,
  evaluateRelease,
  clearReservation as aggregateClearReservation,
} from '@/lib/stripe/domain/subscription-aggregate'
import { extractPriceId } from '@/lib/stripe/domain/subscription-values'
import {
  applyDeletedReset,
  clearReservation,
  clearReservationMatching,
  type SubKey,
  type SaveResult,
} from '@/lib/stripe/subscription-repository'
import { projectStripeSubscription } from '@/lib/stripe/project-subscription'
import { notifyOps } from '@/lib/ops'
import { recordIntegrationFailure } from '@/lib/integration-failures'
import { syncClerkPublicMetadata } from '@/lib/auth/clerk-metadata'
import { releaseCompletedDowngrade } from '@/lib/stripe/subscription'
import { runtimeEnv } from '@/lib/env/runtime-env'

// RLS-P2 (Task 7): 署名 event 由来の識別子から内部 user id を解決する。SECURITY
// DEFINER 関数 (RLS 迂回) ゆえ context 不要・退会済み行も deleted_at 付きで返す。
// load() は users を RLS 下で読むため resolve には使えない (context 未設定で循環)。
// 返り値: 行あり = { id, deletedAt } / 行なし (unlinked) = null。deletedAt は
// timestamptz ゆえ postgres-js が Date にパースする (呼出側は truthiness のみ判定)。
type ResolvedStripeUser = { id: string; deletedAt: string | Date | null }

async function resolveStripeUser(
  db: DB,
  by: SubKey['by'],
  value: string,
): Promise<ResolvedStripeUser | null> {
  const rows = await db.execute<{ id: string; deleted_at: string | Date | null }>(
    sql`SELECT id, deleted_at FROM public.app_resolve_user_for_stripe(${by}, ${value})`,
  )
  const row = rows[0]
  return row ? { id: row.id, deletedAt: row.deleted_at } : null
}

// 退会済み user (resolve が deleted_at 非 null) 宛の event を log + skip する共通判定。
// PII/id は載せない (spec §3.3 監視形)。true = skip 済み (呼出側は return する)。
function skipIfDeleted(resolved: ResolvedStripeUser | null, eventType: string): boolean {
  if (resolved?.deletedAt) {
    logger.warn({ event: 'stripe.event.skipped_deleted_user', type: eventType })
    return true
  }
  return false
}

// 失敗時 notify の context 拡充用。event.data.object.customer を best-effort で
// 取り出す (event 種別によっては customer 不在、その場合 undefined → notify payload
// から省略される)。throw しない (notify path は handler を巻き込んではならない)。
export function extractCustomerId(event: Stripe.Event): string | undefined {
  const obj = (event.data as { object?: unknown } | null | undefined)?.object
  if (!obj || typeof obj !== 'object') return undefined
  const customer = (obj as { customer?: unknown }).customer
  if (typeof customer === 'string') return customer
  if (customer && typeof customer === 'object' && 'id' in customer) {
    const id = (customer as { id?: unknown }).id
    return typeof id === 'string' ? id : undefined
  }
  return undefined
}

export async function handleEvent(event: Stripe.Event): Promise<void> {
  const db = getDb()
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session
      const clerkId = s.client_reference_id
      const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id
      if (!clerkId || !customerId) return

      // RLS-P2 (Task 7): clerkId で内部 id を解決 → 退会済みは log + skip
      // (外部 I/O = Stripe retrieve も走らせない)。clerkId は first-checkout の
      // 正キー (初回加入は stripe_customer_id 未紐付けのため)。
      const resolved = await resolveStripeUser(db, 'clerkId', clerkId)
      // 削除済み user は scrub で clerk_id=NULL 化されるため clerkId では引けない
      // (stripe_customer_id は scrub 後も保持)。clerkId miss 時のみ customerId で
      // 退会判定する (log+skip の一貫性・spec §2.5)。他 path は元々 customerId 解決
      // なので deleted を捕捉済み、checkout だけ取りこぼしていた。この customerId
      // 解決は退会判定専用で downstream write には使わない: normal flow (clerkId hit)
      // は不変、非退会 fallback hit という起きえない odd state は resolved=null のまま
      // 既存 unlinked 経路へ流す (customerId で write すると normal-flow 挙動が変わる)。
      const deletedCheck = resolved ?? (await resolveStripeUser(db, 'stripeCustomerId', customerId))
      if (skipIfDeleted(deletedCheck, event.type)) return

      // Step 1: link customer to user (既存挙動)。context を張り tx 内で UPDATE。
      // unlinked (resolved=null) は紐付く行がないため skip = 従来の 0 行 match と等価。
      if (resolved) {
        await withTenantTx(db, resolved.id, (tx) =>
          tx
            .update(users)
            .set({ stripeCustomerId: customerId })
            .where(eq(users.clerkId, clerkId)),
        )
      }

      // Step 2 (Fix 3, Sprint 6.2 I-2 race defense): Stripe の webhook delivery は
      // 順序保証されないため、subscription.created が先に到達していると
      // stripe_customer_id 未設定で update が 0 行 match し、ユーザーが
      // 課金完了しても Free のまま取り残される。checkout.session.completed
      // 時点で session.subscription から直接 sub を fetch して plan/status を
      // 同期しておく。subscription.created/updated 側は冪等なので後着しても
      // 問題なし (後勝ち同じ値で上書き)。
      const subRef = s.subscription
      if (subRef) {
        const subId = typeof subRef === 'string' ? subRef : subRef.id
        // retrieve() が throw した場合 (Stripe 5xx / timeout)、 outer try に
        // 流れて notifyWebhookError + 200 で完結する。 customerId link は
        // Step 1 で既に成功しているので、 plan/status の同期は次に届く
        // customer.subscription.created/.updated webhook で recover される
        // (両 path とも独立 idempotent、 race defense の degraded mode)。
        const sub = await stripe.subscriptions.retrieve(subId)
        // Step 2 の射影 (priceId 抽出 → derivation → anomaly 通知 → plan 6 列書込 →
        // RETURNING gate 付き Clerk sync) を use-case に集約。 retrieve は caller に
        // 残し、 取得した sub を use-case に渡す。 0 行 match (user.created 後着 race)
        // では use-case 内で Clerk sync を fire させない (clobber 整合崩壊防止)。
        // RLS-P2: context = resolved.id、unlinked は null (use-case が DB を触らず 0 行相当)。
        await projectStripeSubscription(
          db,
          resolved?.id ?? null,
          { by: 'clerkId', value: clerkId },
          sub,
          { eventId: event.id, customerId },
        )
      }
      return
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
      // RLS-P2 (Task 7): stripeCustomerId で内部 id を解決 → 退会済みは log + skip。
      const resolved = await resolveStripeUser(db, 'stripeCustomerId', customerId)
      if (skipIfDeleted(resolved, event.type)) return
      // 射影 use-case: derivation + anomaly 通知 + plan 6 列書込 + RETURNING gate 付き
      // Clerk sync を集約。 result で 0 行分岐 (unlinked notify) と §6.4 release gate を分岐。
      // context = resolved.id (unlinked は null で use-case が DB を触らず 0 行相当を返す)。
      const result = await projectStripeSubscription(
        db,
        resolved?.id ?? null,
        { by: 'stripeCustomerId', value: customerId },
        sub,
        { eventId: event.id, customerId },
      )
      // A-4: 行 match の有無 (result.matched) と clerkId の有無 (Clerk sync 要否) を分離。
      // scrub 行 (matched・clerkId null) は use-case 内で sync skip 済み。 gate は
      // 行 match していれば clerkId 無関係に評価する (DB 予約列照合であって clerkId 非依存)。
      // matched=true は resolved 非 null を含意する (projectStripeSubscription は userId
      // null のとき matched:false を返す) ため && resolved で narrowing する。
      if (result.matched && resolved) {
        if (event.type === 'customer.subscription.updated') {
          const priceId = extractPriceId(sub)
          await evaluateReleaseGate({
            userId: resolved.id,
            sub,
            customerId,
            priceId,
            dbScheduleId: result.scheduledDowngradeScheduleId ?? null,
            dbTargetPriceId: result.scheduledTargetPriceId ?? null,
            eventId: event.id,
          })
        }
      } else if (event.type === 'customer.subscription.updated') {
        // .created の unlinked race は checkout.session.completed が後追いで救済
        // するため alert 不要 (新規 sign-up の自然な ordering)。 .updated で
        // unlinked (行なし) は user operation 由来 (Portal 経由 plan 変更等) で
        // stripeCustomerId 紐付き欠落 = OT 介入対象の anomaly なので notifyOps する。
        await notifyOps('stripe sub event for unlinked customer', {
          eventId: event.id,
          customerId,
          eventType: event.type,
          environment: runtimeEnv(),
          timestamp: new Date().toISOString(),
        })
      }
      return
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
      // RLS-P2 (Task 7): stripeCustomerId で内部 id を解決 → 退会済みは log + skip。
      // scrub 済み行 (deleted_at 非 null) への silent write はここで遮断される
      // (旧: 下記 matched・clerkId null 分岐で silent skip していた自己誘発 webhook を
      // resolve 段で明示 skip 化。spec §2.5 / §7-2)。
      const resolved = await resolveStripeUser(db, 'stripeCustomerId', customerId)
      if (skipIfDeleted(resolved, event.type)) return
      // subscription 削除時: plan/status/billingInterval をリセット、cancelAt +
      // 予約 3 列を clear。 currentPeriodEnd は billing 履歴の記録として残す
      // (applyDeleted の DeletedReset に含めないことで touch しない)。
      // cancelAtPeriodEnd は schema 廃止済み (cancel_at != null で解約予約判定)。
      // context を張り tx 内で write。unlinked (resolved=null) は 0 行 match 相当。
      const result: Pick<SaveResult, 'matched' | 'clerkId'> = resolved
        ? await withTenantTx(db, resolved.id, (tx) =>
            applyDeletedReset(
              tx,
              { by: 'stripeCustomerId', value: customerId },
              applyDeleted(),
            ),
          )
        : { matched: false, clerkId: null }
      // clerkId 非 null を「UPDATE が行に match したか」の proxy にすると、 退会
      // (GDPR scrub: clerkId=NULL・stripeCustomerId は保持) が自己誘発する
      // 後着 .deleted webhook を「行なし = 整合崩壊」と誤判定してしまう
      // (根本原因、 docs/audit/2026-07-08-deletion-self-induced-webhook-alarm.md)。
      // 行 match の有無 (matched) と clerkId の有無 (metadata sync 要否) を分離する。
      if (!result.matched) {
        // 行なし = subscription を解約された user の row が本当に消えている
        // など整合崩壊 = OT 介入対象。 .created と違い recover の経路がない。
        await notifyOps('stripe sub event for unlinked customer', {
          eventId: event.id,
          customerId,
          eventType: event.type,
          environment: runtimeEnv(),
          timestamp: new Date().toISOString(),
        })
      } else if (result.clerkId) {
        await syncClerkPublicMetadata({ clerkId: result.clerkId, plan: 'free' })
      }
      // row があり clerkId が null (scrub 済み) は削除済み user への自己誘発
      // webhook として無害 skip: metadata sync も notifyOps も行わない。
      return
    }
    case 'invoice.payment_failed': {
      // DB の plan/status は変更しない: plan/status は customer.subscription.updated
      // が最終正。upgrade 即時課金失敗時は subscription が pending_update のまま旧
      // price を維持するので、DB 据え置きで Stripe 側 actual current price と整合する。
      const customerId = extractCustomerId(event)
      await notifyOps('stripe invoice.payment_failed', {
        eventId: event.id,
        customerId,
        environment: runtimeEnv(),
        timestamp: new Date().toISOString(),
      })
      return
    }
    case 'subscription_schedule.released': {
      // §6.4 / §6.4.1: schedule の release を最終正として 3 列を冪等 clear。
      // .updated gate の clear 失敗や、 能動 release 後の取りこぼしを回収する
      // recovery path。 0 行 match (既に clear 済) は正常な no-op。 WHERE は
      // scheduledDowngradeScheduleId = schedule.id (SubKey='scheduleId')。
      //
      // 配線注記 (i): released は scheduleId 単独 clear で足りるのに対し、 delegate
      // (下記 evaluateReleaseGate) は scheduleId + targetPriceId の 2 列 match
      // (clearReservationMatching) を課す。 理由: released は event payload の
      // schedule.id が Stripe 発の事実で単独で予約同一性が確定する。 delegate は
      // .updated が再送/race で発効前後が混ざりうるため、 target price も照合して
      // 「clear 対象は消費済のこの予約である」ことを行 match で確定させる。
      const schedule = event.data.object as Stripe.SubscriptionSchedule
      // RLS-P2 (Task 7): scheduleId で内部 id を解決 → 退会済みは log + skip。
      // unlinked (予約なし = 該当 scheduleId を持つ行なし) は clear を発行せず return
      // (従来の clearReservation 0 行冪等 no-op と等価)。
      const resolved = await resolveStripeUser(db, 'scheduleId', schedule.id)
      if (skipIfDeleted(resolved, event.type)) return
      if (resolved) {
        await withTenantTx(db, resolved.id, (tx) =>
          clearReservation(
            tx,
            { by: 'scheduleId', value: schedule.id },
            aggregateClearReservation(),
          ),
        )
      }
      return
    }
    default:
      // Unknown event — no-op. Caller still returns 200.
      return
  }
}

// §6.4 release gate。 customer.subscription.updated で plan 同期後、 予約
// (scheduledDowngradeScheduleId) が存在するときのみ呼ばれる。
// #1 (sub.schedule === DB scheduleId) かつ #5 (現 item price === target price)
// を充足したとき delegate に落とす。 R (Task 2): delegate では clear を先行させ
// (release 成否から decouple)、 その後 best-effort で releaseCompletedDowngrade へ
// 委譲する (順序反転)。 status/#2/#3/#4 の判定は releaseCompletedDowngrade (T10) が担う。
async function evaluateReleaseGate(args: {
  userId: string
  sub: Stripe.Subscription
  customerId: string
  priceId: string | null
  dbScheduleId: string | null
  dbTargetPriceId: string | null
  eventId: string
}): Promise<void> {
  const { userId, sub, customerId, priceId, dbScheduleId, dbTargetPriceId, eventId } = args
  // 予約なし → gate 全 skip (この早期 return は保存する)。
  if (!dbScheduleId) return

  // #1: sub.schedule は string id / 展開 object / null で来うる。
  const subScheduleId =
    typeof sub.schedule === 'string' ? sub.schedule : (sub.schedule?.id ?? null)

  // 判定は aggregate.evaluateRelease (pure) に集約、 副作用 (clear / notify / 委譲)
  // のみ本 helper が担う。 分岐順序・挙動は従来 verbatim:
  //   clear_direct = 方向2 保険 (sub.schedule==null + DB 予約残存 → 3 列冪等 clear)
  //   mismatch     = 別 non-null id (OT 介入 anomaly、 委譲も clear もしない)
  //   skip         = #5 未反映 (item price != target、 予約維持)
  //   delegate     = #1 && #5 充足 → clear 先行 + best-effort release (R: 順序反転)
  switch (evaluateRelease({ subScheduleId, dbScheduleId, priceId, dbTargetPriceId })) {
    case 'clear_direct':
      // RLS-P2: context を張り tx 内で clear (owner-scope WHERE は不変)。
      await withTenantTx(getDb(), userId, (tx) =>
        clearReservation(
          tx,
          { by: 'stripeCustomerId', value: customerId },
          aggregateClearReservation(),
        ),
      )
      return
    case 'mismatch':
      // errorMessage は none: anomaly 検知 (state_mismatch) で例外由来でなく、
      // subScheduleId は context 内に残す (subject / context は byte 不変)。
      await recordIntegrationFailure({
        key: 'stripe_gate_mismatch',
        stripeCustomerId: customerId,
        stripeSubscriptionId: sub.id,
        scheduleId: dbScheduleId,
        subject: 'stripe release gate schedule mismatch',
        context: {
          eventId,
          customerId,
          subScheduleId,
          dbScheduleId,
          environment: runtimeEnv(),
          timestamp: new Date().toISOString(),
        },
      })
      return
    case 'skip':
      return
    case 'delegate': {
      // 手順0: I-9 上ありえない破損 (schedule 有・target null)。 誤 clear せず予約を
      // 維持し観測のみ。 evaluateRelease が priceId==dbTargetPriceId で delegate に
      // 落とす都合上 dbTargetPriceId が null で到達しうるが、 clearReservationMatching
      // の target 照合に null を渡さない (型 narrowing + 防御)。
      if (dbTargetPriceId == null) {
        await notifyOps('stripe release gate: reservation missing target price', {
          eventId,
          customerId,
          scheduleId: dbScheduleId,
          environment: runtimeEnv(),
          timestamp: new Date().toISOString(),
        })
        return
      }
      // 手順1: clear 先行 (release 成否に無関係)。 delegate 到達 = 発効済 (price==
      // target 確認済) で予約は消費済ゆえ DB clear を確定させる。 matched は release を
      // gate しない (matched:false = 再送/race でも release へ進み status gate が吸収)。
      // clear throw は握らない — correctness 重大ゆえ outer catch に伝播させ
      // notifyWebhookError + 200 で処理する (release へは進まない)。
      // RLS-P2: context を張り tx 内で clear (owner-scope + schedule/target 照合は不変)。
      await withTenantTx(getDb(), userId, (tx) =>
        clearReservationMatching(
          tx,
          { by: 'stripeCustomerId', value: customerId },
          aggregateClearReservation(),
          { scheduleId: dbScheduleId, targetPriceId: dbTargetPriceId },
        ),
      )
      // 手順2: best-effort release (detach)。 throw は握って notifyOps のみ (clear は
      // 済で orphan は生じない)。 release は tx 外 (外部 I/O)。
      try {
        await releaseCompletedDowngrade(dbScheduleId, 'autorelease:' + dbScheduleId)
      } catch (err) {
        await recordIntegrationFailure({
          key: 'stripe_release',
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          scheduleId: dbScheduleId,
          errorMessage: err instanceof Error ? err.message : String(err),
          subject: 'stripe autorelease failed (reservation cleared)',
          context: {
            eventId,
            customerId,
            scheduleId: dbScheduleId,
            targetPriceId: dbTargetPriceId,
            error: err,
            environment: runtimeEnv(),
            timestamp: new Date().toISOString(),
          },
        })
      }
      return
    }
  }
}
