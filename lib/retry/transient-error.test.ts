// transient-error 共有 util の test。 OCR (lib/ai/ocr.ts) と review-events flush の
// 両方が参照する error 分類 + backoff 計算を verify する。
// CLAUDE.md AI 絶対ルール 5: 429 (rate limit) は即時停止 = retry 対象から除外。
// 503 等の transient (5xx / network / timeout) とは厳密に区別する (429 ≠ 503)。

import { describe, it, expect } from 'vitest'
import {
  isRateLimitError,
  isTransientError,
  computeBackoffMs,
} from './transient-error'

describe('isRateLimitError', () => {
  it('429 数字 / rate limit / RESOURCE_EXHAUSTED を rate limit と判定する', () => {
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true)
    expect(isRateLimitError(new Error('rate limit exceeded'))).toBe(true)
    expect(isRateLimitError(new Error('ratelimit'))).toBe(true)
    expect(isRateLimitError(new Error('RESOURCE_EXHAUSTED'))).toBe(true)
  })

  it('5xx / network / 通常の 4xx は rate limit ではない', () => {
    expect(isRateLimitError(new Error('503 Service Unavailable'))).toBe(false)
    expect(isRateLimitError(new Error('500 Internal Server Error'))).toBe(false)
    expect(isRateLimitError(new Error('fetch failed'))).toBe(false)
    expect(isRateLimitError(new Error('400 Bad Request'))).toBe(false)
  })

  it('Error 以外 (string / number) も String 化して判定する', () => {
    expect(isRateLimitError('429')).toBe(true)
    expect(isRateLimitError(429)).toBe(true)
    expect(isRateLimitError('503')).toBe(false)
  })
})

describe('isTransientError', () => {
  it('5xx (500/502/503/504) / timeout / unavailable / network 断を transient と判定する', () => {
    expect(isTransientError(new Error('500'))).toBe(true)
    expect(isTransientError(new Error('502 Bad Gateway'))).toBe(true)
    expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true)
    expect(isTransientError(new Error('504 Gateway Timeout'))).toBe(true)
    expect(isTransientError(new Error('request timeout'))).toBe(true)
    expect(isTransientError(new Error('model unavailable'))).toBe(true)
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true)
    expect(isTransientError(new Error('fetch failed'))).toBe(true)
    expect(isTransientError(new Error('socket hang up'))).toBe(true)
  })

  it('429 (rate limit) は transient に含めない (即時停止扱い、 ルール 5)', () => {
    expect(isTransientError(new Error('429 Too Many Requests'))).toBe(false)
  })

  it('通常の 4xx (400 / 403) は transient ではない (retry しない)', () => {
    expect(isTransientError(new Error('400 Bad Request'))).toBe(false)
    expect(isTransientError(new Error('403 Forbidden'))).toBe(false)
  })

  it('Error 以外 (string / number) も String 化して判定する', () => {
    expect(isTransientError('503')).toBe(true)
    expect(isTransientError(503)).toBe(true)
    expect(isTransientError('fetch failed')).toBe(true)
    expect(isTransientError('400')).toBe(false)
  })
})

describe('429 ≠ 503 (相互排他、 CLAUDE.md ルール 5)', () => {
  it('429 は rate limit かつ非 transient、 503 は transient かつ非 rate limit', () => {
    expect(isRateLimitError('429')).toBe(true)
    expect(isTransientError('429')).toBe(false)
    expect(isTransientError('503')).toBe(true)
    expect(isRateLimitError('503')).toBe(false)
  })
})

describe('computeBackoffMs', () => {
  const base = [5_000, 20_000] as const
  const jitter = [2_000, 5_000] as const

  it('rng=0 のとき base[attempt] をそのまま返す (jitter なし)', () => {
    expect(computeBackoffMs(0, base, jitter, () => 0)).toBe(5_000)
    expect(computeBackoffMs(1, base, jitter, () => 0)).toBe(20_000)
  })

  it('rng 値に応じて jitter を base に加算する', () => {
    expect(computeBackoffMs(0, base, jitter, () => 0.5)).toBe(5_000 + 1_000)
    expect(computeBackoffMs(1, base, jitter, () => 1)).toBe(20_000 + 5_000)
  })

  it('attempt で base / jitter 配列を index する', () => {
    const b = [10_000, 30_000, 60_000] as const
    const j = [0, 0, 0] as const
    expect(computeBackoffMs(2, b, j, () => 0.9)).toBe(60_000)
  })
})
