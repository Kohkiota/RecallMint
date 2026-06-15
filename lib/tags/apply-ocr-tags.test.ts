import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { tagCategories, tagOptions, cardTags } from '@/lib/db/schema'

// apply-ocr-tags.ts unit test (Tag-3 T1)。
//
// 観点 (spec §7 二分化):
//   (a) 構造 + 値 correctness 8 case:
//     1. find: 既存 category / option が trim 一致で再利用される (新規 INSERT 0 回)
//     2. create: 新規 category default = select_type='multi' / color=null / sort_key 末尾
//     3. create: 新規 option default = color=null / sort_key 同 category 内末尾累積
//     4. 集約: 同 upload 内同名 (category / option) は同 id 流用 (1 INSERT のみ)
//     5. trim: '年度 ' と '年度' を同 row として merge する
//     6. card_tags: (card_id, option_id) PK で同 pair 重複なし
//     7. rollback: 予期せぬ DB error (ON CONFLICT 外) → throw 伝播
//     8. race conflict 正常系: Step 1 SELECT 空 → Step 2 INSERT DO NOTHING → Step 3 再 SELECT で id 回収
//   (b-i) tenant isolation 構造 1 case:
//     9. 全 SELECT / INSERT 句に userId が含まれる (eq spy で構造保証)
//
// tx は drizzle builder を模倣する mock。 実 DB 接続なし。

// ---------------------------------------------------------------------------
// drizzle-orm の eq / and / inArray を spy ラップ
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
    inArray: vi.fn(
      (...args: Parameters<typeof real.inArray>) => real.inArray(...args),
    ),
  }
})

// ---------------------------------------------------------------------------
// in-memory store + drizzle tx mock
// ---------------------------------------------------------------------------

type CategoryRow = {
  id: string
  userId: string
  name: string
  selectType: 'single' | 'multi'
  color: string | null
  sortKey: string | null
}

type OptionRow = {
  id: string
  userId: string
  categoryId: string
  name: string
  color: string | null
  sortKey: string | null
}

type CardTagRow = {
  cardId: string
  optionId: string
  userId: string
}

interface Store {
  categories: CategoryRow[]
  options: OptionRow[]
  cardTags: CardTagRow[]
}

interface Captured {
  // 各 INSERT の入力 values を順に記録する。 bulk INSERT も values: [...] の単一 call 想定。
  categoryInserts: Record<string, unknown>[][]
  optionInserts: Record<string, unknown>[][]
  cardTagInserts: Record<string, unknown>[][]
  selectCount: number
  // race ケース: Step 2 INSERT が DO NOTHING で 0 行扱いになった後、 Step 3 再 SELECT で
  // 並走 INSERT の row を返す模擬を仕込むためのフック (table 名で differential)。
  // null なら既定 (store からの read) を返す。
  selectOverride: ((tableName: string, callIndex: number) => unknown[] | null) | null
  // 予期せぬ DB error 注入 (case 7)。
  throwOnInsert: { table: 'tag_categories' | 'tag_options' | 'card_tags'; error: Error } | null
}

function freshStore(): Store {
  return { categories: [], options: [], cardTags: [] }
}

function freshCaptured(): Captured {
  return {
    categoryInserts: [],
    optionInserts: [],
    cardTagInserts: [],
    selectCount: 0,
    selectOverride: null,
    throwOnInsert: null,
  }
}

function makeTx(store: Store, captured: Captured) {
  // drizzle builder を最低限の chain で模倣する。 WHERE predicate は実 SQL を組まないので、
  // store 上の row を「同 table の find が呼ばれたら全件返す」 簡易応答にする。 race ケース
  // 等で differential な結果を返したい場合は captured.selectOverride を使う。
  const tx: Record<string, unknown> = {}

  tx.select = (_cols?: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: async (_predicate?: unknown) => {
        const name = getTableName(table as never)
        const callIndex = captured.selectCount
        captured.selectCount += 1
        if (captured.selectOverride) {
          const override = captured.selectOverride(name, callIndex)
          if (override !== null) return override
        }
        if (name === getTableName(tagCategories)) {
          return store.categories.map((c) => ({
            id: c.id,
            name: c.name,
            sortKey: c.sortKey,
          }))
        }
        if (name === getTableName(tagOptions)) {
          return store.options.map((o) => ({
            id: o.id,
            name: o.name,
            categoryId: o.categoryId,
            sortKey: o.sortKey,
          }))
        }
        return []
      },
    }),
  })

  tx.insert = (table: unknown) => {
    const name = getTableName(table as never)
    return {
      values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(vals) ? vals : [vals]

        const finalize = () => {
          if (
            captured.throwOnInsert &&
            captured.throwOnInsert.table === name
          ) {
            throw captured.throwOnInsert.error
          }
          if (name === getTableName(tagCategories)) {
            captured.categoryInserts.push(arr)
            for (const v of arr) {
              if (!store.categories.find((c) => c.id === v.id)) {
                store.categories.push({
                  id: v.id as string,
                  userId: v.userId as string,
                  name: v.name as string,
                  selectType: v.selectType as 'single' | 'multi',
                  color: (v.color as string | null) ?? null,
                  sortKey: (v.sortKey as string | null) ?? null,
                })
              }
            }
          } else if (name === getTableName(tagOptions)) {
            captured.optionInserts.push(arr)
            for (const v of arr) {
              if (!store.options.find((o) => o.id === v.id)) {
                store.options.push({
                  id: v.id as string,
                  userId: v.userId as string,
                  categoryId: v.categoryId as string,
                  name: v.name as string,
                  color: (v.color as string | null) ?? null,
                  sortKey: (v.sortKey as string | null) ?? null,
                })
              }
            }
          } else if (name === getTableName(cardTags)) {
            captured.cardTagInserts.push(arr)
            for (const v of arr) {
              if (
                !store.cardTags.find(
                  (ct) => ct.cardId === v.cardId && ct.optionId === v.optionId,
                )
              ) {
                store.cardTags.push({
                  cardId: v.cardId as string,
                  optionId: v.optionId as string,
                  userId: v.userId as string,
                })
              }
            }
          }
        }

        return {
          onConflictDoNothing: () => {
            finalize()
            return Promise.resolve(undefined)
          },
          // card_tags の plain INSERT (ON CONFLICT 不要、 同 pair 構造的に発生しない) は
          // Promise を直接 await する経路もあるので thenable interface を持たせる。
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
            try {
              finalize()
            } catch (e) {
              if (reject) return reject(e)
              throw e
            }
            return resolve(undefined)
          },
        }
      },
    }
  }

  return tx as Parameters<
    typeof import('./apply-ocr-tags').applyOcrTags
  >[0]
}

// ---------------------------------------------------------------------------
// (a) 構造 + 値 correctness
// ---------------------------------------------------------------------------

describe('applyOcrTags (a) correctness', () => {
  let store: Store
  let captured: Captured

  beforeEach(() => {
    vi.clearAllMocks()
    store = freshStore()
    captured = freshCaptured()
  })

  it('case 1: 既存 category / option が trim 一致で再利用される (新規 INSERT 0 回)', async () => {
    // 既存 category 「年度」 + 既存 option 「2024」 を pre-seed。
    store.categories.push({
      id: 'cat-existing',
      userId: 'user-1',
      name: '年度',
      selectType: 'multi',
      color: null,
      sortKey: '0',
    })
    store.options.push({
      id: 'opt-existing',
      userId: 'user-1',
      categoryId: 'cat-existing',
      name: '2024',
      color: null,
      sortKey: '0',
    })

    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '年度': '2024' } },
    ])

    expect(captured.categoryInserts).toHaveLength(0)
    expect(captured.optionInserts).toHaveLength(0)
    // card_tags は 1 件 INSERT される (既存 option_id 再利用)
    expect(captured.cardTagInserts).toHaveLength(1)
    expect(captured.cardTagInserts[0]).toEqual([
      { cardId: 'card-1', optionId: 'opt-existing', userId: 'user-1' },
    ])
  })

  it('case 2: 新規 category default = select_type=multi / color=null / sort_key=末尾', async () => {
    // 既存 category 1 件 (sort_key='0') を pre-seed、 新規は sort_key='1' になるはず。
    store.categories.push({
      id: 'cat-pre',
      userId: 'user-1',
      name: 'pre',
      selectType: 'single',
      color: 'red',
      sortKey: '0',
    })

    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': '微積' } },
    ])

    expect(captured.categoryInserts).toHaveLength(1)
    const cat = captured.categoryInserts[0]![0]!
    expect(cat).toMatchObject({
      userId: 'user-1',
      name: '分野',
      selectType: 'multi',
      color: null,
      sortKey: '1',
    })
    // id は server 採番 (uuid) で string であれば良い (固定値 assert しない)
    expect(typeof cat.id).toBe('string')
    expect((cat.id as string).length).toBeGreaterThan(0)
  })

  it('case 2-b: 空 DB なら新規 category sort_key=0', async () => {
    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': '微積' } },
    ])
    expect(captured.categoryInserts[0]![0]).toMatchObject({ sortKey: '0' })
    expect(captured.optionInserts[0]![0]).toMatchObject({ sortKey: '0' })
  })

  it('case 3: 新規 option default = color=null / sort_key 同 category 内末尾累積', async () => {
    // 同 upload 内に同 category の新規 option を 3 件作る (in-memory 累積 0,1,2)。
    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': ['微積', '線形代数', '統計'] } },
    ])
    expect(captured.optionInserts).toHaveLength(1)
    const opts = captured.optionInserts[0]!
    expect(opts).toHaveLength(3)
    const sortKeys = opts.map((o) => o.sortKey).sort()
    expect(sortKeys).toEqual(['0', '1', '2'])
    for (const opt of opts) {
      expect(opt).toMatchObject({ color: null, userId: 'user-1' })
    }
  })

  it('case 4: 同 upload 内同名 (category / option) は同 id 流用 (1 INSERT のみ)', async () => {
    // 5 cards すべて 年度=2024 → category 1 INSERT、 option 1 INSERT、 card_tags 5 行
    const { applyOcrTags } = await import('./apply-ocr-tags')
    const cards = [1, 2, 3, 4, 5].map((i) => ({
      id: `card-${i}`,
      custom_props: { '年度': '2024' },
    }))
    await applyOcrTags(makeTx(store, captured), 'user-1', cards)

    expect(captured.categoryInserts).toHaveLength(1)
    expect(captured.categoryInserts[0]).toHaveLength(1)
    expect(captured.optionInserts).toHaveLength(1)
    expect(captured.optionInserts[0]).toHaveLength(1)
    // 5 cards 分の card_tags 行が同 option_id を参照
    const optionId = captured.optionInserts[0]![0]!.id
    expect(captured.cardTagInserts).toHaveLength(1)
    expect(captured.cardTagInserts[0]).toHaveLength(5)
    for (const ct of captured.cardTagInserts[0]!) {
      expect(ct.optionId).toBe(optionId)
    }
  })

  it('case 5: trim 効果 — \'年度 \' と \'年度\' を同 row として merge する', async () => {
    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '年度 ': '2024' } },
      { id: 'card-2', custom_props: { '年度': ' 2024 ' } },
    ])
    // category も option も 1 件のみ INSERT (trim で同一化)
    expect(captured.categoryInserts[0]).toHaveLength(1)
    expect(captured.categoryInserts[0]![0]!.name).toBe('年度')
    expect(captured.optionInserts[0]).toHaveLength(1)
    expect(captured.optionInserts[0]![0]!.name).toBe('2024')
    // card_tags は 2 行 (両 card に紐づく)
    expect(captured.cardTagInserts[0]).toHaveLength(2)
  })

  it('case 5-b: 空文字 / 空白のみ key / value は skip', async () => {
    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '': '2024', '年度': '   ', '分野': '微積' } },
      { id: 'card-2', custom_props: { '   ': 'x' } },
    ])
    // '分野=微積' のみ残る
    expect(captured.categoryInserts[0]).toHaveLength(1)
    expect(captured.categoryInserts[0]![0]!.name).toBe('分野')
    expect(captured.optionInserts[0]).toHaveLength(1)
    expect(captured.optionInserts[0]![0]!.name).toBe('微積')
    expect(captured.cardTagInserts[0]).toHaveLength(1)
  })

  it('case 6: card_tags は (card_id, option_id) PK で同 pair 重複なし', async () => {
    // 同 card に同 option が array で 2 回出現するケース (custom_props value array に重複)。
    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': ['微積', '微積'] } },
    ])
    // option INSERT は trim + 集約で 1 件のみ
    expect(captured.optionInserts[0]).toHaveLength(1)
    // card_tags も 1 件 (同 pair 重複なし)
    expect(captured.cardTagInserts[0]).toHaveLength(1)
  })

  it('case 7: rollback — 予期せぬ DB error が ON CONFLICT 外で throw する → 呼び出し元に伝播', async () => {
    captured.throwOnInsert = {
      table: 'tag_categories',
      error: new Error('boom: NOT NULL violation'),
    }
    const { applyOcrTags } = await import('./apply-ocr-tags')
    await expect(
      applyOcrTags(makeTx(store, captured), 'user-1', [
        { id: 'card-1', custom_props: { '分野': '微積' } },
      ]),
    ).rejects.toThrow(/boom/)
    // throw 後の後続 INSERT は走らない
    expect(captured.optionInserts).toHaveLength(0)
    expect(captured.cardTagInserts).toHaveLength(0)
  })

  it('case 8: race 正常系 — Step 1 空 → Step 2 INSERT DO NOTHING → Step 3 再 SELECT で id 回収', async () => {
    // Step 1 (category find) で空、 Step 2 INSERT 後、 Step 3 (category 再 SELECT) で
    // 並走 INSERT 済の row を返す。 helper の SELECT 呼出順は:
    //   call 0: tag_categories (find)
    //   call 1: tag_options (find)
    //   call 2: tag_categories (再 SELECT 、 並走 INSERT row を返す)
    //   call 3: tag_options (再 SELECT 、 並走 INSERT row を返す)
    captured.selectOverride = (tableName, callIndex) => {
      // Step 1 は空 / Step 3 (再 SELECT) で並走 row を返す
      if (callIndex === 0 || callIndex === 1) return [] // Step 1 / Step 1' 空
      if (tableName === getTableName(tagCategories)) {
        return [{ id: 'cat-race', name: '分野', sortKey: '0' }]
      }
      if (tableName === getTableName(tagOptions)) {
        return [
          { id: 'opt-race', name: '微積', categoryId: 'cat-race', sortKey: '0' },
        ]
      }
      return null
    }

    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': '微積' } },
    ])

    // INSERT は走った (DO NOTHING は throw しない正常系)、 ただし helper は再 SELECT で
    // 並走 row の id を回収し、 card_tags 作成まで正常継続する。
    expect(captured.cardTagInserts).toHaveLength(1)
    expect(captured.cardTagInserts[0]).toEqual([
      { cardId: 'card-1', optionId: 'opt-race', userId: 'user-1' },
    ])
  })

  it('case 9 (b-i): tenant isolation 構造 — SELECT / INSERT 句に userId が必ず含まれる', async () => {
    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': '微積' } },
    ])

    // eq spy 呼出から (table, column, value) signature を抜き出して userId 渡し構造を gate
    const { eq } = await import('drizzle-orm')
    const calls = vi.mocked(eq).mock.calls as [
      { name?: string; table?: unknown },
      unknown,
    ][]
    const sig = calls.map(([col, val]) => {
      const tableName = col.table ? getTableName(col.table as never) : ''
      return [tableName, col.name, val] as [string, string | undefined, unknown]
    })

    // find SELECT (tag_categories) の WHERE に userId
    expect(sig).toContainEqual(['tag_categories', 'user_id', 'user-1'])
    // find SELECT (tag_options) の WHERE に userId
    expect(sig).toContainEqual(['tag_options', 'user_id', 'user-1'])

    // INSERT は eq でなく values dict に userId が入る — captured で構造保証
    for (const row of captured.categoryInserts.flat()) {
      expect(row.userId).toBe('user-1')
    }
    for (const row of captured.optionInserts.flat()) {
      expect(row.userId).toBe('user-1')
    }
    for (const row of captured.cardTagInserts.flat()) {
      expect(row.userId).toBe('user-1')
    }
  })
})
