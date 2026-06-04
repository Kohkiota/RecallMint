'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

// /app?billing=<kind> の kind に応じた一過性の通知 toast。
// kind は SSR 安全に server component (page.tsx) で searchParams から抽出し prop で
// 渡す (useSearchParams + Next 15 Suspense を避ける)。本 component が client なのは
// auto-dismiss timer / URL クリーン / dismiss 状態を持つため。
//
// 文言は金額を含めない (§7 方針)。未知/未指定 kind は描画しない。
// cancel は §7.5「Portal 経路。MVP では Portal return、本 banner 統合は任意」に基づく
// 先行予約。現時点でキャンセルフローは Stripe Billing Portal の return URL 経由のため
// ?billing=cancel を生成するルートは存在しない。将来の Portal return 統合時に有効化。
const COPY: Record<string, string> = {
  new: '決済を受け付けました。反映まで少し時間がかかる場合があります。',
  upgrade: '支払い確認後にプランが反映されます。',
  downgrade: '現在の請求期間終了後にプランが変更されます。',
  cancel: '現在の請求期間終了後に Free へ戻ります。',
}

// 自動 fade out までの時間と fade 自体の duration (ms)。 dismissed=true で unmount。
const AUTO_DISMISS_MS = 4500
const FADE_DURATION_MS = 500

export function BillingBanner({ kind }: { kind: string | undefined }) {
  const [dismissed, setDismissed] = useState(false)
  // fading=true で opacity-0 へ遷移、 FADE_DURATION_MS 経過後に dismissed で unmount。
  const [fading, setFading] = useState(false)

  const message = kind ? COPY[kind] : undefined

  useEffect(() => {
    if (!message) return
    // ?billing= を URL から除去 — reload での再発火を止める。 Next router を介さず
    // history API を直接使う (RSC 再 fetch 不要、 message は state に latch 済)。
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      if (url.searchParams.has('billing')) {
        url.searchParams.delete('billing')
        window.history.replaceState(null, '', url.pathname + url.search + url.hash)
      }
    }
    const fadeAt = window.setTimeout(() => setFading(true), AUTO_DISMISS_MS)
    const removeAt = window.setTimeout(
      () => setDismissed(true),
      AUTO_DISMISS_MS + FADE_DURATION_MS,
    )
    return () => {
      window.clearTimeout(fadeAt)
      window.clearTimeout(removeAt)
    }
  }, [message])

  if (!message || dismissed) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        'fixed top-4 left-1/2 -translate-x-1/2 z-50',
        'flex items-center justify-center gap-3 max-w-[90vw]',
        'text-sm text-center text-amber-700',
        'bg-amber-50 border border-amber-200 rounded-md shadow-md px-4 py-2',
        'transition-opacity duration-500',
        fading ? 'opacity-0' : 'opacity-100',
      ].join(' ')}
    >
      <span className="flex-1 text-center">{message}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="閉じる"
        onClick={() => setDismissed(true)}
        className="text-amber-700 hover:bg-amber-100 hover:text-amber-900"
      >
        ×
      </Button>
    </div>
  )
}
