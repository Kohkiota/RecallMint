// applyCardMove の unit test (Grid-3 spec §4.1 / §10-3)。
//
// 実 DB は使わず fake tx で発行 query を捕まえ、 **SQL の形**を pin する:
//   - SET 句が exam_id / base_order / updated_at の 3 列だけであること
//     (= question_label / content_version / FSRS 列に触れない — kickoff 決定 8)
//   - 割当が `UPDATE ... FROM (VALUES ...)` の 1 statement に畳まれ、 値が全て
//     bind parameter であること (文字列連結していない)
//   - owner-scope (user_id) が exam 検証 / card 突合 / UPDATE の全てに乗ること
//   - 不在 card の skip と、 移動先 exam 不在の 'failed'
//
// pin しない範囲: 実 PG 上で行がどう動くか (= 順序・不変条件の readback) は
// tests/integration/pg/card-move.test.ts が実 PostgreSQL で見る。

import { SQL, getTableName } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { CardMovePatch } from '@/lib/sync/shared/mutation-schemas'

const { loggerCalls } = vi.hoisted(() => ({
  loggerCalls: [] as Array<{ level: 'info' | 'warn'; payload: Record<string, unknown> }>,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn((payload: Record<string, unknown>) => {
      loggerCalls.push({ level: 'info', payload })
    }),
    warn: vi.fn((payload: Record<string, unknown>) => {
      loggerCalls.push({ level: 'warn', payload })
    }),
    error: vi.fn(),
  },
}))

import { applyCardMove } from './apply-card-move'

// ---------------------------------------------------------------------------
// fake tx — select 2 種 (exams / cards) と update 1 種を捕まえる
// ---------------------------------------------------------------------------

interface TxState {
  examRows: { id: string }[]
  cardRows: { id: string }[]
  selectTables: string[]
  selectWheres: unknown[]
  updateCount: number
  updateTable: string | null
  setArg: Record<string, unknown> | null
  fromArg: unknown
  updateWhere: unknown
}

function freshState(): TxState {
  return {
    examRows: [{ id: EXAM_ID }],
    cardRows: [],
    selectTables: [],
    selectWheres: [],
    updateCount: 0,
    updateTable: null,
    setArg: null,
    fromArg: null,
    updateWhere: null,
  }
}

function makeTx(state: TxState) {
  const obj: Record<string, unknown> = {}
  obj.select = () => ({
    from: (table: unknown) => {
      const name = getTableName(table as Parameters<typeof getTableName>[0])
      state.selectTables.push(name)
      return {
        where: (cond: unknown) => {
          state.selectWheres.push(cond)
          return Promise.resolve(name === 'exams' ? state.examRows : state.cardRows)
        },
      }
    },
  })
  obj.update = (table: unknown) => {
    state.updateCount += 1
    state.updateTable = getTableName(table as Parameters<typeof getTableName>[0])
    const chain: Record<string, unknown> = {}
    chain.set = (arg: Record<string, unknown>) => {
      state.setArg = arg
      return chain
    }
    chain.from = (arg: unknown) => {
      state.fromArg = arg
      return chain
    }
    chain.where = (arg: unknown) => {
      state.updateWhere = arg
      return Promise.resolve()
    }
    return chain
  }
  return obj as Parameters<typeof applyCardMove>[0]
}

function render(value: unknown) {
  return new PgDialect().sqlToQuery(value as SQL)
}

const USER_ID = '11111111-1111-4111-a111-111111111111'
const EXAM_ID = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee'
const MOVE_ID = '99999999-9999-4999-a999-999999999999'
const CARD_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const CARD_B = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'

const PATCH: CardMovePatch = {
  exam_id: EXAM_ID,
  cards: [
    { id: CARD_A, base_order: 1024 },
    { id: CARD_B, base_order: 2048 },
  ],
}

let state: TxState

beforeEach(() => {
  state = freshState()
  loggerCalls.length = 0
})

describe('applyCardMove — SET 句 (kickoff 決定 8 の不変条件)', () => {
  it('SET は examId / baseOrder / updatedAt の 3 列のみ (question_label / content_version 不触)', async () => {
    state.cardRows = [{ id: CARD_A }, { id: CARD_B }]

    const result = await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    expect(result).toBe('applied')
    expect(state.updateTable).toBe('cards')
    expect(Object.keys(state.setArg ?? {}).sort()).toEqual([
      'baseOrder',
      'examId',
      'updatedAt',
    ])
  })

  it('updatedAt は now() で bump する (pull cursor が updated_at 基点のため必須)', async () => {
    state.cardRows = [{ id: CARD_A }, { id: CARD_B }]

    await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    const updatedAt = state.setArg?.['updatedAt']
    expect(updatedAt).toBeInstanceOf(SQL)
    expect(render(updatedAt).sql).toContain('now()')
  })

  it('baseOrder は VALUES 列 (v.base_order) を参照する = server は順序を計算しない', async () => {
    state.cardRows = [{ id: CARD_A }, { id: CARD_B }]

    await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    const baseOrder = state.setArg?.['baseOrder']
    expect(baseOrder).toBeInstanceOf(SQL)
    expect(render(baseOrder).sql).toBe('v.base_order')
    expect(state.setArg?.['examId']).toBe(EXAM_ID)
  })
})

describe('applyCardMove — 一括 UPDATE の形', () => {
  it('割当は 1 statement の VALUES join に畳まれ、 値は全て bind parameter', async () => {
    state.cardRows = [{ id: CARD_A }, { id: CARD_B }]

    await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    // per-card loop でないこと: UPDATE は 2 件の割当に対して 1 回だけ
    expect(state.updateCount).toBe(1)

    const from = render(state.fromArg)
    expect(from.sql).toBe(
      '(VALUES ($1::uuid, $2::int), ($3::uuid, $4::int)) AS v(id, base_order)',
    )
    // 値は param 側にだけ現れる (SQL 本文への文字列連結をしていない)
    expect(from.params).toEqual([CARD_A, 1024, CARD_B, 2048])
    expect(from.sql).not.toContain(CARD_A)
  })

  it('UPDATE の WHERE は owner-scope (user_id) + VALUES 行との id 突合', async () => {
    state.cardRows = [{ id: CARD_A }, { id: CARD_B }]

    await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    const where = render(state.updateWhere)
    expect(where.sql).toBe('("cards"."user_id" = $1 and "cards"."id" = v.id)')
    expect(where.params).toEqual([USER_ID])
  })
})

describe('applyCardMove — 移動先 exam の検証', () => {
  it('exam が不在 / 他 user (0 行) → failed で UPDATE を発行しない', async () => {
    state.examRows = []
    state.cardRows = [{ id: CARD_A }, { id: CARD_B }]

    const result = await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    expect(result).toBe('failed')
    expect(state.updateCount).toBe(0)
    // card 突合まで進まない (exam 検証が先)
    expect(state.selectTables).toEqual(['exams'])
  })

  it('exam 検証の WHERE は exam id + user_id (owner-scope)', async () => {
    state.cardRows = [{ id: CARD_A }]

    await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    const where = render(state.selectWheres[0])
    expect(where.sql).toBe('("exams"."id" = $1 and "exams"."user_id" = $2)')
    expect(where.params).toEqual([EXAM_ID, USER_ID])
  })
})

describe('applyCardMove — 不在 card の skip (spec §4.2)', () => {
  it('突合で見つからない card は VALUES から落として残りを適用し applied を返す', async () => {
    state.cardRows = [{ id: CARD_B }] // CARD_A は削除済 / 他 tenant

    const result = await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    expect(result).toBe('applied')
    const from = render(state.fromArg)
    expect(from.params).toEqual([CARD_B, 2048])
  })

  it('全件不在 → UPDATE を発行せず applied (空適用で outbox を掃かせる)', async () => {
    state.cardRows = []

    const result = await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    expect(result).toBe('applied')
    expect(state.updateCount).toBe(0)
  })

  it('card 突合は owner-scope + patch の id 集合で引く', async () => {
    state.cardRows = [{ id: CARD_A }, { id: CARD_B }]

    await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    expect(state.selectTables).toEqual(['exams', 'cards'])
    const where = render(state.selectWheres[1])
    expect(where.sql).toBe(
      '("cards"."user_id" = $1 and "cards"."id" in ($2, $3))',
    )
    expect(where.params).toEqual([USER_ID, CARD_A, CARD_B])
  })
})

describe('applyCardMove — 適用実績の構造化 log', () => {
  it('skip 有り → warn で requested / applied / skipped と exam id を 1 行 (prod 既定 level=warn で見える)', async () => {
    state.cardRows = [{ id: CARD_B }]

    await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    expect(loggerCalls).toHaveLength(1)
    // info だと prod 既定 LOG_LEVEL (warn) で落ちる = skip の不可視化防止が成立しない
    expect(loggerCalls[0]!.level).toBe('warn')
    expect(loggerCalls[0]!.payload).toMatchObject({
      event: 'card_move.applied',
      moveId: MOVE_ID,
      userId: USER_ID,
      examId: EXAM_ID,
      requested: 2,
      applied: 1,
      skipped: 1,
    })
  })

  it('skip 無し → info (通常の適用実績を prod の warn 以上に混ぜない)', async () => {
    state.cardRows = [{ id: CARD_A }, { id: CARD_B }]

    await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    expect(loggerCalls).toHaveLength(1)
    expect(loggerCalls[0]!.level).toBe('info')
    expect(loggerCalls[0]!.payload).toMatchObject({
      event: 'card_move.applied',
      requested: 2,
      applied: 2,
      skipped: 0,
    })
  })

  it('exam 不在で failed のときは log を出さない (適用していないため)', async () => {
    state.examRows = []

    await applyCardMove(makeTx(state), USER_ID, MOVE_ID, PATCH)

    expect(loggerCalls).toHaveLength(0)
  })
})
