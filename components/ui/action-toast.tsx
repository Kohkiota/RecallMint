'use client'

import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'

// ActionToast — 操作 1 件に対する一過性の通知 + 取り消し操作 1 個 (Grid-3 spec §7.5)。
//
// billing-banner.tsx の bespoke 実装 (fixed 配置 / role="status" aria-live="polite" /
// auto-dismiss) を下敷きにした最小 component。外部 toast ライブラリ (sonner 等) は
// 導入しない。
//
// 表示 state は呼出元 component が持つ (グローバル store / context を作らない —
// 表示面は exam 詳細と試験一覧の 2 箇所だけ)。本 component は controlled:
// auto-dismiss も閉じるボタンも `onClose` を呼ぶだけで、自前の非表示 state を持たない
// (呼出元が unmount する = undo 素材の破棄と同じ 1 箇所で起きる)。
//
// **連続表示は単一 slot で最新に置換する**: 呼出元は toast state を 1 つだけ持ち、
// 新しい操作で上書きする。
//
// 旧 timer の clear が本 component 側で成立する範囲は **`message` が変わったとき /
// unmount したとき** の 2 つだけ (どちらも timer effect の cleanup が走る)。
// **同一文言を連続表示する呼出元は `key` に操作 id を渡して remount させること** —
// message が同値だと effect が再実行されず、置換時に 15 秒が再カウントされないまま
// 前の toast の timer で閉じる (この境界は test で pin してある)。
// この 1 点だけが呼出元の規律に依存する = 本 component 単体では保証しない。

// 自動 dismiss までの時間。billing-banner の 4.5 秒は undo の判断に短すぎる (spec §7.5)。
export const ACTION_TOAST_AUTO_DISMISS_MS = 15_000

type Props = {
  message: string
  /** action button の label。`onAction` と揃って初めて button を描画する。 */
  actionLabel?: string
  onAction?: () => void
  /** 二度押し防止は親の責務: 発行中は true を渡して button を disabled にする。 */
  actionPending?: boolean
  onClose: () => void
}

export function ActionToast({
  message,
  actionLabel,
  onAction,
  actionPending = false,
  onClose,
}: Props) {
  // onClose は呼出元の inline arrow で毎 render identity が変わりうる。timer effect の
  // 依存に入れると再 render のたびに 15 秒が張り直され auto-dismiss が起きなくなるため、
  // latest-ref に逃がす (use-bulk-card-tags と同じ pattern)。
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // auto-dismiss。cleanup が旧 timer を clear するので、message 差し替え (置換) でも
  // unmount でも古い timer は生き残らない。**同一 message での置換は effect が再実行
  // されない** ため、呼出元が `key` を変えて remount させる規約 (冒頭 banner)。
  useEffect(() => {
    const timer = window.setTimeout(
      () => onCloseRef.current(),
      ACTION_TOAST_AUTO_DISMISS_MS,
    )
    return () => window.clearTimeout(timer)
  }, [message])

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        'fixed top-4 left-1/2 z-50 -translate-x-1/2',
        'flex max-w-[90vw] items-center gap-3',
        'rounded-lg border border-border bg-background px-4 py-2 shadow-lg',
        'text-sm text-foreground',
      ].join(' ')}
    >
      <span className="flex-1">{message}</span>
      {actionLabel && onAction ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAction}
          disabled={actionPending}
        >
          {actionLabel}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="閉じる"
        onClick={onClose}
      >
        ×
      </Button>
    </div>
  )
}
