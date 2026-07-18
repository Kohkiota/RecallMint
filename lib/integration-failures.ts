// 課金系・外部連携の失敗を DB 台帳 (integration_failures) に記録しつつ Discord へも
// 通知する dual-write helper。handle-clerk-event.ts の recordFailure (DB 書込 = 真実
// → notifyOps = 通知 の順) を一般化したもの。
//
// server 境界は @/lib/db の import 'server-only' が transitive に保証するため、本 file
// には直接付与しない。
//
// 詳細: specs/2026-07-10-sprint2-integration-failures-design.md §5

import { getAdminDb, getDb } from '@/lib/db'
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
  // workflow=null: 記録 site (clerk-metadata.ts) は複数文脈から呼ばれ、site 単独で
  // 文脈を特定できない (誤った固定値を書くより NULL)。caller-trace (Task 2 実確認):
  //   init sync (handle-clerk-event.ts user.created) → context.keys = ['dbUserId','plan']
  //   Stripe plan sync (handle-stripe-event.ts .deleted / project-subscription.ts) → ['plan']
  //   backfill script (backfill-clerk-metadata.ts) → ['dbUserId','plan']
  // ゆえ context.keys で「Stripe plan sync (['plan'])」対「init sync or backfill
  // (['dbUserId','plan'])」の傾向推測は可能だが、init sync と backfill は同一 keys で
  // 厳密判別は不能。これを許容し workflow=null を維持する (override 引数は入れない = 4 軸原則)。
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
  // 画像GC sweepのR2物理削除失敗。 design spec §4.6: DB側の掃除(status/行DELETE)とは
  // decoupleされ、 R2失敗のみ台帳に積む(DB失敗はscript出力の可視化+次run収束に委ねる)。
  // context = { assetId, objectKey, status } (呼出配線はG5 reconcilerで行う)。
  r2_gc_delete: {
    service: 'r2',
    operation: 'object.delete',
    workflow: 'asset_gc',
    failureCode: 'external_api_error',
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
    // 実行文脈で存在する接続を選ぶ: runtime は DATABASE_URL_APP(app role)、operator
    // script は DATABASE_URL_ADMIN(owner)のみを持つ (RLS-P1)。どちらでも失敗台帳の
    // INSERT を落とさないため (integration_failures は app/owner 両 role が INSERT 可)。
    // 選択も try 内に置く: getDb/getAdminDb が env 未設定等で throw しても catch の
    // best-effort (ledger 失敗 log + notifyOps) を通すため。
    const db = process.env.DATABASE_URL_APP ? getDb() : getAdminDb()
    await db
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
