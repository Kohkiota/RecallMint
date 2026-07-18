// W2: delete 越境 隔離 assertion。owner-scoped DELETE が「A の文脈で B の
// card/exam を削除できない」(negative: B の行が残る)かつ「A 自身の card/exam
// は削除できる」(positive control)ことを実 PG で検証する。
//
// この repo の delete は defense-in-depth: owner-scoped SELECT gate(0 行なら
// early return)+ owner-scoped DELETE の二重 owner check。ゆえに単一
// predicate 除去では越境しない(片方が守る)。詳細な RED 実測(単一除去=守られる
// / 両方除去=越境する)はこの test file には含めず(commit しない一時改変のため)、
// タスク report に記録する。
//
// 代表 RED = applyCardDelete(lib/cards/apply-card-mutation.ts。
// `(tx: DbExecutor, cardId, userId) => Promise<void>`。arg-passing・auth mock
// 不要)。owner check 2 箇所:
//   - SELECT gate(~:140)`and(eq(cards.id, cardId), eq(cards.userId, userId))`
//     — 0 行で early return。
//   - DELETE(~:164)`and(eq(cards.id, cardId), eq(cards.userId, userId))`。
//
// 追加 behavioral(非 RED)= deleteExam
// (app/(app)/app/exams/_actions/delete-exam.ts)。getCurrentUser() を内部で
// 呼ぶため userId 切替に auth seam mock(@/lib/auth/ensure-user)が必要。
// next/cache の revalidatePath も node test env で実行すると throw するため
// mock する(request scope 外)。三段(owner SELECT / child 列挙 /
// DELETE cascade)。
//
// mutating test ゆえ beforeEach で truncate→seed(write-isolation.test.ts と
// 同方針)。@/lib/db は mock しない(実 PG に対して実行する)。
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import { cards, exams, tombstones, type User } from '@/lib/db/schema'
import { applyCardDelete } from '@/lib/cards/apply-card-mutation'

import {
  type TenantFixture,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

const { mockGetCurrentUser } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

// deleteExam は 'use server' file。auth mock を hoist 済のため top-level import
// で問題ない(vi.mock は import より前に hoist される)。
import { deleteExam } from '@/app/(app)/app/exams/_actions/delete-exam'

afterAll(async () => {
  await closeDb()
})

describe('delete isolation (W2)', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
    mockGetCurrentUser.mockReset()
  })

  // --- 代表 RED: applyCardDelete の owner check(SELECT gate + DELETE)を
  // 両方外すと B の card が A の userId 呼び出しで実削除される(defense-in-depth
  // ゆえ片方だけの除去では越境しない — 因果は report に実測記録)。
  describe('applyCardDelete', () => {
    it('deletes tenant A own card (positive control)', async () => {
      await applyCardDelete(getDb(), fixture.a.cardId, fixture.a.userId)

      const rows = await getDb()
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      expect(rows).toHaveLength(0)

      // tombstone が A の userId で INSERT されている(mirror 削除反映の不変条件)。
      const tombstoneRows = await getDb()
        .select({ userId: tombstones.userId, entityType: tombstones.entityType })
        .from(tombstones)
        .where(
          and(
            eq(tombstones.entityId, fixture.a.cardId),
            eq(tombstones.entityType, 'card'),
          ),
        )
      expect(tombstoneRows).toHaveLength(1)
      expect(tombstoneRows[0]?.userId).toBe(fixture.a.userId)
    })

    it('does not delete tenant B card via tenant A context (negative)', async () => {
      await applyCardDelete(getDb(), fixture.b.cardId, fixture.a.userId)

      // 戻り値が無い(void)ため実 DB の行状態のみで判定する(vacuous 回避)。
      const rows = await getDb()
        .select({ id: cards.id, title: cards.title })
        .from(cards)
        .where(eq(cards.id, fixture.b.cardId))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.title).toBe('Card B')
    })
  })

  // --- 非 RED・behavioral: deleteExam は getCurrentUser() から userId を得る
  // ため、mock の返す user.id を切り替えて WHERE user_id が実際にその値を
  // 駆動していることを実証する(switch 実証)。
  describe('deleteExam', () => {
    it('does not delete tenant B exam (+ its cards) via tenant A context (negative)', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: fixture.a.userId } as User)

      const result = await deleteExam(fixture.b.examId)
      // owner SELECT gate が 0 行 → idempotent silent success(実削除なし)。
      expect(result.ok).toBe(true)

      const examRows = await getDb()
        .select({ id: exams.id })
        .from(exams)
        .where(eq(exams.id, fixture.b.examId))
      expect(examRows).toHaveLength(1)

      const cardRows = await getDb()
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.id, fixture.b.cardId))
      expect(cardRows).toHaveLength(1)
    })

    it('deletes tenant A own exam, cascading to its cards (positive control)', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: fixture.a.userId } as User)

      const result = await deleteExam(fixture.a.examId)
      expect(result.ok).toBe(true)

      const examRows = await getDb()
        .select({ id: exams.id })
        .from(exams)
        .where(eq(exams.id, fixture.a.examId))
      expect(examRows).toHaveLength(0)

      // exams DELETE → FK CASCADE(onDelete: 'cascade')で配下 card も消える。
      const cardRows = await getDb()
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      expect(cardRows).toHaveLength(0)
    })

    it('switch: same examId(B) succeeds once mock user is B — proves mock userId drives WHERE', async () => {
      // 直前と同じ b.examId が、mock user を A→B に切り替えるだけで削除可能に
      // なることを示す。A context では上の negative test が「残る」ことを示して
      // おり、本 test は同一 examId・同一呼び出し形で B context なら「消える」
      // ことを示すことで、userId が固定値でなく auth seam の返す user.id に
      // 連動していることを実証する。
      mockGetCurrentUser.mockResolvedValue({ id: fixture.b.userId } as User)

      const result = await deleteExam(fixture.b.examId)
      expect(result.ok).toBe(true)

      const examRows = await getDb()
        .select({ id: exams.id })
        .from(exams)
        .where(eq(exams.id, fixture.b.examId))
      expect(examRows).toHaveLength(0)
    })
  })
})
