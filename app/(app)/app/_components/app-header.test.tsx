// @vitest-environment jsdom
// AppHeader component rendering tests.
// Clerk SDK and Next.js Link are mocked so this runs in Node/jsdom without
// a full Next.js context.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@clerk/nextjs', () => ({
  UserButton: () => <div data-testid="user-button" />,
}))

// next/link renders an <a> tag; mock to keep it simple and avoid Next.js
// router context dependency in unit tests. onClick prop must be forwarded
// so the I-1.7 revalidateAppPath wiring can be asserted.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
    onClick,
  }: {
    href: string
    children: React.ReactNode
    className?: string
    onClick?: (e: React.MouseEvent) => void
  }) => (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  ),
}))

vi.mock('@/app/(app)/app/_actions/revalidate', () => ({
  revalidateAppPath: vi.fn(),
}))

import { AppHeader } from './app-header'
import { revalidateAppPath } from '@/app/(app)/app/_actions/revalidate'

const mockRevalidate = revalidateAppPath as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

// vitest.setup.ts runs vi.resetModules() in beforeEach which re-evaluates
// modules but does not clean up jsdom DOM between tests. Explicit cleanup
// ensures each test starts with a fresh document body.
afterEach(() => {
  cleanup()
})

describe('AppHeader', () => {
  it('renders brand link to /app', () => {
    render(<AppHeader />)
    const brand = screen.getByRole('link', { name: 'RecallMint' })
    expect(brand).toHaveAttribute('href', '/app')
  })

  it('renders 2 nav links with correct hrefs (演習 / 設定) — Sprint A-2 で vocab nav 撤去', () => {
    render(<AppHeader />)
    expect(screen.queryByRole('link', { name: '単語' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '復習' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '演習' })).toHaveAttribute('href', '/app/quiz')
    expect(screen.getByRole('link', { name: '設定' })).toHaveAttribute('href', '/app/settings')
  })

  it('renders UserButton', () => {
    render(<AppHeader />)
    expect(screen.getByTestId('user-button')).toBeInTheDocument()
  })

  // 残存 3 link すべてに onClick で revalidateAppPath が紐付き、
  // navigate 先 Router Cache を破棄する。click ごとに該当 path で 1 回 call。
  it.each([
    { name: 'RecallMint', path: '/app' as const },
    { name: '演習', path: '/app/quiz' as const },
    { name: '設定', path: '/app/settings' as const },
  ])('「$name」link click → revalidateAppPath($path) を 1 回 call', ({ name, path }) => {
    render(<AppHeader />)
    fireEvent.click(screen.getByRole('link', { name }))
    expect(mockRevalidate).toHaveBeenCalledTimes(1)
    expect(mockRevalidate).toHaveBeenCalledWith(path)
  })
})
