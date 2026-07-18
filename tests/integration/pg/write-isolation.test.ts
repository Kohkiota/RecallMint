// W1: write 越境 隔離 assertion。owner-scoped UPDATE が「A の文脈で B の card を
// 更新できない」(negative: 0 行・B 不変)かつ「A 自身の card は更新できる」
// (positive control)ことを実 PG で検証する。
//
// 代表 RED = CARD_FIELD_HANDLERS.title 経由の updateCardField
// (lib/cards/card-field-handlers.ts の
// `and(eq(cards.id, cardId), eq(cards.userId, userId))`)。owner-scope が
// `eq(cards.userId, userId)` を外すと B の card が A の userId 呼び出しで
// 書き換わる = clean な write 越境代表。他 2 関数は非 RED・best-effort の
// behavioral assertion(詳細は各 describe 内コメント)。
//
// mutating test ゆえ beforeEach で truncate→seed(各 test を clean state から)。
// read-isolation.test.ts / delta-isolation.test.ts と異なり beforeAll ではなく
// beforeEach を使う(前 test の書込みが後続 test の positive/negative 判定を
// 汚さないようにするため)。
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import { cards, tagOptions } from '@/lib/db/schema'
import { CARD_FIELD_HANDLERS } from '@/lib/cards/card-field-handlers'
import { applyTagOptionUpdate } from '@/lib/tags/apply-tag-mutation'
import { applyCardFinalStates } from '@/lib/reviews/session-repository'
import type { ReplayCardState } from '@/lib/cards/replay-card'

import {
  type TenantFixture,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

afterAll(async () => {
  await closeDb()
})

describe('write isolation (W1)', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
  })

  // --- 代表 RED: updateCardField の WHERE から eq(cards.userId, userId) を
  // 外すと、B の card が A の userId 呼び出しで書き換わる(0 行 → 1 行)。
  // 戻り値と実 DB の行状態の両方を assert する(戻り値だけだと UPDATE が実際に
  // 効いたか分からないため)。
  describe('CARD_FIELD_HANDLERS.title', () => {
    it('updates tenant A own card title (positive control)', async () => {
      const result = await CARD_FIELD_HANDLERS.title(
        getDb(),
        fixture.a.cardId,
        fixture.a.userId,
        'A-new-title',
      )
      expect(result).toBe('applied')

      const rows = await getDb()
        .select({ title: cards.title })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      expect(rows[0]?.title).toBe('A-new-title')
    })

    it('does not update tenant B card via tenant A context (negative)', async () => {
      const result = await CARD_FIELD_HANDLERS.title(
        getDb(),
        fixture.b.cardId,
        fixture.a.userId,
        'HACKED',
      )
      expect(result).toBe('failed')

      const rows = await getDb()
        .select({ title: cards.title })
        .from(cards)
        .where(eq(cards.id, fixture.b.cardId))
      expect(rows[0]?.title).toBe('Card B')
    })
  })

  // --- 非 RED・behavioral: owner-scope `and(eq(tagOptions.id, optionId),
  // eq(tagOptions.userId, userId))`。A の userId で B の tagOptionId を更新
  // しても 0 行 → 'failed'(A 自身は 'applied')。
  describe('applyTagOptionUpdate', () => {
    it('updates tenant A own tag option (positive control)', async () => {
      const result = await applyTagOptionUpdate(
        getDb(),
        fixture.a.userId,
        fixture.a.tagOptionId,
        { field: 'name', value: 'A-new-option' },
      )
      expect(result).toBe('applied')
    })

    it('does not update tenant B tag option via tenant A context (negative)', async () => {
      const result = await applyTagOptionUpdate(
        getDb(),
        fixture.a.userId,
        fixture.b.tagOptionId,
        { field: 'name', value: 'HACKED' },
      )
      expect(result).toBe('failed')

      // 戻り値だけでなく B の実データが不変であることも確認(vacuous 回避)。
      // 注: 'name' field は owner-scoped pre-check SELECT で短絡するため、共有 final
      // UPDATE の WHERE 節そのものは本 test では独立に exercise されない(delete 系と
      // 同じ defense-in-depth。full RED 化は follow-up)。
      const rows = await getDb()
        .select({ name: tagOptions.name })
        .from(tagOptions)
        .where(eq(tagOptions.id, fixture.b.tagOptionId))
      expect(rows[0]?.name).toBe('Option')
    })
  })

  // --- 非 RED・behavioral: cards の FSRS state UPDATE を
  // `WHERE and(eq(cards.userId, userId), cards.id = v.id)` で行う (VALUES join)。
  // A の userId で B の cardId を渡すと RETURNING 0 行 → finalStates.size(1)との
  // count-mismatch throw (session-repository.ts の安全網)。A 自身は resolve し
  // 実 DB の値が書き換わる。
  describe('applyCardFinalStates', () => {
    const sampleFinalState: ReplayCardState = {
      due: new Date('2030-01-01T00:00:00.000Z'),
      stability: 5.5,
      difficulty: 3.3,
      elapsedDays: 10,
      scheduledDays: 20,
      reps: 4,
      lapses: 1,
      state: 2,
      learningSteps: 0,
      lastReview: new Date('2026-07-18T00:00:00.000Z'),
      answered: true,
      lastCorrect: true,
      currentStreak: 2,
    }

    it('updates tenant A own card FSRS state (positive control)', async () => {
      await applyCardFinalStates(
        getDb(),
        fixture.a.userId,
        new Map([[fixture.a.cardId, sampleFinalState]]),
      )

      const rows = await getDb()
        .select({ stability: cards.stability })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      expect(rows[0]?.stability).toBeCloseTo(5.5)
    })

    it('does not update tenant B card via tenant A context (negative)', async () => {
      await expect(
        applyCardFinalStates(
          getDb(),
          fixture.a.userId,
          new Map([[fixture.b.cardId, sampleFinalState]]),
        ),
      ).rejects.toThrow('bulk update card count mismatch')
    })
  })
})
