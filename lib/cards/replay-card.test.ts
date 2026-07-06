// replayCard の invariant テスト。
// @/lib/fsrs は mock しない — 実 ts-fsrs rate() を使って累積 FSRS state を保証する。
// app/api/review-events/bulk/route.test.ts の同等検証を純関数版で再現し、
// DB 結合なしに fold の正しさを回帰 guard とする。

import { describe, it, expect } from 'vitest'
import type { RatingInt } from '@/lib/fsrs'
import { replayCard, type ReplayCardState, type ReplayEvent } from './replay-card'

// -----------------------------------------------------------------------
// テストヘルパー
// -----------------------------------------------------------------------

/** 新規 card 相当の初期 ReplayCardState を生成する。 */
function makeInitialState(overrides: Partial<ReplayCardState> = {}): ReplayCardState {
  return {
    due: new Date('2026-05-28T00:00:00Z'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    ...overrides,
  }
}

function makeEvents(ratings: RatingInt[], startIso = '2026-05-28T10:00:00Z'): ReplayEvent[] {
  const base = new Date(startIso).getTime()
  return ratings.map((rating, i) => ({
    rating,
    answeredAt: new Date(base + i * 60_000), // 1分間隔
  }))
}

// -----------------------------------------------------------------------
// Case A: 全 correct — Hard(2) → Good(3) → Easy(4)
// -----------------------------------------------------------------------
describe('replayCard: ケース A (全 correct, ratings [2,3,4])', () => {
  it('reps が apply 数分 increment し、streak が連続 correct で増加し、due が最後の answeredAt より将来になる', () => {
    const initial = makeInitialState()
    const events = makeEvents([2, 3, 4])
    const lastAnsweredAt = events[events.length - 1].answeredAt

    const { final, reviews } = replayCard(initial, events)

    // reviews の長さと順序
    expect(reviews).toHaveLength(3)
    expect(reviews.map((r) => r.rating)).toEqual([2, 3, 4])
    for (let i = 0; i < reviews.length; i++) {
      expect(reviews[i].reviewedAt).toEqual(events[i].answeredAt)
    }

    // reps が apply 数分増加 (ts-fsrs は rating 問わず reps++ する)
    expect(final.reps - initial.reps).toBe(3)

    // streak が monotonic 増加 0→1→2→3: 中間確認は incremental replayCard で
    const after1 = replayCard(initial, [events[0]]).final
    const after2 = replayCard(initial, [events[0], events[1]]).final
    const after3 = final
    expect(after1.currentStreak).toBe(1)
    expect(after2.currentStreak).toBe(2)
    expect(after3.currentStreak).toBe(3)

    // 最後の due が最終 answeredAt より将来
    expect(final.due.getTime()).toBeGreaterThan(lastAnsweredAt.getTime())

    // answered / lastCorrect フラグ
    expect(final.answered).toBe(true)
    expect(final.lastCorrect).toBe(true)
  })
})

// -----------------------------------------------------------------------
// Case B: incorrect 混在 — Good(3) → Again(1) → Good(3)
// -----------------------------------------------------------------------
describe('replayCard: ケース B (incorrect 混在, ratings [3,1,3])', () => {
  it('Again で streak が 0 にリセットされ、その後の correct で streak が 1 になる', () => {
    const initial = makeInitialState()
    const events = makeEvents([3, 1, 3])

    // incremental で中間 streak を確認する
    const afterGood1 = replayCard(initial, [events[0]]).final
    const afterAgain = replayCard(initial, [events[0], events[1]]).final
    const { final: afterGood2, reviews } = replayCard(initial, events)

    expect(afterGood1.currentStreak).toBe(1)  // Good → streak 1
    expect(afterAgain.currentStreak).toBe(0)  // Again → streak reset 0
    expect(afterGood2.currentStreak).toBe(1)  // Good → streak 1

    // reps は incorrect でも increment する
    expect(afterGood2.reps - initial.reps).toBe(3)

    // 最後の event が Good → lastCorrect = true
    expect(afterGood2.lastCorrect).toBe(true)

    // reviews の長さと順序
    expect(reviews).toHaveLength(3)
    expect(reviews.map((r) => r.rating)).toEqual([3, 1, 3])
  })
})

// -----------------------------------------------------------------------
// Case C: empty events (no-op)
// -----------------------------------------------------------------------
describe('replayCard: ケース C (events 空)', () => {
  it('events が空の場合 final は initial と同値で、initial を変更しない', () => {
    const initial = makeInitialState()
    const snapshot = { ...initial } // 変更前スナップショット

    const { final, reviews } = replayCard(initial, [])

    // no-op: final は initial と深く等しい
    expect(final).toEqual(snapshot)

    // reviews は空配列
    expect(reviews).toEqual([])

    // initial オブジェクトを mutate していない
    expect(initial).toEqual(snapshot)
  })

  it('final は initial とは別のオブジェクト参照 (non-mutation guard)', () => {
    const initial = makeInitialState()
    const { final } = replayCard(initial, [])
    expect(final).not.toBe(initial)
  })
})
