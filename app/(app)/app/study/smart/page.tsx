// スマート復習の入口 page (Server Component)。
//
// 認証 → user_settings.session_limit を取得 (行不在は 20 fallback) →
// 「現在の設定: XX 枚」を表示し、 開始 button (client) を描画する。
// I-2: client 側 button で revalidateAppPath を呼んで Router Cache を破棄。

import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { userSettings } from '@/lib/db/schema'
import { Card, CardContent } from '@/components/ui/card'
import { StartButton } from './_components/start-button'

export default async function SmartStudyEntryPage() {
  const user = await getCurrentUser()
  // /app layout の auth gate が事前に弾くため null は基本想定外、 防御的 null check のみ。
  if (!user) return null

  const db = getDb()
  const settingsRows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, user.id))
    .limit(1)
  const sessionLimit = settingsRows[0]?.sessionLimit ?? 20

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">スマート復習</h1>
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-slate-700">
            設定した上限枚数まで、FSRS で due になった card を復習します。
          </p>
          <p className="mt-3 text-sm text-slate-600">
            現在の設定: <span className="font-medium">{sessionLimit} 枚</span>
          </p>
          <StartButton />
        </CardContent>
      </Card>
    </div>
  )
}
