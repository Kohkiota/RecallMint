// @vitest-environment jsdom
// useCardOptions hook の最小 unit test (Edit-2 T1)。
// - handlers が working-set (options / autoEditOptionId) を更新することを検証。
// - commit が runOptimisticUpdate を呼ぶことを検証。
//
// runOptimisticUpdate / runGuardedEntityMutationFlush は spy mock。
// getClientDb() は fake-indexeddb (test 環境の Dexie) をそのまま使う。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { CardOption } from '@/lib/db/schema'
import { getClientDb } from '@/lib/client-db'

const { mockRunOptimistic, mockFlush } = vi.hoisted(() => ({
  mockRunOptimistic: vi.fn(async () => {}),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/optimistic-mutation', () => ({
  runOptimisticUpdate: mockRunOptimistic,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { useCardOptions } from './use-card-options'

const CARD_ID = '11111111-1111-4111-8111-111111111111'

const baseOptions: CardOption[] = [
  { id: 'a', text: '選択肢A', is_correct: false },
  { id: 'b', text: '選択肢B', is_correct: false },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useCardOptions — handlers が working-set を更新する', () => {
  it('handleCheckboxToggle → 対象 index の is_correct が更新される', () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      result.current.handleCheckboxToggle(0, true)
    })
    expect(result.current.options[0]!.is_correct).toBe(true)
    expect(result.current.options[1]!.is_correct).toBe(false)
  })

  it('handleAddOption → working-set に新規 option が末尾追加され autoEditOptionId が set される', () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      result.current.handleAddOption()
    })
    expect(result.current.options).toHaveLength(3)
    expect(result.current.autoEditOptionId).not.toBeNull()
    // nextOptionId(a, b) → c
    expect(result.current.options[2]!.id).toBe('c')
    expect(result.current.options[2]!.text).toBe('')
  })

  it('handleDeleteOption → 対象 index の option が除去される', () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      result.current.handleDeleteOption(1)
    })
    expect(result.current.options).toHaveLength(1)
    expect(result.current.options[0]!.id).toBe('a')
  })

  it('handleDeleteOption: options.length === 1 → no-op (削除しない)', () => {
    const single: CardOption[] = [{ id: 'a', text: 'A', is_correct: false }]
    const { result } = renderHook(() => useCardOptions(CARD_ID, single))
    act(() => {
      result.current.handleDeleteOption(0)
    })
    expect(result.current.options).toHaveLength(1)
  })

  it('handleCellSave → 対象 index の option が更新される', () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      result.current.handleCellSave(0, { id: 'a', text: '更新A', is_correct: false })
    })
    expect(result.current.options[0]!.text).toBe('更新A')
    // 他 index は変わらない
    expect(result.current.options[1]!.text).toBe('選択肢B')
  })

  it('canDelete: options > 1 → true', () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    expect(result.current.canDelete).toBe(true)
  })

  it('canDelete: options === 1 → false', () => {
    const single: CardOption[] = [{ id: 'a', text: 'A', is_correct: false }]
    const { result } = renderHook(() => useCardOptions(CARD_ID, single))
    expect(result.current.canDelete).toBe(false)
  })

  it('correctIds: is_correct=true の option id のみ返す', () => {
    const opts: CardOption[] = [
      { id: 'a', text: 'A', is_correct: true },
      { id: 'b', text: 'B', is_correct: false },
      { id: 'c', text: 'C', is_correct: true },
    ]
    const { result } = renderHook(() => useCardOptions(CARD_ID, opts))
    expect(result.current.correctIds).toEqual(['a', 'c'])
  })
})

describe('useCardOptions — commit が runOptimisticUpdate を呼ぶ', () => {
  it('handleCheckboxToggle → runOptimisticUpdate が呼ばれ entity_type / entity_id / field が正しい', async () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      result.current.handleCheckboxToggle(0, true)
    })
    await vi.waitFor(() => {
      expect(mockRunOptimistic).toHaveBeenCalledTimes(1)
    })
    const call = (mockRunOptimistic.mock.calls[0] as unknown as [{ mutation: { entity_type: string; entity_id: string; op: string; patch: { field: string } } }])[0]
    expect(call.mutation.entity_type).toBe('card')
    expect(call.mutation.entity_id).toBe(CARD_ID)
    expect(call.mutation.op).toBe('update_field')
    expect(call.mutation.patch.field).toBe('options')
  })

  it('handleCheckboxToggle → immediateDrain で runGuardedEntityMutationFlush が呼ばれる', async () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      result.current.handleCheckboxToggle(0, true)
    })
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalledTimes(1)
    })
  })

  it('handleCellSave で値変更あり → runOptimisticUpdate が呼ばれる', async () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      result.current.handleCellSave(0, { id: 'a', text: '更新A', is_correct: false })
    })
    await vi.waitFor(() => {
      expect(mockRunOptimistic).toHaveBeenCalledTimes(1)
    })
  })

  it('handleCellSave で値変更なし → runOptimisticUpdate は呼ばれない (no-op guard)', async () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      // baseOptions[0] と同値を渡す → shallowEqualOptions → no-op
      result.current.handleCellSave(0, { id: 'a', text: '選択肢A', is_correct: false })
    })
    // microtask drain して副作用がないことを確認
    await new Promise((r) => setTimeout(r, 50))
    expect(mockRunOptimistic).not.toHaveBeenCalled()
  })

  it('handleDeleteOption → runOptimisticUpdate が呼ばれる (即時 drain)', async () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      result.current.handleDeleteOption(1)
    })
    await vi.waitFor(() => {
      expect(mockRunOptimistic).toHaveBeenCalledTimes(1)
    })
  })

  it('handleAddOption → commit は呼ばれない (ghost は sanitize 対象)', async () => {
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    act(() => {
      result.current.handleAddOption()
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(mockRunOptimistic).not.toHaveBeenCalled()
  })
})

// Sprint F W2 Critical 回帰: handleCellUnmountSave は optionsRef を同期しないと、後続の
// 別 handler が stale ref から payload を組んで unmount-saved edit を上書きする(canonical/
// Codex 指摘)。fix (optionsRef.current = nextAll) を pin する。
describe('useCardOptions — handleCellUnmountSave (Sprint F W2)', () => {
  it('unmount-save 後の別 option 操作が unmount-saved edit を上書きしない (optionsRef 同期)', async () => {
    // 存在 gate(cards.get)が実在を確認できるよう card を seed(row の存在のみが要件)。
    await getClientDb().cards.clear()
    await getClientDb().cards.put({
      id: CARD_ID,
      user_id: 'user-1',
      exam_id: 'exam-1',
      options: baseOptions,
    } as never)
    const { result } = renderHook(() => useCardOptions(CARD_ID, baseOptions))
    // option 0 を unmount-save 経由で編集(存在 gate + commit は fire-and-forget)。
    await act(async () => {
      result.current.handleCellUnmountSave(0, {
        id: 'a',
        text: '選択肢A 編集済み',
        is_correct: false,
      })
      await new Promise((r) => setTimeout(r, 50))
    })
    await vi.waitFor(() => {
      expect(mockRunOptimistic).toHaveBeenCalledTimes(1)
    })
    // 別 option(index 1)を toggle → 2 回目 commit(working-set から payload を構築)。
    act(() => {
      result.current.handleCheckboxToggle(1, true)
    })
    await vi.waitFor(() => {
      expect(mockRunOptimistic).toHaveBeenCalledTimes(2)
    })
    // 2 回目 payload の option 0 は unmount-saved edit を保持(revert していない)。
    const secondCall = (
      mockRunOptimistic.mock.calls[1] as unknown as [
        { afterPatch: { options: CardOption[] } },
      ]
    )[0]
    expect(secondCall.afterPatch.options[0]!.text).toBe('選択肢A 編集済み')
  })
})
