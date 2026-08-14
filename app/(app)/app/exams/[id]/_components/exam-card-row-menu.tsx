// ExamCardRowMenu — 行メニュー「ここに取り込む」 (UI 入口 c) と取り込み picker。
// Grid-3 spec §7.2 / §7.4 / D-9。
//
// 構成:
//   ExamCardRowMenu … select セル内の ⋯ trigger + Radix Popover の menu。項目は
//     「ここに取り込む」1 つだけ (ColumnHeaderMenu と同じ Popover wrapper・同じ項目 markup)。
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
import { MoreHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { compareByBaseOrder } from '@/lib/cards/domain/card-order'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { POSITION_LOCKED_REASON } from './exam-card-move-popover'

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
}

export function ExamCardRowMenu({
  userId,
  currentExamId,
  anchorCard,
  positionLocked,
  pending,
  onPullInto,
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

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`行メニュー: ${anchorCard.title}`}
            // select td 全域の onClick (行選択トグル) への bubbling を止める
            // (checkbox / 「カードを開く」と同理由)。Radix 自身の toggle は
            // defaultPrevented を見るので stopPropagation では止まらない。
            onClick={(e) => e.stopPropagation()}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <div className="flex flex-col" data-testid="exam-card-row-menu">
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

function cardLabel(card: ClientCard): string {
  const raw = (card.question_label ?? card.title ?? '').trim()
  const text = raw.length > 0 ? raw : '(無題)'
  return text.length > CARD_LABEL_MAX ? `${text.slice(0, CARD_LABEL_MAX)}…` : text
}
