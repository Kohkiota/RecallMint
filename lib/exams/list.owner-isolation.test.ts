// S1.7 review Important 3 を受けて新規。 lib/exams/list.ts の owner-check 回帰
// 防止 test。
//
// 2 層構成 (監査 2026-07-17 G2 対応):
// - chain mock (下記): row mapping / null・防御経路の挙動検証。 where() 引数は
//   検証できない (eq(userId) を除去しても通過することを変異実測で確認済 —
//   docs/audit/2026-07-17-test-quality-audit.md)。
// - eq-spy (末尾 describe): drizzle の eq を spy 化し、 各 query が owner 列で
//   絞ることを実引数で pin する。 前例 = lib/db/cards-delta.test.ts の (d)。
//
// 既存 list.test.ts は formatRelativeJa の純粋関数 test 専用、 owner-check は
// SQL レイヤなので別 file で mock chain を構築する。

import { describe, it, expect, vi, beforeEach } from 'vitest'
// RLS-P2: list.ts の 5 query は dbc を必須末尾引数で受け取る。mock された getDb()
// を dbc として渡し、既存 chain mock を通す (mock は @/lib/db)。
import { getDb } from '@/lib/db'

type SelectedRow = Record<string, unknown>

const { dbState } = vi.hoisted(() => ({
  dbState: {
    // 各 caller (getActiveExamsWithCardCount / getExamByIdForUser /
    // getCardsForExam) が select.from.where (.leftJoin.groupBy.orderBy etc)
    // で取り出す row を、 caller ごとに切り替える queue。
    queue: [] as SelectedRow[][],
  },
}))

// drizzle-orm: eq を spy 化し実動作は real に委譲 (owner-scope 実引数 pin 用)。
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  const spyEq = vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args))
  return { ...real, eq: spyEq }
})

async function getEqSpy() {
  const { eq } = await import('drizzle-orm')
  return vi.mocked(eq)
}

// schema は静的 import しない: mock 適用後の動的 import 経路 (list.ts 側) と
// module インスタンスを一致させ、 column 参照の同一性で assert するため
// (前例: lib/db/cards-delta.test.ts)。
async function getSchema() {
  return await import('@/lib/db/schema')
}

vi.mock('@/lib/db', () => {
  // chain proxy: 各 method は self を返し、 最終的に await されると queue の先頭を resolve
  function chain() {
    const obj: Record<string, unknown> = {}
    const passthrough = [
      'from',
      'where',
      'leftJoin',
      'innerJoin',
      'groupBy',
      'orderBy',
      'limit',
    ]
    for (const m of passthrough) obj[m] = () => obj
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      const next = dbState.queue.shift() ?? []
      return Promise.resolve(next).then(onFulfilled, onRejected)
    }
    return obj
  }
  return {
    getDb: () => ({
      select: () => chain(),
    }),
  }
})

async function importModule() {
  return await import('./list')
}

beforeEach(async () => {
  dbState.queue = []
  ;(await getEqSpy()).mockClear()
})

// getActiveExamsWithCardCount は ExamListLive (Dexie useLiveQuery) への切替により撤去済。
// 旧 test は同時に撤去 (dead code に対応)。

describe('getExamByIdForUser (owner isolation)', () => {
  it('returns null when row not found (other user / unknown exam)', async () => {
    dbState.queue = [[]]
    const { getExamByIdForUser } = await importModule()
    const r = await getExamByIdForUser('user-1', 'exam-unknown', getDb())
    expect(r).toBeNull()
  })

  it('returns exam detail with archived_at when found (own exam)', async () => {
    const now = new Date('2026-05-19T05:00:00Z')
    dbState.queue = [
      [
        {
          id: 'exam-A',
          name: 'My Exam',
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        },
      ],
    ]
    const { getExamByIdForUser } = await importModule()
    const r = await getExamByIdForUser('user-1', 'exam-A', getDb())
    expect(r).toEqual({
      id: 'exam-A',
      name: 'My Exam',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })
  })

  it('returns exam with archivedAt populated for archived exam', async () => {
    const created = new Date('2026-05-10T05:00:00Z')
    const archived = new Date('2026-05-18T05:00:00Z')
    dbState.queue = [
      [
        {
          id: 'exam-A',
          name: 'Archived Exam',
          createdAt: created,
          updatedAt: created,
          archivedAt: archived,
        },
      ],
    ]
    const { getExamByIdForUser } = await importModule()
    const r = await getExamByIdForUser('user-1', 'exam-A', getDb())
    expect(r?.archivedAt).toEqual(archived)
  })
})

describe('getCardsForExam (owner isolation + full detail mapping)', () => {
  it('returns empty array when no rows (other user exam or empty exam)', async () => {
    dbState.queue = [[]]
    const { getCardsForExam } = await importModule()
    const r = await getCardsForExam('user-1', 'exam-A', getDb())
    expect(r).toEqual([])
  })

  it('maps rows into full ExamDetailCard (question 全文 / options / explanation)', async () => {
    const options = [
      { id: 'a', text: '選択肢A', is_correct: true, explanation: 'A の解説' },
      { id: 'b', text: '選択肢B', is_correct: false },
    ]
    dbState.queue = [
      [
        {
          id: 'card-1',
          title: '問1',
          sortKey: '001',
          questionText: 'a'.repeat(120),
          options,
          explanationText: 'カード全体の解説',
          memo: 'マイメモ',
          images: [{ key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target: 'question_text', alt: '' }],
        },
      ],
    ]
    const { getCardsForExam } = await importModule()
    const r = await getCardsForExam('user-1', 'exam-A', getDb())
    expect(r).toHaveLength(1)
    // snippet 化せず問題文全文・全選択肢・card 解説・memo・images をそのまま返す
    expect(r[0]).toEqual({
      id: 'card-1',
      title: '問1',
      sortKey: '001',
      questionText: 'a'.repeat(120),
      options,
      explanationText: 'カード全体の解説',
      memo: 'マイメモ',
      images: [{ key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target: 'question_text', alt: '' }],
    })
  })

  it('images が非配列(欠損)行は空配列にフォールバックする(options と同じ防御パターン)', async () => {
    dbState.queue = [
      [
        {
          id: 'card-2',
          title: '問2',
          sortKey: null,
          questionText: '問題文2',
          options: [],
          explanationText: null,
          memo: null,
          images: null,
        },
      ],
    ]
    const { getCardsForExam } = await importModule()
    const r = await getCardsForExam('user-1', 'exam-A', getDb())
    expect(r[0]?.images).toEqual([])
  })

  it('handles null sortKey + non-array options + null explanation + null memo defensively', async () => {
    dbState.queue = [
      [
        {
          id: 'card-1',
          title: '問1',
          sortKey: null,
          questionText: 'short',
          options: null, // DB schema 上 NOT NULL だが防御コード経路の確認
          explanationText: null,
          memo: null,
        },
      ],
    ]
    const { getCardsForExam } = await importModule()
    const r = await getCardsForExam('user-1', 'exam-A', getDb())
    expect(r[0].sortKey).toBeNull()
    expect(r[0].options).toEqual([])
    expect(r[0].explanationText).toBeNull()
    expect(r[0].memo).toBeNull()
    expect(r[0].questionText).toBe('short')
  })
})

// S1.9.2: result page 用の新規 query 2 本。 owner-check 回帰防止。
describe('getSourceDocumentForUser (owner isolation)', () => {
  it('returns null when row not found (other user / unknown / discarded)', async () => {
    dbState.queue = [[]]
    const { getSourceDocumentForUser } = await importModule()
    const r = await getSourceDocumentForUser('user-1', 'sdoc-unknown', getDb())
    expect(r).toBeNull()
  })

  it('returns { id, examName } when found (own source_document)', async () => {
    dbState.queue = [[{ id: 'sdoc-A', examName: 'My Exam' }]]
    const { getSourceDocumentForUser } = await importModule()
    const r = await getSourceDocumentForUser('user-1', 'sdoc-A', getDb())
    expect(r).toEqual({ id: 'sdoc-A', examName: 'My Exam' })
  })
})

describe('getCardsForSourceDocument (owner isolation + snippet/keys derivation)', () => {
  it('returns empty array when no rows (other user / discarded source_document)', async () => {
    dbState.queue = [[]]
    const { getCardsForSourceDocument } = await importModule()
    const r = await getCardsForSourceDocument('user-1', 'sdoc-A', getDb())
    expect(r).toEqual([])
  })

  it('maps rows into list entries with snippet + option count + custom_props keys', async () => {
    dbState.queue = [
      [
        {
          id: 'card-1',
          title: '問1',
          sortKey: '001',
          questionText: 'a'.repeat(120),
          options: [
            { id: 'a', text: 'A', is_correct: true },
            { id: 'b', text: 'B', is_correct: false },
          ],
          createdAt: new Date(),
        },
      ],
    ]
    const { getCardsForSourceDocument } = await importModule()
    const r = await getCardsForSourceDocument('user-1', 'sdoc-A', getDb())
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      id: 'card-1',
      title: '問1',
      sortKey: '001',
      optionCount: 2,
    })
    expect(r[0].questionTextSnippet.endsWith('…')).toBe(true)
  })
})

// 監査 2026-07-17 G2: chain mock は where() 引数を握り潰すため、owner 絞りの
// 実在は eq の実引数で pin する。全 5 query が対象 (list.ts の owner-scoped 面)。
describe('owner-scope WHERE 検証 (eq-spy)', () => {
  it('getActiveExamsForUser: eq(exams.userId, userId) が呼ばれる', async () => {
    dbState.queue = [[]]
    const { getActiveExamsForUser } = await importModule()
    await getActiveExamsForUser('user-1', getDb())
    const { exams } = await getSchema()
    expect(await getEqSpy()).toHaveBeenCalledWith(exams.userId, 'user-1')
  })

  it('getExamByIdForUser: eq(exams.userId, userId) と eq(exams.id, examId) が呼ばれる', async () => {
    dbState.queue = [[]]
    const { getExamByIdForUser } = await importModule()
    await getExamByIdForUser('user-1', 'exam-A', getDb())
    const { exams } = await getSchema()
    const spy = await getEqSpy()
    expect(spy).toHaveBeenCalledWith(exams.userId, 'user-1')
    expect(spy).toHaveBeenCalledWith(exams.id, 'exam-A')
  })

  it('getCardsForExam: eq(cards.userId, userId) と eq(cards.examId, examId) が呼ばれる', async () => {
    dbState.queue = [[]]
    const { getCardsForExam } = await importModule()
    await getCardsForExam('user-1', 'exam-A', getDb())
    const { cards } = await getSchema()
    const spy = await getEqSpy()
    expect(spy).toHaveBeenCalledWith(cards.userId, 'user-1')
    expect(spy).toHaveBeenCalledWith(cards.examId, 'exam-A')
  })

  it('getSourceDocumentForUser: eq(sourceDocuments.userId, userId) と eq(sourceDocuments.id, id) が呼ばれる', async () => {
    dbState.queue = [[]]
    const { getSourceDocumentForUser } = await importModule()
    await getSourceDocumentForUser('user-1', 'sdoc-A', getDb())
    const { sourceDocuments } = await getSchema()
    const spy = await getEqSpy()
    expect(spy).toHaveBeenCalledWith(sourceDocuments.userId, 'user-1')
    expect(spy).toHaveBeenCalledWith(sourceDocuments.id, 'sdoc-A')
  })

  it('getCardsForSourceDocument: eq(cards.userId, userId) と eq(cards.sourceDocumentId, id) が呼ばれる', async () => {
    dbState.queue = [[]]
    const { getCardsForSourceDocument } = await importModule()
    await getCardsForSourceDocument('user-1', 'sdoc-A', getDb())
    const { cards } = await getSchema()
    const spy = await getEqSpy()
    expect(spy).toHaveBeenCalledWith(cards.userId, 'user-1')
    expect(spy).toHaveBeenCalledWith(cards.sourceDocumentId, 'sdoc-A')
  })
})
