import { getCurrentUser } from '@/lib/auth/ensure-user'
import {
  resolveActiveSubscription,
  getPendingState,
} from '@/lib/stripe/subscription'
import { UpgradePlans } from './upgrade-plans'

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

  return (
    <UpgradePlans
      userPlan={user.plan}
      userInterval={user.billingInterval}
      hasPendingUpdate={hasPendingUpdate}
      cancelScheduled={cancelScheduled}
      hasScheduledDowngrade={hasScheduledDowngrade}
    />
  )
}
