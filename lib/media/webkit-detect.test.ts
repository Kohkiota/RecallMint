// isWebKitImagePipeline test (画像圧縮 iOS/WebKit 修正 spec Task 1)。
//
// Node 24 は実 navigator を持つため、 各 test で globalThis.navigator を
// stub し、 afterEach で元の navigator に戻す (sweep.test.ts と同型)。

import { describe, it, expect, afterEach } from 'vitest'
import { isWebKitImagePipeline } from '@/lib/media/webkit-detect'

const originalNavigator = (globalThis as { navigator?: unknown }).navigator

function stubNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  if (originalNavigator === undefined) {
    delete (globalThis as { navigator?: unknown }).navigator
  } else {
    stubNavigator(originalNavigator)
  }
})

const UA_IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const UA_IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1'
const UA_IOS_FIREFOX =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/604.1'
const UA_DESKTOP_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const UA_CHROMIUM =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const UA_DESKTOP_FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'

describe('isWebKitImagePipeline', () => {
  it('typeof navigator === undefined → false (SSR safety)', () => {
    delete (globalThis as { navigator?: unknown }).navigator
    expect(isWebKitImagePipeline()).toBe(false)
  })

  it('iOS Safari → true', () => {
    stubNavigator({ userAgent: UA_IOS_SAFARI, platform: 'iPhone', maxTouchPoints: 5 })
    expect(isWebKitImagePipeline()).toBe(true)
  })

  it('iOS Chrome (CriOS UA) → true (iP* 条件で拾う。AppleWebKit 除外に落ちない)', () => {
    stubNavigator({ userAgent: UA_IOS_CHROME, platform: 'iPhone', maxTouchPoints: 5 })
    expect(isWebKitImagePipeline()).toBe(true)
  })

  it('iOS Firefox (FxiOS UA) → true (iP* 条件で拾う。AppleWebKit 除外に落ちない)', () => {
    stubNavigator({ userAgent: UA_IOS_FIREFOX, platform: 'iPhone', maxTouchPoints: 5 })
    expect(isWebKitImagePipeline()).toBe(true)
  })

  it('desktop-class iPad (MacIntel + maxTouchPoints>1, UA は desktop Safari 偽装) → true', () => {
    stubNavigator({
      userAgent: UA_DESKTOP_SAFARI,
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })
    expect(isWebKitImagePipeline()).toBe(true)
  })

  it('desktop Safari (非 touch Mac) → true', () => {
    stubNavigator({
      userAgent: UA_DESKTOP_SAFARI,
      platform: 'MacIntel',
      maxTouchPoints: 0,
    })
    expect(isWebKitImagePipeline()).toBe(true)
  })

  it('Chromium/Blink (desktop Chrome) → false', () => {
    stubNavigator({ userAgent: UA_CHROMIUM, platform: 'Win32', maxTouchPoints: 0 })
    expect(isWebKitImagePipeline()).toBe(false)
  })

  it('desktop Firefox → false', () => {
    stubNavigator({ userAgent: UA_DESKTOP_FIREFOX, platform: 'Win32', maxTouchPoints: 0 })
    expect(isWebKitImagePipeline()).toBe(false)
  })
})
