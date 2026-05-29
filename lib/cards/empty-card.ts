// 手動 card 作成時の placeholder 値を生成する純粋関数。
// create form の初期値として、 edit validation に通る値を返す。
//
// 返り値は card の notNull 列のうち、 userId / examId を除いた部分。
// 呼び出し元 action で userId / examId を付加して DB INSERT する。

import { nextCardSortKey } from './next-card-sort-key'
import { nextCardTitle } from './next-card-title'
import type { CardOption } from '@/lib/db/schema'

export interface EmptyCard {
  title: string
  sortKey: string
  questionText: string
  options: CardOption[]
  correctAnswerIds: string[]
}

export function buildEmptyCard(
  existingSortKeys: (string | null)[],
  existingCount: number,
): EmptyCard {
  return {
    title: nextCardTitle(existingCount),
    sortKey: nextCardSortKey(existingSortKeys),
    questionText: '(問題文を入力してください)',
    options: [
      {
        id: '1',
        text: '(選択肢1)',
        is_correct: false,
      },
    ],
    correctAnswerIds: [],
  }
}
