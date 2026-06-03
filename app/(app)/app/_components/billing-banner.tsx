'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

// /app?billing=<kind> の kind に応じた一過性の通知 banner。
// kind は SSR 安全に server component (page.tsx) で searchParams から抽出し prop で
// 渡す。これにより useSearchParams (Next 15 で Suspense 必須) を避けられる。本
// component が client なのは dismiss 状態を持つためだけ。
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

export function BillingBanner({ kind }: { kind: string | undefined }) {
  const [dismissed, setDismissed] = useState(false)

  const message = kind ? COPY[kind] : undefined
  if (!message || dismissed) return null

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2"
    >
      <span className="flex-1">{message}</span>
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
