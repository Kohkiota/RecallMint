// @vitest-environment jsdom
// SettingsPage (server component) のプラン section render test。
//
// 観点 (Task 8 §7.3):
// - paid: 「プラン変更」(/app/upgrade) + 「お支払い・解約を管理」(Portal) の 2 ボタン
//   (Pro 年額の除外撤廃 → Pro 年額でも両方表示)
// - free: 「プランを選択」維持 (Portal ボタンなし)
//
// getCurrentUser + db SELECT + 子 form / action を mock し await SettingsPage() で
// JSX を取得して render する。

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const { mockGetCurrentUser } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  }),
}))

// server action import (Portal form の action prop)。実行はしないので noop で十分。
vi.mock('./actions', () => ({
  createBillingPortalSession: vi.fn(),
}))

// 子 client component は本 test の関心外。
vi.mock('./delete-button', () => ({
  DeleteAccountButton: () => <div data-testid="delete-account" />,
}))
vi.mock('./_components/session-limit-form', () => ({
  SessionLimitForm: () => <div data-testid="session-limit-form" />,
}))
vi.mock('./_components/fsrs-mode-form', () => ({
  FsrsModeForm: () => <div data-testid="fsrs-mode-form" />,
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import SettingsPage from './page'

const baseUser = {
  id: 'u_1',
  plan: 'free' as const,
  billingInterval: null as 'month' | 'year' | null,
  cancelAt: null as Date | null,
  subscriptionStatus: null as string | null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('SettingsPage プラン section: entry 出し分け', () => {
  it('free: 「プランを選択」を表示し、Portal / プラン変更ボタンは出さない', async () => {
    mockGetCurrentUser.mockResolvedValue(baseUser)
    render(await SettingsPage())

    expect(screen.getByRole('link', { name: 'プランを選択' })).toHaveAttribute(
      'href',
      '/app/upgrade',
    )
    expect(
      screen.queryByRole('button', { name: 'お支払い・解約を管理' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'プラン変更' }),
    ).not.toBeInTheDocument()
  })

  it('paid (Pro 月): 「プラン変更」+「お支払い・解約を管理」の 2 ボタン', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
    })
    render(await SettingsPage())

    expect(screen.getByRole('link', { name: 'プラン変更' })).toHaveAttribute(
      'href',
      '/app/upgrade',
    )
    expect(
      screen.getByRole('button', { name: 'お支払い・解約を管理' }),
    ).toBeInTheDocument()
  })

  it('paid (Pro 年額): 除外撤廃 → 「プラン変更」を表示し旧「アップグレード」は出さない', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'year',
      subscriptionStatus: 'active',
    })
    render(await SettingsPage())

    expect(screen.getByRole('link', { name: 'プラン変更' })).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'アップグレード' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'お支払い・解約を管理' }),
    ).toBeInTheDocument()
  })
})
