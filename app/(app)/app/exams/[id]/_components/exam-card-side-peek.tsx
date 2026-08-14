'use client'

// ExamCardSidePeek: テーブル行の単票を右スライドパネル(side peek)で開く presentational component。
// radix Dialog non-modal + Portal overlay。 状態を持たない(状態 owner は ExamCardTable)。
//
// 設計:
// - open={row !== null} / modal={false} / onOpenChange 一元 close → Esc・× ともにここを通る。
// - onInteractOutside は preventDefault → 外クリックでは閉じない(テーブルセル編集との共存)。
// - key={row.card.id} を Dialog.Content 直下 div に付与 → card 切替で編集 state をリセット。
//   Dialog.Content 自体には key を付けない(スライドアニメ・focus 移動が破綻するため)。
// - row/cardTags の card_id 整合は親(T3)責務。row=null 時は Dialog 非 open のため本文非描画。

import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ClientCardTag, ClientTagCategory, ClientTagOption } from '@/lib/client-db'

import type { ExamCardRow } from './exam-card-table-columns'
import { InlineTextField } from './inline-text-field'
import { CardEditorFields } from './card-editor-fields'

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
}: ExamCardSidePeekProps): React.JSX.Element | null {
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
            'fixed inset-y-0 right-0 z-[45] w-full md:w-[480px]',
            'flex flex-col',
            'bg-background border-l shadow-lg',
            'data-open:animate-in data-open:slide-in-from-right',
            'data-closed:animate-out data-closed:slide-out-to-right',
            'duration-200 motion-reduce:transition-none',
          )}
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
