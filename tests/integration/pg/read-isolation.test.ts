// R1: read 混入 隔離 assertion。owner-scoped read が「B の行を A の結果に混ぜない」
// (negative)かつ「A 自身の行は返す」(positive control)ことを実 PG で検証する。
//
// 代表 RED = getActiveExamsForUser(userId)(lib/exams/list.ts の
// `eq(exams.userId, userId)`)。owner 述語が単一(他 column に shadow されない)ため、
// これを外すと B の active exam が直接 A の結果に漏れる = clean な read 混入代表。
// 他 3 関数は非 RED・best-effort の behavioral assertion(詳細は各 describe 内コメント)。
//
// read-only test ゆえ beforeAll で truncate→seed を 1 回のみ(per-test reset 不要)。
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { cards, studyDays } from '@/lib/db/schema'
import { getSessionCards } from '@/lib/cards/get-session-cards'
import { getReviewStatsForUser } from '@/lib/db/streak'
import { getActiveExamsForUser, getCardsForExam } from '@/lib/exams/list'

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

describe('read isolation (R1)', () => {
  let fixture: TenantFixture

  beforeAll(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()

    // decoy 差分の投入は ground-truth 側の seeding(A/B 両テナントに跨るため単一
    // tenant context では張れない)。RLS-P2: owner 接続で RLS を bypass して直書きする。
    const owner = getFixtureOwnerDb()

    // getSessionCards decoy 適格性: cards.due は defaultNow() で seed 時刻になる。
    // wall-clock 依存で due<=now が偶然成立/不成立になるのを避けるため、A/B 両方の
    // card due を確定的に過去へ固定する(fixture 自体は変更しない)。
    await owner
      .update(cards)
      .set({ due: new Date('2020-01-01T00:00:00.000Z') })
      .where(inArray(cards.id, [fixture.a.cardId, fixture.b.cardId]))

    // getReviewStatsForUser decoy 適格性: study_days は fixture で
    // distinct_card_count=0 / review_count=0 のまま挿入される(既定値)ため、positive
    // control(A 自身の既知値が返る)も negative(B の既知値と別)も空振りする。
    // A/B に別々の既知値を入れて初めて「効いている」assertion になる。
    await owner
      .update(studyDays)
      .set({ distinctCardCount: 3, reviewCount: 2 })
      .where(eq(studyDays.userId, fixture.a.userId))
    await owner
      .update(studyDays)
      .set({ distinctCardCount: 9, reviewCount: 5 })
      .where(eq(studyDays.userId, fixture.b.userId))
  })

  // --- 代表 RED: eq(exams.userId, userId) を外すと B の active exam が漏れる ---
  describe('getActiveExamsForUser', () => {
    it('returns tenant A own exam (positive control)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getActiveExamsForUser(fixture.a.userId, tx),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.examId)
    })

    it('does not leak tenant B exam into tenant A result (negative)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getActiveExamsForUser(fixture.a.userId, tx),
      )
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.examId)
    })
  })

  // --- 非 RED・best-effort: eq(cards.examId, examId) が userId を shadow するため
  // RED 代表には不適(A は自 examId で引くので userId を外しても B の別 exam の card
  // は来ない)。「A が B の examId を渡しても B の card を得られない(0 件)」を assert。
  describe('getCardsForExam', () => {
    it('returns tenant A own card for own examId (positive control)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getCardsForExam(fixture.a.userId, fixture.a.examId, tx),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.cardId)
    })

    it('returns empty when A supplies B examId (negative, non-leak via shadowing)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getCardsForExam(fixture.a.userId, fixture.b.examId, tx),
      )
      expect(rows).toHaveLength(0)
    })
  })

  // --- 非 RED・best-effort: eq(cards.userId, userId) AND eq(cards.examId, examId)。
  // Dash-1 Home v1 §8.5 で選定が試験スコープ + 出題プール契約に変わったため、A/B の
  // card は state=0 (fixture の initialFsrsState) = 新規部で拾われる経路で見る
  // (due 固定は残るが、新規部は due 条件を持たないので decoy 適格性には効かない)。
  describe('getSessionCards', () => {
    const now = new Date('2026-07-18T12:00:00.000Z')

    it('returns tenant A own card (positive control)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getSessionCards(fixture.a.userId, fixture.a.examId, null, tx, now),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.cardId)
    })

    it('does not leak tenant B card into tenant A result (negative)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getSessionCards(fixture.a.userId, fixture.a.examId, null, tx, now),
      )
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.cardId)
    })

    it('returns empty when A supplies B examId (negative, non-leak via shadowing)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getSessionCards(fixture.a.userId, fixture.b.examId, null, tx, now),
      )
      expect(rows).toHaveLength(0)
    })
  })

  // --- 非 RED・best-effort: raw SQL `WHERE user_id = ...` (study_days)。B の
  // 既知値(distinct_card_count=9 / review_count=5)が A の結果に混ざらないことを検証。
  describe('getReviewStatsForUser', () => {
    // todayInJst(now) = '2026-07-18'(fixture の study_days.day と一致させる)。
    const now = new Date('2026-07-18T12:00:00.000Z')

    it('returns tenant A own known stats (positive control)', async () => {
      const stats = await asTenant(fixture.a.userId, (tx) =>
        getReviewStatsForUser(fixture.a.userId, tx, now),
      )
      expect(stats.todayCardCount).toBe(3)
      expect(stats.streak).toBe(1)
    })

    it('does not mix tenant B known stats into tenant A result (negative)', async () => {
      const stats = await asTenant(fixture.a.userId, (tx) =>
        getReviewStatsForUser(fixture.a.userId, tx, now),
      )
      expect(stats.todayCardCount).not.toBe(9)
    })
  })
})
