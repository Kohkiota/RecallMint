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

import { closeDb } from '@/lib/db'
import { cards, tagOptions } from '@/lib/db/schema'
import { CARD_FIELD_HANDLERS } from '@/lib/cards/card-field-handlers'
import { applyTagOptionUpdate } from '@/lib/tags/apply-tag-mutation'
import { applyCardFinalStates } from '@/lib/reviews/session-repository'
import type { ReplayCardState } from '@/lib/cards/replay-card'

import { asTenant } from './setup/as-tenant'
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
      // 刺激: app-role + tenant context (本番の per-mutation tx と同配線)。
      const result = await asTenant(fixture.a.userId, (tx) =>
        CARD_FIELD_HANDLERS.title(tx, fixture.a.cardId, fixture.a.userId, 'A-new-title'),
      )
      expect(result).toBe('applied')

      // 観測: owner 接続で ground-truth 行状態を読む (RLS bypass)。
      const rows = await getFixtureOwnerDb()
        .select({ title: cards.title })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      expect(rows[0]?.title).toBe('A-new-title')
    })

    it('does not update tenant B card via tenant A context (negative)', async () => {
      const result = await asTenant(fixture.a.userId, (tx) =>
        CARD_FIELD_HANDLERS.title(tx, fixture.b.cardId, fixture.a.userId, 'HACKED'),
      )
      expect(result).toBe('failed')

      const rows = await getFixtureOwnerDb()
        .select({ title: cards.title })
        .from(cards)
        .where(eq(cards.id, fixture.b.cardId))
      expect(rows[0]?.title).toBe('Card B')
    })
  })

  // --- 非 RED・behavioral: owner-scope `and(eq(tagOptions.id, optionId),
  // eq(tagOptions.userId, userId))`。RLS-P3 Wave 1 で tag_options が RLS 有効化された
  // ため、刺激は本番の per-mutation tx と同じ **asTenant(A) 下**で走らせる(RLS on の
  // tag_options は context 無しの raw getDb では P0RLS になり叩けない)。隔離 assertion
  // は不変: A の userId で B の tagOptionId を更新しても 'failed'(B 不変)。RLS 有効化後は
  // これが **RLS(USING が B を A から不可視化)と app 層 eq(userId) の二重防御**で成立する。
  // A 自身は 'applied'。観測は owner (RLS bypass)。
  describe('applyTagOptionUpdate', () => {
    it('updates tenant A own tag option (positive control)', async () => {
      const result = await asTenant(fixture.a.userId, (tx) =>
        applyTagOptionUpdate(tx, fixture.a.userId, fixture.a.tagOptionId, {
          field: 'name',
          value: 'A-new-option',
        }),
      )
      expect(result).toBe('applied')
    })

    it('does not update tenant B tag option via tenant A context (negative)', async () => {
      const result = await asTenant(fixture.a.userId, (tx) =>
        applyTagOptionUpdate(tx, fixture.a.userId, fixture.b.tagOptionId, {
          field: 'name',
          value: 'HACKED',
        }),
      )
      expect(result).toBe('failed')

      // B の実データ不変を owner で確認(vacuous 回避)。'name' field は owner-scoped
      // pre-check SELECT で短絡するため共有 final UPDATE の WHERE 節そのものは独立に
      // exercise されない(下の 'color' が担う)。RLS + app 層 eq(userId) の二重防御で 0 行。
      const rows = await getFixtureOwnerDb()
        .select({ name: tagOptions.name })
        .from(tagOptions)
        .where(eq(tagOptions.id, fixture.b.tagOptionId))
      expect(rows[0]?.name).toBe('Option')
    })

    // 'name'/'category_id' は pre-check SELECT で短絡するが、'color'/'sort_key' は pre-check
    // が無く、共有 final UPDATE の and(eq(id), eq(userId)) が app 層唯一の owner 節。RLS 有効化
    // 後はそこに USING も重なる。pre-check の無い 'color' で両防御下の B 不変を exercise する。
    it('updates tenant A own tag option color (positive control)', async () => {
      const result = await asTenant(fixture.a.userId, (tx) =>
        applyTagOptionUpdate(tx, fixture.a.userId, fixture.a.tagOptionId, {
          field: 'color',
          value: '#a11a11',
        }),
      )
      expect(result).toBe('applied')

      const rows = await getFixtureOwnerDb()
        .select({ color: tagOptions.color })
        .from(tagOptions)
        .where(eq(tagOptions.id, fixture.a.tagOptionId))
      expect(rows[0]?.color).toBe('#a11a11')
    })

    it('does not update tenant B tag option color via tenant A context (negative, shared UPDATE owner clause)', async () => {
      const result = await asTenant(fixture.a.userId, (tx) =>
        applyTagOptionUpdate(tx, fixture.a.userId, fixture.b.tagOptionId, {
          field: 'color',
          value: '#hacked',
        }),
      )
      expect(result).toBe('failed')

      // color は pre-check 無し = 共有 UPDATE の owner 節 + RLS USING のみが守る。B の color は不変 (null)。
      const rows = await getFixtureOwnerDb()
        .select({ color: tagOptions.color })
        .from(tagOptions)
        .where(eq(tagOptions.id, fixture.b.tagOptionId))
      expect(rows[0]?.color).toBeNull()
    })
  })

  // --- 非 RED・behavioral: cards の FSRS state UPDATE を
  // `WHERE and(eq(cards.userId, userId), cards.id = v.id)` で行う (VALUES join)。
  // A の userId で B の cardId を渡すと RETURNING 0 行 → finalStates.size(1)との
  // count-mismatch throw (session-repository.ts の安全網)。A 自身は resolve し
  // 実 DB の値が書き換わる。
  describe('applyCardFinalStates', () => {
    // stability / difficulty は double precision 化(Task 3・spec §1.3、2 列を
    // 1 つの変更として扱う)の実証 pin に使う値。5.5 は単精度 (real, IEEE754
    // float32) でも正確に表現できてしまうため(real cast でも toBe(5.5) が
    // 通ってしまい pin として機能しない)、単精度の 24bit 仮数部を超える有効桁を
    // 持つ値を選ぶ(real cast だと丸められ、double precision cast だとそのまま
    // 保たれる)。difficulty の 3.3 も同じ理由で区別できる値
    // (Math.fround(3.3) = 3.299999952316284 ≠ 3.3)。
    const sampleFinalState: ReplayCardState = {
      due: new Date('2030-01-01T00:00:00.000Z'),
      stability: 5.123456789012345,
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
      await asTenant(fixture.a.userId, (tx) =>
        applyCardFinalStates(
          tx,
          fixture.a.userId,
          new Map([[fixture.a.cardId, sampleFinalState]]),
        ),
      )

      const rows = await getFixtureOwnerDb()
        .select({ stability: cards.stability, difficulty: cards.difficulty })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      // 厳密一致(Task 3): double precision 化が実際に効いていることの pin。
      // stability / difficulty 双方の cast を個別に ::real へ戻す変異でそれぞれ
      // fail することを red 検証済み(task-3-report.md)。
      expect(rows[0]?.stability).toBe(5.123456789012345)
      expect(rows[0]?.difficulty).toBe(3.3)
    })

    it('does not update tenant B card via tenant A context (negative)', async () => {
      await expect(
        asTenant(fixture.a.userId, (tx) =>
          applyCardFinalStates(
            tx,
            fixture.a.userId,
            new Map([[fixture.b.cardId, sampleFinalState]]),
          ),
        ),
      ).rejects.toThrow('bulk update card count mismatch')
    })
  })
})
