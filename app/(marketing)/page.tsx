import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { Button } from '@/components/ui/button'

export default async function Home() {
  // R2 (Bug 3 fix): redirect to /app only when ALL three conditions hold:
  //   (1) Clerk session exists, (2) DB row exists, (3) deleted_at IS NULL.
  // Otherwise render the landing — this gracefully covers anonymous visitors,
  // sign-up webhook race (row not yet synced), and the 60s cached-JWT window
  // for a deleted user. UnauthenticatedError is the no-session case (anon).
  let user
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      user = null
    } else {
      throw err
    }
  }

  if (user && !user.deletedAt) {
    redirect('/app')
  }

  // marketing layout が外側 chrome (Header + Footer) を担当、 main は
  // full-flex (`flex-1 flex flex-col`)。 hero center 配置は本 page 内側
  // wrapper で実現 (spec §4.6 page 別 wrapper pattern)。
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      <h1 className="text-4xl font-bold text-slate-900 mb-4">RecallMint</h1>
      <p className="text-slate-600 mb-8 text-center max-w-md">
        AI OCR で学習資料を取り込み、 FSRS 忘却曲線で効率的に復習する学習アプリ
      </p>
      <div className="flex gap-3">
        <Button asChild size="lg">
          <Link href="/sign-up">新規登録</Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/sign-in">ログイン</Link>
        </Button>
      </div>
    </div>
  )
}
