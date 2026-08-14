// RLS-P2 Task 9 — item (3): tenant context の漏れ防止 & loud 検出 (spec §3.1-4)。
//
//  - A/B 交互 tx: 各 tx は自 tenant のみ見る。COMMIT path / ROLLBACK path とも
//    前 tenant の残留が無い。
//  - loud: context 未設定 or 空文字での対象表アクセスは P0RLS RAISE
//    (app_current_user_id が空/未設定で raise する = 潜伏させない)。INSERT は
//    per-new-row の WITH CHECK 評価ゆえ行数に依らず必ず RAISE。
//  - wrapper 実 PG: asTenant 内で GUC 可視 / tx 消滅後は context 消える (P0RLS) /
//    savepoint (per-mutation tx 構造) 内でも context 維持。
//
// mutating (rollback) を含むため beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import { cards } from '@/lib/db/schema'
import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'

import { asTenant } from './setup/as-tenant'
import { assertRejectsWithP0RLS } from './setup/rls-assert'
import {
  type TenantFixture,
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

const CARD_OPTIONS = [
  { id: 'a', uid: '00000000-0000-4000-8000-000000000001', text: 'opt a', is_correct: true },
  { id: 'b', uid: '00000000-0000-4000-8000-000000000002', text: 'opt b', is_correct: false },
]

describe('RLS tenant context: isolation across tx + loud on missing context', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
  })

  describe('A/B alternating transactions', () => {
    it('each tx sees only its own tenant across A/B/A/B (no residue)', async () => {
      const readCards = (userId: string) =>
        asTenant(userId, (tx) => tx.select({ id: cards.id }).from(cards))

      const a1 = await readCards(fixture.a.userId)
      expect(a1.map((r) => r.id)).toEqual([fixture.a.cardId])

      const b1 = await readCards(fixture.b.userId)
      expect(b1.map((r) => r.id)).toEqual([fixture.b.cardId])

      const a2 = await readCards(fixture.a.userId)
      expect(a2.map((r) => r.id)).toEqual([fixture.a.cardId])

      const b2 = await readCards(fixture.b.userId)
      expect(b2.map((r) => r.id)).toEqual([fixture.b.cardId])
    })

    it('a tx that throws rolls back its write; later tx sees no residue', async () => {
      const owner = getFixtureOwnerDb()
      const boomCardId = randomUUID()

      await expect(
        asTenant(fixture.a.userId, async (tx) => {
          await tx.insert(cards).values({
            id: boomCardId,
            userId: fixture.a.userId,
            examId: fixture.a.examId,
            sourceDocumentId: fixture.a.sourceDocumentId,
            title: 'rolled back',
            baseOrder: 1024,
            questionText: 'Q?',
            options: CARD_OPTIONS,
            correctAnswerIds: ['a'],
            ...initialFsrsState(new Date()),
          })
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')

      // owner ground-truth: rollback により boom card は存在しない。
      const planted = await owner
        .select({ id: cards.id })
        .from(cards)
        .where(sql`${cards.id} = ${boomCardId}`)
      expect(planted).toHaveLength(0)

      // 後続 tx は自 tenant のみ・rollback 分の残留無し。
      const bRows = await asTenant(fixture.b.userId, (tx) =>
        tx.select({ id: cards.id }).from(cards),
      )
      expect(bRows.map((r) => r.id)).toEqual([fixture.b.cardId])

      const aRows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: cards.id }).from(cards),
      )
      expect(aRows.map((r) => r.id)).toEqual([fixture.a.cardId])
    })
  })

  describe('loud on missing / empty context', () => {
    it('bare SELECT on cards without tenant context raises P0RLS', async () => {
      await assertRejectsWithP0RLS(() =>
        getDb().select({ id: cards.id }).from(cards),
      )
    })

    it('empty-string context ("") raises P0RLS on SELECT', async () => {
      await assertRejectsWithP0RLS(() =>
        getDb().transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.user_id', '', true)`)
          return tx.select({ id: cards.id }).from(cards)
        }),
      )
    })

    it('INSERT without context raises P0RLS (WITH CHECK is per-new-row, row count irrelevant)', async () => {
      await assertRejectsWithP0RLS(() =>
        getDb().insert(cards).values({
          id: randomUUID(),
          userId: fixture.a.userId,
          examId: fixture.a.examId,
          sourceDocumentId: fixture.a.sourceDocumentId,
          title: 'no-context insert',
          baseOrder: 1024,
          questionText: 'Q?',
          options: CARD_OPTIONS,
          correctAnswerIds: ['a'],
          ...initialFsrsState(new Date()),
        }),
      )
    })
  })

  describe('withTenantTx GUC semantics on real PG', () => {
    it('current_setting(app.user_id) inside asTenant equals the tenant id', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.execute<{ v: string }>(sql`SELECT current_setting('app.user_id', true) AS v`),
      )
      expect(rows[0]?.v).toBe(fixture.a.userId)
    })

    it('GUC is transaction-local: a contextless call after the tx raises P0RLS', async () => {
      // context を張って使い切る tx (COMMIT)。
      await asTenant(fixture.a.userId, (tx) =>
        tx.execute(sql`SELECT public.app_current_user_id()`),
      )
      // 別 tx (set_config なし) では GUC が消えている → P0RLS。
      await assertRejectsWithP0RLS(() =>
        getDb().execute(sql`SELECT public.app_current_user_id()`),
      )
    })

    it('a nested savepoint sub-tx still sees the outer tenant context', async () => {
      // per-mutation tx (entity-mutations) の savepoint 構造を再現。inner が
      // outer で張った GUC を引き継ぎ、cards read も A のみに scope される。
      await asTenant(fixture.a.userId, async (tx) => {
        await tx.transaction(async (inner) => {
          const ctx = await inner.execute<{ v: string }>(
            sql`SELECT public.app_current_user_id() AS v`,
          )
          expect(ctx[0]?.v).toBe(fixture.a.userId)

          const rows = await inner.select({ id: cards.id }).from(cards)
          expect(rows.map((r) => r.id)).toEqual([fixture.a.cardId])
        })
      })
    })
  })
})
