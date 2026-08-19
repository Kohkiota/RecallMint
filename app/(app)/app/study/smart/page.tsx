// スマート復習 page (Server Component、 S2.2.1 T2 で session/page.tsx 統合)。
//
// 認証 → user_settings 取得 (session_limit / fsrsMode、 行不在は 20 / false fallback) →
// 出題プール取得 (選択試験スコープ) → StudySessionHost に渡す。 cards 0 件 /
// server fetch fail の empty UI 判定は host 側 (Dexie + server 両方 0 件のときの
// 一元判断、 S-local-4)。
//
// Dash-1 Home v1 §8.5 / §6: `exam` / `origin` を searchParams から読む。
// - `exam` 不在 (bookmark 直行) では server 取得を行わない。試験の解決は Dexie
//   mirror(保存値 / 1 件自動)を要するため client の共通 resolver 側にしかできず、
//   ここで別の解決手段を持つと 2 実装になる。この場合 host が Dexie から選定する。
// - `origin` は **信頼しない**: 既知値の `home_today` のみ通し、他は全て `smart` に
//   落とす(§11.3 の語彙 = `ORIGIN_VALUES` の 1 箇所を経由)。client flush は wire
//   schema 違反を terminal 失敗として回答 event を恒久破棄するため、query 由来の
//   長大値を素通しすると実データが失われる(Task 4 Ruling 12)。

import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { normalizeOriginValue } from '@/lib/dashboard/domain/origin-values'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { userSettings, type Card } from '@/lib/db/schema'
import { getSessionCards } from '@/lib/cards/get-session-cards'
import { AppContainer } from '../../_components/app-container'
import { StudySessionHost } from './_components/study-session-host'

// 配列で来た場合 (?exam=a&exam=b) は先頭のみ採用 (dashboard page の billing と同方針)。
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function SmartStudyPage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>
}) {
  const user = await getCurrentUser()
  // getCurrentUser は UnauthenticatedError を throw するが、
  // /app layout の auth middleware が事前に guard するため、
  // ここで null が返ることは基本ない。 防御的に null チェックのみ。
  if (!user) return null

  const sp = await searchParams
  const examId = firstParam(sp.exam)
  const origin =
    normalizeOriginValue(firstParam(sp.origin)) === 'home_today'
      ? 'home_today'
      : 'smart'

  // RLS-P3 Wave2: user_settings read を tenant context 下に入れる。cards の
  // withTenantTx(下記)とは別 tx = settings/cards が別 snapshot になる非原子性は
  // 配線前から不変(意図的に維持)。
  const settingsRows = await withTenantTx(user.id, (tx) =>
    tx
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, user.id))
      .limit(1),
  )
  const row = settingsRows[0]
  const sessionLimit = row ? row.sessionLimit : 20  // 行不在のみ 20。 明示 null = 上限なし は維持
  const fsrsMode = row ? row.fsrsMode : false

  // S-local-4 (Phase γ): server fetch を try/catch、 throw 時 cards=[]。 これにより
  // offline / server 5xx / 無効な exam 値でも page render fail せず、 client
  // (StudySessionHost) が Dexie cards で続行できる。 Dexie / server 両方 0 件のときの
  // empty UI も host 側。
  let serverCards: Card[] = []
  if (examId !== undefined) {
    try {
      serverCards = await withTenantTx(user.id, (tx) =>
        getSessionCards(user.id, examId, sessionLimit, tx),
      )
    } catch {
      // silent: client が Dexie cards mirror で代替する
    }
  }

  // S-local-3: userId / sessionLimit を渡し、 client が Dexie cards mirror から
  // 直接出題プールを引いて (mirror が空なら server cards で fallback)。 userId は
  // flush の owner-scope にも使われる (spec §4.6)。
  // S-local-4: cards=[] でも host に進む (empty UI 判定は host 内)。
  return (
    <AppContainer>
      <StudySessionHost
        cards={serverCards}
        fsrsMode={fsrsMode}
        userId={user.id}
        sessionLimit={sessionLimit}
        examId={examId}
        origin={origin}
      />
    </AppContainer>
  )
}
