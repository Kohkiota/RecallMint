// replayCard — DB 非依存の純粋 FSRS fold 関数。
// 複数の event を in-memory で順次 apply し、最終 card state を返す。
// 呼び出し元 (ingest の foldSession) が fold 後の結果を bulk SQL で一括書き込みする
// ためのコア計算を担当する。

import type { Card as FsrsCard } from 'ts-fsrs'
import { rate, type RatingInt } from '@/lib/fsrs'

// -----------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------

/** cards 行のうち FSRS fold に必要なフィールド (camelCase = DB 側命名規則)。 */
export interface ReplayCardState {
  due: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  reps: number
  lapses: number
  state: 0 | 1 | 2 | 3
  learningSteps: number
  lastReview: Date | null
  answered: boolean
  lastCorrect: boolean | null
  currentStreak: number
}

export interface ReplayEvent {
  /** scheduling の正誤定義 (ts-fsrs rate に渡す)。 */
  rating: RatingInt
  /** 統計・フィルタの正誤定義 (last_correct / current_streak の唯一の源・spec §6)。 */
  isCorrect: boolean
  answeredAt: Date
}

// -----------------------------------------------------------------------
// Pure fold
// -----------------------------------------------------------------------

/**
 * events を呼び出し元が確定した順 (answered_at 昇順) で initial state に fold する。
 * events が空の場合は initial のコピーを返す (no-op)。
 * initial は mutate しない。
 */
export function replayCard(
  initial: ReplayCardState,
  events: ReplayEvent[],
): ReplayCardState {
  // working copy (initial を mutate しないため spread でコピー)
  let current: ReplayCardState = { ...initial }

  for (const event of events) {
    const { rating, isCorrect, answeredAt: now } = event

    // DB row (camelCase) → ts-fsrs Card (snake_case) に変換して rate() を呼ぶ。
    const fsrsCard: FsrsCard = {
      due: current.due,
      stability: current.stability,
      difficulty: current.difficulty,
      // ts-fsrs Card.elapsed_days は v6.0.0 で削除予定 (@deprecated)。
      // v5 では代替フィールドが未公開のため引き続き使用する。
      elapsed_days: current.elapsedDays,
      scheduled_days: current.scheduledDays,
      learning_steps: current.learningSteps,
      reps: current.reps,
      lapses: current.lapses,
      state: current.state,
      last_review: current.lastReview ?? undefined,
    }

    const next = rate(fsrsCard, rating, now).card

    current = {
      due: next.due,
      stability: next.stability,
      difficulty: next.difficulty,
      elapsedDays: next.elapsed_days,
      scheduledDays: next.scheduled_days,
      learningSteps: next.learning_steps,
      reps: next.reps,
      lapses: next.lapses,
      state: next.state as 0 | 1 | 2 | 3,
      lastReview: next.last_review ?? now,
      answered: true,
      lastCorrect: isCorrect,
      currentStreak: isCorrect ? current.currentStreak + 1 : 0,
    }
  }

  return current
}
