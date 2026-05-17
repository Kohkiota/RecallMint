import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { createBillingPortalSession } from './actions'
import { DeleteAccountButton } from './delete-button'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { planLabelFor } from '@/lib/plan-catalog'

// 解約予定日を日本語ロケールの YYYY/MM/DD 形式に整形する
// Intl.DateTimeFormat を使い、ロケール依存の区切り文字を統一する
function formatCancelDate(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export default async function SettingsPage() {
  const user = await getCurrentUser()
  if (!user) return null

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">設定</h1>

      <section>
        <h2 className="font-bold mb-2">プラン</h2>
        <Card>
          <CardContent>
            <p className="text-sm text-slate-700">
              現在: <span className="font-medium">{planLabelFor(user.plan, user.billingInterval)}</span>
            </p>
            {user.plan !== 'free' && user.cancelAt ? (
              // 解約予約中: cancel_at != null が解約予約中の signal
              <p className="text-xs text-amber-700 mt-1">
                解約予約中、{formatCancelDate(user.cancelAt)} 終了
              </p>
            ) : user.subscriptionStatus ? (
              <p className="text-xs text-slate-500 mt-1">
                ステータス: {user.subscriptionStatus}
              </p>
            ) : null}
            {user.plan === 'free' ? (
              <Button asChild size="sm" className="mt-3 px-4 py-2 text-sm font-medium">
                <Link href="/app/upgrade">プランを選択</Link>
              </Button>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <form action={createBillingPortalSession}>
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    className="px-4 py-2 text-sm font-medium"
                  >
                    お支払い・解約を管理
                  </Button>
                </form>
                {/* Pro 年額以外 (= 最上位以外) は upgrade page でさらに上の plan に
                    切替可能。 Pro 年額のときは upgrade page が /app へ redirect する
                    ので CTA を表示しない。 */}
                {!(user.plan === 'pro' && user.billingInterval === 'year') && (
                  <Button asChild size="sm" className="px-4 py-2 text-sm font-medium">
                    <Link href="/app/upgrade">アップグレード</Link>
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="font-bold mb-2 text-red-700">危険な操作</h2>
        <Card className="ring-red-200">
          <CardContent>
            <p className="text-sm text-slate-700 mb-3">
              アカウントを削除します。登録したカードと学習履歴は復元できません。
            </p>
            <DeleteAccountButton plan={user.plan} />
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="font-bold mb-2">法的情報</h2>
        <Card>
          <CardContent>
            <ul className="text-sm text-slate-700 space-y-2">
              <li>
                <Link href="/contact" className="text-blue-700 hover:underline">
                  お問い合わせ
                </Link>
              </li>
              <li>
                <Link href="/terms" className="text-blue-700 hover:underline">
                  利用規約
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="text-blue-700 hover:underline">
                  プライバシーポリシー
                </Link>
              </li>
              <li>
                <Link href="/legal" className="text-blue-700 hover:underline">
                  特定商取引法に基づく表記
                </Link>
              </li>
            </ul>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
