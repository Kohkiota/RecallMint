// @vitest-environment jsdom
// InstallPrompt unit (画像フェーズ A Task 12 / spec §7)。
// 観点: standalone → null / 非 standalone → ヒント表示 / dismiss で消える /
// beforeinstallprompt 捕捉時は install ボタン、 未捕捉 (iOS) は手動手順テキスト。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { InstallPrompt } from './install-prompt'

// display-mode: standalone の matchMedia を制御する stub。
function stubMatchMedia(standalone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('display-mode: standalone') ? standalone : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  // navigator.standalone を明示的に false 化 (iOS 判定の混入を防ぐ)。
  Object.defineProperty(navigator, 'standalone', {
    value: false,
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('InstallPrompt', () => {
  it('standalone (display-mode) なら何も描画しない (null)', () => {
    stubMatchMedia(true)
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('iOS standalone (navigator.standalone) なら何も描画しない', () => {
    stubMatchMedia(false)
    Object.defineProperty(navigator, 'standalone', {
      value: true,
      configurable: true,
      writable: true,
    })
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('非 standalone なら「ホーム画面に追加」のヒントを表示する', () => {
    stubMatchMedia(false)
    render(<InstallPrompt />)
    expect(
      screen.getByText(/ホーム画面に追加すると画像がオフラインでも消えにくくなります/),
    ).toBeTruthy()
  })

  it('beforeinstallprompt 未捕捉 (iOS Safari) なら手動手順テキストを表示', () => {
    stubMatchMedia(false)
    render(<InstallPrompt />)
    expect(screen.getByText(/「ホーム画面に追加」から登録できます/)).toBeTruthy()
    // Chromium 用 install ボタンは出さない。
    expect(screen.queryByRole('button', { name: 'ホーム画面に追加' })).toBeNull()
  })

  it('beforeinstallprompt 捕捉時は install ボタンを表示し click で prompt() を呼ぶ', () => {
    stubMatchMedia(false)
    render(<InstallPrompt />)

    const promptFn = vi.fn(async () => {})
    const event = Object.assign(new Event('beforeinstallprompt'), {
      prompt: promptFn,
    })
    // preventDefault を追跡。
    const preventDefault = vi.spyOn(event, 'preventDefault')
    fireEvent(window, event)

    expect(preventDefault).toHaveBeenCalled()
    const installBtn = screen.getByRole('button', { name: 'ホーム画面に追加' })
    fireEvent.click(installBtn)
    expect(promptFn).toHaveBeenCalledTimes(1)
  })

  it('閉じるボタンで dismiss すると消える', () => {
    stubMatchMedia(false)
    render(<InstallPrompt />)
    expect(
      screen.getByText(/ホーム画面に追加すると画像がオフラインでも消えにくくなります/),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(
      screen.queryByText(/ホーム画面に追加すると画像がオフラインでも消えにくくなります/),
    ).toBeNull()
  })
})
