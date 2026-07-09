import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName, Column, type SQL } from 'drizzle-orm'
import { exams } from '@/lib/db/schema'

// bumpExamCardCount (card-count.ts) の helper 単体 contract test。
//
// 位置づけ: これは helper 自身の符号分岐 contract (delta>0 素加算 / delta<0 GREATEST)
// の直テスト。 G1/G2 (consumer 側 golden = 呼び出し文脈の挙動) とは二層で、 重複でなく
// helper 単体の分岐保証を担う (spec §3.5 / Codex 指摘)。
//
// SQL fragment は構造的観測 (render 文字列 pin はしない): queryChunks を走査し
// (a) 参照 column (b) 数値 chunk 値 (c) GREATEST 有無 で判定する
// (apply-card-mutation.test / upload-persistence.test と同 helper)。
//
// owner-scope (WHERE の eq) は drizzle-orm の eq spy で観測する。 sql は real を通す
// (fragment 構造を観測するため)。

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
  }
})

// ---------------------------------------------------------------------------
// sql fragment の構造的観測 helper (golden と同型)
// ---------------------------------------------------------------------------

// queryChunks 内の Column instance の .name を列挙 (参照 column)。
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

// queryChunks 内の raw number chunk を列挙 (`sql\`... + ${N}\`` の N は生 number chunk)。
function sqlNumberChunks(frag: SQL): number[] {
  const chunks = (frag as unknown as { queryChunks?: unknown[] }).queryChunks ?? []
  return chunks.filter((c): c is number => typeof c === 'number')
}

// ---------------------------------------------------------------------------
// executor fake: update(exams).set().where() を捕捉するだけ (helper は他を呼ばない)。
// ---------------------------------------------------------------------------

interface Captured {
  updateTable: unknown
  updateSet: Record<string, unknown> | null
}

function makeTx(captured: Captured) {
  const tx: Record<string, unknown> = {}
  tx.update = (table: unknown) => ({
    set: (vals: Record<string, unknown>) => {
      captured.updateTable = table
      captured.updateSet = vals
      return {
        where: () => Promise.resolve(undefined),
      }
    },
  })
  return tx as Parameters<
    typeof import('./card-count').bumpExamCardCount
  >[0]
}

// eq spy 呼出から [tableName, columnName, value] を作る。
async function eqSignature() {
  const { eq } = await import('drizzle-orm')
  return (
    vi.mocked(eq).mock.calls as [{ name?: string; table?: unknown }, unknown][]
  ).map(([col, val]) => {
    const tableName = col.table ? getTableName(col.table as never) : ''
    return [tableName, col.name, val] as [string, string, unknown]
  })
}

describe('bumpExamCardCount (helper contract)', () => {
  let captured: Captured

  beforeEach(() => {
    vi.clearAllMocks()
    captured = { updateTable: null, updateSet: null }
  })

  it('delta > 0 (+1): card_count 参照 + 素加算 (GREATEST 不在) + number chunk 1', async () => {
    const { bumpExamCardCount } = await import('./card-count')
    await bumpExamCardCount(makeTx(captured), {
      examId: 'exam-1',
      userId: 'user-1',
      delta: 1,
    })
    const cardCount = captured.updateSet!.cardCount as SQL
    expect(sqlColumnNames(cardCount)).toContain('card_count')
    expect(sqlStaticText(cardCount)).not.toContain('GREATEST')
    expect(sqlNumberChunks(cardCount)).toContain(1)
  })

  it('delta < 0 (-1): GREATEST 負ガード + card_count 参照 + number chunk -1', async () => {
    const { bumpExamCardCount } = await import('./card-count')
    await bumpExamCardCount(makeTx(captured), {
      examId: 'exam-1',
      userId: 'user-1',
      delta: -1,
    })
    const cardCount = captured.updateSet!.cardCount as SQL
    expect(sqlColumnNames(cardCount)).toContain('card_count')
    expect(sqlStaticText(cardCount)).toContain('GREATEST')
    // delta は既に負 (+ ${-1}) = 実質減算。number chunk は -1。
    expect(sqlNumberChunks(cardCount)).toContain(-1)
  })

  it('delta > 0 (+5): number chunk 5 + 素加算 (GREATEST 不在)', async () => {
    const { bumpExamCardCount } = await import('./card-count')
    await bumpExamCardCount(makeTx(captured), {
      examId: 'exam-1',
      userId: 'user-1',
      delta: 5,
    })
    const cardCount = captured.updateSet!.cardCount as SQL
    expect(sqlNumberChunks(cardCount)).toContain(5)
    expect(sqlStaticText(cardCount)).not.toContain('GREATEST')
  })

  it('set.updatedAt = exams.updated_at 自己参照 (now() 不在)', async () => {
    const { bumpExamCardCount } = await import('./card-count')
    await bumpExamCardCount(makeTx(captured), {
      examId: 'exam-1',
      userId: 'user-1',
      delta: 1,
    })
    const updatedAt = captured.updateSet!.updatedAt as SQL
    expect(sqlColumnNames(updatedAt)).toEqual(['updated_at'])
    expect(sqlStaticText(updatedAt).toLowerCase()).not.toContain('now(')
  })

  it('owner-scope: UPDATE table = exams / WHERE に eq(exams.id) + eq(exams.userId)', async () => {
    const { bumpExamCardCount } = await import('./card-count')
    await bumpExamCardCount(makeTx(captured), {
      examId: 'exam-1',
      userId: 'user-1',
      delta: 1,
    })
    expect(getTableName(captured.updateTable as never)).toBe(getTableName(exams))
    const sig = await eqSignature()
    expect(sig).toContainEqual(['exams', 'id', 'exam-1'])
    expect(sig).toContainEqual(['exams', 'user_id', 'user-1'])
  })
})
