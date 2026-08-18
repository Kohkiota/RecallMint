import { describe, it, expect } from 'vitest'
// ts-fsrs はこの test file 内でのみ import する — pin 対象の一致検証のため
// (initial-fsrs-state.ts 本体は client bundle 回避のため ts-fsrs を import しない)。
import { createEmptyCard } from 'ts-fsrs'
import { initialFsrsState } from './initial-fsrs-state'

describe('initialFsrsState', () => {
  it('FSRS 状態 + card 学習統計 default を返す', () => {
    const now = new Date('2026-08-11T00:00:00Z')
    expect(initialFsrsState(now)).toEqual({
      due: now,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      learningSteps: 0,
      lastReview: null,
      firstReviewedAt: null,
      answered: false,
      lastCorrect: null,
      currentStreak: 0,
    })
  })

  it('due は注入した now をそのまま返す (呼び出しごとに現在時刻を取らない)', () => {
    const now = new Date('2020-01-01T00:00:00Z')
    expect(initialFsrsState(now).due).toEqual(now)
  })

  // server-only pin: ts-fsrs createEmptyCard() の FSRS 由来 field と全一致することを
  // 検証する (spec §7 — 初期 FSRS 値の 1 定義化)。 snake_case (ts-fsrs) → camelCase
  // (DB 列名) の対応で比較する。
  it('ts-fsrs createEmptyCard() と FSRS 由来 field が一致する', () => {
    const now = new Date('2026-08-11T00:00:00Z')
    const emptyCard = createEmptyCard(now)
    const ours = initialFsrsState(now)

    expect(ours.due).toEqual(emptyCard.due)
    expect(ours.stability).toBe(emptyCard.stability)
    expect(ours.difficulty).toBe(emptyCard.difficulty)
    expect(ours.elapsedDays).toBe(emptyCard.elapsed_days)
    expect(ours.scheduledDays).toBe(emptyCard.scheduled_days)
    expect(ours.reps).toBe(emptyCard.reps)
    expect(ours.lapses).toBe(emptyCard.lapses)
    expect(ours.state).toBe(emptyCard.state)
    expect(ours.learningSteps).toBe(emptyCard.learning_steps)
    // ts-fsrs は未設定を undefined で表す、こちらは null — どちらも「未実施」を表す
    // ので nullish 正規化した上で比較する。
    expect(ours.lastReview).toBe(emptyCard.last_review ?? null)
  })
})
