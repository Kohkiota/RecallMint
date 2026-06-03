'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  PAID_PLAN_CATALOG,
  planLabelFor,
  yearlyDiscountPercent,
  yearlyMonthlyEquivalent,
} from '@/lib/plan-catalog'
import type { Plan } from '@/lib/auth/plan-limits'
import type { BillingInterval } from '@/lib/stripe/price-mapping'
import { createCheckoutSession, changePlan, cancelDowngrade } from './actions'

type Props = {
  userPlan: Plan
  userInterval: BillingInterval | null
  // §5.5 ブロック条件の granular flags。T7/T8 が個別に再利用するため derive せず
  // そのまま受け取る (blocked は本 component 内で OR 合成)。
  hasPendingUpdate: boolean
  cancelScheduled: boolean
  hasScheduledDowngrade: boolean
  // ダウングレード予約中 (§5.5) の banner 表示用。hasScheduledDowngrade=true の
  // ときのみ意味を持つ。label / date は server (page.tsx) で整形済の文字列を渡す
  // (client は price-mapping / Date 整形ロジックを持たない)。date は null 不可避な
  // ケースのため optional。
  scheduledTargetPlanLabel?: string
  scheduledEffectiveDateLabel?: string
}

// プラン変更 page 内の toggle + 2 plan cards。月↔年 切替で価格 / CTA 状態を
// 動的に再評価する。§7.1 で双方向化し、現プラン以外 (下位含む) は選択可能。
// pending / 解約予約 / ダウングレード予約中 (§5.5) は全 CTA を disable し案内文を出す。
export function UpgradePlans({
  userPlan,
  userInterval,
  hasPendingUpdate,
  cancelScheduled,
  hasScheduledDowngrade,
  scheduledTargetPlanLabel,
  scheduledEffectiveDateLabel,
}: Props) {
  // 既存 paid user は同じ cycle を default 表示、 Free は月額 default。
  // rename setBillingInterval (cf. window.setInterval 衝突回避、 同 dir の
  // delete-button.tsx で window.setInterval を使うため shadow を避ける)。
  const initialInterval: BillingInterval =
    userInterval === 'year' ? 'year' : 'month'
  const [interval, setBillingInterval] =
    useState<BillingInterval>(initialInterval)

  // §5.5: 処理中の pending / 解約予約 / ダウングレード予約のいずれかで全変更を停止。
  const blocked = hasPendingUpdate || cancelScheduled || hasScheduledDowngrade

  // toggle ラベルの割引率は catalog 起点 (price 改定時の自動追随)。
  // Standard と Pro は同じ割引率 (約 17%) を維持する建付け、 不一致時は
  // plan-catalog.test.ts で検出される設計。
  const discountPercent = yearlyDiscountPercent(
    PAID_PLAN_CATALOG.standard.monthlyYen,
    PAID_PLAN_CATALOG.standard.yearlyYen,
  )

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">プラン変更</h1>
      <p className="text-sm text-slate-600 mb-4">
        現在のプラン: <span className="font-medium">{planLabelFor(userPlan, userInterval)}</span>
      </p>

      {/* §5.5: ダウングレード予約中は page 上部に予約内容 + 取消を提示。blocked で
          全変更 CTA は disabled になるが、取消だけは唯一の有効操作として enabled。 */}
      {hasScheduledDowngrade && (
        <DowngradeReservationBanner
          targetPlanLabel={scheduledTargetPlanLabel}
          effectiveDateLabel={scheduledEffectiveDateLabel}
        />
      )}

      {/* §5.5 notice の出し分け: blocked 自体は OR のままで全 CTA は disable
          されるが、 notice は状態別に文言を分ける (旧版は支払い待ち向け文言が
          ダウングレード予約のみの状態でも出ていた)。 hasScheduledDowngrade
          のみは DowngradeReservationBanner が予約内容 + 取消ボタンを既に
          表示するため、 追加 notice を出さない (冗長回避)。 */}
      {hasPendingUpdate ? (
        <p role="status" aria-live="polite" className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-4">
          お支払いの処理中です。完了までお待ちください。
        </p>
      ) : cancelScheduled ? (
        <p role="status" aria-live="polite" className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-4">
          解約予約中です。プラン変更するには『お支払い・解約を管理』から予約を取り消してください。
        </p>
      ) : null}

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
          blocked={blocked}
        />
        <PlanCard
          plan="pro"
          interval={interval}
          userPlan={userPlan}
          userInterval={userInterval}
          blocked={blocked}
        />
      </div>

      <p className="text-xs text-slate-500 mt-4">
        プランの解約は『お支払い・解約を管理』(設定 page) からお願いします。
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
  blocked,
}: {
  plan: 'standard' | 'pro'
  interval: BillingInterval
  userPlan: Plan
  userInterval: BillingInterval | null
  blocked: boolean
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
          blocked={blocked}
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
  blocked,
}: {
  plan: 'standard' | 'pro'
  interval: BillingInterval
  userPlan: Plan
  userInterval: BillingInterval | null
  blocked: boolean
}) {
  // PlanCard 側と同じ rank 同値判定 (transition window で NULL=month 扱い)。
  const isCurrent = rank(userPlan, userInterval) === rank(plan, interval)

  if (isCurrent) {
    // 現プランは §5.5 ブロックの有無に関わらず常に disabled。
    return (
      <Button disabled className="w-full">
        現在のプラン
      </Button>
    )
  }

  // §7.1: 下位 (downgrade) も選択可。free / paid で経路が分かれる。
  // free → Checkout で新規 sub、 paid → changePlan で in-place 変更。
  if (userPlan === 'free') {
    const ctaLabel = `${plan === 'standard' ? 'Standard' : 'Pro'} に加入`
    return (
      <form action={createCheckoutSession}>
        <input type="hidden" name="plan" value={plan} />
        <input type="hidden" name="interval" value={interval} />
        <Button type="submit" className="w-full" disabled={blocked}>
          {ctaLabel}
        </Button>
      </form>
    )
  }

  return (
    <PaidChangeForm
      plan={plan}
      interval={interval}
      userPlan={userPlan}
      userInterval={userInterval}
      blocked={blocked}
    />
  )
}

// paid user の in-place プラン変更フォーム。CTA は直接 submit せず確認 modal を開き、
// confirm 時に fresh operationId を払い出して submit する。
// operationId を confirm 時生成にする理由 (§5.4): per-mount 固定だと「開く→閉じる→
// 別 plan を選び直す」操作で同一 UUID が別 intent に再利用され、idempotency key が
// 衝突しうる。confirm = 1 操作の確定点なので、ここで都度生成するのが正しい単位。
function PaidChangeForm({
  plan,
  interval,
  userPlan,
  userInterval,
  blocked,
}: {
  plan: 'standard' | 'pro'
  interval: BillingInterval
  userPlan: Plan
  userInterval: BillingInterval | null
  blocked: boolean
}) {
  const [open, setOpen] = useState(false)
  // confirm 時に生成した operationId を hidden input へ反映するための state。
  const [operationId, setOperationId] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  const targetLabel = PAID_PLAN_CATALOG[plan].label
  const ctaLabel = `${targetLabel} ${interval === 'year' ? '年額' : '月額'} に変更`

  // upgrade / downgrade の向きは rank 比較で判定 (現プランより上位なら upgrade)。
  // 文言だけが分岐し、submit 先 (changePlan) は同一 (action 側で再判定)。
  const isUpgradeDir = rank(plan, interval) > rank(userPlan, userInterval)
  const description = isUpgradeDir
    ? '今すぐ差額が請求され、プランが変更されます'
    : `現在の請求期間終了後に ${targetLabel} へ切り替わります。それまでは現在のプランを利用できます`

  // confirm: fresh UUID を hidden input に載せてから form を submit する。
  // setState は同期反映されないため、requestSubmit 前に DOM へ直接書き込む。
  const onConfirm = () => {
    const id = crypto.randomUUID()
    setOperationId(id)
    const input = formRef.current?.querySelector<HTMLInputElement>(
      'input[name="operationId"]',
    )
    if (input) input.value = id
    setOpen(false)
    formRef.current?.requestSubmit()
  }

  return (
    <form ref={formRef} action={changePlan}>
      <input type="hidden" name="plan" value={plan} />
      <input type="hidden" name="interval" value={interval} />
      <input type="hidden" name="operationId" value={operationId} readOnly />
      <Button
        type="button"
        className="w-full"
        disabled={blocked}
        onClick={() => {
          if (!blocked) setOpen(true)
        }}
      >
        {ctaLabel}
      </Button>
      <ConfirmDialog
        open={open}
        title={`${targetLabel} に変更しますか？`}
        description={description}
        confirmLabel="変更する"
        onConfirm={onConfirm}
        onCancel={() => setOpen(false)}
      />
    </form>
  )
}

// §5.5: ダウングレード予約中 banner。amber/slate の注意喚起トーン (blocked notice と
// 統一)。取消は cancelDowngrade への直接 submit (benign / 可逆寄りなので二段確認不要)。
// cancelDowngrade は operationId 必須 (未送信で MISSING_OPERATION_ID throw) のため、
// render 毎の UUID を hidden input に載せる (取消は idempotent なので per-render で十分)。
function DowngradeReservationBanner({
  targetPlanLabel,
  effectiveDateLabel,
}: {
  targetPlanLabel?: string
  effectiveDateLabel?: string
}) {
  const [operationId] = useState(() => crypto.randomUUID())
  const planText = targetPlanLabel ?? '変更先プラン'
  // 発効日が null (timestamp 未確定) のケースは日付を省く。全角括弧で囲う。
  const dateSuffix = effectiveDateLabel ? `（${effectiveDateLabel}）` : ''

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-4"
    >
      <span>
        {planText}へ変更予約中{dateSuffix} —
      </span>
      <form action={cancelDowngrade}>
        <input type="hidden" name="operationId" value={operationId} />
        {/* blocked に依らず常時有効 (予約中で唯一の操作)。 */}
        <Button type="submit" variant="outline" size="sm">
          取消
        </Button>
      </form>
    </div>
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
