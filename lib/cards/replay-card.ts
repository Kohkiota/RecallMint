// replayCard — DB 非依存の純粋 FSRS fold 関数。
// 複数の rating event を in-memory で順次 apply し、最終 card state と
// reviews 配列を返す。呼び出し元 (bulk endpoint) が fold 後の結果を
// bulk SQL で一括書き込みするためのコア計算を担当する。
// submit-review-tx.ts の (2)→(3) ブロックを純関数として抽出したもの。

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
  rating: RatingInt
  answeredAt: Date
}

export interface ReplayCardResult {
  /** cards に書き戻す最終 state */
  final: ReplayCardState
  /** 各 event に対応する reviews 行 (apply 順 — payload 順を保持) */
  reviews: { rating: RatingInt; reviewedAt: Date }[]
}

// -----------------------------------------------------------------------
// Pure fold
// -----------------------------------------------------------------------

/**
 * events を payload 順 (呼び出し元保証) で initial state に fold する。
 * events が空の場合は initial のコピーを返す (no-op)。
 * initial は mutate しない。
 */
export function replayCard(
  initial: ReplayCardState,
  events: ReplayEvent[],
): ReplayCardResult {
  // no-op shortcut — initial を mutate せずコピーを返す
  if (events.length === 0) {
    return { final: { ...initial }, reviews: [] }
  }

  const reviews: { rating: RatingInt; reviewedAt: Date }[] = []

  // working copy (initial を mutate しないため spread でコピー)
  let current: ReplayCardState = { ...initial }

  for (const event of events) {
    const { rating, answeredAt: now } = event

    // DB row (camelCase) → ts-fsrs Card (snake_case) に変換して rate() を呼ぶ。
    // submit-review-tx.ts の変換ロジックと完全に同一にすること。
    const fsrsCard: FsrsCard = {
      due: current.due,
      stability: current.stability,
      difficulty: current.difficulty,
      // ts-fsrs Card.elapsed_days は v6.0.0 で削除予定 (@deprecated)。
      // v5 では代替フィールドが未公開のため引き続き使用し、lint を明示的に抑制する。
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      elapsed_days: current.elapsedDays,
      scheduled_days: current.scheduledDays,
      learning_steps: current.learningSteps,
      reps: current.reps,
      lapses: current.lapses,
      state: current.state,
      last_review: current.lastReview ?? undefined,
    }

    const result = rate(fsrsCard, rating, now)
    const next = result.card // 更新後の ts-fsrs Card state

    // correct 定義: Again(1) = 不正解、Hard/Good/Easy(2/3/4) = 正解
    const correct = rating >= 2

    // submit-review-tx.ts の UPDATE set と完全に同じフィールドを更新する
    current = {
      due: next.due,
      stability: next.stability,
      difficulty: next.difficulty,
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      elapsedDays: next.elapsed_days,
      scheduledDays: next.scheduled_days,
      learningSteps: next.learning_steps,
      reps: next.reps,
      lapses: next.lapses,
      state: next.state as 0 | 1 | 2 | 3,
      lastReview: next.last_review ?? now,
      answered: true,
      lastCorrect: correct,
      currentStreak: correct ? current.currentStreak + 1 : 0,
    }

    reviews.push({ rating, reviewedAt: now })
  }

  return { final: current, reviews }
}
