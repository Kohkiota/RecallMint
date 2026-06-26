// @vitest-environment jsdom
// CompactOptionsCell (Edit-2 T2) の基本動作 test。
// table cell 用 compact editable 選択肢 component。
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。
// runOptimisticUpdate / getClientDb は fake-indexeddb の実 Dexie で動かす。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { ClientCardOption } from '@/lib/client-db'
import { getClientDb } from '@/lib/client-db'

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

import { CompactOptionsCell } from './exam-card-table-options-edit-cell'

const CARD_ID = '44444444-4444-4444-8444-444444444444'

const baseOptions: ClientCardOption[] = [
  { id: 'a', text: '選択肢A', is_correct: true, explanation: 'A 理由' },
  { id: 'b', text: '選択肢B', is_correct: false },
]

async function seedCard(options: ClientCardOption[]) {
  await getClientDb().cards.put({
    id: CARD_ID,
    user_id: 'user-1',
    exam_id: 'exam-1',
    title: '',
    sort_key: null,
    question_text: '',
    options,
    correct_answer_ids: options.filter((o) => o.is_correct).map((o) => o.id),
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    current_streak: 0,
    due: '2026-01-01T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    content_version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    sync_status: 'synced',
  } as never)
}

beforeEach(async () => {
  // commit が void runOptimisticUpdate (fire-and-forget) なので、前 test の
  // transaction が settle 前に次 test が始まると mockEnqueue に stale call が bleed する。
  // useRealTimers → cards.clear() を mock 操作の前に置いて前 test を drain する。
  vi.useRealTimers()
  await getClientDb().cards.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — 表示', () => {
  it('N 個の選択肢が縦積みで全て描画される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    // 各選択肢の本文が display cell (role=button) として出る
    expect(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' }).length,
    ).toBe(2)
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.getByText('選択肢B')).toBeInTheDocument()
  })

  it('空 options 配列 → クラッシュしない', () => {
    // no throw
    expect(() =>
      render(<CompactOptionsCell cardId={CARD_ID} options={[]} />),
    ).not.toThrow()
    // 「+ 選択肢を追加」 は出る
    expect(
      screen.getByRole('button', { name: '+ 選択肢を追加' }),
    ).toBeInTheDocument()
  })

  it('explanation あり → 解説テキストが表示される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} />)
    expect(screen.getByText('A 理由', { exact: false })).toBeInTheDocument()
  })

  it('explanation 未設定 → placeholder が表示される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[1]!]} />)
    expect(screen.getByText('解説 (クリックで追加)')).toBeInTheDocument()
  })

  it('「+ 選択肢を追加」 button が描画される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    expect(
      screen.getByRole('button', { name: '+ 選択肢を追加' }),
    ).toBeInTheDocument()
  })

  it('削除 button が各 option に描画される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    expect(
      screen.getAllByRole('button', { name: '選択肢を削除' }).length,
    ).toBe(2)
  })

  it('options.length === 1 → 削除 button が disabled', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} />)
    expect(
      screen.getByRole('button', { name: '選択肢を削除' }),
    ).toBeDisabled()
  })

  it('is_correct=true の checkbox が checked', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} />)
    expect(
      (screen.getByRole('checkbox') as HTMLInputElement).checked,
    ).toBe(true)
  })

  it('is_correct=false の checkbox が unchecked', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[1]!]} />)
    expect(
      (screen.getByRole('checkbox') as HTMLInputElement).checked,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// checkbox toggle
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — checkbox toggle', () => {
  it('checkbox toggle → enqueue (即時 drain)', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!) // option b を ON
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: true },
          ],
        },
      })
    })
  })

  it('checkbox toggle → flush が即時叩かれる', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getAllByRole('checkbox')[0]!) // option a を OFF
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// text click-to-edit
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — text click-to-edit', () => {
  it('text cell click → edit mode (textarea 表示)', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} />)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    expect(
      screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
    ).toBeInTheDocument()
  })

  it('text 編集 + blur → mirror cards.update に options が書かれる', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!,
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      { target: { value: '選択肢A 改' } },
    )
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.options).toEqual([
        { id: 'a', text: '選択肢A 改', is_correct: true, explanation: 'A 理由' },
        { id: 'b', text: '選択肢B', is_correct: false },
      ])
    })
  })

  it('値変更なし + blur → enqueue されない', async () => {
    await seedCard([baseOptions[0]!])
    render(
      <CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('textbox', { name: '選択肢 本文 編集' }),
      ).not.toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// explanation click-to-edit (incl. drop-on-empty)
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — explanation click-to-edit', () => {
  it('explanation cell click → edit mode (textarea 表示)', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[1]!]} />)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 解説 編集' }))
    expect(
      screen.getByRole('textbox', { name: '選択肢 解説 編集' }),
    ).toBeInTheDocument()
  })

  it('explanation 編集 + blur → enqueue に explanation 含む', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 解説 編集' })[1]!, // option b
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: '選択肢 解説 編集' }),
      { target: { value: 'B 理由' } },
    )
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 解説 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            {
              id: 'a',
              text: '選択肢A',
              isCorrect: true,
              explanation: 'A 理由',
            },
            { id: 'b', text: '選択肢B', isCorrect: false, explanation: 'B 理由' },
          ],
        },
      })
    })
  })

  it('explanation を空文字に → enqueue payload から explanation key が drop される', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 解説 編集' })[0]!, // option a (has explanation)
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: '選択肢 解説 編集' }),
      { target: { value: '' } },
    )
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 解説 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true }, // explanation key dropped
            { id: 'b', text: '選択肢B', isCorrect: false },
          ],
        },
      })
    })
  })
})

// ---------------------------------------------------------------------------
// add / delete
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — add / delete', () => {
  it('「+ 追加」 click → 新 option が optimistic に末尾追加される (削除ボタン数で確認)', async () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    expect(
      screen.getAllByRole('button', { name: '選択肢を削除' }).length,
    ).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      // 新 option は autoEditOnMount=true で即 edit mode になるため、
      // text cell は textbox として出る。削除ボタン数で行追加を確認する。
      expect(
        screen.getAllByRole('button', { name: '選択肢を削除' }).length,
      ).toBe(3)
    })
  })

  it('「+ 追加」 click → 新 option の text cell が即 edit mode になる', async () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      ).toBeInTheDocument()
    })
  })

  it('削除 click → 該当 option が optimistic に消え enqueue', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} />)
    expect(screen.getByText('選択肢B')).toBeInTheDocument()
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢を削除' })[1]!, // option b
    )
    await vi.waitFor(() => {
      expect(screen.queryByText('選択肢B')).not.toBeInTheDocument()
    })
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
          ],
        },
      })
    })
  })

  it('options.length === 1 → 削除 button が disabled (canDelete=false)', () => {
    render(
      <CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} />,
    )
    expect(
      screen.getByRole('button', { name: '選択肢を削除' }),
    ).toBeDisabled()
  })
})
