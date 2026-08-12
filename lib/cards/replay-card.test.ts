// replayCard の invariant テスト。
// @/lib/fsrs は mock しない — 実 ts-fsrs rate() を使って累積 FSRS state を保証する。
// 正誤の 2 本立て (spec §6): scheduling = rating / 統計 (lastCorrect・currentStreak) =
// isCorrect。両者が独立に効くことを本 file で pin する。

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

/** rating と isCorrect を連動させた既定形 (Again(1) のみ不正解)。 */
function makeEvents(ratings: RatingInt[], startIso = '2026-05-28T10:00:00Z'): ReplayEvent[] {
  const base = new Date(startIso).getTime()
  return ratings.map((rating, i) => ({
    rating,
    isCorrect: rating >= 2,
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

    const final = replayCard(initial, events)

    // reps が apply 数分増加 (ts-fsrs は rating 問わず reps++ する)
    expect(final.reps - initial.reps).toBe(3)

    // streak が monotonic 増加 0→1→2→3: 中間確認は incremental replayCard で
    const after1 = replayCard(initial, [events[0]])
    const after2 = replayCard(initial, [events[0], events[1]])
    expect(after1.currentStreak).toBe(1)
    expect(after2.currentStreak).toBe(2)
    expect(final.currentStreak).toBe(3)

    // 最後の due が最終 answeredAt より将来
    expect(final.due.getTime()).toBeGreaterThan(lastAnsweredAt.getTime())

    // lastReview は最後に適用した event の answeredAt
    expect(final.lastReview).toEqual(lastAnsweredAt)

    // answered / lastCorrect フラグ
    expect(final.answered).toBe(true)
    expect(final.lastCorrect).toBe(true)
  })
})

// -----------------------------------------------------------------------
// Case B: incorrect 混在 — Good(3) → Again(1) → Good(3)
// -----------------------------------------------------------------------
describe('replayCard: ケース B (incorrect 混在, ratings [3,1,3])', () => {
  it('isCorrect=false で streak が 0 にリセットされ、その後の correct で streak が 1 になる', () => {
    const initial = makeInitialState()
    const events = makeEvents([3, 1, 3])

    // incremental で中間 streak を確認する
    const afterGood1 = replayCard(initial, [events[0]])
    const afterAgain = replayCard(initial, [events[0], events[1]])
    const afterGood2 = replayCard(initial, events)

    expect(afterGood1.currentStreak).toBe(1) // correct → streak 1
    expect(afterAgain.currentStreak).toBe(0) // incorrect → streak reset 0
    expect(afterGood2.currentStreak).toBe(1) // correct → streak 1

    // reps は incorrect でも increment する
    expect(afterGood2.reps - initial.reps).toBe(3)

    // 最後の event が correct → lastCorrect = true
    expect(afterGood2.lastCorrect).toBe(true)
  })
})

// -----------------------------------------------------------------------
// Case B2: 正誤 2 本立て — 統計は isCorrect のみを見る (rating とは独立)
// -----------------------------------------------------------------------
describe('replayCard: 統計列は isCorrect が決める (rating と乖離しても従う)', () => {
  it('rating=3 (Good) でも isCorrect=false なら lastCorrect=false / streak リセット', () => {
    const initial = makeInitialState({ currentStreak: 5, lastCorrect: true, answered: true })
    const at = new Date('2026-05-28T10:00:00Z')

    const final = replayCard(initial, [{ rating: 3, isCorrect: false, answeredAt: at }])

    expect(final.lastCorrect).toBe(false)
    expect(final.currentStreak).toBe(0)
    // scheduling は rating=3 のまま前進する (Again ではないので lapses は増えない)
    expect(final.lapses).toBe(initial.lapses)
  })

  it('rating=1 (Again) でも isCorrect=true なら lastCorrect=true / streak 継続', () => {
    const initial = makeInitialState({ currentStreak: 5, lastCorrect: true, answered: true })
    const at = new Date('2026-05-28T10:00:00Z')

    const final = replayCard(initial, [{ rating: 1, isCorrect: true, answeredAt: at }])

    expect(final.lastCorrect).toBe(true)
    expect(final.currentStreak).toBe(6)
  })
})

// -----------------------------------------------------------------------
// Case C: empty events (no-op)
// -----------------------------------------------------------------------
describe('replayCard: ケース C (events 空)', () => {
  it('events が空の場合 final は initial と同値で、initial を変更しない', () => {
    const initial = makeInitialState()
    const snapshot = { ...initial } // 変更前スナップショット

    const final = replayCard(initial, [])

    // no-op: final は initial と深く等しい
    expect(final).toEqual(snapshot)

    // initial オブジェクトを mutate していない
    expect(initial).toEqual(snapshot)
  })

  it('final は initial とは別のオブジェクト参照 (non-mutation guard)', () => {
    const initial = makeInitialState()
    expect(replayCard(initial, [])).not.toBe(initial)
  })
})
