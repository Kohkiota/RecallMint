// @vitest-environment jsdom
// DashboardActions client component tests.
// T6: 左 button href → /app/study/smart/session、右 button → disabled「カスタム演習（準備中）」

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
  }: {
    href: string
    children: React.ReactNode
    onClick?: (e: React.MouseEvent) => void
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}))

vi.mock('@/app/(app)/app/_actions/revalidate', () => ({
  revalidateAppPath: vi.fn(),
}))

import { DashboardActions } from './dashboard-actions'
import { revalidateAppPath } from '@/app/(app)/app/_actions/revalidate'

const mockRevalidate = revalidateAppPath as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('DashboardActions', () => {
  it('dueCount > 0: スマート復習 link が href=/app/study/smart/session で表示', () => {
    render(<DashboardActions dueCount={3} />)
    const btn = screen.getByRole('link', { name: /スマート復習/ })
    expect(btn).toHaveAttribute('href', '/app/study/smart/session')
    expect(btn).toHaveTextContent('スマート復習（3件）')
  })

  it('dueCount > 0: スマート復習 click → revalidateAppPath(/app/study/smart/session) 1 回 call', () => {
    render(<DashboardActions dueCount={3} />)
    fireEvent.click(screen.getByRole('link', { name: /スマート復習/ }))
    expect(mockRevalidate).toHaveBeenCalledTimes(1)
    expect(mockRevalidate).toHaveBeenCalledWith('/app/study/smart/session')
  })

  it('dueCount === 0: 「復習完了！」 表示、スマート復習 link 不在', () => {
    render(<DashboardActions dueCount={0} />)
    expect(screen.getByText('復習完了！')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /スマート復習/ })).not.toBeInTheDocument()
  })

  it('右 button は「カスタム演習（準備中）」label で disabled (dueCount > 0)', () => {
    render(<DashboardActions dueCount={3} />)
    const btn = screen.getByRole('button', { name: 'カスタム演習（準備中）' })
    expect(btn).toBeDisabled()
  })

  it('右 button は「カスタム演習（準備中）」label で disabled (dueCount === 0)', () => {
    render(<DashboardActions dueCount={0} />)
    const btn = screen.getByRole('button', { name: 'カスタム演習（準備中）' })
    expect(btn).toBeDisabled()
  })

  it('旧「問題演習」link は存在しない (T6 で disabled button に置換済)', () => {
    render(<DashboardActions dueCount={0} />)
    expect(screen.queryByRole('link', { name: '問題演習' })).not.toBeInTheDocument()
  })
})
