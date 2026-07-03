// card-filter-labels — フィルタ UI で使うラベル定数。
// filter-bar / condition-bar / S1-3 editors が共通 import する純粋定数ファイル。
// S1-2 で exam-card-table-filter-bar.tsx から移設。

import type { AnswerStateFilter, StreakFilterOp } from './card-filter-predicates'

export const ANSWER_STATE_LABELS: Record<AnswerStateFilter, string> = {
  all: 'すべて',
  unanswered: '未回答',
  correct: '直近正解',
  incorrect: '直近不正解',
}

export const STREAK_OP_LABELS: Record<StreakFilterOp, string> = {
  lte: '≤',
  gte: '≥',
  eq: '=',
}
