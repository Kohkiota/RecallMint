import Link from 'next/link'
import { Button } from '@/components/ui/button'

// 削除完了 terminal page。 (auth) layout が AuthHeader + main center を
// 担当、 page は文言 + 戻り button 直書き。 削除済 user の middleware
// 経由 redirect でのみ到達 (`/app/layout.tsx` の `if (user.deletedAt)
// redirect('/sign-out-deleted')` 経路)。
export default function Page() {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">
        アカウントは削除済みです
      </h1>
      <p className="text-slate-600 mb-6">トップに戻ってください。</p>
      <Button asChild size="lg">
        <Link href="/">トップに戻る</Link>
      </Button>
    </div>
  )
}
