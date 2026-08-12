// @vitest-environment jsdom
// CustomSessionFlow (S2.3 T11 + T15) — state machine + SessionLauncher 統合テスト。
//
// 検証観点:
// 1. 初期表示: CustomFilterForm が render される
// 2. onStart(criteria) → getCustomSessionCards が {…criteria, userId, limit: customLimit} で呼ばれる
// 3. 解決済み cards → SessionLauncher が userId / heading="カスタム演習" で render される
// 4. 0 件 → SessionLauncher に渡った emptyState が render される (cards.length===0 path)
// 5. 「条件を変更」 click → フォームに戻る (filter フェーズに遷移)
// 6. getCustomSessionCards throw → empty 扱い (page crash しない)
// 7. (T15) handleStart が seedFromCriteria(criteria) を rng として getCustomSessionCards に渡す

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import * as React from 'react'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// getCustomSessionCards: テストごとに解決値を切り替えられる spy
const mockGetCustomSessionCards = vi.fn()
vi.mock('@/lib/cards/get-custom-session-cards', () => ({
  getCustomSessionCards: (...args: unknown[]) => mockGetCustomSessionCards(...args),
}))

// seedFromCriteria: 決定論的 rng を返す純関数。spy して呼び出し確認。
const mockSeedFromCriteria = vi.fn((_criteria: unknown): (() => number) => Math.random)
vi.mock('@/lib/cards/seed-from-criteria', () => ({
  seedFromCriteria: (criteria: unknown) => mockSeedFromCriteria(criteria),
}))

// CustomFilterForm: onStart を外から発火できる stub
const mockOnStartRef: { current: ((c: unknown) => void) | null } = { current: null }
// form に渡る customLimit を記録 (preview cap が flow→form へ正しく伝播することの検証用)
const mockCustomLimitRef: { current: number | null | undefined } = { current: undefined }
vi.mock('./custom-filter-form', () => ({
  CustomFilterForm: ({
    onStart,
    customLimit,
  }: {
    userId: string
    customLimit: number | null
    onStart: (c: unknown) => void
  }) => {
    // ref に最新の onStart / customLimit を保持
    mockOnStartRef.current = onStart
    mockCustomLimitRef.current = customLimit
    return <div data-testid="custom-filter-form">FilterForm</div>
  },
}))

// SessionLauncher: props を記録して emptyState を render できる stub
const lastLauncherProps: {
  cards?: unknown[]
  userId?: string
  heading?: string
  fsrsMode?: boolean
  emptyState?: React.ReactNode
} = {}
vi.mock('../../_components/session-launcher', () => ({
  SessionLauncher: (props: {
    cards: unknown[]
    userId: string
    heading: string
    fsrsMode: boolean
    emptyState: React.ReactNode
  }) => {
    // props を記録
    lastLauncherProps.cards = props.cards
    lastLauncherProps.userId = props.userId
    lastLauncherProps.heading = props.heading
    lastLauncherProps.fsrsMode = props.fsrsMode
    lastLauncherProps.emptyState = props.emptyState
    // cards が空の場合は emptyState を render (SessionLauncher の実装に準拠)
    if (props.cards.length === 0) {
      return <>{props.emptyState}</>
    }
    return <div data-testid="session-launcher">SessionLauncher (cards={props.cards.length})</div>
  },
}))

import { CustomSessionFlow } from './custom-session-flow'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRITERIA = {
  examIds: ['exam-1'],
  tagFilter: {},
  answerState: 'all' as const,
  streakFilter: null,
  order: 'sequential' as const,
}

const CARDS = [
  { id: 'card-1', question: 'Q1' },
  { id: 'card-2', question: 'Q2' },
]

const DEFAULT_PROPS = {
  userId: 'user-1',
  customLimit: 20,
  fsrsMode: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSeedFromCriteria.mockReturnValue(Math.random)
  mockOnStartRef.current = null
  Object.keys(lastLauncherProps).forEach((k) => {
    delete (lastLauncherProps as Record<string, unknown>)[k]
  })
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CustomSessionFlow — 初期表示', () => {
  it('初期フェーズは filter: CustomFilterForm が表示される', () => {
    mockGetCustomSessionCards.mockResolvedValue(CARDS)
    render(<CustomSessionFlow {...DEFAULT_PROPS} />)

    expect(screen.getByTestId('custom-filter-form')).toBeInTheDocument()
  })
})

describe('CustomSessionFlow — onStart → 選定 → SessionLauncher', () => {
  it('onStart(criteria) → getCustomSessionCards が {…criteria, userId, limit} で呼ばれる', async () => {
    mockGetCustomSessionCards.mockResolvedValue(CARDS)
    render(<CustomSessionFlow {...DEFAULT_PROPS} />)

    // CustomFilterForm stub 経由で onStart を発火
    await act(async () => {
      mockOnStartRef.current!(CRITERIA)
    })

    expect(mockGetCustomSessionCards).toHaveBeenCalledOnce()
    // 第 1 引数: criteria + userId + limit。 第 2 引数: seedFromCriteria 由来の rng 関数。
    expect(mockGetCustomSessionCards).toHaveBeenCalledWith(
      { ...CRITERIA, userId: 'user-1', limit: 20 },
      expect.any(Function),
    )
  })

  it('選定完了後、SessionLauncher が userId + heading="カスタム演習" で render される', async () => {
    mockGetCustomSessionCards.mockResolvedValue(CARDS)
    render(<CustomSessionFlow {...DEFAULT_PROPS} />)

    await act(async () => {
      mockOnStartRef.current!(CRITERIA)
    })

    await waitFor(() => {
      expect(screen.getByTestId('session-launcher')).toBeInTheDocument()
    })

    // userId は flush の owner-scope 供給 (spec §4.6)
    expect(lastLauncherProps.userId).toBe('user-1')
    expect(lastLauncherProps.heading).toBe('カスタム演習')
    expect(lastLauncherProps.cards).toHaveLength(CARDS.length)
  })

  it('fsrsMode が SessionLauncher に渡る', async () => {
    mockGetCustomSessionCards.mockResolvedValue(CARDS)
    render(<CustomSessionFlow {...DEFAULT_PROPS} fsrsMode={true} />)

    await act(async () => {
      mockOnStartRef.current!(CRITERIA)
    })

    await waitFor(() => {
      expect(screen.getByTestId('session-launcher')).toBeInTheDocument()
    })

    expect(lastLauncherProps.fsrsMode).toBe(true)
  })

  it('customLimit が null のとき getCustomSessionCards に limit:null が渡る', async () => {
    mockGetCustomSessionCards.mockResolvedValue(CARDS)
    render(<CustomSessionFlow {...DEFAULT_PROPS} customLimit={null} />)

    await act(async () => {
      mockOnStartRef.current!(CRITERIA)
    })

    expect(mockGetCustomSessionCards).toHaveBeenCalledWith(
      expect.objectContaining({ limit: null }),
      expect.any(Function),
    )
  })
})

describe('CustomSessionFlow — 0 件パス', () => {
  it('cards=[] → SessionLauncher の emptyState (条件に一致するカードがありません) が表示される', async () => {
    mockGetCustomSessionCards.mockResolvedValue([])
    render(<CustomSessionFlow {...DEFAULT_PROPS} />)

    await act(async () => {
      mockOnStartRef.current!(CRITERIA)
    })

    await waitFor(() => {
      expect(
        screen.getByText('条件に一致するカードがありません。'),
      ).toBeInTheDocument()
    })

    // SessionLauncher には cards=[] が渡る
    expect(lastLauncherProps.cards).toHaveLength(0)
  })

  it('「条件を変更」 click でフォームに戻る', async () => {
    mockGetCustomSessionCards.mockResolvedValue([])
    render(<CustomSessionFlow {...DEFAULT_PROPS} />)

    await act(async () => {
      mockOnStartRef.current!(CRITERIA)
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '条件を変更' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: '条件を変更' }))

    await waitFor(() => {
      expect(screen.getByTestId('custom-filter-form')).toBeInTheDocument()
    })
  })
})

describe('CustomSessionFlow — エラーパス', () => {
  it('getCustomSessionCards が throw → empty 扱い (emptyState が表示される)', async () => {
    mockGetCustomSessionCards.mockRejectedValue(new Error('Dexie failure'))
    render(<CustomSessionFlow {...DEFAULT_PROPS} />)

    await act(async () => {
      mockOnStartRef.current!(CRITERIA)
    })

    await waitFor(() => {
      expect(
        screen.getByText('条件に一致するカードがありません。'),
      ).toBeInTheDocument()
    })
  })
})

describe('CustomSessionFlow — T15 preview==session (seedFromCriteria 注入)', () => {
  it('handleStart が seedFromCriteria(criteria) を rng として getCustomSessionCards に渡す', async () => {
    // 決定論的な rng 関数を返す spy を設定
    const deterministicRng = () => 0.5
    mockSeedFromCriteria.mockReturnValue(deterministicRng)
    mockGetCustomSessionCards.mockResolvedValue(CARDS)

    render(<CustomSessionFlow {...DEFAULT_PROPS} />)

    await act(async () => {
      mockOnStartRef.current!(CRITERIA)
    })

    // seedFromCriteria が criteria で呼ばれていること
    expect(mockSeedFromCriteria).toHaveBeenCalledOnce()
    expect(mockSeedFromCriteria).toHaveBeenCalledWith(CRITERIA)

    // getCustomSessionCards の第 2 引数が seedFromCriteria の戻り値 (deterministicRng) であること
    expect(mockGetCustomSessionCards).toHaveBeenCalledOnce()
    const [, rngArg] = mockGetCustomSessionCards.mock.calls[0] as [unknown, () => number]
    expect(rngArg).toBe(deterministicRng)
  })

  it('customLimit が flow から form へ渡される', () => {
    mockGetCustomSessionCards.mockResolvedValue(CARDS)
    render(<CustomSessionFlow {...DEFAULT_PROPS} customLimit={50} />)

    // form が render され、 stub が捕捉した customLimit が 50 であること (実値の伝播を検証)
    expect(screen.getByTestId('custom-filter-form')).toBeInTheDocument()
    expect(mockCustomLimitRef.current).toBe(50)
  })
})
