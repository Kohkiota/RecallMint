// @vitest-environment jsdom
// `InlineOptionList` の Task 4.2 cutover 仕様を fake timer で検証:
// - text cell commit (mirror + enqueue) は blur で即時、 drain は 500ms debounce。
// - checkbox toggle / delete は即時 drain。
// - rapid consecutive cell edits は enqueue coalesce (card_id + 'options') で pending
//   1 行 (最新 value) に畳まれる。
// - dirty-guard: 編集中の cell は serverOptions prop 変化で clobber されない。
// - ghost-preserving merge: serverOptions prop 変化で local ghost が evict されない。
//
// enqueueEntityMutation は real 実装 (Dexie coalesce を verify)、
// runGuardedEntityMutationFlush のみ spy。 Dexie が internal scheduling に real microtask
// を使うため、 fake timer は setTimeout/clearTimeout のみに限定する。

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { CardOption } from '@/lib/db/schema'
import { getClientDb } from '@/lib/client-db'
import { getPendingEntityMutations } from '@/lib/sync/entity-mutations'

const { mockFlush } = vi.hoisted(() => ({
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { InlineOptionList } from './inline-option-row'

const CARD_ID = '44444444-4444-4444-8444-444444444444'

const baseOptions: CardOption[] = [
  { id: 'a', text: '選択肢A', is_correct: false, explanation: 'A 理由' },
  { id: 'b', text: '選択肢B', is_correct: false },
]

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

function renderList(all: CardOption[] = baseOptions) {
  return render(<InlineOptionList cardId={CARD_ID} options={all} />)
}

function startTextEdit(newValue: string, rowIdx = 0) {
  fireEvent.click(
    screen.getAllByRole('button', { name: '選択肢 本文 編集' })[rowIdx]!,
  )
  const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
  fireEvent.change(ta, { target: { value: newValue } })
  return ta
}

beforeEach(async () => {
  mockFlush.mockClear()
  await getClientDb().cards.clear()
  await getClientDb().entity_mutations.clear()
  // Dexie (fake-indexeddb) は real microtask を使うため、 debounce timer 制御に必要な
  // setTimeout/clearTimeout のみ fake にする。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('InlineOptionList commit / debounced drain', () => {
  it('text cell blur → 500ms 経過前は drain (flush) されない', async () => {
    renderList()
    const ta = startTextEdit('選択肢A 改')
    fireEvent.blur(ta)
    await flushPromises()

    await act(async () => {
      vi.advanceTimersByTime(499)
    })
    expect(mockFlush).not.toHaveBeenCalled()
  })

  it('text cell blur → enqueue は即時 (pending 1 行)、 drain は 500ms 後', async () => {
    renderList()
    const ta = startTextEdit('選択肢A 改')
    fireEvent.blur(ta)
    await flushPromises()

    // Optimistic UI: blur 直後 display 新値
    expect(
      screen.queryByRole('textbox', { name: '選択肢 本文 編集' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('選択肢A 改')).toBeInTheDocument()

    await vi.waitFor(async () => {
      const pending = await getPendingEntityMutations()
      expect(pending).toHaveLength(1)
      expect(pending[0]!.patch).toEqual({
        field: 'options',
        value: [
          { id: 'a', text: '選択肢A 改', isCorrect: false, explanation: 'A 理由' },
          { id: 'b', text: '選択肢B', isCorrect: false },
        ],
      })
    })
    expect(mockFlush).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    expect(mockFlush).toHaveBeenCalledTimes(1)
  })

  it('checkbox toggle → drain は即時 (debounce 待たず)', async () => {
    renderList()
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    await flushPromises()
    expect(mockFlush).toHaveBeenCalledTimes(1)
  })

  it('text 編集中に checkbox click → debounce timer cancel + checkbox 送信に text 新値同梱', async () => {
    renderList()
    // 1. text 編集 blur (debounce 中)
    const ta = startTextEdit('選択肢A 改')
    fireEvent.blur(ta)
    await flushPromises()
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    // 2. 同 row の checkbox click (= 即時 drain、 text 新値も pending に同梱)
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    await flushPromises()

    await vi.waitFor(async () => {
      const pending = await getPendingEntityMutations()
      expect(pending).toHaveLength(1)
      expect(pending[0]!.patch).toEqual({
        field: 'options',
        value: [
          { id: 'a', text: '選択肢A 改', isCorrect: true, explanation: 'A 理由' },
          { id: 'b', text: '選択肢B', isCorrect: false },
        ],
      })
    })

    // checkbox toggle で即時 drain 済 → 残り debounce 経過でも追加 drain なし
    const flushCount = mockFlush.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    expect(mockFlush.mock.calls.length).toBe(flushCount)
  })

  it('rapid consecutive cell edits は coalesce で pending 1 行 (最新 snapshot)', async () => {
    renderList()
    const settle = async (expectedText: string) => {
      await vi.waitFor(async () => {
        const pending = await getPendingEntityMutations()
        expect(pending).toHaveLength(1)
        const value = pending[0]!.patch.value as { text: string }[]
        expect(value[0]!.text).toBe(expectedText)
      })
    }
    fireEvent.blur(startTextEdit('一'))
    await settle('一')
    fireEvent.blur(startTextEdit('二'))
    await settle('二')
    fireEvent.blur(startTextEdit('三'))
    await settle('三')

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
  })
})

describe('InlineOptionList dirty-guard / merge reconciliation', () => {
  it('cell 編集中に serverOptions prop が変わっても in-progress editValue は clobber されない', () => {
    const { rerender } = renderList()
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!,
    )
    const ta = screen.getByRole('textbox', {
      name: '選択肢 本文 編集',
    }) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '途中' } })

    // 親 (mirror) から別値で prop 更新
    rerender(
      <InlineOptionList
        cardId={CARD_ID}
        options={[
          { id: 'a', text: 'server 更新', is_correct: false, explanation: 'A 理由' },
          { id: 'b', text: '選択肢B', is_correct: false },
        ]}
      />,
    )
    const ta2 = screen.getByRole('textbox', {
      name: '選択肢 本文 編集',
    }) as HTMLTextAreaElement
    expect(ta2.value).toBe('途中')
  })

  it('idle 時に serverOptions prop が変わると display 更新 (= rollback path)', async () => {
    const { rerender } = renderList()
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    rerender(
      <InlineOptionList
        cardId={CARD_ID}
        options={[
          { id: 'a', text: 'server 確定A', is_correct: false, explanation: 'A 理由' },
          { id: 'b', text: '選択肢B', is_correct: false },
        ]}
      />,
    )
    await flushPromises()
    expect(screen.getByText('server 確定A')).toBeInTheDocument()
    expect(screen.queryByText('選択肢A')).not.toBeInTheDocument()
  })

  it('ghost-preserving merge: serverOptions prop 変化で local ghost が evict されない', async () => {
    const { rerender } = renderList()
    // c-ghost 追加 (auto-edit)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await flushPromises()
    expect(screen.getByText('c')).toBeInTheDocument()
    expect(screen.getByText('選択肢 (3 件)')).toBeInTheDocument()

    // 親 revalidate を simulate (server 側は a, b のまま、 c は ghost で未送信)
    rerender(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    await flushPromises()

    // merge 戦略: c-ghost は保持される (server に id 'c' なし → ghost)
    expect(screen.getByText('選択肢 (3 件)')).toBeInTheDocument()
    expect(screen.getByText('c')).toBeInTheDocument()
  })
})
