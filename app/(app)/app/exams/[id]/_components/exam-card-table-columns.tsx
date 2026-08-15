'use client'

// exam-card-table-columns — TanStack Table column defs for ExamCardTable。
// module スコープで定義 (component 内 useMemo 不使用)。
// 列順: [select, title, question_label, question, options, tags,
//        explanation_text, memo, lastCorrect, currentStreak, lastReview]。
// Fix-3 T2: 決め打ち sticky 固定は撤去(不変)。S5 でユーザー選択式の列固定(column pinning)を導入 — 固定境界は examViewPrefs V3 + TanStack columnPinning で管理。
//
// 'use client' は JSX を含む ColumnDef を使うため必要 (T2 学び: pure helper でも
// React component を含む場合は boundary が必要)。

import type { ColumnDef, FilterFn } from '@tanstack/react-table'
import type { ClientCard, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { TagEditCallbacks } from '@/lib/tags/tag-crud'
import type { ToggleFn } from '../_hooks/use-card-tag-toggle'
import { TagCell } from './exam-card-table-tag-cell'
import { tagSortKey } from '../_lib/tag-sort-key'
import { compareByQuestionLabel } from '@/lib/cards/domain/card-order'
import { CompactOptionsCell } from './exam-card-table-options-edit-cell'
import { ExamCardRowMenu, type PullIntoDispatch } from './exam-card-row-menu'
import { CardImageGallery } from './card-image-gallery'
import {
  matchesTagFilter,
  matchesAnswerState,
  matchesStreakFilter,
  matchesTextFilter,
  type TagFilterValue,
  type AnswerStateFilter,
  type StreakFilterValue,
  type TextFilterValue,
} from '@/lib/cards/card-filter-predicates'
import type { CardWithTags } from '@/lib/cards/join-card-tags'
import { InlineTextField } from './inline-text-field'

// 既存 import 互換維持: ExamCardRow = CardWithTags (pure alias)。
export type ExamCardRow = CardWithTags

/** TanStack Table meta 型。 table レベルで 1 回構築し、 columns の cell から参照する。 */
export type ExamCardTableMeta = {
  userId: string
  toggle: ToggleFn
  tagEditCallbacks: TagEditCallbacks
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  // T2: side peek trigger。optional — 配線されていない (単体 harness 等) なら
  // グリップ menu の「開く」項目を描画しない (row-ux §5)。
  openCard?: (cardId: string) => void
  // UI fix B: 現在 side peek で開いている card id (再導入 — 「カードを開く」常設 button
  // 撤去時に dead field として一度削除済)。 optional — 未配線 (単体 harness 等) では
  // 行メニュー項目は closed 状態のアイコン/aria-label で描画する (openCard 自体の描画有無には
  // 影響しない、あくまで開閉の視覚表現の入力)。
  activeCardId?: string | null
  // Grid-3 §7.2 + row-ux §2: 行の二役グリップ (menu = 開く / ここに取り込む)。
  // openCard と同じ optional 規約 — 配線されていなければ trigger を描画しない。
  rowMenu?: {
    /** 取り込み先 = 現在表示中の exam。 */
    currentExamId: string
    /** ソート/フィルタ適用中 = menu 項目 disabled (§7.4)。 */
    positionLocked: boolean
    /** 移動の実行中 flag (一括バー / 切り出し / 取り込みで共有)。 */
    pending: boolean
    onPullInto: PullIntoDispatch
  }
}

// ---------------------------------------------------------------------------
// filterFn (Grid-2 T3) — module スコープで定義し、 純関数 (../_lib) に委譲する。
// columnFilters の value 形は filter-bar が書込む型と一致させる。
// ---------------------------------------------------------------------------

const tagsFilterFn: FilterFn<ExamCardRow> = (row, _columnId, filterValue) =>
  matchesTagFilter(row.original.tags, filterValue as TagFilterValue)

const answerStateFilterFn: FilterFn<ExamCardRow> = (row, _columnId, filterValue) =>
  matchesAnswerState(row.original.card, filterValue as AnswerStateFilter)

const streakFilterFn: FilterFn<ExamCardRow> = (row, _columnId, filterValue) =>
  matchesStreakFilter(row.original.card.current_streak, filterValue as StreakFilterValue)

// S4-1: テキストフィルタ factory。read(card) でセル値を取り出して matchesTextFilter に委譲。
// 5 列 (title / question_label / question / explanation_text / memo) に適用 (rule of three 充足)。
// row.original 直読み — accessorFn / getValue とは独立 (sort と filter は別レイヤー)。
const makeTextFilterFn = (
  read: (card: ClientCard) => string | null | undefined,
): FilterFn<ExamCardRow> =>
  (row, _columnId, filterValue) =>
    matchesTextFilter(read(row.original.card), filterValue as TextFilterValue)

// row-ux UI fix A-1: SHARED_BOX_CHROME (inline-edit-shared.ts) の内側 padding (p-2 / md:py-1)
// を直接書き換えるとカードビュー (inline-card-list.tsx / card-editor-fields.tsx 経由の
// InlineTextField / InlineOptionCell) にも波及するため触らない。displayClassName は
// InlineTextField/InlineOptionCell 側で cn()(twMerge)の最後の引数として渡され display div・
// textarea・input の 3 箇所に効く(inline-edit-shared.ts:15 コメント参照)ので、テーブル列
// 側だけで内側 padding を打ち消せる。 td 側 (px-1 py-1) へ余白を一本化するため全方向 0 にする
// — base の p-0 だけでは SHARED_BOX_CHROME の md:py-1 を打ち消せない (twMerge は modifier ごと
// に独立した衝突判定バケツを持つため)、md:py-0 を明示する。 min-h は不変
// (display/edit の箱寸法一致を崩さない = 編集開始時の layout shift 防止)。
const CELL_EDIT_FLUSH_PADDING = 'p-0 md:py-0'

export const examCardTableColumns: ColumnDef<ExamCardRow>[] = [
  {
    id: 'select',
    // row-ux UI fix A-2: グリップ (size-6=24px) + gap-1 (4px) + チェックボックス実体
    // (review F2: h-4 w-4 で 16px に固定 — ブラウザ既定依存の推定値だったのを保証値にした) +
    // px-1 左右 (td 側 8px) = 52px。旧 72px は「+20px の余裕」を持たせていたが、OT 判断で
    // 最小幅まで詰める (72→52)。
    size: 52,
    header: ({ table }) => (
      <div className="flex items-center justify-center gap-1">
        {/* row-ux UI fix A-3: 行側のグリップ (size-6) と同じ幅の spacer を checkbox の前に
            置き、全選択 checkbox の x 位置を行側 checkbox (グリップの右隣) と揃える。
            focusable な要素を足さない (tab 順を増やさない) ため button/input ではなく span、
            かつ aria-hidden で SR にも読ませない (spacer 自体に意味はない)。 */}
        <span className="inline-block size-6 shrink-0" aria-hidden="true" />
        <input
          type="checkbox"
          checked={table.getIsAllRowsSelected()}
          ref={(el) => {
            if (el) el.indeterminate = table.getIsSomeRowsSelected()
          }}
          onChange={table.getToggleAllRowsSelectedHandler()}
          // B: th 全域が onClick で全選択トグルするため、checkbox 直 click の bubbling を止めて
          //    二重発火 (onChange + th onClick) による net no-op を防ぐ。onChange は温存 (Space キー不変)。
          onClick={(e) => e.stopPropagation()}
          aria-label="全選択"
          // row-ux UI fix A-2 review F2: 実寸を明示し select 列 52px の算術 (checkbox~16px 分) を
          // 「仮定」から「保証」にする (既存前例: exam-card-table-options-edit-cell.tsx の h-4 w-4)。
          className="h-4 w-4"
        />
      </div>
    ),
    // row-ux §2 / §6: select 列 = 二役グリップ + checkbox の 2 要素。「カードを開く」常設
    // button と ⋯ 行メニューはグリップの menu に統合済 (要素数を減らすのが本 sprint の主眼)。
    // 基底は常時表示の低コントラスト — hover で「出現」させる書き方は hover 不能端末で
    // 永久不可視になるため使わない (spec §12 の NO-GO 記録)。
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      return (
        <div className="flex items-center justify-center gap-1">
          {/* Grid-3 §7.2 + row-ux §5: グリップ (ドラッグ = 並べ替え / クリック = メニュー)。
              配線済み (meta.rowMenu) のときだけ描画する。 drag 役は SortableRow が配る
              context 経由 (touch-none / dnd attributes はこの button のみ — event 分離契約)。 */}
          {meta?.rowMenu && (
            <ExamCardRowMenu
              userId={meta.userId}
              currentExamId={meta.rowMenu.currentExamId}
              anchorCard={card}
              positionLocked={meta.rowMenu.positionLocked}
              pending={meta.rowMenu.pending}
              onPullInto={meta.rowMenu.onPullInto}
              openCard={meta.openCard}
              isOpen={meta.activeCardId === card.id}
            />
          )}
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            // B: td 全域が onClick で選択トグルするため、checkbox 直 click の bubbling を止めて
            //    二重発火 (onChange + td onClick) による net no-op を防ぐ。onChange は温存 (Space キー不変)。
            onClick={(e) => e.stopPropagation()}
            aria-label={`行選択: ${row.original.card.title}`}
            // row-ux §6: 基底 50% → 行 hover / 自 focus で通常表示。選択済みは常時通常表示。
            // row-ux UI fix A-2 review F2: h-4 w-4 で実寸を明示 (header checkbox と同理由)。
            className="h-4 w-4 opacity-50 group-hover:opacity-100 focus-visible:opacity-100 checked:opacity-100"
          />
        </div>
      )
    },
    enableSorting: false,
  },
  {
    id: 'title',
    size: 80,
    header: 'タイトル',
    // S3-1 D-1: TanStack v8 の getCanSort() は !!accessorFn が必須 (RowSorting.js:178)。
    // display column (accessorFn なし) では enableSorting:true でも getCanSort()===false になり
    // getSortedRowModel がフィルタアウトするため、title を非 null accessor で sortable 化。
    // sortingFn は row.original から直接読んで localeCompare('ja') で比較する。
    accessorFn: (row) => row.card.title,
    // T2/T3 + row-ux §2: side peek の起動は select 列のグリップ menu「開く」に集約済。
    // title セルは InlineTextField のみ(他の text 列 = question_label 等と同型)。
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      // owner は常に認証主体 (meta.userId) — 編集対象 mirror 行の user_id は使わない
      // (lib/sync/optimistic-mutation.ts:58-59 の絶対規則。 outbox 行を他 user 名義にすると
      // 認可境界を迂回しうる)。 meta 不在時は cell 自体を描画しない(question/options/tags と同型)。
      if (!meta) return null
      return (
        <InlineTextField
          cardId={card.id}
          userId={meta.userId}
          field="title"
          initialValue={card.title}
          ariaLabel="タイトル 編集"
          displayClassName={CELL_EDIT_FLUSH_PADDING}
        />
      )
    },
    enableSorting: true,
    sortingFn: (rowA, rowB) =>
      rowA.original.card.title.localeCompare(rowB.original.card.title, 'ja'),
    // S4-1: テキストフィルタ。row.original.card.title を直読み (sort と独立)。
    filterFn: makeTextFilterFn((card) => card.title),
  },
  {
    id: 'question_label',
    size: 100,
    header: '番号',
    // S3-1 D-2: accessorFn は getCanSort() を有効化するために必要 (TanStack v8 制約)。
    // compareByQuestionLabel = **表示専用**(ラベル文字列比較 + NULLS LAST、同値は
    // (base_order, id) で解決)。既定順ではない — 既定順は base_order で別レイヤー。
    // TanStack desc 反転により昇順→null 末尾 / 降順→null 先頭 (継承挙動・意図的)。
    accessorFn: (row) => row.card.question_label,
    cell: ({ row, table }) => {
      const meta = table.options.meta as ExamCardTableMeta | undefined
      // owner は常に認証主体 (meta.userId) — title セルと同型・同理由(:145-152 参照)。
      if (!meta) return null
      return (
        <InlineTextField
          cardId={row.original.card.id}
          userId={meta.userId}
          field="question_label"
          initialValue={row.original.card.question_label ?? null}
          ariaLabel="番号 編集"
          displayClassName={CELL_EDIT_FLUSH_PADDING}
        />
      )
    },
    enableSorting: true,
    sortingFn: (rowA, rowB) =>
      compareByQuestionLabel(rowA.original.card, rowB.original.card),
    // S4-1: テキストフィルタ。row.original.card.question_label を直読み (nullable)。
    filterFn: makeTextFilterFn((card) => card.question_label),
  },
  {
    id: 'question',
    size: 320,
    header: '問題文',
    // accessorFn は表示 (question_text) のために残置 — sort は撤去 (S3-1 D-3 前段)。
    accessorFn: (row) => row.card.question_text,
    // Sprint T T6 + add(2026-07-17 OT): カードビュー同様に gallery を配線(thumbnail +
    // compact add icon)。add は「面ごとの出し分けをしない」原則で table にも配線。
    // 既存 attach 経路(CardImageGallery 内 attachImageToCard)を流用・独自経路なし。userId は meta 経由。
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      // owner は常に認証主体 (meta.userId)。 編集対象 mirror 行の card.user_id は使わない
      // (lib/sync/optimistic-mutation.ts:58-59 の絶対規則 — outbox 行を他 user 名義にすると
      // 認可境界を迂回しうる)。 meta 不在時は outbox 行を作れない(空 user_id の孤児行を
      // 生まないため)ので cell 自体を描画しない。
      if (!meta) return null
      return (
        <>
          <InlineTextField
            cardId={card.id}
            userId={meta.userId}
            field="question_text"
            initialValue={card.question_text}
            ariaLabel="問題文 編集"
            multiline
            displayClassName={`text-sm md:min-h-6 ${CELL_EDIT_FLUSH_PADDING}`}
          />
          <CardImageGallery
            images={card.images}
            target="question_text"
            cardId={card.id}
            userId={meta.userId}
            compact
            attachAriaLabel="問題文に画像を追加"
          />
        </>
      )
    },
    // S3-1: 問題文ソート撤去。連番順の役割は question_label 列 sortingFn へ移管。
    // 注意: 初期連番順(liveData の pre-sort)は別レイヤーで不変(exam-card-table.tsx)。
    enableSorting: false,
    // S4-1: テキストフィルタ。row.original.card.question_text を直読み。
    filterFn: makeTextFilterFn((card) => card.question_text),
  },
  {
    id: 'options',
    size: 240,
    header: '選択肢',
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      // owner は常に認証主体 (meta.userId) — 編集対象 mirror 行の user_id は使わない
      // (lib/sync/optimistic-mutation.ts:58-59 の絶対規則。 outbox 行を他 user 名義にすると
      // 認可境界を迂回しうる)。 `meta?.userId ?? ''` の fallback は空 user_id の outbox 行を
      // 生み、 どの user の flush からも stale 隔離からも選別されない不滅行になるため使わない。
      // 代わりに meta 不在時は cell 自体を描画しない (tags cell と同型)。
      if (!meta) return null
      return (
        <CompactOptionsCell
          cardId={card.id}
          options={card.options}
          images={card.images}
          userId={meta.userId}
        />
      )
    },
    enableSorting: false,
  },
  {
    id: 'tags',
    size: 200,
    header: 'タグ',
    // S3-2 D-3: 代表値 = TagCell 表示順と同一 comparator で並べた先頭タグの
    // `{category.name}: {option.name}`。TanStack の getCanSort() には !!accessorFn が必要。
    accessorFn: (row) => tagSortKey(row.tags),
    cell: ({ row, table }) => {
      const meta = table.options.meta as ExamCardTableMeta | undefined
      if (!meta) return null
      return (
        <TagCell
          cardId={row.original.card.id}
          userId={meta.userId}
          tags={row.original.tags}
          categories={meta.categories}
          options={meta.options}
          toggle={meta.toggle}
          tagEditCallbacks={meta.tagEditCallbacks}
        />
      )
    },
    enableSorting: true,
    // 代表値を localeCompare('ja') で比較。undefined (タグ無し) は sortUndefined:'last' が処理。
    sortingFn: (rowA, rowB, columnId) =>
      String(rowA.getValue(columnId) ?? '').localeCompare(
        String(rowB.getValue(columnId) ?? ''),
        'ja',
      ),
    // タグ無しカード (accessorFn → undefined) は昇降ともに末尾固定。
    sortUndefined: 'last',
    // Grid-2 T3: tag フィルタ (カテゴリ内 OR / カテゴリ間 AND)。value = TagFilterValue。
    // filterFn は row.original.tags を直読み — accessorFn/getValue とは独立 (sort/filter 独立)。
    filterFn: tagsFilterFn,
  },
  {
    id: 'explanation_text',
    size: 220,
    header: '解説',
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      // owner は常に認証主体 (meta.userId) — question セルと同型・同理由(:196-211 参照)。
      if (!meta) return null
      return (
        <>
          <InlineTextField
            cardId={card.id}
            userId={meta.userId}
            field="explanation_text"
            initialValue={card.explanation_text ?? null}
            multiline
            ariaLabel="解説 編集"
            displayClassName={`text-sm md:min-h-6 ${CELL_EDIT_FLUSH_PADDING}`}
          />
          <CardImageGallery
            images={card.images}
            target="explanation_text"
            cardId={card.id}
            userId={meta.userId}
            compact
            attachAriaLabel="解説に画像を追加"
          />
        </>
      )
    },
    enableSorting: false,
    // S4-1: テキストフィルタ。row.original.card.explanation_text を直読み (nullable)。
    filterFn: makeTextFilterFn((card) => card.explanation_text),
  },
  {
    id: 'memo',
    size: 220,
    header: 'メモ',
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      // owner は常に認証主体 (meta.userId) — question セルと同型・同理由(:196-211 参照)。
      if (!meta) return null
      return (
        <>
          <InlineTextField
            cardId={card.id}
            userId={meta.userId}
            field="memo"
            initialValue={card.memo ?? null}
            multiline
            ariaLabel="メモ 編集"
            displayClassName={`text-sm md:min-h-6 ${CELL_EDIT_FLUSH_PADDING}`}
          />
          <CardImageGallery
            images={card.images}
            target="memo"
            cardId={card.id}
            userId={meta.userId}
            compact
            attachAriaLabel="メモに画像を追加"
          />
        </>
      )
    },
    enableSorting: false,
    // S4-1: テキストフィルタ。row.original.card.memo を直読み (nullable)。
    filterFn: makeTextFilterFn((card) => card.memo),
  },
  {
    id: 'lastCorrect',
    size: 96,
    header: '直近正誤',
    // null → undefined 変換: TanStack の sortUndefined: 'last' に乗せるため必須。
    // false ?? undefined === false なので false は保持される (boolean 値は消えない)。
    accessorFn: (row) => row.card.last_correct ?? undefined,
    cell: ({ row }) => {
      const v = row.original.card.last_correct
      if (v === true) {
        return <span className="font-medium text-green-600">正 ○</span>
      }
      if (v === false) {
        return <span className="font-medium text-red-500">誤 ×</span>
      }
      return <span className="text-muted-foreground">—</span>
    },
    enableSorting: true,
    // null/undefined を昇順・降順とも末尾に固定 (direction 非依存)。
    sortUndefined: 'last',
    // boolean 比較は TanStack default ('basic' = 数値変換後比較、false=0 < true=1) で OK。
    // Grid-2 T3: 回答状態フィルタ (AS-1) を last_correct 列に attach。 value = AnswerStateFilter。
    filterFn: answerStateFilterFn,
  },
  {
    id: 'currentStreak',
    size: 96,
    header: '連続正解数',
    // 数値フィールド。null なし。default sortingFn ('auto') で数値ソート。
    accessorFn: (row) => row.card.current_streak,
    cell: ({ row }) => (
      <span>{row.original.card.current_streak}</span>
    ),
    enableSorting: true,
    // Grid-2 T3: 数値比較フィルタ (N-1)。 value = StreakFilterValue。
    filterFn: streakFilterFn,
  },
  {
    id: 'lastReview',
    size: 160,
    header: '最終回答日時',
    // null → undefined 変換: sortUndefined: 'last' を効かせるため必須。
    accessorFn: (row) => row.card.last_review ?? undefined,
    cell: ({ row }) => {
      const v = row.original.card.last_review
      if (!v) {
        return <span className="text-muted-foreground">未回答</span>
      }
      // JST 表示: Asia/Tokyo タイムゾーンで日付 + 時刻を表示
      const jst = new Date(v).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      return <span>{jst}</span>
    },
    enableSorting: true,
    // ISO 文字列を純粋文字列比較 (辞書順 = 時系列順)。
    // 'alphanumeric' は数値分割で ISO に意図しない結果を生む可能性があるため 'text' を明示。
    // undefined (= null 変換済) は sortUndefined: 'last' が処理するため custom 内不要。
    sortingFn: 'text',
    sortUndefined: 'last',
  },
]
