// card-filter-labels — フィルタ UI で使うラベル定数。
// filter-bar / condition-bar / S1-3 editors が共通 import する純粋定数ファイル。
// S1-2 で exam-card-table-filter-bar.tsx から移設。

import type { AnswerStateFilter, StreakFilterOp, TextFilterOp } from '@/lib/cards/card-filter-predicates'

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

// S4-1: テキストフィルタ演算子ラベル (Notion 式 8 種)
export const TEXT_OP_LABELS: Record<TextFilterOp, string> = {
  eq: 'と一致',
  neq: 'と一致しない',
  contains: 'を含む',
  notContains: 'を含まない',
  startsWith: 'で始まる',
  endsWith: 'で終わる',
  empty: '未入力',
  notEmpty: '未入力ではない',
}

// S4-1: テキストフィルタ対象列 id 一覧 (S4-2 / S4-3 で共通参照)
export const TEXT_FILTER_COLUMN_IDS = [
  'title',
  'question_label',
  'question',
  'explanation_text',
  'memo',
] as const
