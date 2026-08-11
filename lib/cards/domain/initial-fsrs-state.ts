// 新規 card の初期 FSRS 状態 + 学習統計 default の 1 定義化 (FSRS 整合 Sprint A Task 2,
// spec §7)。 ts-fsrs の createEmptyCard() と値が一致することは test 側 (このモジュール
// の隣の *.test.ts) で pin する — 本体は ts-fsrs を import しない (client bundle に
// ts-fsrs を含めないため、値をここに直接書く)。
//
// 生成点 (build-new-client-card / apply-card-mutation / saveExtractedCards) の
// 差し替えは Task 3 の担当 — 本 module は追加のみで、既存呼び出し元は未変更。

export function initialFsrsState(now: Date): {
  due: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  reps: number
  lapses: number
  state: 0
  learningSteps: number
  lastReview: null
  answered: false
  lastCorrect: null
  currentStreak: 0
} {
  return {
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
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
  }
}
