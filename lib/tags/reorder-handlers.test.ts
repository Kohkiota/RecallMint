// @vitest-environment jsdom
// reorder-handlers: D&D 並べ替え反映 helper の unit test。
// Tag-4c-2c T1 で `card-tags-section.test.tsx` から file 移動 (assertion 無変更)。

import { describe, it, expect, vi, beforeEach } from 'vitest'

import type {
  ClientTagCategory,
  ClientTagOption,
} from '@/lib/client-db'
import {
  handleReorderCategories,
  handleReorderOptions,
} from '@/lib/tags/reorder-handlers'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'

// ---------------------------------------------------------------------------
// モック: IDB + sync
// Tag-4c-2c T2 M-C polish: import を top に集約、 mock 定義は vi.hoisted で巻き上げ。
// vi.mock は vitest が自動で先頭に hoist するため、 import 順序を整理しても問題なし。
// ---------------------------------------------------------------------------

// Dexie の `db.transaction(mode, table1, ..., tableN, cb)` は cb が最終引数。
// reorder handler は tag_categories or tag_options + entity_mutations の 2 table を渡す
// 多引数形のため、 mock は variadic で受けて末尾を cb として実行する。
const { mockTransaction, mockTagCategoriesUpdate, mockTagOptionsUpdate } = vi.hoisted(() => ({
  mockTransaction: vi.fn(async (...args: unknown[]) => {
    const cb = args[args.length - 1] as () => Promise<void>
    await cb()
  }),
  mockTagCategoriesUpdate: vi.fn(async () => 1),
  mockTagOptionsUpdate: vi.fn(async () => 1),
}))

vi.mock('@/lib/client-db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/client-db')>('@/lib/client-db')
  return {
    ...actual,
    getClientDb: vi.fn(() => ({
      transaction: mockTransaction,
      tag_categories: {
        update: mockTagCategoriesUpdate,
      },
      tag_options: {
        update: mockTagOptionsUpdate,
      },
      // entity_mutations は実 op をモジュールレベルで mock 済 (enqueueEntityMutation)
      // のため空 object で十分 (`db.transaction(...)` が table 参照のために touch する
      // だけで、 実際の query は走らない)。
      entity_mutations: {},
    })),
  }
})

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: vi.fn(async () => ({}) as never),
}))

vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: vi.fn(async () => 'no-pending' as const),
}))

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const cat = (
  id: string,
  name: string,
  selectType: 'single' | 'multi' = 'multi',
  createdAt: string = '2026-06-01T00:00:00.000Z',
): ClientTagCategory => ({
  id,
  user_id: 'user-1',
  name,
  select_type: selectType,
  color: null,
  sort_key: null,
  created_at: createdAt,
  updated_at: createdAt,
})

const opt = (
  id: string,
  categoryId: string,
  name: string,
  createdAt: string = '2026-06-01T00:00:00.000Z',
): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id: categoryId,
  name,
  color: null,
  sort_key: null,
  created_at: createdAt,
  updated_at: createdAt,
})

// ---------------------------------------------------------------------------
// テスト前の共通処理
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

// ===========================================================================
// Tag-4c-2b T6 Section C: handleReorderCategories
// ===========================================================================
//
// テスト戦略 (P-2 = A 案、 plan T6 確定):
// - `handleCreate*` rollback test ブロック (:1325 / :1647) と同じ mock pattern を踏襲
//   (mockTransaction + enqueueEntityMutation.mockRejectedValueOnce で tx throw 伝播 +
//   `flush not called` の 2 軸で契約表現)。
// - same-tx atomic (mirror update + enqueue 同 tx 内) / updates.length === 0 で tx skip /
//   updated_at 打刻 / catch silent return + flush not called の 4 不変条件を pin。

describe('handleReorderCategories', () => {
  it('mirror update + enqueue が同 tx 内で順序通り (update → enqueue) ペアで実行される', async () => {
    const callOrder: string[] = []
    ;(mockTagCategoriesUpdate as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => {
        callOrder.push(`update:${id}`)
        return 1
      },
    )
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockImplementation(
      async (m: { entity_id: string }) => {
        callOrder.push(`enqueue:${m.entity_id}`)
        return {} as never
      },
    )
    // 既存 ['1', '2'] を逆順に並べ替え → 'c1' は '0' へ, 'c2' は ... 既存 '2' 一致しないので両方 update
    const categories: ClientTagCategory[] = [
      { ...cat('c1', '分野A'), sort_key: '0' },
      { ...cat('c2', '分野B'), sort_key: '1' },
    ]
    // 逆順 (c2, c1) で並べ → c2 が 0、 c1 が 1
    await handleReorderCategories(categories, ['c2', 'c1'])

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    // update / enqueue が各 2 回、 (update:c2 → enqueue:c2 → update:c1 → enqueue:c1) ペア順
    expect(callOrder).toEqual([
      'update:c2',
      'enqueue:c2',
      'update:c1',
      'enqueue:c1',
    ])
    // enqueue の引数形 (op=update_field, patch.field='sort_key', value は新キー)
    expect(enqueueEntityMutation).toHaveBeenCalledWith({
      entity_type: 'tag_category',
      entity_id: 'c2',
      op: 'update_field',
      patch: { field: 'sort_key', value: '0' },
    })
    expect(enqueueEntityMutation).toHaveBeenCalledWith({
      entity_type: 'tag_category',
      entity_id: 'c1',
      op: 'update_field',
      patch: { field: 'sort_key', value: '1' },
    })
  })

  it('mirror update 引数に updated_at: <ISO> が含まれる', async () => {
    const categories: ClientTagCategory[] = [
      { ...cat('c1', '分野A'), sort_key: '0' },
      { ...cat('c2', '分野B'), sort_key: '1' },
    ]
    await handleReorderCategories(categories, ['c2', 'c1'])

    // update 第 2 引数に { sort_key, updated_at } が入る (他列に触らない partial update)
    const updateCalls = mockTagCategoriesUpdate.mock.calls as unknown as [
      string,
      { sort_key: string; updated_at: string },
    ][]
    expect(updateCalls).toHaveLength(2)
    for (const [, patch] of updateCalls) {
      expect(typeof patch.sort_key).toBe('string')
      expect(typeof patch.updated_at).toBe('string')
      // ISO 8601 形式 (Z 終端)
      expect(patch.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })

  it('enqueue が throw した場合 → tx が throw を伝播 (Dexie auto-rollback)、 handler catch で silent return、 flush は呼ばれない', async () => {
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    )
    const categories: ClientTagCategory[] = [
      { ...cat('c1', '分野A'), sort_key: '0' },
      { ...cat('c2', '分野B'), sort_key: '1' },
    ]

    // handler catch で silent return (再 throw しない)
    await expect(
      handleReorderCategories(categories, ['c2', 'c1']),
    ).resolves.toBeUndefined()

    // tx 自体は呼ばれている (中で enqueue が throw した)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    // flush は catch 経路で到達しない
    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })

  it('updates.length === 0 (同順 drag) → mockTransaction 自体が呼ばれない (no-op)', async () => {
    // 既に '0','1','2' に正規化された並びで同順 ids を渡す → reindexSortKeys 空配列
    const categories: ClientTagCategory[] = [
      { ...cat('a', 'A'), sort_key: '0' },
      { ...cat('b', 'B'), sort_key: '1' },
      { ...cat('c', 'C'), sort_key: '2' },
    ]
    await handleReorderCategories(categories, ['a', 'b', 'c'])

    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockTagCategoriesUpdate).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
    // flush も呼ばない (no-op)
    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })

  it('正常完了後に flush が呼ばれる', async () => {
    const categories: ClientTagCategory[] = [
      { ...cat('c1', 'A'), sort_key: '0' },
      { ...cat('c2', 'B'), sort_key: '1' },
    ]
    await handleReorderCategories(categories, ['c2', 'c1'])

    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })

  // ----- 境界 (Tag-4c-2b T7 M-A): 未登録 id 混入は無視され currentMap 母数のみ reindex -----
  it('orderedIds に未登録 id (currentMap に無し) が混入しても無視される (defensive filter)', async () => {
    // 既に '0','1' で正規化済の 2 件。 末尾に 'cat-zzz' (存在しない id) を足して渡す。
    const categories: ClientTagCategory[] = [
      { ...cat('c1', 'A'), sort_key: '0' },
      { ...cat('c2', 'B'), sort_key: '1' },
    ]
    // 'cat-zzz' は currentMap に存在しないため filter で落ち、 残る ['c1','c2'] は
    // 同順 → reindexSortKeys が空配列 → no-op (tx 自体張らない)
    await handleReorderCategories(categories, ['c1', 'c2', 'cat-zzz'])

    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockTagCategoriesUpdate).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })

  it('未登録 id を末尾に挟みつつ並び替えがある場合、 登録済 id のみが reindex 対象', async () => {
    // 既に '0','1' で正規化済を逆順 + 末尾未登録。
    const categories: ClientTagCategory[] = [
      { ...cat('c1', 'A'), sort_key: '0' },
      { ...cat('c2', 'B'), sort_key: '1' },
    ]
    await handleReorderCategories(categories, ['c2', 'c1', 'cat-zzz'])

    // c2 → '0', c1 → '1' の 2 更新のみ (cat-zzz は filter で除外)
    expect(mockTagCategoriesUpdate).toHaveBeenCalledTimes(2)
    expect(enqueueEntityMutation).toHaveBeenCalledTimes(2)
    const updatedIds = (mockTagCategoriesUpdate.mock.calls as unknown as [string, unknown][]).map(
      ([id]) => id,
    )
    expect(updatedIds).toEqual(['c2', 'c1'])
    expect(updatedIds).not.toContain('cat-zzz')
  })
})

// ===========================================================================
// Tag-4c-2b T6 Section D: handleReorderOptions
// ===========================================================================
//
// handleReorderCategories と同形 + categoryId 配下 option 集合のみを reindex 母数とする
// 境界 test (別 category の option を巻き込まない) を追加。

describe('handleReorderOptions', () => {
  it('mirror update + enqueue が同 tx 内で順序通り (update → enqueue) ペアで実行される', async () => {
    const callOrder: string[] = []
    ;(mockTagOptionsUpdate as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => {
        callOrder.push(`update:${id}`)
        return 1
      },
    )
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockImplementation(
      async (m: { entity_id: string }) => {
        callOrder.push(`enqueue:${m.entity_id}`)
        return {} as never
      },
    )
    const options: ClientTagOption[] = [
      { ...opt('o1', 'c1', 'A'), sort_key: '0' },
      { ...opt('o2', 'c1', 'B'), sort_key: '1' },
    ]
    await handleReorderOptions(options, 'c1', ['o2', 'o1'])

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual([
      'update:o2',
      'enqueue:o2',
      'update:o1',
      'enqueue:o1',
    ])
    expect(enqueueEntityMutation).toHaveBeenCalledWith({
      entity_type: 'tag_option',
      entity_id: 'o2',
      op: 'update_field',
      patch: { field: 'sort_key', value: '0' },
    })
    expect(enqueueEntityMutation).toHaveBeenCalledWith({
      entity_type: 'tag_option',
      entity_id: 'o1',
      op: 'update_field',
      patch: { field: 'sort_key', value: '1' },
    })
  })

  it('mirror update 引数に updated_at: <ISO> が含まれる', async () => {
    const options: ClientTagOption[] = [
      { ...opt('o1', 'c1', 'A'), sort_key: '0' },
      { ...opt('o2', 'c1', 'B'), sort_key: '1' },
    ]
    await handleReorderOptions(options, 'c1', ['o2', 'o1'])

    const updateCalls = mockTagOptionsUpdate.mock.calls as unknown as [
      string,
      { sort_key: string; updated_at: string },
    ][]
    expect(updateCalls).toHaveLength(2)
    for (const [, patch] of updateCalls) {
      expect(typeof patch.sort_key).toBe('string')
      expect(patch.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })

  it('enqueue が throw した場合 → tx が throw を伝播 (Dexie auto-rollback)、 handler catch で silent return、 flush は呼ばれない', async () => {
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    )
    const options: ClientTagOption[] = [
      { ...opt('o1', 'c1', 'A'), sort_key: '0' },
      { ...opt('o2', 'c1', 'B'), sort_key: '1' },
    ]

    await expect(
      handleReorderOptions(options, 'c1', ['o2', 'o1']),
    ).resolves.toBeUndefined()

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })

  it('updates.length === 0 (同順 drag) → mockTransaction 自体が呼ばれない (no-op)', async () => {
    const options: ClientTagOption[] = [
      { ...opt('o1', 'c1', 'A'), sort_key: '0' },
      { ...opt('o2', 'c1', 'B'), sort_key: '1' },
      { ...opt('o3', 'c1', 'C'), sort_key: '2' },
    ]
    await handleReorderOptions(options, 'c1', ['o1', 'o2', 'o3'])

    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockTagOptionsUpdate).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })

  it('正常完了後に flush が呼ばれる', async () => {
    const options: ClientTagOption[] = [
      { ...opt('o1', 'c1', 'A'), sort_key: '0' },
      { ...opt('o2', 'c1', 'B'), sort_key: '1' },
    ]
    await handleReorderOptions(options, 'c1', ['o2', 'o1'])

    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })

  // ----- 境界: categoryId 配下 option 集合のみが reindex 対象 (別 cat 巻き込まない) -----
  it('categoryId 配下の option 集合のみを reindex (別 category の option は触らない)', async () => {
    // 2 category × 各 3 option (cat-1: o-a/b/c 全て normalized '0','1','2',
    //  cat-2: o-x/y/z 別 sort_key 帯 '0','1','2')
    const options: ClientTagOption[] = [
      { ...opt('o-a', 'cat-1', 'A'), sort_key: '0' },
      { ...opt('o-b', 'cat-1', 'B'), sort_key: '1' },
      { ...opt('o-c', 'cat-1', 'C'), sort_key: '2' },
      { ...opt('o-x', 'cat-2', 'X'), sort_key: '0' },
      { ...opt('o-y', 'cat-2', 'Y'), sort_key: '1' },
      { ...opt('o-z', 'cat-2', 'Z'), sort_key: '2' },
    ]
    // cat-1 を ['o-c', 'o-a', 'o-b'] の順に並べ替え
    // → o-c: '2' → '0' (差分あり)
    //    o-a: '0' → '1' (差分あり)
    //    o-b: '1' → '2' (差分あり)
    await handleReorderOptions(options, 'cat-1', ['o-c', 'o-a', 'o-b'])

    // 3 件全て差分 → 3 update + 3 enqueue
    expect(mockTagOptionsUpdate).toHaveBeenCalledTimes(3)
    expect(enqueueEntityMutation).toHaveBeenCalledTimes(3)

    // update / enqueue 対象は cat-1 配下 3 件のみ (cat-2 巻き込まない)
    const updatedIds = (mockTagOptionsUpdate.mock.calls as unknown as [string, unknown][]).map(
      ([id]) => id,
    )
    expect(updatedIds.sort()).toEqual(['o-a', 'o-b', 'o-c'])
    expect(updatedIds).not.toContain('o-x')
    expect(updatedIds).not.toContain('o-y')
    expect(updatedIds).not.toContain('o-z')

    const enqueuedIds = (
      enqueueEntityMutation as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => (c[0] as { entity_id: string }).entity_id)
    expect(enqueuedIds.sort()).toEqual(['o-a', 'o-b', 'o-c'])
  })

  // ----- 境界 (Tag-4c-2b T7 M-A): orderedIds に別 category の id が混入しても巻き込まない -----
  it('orderedIds に別 category の option id が混入しても currentMap (categoryId 配下) のみで reindex', async () => {
    // 2 category × 各 3 option (cat-1: o-a/b/c 全て normalized '0','1','2',
    //  cat-2: o-x/y/z 別 sort_key 帯 '0','1','2')
    const options: ClientTagOption[] = [
      { ...opt('o-a', 'cat-1', 'A'), sort_key: '0' },
      { ...opt('o-b', 'cat-1', 'B'), sort_key: '1' },
      { ...opt('o-c', 'cat-1', 'C'), sort_key: '2' },
      { ...opt('o-x', 'cat-2', 'X'), sort_key: '0' },
      { ...opt('o-y', 'cat-2', 'Y'), sort_key: '1' },
      { ...opt('o-z', 'cat-2', 'Z'), sort_key: '2' },
    ]
    // cat-1 の reorder に cat-2 配下の `o-x` を混入させる
    // → defensive filter で o-x は currentMap (cat-1 配下のみ) に存在しないため落ち、
    //   残る ['o-c','o-a','o-b'] が cat-1 配下で reindex 対象 (3 件全て差分)
    await handleReorderOptions(options, 'cat-1', ['o-c', 'o-a', 'o-b', 'o-x'])

    // o-x の update は呼ばれない
    const updatedIds = (mockTagOptionsUpdate.mock.calls as unknown as [string, unknown][]).map(
      ([id]) => id,
    )
    expect(updatedIds).not.toContain('o-x')
    expect(updatedIds).not.toContain('o-y')
    expect(updatedIds).not.toContain('o-z')
    // cat-1 配下 3 件 (差分あり) のみ update / enqueue
    expect(updatedIds.sort()).toEqual(['o-a', 'o-b', 'o-c'])
    expect(mockTagOptionsUpdate).toHaveBeenCalledTimes(3)
    expect(enqueueEntityMutation).toHaveBeenCalledTimes(3)

    const enqueuedIds = (
      enqueueEntityMutation as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => (c[0] as { entity_id: string }).entity_id)
    expect(enqueuedIds).not.toContain('o-x')
    expect(enqueuedIds).not.toContain('o-y')
    expect(enqueuedIds).not.toContain('o-z')
    expect(enqueuedIds.sort()).toEqual(['o-a', 'o-b', 'o-c'])
  })
})
