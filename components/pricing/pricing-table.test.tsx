// @vitest-environment jsdom
// PricingTable client component: 認証 4 state × toggle 切替の CTA / 価格表示。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

import { PricingTable } from './pricing-table'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('PricingTable', () => {
  it('未認証: 3 カラム × 無料登録 CTA、 月額価格表示', () => {
    render(<PricingTable viewer={{ authenticated: false }} />)
    // Free / Standard / Pro 3 カラムのラベル
    expect(screen.getByText('Free')).toBeInTheDocument()
    expect(screen.getByText('Standard')).toBeInTheDocument()
    expect(screen.getByText('Pro')).toBeInTheDocument()
    // 月額 default: ¥680 / ¥1,280
    expect(screen.getByText('¥680')).toBeInTheDocument()
    expect(screen.getByText('¥1,280')).toBeInTheDocument()
    // 「無料登録」link が 3 つ (全カラム sign-up 誘導)
    const signupLinks = screen.getAllByRole('link', { name: '無料登録' })
    expect(signupLinks).toHaveLength(3)
    signupLinks.forEach((l) => expect(l).toHaveAttribute('href', '/sign-up'))
  })

  it('toggle: 月→年で価格表示が切替', () => {
    render(<PricingTable viewer={{ authenticated: false }} />)
    fireEvent.click(screen.getByRole('button', { name: /年額/ }))
    expect(screen.getByText('¥6,800')).toBeInTheDocument()
    expect(screen.getByText('¥12,800')).toBeInTheDocument()
    // 月あたり相当 (年額時のみ表示)
    expect(screen.getByText(/月あたり ¥566/)).toBeInTheDocument()
  })

  it('認証済 Free user: Free=「現在のプラン」disabled、 Standard/Pro=「アップグレード」', () => {
    render(<PricingTable viewer={{ authenticated: true, plan: 'free', billingInterval: null }} />)
    expect(screen.getAllByText('現在のプラン').length).toBeGreaterThanOrEqual(1)
    const upgradeLinks = screen.getAllByRole('link', { name: 'アップグレード' })
    expect(upgradeLinks).toHaveLength(2)
    upgradeLinks.forEach((l) => expect(l).toHaveAttribute('href', '/app/upgrade'))
  })

  it('認証済 Standard 月額: Standard月=current、 Pro=upgrade、 Free=下位', () => {
    render(<PricingTable viewer={{ authenticated: true, plan: 'standard', billingInterval: 'month' }} />)
    // Free カラム = 「現在より下位プラン」disabled
    expect(screen.getAllByText('現在より下位プラン').length).toBeGreaterThanOrEqual(1)
    // Standard 月額 default toggle で current
    expect(screen.getAllByText('現在のプラン').length).toBeGreaterThanOrEqual(1)
    // Pro upgrade
    expect(screen.getByRole('link', { name: 'アップグレード' })).toBeInTheDocument()
  })

  it('認証済 Pro 年額 (最上位): 年 toggle で Pro 年=current、 全 CTA disabled (upgrade link なし)', () => {
    render(<PricingTable viewer={{ authenticated: true, plan: 'pro', billingInterval: 'year' }} />)
    fireEvent.click(screen.getByRole('button', { name: /年額/ }))
    // upgrade link は存在しない (Pro 年が最上位、 Free/Standard は下位)
    expect(screen.queryByRole('link', { name: 'アップグレード' })).not.toBeInTheDocument()
    // Pro 年 current + Free/Standard 下位
    expect(screen.getAllByText('現在のプラン').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('現在より下位プラン').length).toBeGreaterThanOrEqual(2)
  })
})
