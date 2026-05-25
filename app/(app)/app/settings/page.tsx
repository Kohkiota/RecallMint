import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { userSettings } from '@/lib/db/schema'
import { createBillingPortalSession } from './actions'
import { DeleteAccountButton } from './delete-button'
import { SessionLimitForm } from './_components/session-limit-form'
import { FsrsModeForm } from './_components/fsrs-mode-form'
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

  // 学習設定: user_settings を owner-scoped SELECT (行不在は sessionLimit=20 の暫定値)
  const db = getDb()
  const settingsRows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, user.id))
    .limit(1)
  const sessionLimit = settingsRows[0]?.sessionLimit ?? 20
  const fsrsMode = settingsRows[0]?.fsrsMode ?? false

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

      {/* 学習設定 section — プランの次、危険な操作の前 */}
      <section>
        <h2 className="font-bold mb-2">学習設定</h2>
        <Card>
          <CardContent>
            <p className="text-sm text-slate-700 mb-3">
              1 セッションあたりの最大 card 数
            </p>
            <SessionLimitForm initial={sessionLimit} />

            <div className="mt-6 border-t border-slate-200 pt-4">
              <p className="text-sm text-slate-700 mb-1">回答評価の入力方式</p>
              <p className="text-xs text-slate-500 mb-3">
                オフ: 正誤を自動で FSRS rating にマッピング。
                オン: Again/Hard/Good/Easy を自分で選択 (上級者向け)。
              </p>
              <FsrsModeForm initial={fsrsMode} />
            </div>
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
            {/* S-perf-1: 法的 4 link は閲覧率が低く、 全件 default prefetch すると
                settings page 表示時の並列 RSC SSR を 4 件積み増す。 prefetch={false}
                で抑制 (click 時の遷移は維持)。 */}
            <ul className="text-sm text-slate-700 space-y-2">
              <li>
                <Link href="/contact" prefetch={false} className="text-blue-700 hover:underline">
                  お問い合わせ
                </Link>
              </li>
              <li>
                <Link href="/terms" prefetch={false} className="text-blue-700 hover:underline">
                  利用規約
                </Link>
              </li>
              <li>
                <Link href="/privacy" prefetch={false} className="text-blue-700 hover:underline">
                  プライバシーポリシー
                </Link>
              </li>
              <li>
                <Link href="/legal" prefetch={false} className="text-blue-700 hover:underline">
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
