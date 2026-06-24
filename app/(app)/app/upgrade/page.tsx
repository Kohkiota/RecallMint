import { getCurrentUser } from '@/lib/auth/ensure-user'
import {
  resolveActiveSubscription,
  getPendingState,
} from '@/lib/stripe/subscription'
import { resolveFromPriceId } from '@/lib/stripe/price-mapping'
import { PAID_PLAN_CATALOG } from '@/lib/plan-catalog'
import { AppContainer } from '../_components/app-container'
import { UpgradePlans } from './upgrade-plans'

// 予約発効日を settings の formatCancelDate と同一形式 (ja-JP YYYY/MM/DD) で整形する。
// 共有 helper 化せず複製するのは、settings との cross-module 結合を避けるため
// (整形ロジックは trivial、片方の都合でもう片方が壊れる依存を作らない)。
function formatEffectiveDate(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

// §7.1: プラン変更 page は双方向 (upgrade / downgrade / 月年切替) になったため、
// 最上位 (pro+year) への redirect は撤廃。paid user は sub 状態を server で取得し
// ブロック判定 (§5.5) のフラグを client に渡す。free user は sub 不在なので Stripe
// 呼出を skip する。
export default async function UpgradePage() {
  const user = await getCurrentUser()
  if (!user) return null

  let hasPendingUpdate = false
  let cancelScheduled = false
  // ダウングレード予約の真実 source は DB 列 (方針C)。Stripe schedule 単独ではなく
  // この列でブロック判定する (changePlan action と同じ基準、§5.5)。
  const hasScheduledDowngrade = user.scheduledDowngradeScheduleId != null

  if (user.plan !== 'free') {
    // resolve 失敗 (0 本 / 複数 / 矛盾) は page を落とさず、ブロックなしで描画する
    // (action 側で再判定し弾くため、UI は graceful degrade で良い、§8)。
    try {
      const { sub } = await resolveActiveSubscription(user)
      const pending = getPendingState(sub)
      hasPendingUpdate = pending.hasPendingUpdate
      cancelScheduled = pending.cancelScheduled
    } catch {
      // NoSubscriptionError / AmbiguousSubscriptionError 等。DB 列由来の
      // hasScheduledDowngrade は維持したまま pending/cancel は false 扱い。
    }
  }

  // 変更予約 banner 用の表示文字列を server で整形して渡す
  // (client は price-mapping / Date 整形を持たない)。予約 price → (plan,interval) →
  // 短縮ラベル、発効日 → ja-JP 整形。price 解決不能 / 日付 null は undefined で graceful。
  // banner は tier + interval のみ (例: "Standard 月額")。planLabelFor のフル
  // 「Standard プラン 月額」は banner 文では冗長なため catalog の tier label を使う。
  let scheduledTargetPlanLabel: string | undefined
  let scheduledEffectiveDateLabel: string | undefined
  if (hasScheduledDowngrade) {
    if (user.scheduledTargetPriceId) {
      const mapping = resolveFromPriceId(user.scheduledTargetPriceId)
      if (mapping) {
        const tier = PAID_PLAN_CATALOG[mapping.plan].label
        const intervalText = mapping.interval === 'year' ? '年額' : '月額'
        scheduledTargetPlanLabel = `${tier} ${intervalText}`
      }
    }
    if (user.scheduledChangeEffectiveAt) {
      scheduledEffectiveDateLabel = formatEffectiveDate(
        user.scheduledChangeEffectiveAt,
      )
    }
  }

  return (
    <AppContainer>
      <UpgradePlans
        userPlan={user.plan}
        userInterval={user.billingInterval}
        hasPendingUpdate={hasPendingUpdate}
        cancelScheduled={cancelScheduled}
        hasScheduledDowngrade={hasScheduledDowngrade}
        scheduledTargetPlanLabel={scheduledTargetPlanLabel}
        scheduledEffectiveDateLabel={scheduledEffectiveDateLabel}
      />
    </AppContainer>
  )
}
