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
import { changePlan } from './actions'

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
    // 現プラン以外の paid CTA すべてに operationId hidden input が存在する。
    // T7: 値は confirm 時に生成するため、初期 render では空 (confirm 後に非空)。
    expect(opInputs.length).toBeGreaterThanOrEqual(1)
  })

  it('ブロック (hasPendingUpdate): 全変更 CTA disabled + 支払い処理中 notice', () => {
    renderPlans({
      userPlan: 'standard',
      userInterval: 'month',
      hasPendingUpdate: true,
    })
    // 新文言は支払い特化 (旧「処理中の支払い完了 または 予約キャンセル」)
    expect(
      screen.getByText(/お支払いの処理中です/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/解約予約中/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Pro 月額 に変更' }),
    ).toBeDisabled()
  })

  it('ブロック (cancelScheduled): 全変更 CTA disabled + 解約予約中 notice', () => {
    renderPlans({
      userPlan: 'standard',
      userInterval: 'month',
      cancelScheduled: true,
    })
    expect(
      screen.getByText(/解約予約中です/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/お支払いの処理中/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Pro 月額 に変更' }),
    ).toBeDisabled()
  })

  it('ブロック (hasScheduledDowngrade のみ): 全変更 CTA disabled、 notice なし (banner で代替)', () => {
    renderPlans({
      userPlan: 'pro',
      userInterval: 'year',
      hasScheduledDowngrade: true,
    })
    // hasPendingUpdate / cancelScheduled が false のため、 支払い / 解約系の
    // notice は出ない (DowngradeReservationBanner が予約内容 + 取消ボタンを
    // 既に表示するため冗長回避)。
    expect(
      screen.queryByText(/お支払いの処理中/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/解約予約中/),
    ).not.toBeInTheDocument()
    // CTA は blocked のまま (全 disable は維持)。
    expect(
      screen.getByRole('button', { name: 'Standard 年額 に変更' }),
    ).toBeDisabled()
  })

  it('ブロック (hasPendingUpdate + hasScheduledDowngrade 両 true): 支払い処理中 notice 優先', () => {
    renderPlans({
      userPlan: 'pro',
      userInterval: 'year',
      hasPendingUpdate: true,
      hasScheduledDowngrade: true,
    })
    // 優先順位: hasPendingUpdate > cancelScheduled > hasScheduledDowngrade。
    expect(
      screen.getByText(/お支払いの処理中/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/解約予約中/),
    ).not.toBeInTheDocument()
  })

  it('非ブロック時は案内文を出さない', () => {
    renderPlans({ userPlan: 'standard', userInterval: 'month' })
    expect(screen.queryByText(/お支払いの処理中/)).not.toBeInTheDocument()
    expect(screen.queryByText(/解約予約中/)).not.toBeInTheDocument()
  })

  it('paid CTA click は即 submit せず確認 modal を開く', () => {
    renderPlans({ userPlan: 'standard', userInterval: 'month' })
    // click 前は modal 非表示
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pro 月額 に変更' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // changePlan は確認前には呼ばれない (form submit は confirm 後)
    expect(changePlan).not.toHaveBeenCalled()
  })

  it('upgrade 方向の modal は §5.2 の即時差額請求文言を出す', () => {
    // Standard 月 → Pro 月 = upgrade
    renderPlans({ userPlan: 'standard', userInterval: 'month' })
    fireEvent.click(screen.getByRole('button', { name: 'Pro 月額 に変更' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Pro に変更しますか？')
    expect(dialog).toHaveTextContent(
      '今すぐ差額が請求され、プランが変更されます',
    )
  })

  it('downgrade 方向の modal は §5.3 の期末切替文言を出す', () => {
    // Pro 月 → Standard 月 = downgrade
    renderPlans({ userPlan: 'pro', userInterval: 'month' })
    fireEvent.click(screen.getByRole('button', { name: 'Standard 月額 に変更' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Standard に変更しますか？')
    expect(dialog).toHaveTextContent(
      '現在の請求期間終了後に Standard へ切り替わります。それまでは現在のプランを利用できます',
    )
  })

  it('confirm で form の operationId hidden input が非空値になる', () => {
    const { container } = renderPlans({
      userPlan: 'standard',
      userInterval: 'month',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pro 月額 に変更' }))
    // confirm 前は operationId は空 (confirm 時生成)
    const opBefore = container.querySelector(
      'input[name="operationId"]',
    ) as HTMLInputElement | null
    expect(opBefore?.value ?? '').toBe('')
    // requestSubmit は jsdom 未実装のため no-op stub を入れて confirm を通す
    HTMLFormElement.prototype.requestSubmit = vi.fn()
    fireEvent.click(screen.getByRole('button', { name: '変更する' }))
    const opAfter = container.querySelector(
      'input[name="operationId"]',
    ) as HTMLInputElement | null
    expect(opAfter?.value).not.toBe('')
  })

  it('変更予約中: banner に短縮ラベル + 日付 + 取消 form を表示', () => {
    const { container } = renderPlans({
      userPlan: 'pro',
      userInterval: 'year',
      hasScheduledDowngrade: true,
      // page.tsx が tier + interval の短縮ラベルを渡す (例: "Standard 月額")。
      scheduledTargetPlanLabel: 'Standard 月額',
      scheduledEffectiveDateLabel: '2026/07/01',
    })
    // banner と blocked notice は両方 role="status"。変更予約中文言で banner を特定。
    const banner = screen
      .getAllByRole('status')
      .find((el) => el.textContent?.includes('変更予約中'))!
    expect(banner).toBeDefined()
    // 「Standard 月額へ変更予約中（2026/07/01）— 取消」: 短縮ラベル + 全角括弧日付。
    // フルラベル「プラン」は使わない。
    expect(banner).toHaveTextContent('Standard 月額へ変更予約中')
    expect(banner.textContent).not.toContain('プラン')
    expect(banner.textContent).not.toContain('ダウングレード')
    expect(banner).toHaveTextContent('2026/07/01')
    // hasScheduledDowngrade のみ true の場合、 banner 以外の blocked notice は
    // 出ない (支払い / 解約系 notice は表示しない、 banner が予約内容 + 取消を
    // 代替)。
    expect(screen.queryByText(/お支払いの処理中/)).not.toBeInTheDocument()
    expect(screen.queryByText(/解約予約中です/)).not.toBeInTheDocument()
    // 取消ボタンは cancelDowngrade form 配下、blocked でも enabled
    const cancelBtn = screen.getByRole('button', { name: '取消' })
    expect(cancelBtn).toBeEnabled()
    // cancelDowngrade form には operationId hidden input が必要
    const cancelForm = cancelBtn.closest('form')
    expect(cancelForm).not.toBeNull()
    const op = cancelForm!.querySelector(
      'input[name="operationId"]',
    ) as HTMLInputElement | null
    expect(op?.value ?? '').not.toBe('')
    // 変更 CTA は blocked で disabled のまま (取消だけ enabled)
    expect(
      screen.getByRole('button', { name: 'Standard 年額 に変更' }),
    ).toBeDisabled()
    void container
  })
})
