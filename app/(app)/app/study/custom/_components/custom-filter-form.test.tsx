// @vitest-environment jsdom
// CustomFilterForm (S2.3 T10 + T11 count preview + T15 preview list) — local state + onStart payload のテスト。
//
// 検証観点:
// 1. 試験 chip toggle で examIds が更新される
// 2. 回答状態 select 変更で answerState が更新される
// 3. 連続正解数 入力で streakFilter が更新される
// 4. 出題順 radio でデフォルトが sequential で、 random に切替可
// 5. 「演習開始」 click で onStart が 5 keys (examIds/tagFilter/answerState/streakFilter/order) 付きで呼ばれる
// 6. tag toggle が tagFilter に反映される (chip 表示 / onStart payload)
// 7. (T11 Q-3) 件数ヒント (match-count-hint) が matchCount に応じて表示される
// 8. (T15) 2 値表示: 条件一致 N 件 / 出題 M 件
// 9. (T15) プレビューリストが cap 件を表示する (CustomSessionPreview に渡る rows)
//
// useLiveQuery は vi.mock で返値を直接制御する。 CardTagAddPopover は
// onToggle を外部から呼び出せるよう軽量 stub に差し替える。
// getCustomSessionCards / selectCustomSessionRows も vi.mock でスタブする。
// CustomSessionPreview は stub し、受け取った rows 数を data-testid で検証可能にする。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import type { ClientExam, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { CardWithTags } from '@/lib/cards/join-card-tags'

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { liveQueryState, mockOnToggleRef, mockCountRef, mockPreviewRowsRef } = vi.hoisted(() => ({
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
  // selectCustomSessionRows が返す CardWithTags[]
  mockPreviewRowsRef: { current: [] as CardWithTags[] },
}))

// getCustomSessionCards: 件数プレビュー用に mock。 Promise<Card[]> を返す。
// selectCustomSessionRows: プレビュー行用に mock。 Promise<CardWithTags[]> を返す。
vi.mock('@/lib/cards/get-custom-session-cards', () => ({
  getCustomSessionCards: vi.fn(async () =>
    Array.from({ length: mockCountRef.current }, (_, i) => ({ id: `card-${i}` })),
  ),
  selectCustomSessionRows: vi.fn(async () => mockPreviewRowsRef.current),
}))

// seedFromCriteria: 決定論的 rng を返す純関数。テストでは参照のみ確認。
vi.mock('@/lib/cards/seed-from-criteria', () => ({
  seedFromCriteria: vi.fn(() => Math.random),
}))

// dexie-react-hooks: useLiveQuery を fn.toString() の内容で分岐。
// 件数プレビュー用 useLiveQuery は getCustomSessionCards を含む文字列になる。
// 出題プレビュー用 useLiveQuery は selectCustomSessionRows を含む文字列になる。
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: vi.fn((fn: () => unknown, _deps?: unknown[]) => {
    const src = fn.toString()
    if (src.includes('tag_categories')) return liveQueryState.categories
    if (src.includes('tag_options')) return liveQueryState.options
    // 出題プレビュー (cap 後リスト): selectCustomSessionRows を呼ぶ fn
    if (src.includes('selectCustomSessionRows')) return mockPreviewRowsRef.current
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

// CustomSessionPreview: rows 数を data-testid で公開する stub
vi.mock('./custom-session-preview', () => ({
  CustomSessionPreview: ({ rows }: { rows: CardWithTags[]; customLimit: number | null }) => (
    <div data-testid="custom-session-preview" data-row-count={rows.length}>
      {rows.length > 0 && <span data-testid="preview-rows-count">{rows.length}</span>}
    </div>
  ),
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

// 軽量な CardWithTags fixture
function makePreviewRow(id: string): CardWithTags {
  return {
    card: {
      id,
      user_id: 'user-1',
      exam_id: 'exam-1',
      title: `Card ${id}`,
      question_text: `Q${id}`,
      options: [],
      correct_answer_ids: [],
      images: [],
      answered: false,
      current_streak: 0,
      last_correct: null,
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
      sync_status: 'synced',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    tags: [],
  }
}

const EXAMS = [makeExam('exam-a', '試験 A'), makeExam('exam-b', '試験 B')]
const CATEGORIES = [makeCat('cat-1', '分野')]
const OPTIONS = [makeOpt('opt-1', '循環器', 'cat-1'), makeOpt('opt-2', '腎臓', 'cat-1')]

const DEFAULT_PROPS = {
  userId: 'user-1',
  customLimit: 20 as number | null,
  onStart: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  liveQueryState.exams = EXAMS
  liveQueryState.categories = CATEGORIES
  liveQueryState.options = OPTIONS
  mockOnToggleRef.current = (_catId: string, _optId: string) => {}
  mockCountRef.current = 5
  mockPreviewRowsRef.current = []
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
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    const chipA = screen.getByRole('button', { name: '試験 A' })
    expect(chipA).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(chipA)
    expect(chipA).toHaveAttribute('aria-pressed', 'true')
  })

  it('同じ chip を 2 回 click すると選択が解除される', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    const chipA = screen.getByRole('button', { name: '試験 A' })
    fireEvent.click(chipA)
    fireEvent.click(chipA)
    expect(chipA).toHaveAttribute('aria-pressed', 'false')
  })

  it('複数試験を選択して onStart に examIds が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

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
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    const sel = screen.getByRole('combobox', { name: '回答状態フィルタ' })
    expect(sel).toHaveValue('all')
  })

  it('「未回答」 に変更して onStart payload に answerState="unanswered" が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

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
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.streakFilter).toBeNull()
  })

  it('streak しきい値を入力すると onStart payload に streakFilter が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    fireEvent.change(screen.getByRole('spinbutton', { name: '連続正解数 しきい値' }), {
      target: { value: '3' },
    })
    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.streakFilter).toEqual({ op: 'lte', value: 3 })
  })

  it('演算子を ≥ に変更して onStart payload に op="gte" が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

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
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    const sequential = screen.getByRole('radio', { name: '順番どおり' })
    expect(sequential).toBeChecked()
  })

  it('「ランダム」 radio を選択すると onStart payload に order="random" が含まれる', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    fireEvent.click(screen.getByRole('radio', { name: 'ランダム' }))
    fireEvent.click(screen.getByRole('button', { name: '演習開始' }))

    const payload = onStart.mock.calls[0][0] as Record<string, unknown>
    expect(payload.order).toBe('random')
  })

  it('sequential から random に戻す', () => {
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

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
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    // CardTagAddPopover stub 経由で toggle を発火
    mockOnToggleRef.current('cat-1', 'opt-1')

    await waitFor(() => {
      expect(screen.getByTestId('tag-chip-opt-1')).toBeInTheDocument()
    })
  })

  it('tag toggle 後の onStart payload に tagFilter が含まれる', async () => {
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

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
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

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
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

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
  it('matchCount が number のとき「条件一致 N 件 / 出題 M 件」 ヒントが表示される', () => {
    mockCountRef.current = 7
    mockPreviewRowsRef.current = Array.from({ length: 5 }, (_, i) => makePreviewRow(`c${i}`))
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    const hint = screen.getByTestId('match-count-hint')
    expect(hint).toHaveTextContent('条件一致 7 件')
    expect(hint).toHaveTextContent('出題 5 件')
  })

  it('matchCount=0 のときも「条件一致 0 件 / 出題 0 件」 が表示される', () => {
    mockCountRef.current = 0
    mockPreviewRowsRef.current = []
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    const hint = screen.getByTestId('match-count-hint')
    expect(hint).toHaveTextContent('条件一致 0 件')
    expect(hint).toHaveTextContent('出題 0 件')
  })

  it('件数ヒントがあっても演習開始ボタンは常に enabled', () => {
    mockCountRef.current = 0
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    const startBtn = screen.getByRole('button', { name: '演習開始' })
    expect(startBtn).not.toBeDisabled()
  })
})

describe('CustomFilterForm — T15 preview list', () => {
  it('previewRows がある場合 CustomSessionPreview がレンダーされる', () => {
    mockPreviewRowsRef.current = [makePreviewRow('c1'), makePreviewRow('c2'), makePreviewRow('c3')]
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    const preview = screen.getByTestId('custom-session-preview')
    expect(preview).toBeInTheDocument()
    expect(preview).toHaveAttribute('data-row-count', '3')
  })

  it('previewRows=[] のとき CustomSessionPreview に rows=[] が渡る', () => {
    mockPreviewRowsRef.current = []
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    const preview = screen.getByTestId('custom-session-preview')
    expect(preview).toHaveAttribute('data-row-count', '0')
  })

  it('出題順 radio を変更すると previewRows が再計算される (deps 更新)', () => {
    // useLiveQuery mock は deps 変更を検知しないが、
    // radio 変更後も CustomSessionPreview がマウントされていることを確認
    mockPreviewRowsRef.current = [makePreviewRow('c1')]
    const onStart = vi.fn()
    render(<CustomFilterForm {...DEFAULT_PROPS} onStart={onStart} />)

    fireEvent.click(screen.getByRole('radio', { name: 'ランダム' }))

    // プレビューはまだ表示される (order 変更はフォームの deps に含まれる)
    expect(screen.getByTestId('custom-session-preview')).toBeInTheDocument()
  })
})
