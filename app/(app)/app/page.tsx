import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { DashboardActions } from './_components/dashboard-actions'
import { DashboardStats } from './_components/dashboard-stats'

// S-perf-3 (dashboard 高速化): dueCount の server SSR SELECT (cards WHERE
// due <= now) を撤去。 DashboardActions と DashboardStats が Dexie mirror から
// useLiveQuery で算出する。 これにより本 server component は user.id / plan を
// 渡すだけで済み、 cards 件数依存の DB 待ちが消える。
//
// 残置: getCurrentUser() は user.id (= Dexie tenant key) + plan + billingInterval
// (upgrade CTA hide 判定) を引くため必須。 旧 S-perf-2 T4 のコメント (JWT 未掲載
// field 依存) と同方針で getAuthContext() への切替は見送る。
//
// PullTrigger: (app) 配下の deep link / reload / 内部 navigate のいずれでも 1 回
// fire させるため、 配置は `app/(app)/app/layout.tsx` (= /app/* 共通 layout) に
// 移動済 (cache-fix roadmap ④-1)。 同 layout 配下の navigation では re-mount
// しないため重複発火しない。

export default async function Dashboard() {
  const user = await getCurrentUser()
  if (!user) return null

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">こんにちは</h1>

      <DashboardStats userId={user.id} />

      <DashboardActions userId={user.id} />

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
