import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName, Column, type SQL } from 'drizzle-orm'
import { cards, exams } from '@/lib/db/schema'

// saveExtractedCards (upload-persistence.ts) の characterization golden (F3 G1)。
//
// 参照事実 A: applyOcrTags は vi.mock で差し替える (find-or-create 2 段 × 3 table を
// executor fake で通すと fake が本体より複雑化し brittle。 G1 の pin 対象は card_count
// 面のみで tag 分解は無関係)。 mock ゆえ「同 tx object で 1 回呼ばれる」ことと inserted
// ids (zip 順) を引数で観測する。 rollback 経路 (applyOcrTags throw の tx 巻込) は mock
// 化のため観測不能 = G1 対象外。
//
// 期待値は全て現 HEAD の実挙動を観測して pin したもの (spec から推測しない)。
// SQL fragment は構造的観測 (render 文字列 pin はしない): sql object の queryChunks を
// 走査し (a) 参照 column (b) 数値 chunk 値 (c) GREATEST 有無 で判定する。

// ---------------------------------------------------------------------------
// drizzle-orm の eq を spy ラップ (owner-scope WHERE の観測用)。apply-card-mutation.test
// と同方式。 sql は real を通す (fragment 構造を観測するため)。
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
  }
})

// applyOcrTags を mock 化 (参照事実 A)。 本体 find-or-create は通さない。
// 実 applyOcrTags と同じ引数型 (tx, userId, cards) で spy を型付けし、 mock.calls から
// tx identity / inserted ids を型安全に取り出せるようにする。
type ApplyOcrTagsFn = typeof import('@/lib/tags/apply-ocr-tags').applyOcrTags
const applyOcrTagsMock =
  vi.fn<(...args: Parameters<ApplyOcrTagsFn>) => Promise<void>>(async () => undefined)
vi.mock('@/lib/tags/apply-ocr-tags', () => ({
  applyOcrTags: (...args: Parameters<ApplyOcrTagsFn>) => applyOcrTagsMock(...args),
}))

// ---------------------------------------------------------------------------
// sql fragment の構造的観測 helper
// ---------------------------------------------------------------------------

// queryChunks 内の Column instance の .name を列挙 (参照 column)。
function sqlColumnNames(frag: SQL): string[] {
  const chunks = (frag as unknown as { queryChunks?: unknown[] }).queryChunks ?? []
  return chunks.filter((c): c is Column => c instanceof Column).map((c) => c.name)
}

// queryChunks 内の StringChunk の value を連結 (GREATEST / now() 等 SQL キーワードの有無検査用)。
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
// executor fake (apply-card-mutation.test:255-298 の型踏襲)
// db = { transaction: (cb) => cb(tx) }。 tx は insert(cards).values().returning() で
// rows を捕捉し zip した [{id, title}] を返す / update(exams).set().where() を捕捉。
// ---------------------------------------------------------------------------

type SaveArgs = Parameters<
  typeof import('./upload-persistence').saveExtractedCards
>[1]

interface Captured {
  insertTable: unknown
  insertRows: SaveArgs['cardRows'] | null
  updateTable: unknown
  updateSet: Record<string, unknown> | null
  updateWhere: unknown
  // transaction callback に渡した tx object (identity 観測用)
  txHandedToCallback: unknown
  // returning() が返す zip 済 rows (applyOcrTags mock に渡る ids の期待値算出用)
  returnedRows: Array<{ id: string; title: string }> | null
}

function freshCaptured(): Captured {
  return {
    insertTable: null,
    insertRows: null,
    updateTable: null,
    updateSet: null,
    updateWhere: null,
    txHandedToCallback: null,
    returnedRows: null,
  }
}

// returning() が cards INSERT rows を id/title で zip して返す挙動を再現する。
// row.id は入力 row の id を使う (client 生成 id をそのまま採番する現挙動)。
// RLS-P3: saveExtractedCards は自前で transaction を開かず、caller (withTenantTx) が
// 張った tenant tx を受け取る。よって fake も transaction ラッパを持たず tx を直接返す。
// tx identity 観測点 (txHandedToCallback) = 渡す tx そのもの。
function makeDb(captured: Captured) {
  const tx: Record<string, unknown> = {}

  tx.insert = (table: unknown) => ({
    values: (rows: SaveArgs['cardRows']) => ({
      returning: (_cols?: unknown) => {
        captured.insertTable = table
        captured.insertRows = rows
        const zipped = rows.map((r) => ({
          id: (r as { id: string }).id,
          title: (r as { title: string }).title,
        }))
        captured.returnedRows = zipped
        return Promise.resolve(zipped)
      },
    }),
  })

  tx.update = (table: unknown) => ({
    set: (vals: Record<string, unknown>) => ({
      where: (predicate: unknown) => {
        captured.updateTable = table
        captured.updateSet = vals
        captured.updateWhere = predicate
        return Promise.resolve(undefined)
      },
    }),
  })

  captured.txHandedToCallback = tx

  return tx as unknown as Parameters<
    typeof import('./upload-persistence').saveExtractedCards
  >[0]
}

// N 件の cardRows を組む (id/title を index で採番)。 その他 column は現挙動観測に不要
// なので最小限 (fake は values をそのまま捕捉し returning で id/title を zip するだけ)。
function makeCardRows(n: number): SaveArgs['cardRows'] {
  return Array.from({ length: n }, (_, i) => ({
    id: `card-${i}`,
    userId: 'user-1',
    examId: 'exam-1',
    sourceDocumentId: 'src-1',
    title: `title-${i}`,
    questionText: `q-${i}`,
    options: [{ id: 'a', text: 'A', is_correct: true }],
    correctAnswerIds: ['a'],
  })) as unknown as SaveArgs['cardRows']
}

describe('saveExtractedCards (F3 G1 characterization)', () => {
  let captured: Captured

  beforeEach(() => {
    vi.clearAllMocks()
    captured = freshCaptured()
  })

  it('cards INSERT rows = 渡した cardRows そのまま (N 件)', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(3)
    await saveExtractedCards(makeDb(captured), {
      userId: 'user-1',
      examId: 'exam-1',
      cardRows,
      customProps: [undefined, undefined, undefined],
    })
    expect(getTableName(captured.insertTable as never)).toBe(getTableName(cards))
    expect(captured.insertRows).toBe(cardRows)
    expect(captured.insertRows).toHaveLength(3)
  })

  it('戻り値 = returning() の zip 済 [{id, title}] (N 件)', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(3)
    const result = await saveExtractedCards(makeDb(captured), {
      userId: 'user-1',
      examId: 'exam-1',
      cardRows,
      customProps: [undefined, undefined, undefined],
    })
    expect(result).toEqual([
      { id: 'card-0', title: 'title-0' },
      { id: 'card-1', title: 'title-1' },
      { id: 'card-2', title: 'title-2' },
    ])
  })

  it('set.cardCount fragment = exams.card_count 参照 + 数値 param N (現挙動: 素加算)', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(3)
    await saveExtractedCards(makeDb(captured), {
      userId: 'user-1',
      examId: 'exam-1',
      cardRows,
      customProps: [undefined, undefined, undefined],
    })
    const cardCount = captured.updateSet!.cardCount as SQL
    // (a) 参照 column = exams.card_count
    expect(sqlColumnNames(cardCount)).toContain('card_count')
    // (b) 数値 param = cardRows.length (= 3)
    expect(sqlNumberChunks(cardCount)).toContain(3)
    // (c) GREATEST は不在 (create/OCR path は素加算)
    expect(sqlStaticText(cardCount)).not.toContain('GREATEST')
  })

  it('set.updatedAt = exams.updated_at 自己参照 (now() 不在 — card 増減で updatedAt を動かさない)', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(2)
    await saveExtractedCards(makeDb(captured), {
      userId: 'user-1',
      examId: 'exam-1',
      cardRows,
      customProps: [undefined, undefined],
    })
    const updatedAt = captured.updateSet!.updatedAt as SQL
    expect(sqlColumnNames(updatedAt)).toEqual(['updated_at'])
    expect(sqlStaticText(updatedAt).toLowerCase()).not.toContain('now(')
  })

  it('exams UPDATE の WHERE に eq(exams.id, examId) + eq(exams.userId, userId)', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(1)
    await saveExtractedCards(makeDb(captured), {
      userId: 'user-1',
      examId: 'exam-1',
      cardRows,
      customProps: [undefined],
    })
    expect(getTableName(captured.updateTable as never)).toBe(getTableName(exams))
    const { eq } = await import('drizzle-orm')
    const sig = (
      vi.mocked(eq).mock.calls as [{ name?: string; table?: unknown }, unknown][]
    ).map(([col, val]) => {
      const tableName = col.table ? getTableName(col.table as never) : ''
      return [tableName, col.name, val] as [string, string, unknown]
    })
    expect(sig).toContainEqual(['exams', 'id', 'exam-1'])
    expect(sig).toContainEqual(['exams', 'user_id', 'user-1'])
  })

  it('applyOcrTags mock が「transaction callback の tx object」+ inserted ids (zip 順) で 1 回呼ばれる', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(3)
    await saveExtractedCards(makeDb(captured), {
      userId: 'user-1',
      examId: 'exam-1',
      cardRows,
      customProps: ['p0', 'p1', 'p2'] as unknown as SaveArgs['customProps'],
    })
    expect(applyOcrTagsMock).toHaveBeenCalledTimes(1)
    const [txArg, userIdArg, ocrCards] = applyOcrTagsMock.mock.calls[0]!
    // 同一 tx object identity (transaction callback が受けた tx と同一)
    expect(txArg).toBe(captured.txHandedToCallback)
    expect(userIdArg).toBe('user-1')
    // inserted ids を zip 順で (returning row の id と customProps[i] を対応させる)
    expect(ocrCards).toEqual([
      { id: 'card-0', custom_props: 'p0' },
      { id: 'card-1', custom_props: 'p1' },
      { id: 'card-2', custom_props: 'p2' },
    ])
  })

  it('exams UPDATE は渡された tx 経由で発生する (tx identity)', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(1)
    // update() を呼んだ tx の identity を捕捉し、 渡した tx と一致することを確認する。
    let txUsedByUpdate: unknown = null
    const tx: Record<string, unknown> = {}
    tx.insert = (_table: unknown) => ({
      values: (rows: SaveArgs['cardRows']) => ({
        returning: () =>
          Promise.resolve(
            rows.map((r) => ({
              id: (r as { id: string }).id,
              title: (r as { title: string }).title,
            })),
          ),
      }),
    })
    tx.update = (_table: unknown) => {
      txUsedByUpdate = tx
      return {
        set: () => ({ where: () => Promise.resolve(undefined) }),
      }
    }

    await saveExtractedCards(
      tx as unknown as Parameters<
        typeof import('./upload-persistence').saveExtractedCards
      >[0],
      {
        userId: 'user-1',
        examId: 'exam-1',
        cardRows,
        customProps: [undefined],
      },
    )
    expect(txUsedByUpdate).toBe(tx)
  })
})
