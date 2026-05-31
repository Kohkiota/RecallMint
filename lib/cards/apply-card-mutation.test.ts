import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

// apply-card-mutation.ts の純関数 (applyCardFieldUpdate / applyCardCreate /
// applyCardDelete + buildSetClause) の unit test。
//
// tx はモックオブジェクトとして渡す。 実 DB / 実 API は使わない。
// owner-scope: cardId + userId / examId + userId が全 WHERE に含まれることを
// drizzle-orm の eq spy で担保する (server action test と同方式)。

import { getTableName } from 'drizzle-orm'
import { cards, exams } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// 共有 store / ctl (各 describe で初期化)
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
// helper: eq spy 呼出から [tableName, columnName, value] 配列を作る
// (drizzle-orm の eq は vi.mock でラップ済み、import して spy を参照する)
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
// applyCardFieldUpdate
// ---------------------------------------------------------------------------

describe('applyCardFieldUpdate', () => {
  // in-memory state for the mock tx
  const txState = {
    updateTable: null as unknown,
    setArg: null as Record<string, unknown> | null,
    whereArgs: [] as unknown[][],
    returningRows: [] as Record<string, unknown>[],
    throwOnReturning: false,
  }

  function makeTx() {
    const obj: Record<string, unknown> = {}
    obj.update = (table: unknown) => {
      txState.updateTable = table
      const chain: Record<string, unknown> = {}
      chain.set = (arg: Record<string, unknown>) => {
        txState.setArg = arg
        return chain
      }
      chain.where = (...args: unknown[]) => {
        txState.whereArgs.push(args)
        return chain
      }
      chain.returning = () => {
        if (txState.throwOnReturning) {
          return Promise.reject(new Error('tx boom'))
        }
        return Promise.resolve(txState.returningRows)
      }
      return chain
    }
    return obj as Parameters<
      typeof import('./apply-card-mutation').applyCardFieldUpdate
    >[0]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    txState.updateTable = null
    txState.setArg = null
    txState.whereArgs = []
    txState.returningRows = [{ examId: 'exam-1' }]
    txState.throwOnReturning = false
  })

  it('card が存在する場合 { found: true, examId } を返す', async () => {
    const { applyCardFieldUpdate } = await import('./apply-card-mutation')
    const result = await applyCardFieldUpdate(makeTx(), 'card-1', 'user-1', {
      title: '問1',
    })
    expect(result).toEqual({ found: true, examId: 'exam-1' })
  })

  it('0 rows (カード不在 / 他 user) → { found: false }', async () => {
    txState.returningRows = []
    const { applyCardFieldUpdate } = await import('./apply-card-mutation')
    const result = await applyCardFieldUpdate(makeTx(), 'card-1', 'user-1', {
      title: '問1',
    })
    expect(result).toEqual({ found: false })
  })

  it('cards テーブルを UPDATE する', async () => {
    const { applyCardFieldUpdate } = await import('./apply-card-mutation')
    await applyCardFieldUpdate(makeTx(), 'card-1', 'user-1', { title: '問1' })
    expect(getTableName(txState.updateTable as never)).toBe('cards')
  })

  it('setData が set() に渡され updatedAt: sql`now()` が付加される', async () => {
    const { applyCardFieldUpdate } = await import('./apply-card-mutation')
    await applyCardFieldUpdate(makeTx(), 'card-1', 'user-1', {
      title: '問1',
      sortKey: 'Q-01',
    })
    expect(txState.setArg).toMatchObject({ title: '問1', sortKey: 'Q-01' })
    // updatedAt は SQL 式 now()
    const updatedAt = txState.setArg?.updatedAt
    expect(updatedAt).toBeInstanceOf(SQL)
    const rendered = new PgDialect().sqlToQuery(updatedAt as SQL).sql
    expect(rendered).toContain('now()')
  })

  it('owner-scope: WHERE に eq(cards.id, cardId) と eq(cards.userId, userId) が含まれる', async () => {
    const { applyCardFieldUpdate } = await import('./apply-card-mutation')
    await applyCardFieldUpdate(makeTx(), 'card-1', 'user-1', { title: '問1' })
    const sig = await eqSignature()
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })

  it('tx.update が throw した場合は例外を再 throw する (wrapper 側で catch)', async () => {
    txState.throwOnReturning = true
    const { applyCardFieldUpdate } = await import('./apply-card-mutation')
    await expect(
      applyCardFieldUpdate(makeTx(), 'card-1', 'user-1', { title: '問1' }),
    ).rejects.toThrow('tx boom')
  })
})

// ---------------------------------------------------------------------------
// applyCardCreate
// ---------------------------------------------------------------------------

describe('applyCardCreate', () => {
  const store = {
    exams: [] as { id: string; userId: string; cardCount: number }[],
    cards: [] as Record<string, unknown>[],
  }
  const ctl = {
    insertedValues: null as Record<string, unknown> | null,
    nextCardId: 'card-new-1',
  }

  function makeTx() {
    const tx: Record<string, unknown> = {}

    tx.select = (_cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const name = getTableName(table as never)
          if (name === getTableName(exams)) {
            return Promise.resolve(
              store.exams.map((e) => ({ id: e.id })),
            )
          }
          // cards: sortKey のみ
          return Promise.resolve(
            store.cards.map((c) => ({ sortKey: c.sortKey })),
          )
        },
      }),
    })

    tx.insert = () => ({
      values: (vals: Record<string, unknown>) => {
        ctl.insertedValues = vals
        return {
          returning: () => {
            const id = ctl.nextCardId
            store.cards.push({ id, ...vals })
            return Promise.resolve([{ id }])
          },
        }
      },
    })

    tx.update = () => ({
      set: () => ({
        where: () => {
          for (const e of store.exams) e.cardCount += 1
          return Promise.resolve(undefined)
        },
      }),
    })

    return tx as Parameters<
      typeof import('./apply-card-mutation').applyCardCreate
    >[0]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    store.exams = [{ id: 'exam-1', userId: 'user-1', cardCount: 0 }]
    store.cards = []
    ctl.insertedValues = null
    ctl.nextCardId = 'card-new-1'
  })

  it('正常: 新 cardId を返す', async () => {
    const { applyCardCreate } = await import('./apply-card-mutation')
    const result = await applyCardCreate(makeTx(), 'exam-1', 'user-1')
    expect(result).toBe('card-new-1')
  })

  it('exam 不在 → EXAM_NOT_FOUND sentinel を返す', async () => {
    store.exams = []
    const { applyCardCreate, EXAM_NOT_FOUND } = await import(
      './apply-card-mutation'
    )
    const result = await applyCardCreate(makeTx(), 'exam-x', 'user-1')
    expect(result).toBe(EXAM_NOT_FOUND)
  })

  it('INSERT 値に userId / examId / sourceDocumentId: null が含まれる', async () => {
    const { applyCardCreate } = await import('./apply-card-mutation')
    await applyCardCreate(makeTx(), 'exam-1', 'user-1')
    const v = ctl.insertedValues!
    expect(v.userId).toBe('user-1')
    expect(v.examId).toBe('exam-1')
    expect(v.sourceDocumentId).toBeNull()
  })

  it('INSERT 値は placeholder: title/questionText 非空、 option 1 件以上、 correctAnswerIds=[]', async () => {
    const { applyCardCreate } = await import('./apply-card-mutation')
    await applyCardCreate(makeTx(), 'exam-1', 'user-1')
    const v = ctl.insertedValues!
    expect(typeof v.title).toBe('string')
    expect((v.title as string).length).toBeGreaterThan(0)
    expect((v.questionText as string).trim().length).toBeGreaterThan(0)
    expect(Array.isArray(v.options)).toBe(true)
    expect((v.options as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect(v.correctAnswerIds).toEqual([])
  })

  it('同一 tx で card_count += 1 される', async () => {
    const { applyCardCreate } = await import('./apply-card-mutation')
    await applyCardCreate(makeTx(), 'exam-1', 'user-1')
    expect(store.exams[0]!.cardCount).toBe(1)
    expect(store.cards.length).toBe(1)
    // card_count === 実 card 件数 (spec §3.6 integrity)
    expect(store.exams[0]!.cardCount).toBe(store.cards.length)
  })

  it('sortKey は既存 cards の末尾連番', async () => {
    store.cards = [
      { id: 'c1', sortKey: '1' },
      { id: 'c2', sortKey: '2' },
    ]
    const { applyCardCreate } = await import('./apply-card-mutation')
    await applyCardCreate(makeTx(), 'exam-1', 'user-1')
    expect(ctl.insertedValues!.sortKey).toBe('3')
  })

  it('owner-scope: WHERE に eq(exams.id, examId) / eq(exams.userId, userId) / eq(cards.examId, examId) / eq(cards.userId, userId) が含まれる', async () => {
    const { applyCardCreate } = await import('./apply-card-mutation')
    await applyCardCreate(makeTx(), 'exam-1', 'user-1')
    const sig = await eqSignature()
    expect(sig).toContainEqual(['exams', 'id', 'exam-1'])
    expect(sig).toContainEqual(['exams', 'user_id', 'user-1'])
    expect(sig).toContainEqual(['cards', 'exam_id', 'exam-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })

  it('exam 不在時は card INSERT も card_count 更新も行われない', async () => {
    store.exams = []
    const { applyCardCreate } = await import('./apply-card-mutation')
    await applyCardCreate(makeTx(), 'exam-x', 'user-1')
    expect(store.cards.length).toBe(0)
    expect(ctl.insertedValues).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// applyCardDelete
// ---------------------------------------------------------------------------

describe('applyCardDelete', () => {
  const store = {
    exams: [] as { id: string; userId: string; cardCount: number }[],
    cards: [] as { id: string; examId: string; userId: string }[],
    tombstones: [] as {
      userId: string
      entityType: string
      entityId: string
    }[],
  }
  const ctl = {
    tombstoneAlreadyExists: false,
  }
  const captured = {
    tombstoneValues: null as Record<string, unknown> | null,
  }

  function makeTx() {
    const tx: Record<string, unknown> = {}

    tx.select = (_cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const name = getTableName(table as never)
          if (name === getTableName(cards)) {
            return Promise.resolve(
              store.cards.map((c) => ({ examId: c.examId })),
            )
          }
          return Promise.resolve([])
        },
      }),
    })

    tx.insert = (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          captured.tombstoneValues = vals
          if (!ctl.tombstoneAlreadyExists) {
            store.tombstones.push({
              userId: vals.userId as string,
              entityType: vals.entityType as string,
              entityId: vals.entityId as string,
            })
          }
          return Promise.resolve(undefined)
        },
      }),
    })

    tx.delete = (table: unknown) => ({
      where: () => {
        const name = getTableName(table as never)
        if (name === getTableName(cards)) {
          store.cards = []
        }
        return Promise.resolve(undefined)
      },
    })

    tx.update = (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: () => {
          for (const e of store.exams) {
            e.cardCount = Math.max(e.cardCount - 1, 0)
          }
          return Promise.resolve(undefined)
        },
      }),
    })

    return tx as Parameters<
      typeof import('./apply-card-mutation').applyCardDelete
    >[0]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    store.exams = [{ id: 'exam-1', userId: 'user-1', cardCount: 1 }]
    store.cards = [{ id: 'card-1', examId: 'exam-1', userId: 'user-1' }]
    store.tombstones = []
    ctl.tombstoneAlreadyExists = false
    captured.tombstoneValues = null
  })

  it('正常削除: tombstone INSERT + card DELETE + cardCount -= 1', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    expect(store.tombstones.length).toBe(1)
    expect(store.tombstones[0]).toMatchObject({
      userId: 'user-1',
      entityType: 'card',
      entityId: 'card-1',
    })
    expect(store.cards.length).toBe(0)
    expect(store.exams[0]!.cardCount).toBe(0)
  })

  it('void を返す (ActionResult は wrapper 側)', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    const result = await applyCardDelete(makeTx(), 'card-1', 'user-1')
    expect(result).toBeUndefined()
  })

  it('card 不在 → idempotent: tombstone なし / cardCount 不変', async () => {
    store.cards = []
    store.exams[0]!.cardCount = 0
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-nonexistent', 'user-1')
    expect(store.tombstones.length).toBe(0)
    expect(store.exams[0]!.cardCount).toBe(0)
  })

  it('re-delete → insert().values().onConflictDoNothing() 経路に到達し tombstone は増えない', async () => {
    // card は存在する (step1 の early-return を避け step2 tombstone insert 経路に到達させる)
    store.cards = [{ id: 'card-1', examId: 'exam-1', userId: 'user-1' }]
    // tombstone は既存として mock が push を skip する → tombstones.length === 0 のまま
    ctl.tombstoneAlreadyExists = true
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    // onConflictDoNothing の一意性不変条件: tombstone は重複挿入されない
    expect(store.tombstones.length).toBe(0)
    // onConflictDoNothing 経路に到達した証拠: values() に渡された値が記録されている
    expect(captured.tombstoneValues).toMatchObject({
      userId: 'user-1',
      entityType: 'card',
      entityId: 'card-1',
    })
  })

  it('GREATEST guard: cardCount が 0 でも負にならない', async () => {
    store.exams[0]!.cardCount = 0
    store.cards = [{ id: 'card-1', examId: 'exam-1', userId: 'user-1' }]
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    expect(store.exams[0]!.cardCount).toBe(0)
  })

  it('spec §3.6 integrity: 削除後 cardCount === COUNT(cards WHERE exam_id)', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    const exam = store.exams.find((e) => e.id === 'exam-1')!
    const actualCount = store.cards.filter((c) => c.examId === 'exam-1').length
    expect(exam.cardCount).toBe(actualCount)
  })

  it('tombstone.deletedAt は DB クロック sql`now()` (増分 pull cursor 統一)', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    const deletedAt = captured.tombstoneValues?.deletedAt
    expect(deletedAt).toBeInstanceOf(SQL)
    const q = new PgDialect().sqlToQuery(deletedAt as SQL)
    expect(q.sql).toContain('now()')
    expect(q.params).toHaveLength(0)
  })

  it('owner-scope: WHERE に eq(cards.id, cardId) と eq(cards.userId, userId) が含まれる', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    const sig = await eqSignature()
    expect(sig).toContainEqual(['cards', 'id', 'card-1'])
    expect(sig).toContainEqual(['cards', 'user_id', 'user-1'])
  })

  it('exams.cardCount UPDATE の WHERE に eq(exams.id, examId) と eq(exams.userId, userId) が含まれる', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    const sig = await eqSignature()
    expect(sig).toContainEqual(['exams', 'id', 'exam-1'])
    expect(sig).toContainEqual(['exams', 'user_id', 'user-1'])
  })
})

// ---------------------------------------------------------------------------
// buildSetClause (export 確認 + 代表ケース)
// ---------------------------------------------------------------------------

describe('buildSetClause', () => {
  it('export されている', async () => {
    const mod = await import('./apply-card-mutation')
    expect(typeof mod.buildSetClause).toBe('function')
  })

  it('title: 正常', async () => {
    const { buildSetClause } = await import('./apply-card-mutation')
    const r = buildSetClause('title', '問1')
    expect(r).toEqual({ ok: true, data: { title: '問1' } })
  })

  it('title: trim 適用', async () => {
    const { buildSetClause } = await import('./apply-card-mutation')
    const r = buildSetClause('title', '  問1  ')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.title).toBe('問1')
  })

  it('title: 空文字 → { ok: false }', async () => {
    const { buildSetClause } = await import('./apply-card-mutation')
    const r = buildSetClause('title', '')
    expect(r.ok).toBe(false)
  })

  it('sort_key: 空文字 → null に正規化', async () => {
    const { buildSetClause } = await import('./apply-card-mutation')
    const r = buildSetClause('sort_key', '')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.sortKey).toBeNull()
  })

  it('options: is_correct から correctAnswerIds を再生成する', async () => {
    const { buildSetClause } = await import('./apply-card-mutation')
    const r = buildSetClause('options', [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B', isCorrect: false },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.correctAnswerIds).toEqual(['a'])
    }
  })

  it('unknown field → { ok: false } (defensive)', async () => {
    const { buildSetClause } = await import('./apply-card-mutation')
    const r = buildSetClause('no_such_field' as 'title', 'x')
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// UpdateCardFieldName: 型エクスポート確認 (実行時 check は不要、 型引数として利用)
// ---------------------------------------------------------------------------

describe('UpdateCardFieldName export', () => {
  it('apply-card-mutation から UpdateCardFieldName が型 export されている', async () => {
    // import して module に存在確認 (型なので実行時 check は不可; ここでは module load 確認のみ)
    const mod = await import('./apply-card-mutation')
    // EXAM_NOT_FOUND Symbol も export されている
    expect(typeof mod.EXAM_NOT_FOUND).toBe('symbol')
  })
})
