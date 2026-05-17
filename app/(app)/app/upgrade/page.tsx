import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UpgradePlans } from './upgrade-plans'

export default async function UpgradePage() {
  const user = await getCurrentUser()
  if (!user) return null

  // 最上位 (Pro 年額) はアップグレード先なし → /app に redirect。
  // Pro 月額 user は Pro 年額への upsell があるので page を render する
  // (UpgradePlans 内で Standard 系は disabled 表示)。
  if (user.plan === 'pro' && user.billingInterval === 'year') {
    redirect('/app')
  }

  return (
    <UpgradePlans userPlan={user.plan} userInterval={user.billingInterval} />
  )
}
