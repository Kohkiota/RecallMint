// @vitest-environment jsdom
// UpgradePlans client component test。プラン状態 × toggle 切替 × §5.5 ブロックの
// CTA 表示を検証。server action は spy のみ (form submit 起動の検証は別 path)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('./actions', () => ({
  createCheckoutSession: vi.fn(),
  changePlan: vi.fn(),
  cancelDowngrade: vi.fn(),
}))

import { UpgradePlans } from './upgrade-plans'

// 全 case でブロック flag は false default。ブロック専用 case で個別に上書きする。
function renderPlans(
  props: Partial<React.ComponentProps<typeof UpgradePlans>> & {
    userPlan: React.ComponentProps<typeof UpgradePlans>['userPlan']
    userInterval: React.ComponentProps<typeof UpgradePlans>['userInterval']
  },
) {
  return render(
    <UpgradePlans
      hasPendingUpdate={false}
      cancelScheduled={false}
      hasScheduledDowngrade={false}
      {...props}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('UpgradePlans', () => {
  it('見出しは「プラン変更」', () => {
    renderPlans({ userPlan: 'free', userInterval: null })
    expect(
      screen.getByRole('heading', { name: 'プラン変更' }),
    ).toBeInTheDocument()
  })

  it('Free user: Standard / Pro 両方 月額 CTA active (加入可能)', () => {
    renderPlans({ userPlan: 'free', userInterval: null })
    expect(screen.getByText(/現在のプラン/)).toHaveTextContent('Free')
    expect(screen.getByRole('button', { name: 'Standard に加入' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Pro に加入' })).toBeEnabled()
  })

  it('Standard 月額 user: 現在の Standard 月 = disabled、 Pro 月 = 変更 enabled', () => {
    renderPlans({ userPlan: 'standard', userInterval: 'month' })
    expect(screen.getByRole('button', { name: '現在のプラン' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Pro 月額 に変更' }),
    ).toBeEnabled()
  })

  it('下位プランも選択可: Pro 月額 user で Standard 月 = 「現在より下位」ではなく変更 enabled', () => {
    renderPlans({ userPlan: 'pro', userInterval: 'month' })
    // 旧「現在より下位プラン」disabled は撤廃 → Standard 月への変更が active
    expect(
      screen.getByRole('button', { name: 'Standard 月額 に変更' }),
    ).toBeEnabled()
    expect(screen.queryByText('現在より下位プラン')).not.toBeInTheDocument()
  })

  it('Pro 月額 user で 年 toggle: Pro 年 = 変更 active、 Standard 年 = 変更 active (下位も可)', () => {
    renderPlans({ userPlan: 'pro', userInterval: 'month' })
    fireEvent.click(screen.getByRole('button', { name: /年額/ }))
    expect(
      screen.getByRole('button', { name: 'Pro 年額 に変更' }),
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Standard 年額 に変更' }),
    ).toBeEnabled()
  })

  it('toggle 月→年 で 価格表示が切り替わる', () => {
    renderPlans({ userPlan: 'free', userInterval: null })
    expect(screen.getByText('¥680')).toBeInTheDocument()
    expect(screen.getByText('¥1,280')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /年額/ }))
    expect(screen.getByText('¥6,800')).toBeInTheDocument()
    expect(screen.getByText('¥12,800')).toBeInTheDocument()
  })

  it('paid user で billingInterval=null (transition window): 月 toggle default で「現在のプラン」表示', () => {
    renderPlans({ userPlan: 'standard', userInterval: null })
    expect(screen.getAllByText('現在のプラン').length).toBeGreaterThanOrEqual(1)
  })

  it('free user の CTA は checkout form (plan/interval hidden input を持つ)', () => {
    const { container } = renderPlans({ userPlan: 'free', userInterval: null })
    const planInputs = container.querySelectorAll('input[name="plan"]')
    const intervalInputs = container.querySelectorAll('input[name="interval"]')
    expect(planInputs.length).toBeGreaterThanOrEqual(2)
    expect(intervalInputs.length).toBeGreaterThanOrEqual(2)
    // free は changePlan 経路ではないので operationId hidden input は無い
    expect(container.querySelector('input[name="operationId"]')).toBeNull()
  })

  it('paid user の CTA は changePlan form (operationId hidden input を持つ)', () => {
    const { container } = renderPlans({ userPlan: 'standard', userInterval: 'month' })
    const opInputs = container.querySelectorAll('input[name="operationId"]')
    // 現プラン以外の paid CTA すべてに operationId が載る
    expect(opInputs.length).toBeGreaterThanOrEqual(1)
    opInputs.forEach((el) => {
      expect((el as HTMLInputElement).value).not.toBe('')
    })
  })

  it('ブロック (hasPendingUpdate): 全変更 CTA disabled + 案内文表示', () => {
    renderPlans({
      userPlan: 'standard',
      userInterval: 'month',
      hasPendingUpdate: true,
    })
    expect(
      screen.getByText(/処理中の支払い完了 または 予約キャンセルを先に行ってください/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Pro 月額 に変更' }),
    ).toBeDisabled()
  })

  it('ブロック (cancelScheduled): 全変更 CTA disabled + 案内文表示', () => {
    renderPlans({
      userPlan: 'standard',
      userInterval: 'month',
      cancelScheduled: true,
    })
    expect(
      screen.getByText(/処理中の支払い完了/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Pro 月額 に変更' }),
    ).toBeDisabled()
  })

  it('ブロック (hasScheduledDowngrade): 全変更 CTA disabled + 案内文表示', () => {
    renderPlans({
      userPlan: 'pro',
      userInterval: 'year',
      hasScheduledDowngrade: true,
    })
    expect(
      screen.getByText(/処理中の支払い完了/),
    ).toBeInTheDocument()
    // pro+year なので下位への変更 CTA が複数。すべて disabled。
    expect(
      screen.getByRole('button', { name: 'Standard 年額 に変更' }),
    ).toBeDisabled()
  })

  it('非ブロック時は案内文を出さない', () => {
    renderPlans({ userPlan: 'standard', userInterval: 'month' })
    expect(screen.queryByText(/処理中の支払い完了/)).not.toBeInTheDocument()
  })
})
