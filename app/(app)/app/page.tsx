import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { AppContainer } from './_components/app-container'
import { BillingBanner } from './_components/billing-banner'
import { HomeDashboard } from './_components/home/home-dashboard'

// Home v1 (Dash-1)。 本 server component は DB SELECT を行わない (S-perf-3 維持):
// searchParams から `billing` / `exam` を抜き、 user.id と一緒に client root へ渡す
// だけ。 7 ウィジェットは全て HomeDashboard 配下の client component が Dexie mirror
// から算出する (唯一の server 読みは W4 の /api/stats/summary への CSR fetch)。
//
// 残置: getCurrentUser() は user.id (= Dexie tenant key) を引くため必須。 旧 S-perf-2
// T4 のコメント (JWT 未掲載 field 依存) と同方針で getAuthContext() への切替は見送る。
//
// PullTrigger: (app) 配下の deep link / reload / 内部 navigate のいずれでも 1 回
// fire させるため、 配置は `app/(app)/app/layout.tsx` (= /app/* 共通 layout) に
// 移動済 (cache-fix roadmap ④-1)。 同 layout 配下の navigation では re-mount
// しないため重複発火しない。

// Next 15: searchParams は Promise。billing banner の kind と選択試験 (`exam`) を
// SSR 安全に抽出して client へ prop で渡す (useSearchParams + Suspense を避ける)。
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
  // `exam` も同方針。 妥当性 (uuid / 実在 / owner) の検証は client resolver の責務
  // (Dexie mirror を要するため server では判定できない — spec §6)。
  const exam = Array.isArray(sp.exam) ? sp.exam[0] : sp.exam

  return (
    <AppContainer>
      <div>
        <BillingBanner kind={billing} />

        <HomeDashboard userId={user.id} urlExamId={exam} />

        {/* 全 plan で「プラン変更」CTA を表示。entry point を /app/upgrade に統一し、
            upgrade / downgrade の選択は同 page 内 toggle に委ねる (§7.4)。Pro 年額も
            含め表示する (最上位でも plan 変更導線は残す)。prefetch は切る — upgrade
            page は load 時に Stripe call を行うため (perf precedent)。 */}
        <Link
          href="/app/upgrade"
          prefetch={false}
          className="mt-6 block text-center text-sm text-muted-foreground underline"
        >
          プラン変更
        </Link>
      </div>
    </AppContainer>
  )
}
