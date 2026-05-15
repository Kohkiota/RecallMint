import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { createCheckoutSession } from './actions'
import { Button } from '@/components/ui/button'

export default async function UpgradePage() {
  const user = await getCurrentUser()
  if (!user) return null
  // If already Pro, there's nothing to upgrade — bounce to settings (Task 6.3
  // will land /app/settings). For now send them to /app since /app/settings
  // does not yet exist.
  if (user.plan === 'pro') redirect('/app')

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Pro プラン</h1>
      <p className="text-slate-700 mb-4">
        月 <span className="font-bold text-3xl">¥500</span> / 月
      </p>
      <ul className="space-y-1 text-sm text-slate-700 mb-6">
        <li>✅ 登録単語数 100 → <strong>2,000</strong></li>
        <li>✅ AI 例文生成 10/日 → <strong>100/日</strong></li>
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
