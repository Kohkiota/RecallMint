// UI 用の plan カタログ。 lib/auth/plan-limits.ts (backend 上限 enforce) と分離:
// 本 file は表示・upsell 判断・価格表 (/pricing, /app/upgrade) 共通の data。
//
// 価格は JPY 整数 (税込前提、 sed 置換対象ではない — 価格更改時は本 file 直接編集)。
// 機能差は plan 軸のみ (cycle 軸では同一)。
//
// rank() で「(plan, interval) を一直線に並べた upsell 順位」を表現:
//   free=0 < standard月=1 < standard年=2 < pro月=3 < pro年=4
// upgrade page / pricing page で「現在のプラン / アップグレード / ダウングレード」
// を 1 関数で判定可能にする。

import type { Plan } from '@/lib/auth/plan-limits'
import type { PaidPlan, BillingInterval } from '@/lib/stripe/price-mapping'

export type PlanCatalogEntry = {
  id: PaidPlan
  label: string
  monthlyYen: number
  yearlyYen: number
  features: string[]
}

// 価格 (税込) は 2026-05-17 確定値。 docs/02-tech-spec.md §6 (機能差) と整合。
// Free は別 entry で扱う (Stripe price なし、 price=0)。
export const PAID_PLAN_CATALOG: Readonly<Record<PaidPlan, PlanCatalogEntry>> =
  Object.freeze({
    standard: {
      id: 'standard',
      label: 'Standard',
      monthlyYen: 680,
      yearlyYen: 6800,
      features: [
        '月 300 問まで AI OCR 取込',
        '複数試験の管理',
        'FSRS 全機能',
        'カスタムプロパティ無制限',
      ],
    },
    pro: {
      id: 'pro',
      label: 'Pro',
      monthlyYen: 1280,
      yearlyYen: 12800,
      features: [
        'AI OCR 公平利用 (上限なし)',
        'Standard の全機能',
        '複数デバイス同期 (v1.x 予定)',
        'エクスポート機能 (v1.x 予定)',
      ],
    },
  })

export const FREE_PLAN: PlanCatalogEntry = Object.freeze({
  id: 'standard', // dummy: Free は Stripe price 不在のため id は使われない
  label: 'Free',
  monthlyYen: 0,
  yearlyYen: 0,
  features: ['月 30 問まで AI OCR 取込', '1 試験まで', 'FSRS 基本機能'],
})

// 年額の月割り価格 (端数切り捨て) — UI バッジ「月あたり ¥X 相当」用。
export function yearlyMonthlyEquivalent(yearlyYen: number): number {
  return Math.floor(yearlyYen / 12)
}

// 年額バッジ「月比 N % off」 — 月額×12 と年額の差分から算出。
export function yearlyDiscountPercent(monthlyYen: number, yearlyYen: number): number {
  const fullYearAtMonthly = monthlyYen * 12
  if (fullYearAtMonthly === 0) return 0
  const discount = fullYearAtMonthly - yearlyYen
  return Math.round((discount / fullYearAtMonthly) * 100)
}

// upsell 順位 (free=0, standard月=1, standard年=2, pro月=3, pro年=4)。
// pro 年が最上位 (OT 確定方針)。 同 rank = 現在のプラン、 高 rank = upgrade、
// 低 rank = downgrade。
export function rankPlan(plan: Plan, interval: BillingInterval | null): number {
  if (plan === 'free') return 0
  const base = plan === 'standard' ? 1 : 3
  const cycle = interval === 'year' ? 1 : 0
  return base + cycle
}

// 「ユーザーが target に切り替えるのは upgrade か」(同 rank は false)。
export function isUpgrade(
  user: { plan: Plan; interval: BillingInterval | null },
  target: { plan: PaidPlan; interval: BillingInterval },
): boolean {
  return rankPlan(target.plan, target.interval) > rankPlan(user.plan, user.interval)
}

// (plan, billingInterval) → 表示ラベル。 settings page / upgrade-plans 共通。
// interval=NULL (transition window) は「(同期中)」と表示し、 webhook 受信前の
// 一時的な未確定状態を end user に明示する (OT 観測性は別途 log / Sentry で確保)。
export function planLabelFor(
  plan: Plan,
  interval: BillingInterval | null,
): string {
  if (plan === 'free') return 'Free プラン'
  const planLabel = plan === 'standard' ? 'Standard' : 'Pro'
  const cycleLabel =
    interval === 'year' ? '年額' : interval === 'month' ? '月額' : '(同期中)'
  return `${planLabel} プラン ${cycleLabel}`
}
