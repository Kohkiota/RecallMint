// @vitest-environment jsdom
// ActionToast: auto-dismiss / action button / 連続表示 (置換) の timer 挙動 test。
// fake timers + fireEvent (userEvent は fake timers と相性が悪い)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

import { ActionToast, ACTION_TOAST_AUTO_DISMISS_MS } from './action-toast'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('ActionToast — 表示と a11y', () => {
  it('message を role="status" aria-live="polite" で描画する', () => {
    render(<ActionToast message="2 枚を移動しました" onClose={vi.fn()} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('2 枚を移動しました')
  })

  it('actionLabel / onAction が無ければ action button を描画しない (閉じるのみ)', () => {
    render(<ActionToast message="元に戻しました" onClose={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument()
  })
})

describe('ActionToast — auto-dismiss (15 秒)', () => {
  it('15 秒経過で onClose を 1 回呼ぶ (14.999 秒では呼ばない)', () => {
    const onClose = vi.fn()
    render(<ActionToast message="2 枚を移動しました" onClose={onClose} />)

    advance(ACTION_TOAST_AUTO_DISMISS_MS - 1)
    expect(onClose).not.toHaveBeenCalled()

    advance(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('auto-dismiss は 15 秒 (billing banner の 4.5 秒ではない)', () => {
    const onClose = vi.fn()
    render(<ActionToast message="2 枚を移動しました" onClose={onClose} />)
    advance(4500)
    expect(onClose).not.toHaveBeenCalled()
    expect(ACTION_TOAST_AUTO_DISMISS_MS).toBe(15_000)
  })

  it('unmount 後は timer が発火しない (置換時に旧 timer が残らない)', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <ActionToast message="2 枚を移動しました" onClose={onClose} />,
    )
    advance(10_000)
    unmount()
    advance(10_000)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('再 render で onClose の identity が変わっても timer は張り直さず、最新の onClose を呼ぶ', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(
      <ActionToast message="2 枚を移動しました" onClose={first} />,
    )
    advance(10_000)
    // 同 message のまま別 identity の onClose を渡す (親の再 render 相当)。
    rerender(<ActionToast message="2 枚を移動しました" onClose={second} />)
    advance(5_000)

    // timer が張り直されていれば 15 秒経過扱いにならず 0 回になる。
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })
})

describe('ActionToast — 連続表示 (単一 slot の置換)', () => {
  it('同一文言のまま key も変えずに再 render すると timer は張り直らない (親が key を付ける契約の根拠)', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <ActionToast message="2 枚を移動しました" onClose={onClose} />,
    )
    advance(10_000)

    // message が同値だと timer effect は再実行されない = 置換時点からの 15 秒にならない。
    rerender(<ActionToast message="2 枚を移動しました" onClose={onClose} />)
    advance(5_000)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('message 差し替えで旧 timer が clear され、新しい 15 秒が張られる', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <ActionToast message="2 枚を移動しました" onClose={onClose} />,
    )
    advance(10_000)

    rerender(<ActionToast message="3 枚を移動しました" onClose={onClose} />)
    // 旧 timer の期限 (合計 15 秒) を跨いでも発火しない = 旧 timer は clear 済。
    advance(9_000)
    expect(onClose).not.toHaveBeenCalled()

    // 置換時点からの 15 秒で発火する。
    advance(6_000)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('同一文言の連続表示は key の付け替えで置換する (remount で timer が張り直る)', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <ActionToast key="move-1" message="2 枚を移動しました" onClose={onClose} />,
    )
    advance(10_000)

    rerender(
      <ActionToast key="move-2" message="2 枚を移動しました" onClose={onClose} />,
    )
    advance(9_000)
    expect(onClose).not.toHaveBeenCalled()

    advance(6_000)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ActionToast — action button', () => {
  it('click で onAction を呼ぶ (onClose は呼ばない)', () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(
      <ActionToast
        message="2 枚を移動しました"
        actionLabel="元に戻す"
        onAction={onAction}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '元に戻す' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('actionPending で disabled になり click しても onAction を呼ばない (二度押し防止 = 親責務)', () => {
    const onAction = vi.fn()
    render(
      <ActionToast
        message="2 枚を移動しました"
        actionLabel="元に戻す"
        onAction={onAction}
        actionPending
        onClose={vi.fn()}
      />,
    )

    const button = screen.getByRole('button', { name: '元に戻す' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('閉じるボタン click で onClose を呼ぶ', () => {
    const onClose = vi.fn()
    render(
      <ActionToast
        message="2 枚を移動しました"
        actionLabel="元に戻す"
        onAction={vi.fn()}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
