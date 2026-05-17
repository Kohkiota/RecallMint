import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { PricingTable, type PricingViewer } from '@/components/pricing/pricing-table'

// 公開 /pricing page。 marketing chrome (Header + Footer) は (marketing) layout
// が配備。 認証状態は best-effort で取得し、 viewer prop に渡す:
//   - 未認証 (Clerk session なし) → { authenticated: false }
//   - 認証済 + DB user 存在 + deletedAt NULL → { authenticated: true, ... }
//   - その他 (DB 未同期 / 削除済) → { authenticated: false } として扱う
//     (現プランハイライト不要、 sign-up 再誘導で問題なし)
export default async function PricingPage() {
  let viewer: PricingViewer = { authenticated: false }
  try {
    const user = await getCurrentUser()
    if (user && !user.deletedAt) {
      viewer = {
        authenticated: true,
        plan: user.plan,
        billingInterval: user.billingInterval,
      }
    }
  } catch (err) {
    if (!(err instanceof UnauthenticatedError)) throw err
    // UnauthenticatedError は default (未認証) のまま fall through
  }

  return <PricingTable viewer={viewer} />
}
