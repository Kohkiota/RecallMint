import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { createCheckoutSession } from './actions'
import { Button } from '@/components/ui/button'

export default async function UpgradePage() {
  const user = await getCurrentUser()
  if (!user) return null
  // TODO(post-A-3.2): 3 プラン (free/standard/pro) UI 対応。
  // 現状は 'standard' 流入時に redirect されず Pro 加入 CTA を表示する誤動作あり。
  // Stripe checkout 拡張 Sprint で UI 改修 (Standard / Pro 別 plan カード分岐)。
  if (user.plan === 'pro') redirect('/app')

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Pro プラン</h1>
      <p className="text-slate-700 mb-4">
        月 <span className="font-bold text-3xl">¥500</span> / 月
      </p>
      <ul className="space-y-1 text-sm text-slate-700 mb-6">
        <li>✅ AI OCR ページ数 30 / 月 → <strong>公平利用</strong></li>
        <li>✅ 教材 PDF / 画像から問題を自動生成</li>
        <li>✅ いつでもキャンセル可能（期間終了時解約）</li>
      </ul>
      <form action={createCheckoutSession}>
        <Button
          type="submit"
          size="lg"
          className="w-full py-3 rounded-xl font-bold"
        >
          Pro に加入する
        </Button>
      </form>
    </div>
  )
}
