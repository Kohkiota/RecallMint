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
import { buildNewCardMutationPatch } from '@/lib/cards/card-write'
import { sortLikeServer } from '@/lib/cards/sort-like-server'
import { runOptimisticCreate } from '@/lib/sync/optimistic-mutation'
import { newId } from '@/lib/sync/entity-mutations'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { InlineTextField } from './inline-text-field'
import { DeleteCardButton } from './delete-card-button'
import { CardEditorFields } from './card-editor-fields'

// sortLikeServer は @/lib/cards/sort-like-server に抽出済 (S2.3 T3)。 既存 importer
// (exam-card-table-columns / exam-card-table) の `from './inline-card-list'` 互換のため re-export。
export { sortLikeServer }

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
// export: ExamCardTable (案 H-1) から再利用するため export を追加 (internal logic 不変)。
export function toExamDetailCard(c: ClientCard): ExamDetailCard {
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
  //
  // T-B5 (Y-2 Sub-plan B、 2026-06-14): card_tags は全 scan から page subset に絞り込む。
  // 旧: `db.card_tags.toArray()` を Promise.all で並列 fetch (= IDB 全 card_tags scan、
  // 他 exam の card_tags も無駄に読む)。
  // 新: filteredCards 確定後に `where('card_id').anyOf(pageCardIds)` で当該 exam の
  // card 集合のみに絞る (= card_id index 経由 seek、 他 exam 行を skip)。 pageCardIds
  // 依存のため Promise.all 並列は cards/categories/options の 3 store のみとし、 card_tags
  // は filteredCards 確定後の後段直列 fetch。 Grid-1 (テーブル化) で正規化予定の暫定形。
  // 観測可能挙動 (描画 pill 集合 / 件数表示) は不変: tagsByCardId.get(card.id) の key 集合は
  // 必ず pageCardIds の subset (`cards = filteredCards.map(...)` 由来) であり、 全 scan で
  // 入っていた他 exam の card_id entries はそもそも .get() で参照されない死蔵 entries だった。
  // tag_categories / tag_options の全 scan、 subscription 分離、 regroup の memoize、 仮想化
  // は本 task scope 外 (T-B5b 別 task)。 memoize は本 task で不採用 (audit 原文に語なし +
  // fetch memoize は card_tags 変化を取りこぼし stale bug 源、 step0 再調査 §2c)。
  const liveData = useLiveQuery(async () => {
    const db = getClientDb()
    const [cardRows, categories, options] = await Promise.all([
      db.cards.where('exam_id').equals(examId).toArray(),
      db.tag_categories.toArray(),
      db.tag_options.toArray(),
    ])
    const filteredCards = cardRows
      .filter((c) => c.user_id === userId)
      .sort(sortLikeServer)
    const cards = filteredCards.map(toExamDetailCard)
    // T-B5: card_tags は filteredCards の card_id 集合だけに絞って fetch (anyOf 経由)。
    // 空 page (= cards 0 件) は短絡で IDB query を発火しない。
    const pageCardIds = filteredCards.map((c) => c.id)
    const cardTags =
      pageCardIds.length === 0
        ? []
        : await db.card_tags.where('card_id').anyOf(pageCardIds).toArray()
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
  // 追加直後に採番した client id 集合。 mirror insert + useLiveQuery 再描画で該当 card の
  // 問題文 cell に autoEditOnMount を当て、 自動で編集モードにするための marker。
  // client 採番のため server round-trip なしで即時に edit mode へ入れる
  // (card の主体が問題文のため question_text cell のみに適用、 spec §3.5)。
  //
  // **複数 pending id の追跡基盤** (`useState<Set<string>>`)。
  //
  // 経緯: T1a smoke #4 で「2 連続 click で 1 枚目の auto-edit が失われる」 挙動を
  // race と切り分け、 fix #1 (fa4aa7b sync 採番) + fix #2 (本 Set 化) を試行したが
  // いずれも実環境で FAIL。 OT 実機検証 (1 枚目 textarea focus 状態で 2 秒以上待ち
  // → 「+ カードを追加」 click → 1 枚目 display 復帰 + 新カード focus) で**タイミング
  // 無関係 = race ではなく blur-commit による構造的挙動**と決着、 「2 連続で両方
  // auto-edit」 仕様自体を撤回 (実挙動 = 前の編集が確定して閉じ、 新カードに focus
  // 移行 = UX として正しい)。 詳細経緯は plan T1b 「T1a 引継ぎ既知 issue」 参照。
  //
  // Set 化は revert せず維持: (1) 将来仮想化 (Grid-1 TanStack Virtual) で cell 再
  // mount が起きる経路の基盤、 (2) click 以外の経路 (keyboard shortcut で連続 add、
  // batch import で複数 card 同時 mount 等) で複数 pending id を保持する必要が
  // 生じた場合の汎用基盤として残す。 consume (Set 縮小) は持たない (下のコメント参照)。
  const [newCardIds, setNewCardIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  // 設計判断: 「mount 済 marker を Set から削除する consume 経路」 は意図的に持たない。
  // 子 cell の `autoEditOnMount` は **mount 時の値** で判定 (one-shot useState 初期化子)
  // のため、 Set に id が残り続けても既に mount 済 cell の挙動には影響しない。
  // useEffect + setState の consume 実装は `react-hooks/set-state-in-effect` warning に
  // 抵触し、 render-phase sentinel pattern も unmount race / over-trigger を抱える。
  // 本 component 寿命は exam 詳細 page 滞在中のみで、 Set サイズは「滞在中の add 回数」
  // (現実的に 10s 程度) で頭打ち、 各 `has()` も O(1) のため、 ためたままで bound する
  // 方が単純で堅い。 失敗 add (catch 経路) の id も 残置でかまわない (mirror に row が
  // 無いため描画に出てこない)。
  //
  // **成立条件 (重要、 将来の仮想化導入時に注意)**: consume 省略は「本 component 滞在中
  // に cell `<li key={card.id}>` が unmount/remount されないこと」 に依存する。 現状は
  // 直下 `<ul>` の stable key (= `card.id`) で React reconcile = order 変更でも cell は
  // move のみで unmount しないため成立。 **将来 Grid-1 で TanStack Virtual / react-virtual
  // 等の仮想化を導入する場合、 scroll で cell が unmount/remount され、 Set 残置 id を
  // 持つ cell が再 mount で `autoEditOnMount=true` 経路に再突入し、 誤 auto-edit
  // (編集モード強制突入) が発火する**。 仮想化導入と同時に consume (mount 後の Set
  // 縮小、 sentinel pattern、 useEffect + functional updater 等) を復活させること。

  // local-first 追加: helper (`runOptimisticCreate`) 経由で id 採番 + mirror insert +
  // outbox enqueue (op='create') を 1 Dexie rw tx に閉じ、 enqueue throw で Dexie auto-
  // rollback により mirror / outbox の lost write を構造的に排除する。 即時 drain は helper 内蔵。
  // 採番基準は現在の live cards (この exam の sort_key と件数)。
  // card_count は exam list / 詳細 header いずれも mirror の card 行数で算出するため、
  // mirror への insert がそのまま件数表示に反映される (exam.card_count は別 bump しない。
  // 真の確定値は server 適用後の pull-back で収束)。
  const handleAddCard = async () => {
    setError(null)
    const empty = buildEmptyCard(
      cards.map((c) => c.sortKey),
      cards.length,
    )

    // id は helper await の前に sync で採番し、 `setNewCardIds(prev => add)` を同期的に
    // 発火させる。 fa4aa7b で導入した sync 採番 → 先発火は維持しつつ、 Set + functional
    // updater で複数 pending id を蓄積する: updater chain `prev → {id1} → {id1, id2}` で
    // 両 id を追跡、 useLiveQuery 再評価後の cell mount 時に `newCardIds.has(id)` が
    // true となり、 autoEditOnMount (one-shot useState 初期化子) が発火する。
    // 実ブラウザでは button click による blur-commit で 1 枚目の編集状態は確定して
    // 閉じ、 新カードのみが focus する (= 仕様、 詳細は上の Set 化コメント参照)。
    // helper には id 引数で渡し、 helper 内 newId() の二重採番は起きない。
    const cardId = newId()
    setNewCardIds((prev) => {
      const next = new Set(prev)
      next.add(cardId)
      return next
    })

    try {
      await runOptimisticCreate({
        userId,
        id: cardId,
        mirrorStore: getClientDb().cards,
        buildRow: (newCardId, now) =>
          buildNewClientCard({ cardId: newCardId, userId, examId, empty, now }),
        // outbox enqueue: snake_case create patch + camelCase options への写像は
        // lib/cards/card-write.ts (buildNewCardMutationPatch) に移送済 (P3 W3)。
        // server は options の is_correct から correct_answer_ids を再生成するため含めない。
        buildMutation: (newCardId) => ({
          entity_type: 'card',
          entity_id: newCardId,
          op: 'create',
          patch: buildNewCardMutationPatch({ examId, empty }),
        }),
        logEvent: 'card_inline.add.tx_failed',
        logContext: { examId, cardId },
        // user-initiated create は failure を UI で通知する (= delete-card-button と同 pattern)。
        // helper 既定 silent (案 a 取り直し) のままだと「追加ボタンを押したが何も起きない」
        // 経験になり、 prior 動作からの UX regression を招く (Sync-fix-1 T1a canonical review
        // Important #1)。 throwOnError: true で enqueue throw + userId='' fail-fast の双方を
        // caller の catch に流し、 既存 error UI ('カードの追加に失敗しました。') を維持する。
        throwOnError: true,
      })
    } catch {
      // helper が rethrow した場合のみ到達 (enqueue throw → Dexie auto-rollback 済、 もしくは
      // userId='' fail-fast)。 mirror は rollback 済 + outbox 未反映、 案 a 取り直し前提で
      // 次回 pull が server 値で reconcile。 user 通知のため inline error UI を表示する。
      // 注: setNewCardIds は既に発火済 (sync 採番経路) だが、 mirror に該当 row が存在しない
      // ため autoEditOnMount は描画上 no-op となる (該当 cell が render されない)。
      // 失敗した id を Set から削除する bookkeeping は行わない: helper の catch 経路は
      // Dexie auto-rollback 済で mirror に row が存在せず、 cell が render されないため
      // `newCardIds.has(failed_id)` は呼ばれない (= 実害なし、 delete の手間を省く)。
      // 集合は max でも 1 view 中の add 回数分しか溜まらないため leak にもならない。
      setError('カードの追加に失敗しました。')
    }
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

              {/* タグ + 問題文 + 選択肢 + 解説 + メモ の後段フィールド列は side-peek と
                  共有 (P3 W4)。categories / options は上で useMemo 安定化済み、cardTags は
                  本 card 分だけを Map から取り出して透過するため React.memo(CardTagsSection)
                  の凍結は維持される。autoEditOnMount は新規 card の問題文 auto-edit marker。 */}
              <CardEditorFields
                cardId={card.id}
                userId={userId}
                categories={categories}
                tagOptions={options}
                cardTags={tagsByCardId.get(card.id) ?? []}
                questionText={card.questionText}
                options={card.options}
                explanationText={card.explanationText}
                memo={card.memo}
                autoEditOnMount={newCardIds.has(card.id)}
              />
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
