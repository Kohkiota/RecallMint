import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SQL, Column } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

// apply-card-mutation.ts の純関数 (applyCardCreateWithId / applyCardDelete) の unit test。
//
// 旧 buildSetClause / applyCardFieldUpdate のテストは Tag-2a で
// card-field-handlers.test.ts に同値移植され、 本ファイルからは撤去済。
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
// helper: sql fragment の構造的観測 (F3 G2 — render 文字列 pin 禁止)。
// set.cardCount / set.updatedAt の sql object を queryChunks から判定する。
// ---------------------------------------------------------------------------

// Column instance の .name を列挙 (参照 column)。
function sqlColumnNames(frag: SQL): string[] {
  const chunks = (frag as unknown as { queryChunks?: unknown[] }).queryChunks ?? []
  return chunks.filter((c): c is Column => c instanceof Column).map((c) => c.name)
}

// StringChunk の value を連結 (GREATEST / now() 等キーワードの有無検査用)。
function sqlStaticText(frag: SQL): string {
  const chunks = (frag as unknown as { queryChunks?: unknown[] }).queryChunks ?? []
  return chunks
    .flatMap((c) => {
      const v = (c as { value?: unknown }).value
      return Array.isArray(v) ? (v as string[]) : []
    })
    .join('')
}

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
    // G2: exams UPDATE の set 句を捕捉 (cardCount / updatedAt fragment の構造観測用)。
    updateSet: null as Record<string, unknown> | null,
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
      set: (vals: Record<string, unknown>) => {
        captured.updateSet = vals
        return {
          where: () => {
            for (const e of store.exams) {
              e.cardCount = Math.max(e.cardCount - 1, 0)
            }
            return Promise.resolve(undefined)
          },
        }
      },
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
    captured.updateSet = null
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

  // G2: card_count -1 fragment の構造 (delete = GREATEST guard) を現挙動として pin。
  it('G2: set.cardCount = exams.card_count 参照 + GREATEST 有 (現挙動: -1 は GREATEST guard)', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    const cardCount = captured.updateSet!.cardCount as SQL
    expect(sqlColumnNames(cardCount)).toContain('card_count')
    expect(sqlStaticText(cardCount)).toContain('GREATEST')
  })

  it('G2: set.updatedAt = exams.updated_at 自己参照 (now() 不在)', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    const updatedAt = captured.updateSet!.updatedAt as SQL
    expect(sqlColumnNames(updatedAt)).toEqual(['updated_at'])
    expect(sqlStaticText(updatedAt).toLowerCase()).not.toContain('now(')
  })
})

// ---------------------------------------------------------------------------
// applyCardCreateWithId
// ---------------------------------------------------------------------------

describe('applyCardCreateWithId', () => {
  const store = {
    exams: [] as { id: string; userId: string; cardCount: number }[],
    cards: [] as { id: string; examId: string; userId: string }[],
  }
  const ctl = {
    insertedValues: null as Record<string, unknown> | null,
    // ON CONFLICT: null = 実 insert, 'conflict' = skip (no returning row)
    insertConflict: false,
    // G2: exams UPDATE の set 句を捕捉 (cardCount / updatedAt fragment の構造観測用)。
    updateSet: null as Record<string, unknown> | null,
  }

  function makeTx() {
    const tx: Record<string, unknown> = {}

    tx.select = (_cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const name = getTableName(table as never)
          if (name === getTableName(exams)) {
            return Promise.resolve(store.exams.map((e) => ({ id: e.id })))
          }
          return Promise.resolve([])
        },
      }),
    })

    tx.insert = () => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoNothing: (_conf: unknown) => ({
          returning: () => {
            ctl.insertedValues = vals
            if (ctl.insertConflict) {
              // ON CONFLICT DO NOTHING → no row returned
              return Promise.resolve([])
            }
            store.cards.push({ id: vals.id as string, examId: vals.examId as string, userId: vals.userId as string })
            return Promise.resolve([{ id: vals.id }])
          },
        }),
      }),
    })

    tx.update = () => ({
      set: (vals: Record<string, unknown>) => {
        ctl.updateSet = vals
        return {
          where: () => {
            for (const e of store.exams) e.cardCount += 1
            return Promise.resolve(undefined)
          },
        }
      },
    })

    return tx as Parameters<
      typeof import('./apply-card-mutation').applyCardCreateWithId
    >[0]
  }

  const BASE_INPUT = {
    cardId: 'card-client-1',
    examId: 'exam-1',
    title: '問1',
    sortKey: 'Q-01',
    questionText: '質問テキスト',
    options: [
      { id: 'a', text: 'A', is_correct: true },
      { id: 'b', text: 'B', is_correct: false },
    ],
    explanationText: '解説',
    memo: 'メモ',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    store.exams = [{ id: 'exam-1', userId: 'user-1', cardCount: 0 }]
    store.cards = []
    ctl.insertedValues = null
    ctl.insertConflict = false
    ctl.updateSet = null
  })

  it('正常: { examNotFound: false, created: true } を返す', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    const result = await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    expect(result).toEqual({ examNotFound: false, created: true })
  })

  it('exam 不在 → { examNotFound: true, created: false }、card INSERT も card_count 更新もしない', async () => {
    store.exams = []
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    const result = await applyCardCreateWithId(makeTx(), 'user-1', { ...BASE_INPUT, examId: 'exam-x' })
    expect(result).toEqual({ examNotFound: true, created: false })
    expect(ctl.insertedValues).toBeNull()
    expect(store.cards.length).toBe(0)
  })

  it('INSERT 値: id = cardId (client 生成)、userId/examId/sourceDocumentId=null が含まれる', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    const v = ctl.insertedValues!
    expect(v.id).toBe('card-client-1')
    expect(v.userId).toBe('user-1')
    expect(v.examId).toBe('exam-1')
    expect(v.sourceDocumentId).toBeNull()
  })

  it('INSERT 値: title/sortKey/questionText/explanationText/memo が含まれる', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    const v = ctl.insertedValues!
    expect(v.title).toBe('問1')
    expect(v.sortKey).toBe('Q-01')
    expect(v.questionText).toBe('質問テキスト')
    expect(v.explanationText).toBe('解説')
    expect(v.memo).toBe('メモ')
  })

  it('correct_answer_ids は client patch を信用せず options.is_correct から server 再生成 (改竄耐性)', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', {
      ...BASE_INPUT,
      options: [
        { id: 'a', text: 'A', is_correct: true },
        { id: 'b', text: 'B', is_correct: false },
        { id: 'c', text: 'C', is_correct: true },
      ],
    })
    const v = ctl.insertedValues!
    // is_correct=true の id のみが correctAnswerIds に含まれる
    expect(v.correctAnswerIds).toEqual(['a', 'c'])
  })

  it('実 insert 時: card_count += 1', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    expect(store.exams[0]!.cardCount).toBe(1)
    expect(store.cards.length).toBe(1)
  })

  it('ON CONFLICT skip (同 cardId 再送): { created: false }、card_count 非加算', async () => {
    ctl.insertConflict = true
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    const result = await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    expect(result).toEqual({ examNotFound: false, created: false })
    // INSERT は呼ばれた (insertedValues が記録される)
    expect(ctl.insertedValues).not.toBeNull()
    // card_count は加算されない (二重加算防止)
    expect(store.exams[0]!.cardCount).toBe(0)
    expect(store.cards.length).toBe(0)
  })

  it('owner-scope: WHERE に eq(exams.id, examId) / eq(exams.userId, userId) が含まれる', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    const sig = await eqSignature()
    expect(sig).toContainEqual(['exams', 'id', 'exam-1'])
    expect(sig).toContainEqual(['exams', 'user_id', 'user-1'])
  })

  it('owner-scope (exams UPDATE): 実 insert 時の card_count 更新 WHERE に eq(exams.id, examId) と eq(exams.userId, userId) が含まれる', async () => {
    // exams SELECT (owner 確認) と exams UPDATE (card_count += 1) の両方で
    // userId が WHERE に含まれることを assert する。
    // SELECT owner-scope は上のテストで確認済み。ここでは UPDATE の owner-scope を担保。
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    const sig = await eqSignature()
    // exams.user_id = 'user-1' が eq spy に 1 回以上現れること
    // (SELECT WHERE + UPDATE WHERE の両方が含まれるため、重複 containEqual で検証)
    const examsUserIdCalls = sig.filter(
      ([table, col, val]) => table === 'exams' && col === 'user_id' && val === 'user-1',
    )
    expect(examsUserIdCalls.length).toBeGreaterThanOrEqual(2) // SELECT + UPDATE の両方
    const examsIdCalls = sig.filter(
      ([table, col, val]) => table === 'exams' && col === 'id' && val === 'exam-1',
    )
    expect(examsIdCalls.length).toBeGreaterThanOrEqual(2) // SELECT + UPDATE の両方
  })

  // G2: card_count +1 fragment の構造 (create = 素加算・GREATEST 不在) を現挙動として pin。
  it('G2: set.cardCount = exams.card_count 参照 + 素加算 (GREATEST 不在・現挙動)', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    const cardCount = ctl.updateSet!.cardCount as SQL
    expect(sqlColumnNames(cardCount)).toContain('card_count')
    expect(sqlStaticText(cardCount)).not.toContain('GREATEST')
    // +1 は StringChunk (" + 1") に畳まれ、 raw number chunk / param は無い (現挙動)。
    expect(sqlStaticText(cardCount)).toContain('+ 1')
  })

  it('G2: set.updatedAt = exams.updated_at 自己参照 (now() 不在)', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    const updatedAt = ctl.updateSet!.updatedAt as SQL
    expect(sqlColumnNames(updatedAt)).toEqual(['updated_at'])
    expect(sqlStaticText(updatedAt).toLowerCase()).not.toContain('now(')
  })
})

