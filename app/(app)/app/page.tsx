import Link from 'next/link'
import { and, count, eq, lte } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { cards } from '@/lib/db/schema'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getReviewStatsForUser } from '@/lib/db/streak'
import { Card, CardContent } from '@/components/ui/card'
import { DashboardActions } from './_components/dashboard-actions'

export default async function Dashboard() {
  const user = await getCurrentUser()
  if (!user) return null
  const db = getDb()

  const [dueRow] = await db
    .select({ c: count() })
    .from(cards)
    .where(and(eq(cards.userId, user.id), lte(cards.due, new Date())))
  const dueCount = Number(dueRow?.c ?? 0)
  const { todayCardCount, streak } = await getReviewStatsForUser(user.id)

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">こんにちは</h1>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">今日の学習問題数</div>
            <div className="text-3xl font-bold">{todayCardCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">連続日数</div>
            <div className="text-3xl font-bold">{streak} 日</div>
          </CardContent>
        </Card>
      </div>

      <DashboardActions dueCount={dueCount} />

      {/* 最上位 (Pro 年額) 以外は upgrade CTA を表示。 Free / Standard 月年 /
          Pro 月 すべてに上位選択肢があるため画一的に「アップグレード」と表示し、
          具体的な上位 plan の選択は /app/upgrade page 内 toggle に委ねる。 */}
      {!(user.plan === 'pro' && user.billingInterval === 'year') && (
        <Link
          href="/app/upgrade"
          prefetch={false}
          className="block mt-4 text-center text-sm text-slate-600 underline"
        >
          アップグレード
        </Link>
      )}
    </div>
  )
}
