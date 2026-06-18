// @vitest-environment jsdom
// useBulkCardTags: Grid-2 T4 bulk tag helper の unit test。
// - real Dexie (fake-indexeddb/auto) で card_tags を実際に検証
// - enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock
//   (runOptimisticMutation が見る enqueue を mock で置換する)
// - rollback test は enqueue 2 回目で throw させ、 1 card 目の mirror write も revert される
//   atomicity を fake-indexeddb の実 read で実証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useEffect } from 'react'

import { getClientDb, type ClientTagCategory, type ClientTagOption } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// モック: entity-mutations / entity-mutation-flush (vi.hoisted で巻き上げ)
//
// runOptimisticMutation は `@/lib/sync/entity-mutations` の enqueueEntityMutation と
// `@/lib/sync/entity-mutation-flush` の runGuardedEntityMutationFlush を内部 import する。
// 本 test はその 2 import を mock で置換し、 enqueue 呼出回数 / flush 呼出回数 / throw 注入を制御する。
// ---------------------------------------------------------------------------

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: mockEnqueue,
}))

vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import {
  useBulkCardTags,
  type UseBulkCardTagsArgs,
  type BulkTagFn,
} from './use-bulk-card-tags'

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const cat = (
  id: string,
  selectType: 'single' | 'multi' = 'multi',
): ClientTagCategory => ({
  id,
  user_id: 'user-1',
  name: `cat-${id}`,
  select_type: selectType,
  color: null,
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
})

const opt = (id: string, categoryId: string): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id: categoryId,
  name: `opt-${id}`,
  color: null,
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
})

// per-card の assigned option_id を保持する Map から getCardTags を組む。
// categories / options は全 card 共通 (本 test では 1 category + その options)。
function makeGetCardTags(
  categories: ClientTagCategory[],
  options: ClientTagOption[],
  assignedByCard: Map<string, string[]>,
): UseBulkCardTagsArgs['getCardTags'] {
  return (cardId: string) => {
    const allAssignedOptionIds = assignedByCard.get(cardId)
    if (allAssignedOptionIds === undefined) return undefined
    return { categories, options, allAssignedOptionIds }
  }
}

// ---------------------------------------------------------------------------
// テスト用 wrapper: hook を呼んで bulk fn を callback で expose する
// ---------------------------------------------------------------------------

function HookWrapper({
  args,
  onReady,
}: {
  args: UseBulkCardTagsArgs
  onReady: (fn: BulkTagFn) => void
}) {
  const bulk = useBulkCardTags(args)
  useEffect(() => {
    onReady(bulk)
  }, [bulk, onReady])
  return <div data-testid="hook-wrapper" />
}

async function seedCardTag(cardId: string, optionId: string) {
  await getClientDb().card_tags.put({
    card_id: cardId,
    option_id: optionId,
    user_id: 'user-1',
    created_at: '2026-06-01T00:00:00.000Z',
  })
}

async function cardTagCount(cardId: string, optionId: string) {
  return getClientDb()
    .card_tags.where('[card_id+option_id]')
    .equals([cardId, optionId])
    .count()
}

// ---------------------------------------------------------------------------
// 共通前後処理
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks()
  const db = getClientDb()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// Case 1: add — 未保持 3 card に put + enqueue 3 件、 保持済み 1 card は no-op
// ===========================================================================

describe('useBulkCardTags — add gate', () => {
  it('未保持 3 card のみ put + enqueue 3 件、 保持済み card は no-op、 succeeded=全 4 card', async () => {
    const categories = [cat('c1', 'multi')]
    const options = [opt('o1', 'c1')]
    // card-1 は既に o1 保持 (add → no-op)、 card-2/3/4 は未保持
    const assigned = new Map<string, string[]>([
      ['card-1', ['o1']],
      ['card-2', []],
      ['card-3', []],
      ['card-4', []],
    ])
    await seedCardTag('card-1', 'o1')

    let bulk: BulkTagFn | null = null
    render(
      <HookWrapper
        args={{ userId: 'user-1', getCardTags: makeGetCardTags(categories, options, assigned) }}
        onReady={(fn) => { bulk = fn }}
      />,
    )

    let result: Awaited<ReturnType<BulkTagFn>> | undefined
    await act(async () => {
      result = await bulk!(['card-1', 'card-2', 'card-3', 'card-4'], 'c1', 'o1', 'add')
    })

    // 未保持 3 card に o1 が追加される
    expect(await cardTagCount('card-2', 'o1')).toBe(1)
    expect(await cardTagCount('card-3', 'o1')).toBe(1)
    expect(await cardTagCount('card-4', 'o1')).toBe(1)
    // 保持済み card-1 は依然 1 row (重複 put されていない / 削除もされていない)
    expect(await cardTagCount('card-1', 'o1')).toBe(1)

    // enqueue は変更対象 3 card 分のみ
    expect(mockEnqueue).toHaveBeenCalledTimes(3)
    const enqueuedIds = (mockEnqueue as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { entity_id: string }).entity_id,
    )
    expect(enqueuedIds.sort()).toEqual(['card-2', 'card-3', 'card-4'])
    // 全 enqueue が card update_field / value=[o1]
    for (const call of (mockEnqueue as ReturnType<typeof vi.fn>).mock.calls) {
      const arg = call[0] as { entity_type: string; op: string; patch: { field: string; value: string[] } }
      expect(arg.entity_type).toBe('card')
      expect(arg.op).toBe('update_field')
      expect(arg.patch.field).toBe('tag_option_ids')
      expect(arg.patch.value).toEqual(['o1'])
    }

    // BulkResult.succeeded = 全 4 card (no-op card 含む)
    expect(result).toEqual({ ok: true, succeeded: ['card-1', 'card-2', 'card-3', 'card-4'], failed: [] })
  })
})

// ===========================================================================
// Case 2: remove — 保持済み 2 card のみ remove + enqueue 2 件、 未保持 card は no-op
// ===========================================================================

describe('useBulkCardTags — remove gate', () => {
  it('保持済み 2 card のみ remove + enqueue 2 件、 未保持 card は no-op', async () => {
    const categories = [cat('c1', 'multi')]
    const options = [opt('o1', 'c1')]
    const assigned = new Map<string, string[]>([
      ['card-1', ['o1']],
      ['card-2', ['o1']],
      ['card-3', []],
      ['card-4', []],
    ])
    await seedCardTag('card-1', 'o1')
    await seedCardTag('card-2', 'o1')

    let bulk: BulkTagFn | null = null
    render(
      <HookWrapper
        args={{ userId: 'user-1', getCardTags: makeGetCardTags(categories, options, assigned) }}
        onReady={(fn) => { bulk = fn }}
      />,
    )

    let result: Awaited<ReturnType<BulkTagFn>> | undefined
    await act(async () => {
      result = await bulk!(['card-1', 'card-2', 'card-3', 'card-4'], 'c1', 'o1', 'remove')
    })

    // 保持済み 2 card から o1 が削除される
    expect(await cardTagCount('card-1', 'o1')).toBe(0)
    expect(await cardTagCount('card-2', 'o1')).toBe(0)
    // 未保持 card は元から 0 (変化なし)
    expect(await cardTagCount('card-3', 'o1')).toBe(0)
    expect(await cardTagCount('card-4', 'o1')).toBe(0)

    // enqueue は保持済み 2 card 分のみ、 value=[]
    expect(mockEnqueue).toHaveBeenCalledTimes(2)
    const enqueuedIds = (mockEnqueue as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { entity_id: string }).entity_id,
    )
    expect(enqueuedIds.sort()).toEqual(['card-1', 'card-2'])
    for (const call of (mockEnqueue as ReturnType<typeof vi.fn>).mock.calls) {
      const arg = call[0] as { patch: { field: string; value: string[] } }
      expect(arg.patch.field).toBe('tag_option_ids')
      expect(arg.patch.value).toEqual([])
    }

    expect(result).toEqual({ ok: true, succeeded: ['card-1', 'card-2', 'card-3', 'card-4'], failed: [] })
  })
})

// ===========================================================================
// Case 3: 1 tx + 1 flush — runGuardedEntityMutationFlush は 1 回だけ呼ばれる
// ===========================================================================

describe('useBulkCardTags — 1 tx + 1 flush', () => {
  it('複数 card 変更でも flush は 1 回だけ', async () => {
    const categories = [cat('c1', 'multi')]
    const options = [opt('o1', 'c1')]
    const assigned = new Map<string, string[]>([
      ['card-1', []],
      ['card-2', []],
      ['card-3', []],
    ])

    let bulk: BulkTagFn | null = null
    render(
      <HookWrapper
        args={{ userId: 'user-1', getCardTags: makeGetCardTags(categories, options, assigned) }}
        onReady={(fn) => { bulk = fn }}
      />,
    )

    await act(async () => {
      await bulk!(['card-1', 'card-2', 'card-3'], 'c1', 'o1', 'add')
    })

    expect(mockFlush).toHaveBeenCalledTimes(1)
  })

  it('変更対象 0 件 (全 no-op) は tx も flush も張らず即成功を返す', async () => {
    const categories = [cat('c1', 'multi')]
    const options = [opt('o1', 'c1')]
    // 全 card 既に o1 保持 → add は全 no-op
    const assigned = new Map<string, string[]>([
      ['card-1', ['o1']],
      ['card-2', ['o1']],
    ])
    await seedCardTag('card-1', 'o1')
    await seedCardTag('card-2', 'o1')

    let bulk: BulkTagFn | null = null
    render(
      <HookWrapper
        args={{ userId: 'user-1', getCardTags: makeGetCardTags(categories, options, assigned) }}
        onReady={(fn) => { bulk = fn }}
      />,
    )

    let result: Awaited<ReturnType<BulkTagFn>> | undefined
    await act(async () => {
      result = await bulk!(['card-1', 'card-2'], 'c1', 'o1', 'add')
    })

    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, succeeded: ['card-1', 'card-2'], failed: [] })
  })
})

// ===========================================================================
// Case 4: rollback — enqueue 2 回目で throw → 全 card の mirror write が revert
// (1 card 目の put も巻き戻る atomicity を実証)
// ===========================================================================

describe('useBulkCardTags — enqueue 失敗 → 全 card rollback', () => {
  it('enqueue 2 回目で throw した場合、 1 card 目の put も含め card_tags が全 card 未反映に戻る', async () => {
    // 1 回目成功 / 2 回目 throw。 runOptimisticMutation は changes 順に enqueue するため、
    // 「一部 enqueue 成功後の throw でも 1 card 目の mirror write が rollback される」を実証。
    let calls = 0
    mockEnqueue.mockImplementation(async () => {
      calls += 1
      if (calls === 2) throw new Error('enqueue boom (2nd)')
      return {} as never
    })

    const categories = [cat('c1', 'multi')]
    const options = [opt('o1', 'c1')]
    // 2 card とも未保持 → add は 2 card とも変更対象 (enqueue 2 件 = 2 回目で throw)
    const assigned = new Map<string, string[]>([
      ['card-1', []],
      ['card-2', []],
    ])

    let bulk: BulkTagFn | null = null
    render(
      <HookWrapper
        args={{ userId: 'user-1', getCardTags: makeGetCardTags(categories, options, assigned) }}
        onReady={(fn) => { bulk = fn }}
      />,
    )

    let result: Awaited<ReturnType<BulkTagFn>> | undefined
    await act(async () => {
      result = await bulk!(['card-1', 'card-2'], 'c1', 'o1', 'add')
    })

    // 全 card の card_tags が未反映 (Dexie tx auto-rollback、 1 card 目の put も revert)
    expect(await cardTagCount('card-1', 'o1')).toBe(0)
    expect(await cardTagCount('card-2', 'o1')).toBe(0)

    // BulkResult.ok===false / failed===全 cardIds
    expect(result).toEqual({ ok: false, succeeded: [], failed: ['card-1', 'card-2'] })

    // flush は呼ばれない (tx 失敗で runOptimisticMutation の catch 経路、 flush 未到達)
    expect(mockFlush).not.toHaveBeenCalled()
  })
})
