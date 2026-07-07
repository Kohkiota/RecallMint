// custom-session-criteria — CustomSessionCriteria 型の定義 (type-only module)。
// Dexie 結合モジュール (get-custom-session-cards) から型を分離し、
// pure domain 関数が infra に型依存しないようにするための SSoT。

import type {
  TagFilterValue,
  AnswerStateFilter,
  StreakFilterValue,
} from '@/lib/cards/card-filter-predicates'

export type CustomSessionCriteria = {
  userId: string
  /** 絞り込む exam の id 集合。 空配列 = 全 exam (絞り込みなし)。 */
  examIds: string[]
  tagFilter: TagFilterValue
  answerState: AnswerStateFilter
  streakFilter: StreakFilterValue | null
  order: 'random' | 'sequential'
  /** null = 全件 (cap 無効)。 */
  limit: number | null
}
