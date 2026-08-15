'use client'

// ExamCardSidePeek: テーブル行の単票を右スライドパネル(side peek)で開く presentational component。
// radix Dialog non-modal + Portal overlay。 状態を持たない(状態 owner は ExamCardTable / 幅の
// 永続 owner は exam-detail-view — 下記 UI fix C 参照)。
//
// 設計:
// - open={row !== null} / modal={false} / onOpenChange 一元 close → Esc・× ともにここを通る。
// - onInteractOutside は preventDefault → 外クリックでは閉じない(テーブルセル編集との共存)。
// - key={row.card.id} を Dialog.Content 直下 div に付与 → card 切替で編集 state をリセット。
//   Dialog.Content 自体には key を付けない(スライドアニメ・focus 移動が破綻するため)。
// - row/cardTags の card_id 整合は親(T3)責務。row=null 時は Dialog 非 open のため本文非描画。
//
// UI fix C (幅リサイズ + 永続化):
// - widthVw は controlled prop(exam-detail-view が単一所有 + examViewPrefs V4 永続)。 本
//   component は「確定値」のみを onWidthChange 経由で通知し、 直接 setJsonSyncMeta は呼ばない
//   (第 2 の永続経路を作らない)。
// - ドラッグ中の中間値は liveDragWidthVw(ローカル state)に留め、 pointerup で 1 回だけ
//   onWidthChange(確定値) を呼ぶ。 矢印キーは 1 打鍵 = 1 確定(都度 onWidthChange)。
// - モバイル(<md)は従来どおり w-full 固定 + handle 非表示(hidden md:block — 誤タッチ防止、
//   CSS のみで構造的に担保し JS 分岐を持たない)。
// - fix round 1: handle は Dialog.Content の**最後の子**(絶対配置なので見た目は不変)。
//   radix の FocusScope mount effect は tabbable な最初の DOM 候補へ autofocus するため、
//   handle が先頭にあると open 直後の focus が「閉じる」でなく handle に奪われる regression が
//   あった(onOpenAutoFocus を触るのは Dialog 契約凍結に抵触するため DOM 順で解消)。
// - fix round 1: ドラッグの pointermove ハンドラは setState updater の中で親の onWidthChange
//   (別 component の setState)を呼ばない(StrictMode 二重実行で render 中 setState になり得る)。
//   最新値は gesture 内の平の変数 latestWidthVw に持ち、handler 外(pointerup/cancel)で通知する。
// - fix round 1: pointerup に加え pointercancel(OS ジェスチャ中断等)・unmount(peek が閉じる等)
//   でも window listener を確実に外す。 cancel/unmount は「中断」= onWidthChange を呼ばない
//   (確定は pointerup のみ)。

import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ClientCardTag, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { PEEK_WIDTH_MIN_VW, PEEK_WIDTH_MAX_VW, clampPeekWidthVw } from '@/lib/sync/sync-meta'

import type { ExamCardRow } from './exam-card-table-columns'
import { InlineTextField } from './inline-text-field'
import { CardEditorFields } from './card-editor-fields'

// ---------------------------------------------------------------------------
// UI fix C: 幅計算 pure 関数群 — jsdom で直接 unit test するため component から切り出す
// (exam-card-table.tsx の computeCollapsed と同じ方針)。
// ---------------------------------------------------------------------------

/** 矢印キー 1 打鍵あたりの変化量(vw)。 UI の「触感」定数のため schema 側(sync-meta.ts)には置かない。 */
export const PEEK_WIDTH_KEYBOARD_STEP_VW = 5

/**
 * ドラッグ開始時の幅(vw) + pointer 移動量(px, 左方向が正) + viewport 幅(px) から
 * 新しい幅(vw)を計算し、25〜70vw にクランプして返す。
 * panel は右端固定(right-0)・handle は左端にあるため、handle を左へ引く(deltaPx>0)ほど
 * 幅が増える。 viewportWidthPx<=0(異常値)は変化なしとして startWidthVw をそのまま返す。
 */
export function computeDraggedPeekWidthVw(
  startWidthVw: number,
  deltaPx: number,
  viewportWidthPx: number,
): number {
  if (viewportWidthPx <= 0) return clampPeekWidthVw(startWidthVw)
  const deltaVw = (deltaPx / viewportWidthPx) * 100
  return clampPeekWidthVw(startWidthVw + deltaVw)
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ExamCardSidePeekProps = {
  /** null = closed。row/cardTags の card_id 整合は親(T3)責務 */
  row: ExamCardRow | null
  /** 当該 card の raw card_tags。CardTagsSection へそのまま渡す */
  cardTags: ClientCardTag[]
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  userId: string
  onClose: () => void
  /** UI fix C: panel 幅(vw)。 exam-detail-view が単一所有する controlled 値(既に clamp 済の前提)。 */
  widthVw: number
  /** UI fix C: ドラッグ確定 / 矢印キー操作の確定値を通知する(中間値は通知しない)。 */
  onWidthChange: (vw: number) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExamCardSidePeek({
  row,
  cardTags,
  categories,
  options,
  userId,
  onClose,
  widthVw,
  onWidthChange,
}: ExamCardSidePeekProps): React.JSX.Element | null {
  // UI fix C: ドラッグ中の中間値。 非 null の間は表示幅をこちらが上書きする(controlled prop
  // widthVw は pointerup で onWidthChange 経由の確定を受けて追従する)。
  const [liveDragWidthVw, setLiveDragWidthVw] = React.useState<number | null>(null)
  const displayWidthVw = liveDragWidthVw ?? widthVw

  // fix round 1 (③): 進行中 gesture の後始末 (listener 除去) を unmount 時にも必ず走らせるための
  // ref。 pointerup/pointercancel で自ら null に戻す (unmount 時の cleanup が二重除去しないよう)。
  const activeDragCleanupRef = React.useRef<(() => void) | null>(null)
  React.useEffect(() => {
    return () => {
      activeDragCleanupRef.current?.()
    }
  }, [])

  // handle pointerdown: gesture 単位で window リスナーを張り、pointerup/pointercancel/unmount の
  // いずれでも除去する(setPointerCapture は使わない — 単純な単一 panel の drag には過剰、かつ
  // jsdom 未実装)。
  const handleResizePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return // primary button のみ
      event.preventDefault()
      // fix round 1 (⑤): pointerdown 自体は既定では focus を伴わないため明示 focus する。
      // ドラッグ直後に矢印キーで微調整できるようにする(select-none 済みなのでテキスト選択
      // 抑止は preventDefault に依存しない)。
      event.currentTarget.focus()
      const startClientX = event.clientX
      const startWidthVw = widthVw
      const viewportWidthPx = window.innerWidth
      // fix round 1 (②): setLiveDragWidthVw の updater 内で onWidthChange (親 ExamDetailView の
      // setState) を呼ぶと、updater は pure でなければならない契約に反する。 StrictMode(dev)は
      // updater を 2 回評価し、2 回目は React が「render 中」と扱う文脈で走るため
      // 「別 component を render 中に更新した」dev error になり得る。 最新値は gesture 内の
      // 平の変数に保持し、handler(pointerup/cancel)の外側で通知する。
      let latestWidthVw: number | null = null

      function handleMove(moveEvent: PointerEvent) {
        const deltaPx = startClientX - moveEvent.clientX
        latestWidthVw = computeDraggedPeekWidthVw(startWidthVw, deltaPx, viewportWidthPx)
        setLiveDragWidthVw(latestWidthVw)
      }
      // commit=true (pointerup) のみ確定。 commit=false (pointercancel / unmount) は「動かした
      // 事実はあっても中断」として onWidthChange を呼ばない(採った方 — cancel は非確定)。
      function stopDrag(commit: boolean) {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        window.removeEventListener('pointercancel', handleCancel)
        activeDragCleanupRef.current = null
        setLiveDragWidthVw(null)
        if (commit && latestWidthVw !== null) onWidthChange(latestWidthVw)
      }
      function handleUp() {
        stopDrag(true)
      }
      function handleCancel() {
        stopDrag(false)
      }

      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
      window.addEventListener('pointercancel', handleCancel)
      activeDragCleanupRef.current = () => stopDrag(false)
    },
    [widthVw, onWidthChange],
  )

  // handle 矢印キー: 1 打鍵 = 1 確定 (ドラッグと異なり中間値を持たない)。
  const handleResizeKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const delta = event.key === 'ArrowLeft' ? PEEK_WIDTH_KEYBOARD_STEP_VW : -PEEK_WIDTH_KEYBOARD_STEP_VW
      onWidthChange(clampPeekWidthVw(widthVw + delta))
    },
    [widthVw, onWidthChange],
  )

  return (
    <DialogPrimitive.Root
      open={row !== null}
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          // InlineOptionCell は blur 時のみ commit し commit-on-unmount を持たない。
          // React がサブツリーを unmount する前に activeElement を明示的に blur して
          // 編集中の option cell 入力値を保存する(× ボタン経由でも同じ経路を通る)。
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          onClose()
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 right-0 z-[45] w-full md:w-[var(--peek-width-vw)]',
            'flex flex-col',
            'bg-background border-l shadow-lg',
            'data-open:animate-in data-open:slide-in-from-right',
            'data-closed:animate-out data-closed:slide-out-to-right',
            'duration-200 motion-reduce:transition-none',
          )}
          style={{ '--peek-width-vw': `${displayWidthVw}vw` } as React.CSSProperties}
          onInteractOutside={(event) => {
            event.preventDefault()
          }}
        >
          {/* a11y: Dialog.Title は常に存在させる(radix が require する) */}
          <DialogPrimitive.Title className="sr-only">
            {row?.card.title || 'カード'}
          </DialogPrimitive.Title>
          {/* a11y: Dialog.Description でラジックス dev 警告を消す */}
          <DialogPrimitive.Description className="sr-only">
            カードの内容を確認・編集できます。
          </DialogPrimitive.Description>

          {/* ヘッダー: × ボタン。flex-none で本文スクロール中もピン留め */}
          <header className="flex flex-none items-center justify-end border-b px-3 py-2">
            <DialogPrimitive.Close
              aria-label="閉じる"
              className="rounded-md p-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </header>

          {/* 本文: key={row.card.id} で card 切替時に remount → 編集 state をリセット。
              flex-1 min-h-0 で残り高さを占有し overflow-y-auto でスクロール可能にする。
              card 切替は必ずトリガー button(T2)click 起点で、click が focus を button へ移す
              = 編集中 option cell input が blur→commit してから本 remount が走る。よって
              切替時の option 編集消失は onOpenChange の明示 blur(close 経路)ではなく DOM の
              focus 移動で担保される(T3 テストで検証)。 */}
          {row !== null && (
            <div key={row.card.id} className="flex-1 min-h-0 overflow-y-auto">
              <div className="space-y-3 p-4">
                <div>
                  <p className="text-xs font-medium text-slate-500">番号</p>
                  <InlineTextField
                    cardId={row.card.id}
                    userId={userId}
                    field="question_label"
                    initialValue={row.card.question_label ?? null}
                    ariaLabel="番号 編集"
                    placeholder="(番号)"
                    displayClassName="text-xs font-mono text-slate-600"
                  />
                </div>

                <div>
                  <p className="text-xs font-medium text-slate-500">タイトル</p>
                  <InlineTextField
                    cardId={row.card.id}
                    userId={userId}
                    field="title"
                    initialValue={row.card.title}
                    ariaLabel="タイトル 編集"
                    displayClassName="text-sm font-medium text-slate-900"
                  />
                </div>

                {/* タグ + 問題文 + 選択肢 + 解説 + メモ の後段フィールド列は inline-card-list と
                    共有 (P3 W4)。cardTags は親(T3)が card_id 整合させた raw をそのまま透過。
                    autoEditOnMount は side-peek では不要(未指定 = 既定 false)。 */}
                <CardEditorFields
                  cardId={row.card.id}
                  userId={userId}
                  categories={categories}
                  tagOptions={options}
                  cardTags={cardTags}
                  questionText={row.card.question_text}
                  options={row.card.options}
                  explanationText={row.card.explanation_text ?? null}
                  memo={row.card.memo ?? null}
                  images={row.card.images}
                />
              </div>
            </div>
          )}

          {/* UI fix C: リサイズ handle — panel 左端。 md 以上のみ描画(hidden md:block はモバイル
              誤タッチ防止を CSS のみで構造的に担保、JS 分岐を持たない = spec の「モバイル不壊」)。
              role=separator + aria-orientation=vertical + aria-valuenow/min/max + 矢印キーで
              永続される設定値であることを SR に伝える(列幅リサイズ handle は非永続ゆえ
              aria-hidden の装飾扱いだが、こちらは異なる)。
              fix round 1 (①): Dialog.Content の**最後の子**に置く(absolute 配置なので見た目は
              不変)。 radix FocusScope の mount autofocus は DOM 順で最初の tabbable 候補へ移る
              ため、handle が先頭だと open 直後の focus が「閉じる」でなく handle に奪われる
              regression があった。 最後の子にすることで「閉じる」が最初の tabbable 候補に戻る。 */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="パネル幅を変更"
            aria-valuenow={Math.round(displayWidthVw)}
            aria-valuemin={PEEK_WIDTH_MIN_VW}
            aria-valuemax={PEEK_WIDTH_MAX_VW}
            tabIndex={0}
            className={cn(
              'hidden md:block absolute inset-y-0 left-0 z-10 w-1.5',
              'cursor-col-resize touch-none select-none',
              'hover:bg-accent focus-visible:bg-ring focus-visible:outline-none',
            )}
            onPointerDown={handleResizePointerDown}
            onKeyDown={handleResizeKeyDown}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
