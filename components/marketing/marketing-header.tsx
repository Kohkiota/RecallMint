import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/brand/logo'

// 未認証 marketing chrome の Header。 (marketing) RG layout が配備、 top
// (`/`) / contact / legal 3 page に共通表示される。
//
// 構成: 左 logo (`/` link wrap)、 右 nav に Sign in (outline) + Sign up
// (primary CTA) を 2 button 並列。 max-w-4xl は AppHeader (`/app/*`) と
// 統一して chrome 幅一貫。
export function MarketingHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link href="/">
          <Logo />
        </Link>
        <nav className="flex items-center gap-3">
          <Button asChild variant="outline" size="sm">
            <Link href="/sign-in">ログイン</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/sign-up">新規登録</Link>
          </Button>
        </nav>
      </div>
    </header>
  )
}
