'use client'

// 試験詳細 page (/app/exams/[id]) の cards 一覧 + 各 card の inline 編集 UI。
// sort_key / title / question_text / explanation_text / memo の 5 text field と
// 各 option の id / text / is_correct / explanation 4 field を全て inline 編集
// できる (T4)。 「編集」 ボタン / 別 page 遷移は廃止。

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLiveQuery } from 'dexie-react-hooks'
import Link from 'next/link'
import type { ExamDetailCard } from '@/lib/exams/list'
import type { CardOption } from '@/lib/db/schema'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { InlineTextField } from './inline-text-field'
import { InlineOptionList } from './inline-option-row'
import { createCard } from '../_actions/create-card'
import { DeleteCardButton } from './delete-card-button'
import { runGuardedPull } from '@/lib/sync/pull'

type InlineCardListProps = {
  // SSR / Dexie mirror 未 hydrate の初期 (useLiveQuery が undefined) 期間のみ使う
  // server fetch 由来の初期値。 live query が一度でも解決したら (空配列でも) Dexie
  // mirror を単一の真実とする。 「mirror 0 件なら server fallback」 はしない (Task
  // 4.3 で local delete-all した card が server copy で復活するのを防ぐため)。
  initialCards: ExamDetailCard[]
  // route の [id] (試験 id)。 末尾「+ カードを追加」 で createCard に渡す。
  examId: string
  // owner-scope (全 read は WHERE user_id = ?)。 server page の auth() から受領。
  userId: string
}

// Dexie ClientCard (snake_case) → 子 inline 編集 component が消費する ExamDetailCard
// 形 (camelCase) へ写像。 options は ClientCardOption ≡ CardOption (id/text/is_correct/
// explanation?) のため as 経由でそのまま渡す。
function toExamDetailCard(c: ClientCard): ExamDetailCard {
  return {
    id: c.id,
    title: c.title,
    sortKey: c.sort_key ?? null,
    questionText: c.question_text,
    options: Array.isArray(c.options) ? (c.options as CardOption[]) : [],
    explanationText: c.explanation_text ?? null,
    memo: c.memo ?? null,
  }
}

// server (getCardsForExam) の `ORDER BY sort_key, created_at` を Dexie 配列上で再現。
// Postgres ASC は NULL を末尾に置くため、 sort_key 非 null を辞書順 ASC で先に、
// null は末尾、 同 key 内 (null 同士含む) は created_at ASC を tiebreak とする。
function sortLikeServer(a: ClientCard, b: ClientCard): number {
  const aKey = a.sort_key ?? null
  const bKey = b.sort_key ?? null
  if (aKey !== bKey) {
    if (aKey === null) return 1 // null は後ろ (NULLS LAST)
    if (bKey === null) return -1
    return aKey < bKey ? -1 : 1
  }
  // 同 sort_key (null 同士含む): created_at ASC
  if (a.created_at === b.created_at) return 0
  return a.created_at < b.created_at ? -1 : 1
}

export function InlineCardList({
  initialCards,
  examId,
  userId,
}: InlineCardListProps) {
  const router = useRouter()
  // 表示の真実は Dexie cards mirror の直読み (exam 単位 + owner-scope + server sort)。
  // 詳細滞在中のみ購読 (component unmount で dexie-react-hooks が解除)。 deps が変化
  // するまで同一 subscription。
  const liveCards = useLiveQuery(async () => {
    const db = getClientDb()
    const rows = await db.cards.where('exam_id').equals(examId).toArray()
    return rows
      .filter((c) => c.user_id === userId)
      .sort(sortLikeServer)
      .map(toExamDetailCard)
  }, [examId, userId])

  // live query 未解決 (undefined) の間だけ server 由来の initialCards で bootstrap。
  // 解決後 (空配列含む) は mirror を信頼。 二層 state は持たない。
  const cards = liveCards ?? initialCards
  const [isPending, startTransition] = useTransition()
  // createCard 成功直後に返る新 card id。 router.refresh() 後の再描画で、 該当 card の
  // 問題文 cell に autoEditOnMount を当てて自動で編集モードにするための marker。
  // (card の主体が問題文のため question_text cell のみに適用、 spec §3.5)
  const [newCardId, setNewCardId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleAddCard = () => {
    setError(null)
    startTransition(async () => {
      const result = await createCard(examId)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setNewCardId(result.data?.cardId ?? null)
      // server component を再実行して新 card を含む list を取得 (inline cell の
      // serverOptions 同期と同じ機構)。
      router.refresh()
      // 一覧が Dexie 参照のため、カード追加後に mirror を pull で最新化する。
      void runGuardedPull({ reason: 'card-add' }).catch(() => {})
    })
  }

  return (
    <div className="space-y-3">
      {cards.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-sm text-slate-700">この試験にはまだカードがありません。</p>
            <div className="mt-3">
              <Button asChild>
                <Link href="/app/upload" prefetch={false}>アップロードから追加</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
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
                <div className="shrink-0">
                  <DeleteCardButton cardId={card.id} />
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
                  autoEditOnMount={card.id === newCardId}
                />
              </div>

              <div>
                {/* per-card 親 InlineOptionList で options 共有 state を管理。
                    cross-row checkbox race を構造的に解消 (S2.0b-2 follow-up fix)。
                    S2.0b-3: 選択肢ヘッダ + 正解サマリ も InlineOptionList 内に
                    co-locate して **optimistic state 経由表示** に統一 (checkbox
                    toggle で UI と summary が同時に即時更新、 revalidate lag を解消)。 */}
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

      {/* 末尾「+ カードを追加」: createCard で placeholder card を作成し、 refresh 後に
          新 card の問題文 cell を auto-edit する。 inline-option-row の「+ 選択肢を追加」
          と同じ dashed border スタイルに合わせる。 */}
      <div>
        <button
          type="button"
          onClick={handleAddCard}
          disabled={isPending}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? '追加中…' : '＋ カードを追加'}
        </button>
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
