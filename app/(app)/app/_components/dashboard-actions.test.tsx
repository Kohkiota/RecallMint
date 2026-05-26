// @vitest-environment jsdom
// DashboardActions client component tests.
// S-local-5 UX refactor: 「スマート復習」 CTA を Link → button (overlay 起動) に
// 統合。 LocalSessionOverlay は mock し、 button click で表示される / 「保存済み
// カードで復習」 という別 CTA 文言が出ない / dueCount 表示 を verify。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const { mockLocalSessionOverlay } = vi.hoisted(() => ({
  mockLocalSessionOverlay: vi.fn(),
}))

vi.mock('./local-session-overlay', () => ({
  LocalSessionOverlay: (props: Record<string, unknown>) => {
    mockLocalSessionOverlay(props)
    return <div data-testid="local-session-overlay">overlay</div>
  },
}))

import { DashboardActions } from './dashboard-actions'

const BASE_PROPS = {
  userId: 'user-1',
  sessionLimit: 20,
  fsrsMode: false,
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('DashboardActions', () => {
  it('dueCount > 0: 「スマート復習（N件）」 button が表示 (Link でなく button、 S-local-5 UX refactor)', () => {
    render(<DashboardActions dueCount={3} {...BASE_PROPS} />)
    const btn = screen.getByRole('button', { name: /スマート復習/ })
    expect(btn).toHaveTextContent('スマート復習（3件）')
    // 旧仕様の Link (/app/study/smart) は dashboard 上からは消えた
    expect(
      screen.queryByRole('link', { name: /スマート復習/ }),
    ).not.toBeInTheDocument()
  })

  it('dueCount === 0: 「復習完了！」 表示、 スマート復習 button 不在', () => {
    render(<DashboardActions dueCount={0} {...BASE_PROPS} />)
    expect(screen.getByText('復習完了！')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /スマート復習/ }),
    ).not.toBeInTheDocument()
  })

  it('右 button は「カスタム演習（準備中）」 label で disabled (dueCount > 0)', () => {
    render(<DashboardActions dueCount={3} {...BASE_PROPS} />)
    const btn = screen.getByRole('button', { name: 'カスタム演習（準備中）' })
    expect(btn).toBeDisabled()
  })

  it('右 button は「カスタム演習（準備中）」 label で disabled (dueCount === 0)', () => {
    render(<DashboardActions dueCount={0} {...BASE_PROPS} />)
    const btn = screen.getByRole('button', { name: 'カスタム演習（準備中）' })
    expect(btn).toBeDisabled()
  })

  // ---------------------------------------------------------------------------
  // S-local-5 UX refactor: overlay 起動 / 「保存済みカードで復習」 文言不在 guard
  // ---------------------------------------------------------------------------

  it('S-local-5: 初期は overlay 不在', () => {
    render(<DashboardActions dueCount={3} {...BASE_PROPS} />)
    expect(screen.queryByTestId('local-session-overlay')).not.toBeInTheDocument()
  })

  it('S-local-5: スマート復習 button click → overlay 表示 + 各 prop 受け渡し', () => {
    render(
      <DashboardActions
        dueCount={3}
        userId="user-xyz"
        sessionLimit={42}
        fsrsMode={true}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /スマート復習/ }))
    expect(screen.getByTestId('local-session-overlay')).toBeInTheDocument()
    expect(mockLocalSessionOverlay).toHaveBeenCalledTimes(1)
    const props = mockLocalSessionOverlay.mock.calls[0][0] as {
      userId: string
      sessionLimit: number
      fsrsMode: boolean
      onCloseAction: () => void
    }
    expect(props.userId).toBe('user-xyz')
    expect(props.sessionLimit).toBe(42)
    expect(props.fsrsMode).toBe(true)
    expect(typeof props.onCloseAction).toBe('function')
  })

  it('S-local-5: overlay の onCloseAction 呼出 → overlay 消える', () => {
    render(<DashboardActions dueCount={3} {...BASE_PROPS} />)
    fireEvent.click(screen.getByRole('button', { name: /スマート復習/ }))
    const props = mockLocalSessionOverlay.mock.calls[0][0] as {
      onCloseAction: () => void
    }
    // mock から取り出した callback の直接呼出 → 親 state 変更 → act でラップ
    act(() => {
      props.onCloseAction()
    })
    expect(screen.queryByTestId('local-session-overlay')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /スマート復習/ }),
    ).toBeInTheDocument()
  })

  it('S-local-5 regression guard: 「保存済みカードで復習」 文言が dashboard 上に出ない (旧別 CTA は削除済)', () => {
    render(<DashboardActions dueCount={3} {...BASE_PROPS} />)
    expect(screen.queryByText(/保存済みカードで復習/)).not.toBeInTheDocument()
  })
})
