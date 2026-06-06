import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SQL, getTableName } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

// card-field-handlers.ts の unit test。
//
// 旧 buildSetClause + applyCardFieldUpdate (apply-card-mutation.ts) の責務を
// field 名 → handler 関数の dispatch table に分解した。 各 handler は
// (値検証 + SET 列構築 + UPDATE 実行) を 1 関数で完結する。
//
// 観点 (各 handler):
//   - 正常系: ApplyResult='applied' / cards UPDATE 発行 / SET 列が正しい
//   - 値検証失敗: 'failed' / UPDATE は発行されない
//   - 0 row (owner mismatch / 不在): 'failed'
//   - owner-scope: WHERE に eq(cards.id, cardId) + eq(cards.userId, userId)
//   - updatedAt bump: SET に sql`now()`
//   - 正規化 (sort_key / explanation_text / memo): '' → null
//   - options: correct_answer_ids を is_correct から再生成
//
// 観点 (dispatch):
//   - 未知 field → 'failed' (CARD_FIELD_HANDLERS map lookup 失敗時の代替)
//
// tx はモックオブジェクトとして渡す。 実 DB / 実 API は使わない。

// ---------------------------------------------------------------------------
// drizzle-orm の eq / and / sql を spy 経由でラップ (owner-scope assert 用)
// ---------------------------------------------------------------------------

const { mockEq, mockAnd, mockSql } = vi.hoisted(() => ({
  mockEq: vi.fn(),
  mockAnd: vi.fn(),
  mockSql: vi.fn(),
}))

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => {
      mockEq(...args)
      return real.eq(...args)
    }),
    and: vi.fn((...args: Parameters<typeof real.and>) => {
      mockAnd(...args)
      return real.and(...args)
    }),
    sql: vi.fn((...args: Parameters<typeof real.sql>) => {
      mockSql(...args)
      return real.sql(...args)
    }),
  }
})

// ---------------------------------------------------------------------------
// helper: eq spy 呼出から [tableName, columnName, value] を取り出す
// ---------------------------------------------------------------------------
async function eqSignature() {
  const { eq } = await import('drizzle-orm')
  return (
    vi.mocked(eq).mock.calls as [
      { name?: string; table?: unknown },
      unknown,
    ][]
  ).map(([col, val]) => {
    const tableName = col.table ? getTableName(col.table as never) : ''
    return [tableName, col.name, val] as [string, string, unknown]
  })
}

// ---------------------------------------------------------------------------
// 共有 tx mock (cards UPDATE のみを受ける、 他は使わない想定)
// ---------------------------------------------------------------------------

interface TxState {
  updateTable: unknown
  setArg: Record<string, unknown> | null
  whereArgs: unknown[][]
  returningRows: Record<string, unknown>[]
  updateCallCount: number
}

function freshState(): TxState {
  return {
    updateTable: null,
    setArg: null,
    whereArgs: [],
    returningRows: [{ examId: 'exam-1' }],
    updateCallCount: 0,
  }
}

function makeTx(state: TxState) {
  const obj: Record<string, unknown> = {}
  obj.update = (table: unknown) => {
    state.updateTable = table
    state.updateCallCount += 1
    const chain: Record<string, unknown> = {}
    chain.set = (arg: Record<string, unknown>) => {
      state.setArg = arg
      return chain
    }
    chain.where = (...args: unknown[]) => {
      state.whereArgs.push(args)
      return chain
    }
    chain.returning = () => Promise.resolve(state.returningRows)
    return chain
  }
  return obj as Parameters<
    typeof import('./card-field-handlers').CARD_FIELD_HANDLERS.title
  >[0]
}

// ---------------------------------------------------------------------------
// title handler
// ---------------------------------------------------------------------------

describe('CARD_FIELD_HANDLERS.title', () => {
  let state: TxState

  beforeEach(() => {
    vi.clearAllMocks()
    state = freshState()
  })

  it('正常: title を SET、 applied を返す', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.title(
      makeTx(state),
      'card-1',
      'user-1',
      '問1',
    )
    expect(result).toBe('applied')
    expect(state.setArg).toMatchObject({ title: '問1' })
  })

  it('trim を適用する (前後空白除去)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.title(
      makeTx(state),
      'card-1',
      'user-1',
      '  問1  ',
    )
    expect(state.setArg).toMatchObject({ title: '問1' })
  })

  it('空文字 → failed (タイトル必須)、 UPDATE 発行なし', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.title(
      makeTx(state),
      'card-1',
      'user-1',
      '',
    )
    expect(result).toBe('failed')
    expect(state.updateCallCount).toBe(0)
  })

  it('201 文字 → failed (200 文字 max)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.title(
      makeTx(state),
      'card-1',
      'user-1',
      'a'.repeat(201),
    )
    expect(result).toBe('failed')
    expect(state.updateCallCount).toBe(0)
  })

  it('0 row (card 不在 / owner mismatch) → failed', async () => {
    state.returningRows = []
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.title(
      makeTx(state),
      'card-1',
      'user-1',
      '問1',
    )
    expect(result).toBe('failed')
  })

  it('cards テーブルを UPDATE する', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.title(makeTx(state), 'card-1', 'user-1', '問1')
    expect(getTableName(state.updateTable as never)).toBe('cards')
  })

  it('updatedAt = sql`now()` が SET に含まれる', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.title(makeTx(state), 'card-1', 'user-1', '問1')
    const updatedAt = state.setArg?.updatedAt
    expect(updatedAt).toBeInstanceOf(SQL)
    const rendered = new PgDialect().sqlToQuery(updatedAt as SQL).sql
    expect(rendered).toContain('now()')
  })

  it('owner-scope: WHERE に eq(cards.id, cardId) + eq(cards.userId, userId)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.title(makeTx(state), 'card-1', 'user-1', '問1')
    const sig = await eqSignature()
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })
})

// ---------------------------------------------------------------------------
// sort_key handler
// ---------------------------------------------------------------------------

describe('CARD_FIELD_HANDLERS.sort_key', () => {
  let state: TxState

  beforeEach(() => {
    vi.clearAllMocks()
    state = freshState()
  })

  it('正常: sortKey を SET、 applied', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.sort_key(
      makeTx(state),
      'card-1',
      'user-1',
      'Q-01',
    )
    expect(result).toBe('applied')
    expect(state.setArg).toMatchObject({ sortKey: 'Q-01' })
  })

  it('空文字 → null に正規化', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.sort_key(
      makeTx(state),
      'card-1',
      'user-1',
      '',
    )
    expect(state.setArg?.sortKey).toBeNull()
  })

  it('null をそのまま受け入れる', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.sort_key(
      makeTx(state),
      'card-1',
      'user-1',
      null,
    )
    expect(result).toBe('applied')
    expect(state.setArg?.sortKey).toBeNull()
  })

  it('101 文字 → failed (100 文字 max)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.sort_key(
      makeTx(state),
      'card-1',
      'user-1',
      'a'.repeat(101),
    )
    expect(result).toBe('failed')
    expect(state.updateCallCount).toBe(0)
  })

  it('0 row → failed', async () => {
    state.returningRows = []
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.sort_key(
      makeTx(state),
      'card-1',
      'user-1',
      'Q-01',
    )
    expect(result).toBe('failed')
  })

  it('updatedAt bump + owner-scope', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.sort_key(
      makeTx(state),
      'card-1',
      'user-1',
      'Q-01',
    )
    const updatedAt = state.setArg?.updatedAt
    expect(updatedAt).toBeInstanceOf(SQL)
    const sig = await eqSignature()
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })
})

// ---------------------------------------------------------------------------
// question_text handler
// ---------------------------------------------------------------------------

describe('CARD_FIELD_HANDLERS.question_text', () => {
  let state: TxState

  beforeEach(() => {
    vi.clearAllMocks()
    state = freshState()
  })

  it('正常: questionText を SET、 applied', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.question_text(
      makeTx(state),
      'card-1',
      'user-1',
      '質問テキスト',
    )
    expect(result).toBe('applied')
    expect(state.setArg).toMatchObject({ questionText: '質問テキスト' })
  })

  it('空白のみ → failed (trim 後非空必須)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.question_text(
      makeTx(state),
      'card-1',
      'user-1',
      '   ',
    )
    expect(result).toBe('failed')
    expect(state.updateCallCount).toBe(0)
  })

  it('10001 文字 → failed (10000 文字 max)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.question_text(
      makeTx(state),
      'card-1',
      'user-1',
      'a'.repeat(10001),
    )
    expect(result).toBe('failed')
  })

  it('0 row → failed', async () => {
    state.returningRows = []
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.question_text(
      makeTx(state),
      'card-1',
      'user-1',
      '質問',
    )
    expect(result).toBe('failed')
  })

  it('updatedAt bump + owner-scope', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.question_text(
      makeTx(state),
      'card-1',
      'user-1',
      '質問',
    )
    expect(state.setArg?.updatedAt).toBeInstanceOf(SQL)
    const sig = await eqSignature()
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })
})

// ---------------------------------------------------------------------------
// explanation_text handler
// ---------------------------------------------------------------------------

describe('CARD_FIELD_HANDLERS.explanation_text', () => {
  let state: TxState

  beforeEach(() => {
    vi.clearAllMocks()
    state = freshState()
  })

  it('正常: explanationText を SET、 applied', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.explanation_text(
      makeTx(state),
      'card-1',
      'user-1',
      '解説',
    )
    expect(result).toBe('applied')
    expect(state.setArg).toMatchObject({ explanationText: '解説' })
  })

  it('空文字 → null に正規化', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.explanation_text(
      makeTx(state),
      'card-1',
      'user-1',
      '',
    )
    expect(state.setArg?.explanationText).toBeNull()
  })

  it('null をそのまま受け入れる', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.explanation_text(
      makeTx(state),
      'card-1',
      'user-1',
      null,
    )
    expect(state.setArg?.explanationText).toBeNull()
  })

  it('10001 文字 → failed', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.explanation_text(
      makeTx(state),
      'card-1',
      'user-1',
      'a'.repeat(10001),
    )
    expect(result).toBe('failed')
  })

  it('0 row → failed', async () => {
    state.returningRows = []
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.explanation_text(
      makeTx(state),
      'card-1',
      'user-1',
      '解説',
    )
    expect(result).toBe('failed')
  })

  it('updatedAt bump + owner-scope', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.explanation_text(
      makeTx(state),
      'card-1',
      'user-1',
      '解説',
    )
    expect(state.setArg?.updatedAt).toBeInstanceOf(SQL)
    const sig = await eqSignature()
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })
})

// ---------------------------------------------------------------------------
// memo handler
// ---------------------------------------------------------------------------

describe('CARD_FIELD_HANDLERS.memo', () => {
  let state: TxState

  beforeEach(() => {
    vi.clearAllMocks()
    state = freshState()
  })

  it('正常: memo を SET、 applied', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.memo(
      makeTx(state),
      'card-1',
      'user-1',
      'メモ',
    )
    expect(result).toBe('applied')
    expect(state.setArg).toMatchObject({ memo: 'メモ' })
  })

  it('空文字 → null に正規化', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.memo(
      makeTx(state),
      'card-1',
      'user-1',
      '',
    )
    expect(state.setArg?.memo).toBeNull()
  })

  it('null をそのまま受け入れる', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.memo(
      makeTx(state),
      'card-1',
      'user-1',
      null,
    )
    expect(state.setArg?.memo).toBeNull()
  })

  it('10001 文字 → failed', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.memo(
      makeTx(state),
      'card-1',
      'user-1',
      'a'.repeat(10001),
    )
    expect(result).toBe('failed')
  })

  it('0 row → failed', async () => {
    state.returningRows = []
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.memo(
      makeTx(state),
      'card-1',
      'user-1',
      'メモ',
    )
    expect(result).toBe('failed')
  })

  it('updatedAt bump + owner-scope', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.memo(makeTx(state), 'card-1', 'user-1', 'メモ')
    expect(state.setArg?.updatedAt).toBeInstanceOf(SQL)
    const sig = await eqSignature()
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })
})

// ---------------------------------------------------------------------------
// options handler
// ---------------------------------------------------------------------------

describe('CARD_FIELD_HANDLERS.options', () => {
  let state: TxState

  beforeEach(() => {
    vi.clearAllMocks()
    state = freshState()
  })

  it('正常: options + correctAnswerIds を SET、 applied', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.options(
      makeTx(state),
      'card-1',
      'user-1',
      [
        { id: 'a', text: 'A', isCorrect: true },
        { id: 'b', text: 'B', isCorrect: false },
      ],
    )
    expect(result).toBe('applied')
    // camelCase → snake_case (CardOption)
    expect(state.setArg?.options).toEqual([
      { id: 'a', text: 'A', is_correct: true },
      { id: 'b', text: 'B', is_correct: false },
    ])
    // correct_answer_ids は is_correct=true のものだけ
    expect(state.setArg?.correctAnswerIds).toEqual(['a'])
  })

  it('correct_answer_ids は server 側で再生成 (client から渡された correct_answer_ids は無視)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.options(
      makeTx(state),
      'card-1',
      'user-1',
      [
        { id: 'a', text: 'A', isCorrect: true },
        { id: 'b', text: 'B', isCorrect: false },
        { id: 'c', text: 'C', isCorrect: true },
      ],
    )
    expect(state.setArg?.correctAnswerIds).toEqual(['a', 'c'])
  })

  it('explanation がある option はそのまま保持、 空 string や未指定は省く', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.options(
      makeTx(state),
      'card-1',
      'user-1',
      [
        { id: 'a', text: 'A', isCorrect: true, explanation: '理由 A' },
        { id: 'b', text: 'B', isCorrect: false, explanation: '' },
        { id: 'c', text: 'C', isCorrect: false },
      ],
    )
    expect(state.setArg?.options).toEqual([
      { id: 'a', text: 'A', is_correct: true, explanation: '理由 A' },
      { id: 'b', text: 'B', is_correct: false },
      { id: 'c', text: 'C', is_correct: false },
    ])
  })

  it('空配列 → failed (最低 1 個必要)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.options(
      makeTx(state),
      'card-1',
      'user-1',
      [],
    )
    expect(result).toBe('failed')
    expect(state.updateCallCount).toBe(0)
  })

  it('51 個 → failed (最大 50 個まで)', async () => {
    const big = Array.from({ length: 51 }, (_, i) => ({
      id: `o-${i}`,
      text: `T${i}`,
      isCorrect: false,
    }))
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.options(
      makeTx(state),
      'card-1',
      'user-1',
      big,
    )
    expect(result).toBe('failed')
  })

  it('id 重複 → failed', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.options(
      makeTx(state),
      'card-1',
      'user-1',
      [
        { id: 'a', text: 'A', isCorrect: true },
        { id: 'a', text: 'A2', isCorrect: false },
      ],
    )
    expect(result).toBe('failed')
    expect(state.updateCallCount).toBe(0)
  })

  it('0 row → failed', async () => {
    state.returningRows = []
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.options(
      makeTx(state),
      'card-1',
      'user-1',
      [{ id: 'a', text: 'A', isCorrect: true }],
    )
    expect(result).toBe('failed')
  })

  it('updatedAt bump + owner-scope', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.options(
      makeTx(state),
      'card-1',
      'user-1',
      [{ id: 'a', text: 'A', isCorrect: true }],
    )
    expect(state.setArg?.updatedAt).toBeInstanceOf(SQL)
    const sig = await eqSignature()
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })
})

// ---------------------------------------------------------------------------
// dispatch (未知 field → failed)
// ---------------------------------------------------------------------------

describe('CARD_FIELD_HANDLERS dispatch', () => {
  it('map に全 6 field の handler が登録されている', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    expect(Object.keys(CARD_FIELD_HANDLERS).sort()).toEqual(
      [
        'explanation_text',
        'memo',
        'options',
        'question_text',
        'sort_key',
        'title',
      ].sort(),
    )
  })

  it('未知 field → handler 未登録 (envelope 緩和の代替 gate)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    expect(
      (CARD_FIELD_HANDLERS as Record<string, unknown>).no_such_field,
    ).toBeUndefined()
    // registry 側で `if (!handler) return 'failed'` する設計を保証するため
    // ここでは map に未登録であることのみ assert する。
  })
})
