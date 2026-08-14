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

const { enqueueSpy, mockFlush, mockReclaimLocalAssetBlobs, enqueueHandle } = vi.hoisted(() => ({
  enqueueSpy: vi.fn(),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  mockReclaimLocalAssetBlobs: vi.fn(async (_userId: string, _assetIds: string[]) => undefined),
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
vi.mock('@/lib/media/reclaim-local-asset-blobs', () => ({
  reclaimLocalAssetBlobs: mockReclaimLocalAssetBlobs,
}))

import {
  useBulkCardDelete,
  type UseBulkCardDeleteArgs,
  type BulkDeleteFn,
} from './use-bulk-card-delete'

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function makeCard(id: string, images: ClientCard['images'] = []): ClientCard {
  return {
    id,
    user_id: 'user-1',
    exam_id: 'exam-1',
    base_order: 1024,
    title: `card-${id}`,
    question_text: `q-${id}`,
    options: [{ id: 'a', text: 'a', is_correct: true }],
    correct_answer_ids: ['a'],
    images,
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
  await getClientDb().cards.bulkPut(ids.map((id) => makeCard(id)))
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
    // tx rollback 時は reclaim も呼ばれない(削除が成立していないため掃除対象なし)。
    expect(mockReclaimLocalAssetBlobs).not.toHaveBeenCalled()
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
    expect(mockReclaimLocalAssetBlobs).not.toHaveBeenCalled()
    // 既存 card は無傷。
    expect(await cardCount()).toBe(1)
  })
})

// ===========================================================================
// Case 7: ローカル Cache blob 掃除(spec §4.7) — 全 card の UUID key を収集し reclaim
// ===========================================================================

describe('useBulkCardDelete — ローカル Cache blob 掃除(spec §4.7)', () => {
  const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const UUID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const LEGACY_KEY = 'img-1'

  it('削除前に全 card の UUID key を収集し、 削除後に reclaimLocalAssetBlobs を 1 回呼ぶ', async () => {
    await getClientDb().cards.bulkPut([
      makeCard('card-1', [
        { key: UUID_A, target: 'question_text', alt: '' },
        { key: LEGACY_KEY, target: 'question_text', alt: '' },
      ]),
      makeCard('card-2', [{ key: UUID_B, target: 'question_text', alt: '' }]),
      makeCard('card-3', []),
    ])
    const bulk = await mountBulk({ userId: 'user-1' })

    await act(async () => {
      await bulk(['card-1', 'card-2', 'card-3'])
    })

    expect(await cardCount()).toBe(0)
    expect(mockReclaimLocalAssetBlobs).toHaveBeenCalledTimes(1)
    const [userIdArg, keysArg] = mockReclaimLocalAssetBlobs.mock.calls[0]!
    expect(userIdArg).toBe('user-1')
    // legacy key は対象外、 UUID key のみ(card 順不同許容で集合比較)。
    expect(new Set(keysArg)).toEqual(new Set([UUID_A, UUID_B]))
  })

  it('選択 card 全てに UUID key が無ければ reclaimLocalAssetBlobs を空配列で呼ぶ', async () => {
    await seedCards(['card-1', 'card-2'])
    const bulk = await mountBulk({ userId: 'user-1' })

    await act(async () => {
      await bulk(['card-1', 'card-2'])
    })

    expect(mockReclaimLocalAssetBlobs).toHaveBeenCalledWith('user-1', [])
  })

  it('UUID_C を含む単独 card 削除でも該当 key のみ渡る', async () => {
    await getClientDb().cards.put(
      makeCard('card-x', [{ key: UUID_C, target: 'option:1', alt: '' }]),
    )
    const bulk = await mountBulk({ userId: 'user-1' })

    await act(async () => {
      await bulk(['card-x'])
    })

    expect(mockReclaimLocalAssetBlobs).toHaveBeenCalledWith('user-1', [UUID_C])
  })

  it('削除前 pre-read (bulkGet) が reject → never-throw 契約を維持し {ok:false, failed:[...cardIds]}、 reclaim しない', async () => {
    // key 収集の pre-read が try 外にあると、 read reject が never-throw all-or-nothing 契約を
    // 破る。 pre-read を try 内に置くことで既存 catch の failed 経路に集約する。
    await seedCards(['card-1', 'card-2'])
    const spy = vi
      .spyOn(getClientDb().cards, 'bulkGet')
      .mockRejectedValueOnce(new Error('idb read boom'))
    const bulk = await mountBulk({ userId: 'user-1' })

    let result: Awaited<ReturnType<BulkDeleteFn>> | undefined
    await act(async () => {
      result = await bulk(['card-1', 'card-2'])
    })

    expect(result).toEqual({ ok: false, succeeded: [], failed: ['card-1', 'card-2'] })
    // card は削除されず (mutate に到達しない)、 reclaim も呼ばれない。
    expect(await cardCount()).toBe(2)
    expect(mockReclaimLocalAssetBlobs).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('stale mirror で images が非配列でも key 収集で throw せず削除は成立し 有効 card の key のみ渡る', async () => {
    // 旧 schema / 破損 row 想定: 一部 card の images が array でない (Array.isArray 防御)。
    // `?? []` は null/undefined しか救わないため、 非配列で .filter が throw して bulk 削除
    // 全体が失敗する regression を防ぐ。
    const staleCard = makeCard('card-stale', [])
    ;(staleCard as unknown as { images: unknown }).images = 'corrupt'
    await getClientDb().cards.bulkPut([
      staleCard,
      makeCard('card-ok', [{ key: UUID_A, target: 'question_text', alt: '' }]),
    ])
    const bulk = await mountBulk({ userId: 'user-1' })

    let result: Awaited<ReturnType<BulkDeleteFn>> | undefined
    await act(async () => {
      result = await bulk(['card-stale', 'card-ok'])
    })

    // 削除は成立する (key 収集で throw して bulk 全体が失敗しない)。
    expect(result).toEqual({ ok: true, succeeded: ['card-stale', 'card-ok'], failed: [] })
    expect(await cardCount()).toBe(0)
    // 有効 card の UUID key のみ渡る (stale card は空)。
    expect(mockReclaimLocalAssetBlobs).toHaveBeenCalledWith('user-1', [UUID_A])
  })
})
