// クイック演習 page (Server Component。design doc §7)。
//
// smart/page.tsx と同型: 認証 → user_settings (session_limit / fsrs_mode) 取得 →
// client host へ受け渡す。差分: quick はデータ源が L1(Dexie)のみで server
// fallback を持たない設計(定義 doc W5「データ源 = L1 + L2(L2 は 10分の件数計算
// のみ)・L3 依存なし」)なので、smart と違い server 側の card 取得は行わない —
// 選定は client host(`QuickSessionHost`)が Dexie mirror から行う。
//
// origin は preset(+ tag)から**host 側で**導出する(§7 / §11.1)。query の
// `origin` は一切読まない(§7): client flush は wire schema 検証失敗を terminal
// 失敗として回答 event を恒久破棄するため、未検証の長大値を素通しさせない
// (smart/page.tsx の origin 正規化と同じ懸念だが、quick は preset から導出する
// ため RSC 側で origin という query key 自体を読む必要がそもそも無い)。

import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { userSettings } from '@/lib/db/schema'
import { AppContainer } from '../../_components/app-container'
import { QuickSessionHost } from './_components/quick-session-host'

// 配列で来た場合 (?preset=a&preset=b) は先頭のみ採用 (smart/page.tsx と同方針)。
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function QuickStudyPage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>
}) {
  const user = await getCurrentUser()
  // getCurrentUser は UnauthenticatedError を throw するが、
  // /app layout の auth middleware が事前に guard するため、
  // ここで null が返ることは基本ない。防御的に null チェックのみ。
  if (!user) return null

  const sp = await searchParams
  const examId = firstParam(sp.exam)
  const preset = firstParam(sp.preset)
  const tagOptionId = firstParam(sp.tag)

  // RLS-P3 Wave2 踏襲(smart/page.tsx と同方針): user_settings read を tenant
  // context 下に入れる。
  const settingsRows = await withTenantTx(user.id, (tx) =>
    tx
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, user.id))
      .limit(1),
  )
  const row = settingsRows[0]
  const sessionLimit = row ? row.sessionLimit : 20 // 行不在のみ 20。明示 null = 上限なし は維持
  const fsrsMode = row ? row.fsrsMode : false

  return (
    <AppContainer>
      <QuickSessionHost
        userId={user.id}
        sessionLimit={sessionLimit}
        fsrsMode={fsrsMode}
        examId={examId}
        preset={preset}
        tagOptionId={tagOptionId}
      />
    </AppContainer>
  )
}
