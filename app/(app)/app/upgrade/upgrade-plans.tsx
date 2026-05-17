'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  PAID_PLAN_CATALOG,
  planLabelFor,
  yearlyDiscountPercent,
  yearlyMonthlyEquivalent,
} from '@/lib/plan-catalog'
import type { Plan } from '@/lib/auth/plan-limits'
import type { BillingInterval } from '@/lib/stripe/price-mapping'
import { createCheckoutSession } from './actions'

type Props = {
  userPlan: Plan
  userInterval: BillingInterval | null
}

// upgrade page 内の toggle + 2 plan cards。 月↔年 切替で価格 / CTA 状態を
// 動的に再評価する。 「現在のプラン」「ダウングレード」は disabled CTA で
// 表示 (cycle 変更は Stripe Customer Portal 経由を案内)。
export function UpgradePlans({ userPlan, userInterval }: Props) {
  // 既存 paid user は同じ cycle を default 表示、 Free は月額 default。
  // rename setBillingInterval (cf. window.setInterval 衝突回避、 同 dir の
  // delete-button.tsx で window.setInterval を使うため shadow を避ける)。
  const initialInterval: BillingInterval =
    userInterval === 'year' ? 'year' : 'month'
  const [interval, setBillingInterval] =
    useState<BillingInterval>(initialInterval)

  // toggle ラベルの割引率は catalog 起点 (price 改定時の自動追随)。
  // Standard と Pro は同じ割引率 (約 17%) を維持する建付け、 不一致時は
  // plan-catalog.test.ts で検出される設計。
  const discountPercent = yearlyDiscountPercent(
    PAID_PLAN_CATALOG.standard.monthlyYen,
    PAID_PLAN_CATALOG.standard.yearlyYen,
  )

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">プランを選択</h1>
      <p className="text-sm text-slate-600 mb-4">
        現在のプラン: <span className="font-medium">{planLabelFor(userPlan, userInterval)}</span>
      </p>

      {/* 月↔年 toggle (radio 風 segmented button) */}
      <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 mb-6">
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

      <div className="grid gap-4 md:grid-cols-2">
        <PlanCard
          plan="standard"
          interval={interval}
          userPlan={userPlan}
          userInterval={userInterval}
        />
        <PlanCard
          plan="pro"
          interval={interval}
          userPlan={userPlan}
          userInterval={userInterval}
        />
      </div>

      <p className="text-xs text-slate-500 mt-4">
        同じプランの月↔年切替や解約は『お支払い・解約を管理』(設定 page) からお願いします。
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

function PlanCard({
  plan,
  interval,
  userPlan,
  userInterval,
}: {
  plan: 'standard' | 'pro'
  interval: BillingInterval
  userPlan: Plan
  userInterval: BillingInterval | null
}) {
  const entry = PAID_PLAN_CATALOG[plan]
  const price = interval === 'month' ? entry.monthlyYen : entry.yearlyYen
  // rank 同値 = 「現在のプラン」扱い。 paid plan で interval=NULL (transition
  // window) は month と同 rank、 month カード上で「現在のプラン」と表示し
  // 不要な再加入 CTA を抑止する。
  const isCurrent = rank(userPlan, userInterval) === rank(plan, interval)

  return (
    <Card className={isCurrent ? 'ring-1 ring-slate-900' : ''}>
      <CardContent>
        <h2 className="text-lg font-bold mb-1">{entry.label}</h2>
        <p className="mb-1">
          <span className="text-3xl font-bold">¥{price.toLocaleString('ja-JP')}</span>
          <span className="text-sm text-slate-600">
            {interval === 'month' ? ' / 月' : ' / 年'}
          </span>
        </p>
        {interval === 'year' && (
          <p className="text-xs text-slate-500 mb-3">
            月あたり ¥{yearlyMonthlyEquivalent(entry.yearlyYen).toLocaleString('ja-JP')}相当
          </p>
        )}
        <ul className="space-y-1 text-sm text-slate-700 mb-4">
          {entry.features.map((f) => (
            <li key={f}>✅ {f}</li>
          ))}
        </ul>
        <CtaButton
          plan={plan}
          interval={interval}
          userPlan={userPlan}
          userInterval={userInterval}
        />
      </CardContent>
    </Card>
  )
}

function CtaButton({
  plan,
  interval,
  userPlan,
  userInterval,
}: {
  plan: 'standard' | 'pro'
  interval: BillingInterval
  userPlan: Plan
  userInterval: BillingInterval | null
}) {
  // PlanCard 側と同じ rank 同値判定 (transition window で NULL=month 扱い)。
  const isCurrent = rank(userPlan, userInterval) === rank(plan, interval)

  if (isCurrent) {
    return (
      <Button disabled className="w-full">
        現在のプラン
      </Button>
    )
  }

  // free → 全 upgrade、 standard → pro upgrade、 standard月 → standard年、
  // pro月 → pro年 などすべて Stripe Checkout で新規 sub を開いた後 webhook で
  // 旧 sub を proration cancel (Stripe 標準挙動)。
  // 純粋な downgrade (pro → standard) は Customer Portal で実施 (本 page では disabled)。
  const userRank = rank(userPlan, userInterval)
  const targetRank = rank(plan, interval)
  if (targetRank < userRank) {
    return (
      <Button disabled variant="outline" className="w-full">
        現在より下位プラン
      </Button>
    )
  }

  const ctaLabel =
    userPlan === 'free'
      ? `${plan === 'standard' ? 'Standard' : 'Pro'} に加入`
      : `${plan === 'standard' ? 'Standard' : 'Pro'} ${interval === 'year' ? '年額' : '月額'} にアップグレード`

  return (
    <form action={createCheckoutSession}>
      <input type="hidden" name="plan" value={plan} />
      <input type="hidden" name="interval" value={interval} />
      <Button type="submit" className="w-full">
        {ctaLabel}
      </Button>
    </form>
  )
}

// upgrade-plans.tsx 内では lib/plan-catalog.ts の rankPlan を再 export 経由で
// 使わず inline copy (server / client component 境界で type import のみ
// 使い、 logic を client 側に閉じる方針)。 logic は plan-catalog.test.ts で
// 担保済、 本 inline は trivial。
function rank(plan: Plan, interval: BillingInterval | null): number {
  if (plan === 'free') return 0
  const base = plan === 'standard' ? 1 : 3
  const cycle = interval === 'year' ? 1 : 0
  return base + cycle
}

