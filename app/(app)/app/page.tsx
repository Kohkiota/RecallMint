import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { BillingBanner } from './_components/billing-banner'
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

// Next 15: searchParams は Promise。billing banner の kind を SSR 安全に抽出して
// client banner へ prop で渡す (useSearchParams + Suspense を避けるため)。
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>
}) {
  const user = await getCurrentUser()
  if (!user) return null

  const sp = await searchParams
  // 配列で来た場合 (?billing=a&billing=b) は先頭のみ採用。未知 kind は banner 側で無視。
  const billing = Array.isArray(sp.billing) ? sp.billing[0] : sp.billing

  return (
    <div>
      <BillingBanner kind={billing} />

      <h1 className="text-2xl font-bold mb-4">こんにちは</h1>

      <DashboardStats userId={user.id} />

      <DashboardActions userId={user.id} />

      {/* 全 plan で「プラン変更」CTA を表示。entry point を /app/upgrade に統一し、
          upgrade / downgrade の選択は同 page 内 toggle に委ねる (§7.4)。Pro 年額も
          含め表示する (最上位でも plan 変更導線は残す)。prefetch は切る — upgrade
          page は load 時に Stripe call を行うため (perf precedent)。 */}
      <Link
        href="/app/upgrade"
        prefetch={false}
        className="block mt-4 text-center text-sm text-slate-600 underline"
      >
        プラン変更
      </Link>
    </div>
  )
}
