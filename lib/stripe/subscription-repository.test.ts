import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { users } from '@/lib/db/schema'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import * as repo from './subscription-repository'
import {
  loadByUserId,
  loadByStripeCustomerId,
  loadByScheduleId,
  saveProjection,
  applyDeletedReset,
  saveReservation,
  clearReservation,
} from './subscription-repository'
import type { ProjectionUpdate, DeletedReset, ReservationUpdate } from './domain/subscription-aggregate'

// ---------------------------------------------------------------------------
// mock tx: DbExecutor は select/insert/update/delete を持つ構造的部分型。
// repository は select (load) と update (save) のみ使う。 各 chain の末端で
// resolve 値を返しつつ、 where / set 引数を spy で記録する。
// ---------------------------------------------------------------------------

// select().from().where() が row 配列に await 解決する chain。
function selectChain(rows: unknown[]) {
  const whereSpy = vi.fn().mockResolvedValue(rows)
  const fromSpy = vi.fn().mockReturnValue({ where: whereSpy })
  const selectSpy = vi.fn().mockReturnValue({ from: fromSpy })
  return { selectSpy, fromSpy, whereSpy }
}

// update().set().where().returning() が RETURNING 配列に await 解決する chain。
function updateChain(returningRows: unknown[]) {
  const returningSpy = vi.fn().mockResolvedValue(returningRows)
  const whereSpy = vi.fn().mockReturnValue({ returning: returningSpy })
  const setSpy = vi.fn().mockReturnValue({ where: whereSpy })
  const updateSpy = vi.fn().mockReturnValue({ set: setSpy })
  return { updateSpy, setSpy, whereSpy, returningSpy }
}

function selectTx(rows: unknown[]): { tx: DbExecutor; spies: ReturnType<typeof selectChain> } {
  const spies = selectChain(rows)
  const tx = { select: spies.selectSpy } as unknown as DbExecutor
  return { tx, spies }
}

function updateTx(returningRows: unknown[]): {
  tx: DbExecutor
  spies: ReturnType<typeof updateChain>
} {
  const spies = updateChain(returningRows)
  const tx = { update: spies.updateSpy } as unknown as DbExecutor
  return { tx, spies }
}

const RETURNING_ROW = {
  clerkId: 'clerk_1',
  scheduledDowngradeScheduleId: 'sched_1',
  scheduledTargetPriceId: 'price_t',
}

const PROJECTION: ProjectionUpdate = {
  plan: 'standard',
  billingInterval: 'month',
  subscriptionStatus: 'active',
  currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
  cancelAt: null,
  stripeSubscriptionId: 'sub_1',
}

const RESET: DeletedReset = {
  plan: 'free',
  billingInterval: null,
  subscriptionStatus: 'canceled',
  cancelAt: null,
  stripeSubscriptionId: null,
  scheduledDowngradeScheduleId: null,
  scheduledTargetPriceId: null,
  scheduledChangeEffectiveAt: null,
}

const RESERVATION_SET: ReservationUpdate = {
  scheduledDowngradeScheduleId: 'sched_1',
  scheduledTargetPriceId: 'price_t',
  scheduledChangeEffectiveAt: new Date('2026-06-01T00:00:00Z'),
}

const RESERVATION_CLEAR: ReservationUpdate = {
  scheduledDowngradeScheduleId: null,
  scheduledTargetPriceId: null,
  scheduledChangeEffectiveAt: null,
}

// ===========================================================================
// 観点 1: owner-scope WHERE verbatim — 各 save/load が SubKey の列で eq を張る
// ===========================================================================
describe('観点1: owner-scope WHERE verbatim', () => {
  it('loadByUserId は users.id で eq', async () => {
    const { tx, spies } = selectTx([])
    await loadByUserId(tx, 'user_abc')
    expect(spies.whereSpy).toHaveBeenCalledWith(eq(users.id, 'user_abc'))
  })

  it('loadByStripeCustomerId は users.stripeCustomerId で eq', async () => {
    const { tx, spies } = selectTx([])
    await loadByStripeCustomerId(tx, 'cus_abc')
    expect(spies.whereSpy).toHaveBeenCalledWith(eq(users.stripeCustomerId, 'cus_abc'))
  })

  it('loadByScheduleId は users.scheduledDowngradeScheduleId で eq', async () => {
    const { tx, spies } = selectTx([])
    await loadByScheduleId(tx, 'sched_abc')
    expect(spies.whereSpy).toHaveBeenCalledWith(
      eq(users.scheduledDowngradeScheduleId, 'sched_abc'),
    )
  })

  it('saveProjection は SubKey=clerkId → users.clerkId で eq', async () => {
    const { tx, spies } = updateTx([RETURNING_ROW])
    await saveProjection(tx, { by: 'clerkId', value: 'clerk_x' }, PROJECTION)
    expect(spies.whereSpy).toHaveBeenCalledWith(eq(users.clerkId, 'clerk_x'))
  })

  it('saveProjection は SubKey=stripeCustomerId → users.stripeCustomerId で eq', async () => {
    const { tx, spies } = updateTx([RETURNING_ROW])
    await saveProjection(tx, { by: 'stripeCustomerId', value: 'cus_x' }, PROJECTION)
    expect(spies.whereSpy).toHaveBeenCalledWith(eq(users.stripeCustomerId, 'cus_x'))
  })

  it('applyDeletedReset は SubKey=stripeCustomerId → users.stripeCustomerId で eq', async () => {
    const { tx, spies } = updateTx([RETURNING_ROW])
    await applyDeletedReset(tx, { by: 'stripeCustomerId', value: 'cus_y' }, RESET)
    expect(spies.whereSpy).toHaveBeenCalledWith(eq(users.stripeCustomerId, 'cus_y'))
  })

  it('saveReservation は SubKey=id → users.id で eq', async () => {
    const { tx, spies } = updateTx([RETURNING_ROW])
    await saveReservation(tx, { by: 'id', value: 'user_z' }, RESERVATION_SET)
    expect(spies.whereSpy).toHaveBeenCalledWith(eq(users.id, 'user_z'))
  })

  it('clearReservation は SubKey=scheduleId → users.scheduledDowngradeScheduleId で eq', async () => {
    const { tx, spies } = updateTx([RETURNING_ROW])
    await clearReservation(tx, { by: 'scheduleId', value: 'sched_z' }, RESERVATION_CLEAR)
    expect(spies.whereSpy).toHaveBeenCalledWith(
      eq(users.scheduledDowngradeScheduleId, 'sched_z'),
    )
  })
})

// ===========================================================================
// 観点 2: 予約 3 列 atomicity — set が 3 列同時 set / clear が 3 列同時 null
// ===========================================================================
describe('観点2: 予約 3 列 atomicity', () => {
  it('saveReservation は 3 列を同時 set', async () => {
    const { tx, spies } = updateTx([RETURNING_ROW])
    await saveReservation(tx, { by: 'id', value: 'u' }, RESERVATION_SET)
    expect(spies.setSpy).toHaveBeenCalledWith(RESERVATION_SET)
    // set 引数は予約 3 列のみ (plan 6 列を触らない)
    const arg = spies.setSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(arg).sort()).toEqual([
      'scheduledChangeEffectiveAt',
      'scheduledDowngradeScheduleId',
      'scheduledTargetPriceId',
    ])
  })

  it('clearReservation は 3 列を同時 null', async () => {
    const { tx, spies } = updateTx([RETURNING_ROW])
    await clearReservation(tx, { by: 'scheduleId', value: 's' }, RESERVATION_CLEAR)
    expect(spies.setSpy).toHaveBeenCalledWith({
      scheduledDowngradeScheduleId: null,
      scheduledTargetPriceId: null,
      scheduledChangeEffectiveAt: null,
    })
  })
})

// ===========================================================================
// 観点 3: 個別予約列 update 口の不在 — 単一予約列を書く export が無いこと
// ===========================================================================
describe('観点3: 個別予約列 update 口の不在', () => {
  it('repository の export に予約列を個別に書くメソッドが存在しない (I-9 型保証)', () => {
    // 予約列を書けるのは 3 列一括の saveReservation / clearReservation /
    // applyDeletedReset のみ。 単一列専用の setter を export してはならない。
    const exportedNames = Object.keys(repo)
    const forbidden = exportedNames.filter((n) =>
      /^(set|save|update|clear)(Scheduled|DowngradeSchedule|TargetPrice|ChangeEffective)/i.test(n),
    )
    expect(forbidden).toEqual([])
    // 予約を書く経路は 3 メソッドに限定 (allowlist)。
    const reservationWriters = exportedNames.filter(
      (n) => n === 'saveReservation' || n === 'clearReservation' || n === 'applyDeletedReset',
    )
    expect(reservationWriters.sort()).toEqual([
      'applyDeletedReset',
      'clearReservation',
      'saveReservation',
    ])
  })
})

// ===========================================================================
// 観点 4: RETURNING shape — SaveResult の 4 field が返る
// ===========================================================================
describe('観点4: RETURNING shape (SaveResult 4 field)', () => {
  it('saveProjection は matched/clerkId/予約 2 列を返す', async () => {
    const { tx } = updateTx([RETURNING_ROW])
    const result = await saveProjection(tx, { by: 'clerkId', value: 'c' }, PROJECTION)
    expect(result).toEqual({
      matched: true,
      clerkId: 'clerk_1',
      scheduledDowngradeScheduleId: 'sched_1',
      scheduledTargetPriceId: 'price_t',
    })
  })

  it('RETURNING は clerkId + 予約 2 列を SELECT する (release gate 材料)', async () => {
    const { tx, spies } = updateTx([RETURNING_ROW])
    await saveProjection(tx, { by: 'clerkId', value: 'c' }, PROJECTION)
    const returningArg = spies.returningSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(returningArg).sort()).toEqual([
      'clerkId',
      'scheduledDowngradeScheduleId',
      'scheduledTargetPriceId',
    ])
  })

  it('applyDeletedReset / saveReservation / clearReservation も同 SaveResult shape', async () => {
    const del = updateTx([RETURNING_ROW])
    expect(
      await applyDeletedReset(del.tx, { by: 'stripeCustomerId', value: 'x' }, RESET),
    ).toEqual({
      matched: true,
      clerkId: 'clerk_1',
      scheduledDowngradeScheduleId: 'sched_1',
      scheduledTargetPriceId: 'price_t',
    })
    const setR = updateTx([RETURNING_ROW])
    expect(await saveReservation(setR.tx, { by: 'id', value: 'x' }, RESERVATION_SET)).toEqual({
      matched: true,
      clerkId: 'clerk_1',
      scheduledDowngradeScheduleId: 'sched_1',
      scheduledTargetPriceId: 'price_t',
    })
  })
})

// ===========================================================================
// 観点 5: 0 行 match — RETURNING 空配列 → matched:false, clerkId:null
// ===========================================================================
describe('観点5: 0 行 match', () => {
  it('saveProjection の RETURNING 空 → matched:false, clerkId:null', async () => {
    const { tx } = updateTx([])
    const result = await saveProjection(tx, { by: 'clerkId', value: 'nope' }, PROJECTION)
    expect(result).toEqual({
      matched: false,
      clerkId: null,
      scheduledDowngradeScheduleId: null,
      scheduledTargetPriceId: null,
    })
  })

  it('applyDeletedReset の RETURNING 空 → matched:false', async () => {
    const { tx } = updateTx([])
    const result = await applyDeletedReset(tx, { by: 'stripeCustomerId', value: 'nope' }, RESET)
    expect(result.matched).toBe(false)
    expect(result.clerkId).toBeNull()
  })
})

// load の shape (subscription slice を返す / 0 行は null)
describe('load: subscription slice', () => {
  it('行あり → slice を返す', async () => {
    const row = {
      id: 'u1',
      clerkId: 'c1',
      plan: 'standard',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      cancelAt: null,
      stripeSubscriptionId: 'sub_1',
      scheduledDowngradeScheduleId: null,
      scheduledTargetPriceId: null,
      scheduledChangeEffectiveAt: null,
    }
    const { tx } = selectTx([row])
    expect(await loadByUserId(tx, 'u1')).toEqual(row)
  })

  it('0 行 → null', async () => {
    const { tx } = selectTx([])
    expect(await loadByUserId(tx, 'nope')).toBeNull()
  })
})
