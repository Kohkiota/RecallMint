// BFCache 復元時の zombie state を防ぐ setupBFCacheReload の unit test。
// setup function pattern を直接呼ぶため @testing-library / jsdom 不要。
// setupBFCacheReload は Window を引数で受け取るため、mock Window を渡して
// window.location.reload を監視できる (Node 18+ の Event グローバルで十分動作)。

import { describe, it, expect, vi } from 'vitest'
import { setupBFCacheReload } from './bfcache-guard'

// jsdom の window.location は readonly プロパティが多いため、
// テスト用の mock Window を作成して setupBFCacheReload に渡す。
// 実 window の location を上書きしないので beforeEach で安全にリセットできる。
function createMockWindow() {
  const listeners: Record<string, EventListenerOrEventListenerObject[]> = {}
  const mockReload = vi.fn()

  const mockWindow = {
    location: { reload: mockReload },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (!listeners[type]) listeners[type] = []
      listeners[type].push(listener)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (!listeners[type]) return
      listeners[type] = listeners[type].filter((l) => l !== listener)
    },
    dispatchEvent(event: Event) {
      const handlers = listeners[event.type] ?? []
      handlers.forEach((h) => {
        if (typeof h === 'function') h(event)
        else h.handleEvent(event)
      })
      return true
    },
  } as unknown as Window

  return { mockWindow, mockReload }
}

describe('setupBFCacheReload', () => {
  it('case 1: pageshow event with persisted=true → reload が呼ばれる', () => {
    const { mockWindow, mockReload } = createMockWindow()
    const cleanup = setupBFCacheReload(mockWindow)

    const event = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(event, 'persisted', { value: true, configurable: true })
    mockWindow.dispatchEvent(event)

    expect(mockReload).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('case 2: pageshow event with persisted=false → reload が呼ばれない', () => {
    const { mockWindow, mockReload } = createMockWindow()
    const cleanup = setupBFCacheReload(mockWindow)

    const event = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(event, 'persisted', { value: false, configurable: true })
    mockWindow.dispatchEvent(event)

    expect(mockReload).not.toHaveBeenCalled()

    cleanup()
  })

  it('case 3: cleanup 呼び出し後は listener が削除され、persisted=true でも reload が呼ばれない', () => {
    const { mockWindow, mockReload } = createMockWindow()
    const cleanup = setupBFCacheReload(mockWindow)

    // cleanup で listener を削除する
    cleanup()

    // cleanup 後に pageshow persisted=true を dispatch → reload 呼ばれないはず
    const event = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(event, 'persisted', { value: true, configurable: true })
    mockWindow.dispatchEvent(event)

    expect(mockReload).not.toHaveBeenCalled()
  })
})
