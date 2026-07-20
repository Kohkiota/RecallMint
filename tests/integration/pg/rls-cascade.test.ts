// RLS-P2 Task 9 — item (5): FK cascade は RLS 非適用 (spec §3.1-6)。
//
// app-role の deleteExam(A の exam) は内部で withTenantTx (context=A) を張る。
// exams DELETE の FK CASCADE は system 駆動ゆえ RLS policy に縛られず、A に連なる
// 子行 (cards / source_documents / reviews / card_tags / answer_events) を全表
// 横断で完走する。同時に B の decoy は 1 行も減らない (cascade が越境しない)。
//
// delete-isolation.test.ts (W2) は deleteExam の exam+card 越境を pin 済。本 file は
// 「cascade の多表横断完走 + B 件数不変」に絞る (cross-ref: delete-isolation.test.ts)。
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/lib/db'
import {
  answerEvents,
  cardTags,
  cards,
  exams,
  reviews,
  sourceDocuments,
  type User,
} from '@/lib/db/schema'

import {
  type TenantFixture,
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

const { mockGetCurrentUser } = vi.hoisted(() => ({ mockGetCurrentUser: vi.fn() }))
vi.mock('@/lib/auth/ensure-user', () => ({ getCurrentUser: mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { deleteExam } from '@/app/(app)/app/exams/_actions/delete-exam'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

describe('RLS FK cascade (deleteExam) completes across tables; B untouched', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
    mockGetCurrentUser.mockReset()
  })

  it('cascades A exam → its cards/source_docs/reviews/card_tags/answer_events; B counts unchanged', async () => {
    const owner = getFixtureOwnerDb()
    const countFor = async (
      table: typeof cards | typeof sourceDocuments | typeof reviews | typeof cardTags | typeof answerEvents | typeof exams,
      userId: string,
    ) =>
      (await owner.select({ userId: table.userId }).from(table).where(eq(table.userId, userId)))
        .length

    // pre: A/B とも各表に ≥1 行 (fixture)。B の件数を控える。
    const bBefore = {
      exams: await countFor(exams, fixture.b.userId),
      cards: await countFor(cards, fixture.b.userId),
      sourceDocuments: await countFor(sourceDocuments, fixture.b.userId),
      reviews: await countFor(reviews, fixture.b.userId),
      cardTags: await countFor(cardTags, fixture.b.userId),
      answerEvents: await countFor(answerEvents, fixture.b.userId),
    }
    expect(bBefore.cards).toBeGreaterThan(0)
    expect(await countFor(cards, fixture.a.userId)).toBeGreaterThan(0)

    // act: A の exam を削除 (deleteExam 内部で context=A を張る)。
    mockGetCurrentUser.mockResolvedValue({ id: fixture.a.userId } as User)
    const result = await deleteExam(fixture.a.examId)
    expect(result.ok).toBe(true)

    // A の子行が全表で cascade 完走 (0 行)。
    expect(await countFor(exams, fixture.a.userId)).toBe(0)
    expect(await countFor(cards, fixture.a.userId)).toBe(0)
    expect(await countFor(sourceDocuments, fixture.a.userId)).toBe(0)
    expect(await countFor(reviews, fixture.a.userId)).toBe(0)
    expect(await countFor(cardTags, fixture.a.userId)).toBe(0)
    expect(await countFor(answerEvents, fixture.a.userId)).toBe(0)

    // B は 1 行も減らない (cascade が越境しない = RLS 非適用でも owner-scope 保持)。
    expect(await countFor(exams, fixture.b.userId)).toBe(bBefore.exams)
    expect(await countFor(cards, fixture.b.userId)).toBe(bBefore.cards)
    expect(await countFor(sourceDocuments, fixture.b.userId)).toBe(bBefore.sourceDocuments)
    expect(await countFor(reviews, fixture.b.userId)).toBe(bBefore.reviews)
    expect(await countFor(cardTags, fixture.b.userId)).toBe(bBefore.cardTags)
    expect(await countFor(answerEvents, fixture.b.userId)).toBe(bBefore.answerEvents)
  })
})
