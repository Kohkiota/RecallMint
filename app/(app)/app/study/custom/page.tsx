// カスタム演習 page (Server Component、 S2.3 T11)。
//
// 認証 → user_settings 取得 (customSessionLimit / fsrsMode、 行不在は 20 / false fallback) →
// CustomSessionFlow に渡す。 カード選定は client 側 (Dexie mirror) で実行。

import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { userSettings } from '@/lib/db/schema'
import { CustomSessionFlow } from './_components/custom-session-flow'

export default async function CustomStudyPage() {
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
  const row = settingsRows[0]
  // 行不在のみ 20。 明示 null = 上限なし は維持 (smart の sessionLimit と同方針)。
  const customLimit = row ? row.customSessionLimit : 20
  const fsrsMode = row ? row.fsrsMode : false

  return (
    <CustomSessionFlow
      userId={user.id}
      customLimit={customLimit}
      fsrsMode={fsrsMode}
    />
  )
}
