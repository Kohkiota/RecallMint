// @vitest-environment jsdom
// BillingBanner: ?billing=<kind> を kind prop で受け取り種別文言を表示する
// client banner の render test。kind→文言の lookup と dismiss 状態のみ持つので
// Next router context 不要 (prop 注入のため useSearchParams/Suspense を避ける)。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import { BillingBanner } from './billing-banner'

afterEach(() => {
  cleanup()
})

describe('BillingBanner', () => {
  it('kind=new: 決済受付の文言を role="status" で表示', () => {
    render(<BillingBanner kind="new" />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(
      '決済を受け付けました。反映まで少し時間がかかる場合があります。',
    )
  })

  it('kind=upgrade: 支払い確認後にプラン反映の文言', () => {
    render(<BillingBanner kind="upgrade" />)
    expect(screen.getByRole('status')).toHaveTextContent(
      '支払い確認後にプランが反映されます。',
    )
  })

  it('kind=downgrade: 請求期間終了後にプラン変更の文言', () => {
    render(<BillingBanner kind="downgrade" />)
    expect(screen.getByRole('status')).toHaveTextContent(
      '現在の請求期間終了後にプランが変更されます。',
    )
  })

  it('kind=cancel: 請求期間終了後に Free へ戻る文言', () => {
    render(<BillingBanner kind="cancel" />)
    expect(screen.getByRole('status')).toHaveTextContent(
      '現在の請求期間終了後に Free へ戻ります。',
    )
  })

  it('未知の kind は何も描画しない', () => {
    render(<BillingBanner kind="garbage" />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('kind 未指定 (undefined) は何も描画しない', () => {
    render(<BillingBanner kind={undefined} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('閉じるボタンで banner が消える (キーボード到達可能な aria-label 付き)', () => {
    render(<BillingBanner kind="new" />)
    const dismiss = screen.getByRole('button', { name: '閉じる' })
    fireEvent.click(dismiss)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
