// @vitest-environment jsdom
// useBulkCardDelete: Grid-2 T5 bulk delete helper の unit test。
// - real Dexie (fake-indexeddb/auto) で cards / entity_mutations を実際に検証
// - enqueueEntityMutation は real 実装に委譲 (entity_mutations 行 + distinct mutation_id を
//   実 read で assert するため)。 rollback test だけ wrapper で 2 回目 throw を注入する。
// - runGuardedEntityMutationFlush は spy mock (flush 呼出回数 / 未呼出を制御)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useEffect } from 'react'

import { getClientDb, type ClientCard } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// モック: entity-mutations は real 実装へ委譲する wrapper、 entity-mutation-flush は spy。
//
// runOptimisticMutation は `@/lib/sync/entity-mutations` の enqueueEntityMutation と
// `@/lib/sync/entity-mutation-flush` の runGuardedEntityMutationFlush を内部 import する。
// - enqueue は real に委譲 (entity_mutations 行を実 IDB に書く)。 enqueueImpl 差し替えで
//   rollback test の throw 注入を可能にする。
// - flush は spy で置換し fire-and-forget の呼出回数を観測する。
// ---------------------------------------------------------------------------

const { enqueueSpy, mockFlush, enqueueHandle } = vi.hoisted(() => ({
  enqueueSpy: vi.fn(),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  // test から enqueue 実装を差し替えるための可変ハンドル。 既定は real 委譲。
  enqueueHandle: {
    current: (input: unknown, real: (input: unknown) => Promise<unknown>) => real(input),
  } as {
    current: (input: unknown, real: (input: unknown) => Promise<unknown>) => Promise<unknown>
  },
}))

vi.mock('@/lib/sync/entity-mutations', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sync/entity-mutations')>(
    '@/lib/sync/entity-mutations',
  )
  return {
    ...actual,
    enqueueEntityMutation: (input: unknown) => {
      enqueueSpy(input)
      return enqueueHandle.current(input, actual.enqueueEntityMutation as never)
    },
  }
})

vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import {
  useBulkCardDelete,
  type UseBulkCardDeleteArgs,
  type BulkDeleteFn,
} from './use-bulk-card-delete'

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function makeCard(id: string): ClientCard {
  return {
    id,
    user_id: 'user-1',
    exam_id: 'exam-1',
    title: `card-${id}`,
    question_text: `q-${id}`,
    options: [{ id: 'a', text: 'a', is_correct: true }],
    correct_answer_ids: ['a'],
    images: [],
    answered: false,
    current_streak: 0,
    due: '2026-06-01T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    content_version: 1,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    sync_status: 'synced',
  }
}

async function seedCards(ids: string[]) {
  await getClientDb().cards.bulkPut(ids.map(makeCard))
}

async function cardCount() {
  return getClientDb().cards.count()
}

async function deleteMutationRows() {
  const all = await getClientDb().entity_mutations.toArray()
  return all.filter((m) => m.op === 'delete')
}

// ---------------------------------------------------------------------------
// テスト用 wrapper: hook を呼んで bulk fn を callback で expose する
// ---------------------------------------------------------------------------

function HookWrapper({
  args,
  onReady,
}: {
  args: UseBulkCardDeleteArgs
  onReady: (fn: BulkDeleteFn) => void
}) {
  const bulk = useBulkCardDelete(args)
  useEffect(() => {
    onReady(bulk)
  }, [bulk, onReady])
  return <div data-testid="hook-wrapper" />
}

async function mountBulk(args: UseBulkCardDeleteArgs): Promise<BulkDeleteFn> {
  let bulk: BulkDeleteFn | null = null
  render(<HookWrapper args={args} onReady={(fn) => { bulk = fn }} />)
  // onReady は effect で同期発火する。
  return bulk!
}

// ---------------------------------------------------------------------------
// 共通前後処理
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks()
  enqueueHandle.current = (input, real) => real(input) // 既定は real 委譲
  const db = getClientDb()
  await db.cards.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// Case 1: N=3 削除 — cards から 3 件消える + entity_mutations に op='delete' 3 件
// ===========================================================================

describe('useBulkCardDelete — N=3 削除', () => {
  it('3 card 削除で cards が空 + entity_mutations に delete 3 件', async () => {
    await seedCards(['card-1', 'card-2', 'card-3'])
    const bulk = await mountBulk({ userId: 'user-1' })

    let result: Awaited<ReturnType<BulkDeleteFn>> | undefined
    await act(async () => {
      result = await bulk(['card-1', 'card-2', 'card-3'])
    })

    expect(await cardCount()).toBe(0)

    const rows = await deleteMutationRows()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.entity_id).sort()).toEqual(['card-1', 'card-2', 'card-3'])
    for (const r of rows) {
      expect(r.entity_type).toBe('card')
      expect(r.op).toBe('delete')
    }

    expect(result).toEqual({ ok: true, succeeded: ['card-1', 'card-2', 'card-3'], failed: [] })
  })
})

// ===========================================================================
// Case 2: distinct mutation_id — 3 件の delete 行の mutation_id が相異なる
// ===========================================================================

describe('useBulkCardDelete — distinct mutation_id', () => {
  it('3 件の delete 行は相異なる mutation_id を持つ (内部採番 + entity_id 違いで非 coalesce)', async () => {
    await seedCards(['card-1', 'card-2', 'card-3'])
    const bulk = await mountBulk({ userId: 'user-1' })

    await act(async () => {
      await bulk(['card-1', 'card-2', 'card-3'])
    })

    const rows = await deleteMutationRows()
    const ids = rows.map((r) => r.mutation_id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })
})

// ===========================================================================
// Case 3: 1 tx + 1 flush — runGuardedEntityMutationFlush は 1 回だけ
// ===========================================================================

describe('useBulkCardDelete — 1 tx + 1 flush', () => {
  it('複数 card 削除でも flush は 1 回だけ', async () => {
    await seedCards(['card-1', 'card-2', 'card-3'])
    const bulk = await mountBulk({ userId: 'user-1' })

    await act(async () => {
      await bulk(['card-1', 'card-2', 'card-3'])
    })

    expect(mockFlush).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Case 4: rollback — enqueue 2 回目で throw → cards mirror が全 3 件とも復活
// ===========================================================================

describe('useBulkCardDelete — enqueue 失敗 → 全 card rollback', () => {
  it('enqueue 2 回目で throw した場合、 bulkDelete も含め cards が全 3 件復活する', async () => {
    await seedCards(['card-1', 'card-2', 'card-3'])

    // 1 回目は real 委譲 (実際に row を書く)、 2 回目で throw → tx callback rethrow → rollback。
    let calls = 0
    enqueueHandle.current = async (input, real) => {
      calls += 1
      if (calls === 2) throw new Error('enqueue boom (2nd)')
      return real(input)
    }

    const bulk = await mountBulk({ userId: 'user-1' })

    let result: Awaited<ReturnType<BulkDeleteFn>> | undefined
    await act(async () => {
      result = await bulk(['card-1', 'card-2', 'card-3'])
    })

    // Dexie tx auto-rollback: bulkDelete + 1 回目 enqueue 共に巻き戻り、 cards は全 3 件復活。
    expect(await cardCount()).toBe(3)
    // entity_mutations にも delete 行は残らない (1 回目 add も rollback)。
    expect(await deleteMutationRows()).toHaveLength(0)

    expect(result).toEqual({ ok: false, succeeded: [], failed: ['card-1', 'card-2', 'card-3'] })

    // tx 失敗で flush 未到達。
    expect(mockFlush).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Case 5: 冪等収束 — 同 cardIds 再送が throw せず no-op
// ===========================================================================

describe('useBulkCardDelete — 冪等収束', () => {
  it('削除成功後に同じ cardIds で再度 delete しても throw せず ok:true、 cards は不在のまま', async () => {
    await seedCards(['card-1', 'card-2', 'card-3'])
    const bulk = await mountBulk({ userId: 'user-1' })

    await act(async () => {
      await bulk(['card-1', 'card-2', 'card-3'])
    })
    expect(await cardCount()).toBe(0)

    // 同 cardIds 再送: bulkDelete は不在 key に no-op (throw しない)。
    let result: Awaited<ReturnType<BulkDeleteFn>> | undefined
    await act(async () => {
      result = await bulk(['card-1', 'card-2', 'card-3'])
    })

    expect(result).toEqual({ ok: true, succeeded: ['card-1', 'card-2', 'card-3'], failed: [] })
    expect(await cardCount()).toBe(0)
  })
})

// ===========================================================================
// Case 6: 0 件 — 空配列は tx を開かず即成功、 enqueue / flush 未呼出
// ===========================================================================

describe('useBulkCardDelete — 0 件', () => {
  it('空配列は tx を張らず {ok:true, succeeded:[], failed:[]} を返す', async () => {
    await seedCards(['card-1'])
    const bulk = await mountBulk({ userId: 'user-1' })

    let result: Awaited<ReturnType<BulkDeleteFn>> | undefined
    await act(async () => {
      result = await bulk([])
    })

    expect(result).toEqual({ ok: true, succeeded: [], failed: [] })
    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
    // 既存 card は無傷。
    expect(await cardCount()).toBe(1)
  })
})
