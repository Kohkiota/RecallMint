// metric-constants の値 pin。定義 doc §7.1 が凍結する数値そのもの(較正で変わり得るが
// 「変わったことに気付く」ための pin — 無自覚な値ドリフトの検出)。

import { describe, expect, it } from 'vitest'
import {
  DAILY_NEW_DEFAULT,
  ESTIMATE_CAP_MS,
  ESTIMATE_DEFAULT_MS,
  ESTIMATE_SAMPLE_N,
  ESTIMATE_SCAN_LIMIT,
  FORECAST_DAYS,
  QUICK_PRESET_N,
  S_MATURE,
  WEAK_LAPSES_MIN,
  WEAK_TAG_MIN_CARDS,
  WEAK_TAG_MIN_REVIEWS,
  WEAK_TAG_TOP_N,
} from './metric-constants'

describe('metric-constants', () => {
  it('定義 doc §7.1 の値と一致する', () => {
    expect(S_MATURE).toBe(21)
    expect(WEAK_LAPSES_MIN).toBe(2)
    expect(WEAK_TAG_MIN_CARDS).toBe(8)
    expect(WEAK_TAG_MIN_REVIEWS).toBe(15)
    expect(ESTIMATE_DEFAULT_MS).toBe(20_000)
    expect(ESTIMATE_CAP_MS).toBe(120_000)
    expect(ESTIMATE_SAMPLE_N).toBe(100)
    expect(ESTIMATE_SCAN_LIMIT).toBe(1_000)
    expect(WEAK_TAG_TOP_N).toBe(3)
    expect(FORECAST_DAYS).toBe(7)
    expect(QUICK_PRESET_N).toBe(10)
    expect(DAILY_NEW_DEFAULT).toBe(20)
  })
})
