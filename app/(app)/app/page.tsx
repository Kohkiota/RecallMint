import Link from 'next/link'
import { and, count, eq, lte } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { cards } from '@/lib/db/schema'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { DashboardActions } from './_components/dashboard-actions'
import { DashboardStats } from './_components/dashboard-stats'
import { PullTrigger } from './_components/pull-trigger'

// S-perf-2 T4: stats (todayCardCount / streak) を `<DashboardStats />` 経由の
// /api/dashboard/stats に分離。 dueCount は CTA enable 判定に必要なので server
// SSR に残置 (1 SELECT で軽量、 cards_due_idx 走査)。 `getReviewStatsForUser`
// import は撤去 (route.ts 内で呼ぶ)。
//
// C2: 本 page は user.billingInterval (JWT 未掲載) を upgrade CTA hide 判定で
// 使うため、 getAuthContext() への切替で getCurrentUser() を結局呼ぶ必要が残り
// savings ゼロになる → getCurrentUser() を維持する判断。 将来 billingInterval を
// JWT に乗せるなら他 page と同 pattern で切替可 (= 設計の整合性を保つため意図的に
// 旧 pattern を残す)。 詳細: `types/clerk.d.ts` の「JWT に乗せない field」 と
// `docs/superpowers/sessions/2026-05-26-jwt-template-setup.md`。

export default async function Dashboard() {
  const user = await getCurrentUser()
  if (!user) return null
  const db = getDb()

  const [dueRow] = await db
    .select({ c: count() })
    .from(cards)
    .where(and(eq(cards.userId, user.id), lte(cards.due, new Date())))
  const dueCount = Number(dueRow?.c ?? 0)

  return (
    <div>
      {/* S-local-2 (Phase α): mount 時に cards / exams を Dexie に background pull。
          UI なし (return null)、 失敗 silent。 */}
      <PullTrigger />
      <h1 className="text-2xl font-bold mb-4">こんにちは</h1>

      <DashboardStats />

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
