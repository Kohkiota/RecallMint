// @vitest-environment jsdom
// SettingsPage (server component) のプラン section render test。
//
// 観点 (Task 8 §7.3 + §7.4 拡張):
// - 全 plan で「プラン変更」(/app/upgrade) CTA を常時表示 (free 限定の
//   「プランを選択」 文言は廃止、 dashboard /app と同じ entry CTA 統一)
// - paid: 「プラン変更」 + 「お支払い・解約を管理」(Portal) の 2 ボタン
//   (Pro 年額の除外撤廃 → Pro 年額でも両方表示)
// - free: 「プラン変更」 のみ (Portal ボタンなし。 free は Stripe customer
//   不在で Portal session 作成が失敗しうる経路のため)
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
  scheduledDowngradeScheduleId: null as string | null,
  scheduledTargetPriceId: null as string | null,
  scheduledChangeEffectiveAt: null as Date | null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('SettingsPage プラン section: entry 出し分け', () => {
  it('free: 「プラン変更」 を /app/upgrade に表示 (Portal ボタンは出さない)', async () => {
    mockGetCurrentUser.mockResolvedValue(baseUser)
    render(await SettingsPage())

    // §7.4 拡張: 全 plan で「プラン変更」 CTA を表示する。 旧 free 限定文言
    // 「プランを選択」 は廃止。
    expect(screen.getByRole('link', { name: 'プラン変更' })).toHaveAttribute(
      'href',
      '/app/upgrade',
    )
    expect(
      screen.queryByRole('link', { name: 'プランを選択' }),
    ).not.toBeInTheDocument()
    // Portal は paid 限定。 free では Stripe customer 不在のため出さない。
    expect(
      screen.queryByRole('button', { name: 'お支払い・解約を管理' }),
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

describe('SettingsPage プラン section: 予約状態の表示', () => {
  it('paid + cancelAt: 「解約予約中、 YYYY/MM/DD 終了」 を表示', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      cancelAt: new Date('2026-07-31T00:00:00.000Z'),
    })
    render(await SettingsPage())

    expect(screen.getByText(/解約予約中/)).toBeInTheDocument()
    expect(screen.getByText(/2026\/07\/31/)).toBeInTheDocument()
    // ダウングレード予約系の文言は出ない
    expect(screen.queryByText(/変更予約中/)).not.toBeInTheDocument()
    // ステータスは予約表示に置き換えられる (= 「ステータス: active」 は出さない)
    expect(screen.queryByText(/ステータス:/)).not.toBeInTheDocument()
  })

  it('paid + scheduledDowngradeScheduleId (cancelAt なし): 「YYYY/MM/DD に Standard 月額 へ変更予約中」 を表示', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      scheduledDowngradeScheduleId: 'sched_x',
      // vitest.setup.ts で fake env 設定済 (price_fake_standard_monthly)
      scheduledTargetPriceId: 'price_fake_standard_monthly',
      scheduledChangeEffectiveAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    render(await SettingsPage())

    expect(screen.getByText(/2026\/07\/01 に Standard 月額 へ変更予約中/)).toBeInTheDocument()
    // 解約予約系の文言は出ない
    expect(screen.queryByText(/解約予約中/)).not.toBeInTheDocument()
    expect(screen.queryByText(/ステータス:/)).not.toBeInTheDocument()
  })

  it('paid + cancelAt + scheduledDowngradeScheduleId 両方 set: cancelAt 優先 (解約予約中のみ表示)', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      cancelAt: new Date('2026-08-31T00:00:00.000Z'),
      scheduledDowngradeScheduleId: 'sched_x',
      scheduledTargetPriceId: 'price_fake_standard_monthly',
      scheduledChangeEffectiveAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    render(await SettingsPage())

    // cancelAt 優先で解約予約中のみ表示、 ダウングレード予約は出さない (defensive)。
    expect(screen.getByText(/解約予約中/)).toBeInTheDocument()
    expect(screen.getByText(/2026\/08\/31/)).toBeInTheDocument()
    expect(screen.queryByText(/変更予約中/)).not.toBeInTheDocument()
    expect(screen.queryByText(/2026\/07\/01/)).not.toBeInTheDocument()
  })

  it('paid + scheduledDowngradeScheduleId + 不明 priceId: 「YYYY/MM/DD に 変更先プラン へ変更予約中」 にフォールバック', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      scheduledDowngradeScheduleId: 'sched_x',
      scheduledTargetPriceId: 'price_unknown_does_not_resolve',
      scheduledChangeEffectiveAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    render(await SettingsPage())

    // resolveFromPriceId が null → 短縮ラベル不在 → "変更先プラン" にフォールバック
    expect(screen.getByText(/2026\/07\/01 に 変更先プラン へ変更予約中/)).toBeInTheDocument()
  })

  it('paid + scheduledDowngradeScheduleId + effectiveAt なし: 「Standard 月額 へ変更予約中」 (日付なし)', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      scheduledDowngradeScheduleId: 'sched_x',
      scheduledTargetPriceId: 'price_fake_standard_monthly',
      scheduledChangeEffectiveAt: null,
    })
    render(await SettingsPage())

    // 日付不在 → date prefix なし、 ラベルのみ
    expect(screen.getByText('Standard 月額 へ変更予約中')).toBeInTheDocument()
  })
})

describe('SettingsPage プラン section: MF-4 Portal ボタン非活性化', () => {
  it('ダウングレード予約中: Portal ボタンが disabled + 取消誘導メッセージ表示', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      scheduledDowngradeScheduleId: 'sched_x',
      scheduledTargetPriceId: 'price_fake_standard_monthly',
      scheduledChangeEffectiveAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    render(await SettingsPage())

    expect(
      screen.getByRole('button', { name: 'お支払い・解約を管理' }),
    ).toBeDisabled()
    expect(
      screen.getByText(/ダウングレード予約中は支払い管理を開けません/),
    ).toBeInTheDocument()
    expect(screen.getByText(/先に「プラン変更」 から/)).toBeInTheDocument()
    // 「プラン変更」 ボタン (取消導線) は引き続き活性
    expect(screen.getByRole('link', { name: 'プラン変更' })).toHaveAttribute(
      'href',
      '/app/upgrade',
    )
  })

  it('paid + cancelAt のみ: Portal ボタンは活性 (解約予約取消は Portal で行うため)', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      cancelAt: new Date('2026-07-31T00:00:00.000Z'),
    })
    render(await SettingsPage())

    expect(
      screen.getByRole('button', { name: 'お支払い・解約を管理' }),
    ).not.toBeDisabled()
    expect(
      screen.queryByText(/ダウングレード予約中は支払い管理を開けません/),
    ).not.toBeInTheDocument()
  })

  it('paid + cancelAt + scheduledDowngradeScheduleId 両方 set: cancelAt 優先で Portal は活性', async () => {
    // 「両方 set」 時は cancelAt 優先 = 解約が最終決定とみなす既存方針に揃え、
    // Portal は活性のままにして解約予約取消の導線を残す (誤誘導防止)。
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      cancelAt: new Date('2026-08-31T00:00:00.000Z'),
      scheduledDowngradeScheduleId: 'sched_x',
      scheduledTargetPriceId: 'price_fake_standard_monthly',
      scheduledChangeEffectiveAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    render(await SettingsPage())

    expect(
      screen.getByRole('button', { name: 'お支払い・解約を管理' }),
    ).not.toBeDisabled()
    expect(
      screen.queryByText(/ダウングレード予約中は支払い管理を開けません/),
    ).not.toBeInTheDocument()
  })

  it('paid + 予約なし: Portal ボタンは活性 (回帰確認)', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'month',
      subscriptionStatus: 'active',
    })
    render(await SettingsPage())

    expect(
      screen.getByRole('button', { name: 'お支払い・解約を管理' }),
    ).not.toBeDisabled()
    expect(
      screen.queryByText(/ダウングレード予約中は支払い管理を開けません/),
    ).not.toBeInTheDocument()
  })
})
