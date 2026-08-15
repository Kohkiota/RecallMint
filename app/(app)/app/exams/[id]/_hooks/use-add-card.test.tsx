// @vitest-environment jsdom
// useAddCard: Row-UX sprint Task 3 の抽出 hook unit test。
// - real Dexie (fake-indexeddb/auto、 vitest.setup.ts で全 test に供給) で cards /
//   entity_mutations を実際に検証する。
// - enqueueEntityMutation は real 実装へ委譲する wrapper (rollback test だけ throw を注入)。
// - runGuardedEntityMutationFlush は spy mock。
// - newId は spy mock (実 UUID を返す、 呼出捕捉用)。
// - buildEmptyCard は real 実装へ委譲する spy wrapper (呼出順 pin 用。 内容自体は本 test の
//   関心でない — 内容の pin は inline-card-list.test.tsx 側の既存 assertion が担う)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useEffect } from 'react'

import { getClientDb } from '@/lib/client-db'

const {
  mockNewId,
  realNewId,
  buildEmptyCardSpy,
  mockFlush,
  enqueueSpy,
  enqueueHandle,
} = vi.hoisted(() => ({
  mockNewId: vi.fn<() => string>(),
  realNewId: { current: (): string => crypto.randomUUID() },
  buildEmptyCardSpy: vi.fn(),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  enqueueSpy: vi.fn(),
  // test から enqueue 実装を差し替えるための可変ハンドル。 既定は real 委譲
  // (use-bulk-card-delete.test.tsx と同 pattern)。
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
    newId: mockNewId,
    enqueueEntityMutation: (input: unknown) => {
      enqueueSpy(input)
      return enqueueHandle.current(input, actual.enqueueEntityMutation as never)
    },
  }
})
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))
// buildEmptyCard の呼出順 (onIdMinted との前後関係) を invocationCallOrder で pin する
// ため、 real 実装へ委譲する spy wrapper に差し替える。
vi.mock('@/lib/cards/empty-card', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cards/empty-card')>(
    '@/lib/cards/empty-card',
  )
  return {
    ...actual,
    buildEmptyCard: (...args: Parameters<typeof actual.buildEmptyCard>) => {
      buildEmptyCardSpy(...args)
      return actual.buildEmptyCard(...args)
    },
  }
})

import { useAddCard, type AddCardFn, type UseAddCardArgs } from './use-add-card'

const TEST_USER_ID = 'user-1'
const TEST_EXAM_ID = 'exam-1'

// ---------------------------------------------------------------------------
// テスト用 wrapper: hook を呼んで addCard fn を callback で expose する
// (use-bulk-card-delete.test.tsx と同 pattern)。
// ---------------------------------------------------------------------------

function HookWrapper({
  args,
  onReady,
}: {
  args: UseAddCardArgs
  onReady: (fn: AddCardFn) => void
}) {
  const { addCard } = useAddCard(args)
  useEffect(() => {
    onReady(addCard)
  }, [addCard, onReady])
  return <div data-testid="hook-wrapper" />
}

async function mountAddCard(args: UseAddCardArgs): Promise<AddCardFn> {
  let addCard: AddCardFn | null = null
  render(<HookWrapper args={args} onReady={(fn) => { addCard = fn }} />)
  // onReady は effect で同期発火する。
  return addCard!
}

async function createMutationRows() {
  const all = await getClientDb().entity_mutations.toArray()
  return all.filter((m) => m.op === 'create')
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockNewId.mockImplementation(() => realNewId.current())
  enqueueHandle.current = (input, real) => real(input) // 既定は real 委譲
  const db = getClientDb()
  await db.cards.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// Case 1 (① pin): addCard 呼出直後 (await 前) に onIdMinted が同期発火済
// ===========================================================================

describe('useAddCard — onIdMinted の同期発火 (await 前)', () => {
  it('addCard(...) 呼出直後 (await する前) に onIdMinted が既に呼ばれている', async () => {
    const addCard = await mountAddCard({ userId: TEST_USER_ID, examId: TEST_EXAM_ID })
    const onIdMinted = vi.fn()

    let pending: Promise<string>
    // act の同期部分でのみ addCard を呼び、 await はまだしない。 async function は
    // 最初の await に達するまで同期実行されるため、 ここで onIdMinted の同期発火を検証できる。
    act(() => {
      pending = addCard([], 0, { onIdMinted })
    })

    // await する前に既に発火している (このアサーションが red 検証対象:
    // 実装で onIdMinted を最初の await より後に動かすと、 ここで未呼出のまま fail する)。
    expect(onIdMinted).toHaveBeenCalledTimes(1)

    // 後始末: tx を完了させる (未 await の promise を放置しない)。
    await act(async () => {
      await pending
    })
  })
})

// ===========================================================================
// Case 2 (② pin): buildEmptyCard → onIdMinted の呼出順 (invocationCallOrder)
// ===========================================================================

describe('useAddCard — 呼出順 (buildEmptyCard が onIdMinted より先)', () => {
  it('buildEmptyCard の呼出順が onIdMinted より先 (invocationCallOrder で比較)', async () => {
    const addCard = await mountAddCard({ userId: TEST_USER_ID, examId: TEST_EXAM_ID })
    const onIdMinted = vi.fn()

    await act(async () => {
      await addCard([1024, 5120], 2, { onIdMinted })
    })

    expect(buildEmptyCardSpy).toHaveBeenCalledTimes(1)
    expect(onIdMinted).toHaveBeenCalledTimes(1)
    const buildOrder = buildEmptyCardSpy.mock.invocationCallOrder[0]!
    const idMintedOrder = onIdMinted.mock.invocationCallOrder[0]!
    // このアサーションが red 検証対象: 実装で呼出順を反転する (onIdMinted を
    // buildEmptyCard より先に呼ぶ) と buildOrder > idMintedOrder になり fail する。
    expect(buildOrder).toBeLessThan(idMintedOrder)
  })
})

// ===========================================================================
// Case 3: 返り値 id = onIdMinted の id = mirror 行 id
// ===========================================================================

describe('useAddCard — 返り値 id の一致', () => {
  it('addCard の返り値 = onIdMinted に渡った id = mirror 行の id', async () => {
    const NEW_ID = '99999999-9999-4999-8999-999999999999'
    mockNewId.mockImplementationOnce(() => NEW_ID)
    const addCard = await mountAddCard({ userId: TEST_USER_ID, examId: TEST_EXAM_ID })
    let mintedId: string | undefined

    let result = ''
    await act(async () => {
      result = await addCard([], 0, { onIdMinted: (id) => { mintedId = id } })
    })

    expect(result).toBe(NEW_ID)
    expect(mintedId).toBe(NEW_ID)
    const row = await getClientDb().cards.get(NEW_ID)
    expect(row).toBeDefined()
    expect(row!.id).toBe(NEW_ID)
  })
})

// ===========================================================================
// Case 4: mirror insert + outbox enqueue (op='create') 成立
// ===========================================================================

describe('useAddCard — mirror insert + outbox enqueue', () => {
  it('mirror に完全な card row が insert され、 entity_mutations に op=create 1 件が enqueue される', async () => {
    const NEW_ID = '88888888-8888-4888-8888-888888888888'
    mockNewId.mockImplementationOnce(() => NEW_ID)
    const addCard = await mountAddCard({ userId: TEST_USER_ID, examId: TEST_EXAM_ID })

    await act(async () => {
      await addCard([1024, 5120], 2, {})
    })

    const row = (await getClientDb().cards.get(NEW_ID))!
    expect(row.user_id).toBe(TEST_USER_ID)
    expect(row.exam_id).toBe(TEST_EXAM_ID)
    // 末尾採番: max(1024, 5120) + 1024 = 6144。 count=2 → title は「新規カード 3」。
    expect(row.base_order).toBe(6144)
    expect(row.title).toBe('新規カード 3')
    expect(row.sync_status).toBe('pending')

    const rows = await createMutationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.entity_type).toBe('card')
    expect(rows[0]!.entity_id).toBe(NEW_ID)
    expect(rows[0]!.op).toBe('create')

    expect(mockFlush).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Case 5: 失敗経路 (enqueue throw) で rethrow + mirror rollback
// ===========================================================================

describe('useAddCard — enqueue throw → rethrow + mirror rollback', () => {
  it('enqueue が throw すると addCard が rethrow し、 mirror 行も rollback で残らない', async () => {
    enqueueHandle.current = async () => {
      throw new Error('enqueue boom')
    }
    const addCard = await mountAddCard({ userId: TEST_USER_ID, examId: TEST_EXAM_ID })

    let caught: unknown
    await act(async () => {
      try {
        await addCard([], 0, {})
      } catch (err) {
        caught = err
      }
    })

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('enqueue boom')
    // Dexie tx auto-rollback: mirror insert も巻き戻る。
    expect(await getClientDb().cards.count()).toBe(0)
    expect(await createMutationRows()).toHaveLength(0)
    // tx 失敗で flush 未到達。
    expect(mockFlush).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Case 6 (⑥ pin): onIdMinted throw → reject + mirror / outbox 不書込
// ===========================================================================

describe('useAddCard — onIdMinted throw → 同期伝播 reject + enqueue 前に不書込', () => {
  it('onIdMinted が throw すると addCard がその例外で reject し、 mirror insert / outbox enqueue は発生しない', async () => {
    const addCard = await mountAddCard({ userId: TEST_USER_ID, examId: TEST_EXAM_ID })
    const boom = new Error('onIdMinted boom')

    let caught: unknown
    await act(async () => {
      try {
        await addCard([], 0, {
          onIdMinted: () => {
            throw boom
          },
        })
      } catch (err) {
        caught = err
      }
    })

    // 同期伝播した例外がそのまま addCard の reject 理由になる (握り潰されない)。
    expect(caught).toBe(boom)
    // enqueue 前に reject するため mirror / outbox 双方とも不書込。
    expect(await getClientDb().cards.count()).toBe(0)
    expect(await createMutationRows()).toHaveLength(0)
    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
  })
})
