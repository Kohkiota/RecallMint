// @vitest-environment jsdom
// BillingBanner: ?billing=<kind> を kind prop で受け取り種別文言を表示する
// client toast の render test。 kind→文言の lookup / dismiss 状態 /
// auto-dismiss timer / URL クリーン (window.history.replaceState) を検証する。
// Next router context は不要 (prop 注入 + history API 直接書換のため)。

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'

import { BillingBanner } from './billing-banner'

beforeEach(() => {
  // 各 test は default URL から開始する (URL クリーン test 用に明示)。
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BillingBanner: 文言 lookup', () => {
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
})

describe('BillingBanner: dismiss 経路', () => {
  it('閉じるボタンで toast が消える (キーボード到達可能な aria-label 付き)', () => {
    render(<BillingBanner kind="new" />)
    const dismiss = screen.getByRole('button', { name: '閉じる' })
    fireEvent.click(dismiss)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('一定秒数経過で自動的に fade out → unmount する', () => {
    vi.useFakeTimers()
    render(<BillingBanner kind="new" />)
    expect(screen.getByRole('status')).toBeInTheDocument()

    // fade 開始: opacity-0 class が付与される
    act(() => {
      vi.advanceTimersByTime(4500)
    })
    expect(screen.getByRole('status').className).toContain('opacity-0')

    // fade 完了で unmount
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('BillingBanner: URL クリーン (reload 再発火防止)', () => {
  it('mount 時に ?billing= を URL から除去する (他クエリは保持)', () => {
    window.history.replaceState(null, '', '/app?billing=new&other=keep')
    render(<BillingBanner kind="new" />)
    expect(window.location.pathname).toBe('/app')
    expect(window.location.search).toBe('?other=keep')
  })

  it('?billing= 単独なら search が空になる', () => {
    window.history.replaceState(null, '', '/app?billing=upgrade')
    render(<BillingBanner kind="upgrade" />)
    expect(window.location.pathname).toBe('/app')
    expect(window.location.search).toBe('')
  })

  it('kind が無効で描画しない場合は URL を触らない', () => {
    window.history.replaceState(null, '', '/app?billing=garbage&other=keep')
    render(<BillingBanner kind="garbage" />)
    // garbage は COPY 未登録 → useEffect は no-op、 query 維持
    expect(window.location.search).toBe('?billing=garbage&other=keep')
  })
})
