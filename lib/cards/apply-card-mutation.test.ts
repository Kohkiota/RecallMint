import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SQL } from 'drizzle-orm'
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
// applyCardDelete
// ---------------------------------------------------------------------------

describe('applyCardDelete', () => {
  const store = {
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
  // Sprint B (DB 全体掃除) T5 置換 pin: card_count bump (exams.card_count -= 1) 撤去の
  // 証明。 apply-card-mutation.ts はもう tx.update を一切呼ばないため、 呼ばれたら
  // 記録するだけの spy にして「呼ばれない」ことを assert する。
  const updateCalls: unknown[] = []

  function makeTx() {
    const tx: Record<string, unknown> = {}

    tx.select = (_cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const name = getTableName(table as never)
          if (name === getTableName(cards)) {
            return Promise.resolve(store.cards.map((c) => ({ id: c.id })))
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

    tx.update = (table: unknown) => {
      updateCalls.push(table)
      return {
        set: () => ({ where: () => Promise.resolve(undefined) }),
      }
    }

    return tx as Parameters<
      typeof import('./apply-card-mutation').applyCardDelete
    >[0]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    store.cards = [{ id: 'card-1', examId: 'exam-1', userId: 'user-1' }]
    store.tombstones = []
    ctl.tombstoneAlreadyExists = false
    captured.tombstoneValues = null
    updateCalls.length = 0
  })

  it('正常削除: tombstone INSERT + card DELETE', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    expect(store.tombstones.length).toBe(1)
    expect(store.tombstones[0]).toMatchObject({
      userId: 'user-1',
      entityType: 'card',
      entityId: 'card-1',
    })
    expect(store.cards.length).toBe(0)
  })

  it('void を返す (ActionResult は wrapper 側)', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    const result = await applyCardDelete(makeTx(), 'card-1', 'user-1')
    expect(result).toBeUndefined()
  })

  it('card 不在 → idempotent: tombstone なし', async () => {
    store.cards = []
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-nonexistent', 'user-1')
    expect(store.tombstones.length).toBe(0)
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

  // Sprint B (DB 全体掃除) T5 置換 pin: 旧 'exams.cardCount UPDATE の WHERE...' + G2 ×2
  // (card_count / updatedAt fragment 構造) を置換。 card 削除は cards DELETE +
  // tombstone INSERT のみを行い、 exams table への UPDATE を一切発行しないことを
  // mock tx の呼出履歴で保証する。
  it('card 削除は cards DELETE + tombstone INSERT のみを行い、 exams UPDATE を発行しない', async () => {
    const { applyCardDelete } = await import('./apply-card-mutation')
    await applyCardDelete(makeTx(), 'card-1', 'user-1')
    expect(updateCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// applyCardCreateWithId
// ---------------------------------------------------------------------------

describe('applyCardCreateWithId', () => {
  const store = {
    exams: [] as { id: string; userId: string }[],
    cards: [] as { id: string; examId: string; userId: string }[],
  }
  const ctl = {
    insertedValues: null as Record<string, unknown> | null,
    // ON CONFLICT: null = 実 insert, 'conflict' = skip (no returning row)
    insertConflict: false,
  }
  // Sprint B (DB 全体掃除) T5 置換 pin: card_count bump (exams.card_count += 1) 撤去の
  // 証明。 apply-card-mutation.ts はもう tx.update を一切呼ばないため、 呼ばれたら
  // 記録するだけの spy にして「呼ばれない」ことを assert する。
  const updateCalls: unknown[] = []

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

    tx.update = (table: unknown) => {
      updateCalls.push(table)
      return {
        set: () => ({ where: () => Promise.resolve(undefined) }),
      }
    }

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
    store.exams = [{ id: 'exam-1', userId: 'user-1' }]
    store.cards = []
    ctl.insertedValues = null
    ctl.insertConflict = false
    updateCalls.length = 0
  })

  it('正常: { examNotFound: false, created: true } を返す', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    const result = await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    expect(result).toEqual({ examNotFound: false, created: true })
  })

  it('exam 不在 → { examNotFound: true, created: false }、card INSERT を行わない', async () => {
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

  it('実 insert 時: card 行が作成される', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    expect(store.cards.length).toBe(1)
  })

  it('ON CONFLICT skip (同 cardId 再送): { created: false }', async () => {
    ctl.insertConflict = true
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    const result = await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    expect(result).toEqual({ examNotFound: false, created: false })
    // INSERT は呼ばれた (insertedValues が記録される)
    expect(ctl.insertedValues).not.toBeNull()
    expect(store.cards.length).toBe(0)
  })

  it('owner-scope: WHERE に eq(exams.id, examId) / eq(exams.userId, userId) が含まれる', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    const sig = await eqSignature()
    expect(sig).toContainEqual(['exams', 'id', 'exam-1'])
    expect(sig).toContainEqual(['exams', 'user_id', 'user-1'])
  })

  // Sprint B (DB 全体掃除) T5 置換 pin: 旧 'owner-scope (exams UPDATE)...' + G2 ×2
  // (card_count / updatedAt fragment 構造) を置換。 card 作成は cards INSERT のみを
  // 行い、 exams table への UPDATE を一切発行しないことを mock tx の呼出履歴で保証する。
  it('card 作成は cards INSERT のみを行い、 exams UPDATE を発行しない', async () => {
    const { applyCardCreateWithId } = await import('./apply-card-mutation')
    await applyCardCreateWithId(makeTx(), 'user-1', BASE_INPUT)
    expect(updateCalls.length).toBe(0)
  })
})

