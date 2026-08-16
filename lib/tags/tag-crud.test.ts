// tag-crud.test.ts — tag-mirror-correctness sprint T1 pin②③
//
// fake-indexeddb (vitest.setup.ts) で実 Dexie を動かし、 owner-scope guard の契約を pin する。
// runGuardedEntityMutationFlush のみ mock (lib/sync/optimistic-mutation.test.ts と同 pattern)、
// mirror read/write と outbox enqueue は実 Dexie query で検証する。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getClientDb, type ClientTagCategory, type ClientTagOption } from '@/lib/client-db'
import { getPendingEntityMutations } from '@/lib/sync/entity-mutations'

const { mockGuardedFlush } = vi.hoisted(() => ({
  mockGuardedFlush: vi.fn(async () => 'no-pending' as const),
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockGuardedFlush,
}))

import {
  handleRenameCategory,
  handleSetCategoryColor,
  handleRenameOption,
  handleSetOptionColor,
} from './tag-crud'

const USER_A = 'user-A'
const USER_B = 'user-B'

const cat = (overrides: Partial<ClientTagCategory> & { id: string }): ClientTagCategory => ({
  user_id: USER_A,
  name: 'Cat',
  select_type: 'single',
  color: null,
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  ...overrides,
})

const opt = (overrides: Partial<ClientTagOption> & { id: string; category_id: string }): ClientTagOption => ({
  user_id: USER_A,
  name: 'Opt',
  color: null,
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  ...overrides,
})

beforeEach(async () => {
  const db = getClientDb()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.entity_mutations.clear()
  mockGuardedFlush.mockClear()
})

// ---------------------------------------------------------------------------
// pin②: handleRenameCategory の同名 check は owner-scope (user-B の同名 category と
// 衝突しない、 throw しない)
// ---------------------------------------------------------------------------

describe('handleRenameCategory — 同名 check は owner-scope (pin②)', () => {
  it('user-B の同名 category とは衝突せず throw しない', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([
      cat({ id: 'cat-A', user_id: USER_A, name: 'Foo' }),
      cat({ id: 'cat-B', user_id: USER_B, name: 'Bar' }),
    ])

    // user-A の cat-A を 'Bar' に rename。 user-A 自身の他 category に 'Bar' は無いので
    // 衝突は起きない — user-B の 'Bar' が見えていれば (旧: 全店 toArray) throw する。
    await expect(handleRenameCategory(USER_A, 'cat-A', 'Bar')).resolves.toBeUndefined()

    const after = await db.tag_categories.get('cat-A')
    expect(after!.name).toBe('Bar')
  })

  it('user-A 自身の同名 category とは従来通り衝突して throw する', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([
      cat({ id: 'cat-A1', user_id: USER_A, name: 'Foo' }),
      cat({ id: 'cat-A2', user_id: USER_A, name: 'Bar' }),
    ])

    await expect(handleRenameCategory(USER_A, 'cat-A1', 'Bar')).rejects.toThrow(
      '同名のカテゴリが既にあります',
    )
  })
})

// ---------------------------------------------------------------------------
// pin③: 4 handler に他 owner (user-B) の行 id を渡すと no-op (mirror 不変・outbox enqueue なし)
// ---------------------------------------------------------------------------

describe('owner-scope guard — 他 owner の行 id は no-op (pin③)', () => {
  it('handleRenameCategory: user-B の category id を渡すと no-op', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([cat({ id: 'cat-B', user_id: USER_B, name: 'Theirs' })])

    await handleRenameCategory(USER_A, 'cat-B', 'Hijacked')

    const after = await db.tag_categories.get('cat-B')
    expect(after!.name).toBe('Theirs') // mirror 不変
    expect(await getPendingEntityMutations(USER_A)).toHaveLength(0)
    expect(await getPendingEntityMutations(USER_B)).toHaveLength(0)
  })

  it('handleSetCategoryColor: user-B の category id を渡すと no-op', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([
      cat({ id: 'cat-B', user_id: USER_B, name: 'Theirs', color: '#111111' }),
    ])

    await handleSetCategoryColor(USER_A, 'cat-B', '#ffffff')

    const after = await db.tag_categories.get('cat-B')
    expect(after!.color).toBe('#111111') // mirror 不変
    expect(await getPendingEntityMutations(USER_A)).toHaveLength(0)
    expect(await getPendingEntityMutations(USER_B)).toHaveLength(0)
  })

  it('handleRenameOption: user-B の option id を渡すと no-op', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([cat({ id: 'cat-B', user_id: USER_B, name: 'Theirs' })])
    await db.tag_options.bulkPut([
      opt({ id: 'opt-B', category_id: 'cat-B', user_id: USER_B, name: 'TheirOpt' }),
    ])

    await handleRenameOption(USER_A, 'opt-B', 'Hijacked')

    const after = await db.tag_options.get('opt-B')
    expect(after!.name).toBe('TheirOpt') // mirror 不変
    expect(await getPendingEntityMutations(USER_A)).toHaveLength(0)
    expect(await getPendingEntityMutations(USER_B)).toHaveLength(0)
  })

  it('handleSetOptionColor: user-B の option id を渡すと no-op', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([cat({ id: 'cat-B', user_id: USER_B, name: 'Theirs' })])
    await db.tag_options.bulkPut([
      opt({ id: 'opt-B', category_id: 'cat-B', user_id: USER_B, name: 'TheirOpt', color: '#111111' }),
    ])

    await handleSetOptionColor(USER_A, 'opt-B', '#ffffff')

    const after = await db.tag_options.get('opt-B')
    expect(after!.color).toBe('#111111') // mirror 不変
    expect(await getPendingEntityMutations(USER_A)).toHaveLength(0)
    expect(await getPendingEntityMutations(USER_B)).toHaveLength(0)
  })
})
