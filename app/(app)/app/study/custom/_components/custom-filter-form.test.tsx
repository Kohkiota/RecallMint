// @vitest-environment jsdom
// CustomFilterForm (S2.3 T10 + T11 count preview) — local state + onStart payload のテスト。
//
// 検証観点:
// 1. 試験 chip toggle で examIds が更新される
// 2. 回答状態 select 変更で answerState が更新される
// 3. 連続正解数 入力で streakFilter が更新される
// 4. 出題順 radio でデフォルトが sequential で、 random に切替可
// 5. 「演習開始」 click で onStart が 5 keys (examIds/tagFilter/answerState/streakFilter/order) 付きで呼ばれる
// 6. tag toggle が tagFilter に反映される (chip 表示 / onStart payload)
// 7. (T11 Q-3) 件数ヒント (match-count-hint) が matchCount に応じて表示される
//
// useLiveQuery は vi.mock で返値を直接制御する。 CardTagAddPopover は
// onToggle を外部から呼び出せるよう軽量 stub に差し替える。
// getCustomSessionCards (件数プレビュー用) も vi.mock でスタブする。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import type { ClientExam, ClientTagCategory, ClientTagOption } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { liveQueryState, mockOnToggleRef, mockCountRef } = vi.hoisted(() => ({
  // useLiveQuery の返値を制御するための shared state
  liveQueryState: {
    exams: [] as ClientExam[],
    categories: [] as ClientTagCategory[],
    options: [] as ClientTagOption[],
  },
  // CardTagAddPopover stub が外部に公開する onToggle ref
  mockOnToggleRef: { current: (_catId: string, _optId: string) => {} },
  // getCustomSessionCards が返す件数
  mockCountRef: { current: 5 },
}))

// getCustomSessionCards: 件数プレビュー用に mock。 Promise<Card[]> を返す。
vi.mock('@/lib/cards/get-custom-session-cards', () => ({
  getCustomSessionCards: vi.fn(async () =>
    Array.from({ length: mockCountRef.current }, (_, i) => ({ id: `card-${i}` })),
  ),
}))

// dexie-react-hooks: useLiveQuery を fn.toString() の内容で分岐。
// 件数プレビュー用 useLiveQuery は getCustomSessionCards を含む文字列になる。
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: vi.fn((fn: () => unknown, _deps?: unknown[]) => {
    const src = fn.toString()
    if (src.includes('tag_categories')) return liveQueryState.categories
    if (src.includes('tag_options')) return liveQueryState.options
    // 件数プレビュー: getCustomSessionCards を呼ぶ fn — 同期的に件数を返す
    if (src.includes('getCustomSessionCards')) return mockCountRef.current
    // exams は where('user_id') を含む
    return liveQueryState.exams
  }),
}))

// CardTagAddPopover: selectOnly 呼び出しのみ検証。 onToggle を stub 経由で呼び出し可能にする。
vi.mock(
  '@/app/(app)/app/exams/[id]/_components/card-tag-add-popover',
  () => ({
    CardTagAddPopover: ({
      onToggle,
      trigger,
    }: {
      onToggle: (catId: string, optId: string) => void
      trigger?: React.ReactNode
      selectOnly?: boolean
    }) => {
      // onToggle ref を更新して test から呼べるようにする
      mockOnToggleRef.current = onToggle
      return (
        <div data-testid="tag-popover">
          {trigger}
        </div>
      )
    },
  }),
)

// getClientDb は useLiveQuery の内部で使われるが、 mock 済なので呼ばれない。
// import エラー回避のため stub しておく。
vi.mock('@/lib/client-db', () => ({
  getClientDb: () => ({
    exams: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
    tag_categories: { toArray: async () => [] },
    tag_options: { toArray: async () => [] },
  }),
}))

import * as React from 'react'
import { CustomFilterForm } from './custom-filter-form'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeExam(id: string, name: string): ClientExam {
  return {
    id,
    user_id: 'user-1',
    name,
    archived_at: null,
    card_count: 0,
    content_version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function makeCat(id: string, name: string): ClientTagCategory {
  return {
    id,
    user_id: 'user-1',
    name,
    select_type: 'multi',
    color: null,
    sort_key: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function makeOpt(id: string, name: string, category_id: string): ClientTagOption {
  return {
    id,
    user_id: 'user-1',
    category_id,
    name,
    color: null,
    sort_key: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

const EXAMS = [makeExam('exam-a', '試験 A'), makeExam('exam-b', '試験 B')]
const CATEGORIES = [makeCat('cat-1', '分野')]
const OPTIONS = [makeOpt('opt-1', '循環器', 'cat-1'), makeOpt('opt-2', '腎臓', 'cat-1')]

beforeEach(() => {
  vi.clearAllMocks()
  liveQueryState.exams = EXAMS
  liveQueryState.categories = CATEGORIES
  liveQueryState.options = OPTIONS
  mockOnToggleRef.current = (_catId: string, _optId: string) => {}
  mockCountRef.current = 5
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CustomFilterForm — 試験 multiselect', () => {
  it('試験 chip を click すると aria-pressed が true になる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    const chipA = screen.getByRole('button', { name: '試験 A' })
    expect(chipA).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(chipA)
    expect(chipA).toHaveAttribute('aria-pressed', 'true')
  })

  it('同じ chip を 2 回 click すると選択が解除される', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    const chipA = screen.getByRole('button', { name: '試験 A' })
    fireEvent.click(chipA)
    fireEvent.click(chipA)
    expect(chipA).toHaveAttribute('aria-pressed', 'false')
  })

  it('複数試験を選択して onStart に examIds が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: '試験 A' }))
    fireEvent.click(screen.getByRole('button', { name: '試験 B' }))
    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    expect(onStart).toHaveBeenCalledOnce()
    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.examIds).toEqual(expect.arrayContaining(['exam-a', 'exam-b']))
  })
})

describe('CustomFilterForm — 回答状態', () => {
  it('初期値は「すべて」(all)', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    const sel = screen.getByRole('combobox', { name: '回答状態フィルタ' })
    expect(sel).toHaveValue('all')
  })

  it('「未回答」 に変更して onStart payload に answerState="unanswered" が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    fireEvent.change(screen.getByRole('combobox', { name: '回答状態フィルタ' }), {
      target: { value: 'unanswered' },
    })
    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.answerState).toBe('unanswered')
  })
})

describe('CustomFilterForm — 連続正解数', () => {
  it('streak 入力なし → onStart payload の streakFilter は null', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.streakFilter).toBeNull()
  })

  it('streak しきい値を入力すると onStart payload に streakFilter が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    fireEvent.change(screen.getByRole('spinbutton', { name: '連続正解数 しきい値' }), {
      target: { value: '3' },
    })
    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.streakFilter).toEqual({ op: 'lte', value: 3 })
  })

  it('演算子を ≥ に変更して onStart payload に op="gte" が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    fireEvent.change(screen.getByRole('combobox', { name: '連続正解数 演算子' }), {
      target: { value: 'gte' },
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: '連続正解数 しきい値' }), {
      target: { value: '5' },
    })
    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.streakFilter).toEqual({ op: 'gte', value: 5 })
  })
})

describe('CustomFilterForm — 出題順', () => {
  it('デフォルトの出題順は sequential (順番どおり)', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    const sequential = screen.getByRole('radio', { name: '順番どおり' })
    expect(sequential).toBeChecked()
  })

  it('「ランダム」 radio を選択すると onStart payload に order="random" が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    fireEvent.click(screen.getByRole('radio', { name: 'ランダム' }))
    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.order).toBe('random')
  })

  it('sequential から random に戻す', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    fireEvent.click(screen.getByRole('radio', { name: 'ランダム' }))
    fireEvent.click(screen.getByRole('radio', { name: '順番どおり' }))
    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.order).toBe('sequential')
  })
})

describe('CustomFilterForm — tag 選択', () => {
  it('tag toggle で tagFilter が更新され chip が表示される', async () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    // CardTagAddPopover stub 経由で toggle を発火
    mockOnToggleRef.current('cat-1', 'opt-1')

    await waitFor(() => {
      expect(screen.getByTestId('tag-chip-opt-1')).toBeInTheDocument()
    })
  })

  it('tag toggle 後の onStart payload に tagFilter が含まれる', async () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    mockOnToggleRef.current('cat-1', 'opt-1')

    await waitFor(() => {
      expect(screen.getByTestId('tag-chip-opt-1')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.tagFilter).toEqual({ 'cat-1': ['opt-1'] })
  })

  it('chip の × click で tag が解除される', async () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    mockOnToggleRef.current('cat-1', 'opt-1')

    await waitFor(() => {
      expect(screen.getByTestId('tag-chip-opt-1')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'タグ解除: 分野: 循環器' }))

    await waitFor(() => {
      expect(screen.queryByTestId('tag-chip-opt-1')).not.toBeInTheDocument()
    })
  })
})

describe('CustomFilterForm — onStart payload 全 5 keys', () => {
  it('全条件を設定して onStart payload に 5 keys が存在する', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: '試験 A' }))
    fireEvent.change(screen.getByRole('combobox', { name: '回答状態フィルタ' }), {
      target: { value: 'correct' },
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: '連続正解数 しきい値' }), {
      target: { value: '2' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'ランダム' }))
    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    expect(onStart).toHaveBeenCalledOnce()
    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toHaveProperty('examIds', ['exam-a'])
    expect(payload).toHaveProperty('tagFilter')
    expect(payload).toHaveProperty('answerState', 'correct')
    expect(payload).toHaveProperty('streakFilter', { op: 'lte', value: 2 })
    expect(payload).toHaveProperty('order', 'random')
  })
})

describe('CustomFilterForm — 件数ヒント (Q-3 count preview)', () => {
  it('matchCount が number のとき「N 件が条件に一致」 ヒントが表示される', () => {
    mockCountRef.current = 7
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    // useLiveQuery が 7 を返すので hint が表示される
    const hint = screen.getByTestId('match-count-hint')
    expect(hint).toHaveTextContent('7 件が条件に一致')
  })

  it('matchCount=0 のときも「0 件が条件に一致」 が表示される', () => {
    mockCountRef.current = 0
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    const hint = screen.getByTestId('match-count-hint')
    expect(hint).toHaveTextContent('0 件が条件に一致')
  })

  it('件数ヒントがあっても演習開始ボタンは常に enabled', () => {
    mockCountRef.current = 0
    const onStart = vi.fn()
    render(<CustomFilterForm userId="user-1" onStart={onStart} />)

    const startBtn = screen.getByRole('button', { name: '演習開始' })
    expect(startBtn).not.toBeDisabled()
  })
})
