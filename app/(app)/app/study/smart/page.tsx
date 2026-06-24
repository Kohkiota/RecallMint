// スマート復習 page (Server Component、 S2.2.1 T2 で session/page.tsx 統合)。
//
// 認証 → user_settings 取得 (session_limit / fsrsMode、 行不在は 20 / false fallback) →
// due card 取得 → StudySessionHost に渡す。 cards 0 件 / server fetch fail の
// empty UI 判定は host 側 (Dexie + server 両方 0 件のときの一元判断、 S-local-4)。

import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { userSettings, type Card } from '@/lib/db/schema'
import { getSessionCards } from '@/lib/cards/get-session-cards'
import { AppContainer } from '../../_components/app-container'
import { StudySessionHost } from './_components/study-session-host'

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
  const row = settingsRows[0]
  const sessionLimit = row ? row.sessionLimit : 20  // 行不在のみ 20。 明示 null = 上限なし は維持
  const fsrsMode = row ? row.fsrsMode : false

  // S-local-4 (Phase γ): server fetch を try/catch、 throw 時 cards=[]。 これにより
  // offline / server 5xx でも page render fail せず、 client (StudySessionHost) が
  // Dexie cards で続行できる。 Dexie / server 両方 0 件のときの empty UI も host 側。
  let serverCards: Card[] = []
  try {
    serverCards = await getSessionCards(user.id, sessionLimit)
  } catch {
    // silent: client が Dexie cards mirror で代替する
  }

  // S-cache-1: StudySessionHost が client 側で session_id を採番 + Dexie に
  // study_sessions 行を入れてから SessionRunner を render する。
  // S-local-3: userId / sessionLimit を渡し、 client が Dexie cards mirror から
  // 直接 due cards を引いて (mirror が空なら server cards で fallback)。
  // S-local-4: cards=[] でも host に進む (empty UI 判定は host 内)。
  return (
    <AppContainer>
      <StudySessionHost
        cards={serverCards}
        fsrsMode={fsrsMode}
        userId={user.id}
        sessionLimit={sessionLimit}
        mode="smart"
      />
    </AppContainer>
  )
}
