// ExamCardRowMenu — 行の二役グリップ + 行メニュー (「開く」/「ここに取り込む」) と
// 取り込み picker。 Grid-3 spec §7.2 / §7.4 / D-9 + row-ux spec §2 / §5。
//
// 構成:
//   ExamCardRowMenu … select セル内の **grip trigger** + Radix Popover の menu。grip は
//     二役 (ドラッグ = 並べ替え / クリック = メニュー) で、drag 役は SortableRow が配る
//     context (useRowDnd) から来る。項目は「開く」+「ここに取り込む」
//     (ColumnHeaderMenu と同じ Popover wrapper・同じ項目 markup)。
//   PullIntoDialog … 取り込み picker。ConfirmDialog の portal modal パターンを転用
//     (backdrop click / role=dialog + aria-modal / Escape / focus 復帰)。menu を閉じてから
//     開くので Popover の unmount に巻き込まれない。
//
// 役割分担は移動 popover (a) と同じ: **入力の組み立てだけ**を持ち、実際の移動発行・
// toast・undo は親 (ExamCardTable) の責務。確定は onPullInto に委譲し、返ってきた文言を
// dialog 内の inline error に出す — 行メニューは選択ゼロでも開けるため、action bar の
// error 枠 (selectedIds > 0 でのみ mount) を当てにできない。
//
// source exam は **1 操作 1 つ** (spec D-9): undo が単一 exam への逆移動 1 件で表せる
// ことが wire の前提なので、picker で複数 exam を跨いで選ばせない。
//
// 'use client' は付けない: 親 exam-card-table-columns (= 'use client') からのみ import
// される子。file 自体に付けると Next.js TS plugin が function 型 prop を Server Action
// prop として誤検出する (move popover / action-bar / TagCell と同 pattern)。

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { GripVertical, PanelRightClose, PanelRightOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { compareByBaseOrder } from '@/lib/cards/domain/card-order'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { cn } from '@/lib/utils'
import { POSITION_LOCKED_REASON } from './exam-card-move-popover'
import { ROW_DND_LOCKED_REASON, useRowDnd } from './exam-card-row-dnd'

/**
 * 取り込みの確定 dispatch。返り値 = dialog に出す inline error 文言、`null` なら完了
 * (= 閉じてよい)。文言を親から受けるのは、失敗 3 分岐 (reject / no-cards /
 * target-exam-missing) の解釈と文言を移動 UI 3 入口で 1 箇所に保つため。
 */
export type PullIntoDispatch = (
  cardIds: string[],
  anchorId: string,
) => Promise<string | null>

const PULL_INTO_MENU_ITEM_LABEL = 'ここに取り込む'
// UI fix B: 「開く」項目は視覚テキストを持たない (既存サイドピークアイコンのみ)。
// SR には aria-label で開閉状態を伝える (無文言でも名前は要る)。
const OPEN_CARD_ARIA_LABEL_CLOSED = '詳細を開く'
const OPEN_CARD_ARIA_LABEL_OPEN = '詳細を閉じる'

/**
 * checkbox リストを描画する上限 (spec §7.2「少数枚用」の具体化)。超過分は仮想化も検索も
 * 無いまま全件 render すると固まるため、リストを出さず一括バー (a) へ誘導する。
 */
export const PULL_INTO_LIST_LIMIT = 200

const PULL_INTO_OVER_LIMIT_MESSAGE =
  '取り込み元のカードが多すぎるため一覧を表示しません。一括バーの「移動」を使ってください。'

// checkbox の表示は question_label / title の先頭部のみ (spec §7.2)。
const CARD_LABEL_MAX = 40

export type ExamCardRowMenuProps = {
  userId: string
  /** 取り込み先 = 現在表示中の exam。 */
  currentExamId: string
  /** この行の card。取り込んだカードはこの直後に入る (placement anchor)。 */
  anchorCard: ClientCard
  /** ソート/フィルタ適用中 = 位置指定 gating (spec §7.4)。menu 項目を disabled にする。 */
  positionLocked: boolean
  /** 親が持つ移動の実行中 flag (一括バー / 切り出し / 取り込みで共有)。 */
  pending: boolean
  onPullInto: PullIntoDispatch
  /**
   * side peek のトグル (row-ux §5)。 未配線 (単体 harness 等) では「開く」項目を
   * 描画しない — meta 経由 optional の既存規約と同型。
   */
  openCard?: (cardId: string) => void
  /**
   * この行の card が現在 side peek で開いているか (UI fix B)。 未配線 (単体 harness 等) では
   * false 扱い — 「開く」項目のアイコン / aria-label / aria-pressed の初期状態を決めるだけで、
   * 描画有無 (openCard の optional 規約) には影響しない。
   */
  isOpen?: boolean
}

export function ExamCardRowMenu({
  userId,
  currentExamId,
  anchorCard,
  positionLocked,
  pending,
  onPullInto,
  openCard,
  isOpen = false,
}: ExamCardRowMenuProps) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const reasonId = React.useId()
  // picker を閉じたときの focus 復帰先。**menu 項目ではなく trigger** を捕まえる:
  // 項目は picker を開くのと同じ commit で unmount されるため、dialog 側で
  // document.activeElement を退避すると detached node を掴んで focus() が no-op になる
  // (ConfirmDialog が成立するのは trigger が mount され続ける構造だから)。
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  // picker を閉じる唯一の口。unmount 前に trigger へ focus を戻すので、focus は
  // dialog の DOM が外れても trigger に残る。
  const closePicker = React.useCallback(() => {
    setPickerOpen(false)
    triggerRef.current?.focus()
  }, [])

  // row-ux §4: 2 つの gating を別概念として持つ。
  //   dragAvailable = この試験で並べ替えが意味を持つか (行 2 枚以上)。
  //   dragEnabled   = 今この瞬間ドラッグできるか (ソート/フィルタ中・移動中は false)。
  // ctx null (provider 不在 = 単体 harness) は drag 役なし = menu 専用 trigger。
  const rowDnd = useRowDnd()
  const dragAvailable = rowDnd?.dragAvailable ?? false
  const dragEnabled = dragAvailable && !rowDnd?.locked && !rowDnd?.pending
  // 並べ替え可能な行が「今だけ」塞がれている状態 = 理由を提示する唯一の条件。
  // dragAvailable でない行に「ソート/フィルタを解除すれば並べ替えられます」と言うのは誤り。
  const lockedForDrag = dragAvailable && (rowDnd?.locked ?? false)

  const setActivatorNodeRef = rowDnd?.setActivatorNodeRef
  // trigger の ref は 2 者を束ねる: picker の focus 復帰先 (triggerRef) と dnd-kit の
  // activator (KeyboardSensor の起動判定に使う)。 Radix 側の ref は PopoverTrigger asChild
  // の Slot が child の ref と自動合成する (@radix-ui/react-slot useComposedRefs) ので
  // ここでは扱わない。 inline arrow にすると毎 render で detach/attach が走るため
  // useCallback で identity を固定する (SortableRow の merge ref と同規律)。
  // activator は dragAvailable の間は locked / pending 中も付けたままにする — ドラッグ
  // 可能な状況で ref を外すと KeyboardSensor の activator 判定が死ぬため。
  const setTriggerRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node
      if (dragAvailable) setActivatorNodeRef?.(node)
    },
    [dragAvailable, setActivatorNodeRef],
  )

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            ref={setTriggerRef}
            type="button"
            // dnd-kit は disabled 時に listeners を undefined で返す
            // (@dnd-kit/core core.esm.js:3446) ため、 自前の条件分岐は書かない。
            {...rowDnd?.listeners}
            // dnd の semantics (role / tabIndex / aria-roledescription / instructions への
            // aria-describedby) は dragEnabled のときだけ付ける。 locked / pending / 1 枚 /
            // provider 不在では「メニューを開く button」でしかないので、 SR に「Space で
            // つかむ」と案内しない (row-ux §2.4)。
            {...(dragEnabled ? rowDnd?.attributes : undefined)}
            // menu 役は常に生きているので、 どの状態でも disabled を主張しない
            // (dnd-kit の attributes は dragEnabled 時も aria-disabled="false" を出す)。
            aria-disabled={undefined}
            // dragEnabled 側は spread 済みの dnd 側 id をそのまま残す (ここで書くと消える)。
            // 両状態は排他なので空白合成はしない。
            {...(lockedForDrag ? { 'aria-describedby': rowDnd?.lockedReasonId } : {})}
            aria-label={`行の操作: ${anchorCard.title}`}
            title={lockedForDrag ? ROW_DND_LOCKED_REASON : undefined}
            // select td 全域の onClick (行選択トグル) への bubbling を止める
            // (checkbox と同理由)。Radix 自身の toggle は defaultPrevented を見るので
            // stopPropagation では止まらない (= menu は正常に開く)。
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'inline-flex size-6 shrink-0 touch-none items-center justify-center rounded',
              // 常時表示の低コントラスト (row-ux §6): 基底は 50% で可視、 行 hover / 自
              // focus で通常色、 direct hover で前景色。 基底を opacity-0 にはしない
              // (hover 不能端末で永久不可視になる — spec §12 の NO-GO 記録)。
              'text-muted-foreground/50 group-hover:text-muted-foreground focus-visible:text-muted-foreground hover:text-foreground',
              dragEnabled && 'cursor-grab',
            )}
          >
            <GripVertical className="size-4" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <div className="flex flex-col" data-testid="exam-card-row-menu">
            {openCard && (
              <button
                type="button"
                // UI fix B: 文言なし・既存サイドピークアイコンのみ (視覚)。aria-label で
                // 開閉状態を SR に伝え (無文言でも名前は要る)、aria-pressed でトグル button の
                // 意味論を明示する。項目 = 独立 DOM (grip とは別 button) なので、
                // dnd-kit が grip 側に自前で張る aria-pressed (isDragging 表現) とは衝突しない。
                aria-label={isOpen ? OPEN_CARD_ARIA_LABEL_OPEN : OPEN_CARD_ARIA_LABEL_CLOSED}
                aria-pressed={isOpen}
                // 押しやすさ: 既存項目 (px-2 py-1.5) と同じ高さ・パディングを維持。flex-col 親の
                // stretch でボタン幅は既に項目全幅 (アイコンのみでも hit area が痩せない)。
                className="flex items-center rounded px-2 py-1.5 hover:bg-muted"
                onClick={(e) => {
                  // PopoverContent は DOM 上は portal でも **React tree では行 cell の子** なので、
                  // ここで止めないと select td の onClick (行選択トグル) まで伝播する
                  // (「ここに取り込む」項目と同理由・同順序)。
                  e.stopPropagation()
                  // menu を閉じてから発火する (項目 click 後は open state で閉じる規約)。
                  setMenuOpen(false)
                  openCard(anchorCard.id)
                }}
              >
                {isOpen ? (
                  <PanelRightClose className="size-4" aria-hidden="true" />
                ) : (
                  <PanelRightOpen className="size-4" aria-hidden="true" />
                )}
              </button>
            )}
            <button
              type="button"
              disabled={positionLocked}
              aria-disabled={positionLocked || undefined}
              title={positionLocked ? POSITION_LOCKED_REASON : undefined}
              aria-describedby={positionLocked ? reasonId : undefined}
              className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
              onClick={(e) => {
                // PopoverContent は DOM 上は portal でも **React tree では行 cell の子** なので、
                // ここで止めないと select td の onClick (行選択トグル) まで伝播する。
                e.stopPropagation()
                // menu を閉じてから picker を開く (ColumnHeaderMenu と同規約: 項目 click 後は
                // open state で閉じる)。picker 内への focus 移動でも Radix は閉じるが、
                // その focus 挙動に menu の開閉を依存させない。
                setMenuOpen(false)
                setPickerOpen(true)
              }}
            >
              {PULL_INTO_MENU_ITEM_LABEL}
            </button>
            {positionLocked && (
              <p id={reasonId} className="px-2 py-1 text-xs text-muted-foreground">
                {POSITION_LOCKED_REASON}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {pickerOpen && (
        <PullIntoDialog
          userId={userId}
          currentExamId={currentExamId}
          anchorCard={anchorCard}
          pending={pending}
          onPullInto={onPullInto}
          onClose={closePicker}
        />
      )}
    </>
  )
}

function PullIntoDialog({
  userId,
  currentExamId,
  anchorCard,
  pending,
  onPullInto,
  onClose,
}: {
  userId: string
  currentExamId: string
  anchorCard: ClientCard
  pending: boolean
  onPullInto: PullIntoDispatch
  /** 閉じる + focus を行メニュー trigger へ戻す (親が 1 箇所で持つ)。 */
  onClose: () => void
}) {
  const baseId = React.useId()
  const titleId = `${baseId}-title`
  const sourceSelectId = `${baseId}-source`

  const [sourceExamId, setSourceExamId] = React.useState('')
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set())
  const [error, setError] = React.useState<string | null>(null)

  const sourceSelectRef = React.useRef<HTMLSelectElement>(null)

  // open 時に先頭の入力へ focus を移す (ConfirmDialog は confirm へ移すが、ここは
  // 未選択で confirm が disabled のため source select が先頭)。
  // **復帰は dialog 側で持たない**: mount 時の activeElement は同じ commit で消える
  // menu 項目で、detached node への focus() は no-op になる (ConfirmDialog が成立するのは
  // trigger が mount され続ける構造だから)。復帰先の trigger を知っているのは親なので
  // onClose に畳んである。
  React.useEffect(() => {
    sourceSelectRef.current?.focus()
  }, [])

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // 取り込み元候補 = mirror の自分の exam ∖ 現 exam。現 exam を残すと「自分から自分へ
  // 取り込む」= anchor 自身を含みうる無意味な操作になるため候補から外す (spec §7.2)。
  // 並びは移動先 select (§7.1) と同じ updated_at desc。
  const exams = useLiveQuery(async () => {
    const rows = await getClientDb().exams.where('user_id').equals(userId).toArray()
    return rows
      .filter((exam) => exam.id !== currentExamId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }, [userId, currentExamId])

  // 選択中の exam が (削除等で) 候補から消えたら先頭に落とす。
  const effectiveSourceId = (exams ?? []).some((exam) => exam.id === sourceExamId)
    ? sourceExamId
    : (exams?.[0]?.id ?? '')

  // owner scope は compound index の第 1 要素で構造保証する (move popover と同じ経路)。
  const sourceCards = useLiveQuery(async () => {
    if (effectiveSourceId === '') return []
    const rows = await getClientDb()
      .cards.where('[user_id+exam_id]')
      .equals([userId, effectiveSourceId])
      .toArray()
    return rows.sort(compareByBaseOrder)
  }, [userId, effectiveSourceId])

  const cards = sourceCards ?? []
  const overLimit = cards.length > PULL_INTO_LIST_LIMIT
  // **表示中の source exam のリストから引く**のが D-9 (1 操作 1 source exam) の実装点:
  // 渡す cardIds は常に基準順 + 表示中 exam に実在する card だけになり、source を
  // 切り替えた後に残った選択や、その間に消えた card は自動的に落ちる。
  const pickedIds = cards.filter((card) => picked.has(card.id)).map((card) => card.id)
  // 上限超過時は checkbox を描画しないので pickedIds は必ず空になる (= overLimit 項は不要)。
  const canSubmit = !pending && pickedIds.length > 0

  const handleConfirm = async () => {
    setError(null)
    const message = await onPullInto(pickedIds, anchorCard.id)
    setError(message)
    if (message === null) onClose()
  }

  const content = (
    <div
      data-testid="pull-into-backdrop"
      // backdrop click で閉じる。panel 内 click は panel 側の stopPropagation で除外する。
      // ここでも伝播を止めるのは、dialog が portal でも **React tree では行 cell の子** で、
      // 止めないと select td の onClick (行選択トグル) まで届くため。
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="exam-card-pull-into-dialog"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-border bg-background p-6 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-bold text-foreground">
          {PULL_INTO_MENU_ITEM_LABEL}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          選んだカードを「{cardLabel(anchorCard)}」の直後に移動します。
          多数のカードを移動するときは、一括バーの「移動」を使ってください。
        </p>

        {exams !== undefined && exams.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            取り込める試験がありません。
          </p>
        ) : (
          <>
            <div className="mt-4 flex flex-col gap-1">
              <label htmlFor={sourceSelectId} className="text-sm font-medium">
                取り込み元の試験
              </label>
              <select
                id={sourceSelectId}
                ref={sourceSelectRef}
                value={effectiveSourceId}
                disabled={pending}
                onChange={(e) => setSourceExamId(e.target.value)}
                className="w-full rounded-md border border-border bg-background p-1.5 text-sm disabled:opacity-50"
              >
                {(exams ?? []).map((exam) => (
                  <option key={exam.id} value={exam.id}>
                    {exam.name}
                  </option>
                ))}
              </select>
            </div>

            {overLimit ? (
              <p
                data-testid="pull-into-over-limit"
                className="mt-4 text-sm text-muted-foreground"
              >
                {PULL_INTO_OVER_LIMIT_MESSAGE}
              </p>
            ) : (
              <div
                data-testid="pull-into-card-list"
                className="mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-auto"
              >
                {cards.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    この試験にはカードがありません。
                  </p>
                ) : (
                  cards.map((card) => (
                    <label key={card.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        value={card.id}
                        checked={picked.has(card.id)}
                        disabled={pending}
                        onChange={() =>
                          setPicked((prev) => {
                            const next = new Set(prev)
                            if (next.has(card.id)) next.delete(card.id)
                            else next.add(card.id)
                            return next
                          })
                        }
                      />
                      {cardLabel(card)}
                    </label>
                  ))
                )}
              </div>
            )}
          </>
        )}

        {error !== null && (
          <p
            data-testid="pull-into-error"
            role="alert"
            className="mt-3 text-xs text-red-600"
          >
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleConfirm()}>
            取り込む
          </Button>
        </div>
      </div>
    </div>
  )

  // SSR / マウント前は document が無いため inline 描画にフォールバックする
  // (ConfirmDialog と同型)。
  if (typeof document === 'undefined') return content
  return createPortal(content, document.body)
}

/**
 * カードの短い表示名 (picker の checkbox / DnD の読み上げ)。 question_label → title の順に
 * **trim 後の最初の非空**を採り、どちらも空なら「(無題)」。 `??` 単独だと空白のみの
 * question_label が左辺として選ばれ、title があるのに「(無題)」になる (空文字は編集経路が
 * null 正規化するが、空白のみはすり抜ける — inline-text-field.tsx の commit 正規化)。
 * 行 DnD の announcements (exam-card-table.tsx) も同じ文言で読み上げる必要があるので、
 * 両者はこの 1 定義を import して共有する。
 */
export function cardLabel(card: ClientCard): string {
  const text =
    [card.question_label, card.title]
      .map((value) => value?.trim() ?? '')
      .find((value) => value.length > 0) ?? '(無題)'
  return text.length > CARD_LABEL_MAX ? `${text.slice(0, CARD_LABEL_MAX)}…` : text
}
