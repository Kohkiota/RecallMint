// H2: 2 テナント(A/B)fixture。real getDb() で users 2 行 + user_id 保持 19 table
// すべてに A・B 双方 ≥1 行を FK 依存順で INSERT する。B の行は後続 隔離 assertion
// (R1/R2/W1/W2)の「餌(decoy)」であり、WHERE user_id が消えたら B が混ざる状況を
// 作るための土台。よって各 table で A と同種・同 shape(active/非 archived)にする。
import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'

import { getDb } from '@/lib/db'
import {
  aiUsageUsers,
  answerEvents,
  assets,
  cardAssetRefs,
  cardTags,
  cards,
  contactMessages,
  entityMutations,
  exams,
  integrationFailures,
  reviews,
  sourceDocuments,
  studyDays,
  studySessions,
  tagCategories,
  tagOptions,
  tombstones,
  uploadRecords,
  userSettings,
  users,
} from '@/lib/db/schema'

import { EXPECTED_USER_ID_TABLES } from './completeness'

export type TenantIds = {
  userId: string
  examId: string
  cardId: string
  sourceDocumentId: string
  tagCategoryId: string
  tagOptionId: string
  studySessionId: string
  assetId: string
}

export type TenantFixture = { a: TenantIds; b: TenantIds }

// truncate 対象 = users(tenant 本体) + 19 user_id table。CASCADE で FK 子も掃くが、
// downstream の per-test beforeEach が truncate→reseed で使うため全 table を明示列挙する。
// 19 の list は completeness.ts の SSoT を再利用(重複 list の drift を防ぐ — この file の
// 目的そのもの)。TRUNCATE は列挙順に依存しない(CASCADE で全掃)。
const ALL_TABLES = ['users', ...EXPECTED_USER_ID_TABLES] as const

// 1 テナント分を FK 依存順で seed し、downstream が使う主要 id を返す。A/B で
// 完全に別 UUID になるよう全 id を randomUUID() で採番する。
async function seedTenant(
  db: ReturnType<typeof getDb>,
  label: string,
): Promise<TenantIds> {
  const userId = randomUUID()
  const examId = randomUUID()
  const cardId = randomUUID()
  const sourceDocumentId = randomUUID()
  const tagCategoryId = randomUUID()
  const tagOptionId = randomUUID()
  const studySessionId = randomUUID()
  const assetId = randomUUID()
  const day = '2026-07-18'
  const now = new Date('2026-07-18T00:00:00.000Z')

  // --- tier0: users(tenant 本体)---
  await db
    .insert(users)
    .values({ id: userId, clerkId: `clerk_${label}_${userId}` })

  // --- tier1: users のみ参照 ---
  await db.insert(exams).values({ id: examId, userId, name: `Exam ${label}` })
  await db
    .insert(tagCategories)
    .values({ id: tagCategoryId, userId, name: `Cat ${label}`, selectType: 'single' })
  await db.insert(userSettings).values({ userId })
  await db
    .insert(contactMessages)
    .values({ userId, email: `${label}@example.test`, subject: 'S', body: 'B' })
  await db.insert(studySessions).values({
    sessionId: studySessionId,
    userId,
    mode: 'smart',
    startedAt: now,
  })
  await db.insert(aiUsageUsers).values({ userId, date: day, count: 1 })
  await db.insert(assets).values({
    id: assetId,
    userId,
    objectKey: `users/${userId}/${assetId}.webp`,
    mime: 'image/webp',
    byteSize: 100,
    width: 10,
    height: 10,
    hash: `hash_${assetId}`,
  })
  await db.insert(integrationFailures).values({
    userId,
    service: 'stripe',
    operation: 'seed',
    failureCode: 'seed_decoy',
    context: {},
  })
  await db.insert(studyDays).values({ userId, day })
  await db.insert(tombstones).values({
    userId,
    entityType: 'card',
    entityId: randomUUID(),
    deletedAt: now,
  })
  await db.insert(entityMutations).values({
    mutationId: randomUUID(),
    entityType: 'card',
    entityId: randomUUID(),
    userId,
    op: 'update_field',
    patch: {},
    editedAt: now,
  })
  await db.insert(uploadRecords).values({
    userId,
    filename: 'src.pdf',
    fileSizeBytes: 100,
    status: 'completed',
  })

  // --- tier2: tier1 を参照 ---
  await db.insert(sourceDocuments).values({
    id: sourceDocumentId,
    userId,
    examId,
    mode: 'new',
    fileType: 'pdf',
    filename: 'src.pdf',
    fileSizeBytes: 100,
  })
  await db.insert(cards).values({
    id: cardId,
    userId,
    examId,
    sourceDocumentId,
    title: `Card ${label}`,
    questionText: 'Q?',
    options: [
      { id: 'a', uid: randomUUID(), text: 'opt a', is_correct: true },
      { id: 'b', uid: randomUUID(), text: 'opt b', is_correct: false },
    ],
    correctAnswerIds: ['a'],
  })
  await db
    .insert(tagOptions)
    .values({ id: tagOptionId, userId, categoryId: tagCategoryId, name: 'Option' })

  // --- tier3: tier2 を参照 ---
  await db.insert(cardTags).values({ cardId, optionId: tagOptionId, userId })
  await db.insert(reviews).values({ userId, cardId, rating: 3 })
  await db.insert(answerEvents).values({
    eventId: randomUUID(),
    sessionId: studySessionId,
    cardId,
    userId,
    isCorrect: true,
    answeredAt: now,
  })
  await db.insert(cardAssetRefs).values({
    cardId,
    assetId,
    userId,
    fieldKey: 'question',
    ordinal: 0,
  })

  return {
    userId,
    examId,
    cardId,
    sourceDocumentId,
    tagCategoryId,
    tagOptionId,
    studySessionId,
    assetId,
  }
}

// A/B 2 テナントを seed する。呼び出し側は事前に truncateAllUserTables() で
// clean state を作る前提(FK 制約と決定的 assertion のため)。
export async function seedTwoTenants(): Promise<TenantFixture> {
  const db = getDb()
  const a = await seedTenant(db, 'A')
  const b = await seedTenant(db, 'B')
  return { a, b }
}

// 19 user_id table + users を単文 TRUNCATE で全消し(RESTART IDENTITY CASCADE)。
// downstream の per-test beforeEach で truncate→reseed に使う。
export async function truncateAllUserTables(): Promise<void> {
  const db = getDb()
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`),
  )
}
