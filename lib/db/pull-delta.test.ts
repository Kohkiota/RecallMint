// pull-delta test — getDeltaRows(統合 /api/pull の共有 delta 取得 factory)の
// 直接 test + tag 系 3 caller(tag-categories / tag-options / card-tags)の
// owner-scope pin(監査 2026-07-17 G2 追加対処 — 監査 doc が Minor に落とした
// 「pull stream の eq 未 pin」を対処。pull は user のデータ一式を client に返す
// 経路で leak 時の blast radius が大きく、RLS 全無効の本構成では app コードの
// eq(userId) が唯一のテナント隔離防壁のため)。
//
// getDeltaRows は 6 module(cards / exams / tag-categories / tag-options /
// card-tags / tombstones)の共有チョークポイント。cards / exams / tombstones の
// eq(userId) は各 *-delta / tombstones-pull test で pin 済、本 file は factory 本体
// (pull-delta.ts:39)と tag 系 3 caller が正しい userIdCol を渡していることを pin する。
//
// 【この pin の限界】eq-spy は「eq が userId 列と userId 値で呼ばれた」という構造の
// pin であり、テナント隔離の証明ではない。最終 SQL の WHERE に条件が届いているか /
// (参照同一性以上の意味で)正しいテーブルの列と比較しているか / 別の条件で無効化
// されていないか / ストリームの後続チャンクで条件が消えていないか は検証しない。
// 回帰ガードとして有効だがセキュリティ保証として数えない。実効(実際に他 user の
// 行が除外されること)の検証は実 PostgreSQL 2 テナント統合テスト(follow-up、
// docs/audit/2026-07-17-test-quality-audit.md 台帳)の責務。

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRows } = vi.hoisted(() => ({
  mockRows: { value: [] as unknown[] },
}))

// drizzle-orm: eq / gte をスパイ化し、実動作は real に委譲(cards-delta.test.ts 前例)
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  const spyEq = vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args))
  const spyGte = vi.fn(
    (...args: Parameters<typeof real.gte>) => real.gte(...args),
  )
  return { ...real, eq: spyEq, gte: spyGte }
})

// @/lib/db: select().from().where() が mockRows を返す chain mock
vi.mock('@/lib/db', () => {
  function makeSelectChain(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    obj['from'] = (_table: unknown) => ({
      where: (_cond: unknown) => Promise.resolve(mockRows.value),
    })
    return obj
  }
  return { getDb: () => ({ select: () => makeSelectChain() }) }
})

async function getSpies() {
  const { eq, gte } = await import('drizzle-orm')
  return { spyEq: vi.mocked(eq), spyGte: vi.mocked(gte) }
}

// schema / subject は静的 import しない: mock 適用後の module インスタンスを
// 一致させ column 参照の同一性で assert するため(cards-delta.test.ts 前例)。
async function getSchema() {
  return await import('./schema')
}

beforeEach(async () => {
  const { spyEq, spyGte } = await getSpies()
  spyEq.mockClear()
  spyGte.mockClear()
  mockRows.value = []
})

describe('getDeltaRows (factory 直接)', () => {
  async function makeConfig() {
    const { tagCategories } = await getSchema()
    return {
      table: tagCategories,
      userIdCol: tagCategories.userId,
      cursorCol: tagCategories.updatedAt,
      mapper: (row: { id: string; updatedAt: Date }) => ({
        id: row.id,
        updated_at: row.updatedAt.toISOString(),
      }),
      cursorValueOf: (r: { updated_at: string }) => r.updated_at,
    }
  }

  it('eq(userIdCol, userId) が必ず呼ばれる (owner-scope・since 有無に依らず)', async () => {
    const { getDeltaRows } = await import('./pull-delta')
    const { tagCategories } = await getSchema()
    await getDeltaRows(await makeConfig(), 'user-1')
    const { spyEq } = await getSpies()
    expect(spyEq).toHaveBeenCalledWith(tagCategories.userId, 'user-1')
  })

  it('since 指定時に gte(cursorCol, since) が呼ばれ、未指定時は呼ばれない', async () => {
    const { getDeltaRows } = await import('./pull-delta')
    const { tagCategories } = await getSchema()
    const { spyGte } = await getSpies()

    const since = new Date('2026-05-05T00:00:00.000Z')
    await getDeltaRows(await makeConfig(), 'user-1', since)
    expect(spyGte).toHaveBeenCalledWith(tagCategories.updatedAt, since)

    spyGte.mockClear()
    await getDeltaRows(await makeConfig(), 'user-1')
    expect(spyGte).not.toHaveBeenCalled()
  })

  it('rows は mapper 適用済 + max は cursorValueOf の最大 ISO / 0 行で rows=[] max=null', async () => {
    const { getDeltaRows } = await import('./pull-delta')
    mockRows.value = [
      { id: 'a', updatedAt: new Date('2026-05-01T10:00:00.000Z') },
      { id: 'b', updatedAt: new Date('2026-05-10T12:00:00.000Z') },
    ]
    const result = await getDeltaRows(await makeConfig(), 'user-1')
    expect(result.rows).toEqual([
      { id: 'a', updated_at: '2026-05-01T10:00:00.000Z' },
      { id: 'b', updated_at: '2026-05-10T12:00:00.000Z' },
    ])
    expect(result.max).toBe('2026-05-10T12:00:00.000Z')

    mockRows.value = []
    const empty = await getDeltaRows(await makeConfig(), 'user-1')
    expect(empty.rows).toEqual([])
    expect(empty.max).toBeNull()
  })
})

describe('tag 系 3 caller の owner-scope pin (正しい userIdCol を getDeltaRows に渡す)', () => {
  it('getCategoriesDelta: eq(tagCategories.userId, userId) が呼ばれる', async () => {
    const { getCategoriesDelta } = await import('./tag-categories-pull')
    const { tagCategories } = await getSchema()
    await getCategoriesDelta('user-1')
    expect((await getSpies()).spyEq).toHaveBeenCalledWith(
      tagCategories.userId,
      'user-1',
    )
  })

  it('getOptionsDelta: eq(tagOptions.userId, userId) が呼ばれる', async () => {
    const { getOptionsDelta } = await import('./tag-options-pull')
    const { tagOptions } = await getSchema()
    await getOptionsDelta('user-1')
    expect((await getSpies()).spyEq).toHaveBeenCalledWith(
      tagOptions.userId,
      'user-1',
    )
  })

  it('getCardTagsDelta: eq(cardTags.userId, userId) が呼ばれる', async () => {
    const { getCardTagsDelta } = await import('./card-tags-pull')
    const { cardTags } = await getSchema()
    await getCardTagsDelta('user-1')
    expect((await getSpies()).spyEq).toHaveBeenCalledWith(
      cardTags.userId,
      'user-1',
    )
  })
})
