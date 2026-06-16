// @vitest-environment jsdom
// useCardTagToggle: Grid-1 T2 hook の unit test。
// - real Dexie (fake-indexeddb/auto) で card_tags / entity_mutations を実際に検証
// - enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock
// - 5 case: add / remove / single-select 別 option / rollback / stale-closure regression

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useEffect, useState } from 'react'

import { getClientDb, type ClientTagCategory, type ClientTagOption } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// モック: entity-mutations / entity-mutation-flush (vi.hoisted で巻き上げ)
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

import { useCardTagToggle, type UseCardTagToggleArgs, type ToggleFn } from './use-card-tag-toggle'

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

// ---------------------------------------------------------------------------
// テスト用 wrapper component: hook を呼んで toggle fn を callback で expose する
// ---------------------------------------------------------------------------

function HookWrapper({
  args,
  onToggleReady,
}: {
  args: UseCardTagToggleArgs
  onToggleReady: (toggle: ToggleFn) => void
}) {
  const toggle = useCardTagToggle(args)
  useEffect(() => {
    onToggleReady(toggle)
  }, [toggle, onToggleReady])
  return <div data-testid="hook-wrapper" />
}

// ---------------------------------------------------------------------------
// テスト前後の共通処理
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
// Case 1: add — 未付与 option を toggle → card_tags に 1 row 追加 + entity_mutations enqueue
// ===========================================================================

describe('useCardTagToggle — add (未付与 option toggle)', () => {
  it('card_tags に 1 row 追加され entity_mutations に update_field enqueue される', async () => {
    const categories = [cat('c1', 'multi')]
    const options = [opt('o1', 'c1'), opt('o2', 'c1')]
    // card-1 には o1 のみ付与済み、 o2 は未付与
    const allAssignedOptionIds = ['o1']

    let capturedToggle: ToggleFn | null = null
    const getCardContext = () => ({ categories, options, allAssignedOptionIds })

    render(
      <HookWrapper
        args={{ userId: 'user-1', getCardContext }}
        onToggleReady={(t) => { capturedToggle = t }}
      />,
    )

    await act(async () => {
      await capturedToggle!('card-1', 'c1', 'o2')
    })

    // card_tags に o2 の row が追加される
    const db = getClientDb()
    const rows = await db.card_tags.where('[card_id+option_id]').equals(['card-1', 'o2']).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      card_id: 'card-1',
      option_id: 'o2',
      user_id: 'user-1',
    })

    // entity_mutations に op='update_field' patch={ field: 'tag_option_ids', value: [o1, o2] } enqueue
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const enqueueArg = (mockEnqueue as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      entity_type: string
      entity_id: string
      op: string
      patch: { field: string; value: string[] }
    }
    expect(enqueueArg.entity_type).toBe('card')
    expect(enqueueArg.entity_id).toBe('card-1')
    expect(enqueueArg.op).toBe('update_field')
    expect(enqueueArg.patch.field).toBe('tag_option_ids')
    expect(enqueueArg.patch.value).toContain('o1')
    expect(enqueueArg.patch.value).toContain('o2')
  })
})

// ===========================================================================
// Case 2: remove — 付与済み option を toggle → card_tags row 削除 + entity_mutations enqueue (value=[])
// ===========================================================================

describe('useCardTagToggle — remove (付与済み option toggle)', () => {
  it('card_tags row が削除され entity_mutations に value=[] で enqueue される', async () => {
    const db = getClientDb()
    // 事前に o1 を付与
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'o1',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })

    const categories = [cat('c1', 'multi')]
    const options = [opt('o1', 'c1')]
    const allAssignedOptionIds = ['o1']

    let capturedToggle: ToggleFn | null = null
    const getCardContext = () => ({ categories, options, allAssignedOptionIds })

    render(
      <HookWrapper
        args={{ userId: 'user-1', getCardContext }}
        onToggleReady={(t) => { capturedToggle = t }}
      />,
    )

    await act(async () => {
      await capturedToggle!('card-1', 'c1', 'o1')
    })

    // card_tags から o1 が削除される
    const count = await db.card_tags.where('[card_id+option_id]').equals(['card-1', 'o1']).count()
    expect(count).toBe(0)

    // entity_mutations に value=[] で enqueue
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const enqueueArg = (mockEnqueue as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      patch: { field: string; value: string[] }
    }
    expect(enqueueArg.patch.field).toBe('tag_option_ids')
    expect(enqueueArg.patch.value).toEqual([])
  })
})

// ===========================================================================
// Case 3: single-select 別 option — 旧 option 削除 + 新 option 追加が 1 tx 内に完了
// ===========================================================================

describe('useCardTagToggle — single-select 別 option', () => {
  it('旧 option を削除して新 option を追加 (最終状態は新 option のみ)', async () => {
    const db = getClientDb()
    // 事前に single カテゴリ c1 の o1 を付与
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'o1',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })

    const categories = [cat('c1', 'single')]
    const options = [opt('o1', 'c1'), opt('o2', 'c1')]
    const allAssignedOptionIds = ['o1']

    let capturedToggle: ToggleFn | null = null
    const getCardContext = () => ({ categories, options, allAssignedOptionIds })

    render(
      <HookWrapper
        args={{ userId: 'user-1', getCardContext }}
        onToggleReady={(t) => { capturedToggle = t }}
      />,
    )

    // 新 option o2 を toggle → single-select なので o1 を削除して o2 を追加
    await act(async () => {
      await capturedToggle!('card-1', 'c1', 'o2')
    })

    // 最終状態: o1 なし / o2 あり
    const o1Count = await db.card_tags.where('[card_id+option_id]').equals(['card-1', 'o1']).count()
    const o2Count = await db.card_tags.where('[card_id+option_id]').equals(['card-1', 'o2']).count()
    expect(o1Count).toBe(0)
    expect(o2Count).toBe(1)

    // entity_mutations の enqueue value には o2 のみ含まれる (o1 は除外済み)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const enqueueArg = (mockEnqueue as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      patch: { field: string; value: string[] }
    }
    expect(enqueueArg.patch.field).toBe('tag_option_ids')
    expect(enqueueArg.patch.value).toEqual(['o2'])
    expect(enqueueArg.patch.value).not.toContain('o1')
  })
})

// ===========================================================================
// Case 4: rollback — enqueue が throw → Dexie tx auto-rollback で card_tags も未反映
// ===========================================================================

describe('useCardTagToggle — enqueue 失敗 → rollback', () => {
  it('enqueueEntityMutation が throw した場合 card_tags も未反映 (Dexie tx auto-rollback)', async () => {
    // enqueueEntityMutation を 1 回だけ throw させる
    mockEnqueue.mockRejectedValueOnce(new Error('enqueue boom'))

    const categories = [cat('c1', 'multi')]
    const options = [opt('o1', 'c1'), opt('o2', 'c1')]
    const allAssignedOptionIds = ['o1']

    let capturedToggle: ToggleFn | null = null
    const getCardContext = () => ({ categories, options, allAssignedOptionIds })

    render(
      <HookWrapper
        args={{ userId: 'user-1', getCardContext }}
        onToggleReady={(t) => { capturedToggle = t }}
      />,
    )

    // toggle は silent return (throw しない)
    await act(async () => {
      await expect(capturedToggle!('card-1', 'c1', 'o2')).resolves.toBeUndefined()
    })

    // card_tags は未反映 (Dexie tx auto-rollback)
    const db = getClientDb()
    const count = await db.card_tags.where('[card_id+option_id]').equals(['card-1', 'o2']).count()
    expect(count).toBe(0)

    // flush も呼ばれない (catch 経路で early return)
    expect(mockFlush).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Case 5: stale-closure regression — rerender 後の getCardContext が最新値を返す
// ===========================================================================

// Wrapper component that internally holds allAssignedOptionIds as state,
// so we can trigger a re-render (new inline getCardContext arrow) via setState.
function RerenderWrapper({
  userId,
  categories,
  options,
  initialAssignedIds,
  onToggleReady,
  onSetAssignedIds,
}: {
  userId: string
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  initialAssignedIds: string[]
  onToggleReady: (toggle: ToggleFn) => void
  onSetAssignedIds: (setter: (ids: string[]) => void) => void
}) {
  const [assignedIds, setAssignedIds] = useState(initialAssignedIds)
  useEffect(() => {
    onSetAssignedIds(setAssignedIds)
  }, [onSetAssignedIds])

  // inline arrow: new reference on every render (simulates CardTagsSection pattern)
  const toggle = useCardTagToggle({
    userId,
    getCardContext: (_cardId) => ({
      categories,
      options,
      allAssignedOptionIds: assignedIds,
    }),
  })
  useEffect(() => {
    onToggleReady(toggle)
  }, [toggle, onToggleReady])
  return <div data-testid="rerender-wrapper" />
}

describe('useCardTagToggle — stale-closure regression', () => {
  it(
    'rerender 後に getCardContext を入れ替えると最新の allAssignedOptionIds で toggle が動作する (stale-closure regression)',
    async () => {
      const db = getClientDb()
      // 事前に o1 を付与 (rerender 後は assigned=['o1'] → toggle('o1') は REMOVE のはず)
      await db.card_tags.put({
        card_id: 'card-1',
        option_id: 'o1',
        user_id: 'user-1',
        created_at: '2026-06-01T00:00:00.000Z',
      })

      const categories = [cat('c1', 'multi')]
      const options = [opt('o1', 'c1')]

      let capturedToggle: ToggleFn | null = null
      let setAssigned!: (ids: string[]) => void

      render(
        <RerenderWrapper
          userId="user-1"
          categories={categories}
          options={options}
          initialAssignedIds={[]} // 初期: 未付与 (stale なら ADD 判定してしまう)
          onToggleReady={(t) => { capturedToggle = t }}
          onSetAssignedIds={(setter) => { setAssigned = setter }}
        />,
      )

      // rerender: allAssignedOptionIds を ['o1'] に更新 → getCardContext が新 arrow で返す
      await act(async () => {
        setAssigned(['o1'])
      })

      // toggle('o1'): 最新の assignedIds=['o1'] を参照すれば REMOVE、stale=[] なら ADD
      await act(async () => {
        await capturedToggle!('card-1', 'c1', 'o1')
      })

      // REMOVE assertion: card_tags から (card-1, o1) が削除されている
      const count = await db.card_tags
        .where('[card_id+option_id]')
        .equals(['card-1', 'o1'])
        .count()
      expect(count).toBe(0)

      // enqueue の patch.value=[] (REMOVE: o1 を抜いた空配列)
      expect(mockEnqueue).toHaveBeenCalledTimes(1)
      const enqueueArg = (mockEnqueue as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        patch: { field: string; value: string[] }
      }
      expect(enqueueArg.patch.field).toBe('tag_option_ids')
      // stale closure なら value=['o1'] (ADD) になるが、latest-ref なら value=[] (REMOVE)
      expect(enqueueArg.patch.value).toEqual([])
    },
  )
})
