import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Column, getTableName, is } from 'drizzle-orm'
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
  // T13: (created_at, id) 決定的 canonical 選択の検証用。 mock は Date を使わず単調増加の
  // number で代用する (値そのものは無関係、 相対順序だけが意味を持つ)。
  createdAt: number
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
  // T13: .orderBy(...) が実際に呼ばれた table 名 **と渡された列 args そのもの** を記録する。
  // 呼ばれたかどうかだけでなく「正しい列を正しい向き(昇順)で渡したか」を reference
  // identity で検証するため (fix round 1 Important: desc() 逆順や単一列のみへの regression
  // を mock が sort 挙動でごまかしてしまい検出できない、 という指摘への対処)。
  orderByCalls: { table: string; cols: unknown[] }[]
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
    orderByCalls: [],
  }
}

function makeTx(store: Store, captured: Captured) {
  // drizzle builder を最低限の chain で模倣する。 WHERE predicate は実 SQL を組まないので、
  // store 上の row を「同 table の find が呼ばれたら全件返す」 簡易応答にする (intentional —
  // table-name granularity only。 predicate / filter は test 側で再現しない)。 race ケースや
  // 「同 table 内で call N 回目だけ別 row を返す」 等 differential が要るときは
  // captured.selectOverride を使う (tableName + callIndex で表 mock を分岐)。
  const tx: Record<string, unknown> = {}

  // T13: 実 INSERT 経路 (tx.insert 内 finalize) で新規 tag_categories row を作るときに
  // 割り振る createdAt。 pre-seed (store.categories.push) と値域が被らないよう大きめの
  // base から単調増加させる (テストごとに makeTx を作り直すので closure スコープでリセットされる)。
  let nextCategoryCreatedAt = 1000

  tx.select = (_cols?: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: (_predicate?: unknown) => {
        const name = getTableName(table as never)
        const callIndex = captured.selectCount
        captured.selectCount += 1
        const rows: unknown[] = (() => {
          if (captured.selectOverride) {
            const override = captured.selectOverride(name, callIndex)
            if (override !== null) return override
          }
          if (name === getTableName(tagCategories)) {
            return store.categories.map((c) => ({
              id: c.id,
              name: c.name,
              sortKey: c.sortKey,
              createdAt: c.createdAt,
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
        })()
        // 実 drizzle builder は .where(...) 単体でも thenable (await 可)、 .orderBy(...) を
        // chain してもよい。 mock は両方に対応する: orderBy 未呼び出し = 物理/挿入順のまま
        // (ORDER BY 無し SELECT の模擬、 非決定 return order の代理)、 orderBy 呼び出し =
        // (created_at, id) 昇順に実際に並び替える (T13 検証用)。
        return {
          orderBy: (...orderCols: unknown[]) => {
            // fix round 1 Important 対処: sort 自体は引数を見ずに常に (createdAt, id)
            // 昇順で行う(mock の sort 挙動を args に依存させない、変更しない)が、
            // 「production が実際に渡した列 args」 は生で captured に記録する。
            // 呼び出し側 (case C/D) が reference identity で
            // [tagCategories.createdAt, tagCategories.id] と厳密一致するか検証することで、
            // desc() 逆順化や単一列化への regression を検出できるようにする
            // (mock の sort 挙動だけでは args 無視のため検出不能だった gap の解消)。
            captured.orderByCalls.push({ table: name, cols: orderCols })
            const sorted = [...(rows as { id: string; createdAt?: number }[])].sort(
              (a, b) => {
                const ca = a.createdAt ?? 0
                const cb = b.createdAt ?? 0
                if (ca !== cb) return ca - cb
                return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
              },
            )
            return Promise.resolve(sorted)
          },
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        }
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
                  createdAt: nextCategoryCreatedAt++,
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

// T13 fix round 1 Important 対処: captured.orderByCalls[].cols が厳密に
// [tagCategories.createdAt, tagCategories.id] (昇順・この順) であることを検証する。
//
// reference identity (`toBe`) は使わない — apply-ocr-tags.ts が動的 import される都合で
// (各 it() 内 `await import('./apply-ocr-tags')`)、 その内部が参照する `tagCategories` の
// 列オブジェクトと本 test file 最上部で静的 import した `tagCategories` の列オブジェクトが
// 別インスタンスになる (実測済: 同じ `.name` ('created_at') を持つが `===` は false)。
// vi.mock('drizzle-orm', ...) + 動的 import の組み合わせによるモジュール重複が原因と見られる。
// 代わりに drizzle-orm 公式の `is(x, Column)` (module 重複に対して robust な brand check)
// + `.name` (列名) + `.table` (所属 table) の構造検証を使う。 これなら:
//   - desc()/asc() でラップされた列は `is(x, Column)` が false になる (逆順化 regression 検出)
//   - 列名が違えば `.name` 不一致 (誤 column regression 検出)
//   - 別 table の同名列なら `.table` の getTableName 不一致 (誤 table regression 検出)
function expectOrderedByCreatedAtThenId(cols: unknown[]) {
  expect(cols).toHaveLength(2)
  for (const col of cols) {
    expect(is(col, Column)).toBe(true)
  }
  const [c0, c1] = cols as [{ name: string; table: unknown }, { name: string; table: unknown }]
  expect(c0.name).toBe('created_at')
  expect(getTableName(c0.table as never)).toBe(getTableName(tagCategories))
  expect(c1.name).toBe('id')
  expect(getTableName(c1.table as never)).toBe(getTableName(tagCategories))
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
      createdAt: 1,
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
    // M-1 guard: find-only path の SELECT 回数 = 2 (category find / option find)。
    // missingCats / missingPairs 0 件で allCatSortKeys / allOptsForCats / 再 SELECT は走らない。
    expect(captured.selectCount).toBe(2)
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
      createdAt: 1,
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

  it('case 3-b: option sort_key 採番母数は category 内全 option (OCR 候補に無い既存 row も含む) — I-1 regression', async () => {
    // I-1: option find SELECT は inArray(name, optionNames) で絞られるため、 OCR 候補に
    // 含まれない既存 option (A=sortKey:'0', B=sortKey:'1') が sort_key 採番母数から漏れる
    // と、 新規 '微積' の sort_key が '0' になり pre-existing A と衝突する。 fix 後は
    // allOptsForCats SELECT で category 内全 option を別途取得し、 新規 sort_key='2' を出す。
    store.categories.push({
      id: 'cat-existing',
      userId: 'user-1',
      name: '分野',
      selectType: 'multi',
      color: null,
      sortKey: '0',
      createdAt: 1,
    })
    store.options.push(
      {
        id: 'opt-a',
        userId: 'user-1',
        categoryId: 'cat-existing',
        name: 'A',
        color: null,
        sortKey: '0',
      },
      {
        id: 'opt-b',
        userId: 'user-1',
        categoryId: 'cat-existing',
        name: 'B',
        color: null,
        sortKey: '1',
      },
    )

    // option find SELECT は inArray(name, ['微積']) で絞られるため、 既存 A/B は返らない
    // (store には残るが SELECT 結果は空)。 一方 allOptsForCats は category 内全 option を
    // 返すべき。 selectOverride で per-table の 2 回目 (allOptsForCats) のみ既存 A/B を返す。
    let catN = 0
    let optN = 0
    captured.selectOverride = (tableName, _callIndex) => {
      if (tableName === getTableName(tagCategories)) {
        const n = catN++
        // (0) find = 既存 '分野' 一致あり (store 全件返却で OK)、 (1+) は base mock に委譲
        if (n === 0) {
          return [{ id: 'cat-existing', name: '分野', sortKey: '0' }]
        }
        return null // missingCats 0 件で allCatSortKeys / re-SELECT は走らない (M-1 guard)
      }
      if (tableName === getTableName(tagOptions)) {
        const n = optN++
        // (0) find = inArray(name, ['微積']) 一致なし → 空
        if (n === 0) return []
        // (1) allOptsForCats = category 内全 option (既存 A=sortKey:'0', B=sortKey:'1')
        if (n === 1) {
          return [
            { categoryId: 'cat-existing', sortKey: '0' },
            { categoryId: 'cat-existing', sortKey: '1' },
          ]
        }
        // (2) Step 3 re-SELECT = 並走 race 無しなので空 (helper は OK 継続)
        return []
      }
      return null
    }

    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': '微積' } },
    ])

    // category find ヒット (既存 'cat-existing' 再利用) → category INSERT 0 件
    expect(captured.categoryInserts).toHaveLength(0)
    // option は新規 '微積' を 1 件 INSERT、 sort_key='2' (既存 A:0, B:1 の次)
    expect(captured.optionInserts).toHaveLength(1)
    expect(captured.optionInserts[0]).toHaveLength(1)
    expect(captured.optionInserts[0]![0]).toMatchObject({
      categoryId: 'cat-existing',
      name: '微積',
      sortKey: '2',
    })
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
    // per-table の SELECT occurrence index で path を分岐する。 helper の per-table SELECT 順:
    //   tag_categories: (0) find / (1) allCatSortKeys / (2) Step 3 re-SELECT
    //   tag_options:    (0) find / (1) allOptsForCats / (2) Step 3 re-SELECT
    // find SELECT は空に保ち、 re-SELECT で並走 INSERT 済の race row を返す。 これにより
    // §3.1 Step 3 の id 回収 path を実走する (find ヒット path に化けない)。
    let catN = 0
    let optN = 0
    captured.selectOverride = (tableName, _callIndex) => {
      if (tableName === getTableName(tagCategories)) {
        const n = catN++
        if (n < 2) return [] // find + allCatSortKeys は空
        return [{ id: 'cat-race', name: '分野', sortKey: '0' }] // re-SELECT で race row
      }
      if (tableName === getTableName(tagOptions)) {
        const n = optN++
        if (n < 2) return [] // find + allOptsForCats は空
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

  it('case A (Min-4): 101 字超の option value は silent skip、 同 card の正常な他 value は通常作成', async () => {
    // tagNameSchema = z.string().trim().min(1).max(100)。 OCR は Gemini 自動出力で
    // manual の guard が効かないため、 helper 内で safeParse skip しないと 100 字超の
    // ゴミ tag が永続化する。 同 array 内の正常値は落とさず enrichment 継続。
    const longVal = 'x'.repeat(101)
    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': [longVal, '正常値'] } },
    ])

    // category '分野' は 1 件 INSERT
    expect(captured.categoryInserts).toHaveLength(1)
    expect(captured.categoryInserts[0]).toHaveLength(1)
    expect(captured.categoryInserts[0]![0]!.name).toBe('分野')

    // option は '正常値' のみ INSERT (101 字側は skip)
    expect(captured.optionInserts).toHaveLength(1)
    expect(captured.optionInserts[0]).toHaveLength(1)
    expect(captured.optionInserts[0]![0]!.name).toBe('正常値')

    // card_tags は '正常値' option との 1 pair のみ
    expect(captured.cardTagInserts).toHaveLength(1)
    expect(captured.cardTagInserts[0]).toHaveLength(1)
    const optionId = captured.optionInserts[0]![0]!.id
    expect(captured.cardTagInserts[0]![0]).toEqual({
      cardId: 'card-1',
      optionId,
      userId: 'user-1',
    })
  })

  it('case B (Min-4): 101 字超の category key は silent skip、 配下 option も生成しない / 他正常 category は通常作成', async () => {
    // category key が schema 不通過なら、 その key 配下の option も作らない (category が
    // 無いので張りようがない)。 同 card 内の他正常 category は影響を受けない。
    const longKey = 'a'.repeat(101)
    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { [longKey]: '値1', '分野': '値2' } },
    ])

    // category '分野' のみ INSERT (longKey side は category 自体作られず)
    expect(captured.categoryInserts).toHaveLength(1)
    expect(captured.categoryInserts[0]).toHaveLength(1)
    expect(captured.categoryInserts[0]![0]!.name).toBe('分野')

    // option '値2' のみ INSERT ('値1' は parent category skip で配下も生成しない)
    expect(captured.optionInserts).toHaveLength(1)
    expect(captured.optionInserts[0]).toHaveLength(1)
    expect(captured.optionInserts[0]![0]!.name).toBe('値2')

    // card_tags は (card-1, '値2' option) のみ
    expect(captured.cardTagInserts).toHaveLength(1)
    expect(captured.cardTagInserts[0]).toHaveLength(1)
    const optionId = captured.optionInserts[0]![0]!.id
    expect(captured.cardTagInserts[0]![0]).toEqual({
      cardId: 'card-1',
      optionId,
      userId: 'user-1',
    })
  })

  it('case C (T13): 同名 tag_category 重複時は (created_at, id) 最古が canonical — Step 1 find, red 検証済', async () => {
    // 同名 '分野' の重複 category を 2 件 pre-seed。 物理/挿入順 (store push 順、 = ORDER BY
    // 無し SELECT が返す順の代理) は OLDEST を先、 NEWEST を後にする。
    //
    // fix 前のコードは `for (const row of existingCats) categoryByName.set(row.name, row.id)`
    // という無条件 overwrite で、 「配列内で最後に見た row」 が勝つ。 この順序 (oldest→newest)
    // だと fix 前は **newest が勝ってしまう** (誤り、 canonical は本来 oldest であるべき)。
    // fix 後は ORDER BY (created_at, id) 昇順 + Map 構築の first-wins により、 常に oldest が
    // 勝つ (ORDER BY が実際に決定するので物理順に依存しない)。
    store.categories.push({
      id: 'cat-old',
      userId: 'user-1',
      name: '分野',
      selectType: 'multi',
      color: null,
      sortKey: '0',
      createdAt: 1, // 最古 = canonical であるべき
    })
    store.categories.push({
      id: 'cat-new',
      userId: 'user-1',
      name: '分野',
      selectType: 'multi',
      color: null,
      sortKey: '1',
      createdAt: 2, // 新しい = 誤って canonical になってはいけない
    })

    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': '微積' } },
    ])

    // find hit (両方既存) → category 新規 INSERT は 0 件
    expect(captured.categoryInserts).toHaveLength(0)
    // option / card_tags は canonical = 最古 'cat-old' に紐づく (誤って 'cat-new' ではない)
    expect(captured.optionInserts).toHaveLength(1)
    expect(captured.optionInserts[0]![0]).toMatchObject({
      categoryId: 'cat-old',
      name: '微積',
    })
    expect(captured.cardTagInserts).toHaveLength(1)
    const optionId = captured.optionInserts[0]![0]!.id
    expect(captured.cardTagInserts[0]![0]).toEqual({
      cardId: 'card-1',
      optionId,
      userId: 'user-1',
    })
    // 構造保証: tag_categories への .orderBy(...) 呼び出しが実際に発生し、 かつ渡された列が
    // 厳密に [tagCategories.createdAt, tagCategories.id] (昇順・この順) であることを検証する
    // (mock の sort は args を無視して常に昇順にしてしまうため、 desc() 逆順化や単一列化への
    // regression を値だけでは検出できない — fix round 1 Important 対処)。
    const catOrderByCalls = captured.orderByCalls.filter(
      (c) => c.table === getTableName(tagCategories),
    )
    expect(catOrderByCalls.length).toBeGreaterThan(0)
    for (const call of catOrderByCalls) {
      expectOrderedByCreatedAtThenId(call.cols)
    }
  })

  it('case D (T13): Step 3 (post-insert re-fetch) も同名重複時は最古 canonical — 楽観的 id は必ず上書きされる', async () => {
    // Step 1 find は空 (missing) → Step 2 で楽観的 id を仮 set → INSERT → Step 3 re-SELECT
    // で「並走 tx が commit 済の同名 2 行」 が返るケースを模擬する (selectOverride)。
    // override の並び (物理/挿入順の代理) は OLDEST を先、 NEWEST を後にする — fix 前の
    // 無条件 overwrite loop だと「最後に見た row」が勝つため NEWEST が誤って canonical に
    // なる。 fix 後は ORDER BY 昇順 + first-wins で必ず OLDEST が勝ち、 かつ Step 2 の
    // 楽観的 id (どちらでもない、 迷子の自分の予測 id) は確実に上書きされる。
    let catN = 0
    captured.selectOverride = (tableName, _callIndex) => {
      if (tableName === getTableName(tagCategories)) {
        const n = catN++
        if (n === 0) return [] // Step1 find: 空 (missing)
        if (n === 1) return [] // allCatSortKeys (このテストでは母数不使用)
        // Step 3 reselect: 同名 '分野' で 2 行 (並走 tx が作った想定)
        return [
          { id: 'cat-race-old', name: '分野', createdAt: 1 }, // 最古 = canonical であるべき
          { id: 'cat-race-new', name: '分野', createdAt: 2 }, // 新しい = 誤って勝ってはいけない
        ]
      }
      return null // tag_options は default (store 空 → 通常の新規作成 path)
    }

    const { applyOcrTags } = await import('./apply-ocr-tags')
    await applyOcrTags(makeTx(store, captured), 'user-1', [
      { id: 'card-1', custom_props: { '分野': '微積' } },
    ])

    // option は canonical = 最古 'cat-race-old' に紐づく (Step 2 の楽観的 id でも
    // 'cat-race-new' でもない)
    expect(captured.optionInserts).toHaveLength(1)
    expect(captured.optionInserts[0]![0]).toMatchObject({
      categoryId: 'cat-race-old',
      name: '微積',
    })
    const optionId = captured.optionInserts[0]![0]!.id
    expect(captured.cardTagInserts[0]![0]).toEqual({
      cardId: 'card-1',
      optionId,
      userId: 'user-1',
    })
    // 構造保証: Step 1 find + Step 3 reselect の両方の tag_categories .orderBy(...) 呼び出しで
    // 渡された列が厳密に [tagCategories.createdAt, tagCategories.id] であること (drift seam:
    // Step 1 のみ正しく Step 3 が desc() / 単一列に regression するケースを検出する)。
    const catOrderByCalls = captured.orderByCalls.filter(
      (c) => c.table === getTableName(tagCategories),
    )
    expect(catOrderByCalls.length).toBeGreaterThan(0)
    for (const call of catOrderByCalls) {
      expectOrderedByCreatedAtThenId(call.cols)
    }
  })
})
