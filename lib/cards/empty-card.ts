// 手動 card 作成時の placeholder 値を生成する純粋関数。
// create form の初期値として、 edit validation に通る値を返す。
//
// 返り値は card の notNull 列のうち、 userId / examId を除いた部分。
// 呼び出し元 action で userId / examId を付加して DB INSERT する。

import { nextCardTitle } from './next-card-title'
import { nextBaseOrders } from './domain/card-order'
import { newId } from '@/lib/sync/entity-mutations'
import type { CardOption } from '@/lib/db/schema'

export interface EmptyCard {
  title: string
  questionLabel: null
  baseOrder: number
  questionText: string
  // Sprint I W5: 既定 option は uid を必ず持つ(write-path の uid required を満たす)。
  options: Array<CardOption & { uid: string }>
  correctAnswerIds: string[]
}

// existingBaseOrders は **対象 exam の全 card** の base_order(表示中のフィルタ後や
// ページング後の部分集合を渡してはならない — 末尾でない位置に採番されるため)。
export function buildEmptyCard(
  existingBaseOrders: number[],
  existingCount: number,
): EmptyCard {
  return {
    title: nextCardTitle(existingCount),
    // 番号ラベルは自動採番しない: 紙面番号を持たない手動カードに機械的な番号を
    // 付けると「紙面の番号」という列の意味が壊れる(spec 決定 5)。
    questionLabel: null,
    baseOrder: nextBaseOrders(
      existingBaseOrders.length === 0 ? null : Math.max(...existingBaseOrders),
      1,
    )[0]!,
    questionText: '(問題文を入力してください)',
    options: [
      {
        id: '1',
        // Sprint I W5: 生成地点 mint(全 option 生成経路が uid を振る)。
        uid: newId(),
        text: '(選択肢1)',
        is_correct: false,
      },
    ],
    correctAnswerIds: [],
  }
}
