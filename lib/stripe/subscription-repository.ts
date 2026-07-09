// Subscription repository (infra 層)。 users 行の subscription slice を drizzle
// で読み書きする唯一の新 file。 aggregate (純粋 domain) が組み立てた書込値を
// 受け取り、 owner-scope WHERE を SubKey で張って RETURNING で結果を返す。
//
// 構造的不変条件 (I-9): 予約 3 列 (scheduledDowngradeScheduleId /
// scheduledTargetPriceId / scheduledChangeEffectiveAt) を書けるのは 3 列一括の
// saveReservation / clearReservation / applyDeletedReset のみ。 単一予約列だけを
// 書く口はこの module に存在しない (型で atomicity を保証)。
//
// RETURNING は全 save メソッド共通で { clerkId, scheduledDowngradeScheduleId,
// scheduledTargetPriceId } を返す (A-4 row-match / clerkId 分離 + release gate 材料)。

import { eq } from 'drizzle-orm'
import { users } from '@/lib/db/schema'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import type {
  ProjectionUpdate,
  DeletedReset,
  ReservationUpdate,
} from './domain/subscription-aggregate'

// ---------------------------------------------------------------------------
// SubKey: owner-scope の照合 key。 呼出側 (次 task) が現行 site と同じ key を渡す。
//   id → users.id / clerkId → users.clerkId / stripeCustomerId → users.stripeCustomerId /
//   scheduleId → users.scheduledDowngradeScheduleId
// ---------------------------------------------------------------------------
export type SubKey =
  | { by: 'id'; value: string }
  | { by: 'clerkId'; value: string }
  | { by: 'stripeCustomerId'; value: string }
  | { by: 'scheduleId'; value: string }

// SubKey → WHERE 述語。 owner-scope は必ずこの 1 箇所を経由する (verbatim 保証)。
function whereFor(key: SubKey) {
  switch (key.by) {
    case 'id':
      return eq(users.id, key.value)
    case 'clerkId':
      return eq(users.clerkId, key.value)
    case 'stripeCustomerId':
      return eq(users.stripeCustomerId, key.value)
    case 'scheduleId':
      return eq(users.scheduledDowngradeScheduleId, key.value)
  }
}

// ---------------------------------------------------------------------------
// load: subscription slice を返す。 列は plan 6 + 予約 3 + clerkId + id。
// ---------------------------------------------------------------------------
export type SubscriptionSlice = {
  id: string
  clerkId: string | null
  plan: 'free' | 'standard' | 'pro'
  billingInterval: 'month' | 'year' | null
  subscriptionStatus: 'active' | 'past_due' | 'canceled' | null
  currentPeriodEnd: Date | null
  cancelAt: Date | null
  stripeSubscriptionId: string | null
  scheduledDowngradeScheduleId: string | null
  scheduledTargetPriceId: string | null
  scheduledChangeEffectiveAt: Date | null
}

const SLICE_COLUMNS = {
  id: users.id,
  clerkId: users.clerkId,
  plan: users.plan,
  billingInterval: users.billingInterval,
  subscriptionStatus: users.subscriptionStatus,
  currentPeriodEnd: users.currentPeriodEnd,
  cancelAt: users.cancelAt,
  stripeSubscriptionId: users.stripeSubscriptionId,
  scheduledDowngradeScheduleId: users.scheduledDowngradeScheduleId,
  scheduledTargetPriceId: users.scheduledTargetPriceId,
  scheduledChangeEffectiveAt: users.scheduledChangeEffectiveAt,
} as const

async function load(tx: DbExecutor, key: SubKey): Promise<SubscriptionSlice | null> {
  const rows = await tx.select(SLICE_COLUMNS).from(users).where(whereFor(key))
  return (rows[0] as SubscriptionSlice | undefined) ?? null
}

export function loadByUserId(tx: DbExecutor, userId: string): Promise<SubscriptionSlice | null> {
  return load(tx, { by: 'id', value: userId })
}

export function loadByStripeCustomerId(
  tx: DbExecutor,
  customerId: string,
): Promise<SubscriptionSlice | null> {
  return load(tx, { by: 'stripeCustomerId', value: customerId })
}

export function loadByScheduleId(
  tx: DbExecutor,
  scheduleId: string,
): Promise<SubscriptionSlice | null> {
  return load(tx, { by: 'scheduleId', value: scheduleId })
}

// ---------------------------------------------------------------------------
// save: 全メソッド共通で RETURNING { clerkId, 予約 2 列 } を返し、 matched =
// rows.length > 0。 A-4 row-match / clerkId 分離 + release gate 評価に必要。
// ---------------------------------------------------------------------------
export type SaveResult = {
  matched: boolean
  clerkId: string | null
  scheduledDowngradeScheduleId: string | null
  scheduledTargetPriceId: string | null
}

// RETURNING の共通 shape。 clerkId (metadata sync 要否) と予約 2 列 (release gate
// 照合材料) を全 save で一様に取り出す。
const RETURNING_SHAPE = {
  clerkId: users.clerkId,
  scheduledDowngradeScheduleId: users.scheduledDowngradeScheduleId,
  scheduledTargetPriceId: users.scheduledTargetPriceId,
} as const

type ReturningRow = {
  clerkId: string | null
  scheduledDowngradeScheduleId: string | null
  scheduledTargetPriceId: string | null
}

function toSaveResult(rows: ReturningRow[]): SaveResult {
  const row = rows[0]
  return {
    matched: rows.length > 0,
    clerkId: row?.clerkId ?? null,
    scheduledDowngradeScheduleId: row?.scheduledDowngradeScheduleId ?? null,
    scheduledTargetPriceId: row?.scheduledTargetPriceId ?? null,
  }
}

// saveProjection: plan 6 列のみ set。 予約列は触らない (RETURNING で既存予約値を
// そのまま取り出せる = release gate 照合材料)。
export async function saveProjection(
  tx: DbExecutor,
  key: SubKey,
  update: ProjectionUpdate,
): Promise<SaveResult> {
  const rows = await tx
    .update(users)
    .set(update)
    .where(whereFor(key))
    .returning(RETURNING_SHAPE)
  return toSaveResult(rows as ReturningRow[])
}

// applyDeletedReset: deleted reset 8 列 (予約 3 列を含む一括 clear)。
export async function applyDeletedReset(
  tx: DbExecutor,
  key: SubKey,
  reset: DeletedReset,
): Promise<SaveResult> {
  const rows = await tx
    .update(users)
    .set(reset)
    .where(whereFor(key))
    .returning(RETURNING_SHAPE)
  return toSaveResult(rows as ReturningRow[])
}

// saveReservation: 予約 3 列一括 set (I-9)。
export async function saveReservation(
  tx: DbExecutor,
  key: SubKey,
  update: ReservationUpdate,
): Promise<SaveResult> {
  const rows = await tx
    .update(users)
    .set(update)
    .where(whereFor(key))
    .returning(RETURNING_SHAPE)
  return toSaveResult(rows as ReturningRow[])
}

// clearReservation: 予約 3 列一括 null (I-9)。 update は ReservationUpdate (全 null)
// を受け取る = clearReservation() aggregate の出力を verbatim 書く。
export async function clearReservation(
  tx: DbExecutor,
  key: SubKey,
  update: ReservationUpdate,
): Promise<SaveResult> {
  const rows = await tx
    .update(users)
    .set(update)
    .where(whereFor(key))
    .returning(RETURNING_SHAPE)
  return toSaveResult(rows as ReturningRow[])
}
