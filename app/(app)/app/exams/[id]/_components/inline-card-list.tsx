'use client'

// 試験詳細 page (/app/exams/[id]) の cards 一覧 + 各 card の inline 編集 UI。
// sort_key / title / question_text / explanation_text / memo の 5 text field と
// 各 option の id / text / is_correct / explanation 4 field を全て inline 編集
// できる (T4)。 「編集」 ボタン / 別 page 遷移は廃止。

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import Link from 'next/link'
import type { ExamDetailCard } from '@/lib/exams/list'
import type { CardOption } from '@/lib/db/schema'
import {
  getClientDb,
  type ClientCard,
  type ClientCardTag,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { buildEmptyCard } from '@/lib/cards/empty-card'
import { buildNewClientCard } from '@/lib/cards/build-new-client-card'
import { newId, enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { logger } from '@/lib/logger'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { InlineTextField } from './inline-text-field'
import { InlineOptionList } from './inline-option-row'
import { DeleteCardButton } from './delete-card-button'
import { CardTagsSection } from './card-tags-section'

type InlineCardListProps = {
  // SSR / Dexie mirror 未 hydrate の初期 (useLiveQuery が undefined) 期間のみ使う
  // server fetch 由来の初期値。 live query が一度でも解決したら (空配列でも) Dexie
  // mirror を単一の真実とする。 「mirror 0 件なら server fallback」 はしない (Task
  // 4.3 で local delete-all した card が server copy で復活するのを防ぐため)。
  initialCards: ExamDetailCard[]
  // route の [id] (試験 id)。 末尾「+ カードを追加」 の mirror insert / outbox patch に渡す。
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
  // 表示の真実は Dexie cards mirror の直読み (exam 単位 + owner-scope + server sort)。
  // 詳細滞在中のみ購読 (component unmount で dexie-react-hooks が解除)。 deps が変化
  // するまで同一 subscription。
  //
  // Tag-4b Task 3: cards に加えて tag_categories / tag_options / card_tags の 3 store
  // も同 subscription で一括 pull する。 4 store を 1 つの useLiveQuery にまとめることで、
  // タグ side の mirror 更新 (pull / mutation の楽観反映) 時に同 tick で再描画され、
  // 「cards が live で更新されたが tag pill だけ stale」 のような ordering 問題を避ける。
  // deps は `[examId, userId]` のまま (4 store の購読は dexie-react-hooks が自動検出)。
  const liveData = useLiveQuery(async () => {
    const db = getClientDb()
    const [cardRows, categories, options, cardTags] = await Promise.all([
      db.cards.where('exam_id').equals(examId).toArray(),
      db.tag_categories.toArray(),
      db.tag_options.toArray(),
      db.card_tags.toArray(),
    ])
    const filteredCards = cardRows
      .filter((c) => c.user_id === userId)
      .sort(sortLikeServer)
    const cards = filteredCards.map(toExamDetailCard)
    // card_id 別にグループ化。 各 card row 描画時は `.get(cardId) ?? []` で取り出す。
    const tagsByCardId = new Map<string, ClientCardTag[]>()
    for (const t of cardTags) {
      const arr = tagsByCardId.get(t.card_id) ?? []
      arr.push(t)
      tagsByCardId.set(t.card_id, arr)
    }
    return { cards, categories, options, tagsByCardId }
  }, [examId, userId])

  // live query 未解決 (undefined) の間だけ server 由来の initialCards で bootstrap。
  // 解決後 (空配列含む) は mirror を信頼。 二層 state は持たない。
  const cards = liveData?.cards ?? initialCards
  // categories / options は useMemo で同 ref 安定化。 useLiveQuery 戻り値は毎 tick で
  // 新 ref のため、 子 CardTagsSection を React.memo しても素のままでは毎回 prop ref が
  // 変わり memo が無効化される。 同じ deps (= 同 ref) のときは同 ref を返すよう wrap。
  // 過度な追い込み (deep equal / hash) は plan 警告通り入れない。
  const categories = useMemo<ClientTagCategory[]>(
    () => liveData?.categories ?? [],
    [liveData?.categories],
  )
  const options = useMemo<ClientTagOption[]>(
    () => liveData?.options ?? [],
    [liveData?.options],
  )
  // tagsByCardId は Map (毎回新 ref) だが、 子側で `.get(cardId) ?? []` で配列を取り出し、
  // 配列 ref は cardTags 内容が同じなら useLiveQuery の内容ベース差分検知に依存して
  // 同 ref で返る前提。 子 memo は cardTags (= 取り出した配列) の ref で比較する。
  const tagsByCardId = liveData?.tagsByCardId ?? new Map<string, ClientCardTag[]>()
  // 追加直後に採番した client id。 mirror insert + useLiveQuery 再描画で該当 card の
  // 問題文 cell に autoEditOnMount を当て、 自動で編集モードにするための marker。
  // client 採番のため server round-trip なしで即時に edit mode へ入れる
  // (card の主体が問題文のため question_text cell のみに適用、 spec §3.5)。
  const [newCardId, setNewCardId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // local-first 追加: client id を即時採番し、 mirror insert (楽観反映) +
  // outbox enqueue (op='create') + 即時 drain。 server action 直叩き / refresh は廃止。
  // card_count は exam list / 詳細 header いずれも mirror の card 行数で算出するため、
  // mirror への insert がそのまま件数表示に反映される (exam.card_count は別 bump しない。
  // 真の確定値は server 適用後の pull-back で収束)。
  const handleAddCard = () => {
    setError(null)
    const cardId = newId()
    const now = new Date().toISOString()
    // 採番基準は現在の live cards (この exam の sort_key と件数)。
    const empty = buildEmptyCard(
      cards.map((c) => c.sortKey),
      cards.length,
    )
    const card = buildNewClientCard({ cardId, userId, examId, empty, now })

    // 新 card cell が mirror insert 由来の useLiveQuery 再 render で mount する前に
    // newCardId を確定させる。 autoEditOnMount は one-shot の useState 初期化子のため、
    // cell mount 時に newCardId が未確定 (null) だと display 固定になり auto-edit が
    // 起動しない (Stage 4 smoke で実機 IndexedDB の競合として発覚)。 client 採番で id は
    // 手元にあり server round-trip 不要なので、 mirror insert / enqueue より前に set する。
    setNewCardId(cardId)

    void (async () => {
      try {
        await getClientDb().cards.add(card)
      } catch (err) {
        logger.warn({
          event: 'card_inline.create_mirror_insert_failed',
          cardId,
          examId,
          err: String(err),
        })
        setError('カードの追加に失敗しました。')
        return
      }

      // outbox enqueue (snake_case patch + camelCase options)。 server は options の
      // is_correct から correct_answer_ids を再生成するため patch に含めない。
      await enqueueEntityMutation({
        entity_type: 'card',
        entity_id: cardId,
        op: 'create',
        patch: {
          exam_id: examId,
          title: empty.title,
          sort_key: empty.sortKey,
          question_text: empty.questionText,
          options: empty.options.map((o) => ({
            id: o.id,
            text: o.text,
            isCorrect: o.is_correct,
            ...(o.explanation ? { explanation: o.explanation } : {}),
          })),
          explanation_text: null,
          memo: null,
        },
      }).catch((err) => {
        logger.warn({
          event: 'card_inline.create_enqueue_failed',
          cardId,
          examId,
          err: String(err),
        })
      })

      // 即時 drain で create を sync し、 pull-back で card_count を確定収束させる。
      void runGuardedEntityMutationFlush().catch(() => {})
    })()
  }

  return (
    <div className="space-y-3 md:space-y-2">
      {/* 見出し件数は live `cards` (リスト本体と同一の useLiveQuery 配列) の length。
          追加/削除直後も即時整合する (旧 SSR cards.length 由来の stale を解消、論点B)。
          同一配列を数えるため double-count は構造的に発生しない (論点C: card_count
          楽観更新は持たず cards mirror 計数に一本化)。 */}
      <h2 className="text-lg font-bold">カード ({cards.length} 件)</h2>
      {cards.length === 0 && (
        <Card>
          <CardContent className="p-6 md:p-4 text-center">
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
            <CardContent className="p-4 space-y-3 md:p-2 md:space-y-1.5">
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
                {/* Tag-4b Task 3: title 行直下に「タグ」 section を配置。 categories /
                    options は親で useMemo 安定化、 cardTags は本 card 分だけを Map から
                    取り出して渡すため、 他 card にタグを付けても本 card の section は
                    React.memo (CardTagsSection) で再描画 skip される。 */}
                <CardTagsSection
                  cardId={card.id}
                  categories={categories}
                  options={options}
                  cardTags={tagsByCardId.get(card.id) ?? []}
                />
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

      {/* 末尾「+ カードを追加」: client id 採番 + mirror insert + outbox enqueue で
          placeholder card を即時追加し、 新 card の問題文 cell を auto-edit する。
          mirror insert は同期的に反映されるため pending 表示は不要 (即時完了)。
          inline-option-row の「+ 選択肢を追加」と同じ dashed border スタイルに合わせる。 */}
      <div>
        <button
          type="button"
          onClick={handleAddCard}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          ＋ カードを追加
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
