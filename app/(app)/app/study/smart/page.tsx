// スマート復習 page (Server Component、 S2.2.1 T2 で session/page.tsx 統合)。
//
// 認証 → user_settings 取得 (session_limit / fsrsMode、 行不在は 20 / false fallback) →
// due card 取得 → 0 件なら「ありません」案内 / あれば SessionRunner に渡す。

import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { userSettings } from '@/lib/db/schema'
import { getSessionCards } from '@/lib/cards/get-session-cards'
import { StudySessionHost } from './_components/study-session-host'
import { Button } from '@/components/ui/button'

export default async function SmartStudyPage() {
  const user = await getCurrentUser()
  // getCurrentUser は UnauthenticatedError を throw するが、
  // /app layout の auth middleware が事前に guard するため、
  // ここで null が返ることは基本ない。 防御的に null チェックのみ。
  if (!user) return null

  const db = getDb()
  const settingsRows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, user.id))
    .limit(1)
  const sessionLimit = settingsRows[0]?.sessionLimit ?? 20
  const fsrsMode = settingsRows[0]?.fsrsMode ?? false

  const cards = await getSessionCards(user.id, sessionLimit)

  if (cards.length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-6 px-4 py-12 text-center">
        <h1 className="text-2xl font-bold">スマート復習</h1>
        <p className="text-slate-600">
          現在復習する card はありません。
          <br />
          すべての card を学習済みです。お疲れ様でした！
        </p>
        <Button asChild variant="outline">
          <Link href="/app">ダッシュボードへ</Link>
        </Button>
      </div>
    )
  }

  // S-cache-1: StudySessionHost が client 側で session_id を採番 + Dexie に
  // study_sessions 行を入れてから SessionRunner を render する。
  // S-local-3: userId / sessionLimit を渡し、 client が Dexie cards mirror から
  // 直接 due cards を引いて (mirror が空なら server cards で fallback)。
  return (
    <StudySessionHost
      cards={cards}
      fsrsMode={fsrsMode}
      userId={user.id}
      sessionLimit={sessionLimit}
      mode="smart"
    />
  )
}
