// @vitest-environment jsdom
// SmartStudyEntryPage tests.
// I-1 regression guard: description text must not contain 'session_limit'
// I-2: revalidateAppPath called on button click

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

import SmartStudyEntryPage from './page'
import { revalidateAppPath } from '@/app/(app)/app/_actions/revalidate'

const mockRevalidate = revalidateAppPath as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('SmartStudyEntryPage', () => {
  it('タイトル・説明文・スタートリンクが正しく描画される', () => {
    render(<SmartStudyEntryPage />)
    expect(screen.getByRole('heading', { name: 'スマート復習' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'スマート復習を始める' })).toHaveAttribute(
      'href',
      '/app/study/smart/session',
    )
    expect(screen.getByText(/設定した上限枚数まで/)).toBeInTheDocument()
  })

  it('「スマート復習を始める」click で revalidateAppPath(/app/study/smart/session) が呼ばれる', () => {
    render(<SmartStudyEntryPage />)
    fireEvent.click(screen.getByRole('link', { name: 'スマート復習を始める' }))
    expect(mockRevalidate).toHaveBeenCalledTimes(1)
    expect(mockRevalidate).toHaveBeenCalledWith('/app/study/smart/session')
  })

  it('説明文に "session_limit" という文字列が含まれない (I-1 regression guard)', () => {
    render(<SmartStudyEntryPage />)
    const description = screen.getByText(/設定した上限枚数まで/)
    expect(description.textContent).not.toContain('session_limit')
  })
})
