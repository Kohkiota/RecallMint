// @vitest-environment jsdom
// DashboardActions client component tests.
// next/link onClick + revalidateAppPath wiring を 2 button × due 状態でカバー。

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
  it('dueCount > 0: スマート復習 active 表示 + 件数表示', () => {
    render(<DashboardActions dueCount={3} />)
    const btn = screen.getByRole('link', { name: /スマート復習/ })
    // Sprint A-2: /app/review 撤去、 /app/quiz placeholder に暫定リンク
    expect(btn).toHaveAttribute('href', '/app/quiz')
    expect(btn).toHaveTextContent('スマート復習（3件）')
  })

  it('dueCount > 0: スマート復習 click → revalidateAppPath(/app/quiz) 1 回 call', () => {
    render(<DashboardActions dueCount={3} />)
    fireEvent.click(screen.getByRole('link', { name: /スマート復習/ }))
    expect(mockRevalidate).toHaveBeenCalledTimes(1)
    expect(mockRevalidate).toHaveBeenCalledWith('/app/quiz')
  })

  it('dueCount === 0: 「復習完了！」 disabled 表示、スマート復習 link 不在', () => {
    render(<DashboardActions dueCount={0} />)
    expect(screen.getByText('復習完了！')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /スマート復習/ })).not.toBeInTheDocument()
  })

  it('問題演習 link は dueCount に関係なく常時表示 + click → revalidateAppPath(/app/quiz)', () => {
    render(<DashboardActions dueCount={0} />)
    const btn = screen.getByRole('link', { name: '問題演習' })
    expect(btn).toHaveAttribute('href', '/app/quiz')
    fireEvent.click(btn)
    expect(mockRevalidate).toHaveBeenCalledTimes(1)
    expect(mockRevalidate).toHaveBeenCalledWith('/app/quiz')
  })
})
