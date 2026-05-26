// study-days-pull mapper test (S-perf-3)。
// cards-pull.test.ts と同 pattern: pure な mapper + 日付閾値 helper を verify。
// DB query 部分は route 統合 test 側で扱う。

import { describe, it, expect } from 'vitest'
import {
  toClientStudyDay,
  studyDaysLowerBound,
  STUDY_DAYS_WINDOW,
} from './study-days-pull'
import type { studyDays } from './schema'

type StudyDayRow = typeof studyDays.$inferSelect

function fakeRow(overrides?: Partial<StudyDayRow>): StudyDayRow {
  return {
    userId: 'user-1',
    day: '2026-05-26',
    reviewCount: 5,
    correctCount: 3,
    distinctCardCount: 4,
    ...overrides,
  }
}

describe('toClientStudyDay', () => {
  it('camelCase → snake_case 変換 (PK [user_id+day] を保持)', () => {
    const out = toClientStudyDay(fakeRow())
    expect(out).toEqual({
      user_id: 'user-1',
      day: '2026-05-26',
      review_count: 5,
      correct_count: 3,
      distinct_card_count: 4,
    })
  })

  it('count が 0 の day も忠実に変換 (server 側で WHERE review_count > 0 は streak 側責任)', () => {
    const out = toClientStudyDay(
      fakeRow({ reviewCount: 0, correctCount: 0, distinctCardCount: 0 }),
    )
    expect(out.review_count).toBe(0)
    expect(out.correct_count).toBe(0)
    expect(out.distinct_card_count).toBe(0)
  })
})

describe('studyDaysLowerBound', () => {
  it('today を含む 90 日 window → today - 89 日 を下限に返す', () => {
    // 2026-05-26 JST 基準で 2026-02-26 (今日含めて 90 日)
    const now = new Date('2026-05-26T03:00:00.000Z') // = 12:00 JST
    expect(studyDaysLowerBound(now)).toBe('2026-02-26')
  })

  it('月跨ぎ / 年跨ぎでも UTC 算術で正しく計算', () => {
    // 2026-01-15 JST から 89 日前 = 2025-10-18
    const now = new Date('2026-01-15T03:00:00.000Z')
    expect(studyDaysLowerBound(now)).toBe('2025-10-18')
  })

  it('JST 境界: UTC 14:59 (= JST 23:59) と UTC 15:00 (= JST 翌 00:00) で day が変わる', () => {
    expect(studyDaysLowerBound(new Date('2026-05-26T14:59:59.000Z'))).toBe(
      '2026-02-26',
    )
    expect(studyDaysLowerBound(new Date('2026-05-26T15:00:00.000Z'))).toBe(
      '2026-02-27',
    )
  })

  it('STUDY_DAYS_WINDOW = 90 (今日含む day 数) の export を提供', () => {
    expect(STUDY_DAYS_WINDOW).toBe(90)
  })
})
