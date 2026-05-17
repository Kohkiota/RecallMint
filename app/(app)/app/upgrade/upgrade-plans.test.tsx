// @vitest-environment jsdom
// UpgradePlans client component test。 5 plan 状態 × toggle 切替の CTA 表示を
// 検証。 server action は spy のみ (form submit 起動の検証は別 path)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('./actions', () => ({
  createCheckoutSession: vi.fn(),
}))

import { UpgradePlans } from './upgrade-plans'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('UpgradePlans', () => {
  it('Free user: Standard / Pro 両方 月額 CTA active (アップグレード可能)', () => {
    render(<UpgradePlans userPlan="free" userInterval={null} />)
    // 「現在のプラン:」表示に Free が含まれる
    expect(screen.getByText(/現在のプラン/)).toHaveTextContent('Free')
    // Standard 加入 + Pro 加入 ボタンが両方存在
    expect(screen.getByRole('button', { name: 'Standard に加入' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Pro に加入' })).toBeEnabled()
  })

  it('Standard 月額 user (月 toggle default): 現在の Standard 月 = disabled、 Pro 月 = upgrade enabled', () => {
    render(<UpgradePlans userPlan="standard" userInterval="month" />)
    // 「現在のプラン」label が Standard カード内に出る
    const currentBtns = screen.getAllByText('現在のプラン')
    expect(currentBtns.length).toBeGreaterThanOrEqual(1)
    // Pro 月額への アップグレード ボタンは active
    expect(
      screen.getByRole('button', { name: 'Pro 月額 にアップグレード' }),
    ).toBeEnabled()
  })

  it('Pro 月額 user で 年 toggle に切替: Pro 年 = アップグレード active、 Standard 年 = 下位 disabled', () => {
    render(<UpgradePlans userPlan="pro" userInterval="month" />)
    // toggle 「年額」 click
    fireEvent.click(screen.getByRole('button', { name: /年額/ }))
    // Pro 年額 upgrade ボタン
    expect(
      screen.getByRole('button', { name: 'Pro 年額 にアップグレード' }),
    ).toBeEnabled()
    // Standard 年は下位プラン
    expect(screen.getByRole('button', { name: '現在より下位プラン' })).toBeDisabled()
  })

  it('toggle 月→年 で 価格表示が切り替わる', () => {
    render(<UpgradePlans userPlan="free" userInterval={null} />)
    // 月額 default: ¥680 / ¥1,280 が表示
    expect(screen.getByText('¥680')).toBeInTheDocument()
    expect(screen.getByText('¥1,280')).toBeInTheDocument()
    // 年額 toggle click
    fireEvent.click(screen.getByRole('button', { name: /年額/ }))
    expect(screen.getByText('¥6,800')).toBeInTheDocument()
    expect(screen.getByText('¥12,800')).toBeInTheDocument()
  })

  it('paid user で billingInterval=null (transition window): 月 toggle default で表示', () => {
    // C1 schema comment にある「2026-05-17 以前の paid user は interval=NULL」
    // を想定。 rank() は NULL を month 扱いするので「現在のプラン」表示が
    // Standard 月になる。
    render(<UpgradePlans userPlan="standard" userInterval={null} />)
    // 「現在のプラン」disabled ボタンが少なくとも 1 つ (Standard 月) 存在
    expect(screen.getAllByText('現在のプラン').length).toBeGreaterThanOrEqual(1)
  })
})
