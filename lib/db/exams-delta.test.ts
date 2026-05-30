// exams-delta test (S-delete-0 統合 /api/pull 向け)。
// getExamsDelta の DB query 部分を mock して検証。
// - canned 2 行から rows / maxUpdatedAt が正しく返る
// - since 指定時に gte が呼ばれ、未指定時は呼ばれない
// - eq(exams.userId, userId) が必ず呼ばれる (owner-scope)
// - 0 行のとき rows=[] / maxUpdatedAt=null

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── hoisted mocks ─────────────────────────────────────────────────────────────
// vi.hoisted は module 評価より前に実行されるため、外部定数を参照できない。
// canned rows は hoisted 内で定義する。
const { mockRows } = vi.hoisted(() => {
  // exams テーブルの inferSelect に近い最小形。 toClientExam が使う Date 系のみ定義。
  type ExamRow = {
    id: string
    userId: string
    name: string
    questionNoFormat: string | null
    archivedAt: Date | null
    cardCount: number
    contentVersion: number
    createdAt: Date
    updatedAt: Date
  }
  const cannedRows: ExamRow[] = [
    {
      id: 'exam-uuid-1',
      userId: 'user-uuid',
      name: 'Exam One',
      questionNoFormat: null,
      archivedAt: null,
      cardCount: 3,
      contentVersion: 1,
      createdAt: new Date('2026-05-01T10:00:00.000Z'),
      updatedAt: new Date('2026-05-01T10:00:01.000Z'),
    },
    {
      id: 'exam-uuid-2',
      userId: 'user-uuid',
      name: 'Exam Two',
      questionNoFormat: 'numeric',
      archivedAt: null,
      cardCount: 5,
      contentVersion: 2,
      createdAt: new Date('2026-05-01T10:00:02.000Z'),
      updatedAt: new Date('2026-05-10T12:00:01.000Z'),
    },
  ]
  return { mockRows: { value: cannedRows as ExamRow[] | [] } }
})

// ── canned data (テスト assertions 用定数) ───────────────────────────────────
const CANNED_ROWS = [
  {
    id: 'exam-uuid-1',
    userId: 'user-uuid',
    name: 'Exam One',
    questionNoFormat: null,
    archivedAt: null,
    cardCount: 3,
    contentVersion: 1,
    createdAt: new Date('2026-05-01T10:00:00.000Z'),
    updatedAt: new Date('2026-05-01T10:00:01.000Z'),
  },
  {
    id: 'exam-uuid-2',
    userId: 'user-uuid',
    name: 'Exam Two',
    questionNoFormat: 'numeric',
    archivedAt: null,
    cardCount: 5,
    contentVersion: 2,
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
  return await import('./exams-pull')
}

beforeEach(async () => {
  const { spyEq, spyGte } = await getSpies()
  spyEq.mockClear()
  spyGte.mockClear()
  mockRows.value = CANNED_ROWS
})

// ── tests ─────────────────────────────────────────────────────────────────────
describe('getExamsDelta', () => {
  it('(a) rows が toClientExam 適用済で返る (updated_at が Z 付き ISO、 ClientExam shape)', async () => {
    const { getExamsDelta } = await importSubject()
    const result = await getExamsDelta('user-uuid')
    expect(result.rows).toHaveLength(2)
    // updated_at が Z 付き UTC ISO 文字列
    expect(result.rows[0].updated_at).toBe('2026-05-01T10:00:01.000Z')
    expect(result.rows[0].updated_at.endsWith('Z')).toBe(true)
    expect(result.rows[1].updated_at).toBe('2026-05-10T12:00:01.000Z')
    // ClientExam shape の主要フィールド
    expect(result.rows[0].id).toBe('exam-uuid-1')
    expect(result.rows[0].user_id).toBe('user-uuid')
    expect(result.rows[0].name).toBe('Exam One')
    expect(result.rows[0].card_count).toBe(3)
    expect(result.rows[1].id).toBe('exam-uuid-2')
    expect(result.rows[1].question_no_format).toBe('numeric')
  })

  it('(b) maxUpdatedAt = 2 行のうち新しい updated_at の ISO', async () => {
    const { getExamsDelta } = await importSubject()
    const result = await getExamsDelta('user-uuid')
    expect(result.maxUpdatedAt).toBe('2026-05-10T12:00:01.000Z')
  })

  it('(c) since 指定時に gte(exams.updatedAt, since) が呼ばれる', async () => {
    const { getExamsDelta } = await importSubject()
    const { spyGte } = await getSpies()
    const since = new Date('2026-05-05T00:00:00.000Z')
    await getExamsDelta('user-uuid', since)
    expect(spyGte).toHaveBeenCalled()
    const call = spyGte.mock.calls[0]
    // 第2引数が since と同一 Date
    expect(call[1]).toEqual(since)
  })

  it('(c) since 未指定時は gte が呼ばれない', async () => {
    const { getExamsDelta } = await importSubject()
    const { spyGte } = await getSpies()
    await getExamsDelta('user-uuid')
    expect(spyGte).not.toHaveBeenCalled()
  })

  it('(d) eq(exams.userId, userId) が必ず呼ばれる (owner-scope)', async () => {
    const { getExamsDelta } = await importSubject()
    const { spyEq } = await getSpies()
    const { exams } = await import('./schema')
    await getExamsDelta('user-uuid')
    expect(vi.mocked(spyEq)).toHaveBeenCalledWith(exams.userId, 'user-uuid')
  })

  it('(e) 0 行のとき rows=[] / maxUpdatedAt=null', async () => {
    mockRows.value = []
    const { getExamsDelta } = await importSubject()
    const result = await getExamsDelta('user-uuid')
    expect(result.rows).toEqual([])
    expect(result.maxUpdatedAt).toBeNull()
  })
})
