// weekly — 定義 doc §4-Q(週起点・先週同期間比 delta・pin 14)と §4-P の 30 暦日窓
// (pin 17 の pure 部分)の unit。
//
// 固定 fixture: 2026-08-17(月)〜2026-08-23(日) が Home v1 実装対象週(実カレンダーで
// 検証済み)。先週は 2026-08-10(月)〜2026-08-16(日)。

import { describe, expect, it } from 'vitest'
import { jstDayRange } from '@/lib/jst'
import {
  mondayOfWeek,
  thirtyDayWindowStart,
  weeklyDelta,
  weeklySummary,
  type StudyDayRow,
} from './weekly'

describe('mondayOfWeek (定義 doc §4-Q: 週起点 = 月曜 00:00 JST)', () => {
  it('月曜自身は自分自身', () => {
    expect(mondayOfWeek(new Date('2026-08-17T00:00:00+09:00'))).toBe(
      '2026-08-17',
    )
  })
  it('木曜(中日)は同じ週の月曜', () => {
    expect(mondayOfWeek(new Date('2026-08-20T12:00:00+09:00'))).toBe(
      '2026-08-17',
    )
  })
  it('日曜(週の最終日)は同じ週の月曜', () => {
    expect(mondayOfWeek(new Date('2026-08-23T23:00:00+09:00'))).toBe(
      '2026-08-17',
    )
  })
  it('日曜の直後(翌週月曜 00:00)は翌週の月曜', () => {
    expect(mondayOfWeek(new Date('2026-08-24T00:00:00+09:00'))).toBe(
      '2026-08-24',
    )
  })
})

describe('weeklyDelta (定義 doc §4-Q・pin 14)', () => {
  const nowThursday = new Date('2026-08-20T12:00:00+09:00') // JST 木曜

  function row(day: string, review_count: number): StudyDayRow {
    return { day, review_count }
  }

  it('pin 14: 木曜時点で「今週 月〜水」−「先週 月〜水」になる(先週の木〜日は含めない)', () => {
    const rows: StudyDayRow[] = [
      row('2026-08-17', 5), // 今週 月
      row('2026-08-18', 3), // 今週 火
      row('2026-08-19', 2), // 今週 水
      row('2026-08-20', 100), // 今週 木(今日) — delta の対象外(「昨日まで」)
      row('2026-08-10', 1), // 先週 月
      row('2026-08-11', 1), // 先週 火
      row('2026-08-12', 1), // 先週 水
      row('2026-08-13', 999), // 先週 木 — 同期間比の対象外(含めると red)
    ]
    // 今週(月〜水) = 5+3+2 = 10、先週(月〜水) = 1+1+1 = 3 → delta = 7
    expect(weeklyDelta(rows, nowThursday)).toBe(7)
  })

  it('月曜は delta を出さない(今週の月曜〜昨日が空集合)', () => {
    const nowMonday = new Date('2026-08-17T09:00:00+09:00')
    const rows: StudyDayRow[] = [row('2026-08-10', 5), row('2026-08-17', 3)]
    expect(weeklyDelta(rows, nowMonday)).toBeNull()
  })

  it('先週同期間に行が 1 件も無い場合も delta を出さない', () => {
    const rows: StudyDayRow[] = [
      row('2026-08-17', 5),
      row('2026-08-18', 3),
      row('2026-08-19', 2),
      // 先週(2026-08-10〜12)の行が 1 件も無い
    ]
    expect(weeklyDelta(rows, nowThursday)).toBeNull()
  })

  it('今週の合計が 0 でも(行が review_count=0)先週に行があれば負の delta を出す', () => {
    const rows: StudyDayRow[] = [
      row('2026-08-17', 0),
      row('2026-08-10', 4),
      row('2026-08-11', 0),
      row('2026-08-12', 0),
    ]
    expect(weeklyDelta(rows, nowThursday)).toBe(-4)
  })
})

describe('thirtyDayWindowStart (定義 doc §4-P・pin 17 の pure 部分)', () => {
  it('今日を含む直近 30 暦日の開始 = (today - 29 日) の JST 00:00', () => {
    const now = new Date('2026-08-20T12:00:00+09:00') // JST 2026-08-20
    const start = thirtyDayWindowStart(now)
    expect(start).toEqual(jstDayRange('2026-07-22').startAt)
  })

  // fix round 1/5 I-2: 「境界」test を削除した。旧 test は
  // `expect(start.getTime() >= start.getTime()).toBe(true)` /
  // `expect(oneSecondBefore.getTime() >= start.getTime()).toBe(false)` という
  // `start` 自身に対する自己比較(x >= x / x-1000 >= x)で、`thirtyDayWindowStart` が
  // 何を返しても(実装を消しても)成立してしまう恒真式だった — canonical review 指摘。
  // この module が保証すべきは「返す instant が (today-29日) の JST 00:00 と一致する」
  // ことだけであり、それは直上の test が具体値(`jstDayRange('2026-07-22').startAt`)
  // で pin している。実際のイベント(`answered_at`)に対する `>=` 境界比較(30 日目
  // 00:00 ちょうどは含み、その 1 秒前は含まない)は design doc §13.1 が「タグ別・境界
  // (pin 2, 17)| iso: summary endpoint に fixture(…30 日境界の前後)」と明示的に
  // iso 層(summary endpoint・後続 task)に割り当てている — この pure module の
  // 責務ではなく、ここで模造の pin を残さない。
})

describe('weeklySummary (定義 doc §4-Q: 今週の回答数 / 学習日数 + delta)', () => {
  // 木曜(2026-08-20)基準。今週 = 月〜今日、完了分 = 月〜昨日(水)。
  const now = new Date('2026-08-20T12:00:00+09:00')
  const rows: StudyDayRow[] = [
    { day: '2026-08-10', review_count: 30 }, // 先週月
    { day: '2026-08-11', review_count: 20 }, // 先週火
    { day: '2026-08-12', review_count: 10 }, // 先週水
    { day: '2026-08-13', review_count: 99 }, // 先週木(同期間比の対象外)
    { day: '2026-08-17', review_count: 40 }, // 今週月
    { day: '2026-08-18', review_count: 0 }, // 今週火(行はあるが 0)
    { day: '2026-08-19', review_count: 25 }, // 今週水
    { day: '2026-08-20', review_count: 5 }, // 今日
  ]

  it('回答数は今週(月〜今日)の review_count 合計', () => {
    expect(weeklySummary(rows, now).answers).toBe(70)
  })

  it('学習日数は review_count > 0 の日数(0 の行は数えない)', () => {
    expect(weeklySummary(rows, now).studyDays).toBe(3)
  })

  it('delta は weeklyDelta と同値(先週同期間比)', () => {
    expect(weeklySummary(rows, now).delta).toBe(weeklyDelta(rows, now))
    // 今週 月〜水 = 65、先週 月〜水 = 60 → +5
    expect(weeklySummary(rows, now).delta).toBe(5)
  })

  it('先週の行が無ければ delta は null(回答数・学習日数は出す)', () => {
    const thisWeekOnly = rows.filter((r) => r.day >= '2026-08-17')
    const summary = weeklySummary(thisWeekOnly, now)
    expect(summary.delta).toBeNull()
    expect(summary.answers).toBe(70)
  })

  it('今週の行が 1 件も無ければ 0 / 0(意味のある 0)', () => {
    const summary = weeklySummary(
      rows.filter((r) => r.day < '2026-08-17'),
      now,
    )
    expect(summary.answers).toBe(0)
    expect(summary.studyDays).toBe(0)
  })
})
