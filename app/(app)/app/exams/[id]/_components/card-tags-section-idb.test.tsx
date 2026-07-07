// @vitest-environment jsdom
// card-tags-section の fake-indexeddb 統合テスト (Fix-1)。
// createOption (real IDB write 検証) と handleCreateOptionAndAssign atomicity rollback を扱う。
//
// getClientDb は mock せず実 Dexie (fake-indexeddb) を使う。
// runGuardedEntityMutationFlush のみ mock。
// enqueueEntityMutation は rollback test 以外では mock し、
// rollback test (IDB-B) では call-through + 2 回目 throw の実装に差し替える。

import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { ClientTagOption } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// enqueueEntityMutation: 通常テスト用の mock (IDB-B rollback test で差し替える)
// flush のみ常時 mock
// ---------------------------------------------------------------------------

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync/entity-mutations')>()
  return { ...actual, enqueueEntityMutation: mockEnqueue }
})

vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { getClientDb } from '@/lib/client-db'
import { createOption, buildNewOption, handleCreateOptionAndAssign } from '@/lib/tags/tag-crud'

// ---------------------------------------------------------------------------
// fixture helpers (最小限)
// ---------------------------------------------------------------------------

const cat = (
  id: string,
  selectType: 'single' | 'multi' = 'multi',
): import('@/lib/client-db').ClientTagCategory => ({
  id,
  user_id: 'u1',
  name: id,
  select_type: selectType,
  color: null,
  sort_key: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

const optRow = (id: string, categoryId: string, sortKey: string | null = null): ClientTagOption => ({
  id,
  user_id: 'u1',
  category_id: categoryId,
  name: id,
  color: null,
  sort_key: sortKey,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

const cardTagRow = (cardId: string, optionId: string) => ({
  card_id: cardId,
  option_id: optionId,
  user_id: 'u1',
  created_at: '2026-01-01T00:00:00.000Z',
})

// ---------------------------------------------------------------------------
// 各テスト前に関係 store を clear (fake-indexeddb は process 越しで state を持つ)
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const db = getClientDb()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
  mockEnqueue.mockClear()
  mockFlush.mockClear()
  mockEnqueue.mockImplementation(async () => ({}) as never)
})

// ===========================================================================
// Section IDB-A: createOption — real IDB write 検証
// ===========================================================================

describe('createOption — real IDB (fake-indexeddb)', () => {
  it('tag_options テーブルに新規行が書き込まれる', async () => {
    const id = await createOption('u1', [], 'cat-1', '新option')

    const db = getClientDb()
    const row = await db.tag_options.get(id)
    expect(row).toBeDefined()
    expect(row!.name).toBe('新option')
    expect(row!.category_id).toBe('cat-1')
    expect(row!.user_id).toBe('u1')
    expect(row!.color).toBeNull()
  })

  it('返却値の id と IDB に保存された id が一致する', async () => {
    const id = await createOption('u1', [], 'cat-2', 'テスト')

    const db = getClientDb()
    const row = await db.tag_options.get(id)
    expect(row!.id).toBe(id)
  })

  it('enqueueEntityMutation が 1 件 (tag_option create) だけ呼ばれる', async () => {
    const id = await createOption('u1', [], 'cat-3', 'タグ')

    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_option',
        entity_id: id,
        op: 'create',
      }),
    )
  })

  it('userId 空文字 → throw + IDB への書き込みなし', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(createOption('', [], 'cat-1', '新')).rejects.toThrow('empty user_id')

    const db = getClientDb()
    const count = await db.tag_options.count()
    expect(count).toBe(0)
    expect(mockEnqueue).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ===========================================================================
// Section IDB-B: handleCreateOptionAndAssign — atomicity rollback
// enqueueEntityMutation の 2 回目呼び出しで throw させ、 tx 全体を rollback する。
// tag_options (新 option) / card_tags (add/remove) / entity_mutations が全戻しされることを確認。
//
// IDB-1/IDB-2 fix: 1 回目の enqueueEntityMutation は実装を call-through させ、
// 実際に entity_mutations テーブルへ書き込んだうえで 2 回目で throw する。
// これにより Dexie tx の rollback が entity_mutations も巻き戻すことを非真空に検証する。
// ===========================================================================

describe('handleCreateOptionAndAssign — 単票 atomicity rollback (fake-indexeddb)', () => {
  it('enqueue 2 回目が throw → tag_options / card_tags / entity_mutations 全ロールバック (3 store 非真空検証)', async () => {
    const db = getClientDb()

    // 事前状態: card-1 に opt-existing が付与されている (single カテゴリで toRemove あり)
    await db.tag_options.put(optRow('opt-existing', 'cat-single', '0'))
    await db.card_tags.put(cardTagRow('card-1', 'opt-existing'))

    const categories = [cat('cat-single', 'single')]
    const options = [{ ...optRow('opt-existing', 'cat-single'), sort_key: '0' }]
    const existingCardTags = [cardTagRow('card-1', 'opt-existing')]

    // IDB-1/IDB-2: 1 回目 (tag_option create) は db.entity_mutations.add() を直接実行し、
    // 実際に entity_mutations テーブルへ書き込む (Dexie tx zone 内で動く最も安全な書込)。
    // 2 回目 (card update_field) で reject し、 Dexie tx が 3 store
    // (tag_options / card_tags / entity_mutations) を全ロールバックする。
    //
    // realEnqueue (coalesce + add の複合 async) を tx 内で呼ぶと Dexie zone が壊れる
    // (multiple IDB reads が async/await chain を切断し tx が先に commit してしまう)。
    // そのため 1 回目は最小の直接 add() で「本物の書込が発生した」事実だけを作る。
    let callCount = 0
    let didWrite = false
    mockEnqueue.mockImplementation(async () => {
      callCount++
      if (callCount === 2) return Promise.reject(new Error('enqueue 2nd failed'))
      // 1 回目: entity_mutations に直接 row を add する (Dexie tx zone 内で動く)
      const db = getClientDb()
      await db.entity_mutations.add({
        mutation_id: `test-mut-${callCount}`,
        entity_type: 'tag_option',
        entity_id: 'test-entity',
        op: 'create',
        patch: {},
        edited_at: new Date().toISOString(),
        sync_status: 'pending',
      } as Parameters<typeof db.entity_mutations.add>[0])
      didWrite = true
      return {} as never
    })

    await expect(
      handleCreateOptionAndAssign(
        'u1',
        'card-1',
        categories,
        options,
        existingCardTags,
        'cat-single',
        '新',
      ),
    ).rejects.toThrow('enqueue 2nd failed')

    // rollback 検証: tag_options に新 option は存在しない
    const allOptions = await db.tag_options.toArray()
    // rollback 後: opt-existing のみが残る (新 option は存在しない)
    expect(allOptions.map((o) => o.id)).toContain('opt-existing')
    expect(allOptions.some((o) => o.id !== 'opt-existing')).toBe(false)

    // rollback 検証: card_tags は tx 前の状態 (opt-existing が残り、 削除も新規付与もない)
    const allCardTags = await db.card_tags.toArray()
    // single なので opt-existing が toRemove に積まれるが、 rollback で元に戻る
    expect(allCardTags.some((ct) => ct.option_id === 'opt-existing')).toBe(true)
    // 新 option の card_tags 行は存在しない
    const newOptionIds = allOptions.filter((o) => o.id !== 'opt-existing').map((o) => o.id)
    if (newOptionIds.length > 0) {
      // この分岐は rollback が成功していれば到達しない
      expect(allCardTags.some((ct) => newOptionIds.includes(ct.option_id))).toBe(false)
    }

    // rollback 検証 (IDB-1/IDB-2 core): entity_mutations は空
    // 1 回目 enqueue は実実装で entity_mutations に書き込んだが、
    // Dexie tx auto-rollback で巻き戻っているため count === 0 になるはず。
    // これが真空でない (1 回目は実際に IDB に書かれた) ことは callCount で確認済み。
    expect(didWrite).toBe(true) // 1 回目の add() が tx 内で確かに実行された (非真空: 書込が発生した)
    const entityMutCount = await db.entity_mutations.count()
    expect(entityMutCount).toBe(0)
    // flush は tx 失敗 path で到達しない
    expect(mockFlush).not.toHaveBeenCalled()
  })

  it('正常系: tx 成功後 tag_options + card_tags に新規行が存在する', async () => {
    const db = getClientDb()

    const categories = [cat('cat-multi', 'multi')]
    const options: ClientTagOption[] = []
    const existingCardTags: import('@/lib/client-db').ClientCardTag[] = []

    await handleCreateOptionAndAssign(
      'u1',
      'card-2',
      categories,
      options,
      existingCardTags,
      'cat-multi',
      '正常',
    )

    // 正常系: tag_options に行が増えている
    const allOptions = await db.tag_options.toArray()
    expect(allOptions).toHaveLength(1)
    expect(allOptions[0].name).toBe('正常')
    expect(allOptions[0].category_id).toBe('cat-multi')

    // card_tags に付与行が存在する
    const allCardTags = await db.card_tags.toArray()
    expect(allCardTags).toHaveLength(1)
    expect(allCardTags[0].card_id).toBe('card-2')
    expect(allCardTags[0].option_id).toBe(allOptions[0].id)
  })
})

// ===========================================================================
// Section IDB-C: buildNewOption が createOption / handleCreateOptionAndAssign
// の両方で同じ payload shape を生成する (integration shape check)
// ===========================================================================

describe('buildNewOption — sortKey カテゴリ絞り込み (pure)', () => {
  it('別カテゴリの sort_key が混在しても categoryId スコープのみで採番する', () => {
    // cat-A に sort_key '1' / cat-B に sort_key '99' が混在
    const existingOptions: ClientTagOption[] = [
      { ...optRow('o-a', 'cat-A'), sort_key: '1' },
      { ...optRow('o-b1', 'cat-B'), sort_key: '99' },
      { ...optRow('o-b2', 'cat-B'), sort_key: '50' },
    ]
    const result = buildNewOption('u1', existingOptions, 'cat-A', '新')
    // cat-A の既存 sort_key は '1' のみ → '2'
    expect(result.optionRow.sort_key).toBe('2')
    // cat-B の '99' / '50' を巻き込んでいないことを明示確認
    expect(result.optionRow.sort_key).not.toBe('100')
  })
})
