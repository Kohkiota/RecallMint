'use client'

// 試験詳細 page (/app/exams/[id]) の cards 一覧 + 各 card の inline 編集 UI。
// sort_key / title / question_text / explanation_text / memo の 5 text field と
// 各 option の id / text / is_correct / explanation 4 field を全て inline 編集
// できる (T4)。 「編集」 ボタン / 別 page 遷移は廃止。

import type { ExamDetailCard } from '@/lib/exams/list'
import { Card, CardContent } from '@/components/ui/card'
import { InlineTextField } from './inline-text-field'
import { InlineOptionList } from './inline-option-row'

type InlineCardListProps = {
  cards: ExamDetailCard[]
}

export function InlineCardList({ cards }: InlineCardListProps) {
  return (
    <ul className="space-y-2">
      {cards.map((card) => (
        <li key={card.id}>
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-28 shrink-0">
                  <InlineTextField
                    cardId={card.id}
                    field="sort_key"
                    initialValue={card.sortKey}
                    ariaLabel="ソートキー 編集"
                    placeholder="(キー)"
                    displayClassName="text-xs font-mono text-slate-600"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <InlineTextField
                    cardId={card.id}
                    field="title"
                    initialValue={card.title}
                    ariaLabel="タイトル 編集"
                    displayClassName="text-sm font-medium text-slate-900"
                  />
                </div>
              </div>

              <div>
                <p className="text-xs font-medium text-slate-500">問題文</p>
                <InlineTextField
                  cardId={card.id}
                  field="question_text"
                  initialValue={card.questionText}
                  ariaLabel="問題文 編集"
                  multiline
                  displayClassName="text-sm text-slate-800"
                />
              </div>

              <div>
                <p className="text-xs font-medium text-slate-500">
                  選択肢 ({card.options.length} 件)
                </p>
                {/* per-card 親 InlineOptionList で options 共有 state を管理。
                    cross-row checkbox race を構造的に解消 (S2.0b-2 follow-up fix)。 */}
                <InlineOptionList cardId={card.id} options={card.options} />
              </div>

              <div>
                <p className="text-xs font-medium text-slate-500">解説</p>
                <InlineTextField
                  cardId={card.id}
                  field="explanation_text"
                  initialValue={card.explanationText}
                  ariaLabel="解説 編集"
                  multiline
                  placeholder="解説 (クリックで追加)"
                  displayClassName="text-sm text-slate-700"
                />
              </div>

              <div>
                <p className="text-xs font-medium text-slate-500">メモ</p>
                <InlineTextField
                  cardId={card.id}
                  field="memo"
                  initialValue={card.memo}
                  ariaLabel="メモ 編集"
                  multiline
                  placeholder="メモ (クリックで追加)"
                  displayClassName="text-sm text-slate-700"
                />
              </div>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}
