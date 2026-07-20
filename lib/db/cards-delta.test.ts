// cards-delta test (S-delete-0 統合 /api/pull 向け)。
// getCardsDelta の DB query 部分を mock して検証。
// - canned 2 行から rows / maxUpdatedAt が正しく返る
// - since 指定時に gte が呼ばれ、未指定時は呼ばれない
// - eq(cards.userId, userId) が必ず呼ばれる (owner-scope)
// - 0 行のとき rows=[] / maxUpdatedAt=null

import { describe, it, expect, vi, beforeEach } from 'vitest'
// RLS-P2: helper は dbc を必須引数で受け取る。mock された getDb() をそのまま dbc
// として渡し、既存 select().from().where() chain mock を通す (mock は @/lib/db)。
import { getDb } from '@/lib/db'

// ── hoisted mocks ─────────────────────────────────────────────────────────────
// vi.hoisted は module 評価より前に実行されるため、外部定数を参照できない。
// canned rows は hoisted 内で定義する。
const { mockRows } = vi.hoisted(() => {
  // cards テーブルの inferSelect に近い最小形。 toClientCard が使う Date 系のみ定義。
  type CardRow = {
    id: string
    userId: string
    examId: string
    sourceDocumentId: string | null
    title: string
    sortKey: string | null
    questionText: string
    options: { id: string; text: string; is_correct: boolean }[]
    correctAnswerIds: string[]
    explanationText: string | null
    memo: string | null
    images: string[]
    answered: boolean
    lastCorrect: boolean | null
    currentStreak: number
    due: Date
    stability: number
    difficulty: number
    elapsedDays: number
    scheduledDays: number
    reps: number
    lapses: number
    state: number
    learningSteps: number
    lastReview: Date | null
    contentVersion: number
    createdAt: Date
    updatedAt: Date
  }
  const cannedRows: CardRow[] = [
    {
      id: 'card-uuid-1',
      userId: 'user-uuid',
      examId: 'exam-uuid-1',
      sourceDocumentId: null,
      title: 'Card 1',
      sortKey: null,
      questionText: 'Q1',
      options: [{ id: 'a', text: 'A', is_correct: true }],
      correctAnswerIds: ['a'],
      explanationText: null,
      memo: null,
      images: [],
      answered: false,
      lastCorrect: null,
      currentStreak: 0,
      due: new Date('2026-05-01T10:00:00.000Z'),
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      learningSteps: 0,
      lastReview: null,
      contentVersion: 0,
      createdAt: new Date('2026-05-01T10:00:01.000Z'),
      updatedAt: new Date('2026-05-01T10:00:01.000Z'),
    },
    {
      id: 'card-uuid-2',
      userId: 'user-uuid',
      examId: 'exam-uuid-1',
      sourceDocumentId: null,
      title: 'Card 2',
      sortKey: null,
      questionText: 'Q2',
      options: [{ id: 'b', text: 'B', is_correct: false }],
      correctAnswerIds: ['a'],
      explanationText: null,
      memo: null,
      images: [],
      answered: true,
      lastCorrect: true,
      currentStreak: 1,
      due: new Date('2026-05-10T12:00:00.000Z'),
      stability: 1,
      difficulty: 0.5,
      elapsedDays: 1,
      scheduledDays: 2,
      reps: 1,
      lapses: 0,
      state: 2,
      learningSteps: 0,
      lastReview: new Date('2026-05-09T12:00:00.000Z'),
      contentVersion: 1,
      createdAt: new Date('2026-05-01T10:00:02.000Z'),
      updatedAt: new Date('2026-05-10T12:00:01.000Z'),
    },
  ]
  return { mockRows: { value: cannedRows as CardRow[] | [] } }
})

// ── canned data (テスト assertions 用定数) ───────────────────────────────────
const CANNED_ROWS = [
  {
    id: 'card-uuid-1',
    userId: 'user-uuid',
    examId: 'exam-uuid-1',
    sourceDocumentId: null,
    title: 'Card 1',
    sortKey: null,
    questionText: 'Q1',
    options: [{ id: 'a', text: 'A', is_correct: true }],
    correctAnswerIds: ['a'],
    explanationText: null,
    memo: null,
    images: [],
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    due: new Date('2026-05-01T10:00:00.000Z'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    contentVersion: 0,
    createdAt: new Date('2026-05-01T10:00:01.000Z'),
    updatedAt: new Date('2026-05-01T10:00:01.000Z'),
  },
  {
    id: 'card-uuid-2',
    userId: 'user-uuid',
    examId: 'exam-uuid-1',
    sourceDocumentId: null,
    title: 'Card 2',
    sortKey: null,
    questionText: 'Q2',
    options: [{ id: 'b', text: 'B', is_correct: false }],
    correctAnswerIds: ['a'],
    explanationText: null,
    memo: null,
    images: [],
    answered: true,
    lastCorrect: true,
    currentStreak: 1,
    due: new Date('2026-05-10T12:00:00.000Z'),
    stability: 1,
    difficulty: 0.5,
    elapsedDays: 1,
    scheduledDays: 2,
    reps: 1,
    lapses: 0,
    state: 2,
    learningSteps: 0,
    lastReview: new Date('2026-05-09T12:00:00.000Z'),
    contentVersion: 1,
    createdAt: new Date('2026-05-01T10:00:02.000Z'),
    updatedAt: new Date('2026-05-10T12:00:01.000Z'),
  },
]

// drizzle-orm: eq と gte をスパイ化し、実動作は real に委譲
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  const spyEq = vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args))
  const spyGte = vi.fn(
    (...args: Parameters<typeof real.gte>) => real.gte(...args),
  )
  return {
    ...real,
    eq: spyEq,
    gte: spyGte,
  }
})

// @/lib/db: getDb を mock し、select().from().where() が mockRows を返す
vi.mock('@/lib/db', () => {
  function makeSelectChain(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    obj['from'] = (_table: unknown) => {
      return {
        where: (_cond: unknown) => Promise.resolve(mockRows.value),
      }
    }
    return obj
  }

  return {
    getDb: () => ({
      select: () => makeSelectChain(),
    }),
  }
})

// ── helpers ───────────────────────────────────────────────────────────────────
async function getSpies() {
  const { eq, gte } = await import('drizzle-orm')
  return { spyEq: vi.mocked(eq), spyGte: vi.mocked(gte) }
}

async function importSubject() {
  return await import('./cards-pull')
}

beforeEach(async () => {
  const { spyEq, spyGte } = await getSpies()
  spyEq.mockClear()
  spyGte.mockClear()
  mockRows.value = CANNED_ROWS
})

// ── tests ─────────────────────────────────────────────────────────────────────
describe('getCardsDelta', () => {
  it('(a) rows が toClientCard 適用済で返る (updated_at が Z 付き ISO、 ClientCard shape)', async () => {
    const { getCardsDelta } = await importSubject()
    const result = await getCardsDelta('user-uuid', getDb())
    expect(result.rows).toHaveLength(2)
    // updated_at が Z 付き UTC ISO 文字列
    expect(result.rows[0].updated_at).toBe('2026-05-01T10:00:01.000Z')
    expect(result.rows[0].updated_at.endsWith('Z')).toBe(true)
    expect(result.rows[1].updated_at).toBe('2026-05-10T12:00:01.000Z')
    // ClientCard shape の主要フィールド
    expect(result.rows[0].id).toBe('card-uuid-1')
    expect(result.rows[0].user_id).toBe('user-uuid')
    expect(result.rows[0].sync_status).toBe('synced')
    expect(result.rows[1].id).toBe('card-uuid-2')
    expect(result.rows[1].last_review).toBe('2026-05-09T12:00:00.000Z')
  })

  it('(b) maxUpdatedAt = 2 行のうち新しい updated_at の ISO', async () => {
    const { getCardsDelta } = await importSubject()
    const result = await getCardsDelta('user-uuid', getDb())
    expect(result.maxUpdatedAt).toBe('2026-05-10T12:00:01.000Z')
  })

  it('(c) since 指定時に gte(cards.updatedAt, since) が呼ばれる', async () => {
    const { getCardsDelta } = await importSubject()
    const { spyGte } = await getSpies()
    const since = new Date('2026-05-05T00:00:00.000Z')
    await getCardsDelta('user-uuid', getDb(), since)
    expect(spyGte).toHaveBeenCalled()
    const call = spyGte.mock.calls[0]
    // 第2引数が since と同一 Date
    expect(call[1]).toEqual(since)
  })

  it('(c) since 未指定時は gte が呼ばれない', async () => {
    const { getCardsDelta } = await importSubject()
    const { spyGte } = await getSpies()
    await getCardsDelta('user-uuid', getDb())
    expect(spyGte).not.toHaveBeenCalled()
  })

  it('(d) eq(cards.userId, userId) が必ず呼ばれる (owner-scope)', async () => {
    const { getCardsDelta } = await importSubject()
    const { spyEq } = await getSpies()
    const { cards } = await import('./schema')
    await getCardsDelta('user-uuid', getDb())
    expect(vi.mocked(spyEq)).toHaveBeenCalledWith(cards.userId, 'user-uuid')
  })

  it('(e) 0 行のとき rows=[] / maxUpdatedAt=null', async () => {
    mockRows.value = []
    const { getCardsDelta } = await importSubject()
    const result = await getCardsDelta('user-uuid', getDb())
    expect(result.rows).toEqual([])
    expect(result.maxUpdatedAt).toBeNull()
  })
})
