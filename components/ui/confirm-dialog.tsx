'use client'

import * as React from 'react'
import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button, buttonVariants } from '@/components/ui/button'

// buttonVariants の variant 名を再利用 (default/outline/destructive 等)。
type ButtonVariant = NonNullable<
  Parameters<typeof buttonVariants>[0]
>['variant']

type Props = {
  open: boolean
  title: string
  description: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
  confirmVariant?: ButtonVariant
}

// 世界観統一の軽量確認 modal。window.confirm はブラウザ chrome に依存し
// world / 文言を統一できないため自前で持つ。plan 非依存の汎用 component とし、
// 文言は呼出側から props で渡す。a11y は focus 移動 / Esc / backdrop close を最低限担保。
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'キャンセル',
  onConfirm,
  onCancel,
  confirmVariant = 'default',
}: Props) {
  const titleId = useId()
  const descId = useId()
  const confirmRef = useRef<HTMLButtonElement>(null)
  // close 時に呼出元 (CTA) へ focus を戻すため、open 直前の active element を退避。
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // open 時: 直前の focus 退避 + confirm へ focus 移動。close/unmount 時: focus 復帰。
  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()
    return () => {
      previouslyFocused.current?.focus()
    }
  }, [open])

  // Esc で onCancel。document level で listen し、focus 位置に依らず閉じられる。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  const content = (
    <div
      data-testid="confirm-dialog-backdrop"
      // backdrop click で閉じる。panel 内 click は stopPropagation で除外する。
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-bold text-foreground">
          {title}
        </h2>
        <div id={descId} className="mt-2 text-sm text-slate-600">
          {description}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={confirmVariant}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )

  // SSR / マウント前は document が無いため inline 描画にフォールバックせず、
  // client 確定後に body へ portal する ('use client' + 条件描画で client 限定)。
  if (typeof document === 'undefined') return content
  return createPortal(content, document.body)
}
