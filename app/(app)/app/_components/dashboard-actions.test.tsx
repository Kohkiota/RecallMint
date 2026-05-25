// @vitest-environment jsdom
// DashboardActions client component tests.
// T6 (S2.1): 左 button href → /app/study/smart、右 button → disabled「カスタム演習（準備中）」
// S2.2.1 T2: /app/study/smart/session 撤去で href / revalidate path を /app/study/smart に統合。
//
// S-perf-2 (C-1): スマート復習 CTA の onClick={() => void revalidateAppPath(...)} を撤去。
// 「click で revalidateAppPath が呼ばれる」 test は削除済 (旧仕様)。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

import { DashboardActions } from './dashboard-actions'

afterEach(() => {
  cleanup()
})

describe('DashboardActions', () => {
  it('dueCount > 0: スマート復習 link が href=/app/study/smart で表示', () => {
    render(<DashboardActions dueCount={3} />)
    const btn = screen.getByRole('link', { name: /スマート復習/ })
    expect(btn).toHaveAttribute('href', '/app/study/smart')
    expect(btn).toHaveTextContent('スマート復習（3件）')
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
