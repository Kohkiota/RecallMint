// 課金系・外部連携の失敗を DB 台帳 (integration_failures) に記録しつつ Discord へも
// 通知する dual-write helper。handle-clerk-event.ts の recordFailure (DB 書込 = 真実
// → notifyOps = 通知 の順) を一般化したもの。
//
// server 境界は @/lib/db の import 'server-only' が transitive に保証するため、本 file
// には直接付与しない。
//
// 詳細: specs/2026-07-10-sprint2-integration-failures-design.md §5

import { getDb } from '@/lib/db'
import { integrationFailures } from '@/lib/db/schema'
import { notifyOps } from '@/lib/ops'
import { logger } from '@/lib/logger'

// 4 軸語彙の SSoT。key はコード内 handle で DB には入らない (DB に入るのは 4 軸値のみ)。
// 4 軸 tuple は stable identifier として扱う: 値変更は原則「新 entry 追加」で行い、
// 既存 tuple の rename はしない (既存 DB 行との意味継続のため)。
export const INTEGRATION_FAILURE_CATALOG = {
  stripe_release: {
    service: 'stripe',
    operation: 'subscription_schedule.release',
    workflow: 'scheduled_downgrade',
    failureCode: 'external_api_error',
  },
  stripe_gate_mismatch: {
    service: 'stripe',
    operation: 'subscription_schedule.reconcile',
    workflow: 'scheduled_downgrade',
    failureCode: 'state_mismatch',
  },
  // workflow=null: 記録 site (clerk-metadata.ts) は user.created 初期 sync / Stripe plan
  // sync の複数文脈から呼ばれ、site 単独で文脈を特定できない (誤った固定値を書くより
  // NULL)。呼び出し元識別は verbatim 保存される context 側で判別する。
  clerk_sync: {
    service: 'clerk',
    operation: 'user.public_metadata.sync',
    workflow: null,
    failureCode: 'external_api_error',
  },
  deletion_cancel: {
    service: 'stripe',
    operation: 'subscription.cancel',
    workflow: 'user_deletion',
    failureCode: 'external_api_error',
  },
  deletion_list: {
    service: 'stripe',
    operation: 'subscription.list',
    workflow: 'user_deletion',
    failureCode: 'external_api_error',
  },
  deletion_customer_missing: {
    service: 'stripe',
    operation: 'subscription.list',
    workflow: 'user_deletion',
    failureCode: 'state_mismatch',
  },
  deletion_data: {
    service: 'db',
    operation: 'user.data.delete',
    workflow: 'user_deletion',
    failureCode: 'db_error',
  },
} as const

export type IntegrationFailureKey = keyof typeof INTEGRATION_FAILURE_CATALOG

type RecordIntegrationFailureArgs = {
  key: IntegrationFailureKey
  userId?: string
  clerkId?: string
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  scheduleId?: string
  errorMessage?: string
  subject: string
  context: Record<string, unknown>
}

/**
 * integration_failures に 1 行 INSERT した後 notifyOps で Discord 通知する。
 *
 * 順序 = ① INSERT (真実源) → ② notifyOps (通知)。INSERT 失敗は握って logger.error し、
 * context に ledgerWriteError 印を追記して通知は継続する (台帳欠落を Discord 側で可視化。
 * 自 table への再帰記録はしない)。notifyOps の throw (production misconfig fail-fast) は
 * 握らず伝播させる (呼び出し元の webhook 200 不変条件・outer catch を現状維持)。
 *
 * 4 軸値は catalog から引く (呼び出し側は自由文字列で 4 軸を渡せない)。context は
 * verbatim 保存し、入力 object は mutate しない (ledgerWriteError は派生 object にのみ付与)。
 */
export async function recordIntegrationFailure(
  args: RecordIntegrationFailureArgs,
): Promise<void> {
  const axes = INTEGRATION_FAILURE_CATALOG[args.key]

  // notifyOps に渡す context。INSERT 失敗時のみ ledgerWriteError を足すため派生 object を
  // 用意する (入力 args.context への副作用を避ける)。
  let notifyContext: Record<string, unknown> = args.context

  try {
    await getDb()
      .insert(integrationFailures)
      .values({
        service: axes.service,
        operation: axes.operation,
        workflow: axes.workflow,
        failureCode: axes.failureCode,
        userId: args.userId,
        clerkId: args.clerkId,
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        scheduleId: args.scheduleId,
        context: args.context,
        errorMessage: args.errorMessage,
      })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({
      event: 'integration_failures.insert_failed',
      key: args.key,
      err,
    })
    notifyContext = { ...args.context, ledgerWriteError: message }
  }

  await notifyOps(args.subject, notifyContext)
}
