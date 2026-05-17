'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  PAID_PLAN_CATALOG,
  FREE_PLAN,
  rankPlan,
  yearlyDiscountPercent,
  yearlyMonthlyEquivalent,
} from '@/lib/plan-catalog'
import type { Plan } from '@/lib/auth/plan-limits'
import type { BillingInterval } from '@/lib/stripe/price-mapping'

export type PricingViewer =
  | { authenticated: false }
  | {
      authenticated: true
      plan: Plan
      billingInterval: BillingInterval | null
    }

type Props = {
  viewer: PricingViewer
}

// 公開 /pricing page の本体。 marketing chrome 内で SSR された後、 toggle と
// CTA 状態は client side で再評価する。 認証状態 (viewer) は親 server
// component が getCurrentUser を best-effort で呼んで決定する。
export function PricingTable({ viewer }: Props) {
  const [interval, setBillingInterval] = useState<BillingInterval>('month')

  const discountPercent = yearlyDiscountPercent(
    PAID_PLAN_CATALOG.standard.monthlyYen,
    PAID_PLAN_CATALOG.standard.yearlyYen,
  )

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <h1 className="text-3xl md:text-4xl font-bold text-center mb-2">料金プラン</h1>
      <p className="text-center text-slate-600 mb-8">
        AI OCR で取り込んだ問題を FSRS 忘却曲線で復習。 用途に合わせて選べる 3 プラン。
      </p>

      <div className="flex justify-center mb-8">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
          <ToggleButton
            active={interval === 'month'}
            onClick={() => setBillingInterval('month')}
          >
            月額
          </ToggleButton>
          <ToggleButton
            active={interval === 'year'}
            onClick={() => setBillingInterval('year')}
          >
            年額 ({discountPercent}% OFF)
          </ToggleButton>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <PlanColumn
          tier="free"
          interval={interval}
          viewer={viewer}
        />
        <PlanColumn
          tier="standard"
          interval={interval}
          viewer={viewer}
        />
        <PlanColumn
          tier="pro"
          interval={interval}
          viewer={viewer}
        />
      </div>

      <p className="text-xs text-center text-slate-500 mt-8">
        年額プランは月額換算で 2 ヶ月分相当お得です。 解約はいつでも可能、 残り期間まで利用できます。
      </p>
    </div>
  )
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'px-4 py-1.5 rounded-md text-sm font-medium transition-colors ' +
        (active
          ? 'bg-slate-900 text-white'
          : 'text-slate-700 hover:bg-slate-50')
      }
    >
      {children}
    </button>
  )
}

function PlanColumn({
  tier,
  interval,
  viewer,
}: {
  tier: 'free' | 'standard' | 'pro'
  interval: BillingInterval
  viewer: PricingViewer
}) {
  const isFree = tier === 'free'
  const entry = isFree ? FREE_PLAN : PAID_PLAN_CATALOG[tier]
  const price = interval === 'month' ? entry.monthlyYen : entry.yearlyYen

  // 現在のプラン判定:
  //   未認証 / Free 表示 = どの user も current にならない (Free tier も認証
  //   状態がないと「現在」の概念が成立しない)
  //   認証済: rank 同値 = current。 Free tier は free user が viewing 時に current。
  let isCurrent = false
  if (viewer.authenticated) {
    if (isFree && viewer.plan === 'free') {
      isCurrent = true
    } else if (!isFree) {
      isCurrent = rankPlan(viewer.plan, viewer.billingInterval) === rankPlan(tier, interval)
    }
  }

  return (
    <Card className={isCurrent ? 'ring-1 ring-slate-900' : ''}>
      <CardContent>
        <h2 className="text-lg font-bold mb-1">{entry.label}</h2>
        <p className="mb-1">
          <span className="text-3xl font-bold">¥{price.toLocaleString('ja-JP')}</span>
          <span className="text-sm text-slate-600">
            {isFree ? '' : interval === 'month' ? ' / 月' : ' / 年'}
          </span>
        </p>
        {!isFree && interval === 'year' && (
          <p className="text-xs text-slate-500 mb-3">
            月あたり ¥{yearlyMonthlyEquivalent(entry.yearlyYen).toLocaleString('ja-JP')}相当
          </p>
        )}
        <ul className="space-y-1 text-sm text-slate-700 mb-4">
          {entry.features.map((f) => (
            <li key={f}>✅ {f}</li>
          ))}
        </ul>
        <PricingCta
          tier={tier}
          interval={interval}
          viewer={viewer}
          isCurrent={isCurrent}
        />
      </CardContent>
    </Card>
  )
}

function PricingCta({
  tier,
  interval,
  viewer,
  isCurrent,
}: {
  tier: 'free' | 'standard' | 'pro'
  interval: BillingInterval
  viewer: PricingViewer
  isCurrent: boolean
}) {
  // 未認証: すべて /sign-up に誘導 (intent param は MVP では持たない、 sign-up
  // 完了後 /pricing 再訪 or /app/upgrade で plan 再選択)
  if (!viewer.authenticated) {
    return (
      <Button asChild className="w-full">
        <Link href="/sign-up">無料登録</Link>
      </Button>
    )
  }

  if (isCurrent) {
    return (
      <Button disabled className="w-full">
        現在のプラン
      </Button>
    )
  }

  // Free tier は authenticated user 視点では downgrade or current 以外なし。
  // current は上の if で処理済、 ここに来るのは「paid user が free を見ている」case。
  if (tier === 'free') {
    return (
      <Button disabled variant="outline" className="w-full">
        現在より下位プラン
      </Button>
    )
  }

  // Paid tier: rank で upgrade / downgrade 判定
  const userRank = rankPlan(viewer.plan, viewer.billingInterval)
  const targetRank = rankPlan(tier, interval)
  if (targetRank < userRank) {
    return (
      <Button disabled variant="outline" className="w-full">
        現在より下位プラン
      </Button>
    )
  }

  // upgrade: /app/upgrade に誘導 (toggle / plan 選択はそちらの page で再度行う)
  return (
    <Button asChild className="w-full">
      <Link href="/app/upgrade">アップグレード</Link>
    </Button>
  )
}
