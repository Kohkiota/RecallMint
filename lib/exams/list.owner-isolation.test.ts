// S1.7 review Important 3 を受けて新規。 lib/exams/list.ts の owner-check 回帰
// 防止 test。 mock DB chain を使い、 WHERE 句が user_id で正しく絞っているか
// (= 他 user の exam / cards が漏れないか) を検証する。
//
// 既存 list.test.ts は formatRelativeJa の純粋関数 test 専用、 owner-check は
// SQL レイヤなので別 file で mock chain を構築する。

import { describe, it, expect, vi, beforeEach } from 'vitest'

type SelectedRow = Record<string, unknown>

const { dbState } = vi.hoisted(() => ({
  dbState: {
    // 各 caller (getActiveExamsWithCardCount / getExamByIdForUser /
    // getCardsForExam) が select.from.where (.leftJoin.groupBy.orderBy etc)
    // で取り出す row を、 caller ごとに切り替える queue。
    queue: [] as SelectedRow[][],
  },
}))

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

beforeEach(() => {
  dbState.queue = []
})

describe('getActiveExamsWithCardCount (owner isolation)', () => {
  it('returns empty array when no rows (other user / no exams)', async () => {
    dbState.queue = [[]]
    const { getActiveExamsWithCardCount } = await importModule()
    const r = await getActiveExamsWithCardCount('user-1')
    expect(r).toEqual([])
  })

  it('returns rows as-is (DB enforces WHERE userId)', async () => {
    const now = new Date('2026-05-19T05:00:00Z')
    dbState.queue = [
      [
        { id: 'exam-A', name: 'Exam A', updatedAt: now, cardCount: 5 },
        { id: 'exam-B', name: 'Exam B', updatedAt: now, cardCount: 0 },
      ],
    ]
    const { getActiveExamsWithCardCount } = await importModule()
    const r = await getActiveExamsWithCardCount('user-1')
    expect(r).toEqual([
      { id: 'exam-A', name: 'Exam A', updatedAt: now, cardCount: 5 },
      { id: 'exam-B', name: 'Exam B', updatedAt: now, cardCount: 0 },
    ])
  })

  // B1 (S2.0c): cards への JOIN+GROUP BY 集計をやめ、 非正規化列
  // exams.card_count (integer) を直読するようになった。 count() 集約由来の
  // bigint 文字列を coerce する必要はなくなり、 列値をそのまま返す。
  it('card_count 列を number としてそのまま返す (非正規化列を直読)', async () => {
    const now = new Date()
    dbState.queue = [[{ id: 'x', name: 'X', updatedAt: now, cardCount: 42 }]]
    const { getActiveExamsWithCardCount } = await importModule()
    const r = await getActiveExamsWithCardCount('user-1')
    expect(r[0].cardCount).toBe(42)
    expect(typeof r[0].cardCount).toBe('number')
  })
})

describe('getExamByIdForUser (owner isolation)', () => {
  it('returns null when row not found (other user / unknown exam)', async () => {
    dbState.queue = [[]]
    const { getExamByIdForUser } = await importModule()
    const r = await getExamByIdForUser('user-1', 'exam-unknown')
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
    const r = await getExamByIdForUser('user-1', 'exam-A')
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
    const r = await getExamByIdForUser('user-1', 'exam-A')
    expect(r?.archivedAt).toEqual(archived)
  })
})

describe('getCardsForExam (owner isolation + full detail mapping)', () => {
  it('returns empty array when no rows (other user exam or empty exam)', async () => {
    dbState.queue = [[]]
    const { getCardsForExam } = await importModule()
    const r = await getCardsForExam('user-1', 'exam-A')
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
        },
      ],
    ]
    const { getCardsForExam } = await importModule()
    const r = await getCardsForExam('user-1', 'exam-A')
    expect(r).toHaveLength(1)
    // snippet 化せず問題文全文・全選択肢・card 解説・memo をそのまま返す
    expect(r[0]).toEqual({
      id: 'card-1',
      title: '問1',
      sortKey: '001',
      questionText: 'a'.repeat(120),
      options,
      explanationText: 'カード全体の解説',
      memo: 'マイメモ',
    })
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
    const r = await getCardsForExam('user-1', 'exam-A')
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
    const r = await getSourceDocumentForUser('user-1', 'sdoc-unknown')
    expect(r).toBeNull()
  })

  it('returns { id, examName } when found (own source_document)', async () => {
    dbState.queue = [[{ id: 'sdoc-A', examName: 'My Exam' }]]
    const { getSourceDocumentForUser } = await importModule()
    const r = await getSourceDocumentForUser('user-1', 'sdoc-A')
    expect(r).toEqual({ id: 'sdoc-A', examName: 'My Exam' })
  })
})

describe('getCardsForSourceDocument (owner isolation + snippet/keys derivation)', () => {
  it('returns empty array when no rows (other user / discarded source_document)', async () => {
    dbState.queue = [[]]
    const { getCardsForSourceDocument } = await importModule()
    const r = await getCardsForSourceDocument('user-1', 'sdoc-A')
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
          customProps: { 試験回: '令和7' },
          createdAt: new Date(),
        },
      ],
    ]
    const { getCardsForSourceDocument } = await importModule()
    const r = await getCardsForSourceDocument('user-1', 'sdoc-A')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      id: 'card-1',
      title: '問1',
      sortKey: '001',
      optionCount: 2,
      customPropKeys: ['試験回'],
    })
    expect(r[0].questionTextSnippet.endsWith('…')).toBe(true)
  })
})
