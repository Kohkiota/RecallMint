import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { cards } from '@/lib/db/schema'

// saveExtractedCards (upload-persistence.ts) の characterization golden (F3 G1)。
//
// 参照事実 A: applyOcrTags は vi.mock で差し替える (find-or-create 2 段 × 3 table を
// executor fake で通すと fake が本体より複雑化し brittle)。 mock ゆえ「同 tx object で
// 1 回呼ばれる」ことと inserted ids (zip 順) を引数で観測する。 rollback 経路
// (applyOcrTags throw の tx 巻込) は mock 化のため観測不能 = G1 対象外。
//
// 期待値は全て現 HEAD の実挙動を観測して pin したもの (spec から推測しない)。
// Sprint B (DB 全体掃除) T5: card_count bump (exams.card_count += N) の pin は撤去し、
// cards INSERT のみで exams UPDATE を発行しないことを pin する (置換 pin)。

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
// executor fake (apply-card-mutation.test:255-298 の型踏襲)
// db = { transaction: (cb) => cb(tx) }。 tx は insert(cards).values().returning() で
// rows を捕捉し zip した [{id, title}] を返す / update() が呼ばれた場合はそれも捕捉
// する (呼ばれないことを pin する側の観測用、 Sprint B T5)。
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
      cardRows,
      customProps: [undefined, undefined, undefined],
    })
    expect(result).toEqual([
      { id: 'card-0', title: 'title-0' },
      { id: 'card-1', title: 'title-1' },
      { id: 'card-2', title: 'title-2' },
    ])
  })

  // Sprint B (DB 全体掃除) T5 置換 pin: 旧 'set.cardCount fragment...' / 'set.updatedAt...'
  // / 'exams UPDATE の WHERE...' の 3 test を置換。 saveExtractedCards は cards INSERT +
  // applyOcrTags のみを行い、 exams table への UPDATE を一切発行しないことを mock tx の
  // 呼出履歴で保証する。
  it('cards INSERT のみを行い、 exams UPDATE を発行しない', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(2)
    await saveExtractedCards(makeDb(captured), {
      userId: 'user-1',
      cardRows,
      customProps: [undefined, undefined],
    })
    expect(getTableName(captured.insertTable as never)).toBe(getTableName(cards))
    expect(captured.updateTable).toBeNull()
    expect(captured.updateSet).toBeNull()
  })

  it('applyOcrTags mock が「transaction callback の tx object」+ inserted ids (zip 順) で 1 回呼ばれる', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(3)
    await saveExtractedCards(makeDb(captured), {
      userId: 'user-1',
      cardRows,
      // ②-4a T12 §改修: 引数型が discriminated union 化したため
      // `SaveArgs['customProps']` は `Array<...> | undefined` になった。 legacy
      // positional 経路の cast target は非 null の配列型に固定する(NonNullable で
      // union の undefined 枝を除去・runtime 値と assertion は不変 = 保証不変)。
      customProps: ['p0', 'p1', 'p2'] as unknown as NonNullable<SaveArgs['customProps']>,
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

  // ②-4a T12 §改修: publisher 経路(customPropsById)は RETURNING 順に依存せず
  // card ID で custom_props を引く。 legacy positional 経路(上の全 test)は byte-for-byte
  // 不変で、 この test は新経路の対応付けだけを pin する。
  it('customPropsById 経路: inserted row.id で custom_props を引く (RETURNING 順非依存)', async () => {
    const { saveExtractedCards } = await import('./upload-persistence')
    const cardRows = makeCardRows(3)
    await saveExtractedCards(makeDb(captured), {
      userId: 'user-1',
      cardRows,
      customPropsById: {
        // わざと cardRows と異なる key 順で定義し、 positional でなく id lookup で
        // あることを示す。
        'card-2': { year: '2026' },
        'card-0': { subject: 'math' },
        'card-1': { unit: ['a', 'b'] },
      },
    })
    expect(applyOcrTagsMock).toHaveBeenCalledTimes(1)
    const [txArg, userIdArg, ocrCards] = applyOcrTagsMock.mock.calls[0]!
    expect(txArg).toBe(captured.txHandedToCallback)
    expect(userIdArg).toBe('user-1')
    // RETURNING(= zip 順 card-0/1/2)に対し、 各 row の id で custom_props を引く。
    expect(ocrCards).toEqual([
      { id: 'card-0', custom_props: { subject: 'math' } },
      { id: 'card-1', custom_props: { unit: ['a', 'b'] } },
      { id: 'card-2', custom_props: { year: '2026' } },
    ])
  })
})
