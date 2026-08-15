'use client'

// 試験詳細 page (/app/exams/[id]) の cards 一覧 + 各 card の inline 編集 UI。
// question_label / title / question_text / explanation_text / memo の 5 text field と
// 各 option の id / text / is_correct / explanation 4 field を全て inline 編集
// できる (T4)。 「編集」 ボタン / 別 page 遷移は廃止。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { ChevronUp } from 'lucide-react'
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
import { compareByBaseOrder } from '@/lib/cards/domain/card-order'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { InlineTextField } from './inline-text-field'
import { DeleteCardButton } from './delete-card-button'
import { CardEditorFields } from './card-editor-fields'
import { useAddCard } from '../_hooks/use-add-card'

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
    questionLabel: c.question_label ?? null,
    baseOrder: c.base_order,
    questionText: c.question_text,
    options: Array.isArray(c.options) ? (c.options as CardOption[]) : [],
    explanationText: c.explanation_text ?? null,
    memo: c.memo ?? null,
    images: c.images,
  }
}

// Sprint F S: カードビュー仮想化の推定行高(px)。stg PERF-SEED 300-card exam の
// 実測 median(2026-07-15・viewport 1042×575・4 択中心分布)。過小/過大でも
// measureElement(ResizeObserver)が実行高で補正する。多択カード等の可変行高は
// measureElement 追従で吸収(spec §9・行高肥大は監視方針)。
const ESTIMATED_CARD_HEIGHT = 738

// scroll-top ボタンの表示閾値(px)。window をこの高さ以上スクロールしたら表示する。
// table(exam-card-table)は element scroll の collapsed(hysteresis 8/24px)由来だが、
// card-view の scroll-top ボタンは fixed で本文レイアウトを変えない(collapse のような
// layout feedback loop が無い)ため hysteresis は不要で単純閾値で足りる。
const SCROLL_TOP_VISIBLE_THRESHOLD = 400

// 1 card 分の行 body(question_label / title / delete + 後段フィールド列)を module scope の
// component に抽出(Sprint F W0)。抽出は verbatim 移動のみ(挙動不変)で、後続の W1
// (mount 時 consume effect)と S(仮想化の measureElement/ data-index は親 map の <li>
// に付与)の持ち場を用意する。閉包参照していた値(tagOptions / cardTags / autoEditOnMount)
// を props 化しただけで JSX は元と一致。<li> と key は親 map 側に残す。
type InlineCardRowProps = {
  card: ExamDetailCard
  userId: string
  categories: ClientTagCategory[]
  tagOptions: ClientTagOption[]
  cardTags: ClientCardTag[]
  autoEditOnMount: boolean
  // 初回 mount で auto-edit を発火した後、親の newCardIds Set から自 id を消す
  // (Sprint F W1)。仮想化(S)で scroll-out→scroll-in の remount 時に
  // autoEditOnMount=true が再突入して誤 auto-edit するのを防ぐ。
  onAutoEditConsumed: (id: string) => void
}

// 非 export(internal): 'use client' entry から function prop を持つ component を
// export すると Next の serializable-props 境界規則に触れるため。consume の検証は
// InlineCardList 経由の list-level test(remount で誤 auto-edit しない)で担保する。
function InlineCardRow({
  card,
  userId,
  categories,
  tagOptions,
  cardTags,
  autoEditOnMount,
  onAutoEditConsumed,
}: InlineCardRowProps) {
  // 初回 mount 時に 1 回だけ consume する。子 InlineTextField の autoEditOnMount は
  // render 中の one-shot useState 初期化子で読まれる(= mount 時の auto-edit は本 effect
  // より先に確定)ため、consume で Set を縮めても初回 auto-edit は殺さない。以後の
  // remount では Set に自 id が無く autoEditOnMount=false となり再突入しない。
  useEffect(() => {
    if (autoEditOnMount) onAutoEditConsumed(card.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount 時の値で 1 回だけ consume(one-shot・以後の prop 変化では再走させない)
  }, [])

  return (
    <Card>
      <CardContent className="p-4 space-y-3 md:p-2 md:space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-28 shrink-0">
            <InlineTextField
              cardId={card.id}
              userId={userId}
              field="question_label"
              initialValue={card.questionLabel}
              ariaLabel="番号 編集"
              placeholder="(番号)"
              displayClassName="text-xs font-mono text-slate-600"
            />
          </div>
          <div className="flex-1 min-w-0">
            <InlineTextField
              cardId={card.id}
              userId={userId}
              field="title"
              initialValue={card.title}
              ariaLabel="タイトル 編集"
              displayClassName="text-sm font-medium text-slate-900"
            />
          </div>
          <div className="shrink-0">
            <DeleteCardButton cardId={card.id} userId={userId} />
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
          tagOptions={tagOptions}
          cardTags={cardTags}
          questionText={card.questionText}
          options={card.options}
          explanationText={card.explanationText}
          memo={card.memo}
          images={card.images}
          autoEditOnMount={autoEditOnMount}
        />
      </CardContent>
    </Card>
  )
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
      .sort(compareByBaseOrder)
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
  // 生じた場合の汎用基盤として残す。 consume (Set 縮小) は下の consumeNewCardId が担う。
  const [newCardIds, setNewCardIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  // Sprint F W1: mount 済 marker を Set から消す consume 経路。子 InlineCardRow が
  // 初回 mount effect で自 id を渡す(one-shot)。これが無いと S(仮想化)導入後、
  // scroll-out→scroll-in の remount で cell が Set 残置 id を見て autoEditOnMount=true に
  // 再突入し誤 auto-edit する(旧「consume を持たない」設計は「cell が unmount/remount
  // されない」ことに依存しており、仮想化でその前提が崩れる)。functional updater で
  // 参照 Set のみを縮め、既に mount 済 cell の子 one-shot 判定には影響しない(初回
  // auto-edit は effect より先に render で確定済)。id 不在時は同一 ref を返して
  // 無駄な再 render を避ける。
  const consumeNewCardId = useCallback((id: string) => {
    setNewCardIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // Sprint F S: カードビュー仮想化(未仮想化 O(N) 再レンダー freeze の解消)。
  // 内部 scroll container を持たず page(window)スクロールのため useWindowVirtualizer。
  const listRef = useRef<HTMLUListElement>(null)
  // window 座標原点合わせ: window virtualizer は document 座標で測るため、リスト先頭の
  // offsetTop を scrollMargin に渡す。上部 chrome(見出し / empty-state / banner)の
  // 変化で offsetTop が変わりうるため毎 render 実測し、値が変わった時だけ state 更新
  // (guard で re-render loop を防ぐ)。jsdom は layout 非計算ゆえ offsetTop=0。
  const [scrollMargin, setScrollMargin] = useState(0)
  // offsetTop は上部 chrome の高さ変化(主に empty-state ↔ list の cards.length 遷移)で
  // 変わる。deps に cards.length を含めて count 変化時に測り直す。scrollMargin は書込 →
  // 再測(同値なら guard で set skip)で 2 render 以内に収束(infinite loop なし)。
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && el.offsetTop !== scrollMargin) setScrollMargin(el.offsetTop)
  }, [cards.length, scrollMargin])

  const rowVirtualizer = useWindowVirtualizer({
    count: cards.length,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    // 行が table 行より桁違いに高いため overscan は table(5)より絞る。実機で調整可。
    overscan: 3,
    // sort/filter/追加での index-key churn を防ぐ(stable key = card.id)。
    getItemKey: (index) => cards[index]!.id,
    scrollMargin,
  })

  // 追加カードの可視化(Sprint F S): 仮想化後は off-screen の新カードが mount されず
  // auto-edit も focus scroll も起きない。newCardIds の id が cards に現れたら該当 index へ
  // scrollToIndex(align:'auto' = 可視/overscan 内なら no-op)して mount させる。正確な
  // 着地は直後の auto-edit focus() の scroll-into-view に委ねる(追い scroll は足さない)。
  useEffect(() => {
    if (newCardIds.size === 0) return
    for (const id of newCardIds) {
      const idx = cards.findIndex((c) => c.id === id)
      if (idx >= 0) {
        rowVirtualizer.scrollToIndex(idx, { align: 'auto' })
        break
      }
    }
  }, [cards, newCardIds, rowVirtualizer])

  // scroll-top ボタン(テーブルビュー exam-card-table と同一 presentation)。card-view は
  // window スクロール(useWindowVirtualizer)のため、element scroll の collapsed に相当する
  // 出し入れを window.scrollY の閾値判定で行う。検知対象が構造的に異なるため component は
  // 共有せず presentation のみ揃える(実重複 2 箇所 = rule-of-three 未満)。
  const [showScrollTop, setShowScrollTop] = useState(false)
  useEffect(() => {
    const onScroll = () =>
      setShowScrollTop(window.scrollY > SCROLL_TOP_VISIBLE_THRESHOLD)
    onScroll() // 復元スクロール等、mount 時点の scroll 位置を初期反映
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const virtualItems = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()
  const hasVirtualItems = virtualItems.length > 0
  // spacer 高(scrollMargin で document→list 相対に re-base)。空(0 件)は spacer を出さない。
  const paddingTop = hasVirtualItems
    ? virtualItems[0]!.start - scrollMargin
    : 0
  const paddingBottom = hasVirtualItems
    ? totalSize - (virtualItems[virtualItems.length - 1]!.end - scrollMargin)
    : 0

  // local-first 追加: 作成ロジック本体 (id 採番 + buildEmptyCard + mirror insert +
  // outbox enqueue、非自明な実行順の契約込み) は useAddCard hook へ抽出済 (Row-UX
  // sprint Task 3)。ここに残るのは呼出側の関心 (auto-edit marker の同期反映 / error
  // UI) のみ。採番基準は現在表示中の cards (この exam の base_order と件数)。 liveData
  // はこの exam の全 card (フィルタ非適用・pending create も楽観 insert 済で含む) なので
  // 末尾採番の母集団として正しく、 mirror 未 hydrate の窓では initialCards (SSR・同じ
  // base_order 順) が同じ役割を果たす (spec §4.1 r3 — この fallback のために
  // ExamDetailCard が baseOrder を持つ)。 件数表示は exam list / 詳細 header いずれも
  // mirror の card 行数を動的集計するため、 mirror への insert がそのまま件数表示に
  // 反映される (Sprint B で exams.card_count bump 呼出は撤去済 — client はもともと
  // card_count を参照していない)。
  const { addCard } = useAddCard({ userId, examId })
  const handleAddCard = async () => {
    setError(null)
    try {
      await addCard(
        cards.map((c) => c.baseOrder),
        cards.length,
        {
          // hook 内で最初の await (runOptimisticCreate) より前に同期発火する。
          // Set + functional updater で複数 pending id を蓄積する: updater chain
          // `prev → {id1} → {id1, id2}` で両 id を追跡、 useLiveQuery 再評価後の
          // cell mount 時に `newCardIds.has(id)` が true となり、 autoEditOnMount
          // (one-shot useState 初期化子) が発火する。実ブラウザでは button click に
          // よる blur-commit で 1 枚目の編集状態は確定して閉じ、 新カードのみが
          // focus する (= 仕様、 詳細は上の Set 化コメント参照)。
          onIdMinted: (cardId) => {
            setNewCardIds((prev) => {
              const next = new Set(prev)
              next.add(cardId)
              return next
            })
          },
        },
      )
    } catch {
      // hook が rethrow した場合のみ到達 (enqueue throw → Dexie auto-rollback 済、 もしくは
      // userId='' fail-fast)。 mirror は rollback 済 + outbox 未反映、 案 a 取り直し前提で
      // 次回 pull が server 値で reconcile。 user 通知のため inline error UI を表示する。
      // 注: setNewCardIds は既に発火済 (onIdMinted の同期発火経路) だが、 mirror に該当
      // row が存在しないため autoEditOnMount は描画上 no-op となる (該当 cell が render
      // されない)。 失敗した id を Set から削除する bookkeeping は行わない: hook の catch
      // 経路は Dexie auto-rollback 済で mirror に row が存在せず、 cell が render されない
      // ため `newCardIds.has(failed_id)` は呼ばれない (= 実害なし、 delete の手間を省く)。
      // 集合は max でも 1 view 中の add 回数分しか溜まらないため leak にもならない。
      setError('カードの追加に失敗しました。')
    }
  }

  return (
    <div className="space-y-3 md:space-y-2">
      {/* 見出し件数は live `cards` (リスト本体と同一の useLiveQuery 配列) の length。
          追加/削除直後も即時整合する (旧 SSR cards.length 由来の stale を解消、論点B)。
          同一配列を数えるため double-count は構造的に発生しない (論点C: cards mirror
          計数に一本化、 exams.card_count 相当の別カウンタは持たない)。 */}
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
      {/* 仮想化(Sprint F S): top/bottom spacer <li> + 可視 items のみ mount。行間の
          space-y は measureElement が margin を測らないため各 item <li> の pb-2 へ移す
          (視覚間隔は不変・spacer 計算と整合)。<li> は W0 で親 map に温存済ゆえ
          measureElement ref / data-index を直接付与(forwardRef 不要)。 */}
      <ul ref={listRef}>
        {paddingTop > 0 && <li aria-hidden style={{ height: paddingTop }} />}
        {virtualItems.map((vi) => {
          const card = cards[vi.index]!
          return (
            <li
              key={card.id}
              data-index={vi.index}
              ref={rowVirtualizer.measureElement}
              // 旧 space-y-2 は sibling 間のみ gap(最後の card 下には付かない)。真の
              // 末尾 card(全 list 中の最終 index)には pb を付けず、視覚間隔を厳密維持。
              className={vi.index < cards.length - 1 ? 'pb-2' : undefined}
            >
              <InlineCardRow
                card={card}
                userId={userId}
                categories={categories}
                tagOptions={options}
                cardTags={tagsByCardId.get(card.id) ?? []}
                autoEditOnMount={newCardIds.has(card.id)}
                onAutoEditConsumed={consumeNewCardId}
              />
            </li>
          )
        })}
        {paddingBottom > 0 && <li aria-hidden style={{ height: paddingBottom }} />}
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

      {/* scroll-top ボタン: window を閾値超スクロール時のみ表示。fixed のため本文レイアウトに
          影響しない。presentation はテーブルビュー(exam-card-table)と同一。element scroll
          でなく window.scrollTo を呼ぶ点のみ異なる。safe-area(env(safe-area-inset-bottom))は
          付与しない: ① 参照するテーブルビューのボタンも非付与ゆえ視覚一致のため揃える、
          ② 現 viewport は viewport-fit=cover 不在で env() が全デバイス 0(inert)かつ iOS
          Safari は viewport を safe-area 手前に inset するため bottom-4 は home indicator と
          構造的に被らない(判断根拠は Sprint F session doc)。 */}
      {showScrollTop && (
        <Button
          variant="outline"
          size="icon-lg"
          className="rounded-full shadow-sm fixed right-6 bottom-4 z-30"
          data-testid="scroll-top-button"
          aria-label="先頭へスクロール"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <ChevronUp />
        </Button>
      )}
    </div>
  )
}
