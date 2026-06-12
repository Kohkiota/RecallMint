import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { tagCategories, tagOptions } from '@/lib/db/schema'

// apply-tag-mutation.ts の unit test (T4 sync-fix-1)。
//
// 観点:
//   - update_field dispatch の zod 値検証 (tagNameSchema の trim 効果 / max 効果、
//     tagCategoryIdSchema の uuid 効果) — 共有 `lib/validation/tag.ts` 経由で
//     registry と apply 側の drift が起きないことを保証する。
//   - applyTagOptionCreate の dup pre-check が自己 (同 id) を除外する
//     (audit #9 mutation_id race regression)。
//
// tx は重い in-memory mock として組み、 select / insert / update / delete を
// テーブル名で dispatch する。 実 DB は使わない (`server-only` は vitest stub)。

// ---------------------------------------------------------------------------
// drizzle-orm の eq / and / ne / sql を spy ラップ
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
    ne: vi.fn((...args: Parameters<typeof real.ne>) => real.ne(...args)),
    sql: vi.fn((...args: Parameters<typeof real.sql>) => real.sql(...args)),
  }
})

// ---------------------------------------------------------------------------
// in-memory store + tx mock
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

interface Store {
  categories: CategoryRow[]
  options: OptionRow[]
}

interface Captured {
  optionUpdateSet: Record<string, unknown> | null
  categoryUpdateSet: Record<string, unknown> | null
  optionInsertValues: Record<string, unknown> | null
  categoryInsertValues: Record<string, unknown> | null
}

function freshStore(): Store {
  return { categories: [], options: [] }
}

async function neExclusionIds(): Promise<Set<unknown>> {
  // applyTagOptionCreate の dup check に追加された `ne(tagOptions.id, optionId)` を
  // tx mock で再現するため、 直近の `ne` spy 呼出から「除外すべき id 集合」 を抽出する。
  const { ne } = await import('drizzle-orm')
  const calls = vi.mocked(ne).mock.calls as [
    { name?: string; table?: unknown },
    unknown,
  ][]
  const excluded = new Set<unknown>()
  for (const [col, val] of calls) {
    if (col.table && getTableName(col.table as never) === getTableName(tagOptions) && col.name === 'id') {
      excluded.add(val)
    }
  }
  return excluded
}

function makeTx(store: Store, captured: Captured) {
  // 各 chain は drizzle の builder を模倣する。 where(predicate) は実 SQL を組まないが、
  // ne(tagOptions.id, optionId) の自己除外 (#9 fix) を再現するため、 from(tagOptions)
  // .where() の解決時に最新の `ne` spy 呼出を読んで除外 id 集合を作り、 store rows を
  // filter する。 eq() の細粒度 predicate 再現はしない (test の意図上、 store を狙って
  // 組んで categoryId/name 重複の有無を表現する)。
  const tx: Record<string, unknown> = {}

  tx.select = (_cols?: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: async (_predicate?: unknown) => {
        const name = getTableName(table as never)
        if (name === getTableName(tagCategories)) {
          return store.categories.map((c) => ({ id: c.id }))
        }
        if (name === getTableName(tagOptions)) {
          const excluded = await neExclusionIds()
          return store.options
            .filter((o) => !excluded.has(o.id))
            .map((o) => ({
              id: o.id,
              name: o.name,
              categoryId: o.categoryId,
            }))
        }
        return []
      },
    }),
  })

  tx.insert = (table: unknown) => ({
    values: (vals: Record<string, unknown>) => ({
      onConflictDoNothing: () => {
        const name = getTableName(table as never)
        if (name === getTableName(tagCategories)) {
          captured.categoryInsertValues = vals
          if (!store.categories.find((c) => c.id === vals.id)) {
            store.categories.push({
              id: vals.id as string,
              userId: vals.userId as string,
              name: vals.name as string,
              selectType: vals.selectType as 'single' | 'multi',
              color: (vals.color as string | null) ?? null,
              sortKey: (vals.sortKey as string | null) ?? null,
            })
          }
        }
        if (name === getTableName(tagOptions)) {
          captured.optionInsertValues = vals
          if (!store.options.find((o) => o.id === vals.id)) {
            store.options.push({
              id: vals.id as string,
              userId: vals.userId as string,
              categoryId: vals.categoryId as string,
              name: vals.name as string,
              color: (vals.color as string | null) ?? null,
              sortKey: (vals.sortKey as string | null) ?? null,
            })
          }
        }
        return Promise.resolve(undefined)
      },
    }),
  })

  tx.update = (table: unknown) => ({
    set: (vals: Record<string, unknown>) => {
      const name = getTableName(table as never)
      if (name === getTableName(tagCategories)) captured.categoryUpdateSet = vals
      if (name === getTableName(tagOptions)) captured.optionUpdateSet = vals
      return {
        where: () => ({
          returning: () => {
            if (name === getTableName(tagCategories)) {
              // 1 row 返す: store の最初の category id を返して 'applied' 経路を通す
              const r = store.categories[0]
              if (!r) return Promise.resolve([])
              // SET を in-memory にも反映 (assertion で読みやすく)
              if (typeof vals.name === 'string') r.name = vals.name
              if ('color' in vals)
                r.color = (vals.color as string | null) ?? null
              if ('sortKey' in vals)
                r.sortKey = (vals.sortKey as string | null) ?? null
              return Promise.resolve([{ id: r.id }])
            }
            if (name === getTableName(tagOptions)) {
              const r = store.options[0]
              if (!r) return Promise.resolve([])
              if (typeof vals.name === 'string') r.name = vals.name
              if ('color' in vals)
                r.color = (vals.color as string | null) ?? null
              if ('sortKey' in vals)
                r.sortKey = (vals.sortKey as string | null) ?? null
              if (typeof vals.categoryId === 'string')
                r.categoryId = vals.categoryId
              return Promise.resolve([{ id: r.id }])
            }
            return Promise.resolve([])
          },
        }),
      }
    },
  })

  tx.delete = (_table: unknown) => ({
    where: () => Promise.resolve(undefined),
  })

  return tx as Parameters<
    typeof import('./apply-tag-mutation').applyTagCategoryUpdate
  >[0]
}

function freshCaptured(): Captured {
  return {
    optionUpdateSet: null,
    categoryUpdateSet: null,
    optionInsertValues: null,
    categoryInsertValues: null,
  }
}

// ---------------------------------------------------------------------------
// applyTagCategoryUpdate
// ---------------------------------------------------------------------------

describe('applyTagCategoryUpdate (update_field dispatch)', () => {
  let store: Store
  let captured: Captured

  beforeEach(() => {
    vi.clearAllMocks()
    store = freshStore()
    store.categories.push({
      id: 'cat-1',
      userId: 'user-1',
      name: 'old-name',
      selectType: 'single',
      color: null,
      sortKey: null,
    })
    captured = freshCaptured()
  })

  it('name trim 効果: 前後空白付き value は trim 後に SET される (tagNameSchema)', async () => {
    const { applyTagCategoryUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagCategoryUpdate(
      makeTx(store, captured),
      'user-1',
      'cat-1',
      { field: 'name', value: '  hello  ' },
    )
    expect(result).toBe('applied')
    expect(captured.categoryUpdateSet).toMatchObject({ name: 'hello' })
    // in-memory 反映
    expect(store.categories[0]!.name).toBe('hello')
  })

  it('name max 効果: 101 文字 → failed、 UPDATE 発行なし', async () => {
    const { applyTagCategoryUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagCategoryUpdate(
      makeTx(store, captured),
      'user-1',
      'cat-1',
      { field: 'name', value: 'a'.repeat(101) },
    )
    expect(result).toBe('failed')
    expect(captured.categoryUpdateSet).toBeNull()
  })

  it('name 空文字 → failed (既存挙動の regression)', async () => {
    const { applyTagCategoryUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagCategoryUpdate(
      makeTx(store, captured),
      'user-1',
      'cat-1',
      { field: 'name', value: '' },
    )
    expect(result).toBe('failed')
  })

  it('color: null 許容 (tagColorSchema)', async () => {
    const { applyTagCategoryUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagCategoryUpdate(
      makeTx(store, captured),
      'user-1',
      'cat-1',
      { field: 'color', value: null },
    )
    expect(result).toBe('applied')
    expect(captured.categoryUpdateSet).toMatchObject({ color: null })
  })

  it('sort_key: 文字列を SET する (DB 列名 sortKey へマップ)', async () => {
    const { applyTagCategoryUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagCategoryUpdate(
      makeTx(store, captured),
      'user-1',
      'cat-1',
      { field: 'sort_key', value: 'Z-01' },
    )
    expect(result).toBe('applied')
    expect(captured.categoryUpdateSet).toMatchObject({ sortKey: 'Z-01' })
  })

  it('unknown field → failed (defensive guard、 UPDATE 発行なし)', async () => {
    // TS enum narrowing を bypass。 registry 側 schema を後で z.string().min(1) 等に
    // 緩めても apply 側の `!entry` guard が belt-and-suspenders として効くことを保証する。
    const { applyTagCategoryUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagCategoryUpdate(
      makeTx(store, captured),
      'user-1',
      'cat-1',
      { field: 'unknown' as never, value: 'x' },
    )
    expect(result).toBe('failed')
    expect(captured.categoryUpdateSet).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// applyTagOptionUpdate
// ---------------------------------------------------------------------------

describe('applyTagOptionUpdate (update_field dispatch)', () => {
  let store: Store
  let captured: Captured

  beforeEach(() => {
    vi.clearAllMocks()
    store = freshStore()
    store.categories.push({
      id: 'cat-1',
      userId: 'user-1',
      name: 'cat-1',
      selectType: 'single',
      color: null,
      sortKey: null,
    })
    store.options.push({
      id: 'opt-1',
      userId: 'user-1',
      categoryId: 'cat-1',
      name: 'old',
      color: null,
      sortKey: null,
    })
    captured = freshCaptured()
  })

  it('name trim 効果: rename で前後空白 trim される (tagNameSchema)', async () => {
    const { applyTagOptionUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagOptionUpdate(
      makeTx(store, captured),
      'user-1',
      'opt-1',
      { field: 'name', value: '  renamed  ' },
    )
    expect(result).toBe('applied')
    expect(captured.optionUpdateSet).toMatchObject({ name: 'renamed' })
  })

  it('name max 効果: 101 文字 → failed', async () => {
    const { applyTagOptionUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagOptionUpdate(
      makeTx(store, captured),
      'user-1',
      'opt-1',
      { field: 'name', value: 'b'.repeat(101) },
    )
    expect(result).toBe('failed')
    expect(captured.optionUpdateSet).toBeNull()
  })

  it('category_id uuid 効果: not-a-uuid → failed (tagCategoryIdSchema)', async () => {
    const { applyTagOptionUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagOptionUpdate(
      makeTx(store, captured),
      'user-1',
      'opt-1',
      { field: 'category_id', value: 'not-a-uuid' },
    )
    expect(result).toBe('failed')
    expect(captured.optionUpdateSet).toBeNull()
  })

  it('unknown field → failed (defensive guard、 UPDATE 発行なし)', async () => {
    // category 側と同様、 enum narrowing bypass で `!entry` guard を踏ませる。
    const { applyTagOptionUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagOptionUpdate(
      makeTx(store, captured),
      'user-1',
      'opt-1',
      { field: 'unknown' as never, value: 'x' },
    )
    expect(result).toBe('failed')
    expect(captured.optionUpdateSet).toBeNull()
  })

  it('rename: 同 category 内 別 id で同名 option 存在 → failed (UNIQUE 違反、 UPDATE 発行なし)', async () => {
    // beforeEach で seed 済の opt-1 (name='old', cat-1) に加え、 別 id の opt-2 を
    // 同 category に追加。 opt-1 を opt-2 と同名へ rename しようとすると
    // dup pre-check (`dup.some((d) => d.id !== optionId)`) が真になり 'failed'。
    store.options.push({
      id: 'opt-2',
      userId: 'user-1',
      categoryId: 'cat-1',
      name: 'taken',
      color: null,
      sortKey: null,
    })
    const { applyTagOptionUpdate } = await import('./apply-tag-mutation')
    const result = await applyTagOptionUpdate(
      makeTx(store, captured),
      'user-1',
      'opt-1',
      { field: 'name', value: 'taken' },
    )
    expect(result).toBe('failed')
    expect(captured.optionUpdateSet).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// applyTagOptionCreate — dup check 自己除外 (#9 mutation_id race regression)
// ---------------------------------------------------------------------------

describe('applyTagOptionCreate dup pre-check 自己除外 (#9 regression)', () => {
  let store: Store
  let captured: Captured

  beforeEach(() => {
    vi.clearAllMocks()
    store = freshStore()
    // parent category 存在
    store.categories.push({
      id: '11111111-1111-1111-1111-111111111111',
      userId: 'user-1',
      name: 'cat',
      selectType: 'single',
      color: null,
      sortKey: null,
    })
  })

  it('mutation_id race: 同 (id, category_id, name) の row が既存 = 自己マッチ → applied (failed にならない)', async () => {
    // pre-seed: 同じ id / category_id / name の option を store に置く (= 再送 replay 状況)
    store.options.push({
      id: '22222222-2222-2222-2222-222222222222',
      userId: 'user-1',
      categoryId: '11111111-1111-1111-1111-111111111111',
      name: 'opt-a',
      color: null,
      sortKey: null,
    })
    captured = freshCaptured()

    const { applyTagOptionCreate } = await import('./apply-tag-mutation')
    const result = await applyTagOptionCreate(
      makeTx(store, captured),
      'user-1',
      '22222222-2222-2222-2222-222222222222',
      {
        category_id: '11111111-1111-1111-1111-111111111111',
        name: 'opt-a',
        color: null,
        sortKey: null,
      } as unknown as Parameters<typeof applyTagOptionCreate>[3],
    )
    // ne(tagOptions.id, optionId) で自己除外、 dup pre-check は通過し ON CONFLICT で
    // 冪等 INSERT に進む → 'applied' (race regression なし)
    expect(result).toBe('applied')
  })

  it('真の dup (異なる id, 同 category_id, 同 name) → failed', async () => {
    // pre-seed: 異なる id だが同 category_id + 同 name (= 別 mutation が先に作成済)
    store.options.push({
      id: '33333333-3333-3333-3333-333333333333',
      userId: 'user-1',
      categoryId: '11111111-1111-1111-1111-111111111111',
      name: 'opt-a',
      color: null,
      sortKey: null,
    })
    captured = freshCaptured()

    const { applyTagOptionCreate } = await import('./apply-tag-mutation')
    const result = await applyTagOptionCreate(
      makeTx(store, captured),
      'user-1',
      '44444444-4444-4444-4444-444444444444',
      {
        category_id: '11111111-1111-1111-1111-111111111111',
        name: 'opt-a',
      } as unknown as Parameters<typeof applyTagOptionCreate>[3],
    )
    expect(result).toBe('failed')
  })
})
