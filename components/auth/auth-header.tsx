import Link from 'next/link'
import { Logo } from '@/components/brand/logo'

// auth chrome の Header (sign-in / sign-up / sign-out-deleted で共通)。
// nav なし = auth focus 維持、 logo click のみ `/` 戻り (認証中断時の
// 戻り動線)。 footer は (auth) layout で配備しない方針。
export function AuthHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="max-w-4xl mx-auto px-4 py-3">
        <Link href="/">
          <Logo />
        </Link>
      </div>
    </header>
  )
}
