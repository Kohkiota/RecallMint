// @vitest-environment jsdom
// InlineTextField の Task 4.2 cutover 仕様を fake timer で検証する:
// - commit (mirror write + enqueue) は blur で即時、 drain (runGuardedEntityMutationFlush)
//   は 500ms debounce。
// - 連続編集は最後の commit から 500ms 後に drain 1 回 (timer reset)。
// - rapid consecutive edits は enqueue の coalesce (card_id + field) で pending 1 行
//   (最新 value) に畳まれる。
// - dirty-guard: 編集中の外部 prop 変化は in-progress value を clobber しない /
//   idle 時は prop 変化で display 更新 (= pull-reconciliation rollback path)。
//
// enqueue は実 Dexie (fake-indexeddb) に書く実装に通し、 pending 行を assert する。
// runGuardedEntityMutationFlush は spy mock で drain 呼出を verify。

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { getClientDb } from '@/lib/client-db'
import { getPendingEntityMutations } from '@/lib/sync/entity-mutations'

const { mockFlush } = vi.hoisted(() => ({
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

// enqueueEntityMutation は real 実装 (Dexie coalesce を verify するため)。
// runGuardedEntityMutationFlush のみ spy で差し替える。
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { InlineTextField } from './inline-text-field'

const CARD_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = 'user-1'

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

function renderField(initialValue: string | null = '旧') {
  return render(
    <InlineTextField
      cardId={CARD_ID}
      userId={USER_ID}
      field="title"
      initialValue={initialValue}
      ariaLabel="title 編集"
    />,
  )
}

function enterEditAndChange(newValue: string) {
  fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
  const input = screen.getByRole('textbox') as HTMLInputElement
  fireEvent.change(input, { target: { value: newValue } })
  return input
}

beforeEach(async () => {
  mockFlush.mockClear()
  await getClientDb().cards.clear()
  await getClientDb().entity_mutations.clear()
  // setTimeout/clearTimeout のみ fake にして debounce timer を制御する。
  // Dexie (fake-indexeddb) は内部スケジューリングに real microtask を使うため、
  // 全 timer を fake にすると await db.* がハングする。 必要最小限だけ fake にする。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('InlineTextField commit / debounced drain', () => {
  it('blur → 500ms 経過前は drain (flush) されない', async () => {
    renderField('旧')
    const input = enterEditAndChange('新')
    fireEvent.blur(input)
    await flushPromises()

    await act(async () => {
      vi.advanceTimersByTime(499)
    })
    expect(mockFlush).not.toHaveBeenCalled()
  })

  it('blur → enqueue は即時 (pending 1 行)、 drain は 500ms 後', async () => {
    renderField('旧')
    const input = enterEditAndChange('新')
    fireEvent.blur(input)
    await flushPromises()

    // enqueue は即時 → pending 行が既に存在
    const pending = await getPendingEntityMutations(USER_ID)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.patch).toEqual({ field: 'title', value: '新' })
    // drain はまだ
    expect(mockFlush).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    expect(mockFlush).toHaveBeenCalledTimes(1)
  })

  it('blur → 300ms → 再 blur → 合計 800ms で drain 1 回のみ (timer reset)', async () => {
    renderField('旧')
    const input = enterEditAndChange('途中')
    fireEvent.blur(input)
    await flushPromises()

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    const input2 = enterEditAndChange('最終')
    fireEvent.blur(input2)
    await flushPromises()

    // 2 回目 blur から 500ms で drain
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    expect(mockFlush).toHaveBeenCalledTimes(1)
  })

  it('rapid consecutive edits は coalesce で pending 1 行 (最新 value)', async () => {
    renderField('旧')
    // 編集 → blur を順に。 enqueue は async read-modify-write のため、 各 commit が
    // Dexie に settle するのを待ってから次の編集に進む (coalesce を順序通りに観測)。
    const settle = async (expected: string) => {
      await vi.waitFor(async () => {
        const pending = await getPendingEntityMutations(USER_ID)
        expect(pending).toHaveLength(1)
        expect(pending[0]!.patch).toEqual({ field: 'title', value: expected })
      })
    }
    fireEvent.blur(enterEditAndChange('A'))
    await settle('A')
    fireEvent.blur(enterEditAndChange('B'))
    await settle('B')
    fireEvent.blur(enterEditAndChange('C'))
    await settle('C')

    // 最終的に pending は 1 行 (coalesce)、 value は最新 'C'。
    const pending = await getPendingEntityMutations(USER_ID)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.patch).toEqual({ field: 'title', value: 'C' })
  })

  it('mirror write が即時に行われる (commit の楽観反映)', async () => {
    await getClientDb().cards.put({ id: CARD_ID, title: '旧' } as never)
    renderField('旧')
    fireEvent.blur(enterEditAndChange('新'))
    await flushPromises()
    const row = await getClientDb().cards.get(CARD_ID)
    expect(row?.title).toBe('新')
  })
})

describe('InlineTextField dirty-guard / reconciliation', () => {
  it('編集中に親から initialValue が変わっても in-progress value は clobber されない', () => {
    const { rerender } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '途中' } })

    rerender(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="親更新"
        ariaLabel="title 編集"
      />,
    )
    const input2 = screen.getByRole('textbox') as HTMLInputElement
    expect(input2.value).toBe('途中')
  })

  it('idle 時に親から initialValue が変わると display が更新される (= rollback path)', () => {
    const { rerender } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    expect(screen.getByText('旧')).toBeInTheDocument()

    // editing でない idle 状態で prop が server 確定値に変わる (pull-back reconcile)
    rerender(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="server 確定"
        ariaLabel="title 編集"
      />,
    )
    expect(screen.getByText('server 確定')).toBeInTheDocument()
    expect(screen.queryByText('旧')).not.toBeInTheDocument()
  })
})
