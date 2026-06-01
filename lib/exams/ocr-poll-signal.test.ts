import { describe, it, expect, vi } from 'vitest'
import { subscribeOcrPoll, requestOcrPoll } from './ocr-poll-signal'

// module-scope Set を持つモジュールのため、各テストで subscribe したものは
// 必ず unsubscribe し state を自己完結させる

describe('ocr-poll-signal', () => {
  it('(a) subscribe した listener が requestOcrPoll で呼ばれる', () => {
    const fn = vi.fn()
    const unsub = subscribeOcrPoll(fn)
    requestOcrPoll()
    expect(fn).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('(b) unsubscribe 後は requestOcrPoll で呼ばれない', () => {
    const fn = vi.fn()
    const unsub = subscribeOcrPoll(fn)
    unsub()
    requestOcrPoll()
    expect(fn).not.toHaveBeenCalled()
  })

  it('(c) 複数 listener が全て呼ばれる', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const fn3 = vi.fn()
    const unsub1 = subscribeOcrPoll(fn1)
    const unsub2 = subscribeOcrPoll(fn2)
    const unsub3 = subscribeOcrPoll(fn3)
    requestOcrPoll()
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
    expect(fn3).toHaveBeenCalledTimes(1)
    unsub1()
    unsub2()
    unsub3()
  })

  it('(d) 1 listener が throw しても他 listener は呼ばれる (隔離)', () => {
    const throwing = vi.fn(() => { throw new Error('intentional') })
    const safe = vi.fn()
    const unsub1 = subscribeOcrPoll(throwing)
    const unsub2 = subscribeOcrPoll(safe)
    // throw が外に伝播しないことも確認
    expect(() => requestOcrPoll()).not.toThrow()
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(safe).toHaveBeenCalledTimes(1)
    unsub1()
    unsub2()
  })

  it('(e) unsubscribe の冪等性: 2 回呼んでも他 listener に影響なし', () => {
    const fn = vi.fn()
    const other = vi.fn()
    const unsub = subscribeOcrPoll(fn)
    const unsubOther = subscribeOcrPoll(other)
    unsub()
    unsub() // 2 回目 — 安全に no-op であること
    requestOcrPoll()
    expect(fn).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledTimes(1)
    unsubOther()
  })
})
