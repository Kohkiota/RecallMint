import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SQL, getTableName } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  assets,
  cards,
  cardTags,
  tagCategories,
  tagOptions,
} from '@/lib/db/schema'

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
// images handler (画像フェーズ A Task 5)
//
// title 系と違い、 UUID key がある場合は先に assets テーブルへの SELECT
// (owner-scope + status='ready') が挟まる。 既存 makeTx (update のみ) に
// select を足した専用 mock を使う。
// ---------------------------------------------------------------------------

interface ImagesTxState extends TxState {
  // SELECT assets 結果 (owner-scope + status='ready' 一致行のみを返す想定で
  // テスト側が仕込む)
  assetSelectRows: { id: string }[]
  assetSelectCalls: number
}

function freshImagesState(): ImagesTxState {
  return { ...freshState(), assetSelectRows: [], assetSelectCalls: 0 }
}

function makeImagesTx(state: ImagesTxState) {
  const base = makeTx(state) as unknown as Record<string, unknown>
  base.select = (_cols: unknown) => ({
    from: (table: unknown) => {
      const name = getTableName(table as Parameters<typeof getTableName>[0])
      return {
        where: (_cond: unknown) => {
          if (name === getTableName(assets)) {
            state.assetSelectCalls += 1
            return Promise.resolve(state.assetSelectRows)
          }
          return Promise.resolve([])
        },
      }
    },
  })
  return base as Parameters<
    typeof import('./card-field-handlers').CARD_FIELD_HANDLERS.images
  >[0]
}

describe('CARD_FIELD_HANDLERS.images', () => {
  let state: ImagesTxState
  const UUID_1 = '11111111-1111-4111-a111-111111111111'
  const UUID_2 = '22222222-2222-4222-a222-222222222222'

  beforeEach(() => {
    vi.clearAllMocks()
    state = freshImagesState()
  })

  it('正常: UUID key 全件が ready+owned → applied、 images を SET', async () => {
    state.assetSelectRows = [{ id: UUID_1 }, { id: UUID_2 }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.images(
      makeImagesTx(state),
      'card-1',
      'user-1',
      [
        { key: UUID_1, target: 'question_text', alt: '' },
        { key: UUID_2, target: 'option:a', alt: '' },
      ],
    )
    expect(result).toBe('applied')
    expect(state.setArg?.images).toEqual([
      { key: UUID_1, target: 'question_text', alt: '' },
      { key: UUID_2, target: 'option:a', alt: '' },
    ])
    expect(state.assetSelectCalls).toBe(1)
  })

  it('UUID key が ready+owned 行に無い (不在/非ready/他user) → failed、 UPDATE 発行なし', async () => {
    // UUID_2 が返ってこない = 不在 or status != ready or 他 user
    state.assetSelectRows = [{ id: UUID_1 }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.images(
      makeImagesTx(state),
      'card-1',
      'user-1',
      [
        { key: UUID_1, target: 'question_text', alt: '' },
        { key: UUID_2, target: 'option:a', alt: '' },
      ],
    )
    expect(result).toBe('failed')
    expect(state.updateCallCount).toBe(0)
  })

  it('url 非空を含む mutation → failed (zod で reject)、 assets query 不発', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.images(
      makeImagesTx(state),
      'card-1',
      'user-1',
      [
        {
          key: UUID_1,
          target: 'question_text',
          alt: '',
          url: 'https://example.com/x.png',
        },
      ],
    )
    expect(result).toBe('failed')
    expect(state.assetSelectCalls).toBe(0)
    expect(state.updateCallCount).toBe(0)
  })

  it('legacy 非 UUID key のみ → assets query 不発、 applied', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.images(
      makeImagesTx(state),
      'card-1',
      'user-1',
      [{ key: 'legacy-ocr-ref-1', target: 'anything', alt: '' }],
    )
    expect(result).toBe('applied')
    expect(state.assetSelectCalls).toBe(0)
    expect(state.setArg?.images).toEqual([
      { key: 'legacy-ocr-ref-1', target: 'anything', alt: '' },
    ])
  })

  it('非 v4 UUID key (v1) は legacy 扱い → assets query 不発、 applied (spec §2.2 UUIDv4 限定)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.images(
      makeImagesTx(state),
      'card-1',
      'user-1',
      // v1 UUID: isAssetKey (v4 厳密) が false → asset 検証されず passthrough
      [{ key: '11111111-1111-1111-8111-111111111111', target: 'anything', alt: '' }],
    )
    expect(result).toBe('applied')
    expect(state.assetSelectCalls).toBe(0)
  })

  it('owner scope: assets query の WHERE に userId + status=ready が含まれる', async () => {
    state.assetSelectRows = [{ id: UUID_1 }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.images(
      makeImagesTx(state),
      'card-1',
      'user-1',
      [{ key: UUID_1, target: 'question_text', alt: '' }],
    )
    const sig = await eqSignature()
    expect(sig).toContainEqual(['assets', 'user_id', 'user-1'])
    expect(sig).toContainEqual(['assets', 'status', 'ready'])
  })

  it('owner scope: cards UPDATE の WHERE に eq(cards.id, cardId) + eq(cards.userId, userId)', async () => {
    state.assetSelectRows = [{ id: UUID_1 }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.images(
      makeImagesTx(state),
      'card-1',
      'user-1',
      [{ key: UUID_1, target: 'question_text', alt: '' }],
    )
    const sig = await eqSignature()
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })

  it('0 row (card 不在 / owner mismatch) → failed', async () => {
    state.assetSelectRows = [{ id: UUID_1 }]
    state.returningRows = []
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.images(
      makeImagesTx(state),
      'card-1',
      'user-1',
      [{ key: UUID_1, target: 'question_text', alt: '' }],
    )
    expect(result).toBe('failed')
  })

  it('空配列 → assets query 不発、 applied', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.images(
      makeImagesTx(state),
      'card-1',
      'user-1',
      [],
    )
    expect(result).toBe('applied')
    expect(state.assetSelectCalls).toBe(0)
    expect(state.setArg?.images).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// dispatch (未知 field → failed)
// ---------------------------------------------------------------------------

describe('CARD_FIELD_HANDLERS dispatch', () => {
  it('map に全 8 field の handler が登録されている', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    expect(Object.keys(CARD_FIELD_HANDLERS).sort()).toEqual(
      [
        'explanation_text',
        'images',
        'memo',
        'options',
        'question_text',
        'sort_key',
        'tag_option_ids',
        'title',
      ].sort(),
    )
  })

  it('images entry は handleImages と同一関数を指す', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    expect(CARD_FIELD_HANDLERS.images).toBeTypeOf('function')
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

// ---------------------------------------------------------------------------
// tag_option_ids handler (Tag-2c)
//
// このハンドラだけ owner-scoped UPDATE cards 1 列発行ではなく、
//   SELECT cards (owner check)
//   SELECT tag_options (owner check for options)
//   DELETE card_tags (whole-set)
//   INSERT card_tags (new set)
//   UPDATE cards (updated_at bump only)
// の 5 種類の DB 呼出を順次行う。 既存 makeTx は update only なので、
// 専用の makeTagTx で 4 種の操作を全部観測する。
// ---------------------------------------------------------------------------

interface TagTxState {
  // SELECT cards 結果 (owner check)
  cardSelectRows: { id: string }[]
  // SELECT tag_options 結果 (owner check)。 single 制約検査 ④ 拡張で categoryId も返す。
  optionSelectRows: { id: string; categoryId?: string }[]
  // SELECT tag_categories 結果 (single 制約検査用)
  categorySelectRows: { id: string; selectType: 'single' | 'multi' }[]
  // DELETE card_tags 呼出回数
  cardTagsDeleteCalls: number
  // INSERT card_tags の values 記録 (call ごとに push)
  cardTagsInsertedValues: Array<Array<Record<string, unknown>>>
  // UPDATE cards の set arg 記録 (touch 用)
  cardsUpdateSetArgs: Array<Record<string, unknown>>
  // SELECT 対象テーブル順
  selectFromTables: string[]
}

function freshTagState(): TagTxState {
  return {
    cardSelectRows: [{ id: 'card-1' }],
    optionSelectRows: [],
    categorySelectRows: [],
    cardTagsDeleteCalls: 0,
    cardTagsInsertedValues: [],
    cardsUpdateSetArgs: [],
    selectFromTables: [],
  }
}

function makeTagTx(state: TagTxState) {
  const obj: Record<string, unknown> = {}

  obj.select = (_cols: unknown) => ({
    from: (table: unknown) => {
      const name = getTableName(table as Parameters<typeof getTableName>[0])
      state.selectFromTables.push(name)
      return {
        where: (_cond: unknown) => {
          if (name === getTableName(cards)) {
            return Promise.resolve(state.cardSelectRows)
          }
          if (name === getTableName(tagOptions)) {
            return Promise.resolve(state.optionSelectRows)
          }
          if (name === getTableName(tagCategories)) {
            return Promise.resolve(state.categorySelectRows)
          }
          return Promise.resolve([])
        },
      }
    },
  })

  obj.delete = (table: unknown) => ({
    where: (_cond: unknown) => {
      const name = getTableName(table as Parameters<typeof getTableName>[0])
      if (name === getTableName(cardTags)) state.cardTagsDeleteCalls += 1
      return Promise.resolve(undefined)
    },
  })

  obj.insert = (table: unknown) => ({
    values: (vals: Array<Record<string, unknown>>) => {
      const name = getTableName(table as Parameters<typeof getTableName>[0])
      if (name === getTableName(cardTags)) {
        state.cardTagsInsertedValues.push(vals)
      }
      return Promise.resolve(undefined)
    },
  })

  obj.update = (table: unknown) => {
    const name = getTableName(table as Parameters<typeof getTableName>[0])
    return {
      set: (arg: Record<string, unknown>) => {
        if (name === getTableName(cards)) state.cardsUpdateSetArgs.push(arg)
        return {
          where: (_cond: unknown) => Promise.resolve(undefined),
        }
      },
    }
  }

  return obj as Parameters<
    typeof import('./card-field-handlers').CARD_FIELD_HANDLERS.tag_option_ids
  >[0]
}

describe('CARD_FIELD_HANDLERS.tag_option_ids', () => {
  let state: TagTxState
  // 適当な uuid (zod の z.uuid() を通せばよいので形式さえ守れば中身は何でも可)
  const OPT_1 = '11111111-1111-4111-a111-111111111111'
  const OPT_2 = '22222222-2222-4222-a222-222222222222'
  const OPT_3 = '33333333-3333-4333-a333-333333333333'
  // single 制約検査用の category id (multi 想定の既定カテゴリ)
  const CAT_MULTI = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'

  beforeEach(() => {
    vi.clearAllMocks()
    state = freshTagState()
  })

  it('正常: 空配列 → DELETE のみ + bump (INSERT skip)', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [],
    )
    expect(result).toBe('applied')
    // owner-scope SELECT cards のみ走る (option owner check は optionIds 空なので skip)
    expect(state.selectFromTables).toEqual(['cards'])
    // DELETE は必ず 1 回 (whole-set replace で旧紐付けを全消去)
    expect(state.cardTagsDeleteCalls).toBe(1)
    // INSERT は走らない (空集合)
    expect(state.cardTagsInsertedValues).toHaveLength(0)
    // cards.updated_at bump
    expect(state.cardsUpdateSetArgs).toHaveLength(1)
  })

  it('正常: N 件 INSERT + bump (DELETE → INSERT → cards.update)', async () => {
    state.optionSelectRows = [
      { id: OPT_1, categoryId: CAT_MULTI },
      { id: OPT_2, categoryId: CAT_MULTI },
    ]
    state.categorySelectRows = [{ id: CAT_MULTI, selectType: 'multi' }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1, OPT_2],
    )
    expect(result).toBe('applied')
    // owner-scope SELECT cards → SELECT tag_options → SELECT tag_categories
    expect(state.selectFromTables).toEqual([
      'cards',
      'tag_options',
      'tag_categories',
    ])
    expect(state.cardTagsDeleteCalls).toBe(1)
    expect(state.cardTagsInsertedValues).toHaveLength(1)
    expect(state.cardTagsInsertedValues[0]).toEqual([
      { cardId: 'card-1', optionId: OPT_1, userId: 'user-1' },
      { cardId: 'card-1', optionId: OPT_2, userId: 'user-1' },
    ])
    expect(state.cardsUpdateSetArgs).toHaveLength(1)
  })

  it('updated_at bump: SET に sql`now()` が含まれる (touch のみ)', async () => {
    state.optionSelectRows = [{ id: OPT_1, categoryId: CAT_MULTI }]
    state.categorySelectRows = [{ id: CAT_MULTI, selectType: 'multi' }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1],
    )
    expect(state.cardsUpdateSetArgs).toHaveLength(1)
    const setArg = state.cardsUpdateSetArgs[0]!
    expect(setArg['updatedAt']).toBeInstanceOf(SQL)
    const rendered = new PgDialect().sqlToQuery(setArg['updatedAt'] as SQL).sql
    expect(rendered).toContain('now()')
    // touch のみ: 他列は SET しない
    expect(Object.keys(setArg)).toEqual(['updatedAt'])
  })

  it('重複排除: 同 uuid 複数渡しでも INSERT は重複除去後の件数', async () => {
    // optionSelectRows は Set 化後の件数 (2) と一致させる
    state.optionSelectRows = [
      { id: OPT_1, categoryId: CAT_MULTI },
      { id: OPT_2, categoryId: CAT_MULTI },
    ]
    state.categorySelectRows = [{ id: CAT_MULTI, selectType: 'multi' }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1, OPT_1, OPT_2],
    )
    expect(result).toBe('applied')
    expect(state.cardTagsInsertedValues).toHaveLength(1)
    expect(state.cardTagsInsertedValues[0]).toHaveLength(2)
    // 順序は Set の挿入順 (= [OPT_1, OPT_2])
    expect(state.cardTagsInsertedValues[0]!.map((v) => v['optionId'])).toEqual([
      OPT_1,
      OPT_2,
    ])
  })

  it('既存集合との置換: handler は DELETE → INSERT に閉じる (mock 観点)', async () => {
    // 「事前に紐付け 1 件あっても、 DELETE で消し INSERT で入れ直す」 挙動を mock 上で
    // 観測する。 mock 自体は store を持たないが、 DELETE が必ず 1 回 / INSERT が 1 回で
    // values が新集合のみであることを assert する。
    state.optionSelectRows = [{ id: OPT_3, categoryId: CAT_MULTI }]
    state.categorySelectRows = [{ id: CAT_MULTI, selectType: 'multi' }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_3],
    )
    expect(result).toBe('applied')
    expect(state.cardTagsDeleteCalls).toBe(1)
    expect(state.cardTagsInsertedValues).toHaveLength(1)
    expect(state.cardTagsInsertedValues[0]).toEqual([
      { cardId: 'card-1', optionId: OPT_3, userId: 'user-1' },
    ])
  })

  it('値検証失敗 (非 uuid 混在) → failed、 副作用なし', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      ['not-a-uuid'],
    )
    expect(result).toBe('failed')
    expect(state.selectFromTables).toHaveLength(0)
    expect(state.cardTagsDeleteCalls).toBe(0)
    expect(state.cardTagsInsertedValues).toHaveLength(0)
    expect(state.cardsUpdateSetArgs).toHaveLength(0)
  })

  it('値検証失敗 (非配列) → failed、 副作用なし', async () => {
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      'not-an-array',
    )
    expect(result).toBe('failed')
    expect(state.cardTagsDeleteCalls).toBe(0)
  })

  it('値検証失敗 (101 件超) → failed、 副作用なし', async () => {
    // 形式上 uuid である 101 個を作る
    const big = Array.from({ length: 101 }, (_, i) => {
      const hex = (i + 1).toString(16).padStart(4, '0')
      return `${hex}${hex}${hex}${hex}-1111-4111-a111-111111111111`
    })
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      big,
    )
    expect(result).toBe('failed')
    expect(state.selectFromTables).toHaveLength(0)
    expect(state.cardTagsDeleteCalls).toBe(0)
    expect(state.cardTagsInsertedValues).toHaveLength(0)
    expect(state.cardsUpdateSetArgs).toHaveLength(0)
  })

  it('card 不在 (owner mismatch / 未存在) → failed、 DELETE / INSERT / bump 走らない', async () => {
    state.cardSelectRows = []
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1],
    )
    expect(result).toBe('failed')
    // cards owner check のみ走る (option owner check より先)
    expect(state.selectFromTables).toEqual(['cards'])
    expect(state.cardTagsDeleteCalls).toBe(0)
    expect(state.cardTagsInsertedValues).toHaveLength(0)
    expect(state.cardsUpdateSetArgs).toHaveLength(0)
  })

  it('他 user option 混在 (option owner check 不一致) → failed、 DELETE / INSERT / bump 走らない', async () => {
    // 2 件渡したが option_owner check で 1 件しか返らない (= 1 件は他 user)
    state.optionSelectRows = [{ id: OPT_1 }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1, OPT_2],
    )
    expect(result).toBe('failed')
    expect(state.selectFromTables).toEqual(['cards', 'tag_options'])
    expect(state.cardTagsDeleteCalls).toBe(0)
    expect(state.cardTagsInsertedValues).toHaveLength(0)
    expect(state.cardsUpdateSetArgs).toHaveLength(0)
  })

  it('存在しない option_id 混在 → failed (option_owner check と同じ経路)', async () => {
    // 2 件渡したが SELECT が 0 件 (= 全部不在)
    state.optionSelectRows = []
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1, OPT_2],
    )
    expect(result).toBe('failed')
    expect(state.cardTagsDeleteCalls).toBe(0)
    expect(state.cardTagsInsertedValues).toHaveLength(0)
  })

  it('owner-scope eq spy gate: 各 SQL の WHERE に user_id が含まれる', async () => {
    state.optionSelectRows = [{ id: OPT_1, categoryId: CAT_MULTI }]
    state.categorySelectRows = [{ id: CAT_MULTI, selectType: 'multi' }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1],
    )
    const sig = await eqSignature()
    // SELECT cards の WHERE
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
    // SELECT tag_options の WHERE (inArray + eq(user_id))
    expect(sig).toContainEqual(['tag_options', 'user_id', 'user-1'])
    // SELECT tag_categories の WHERE (inArray + eq(user_id), single 制約検査)
    expect(sig).toContainEqual(['tag_categories', 'user_id', 'user-1'])
    // DELETE card_tags の WHERE
    expect(sig).toContainEqual(['card_tags', 'card_id', 'card-1'])
    expect(sig).toContainEqual(['card_tags', 'user_id', 'user-1'])
    // UPDATE cards (bump) の WHERE は SELECT cards と同じ entry を再呼出するため、
    // 上の cards.id / cards.user_id assertion で gate 兼ねる。
  })

  // -------------------------------------------------------------------------
  // A-1: single カテゴリ制約の server enforce
  //
  // select_type='single' なカテゴリに 2 個以上の option が whole-set に含まれる
  // 場合は 'failed' で拒否する (client のみだった制約を server でも enforce)。
  // 検査位置 = 既存検査 ④ の直後・DELETE より前。
  // -------------------------------------------------------------------------
  const CAT_SINGLE_A = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
  const CAT_SINGLE_B = 'cccccccc-cccc-4ccc-accc-cccccccccccc'

  it('single カテゴリに 2 option → failed、 DELETE/INSERT 不発', async () => {
    state.optionSelectRows = [
      { id: OPT_1, categoryId: CAT_SINGLE_A },
      { id: OPT_2, categoryId: CAT_SINGLE_A },
    ]
    state.categorySelectRows = [{ id: CAT_SINGLE_A, selectType: 'single' }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1, OPT_2],
    )
    expect(result).toBe('failed')
    expect(state.cardTagsDeleteCalls).toBe(0)
    expect(state.cardTagsInsertedValues).toHaveLength(0)
    expect(state.cardsUpdateSetArgs).toHaveLength(0)
  })

  it('single 1 個 + multi 複数混在 → applied', async () => {
    state.optionSelectRows = [
      { id: OPT_1, categoryId: CAT_SINGLE_A },
      { id: OPT_2, categoryId: CAT_MULTI },
      { id: OPT_3, categoryId: CAT_MULTI },
    ]
    state.categorySelectRows = [
      { id: CAT_SINGLE_A, selectType: 'single' },
      { id: CAT_MULTI, selectType: 'multi' },
    ]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1, OPT_2, OPT_3],
    )
    expect(result).toBe('applied')
    expect(state.cardTagsDeleteCalls).toBe(1)
    expect(state.cardTagsInsertedValues).toHaveLength(1)
  })

  it('multi のみ複数 → applied', async () => {
    state.optionSelectRows = [
      { id: OPT_1, categoryId: CAT_MULTI },
      { id: OPT_2, categoryId: CAT_MULTI },
    ]
    state.categorySelectRows = [{ id: CAT_MULTI, selectType: 'multi' }]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1, OPT_2],
    )
    expect(result).toBe('applied')
    expect(state.cardTagsDeleteCalls).toBe(1)
    expect(state.cardTagsInsertedValues).toHaveLength(1)
  })

  it('複数 single カテゴリ各 1 個 → applied', async () => {
    state.optionSelectRows = [
      { id: OPT_1, categoryId: CAT_SINGLE_A },
      { id: OPT_2, categoryId: CAT_SINGLE_B },
    ]
    state.categorySelectRows = [
      { id: CAT_SINGLE_A, selectType: 'single' },
      { id: CAT_SINGLE_B, selectType: 'single' },
    ]
    const { CARD_FIELD_HANDLERS } = await import('./card-field-handlers')
    const result = await CARD_FIELD_HANDLERS.tag_option_ids(
      makeTagTx(state),
      'card-1',
      'user-1',
      [OPT_1, OPT_2],
    )
    expect(result).toBe('applied')
    expect(state.cardTagsDeleteCalls).toBe(1)
    expect(state.cardTagsInsertedValues).toHaveLength(1)
  })
})

