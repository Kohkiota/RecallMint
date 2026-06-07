// @vitest-environment jsdom
// AppHeader component rendering tests.
// Clerk SDK and Next.js Link are mocked so this runs in Node/jsdom without
// a full Next.js context.
//
// S-perf-2 (C-1): nav Link の onClick={() => void revalidateAppPath(...)} を全撤去。
// 「click で revalidateAppPath が呼ばれる」 系 test は削除済 (旧仕様)。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@clerk/nextjs', () => ({
  UserButton: () => <div data-testid="user-button" />,
}))

// next/link renders an <a> tag; mock to keep it simple and avoid Next.js
// router context dependency in unit tests.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string
    children: React.ReactNode
    className?: string
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

import { AppHeader } from './app-header'

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

  it('renders nav links: アップロード / 試験 / スマート復習 / タグ / 設定 (演習 link は削除済)', () => {
    render(<AppHeader />)
    // 旧「演習」 (/app/quiz) は T6 で削除
    expect(screen.queryByRole('link', { name: '演習' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '単語' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '復習' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'アップロード' })).toHaveAttribute('href', '/app/upload')
    expect(screen.getByRole('link', { name: '試験' })).toHaveAttribute('href', '/app/exams')
    expect(screen.getByRole('link', { name: 'スマート復習' })).toHaveAttribute('href', '/app/study/smart')
    // Tag-4a: タグ管理 link (4 番目、 スマート復習 と 設定 の間)
    expect(screen.getByRole('link', { name: 'タグ' })).toHaveAttribute('href', '/app/tags')
    expect(screen.getByRole('link', { name: '設定' })).toHaveAttribute('href', '/app/settings')
  })

  it('nav link は brand 含め計 6 件 (RecallMint + アップロード / 試験 / スマート復習 / タグ / 設定)', () => {
    render(<AppHeader />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(6)
    const hrefs = links.map((l) => l.getAttribute('href'))
    expect(hrefs).toEqual([
      '/app',
      '/app/upload',
      '/app/exams',
      '/app/study/smart',
      '/app/tags',
      '/app/settings',
    ])
  })

  it('renders UserButton', () => {
    render(<AppHeader />)
    expect(screen.getByTestId('user-button')).toBeInTheDocument()
  })
})
