// get-dexie-session-cards — Dexie cards (S-local-2 で mirror 済) から smart
// session 用 due cards を取得し、 server Card 型に変換して返す (S-local-3 Task 2)。
//
// 役割境界:
// - Dexie cards table の唯一の "read for session" 入口。 ここで tenant filter +
//   due 比較 + sort + limit を一括処理し、 呼出側 (StudySessionHost) は Card[] のみ
//   見れば良い構造にする。
// - 失敗 (Dexie 例外) は呼出側で catch する想定で throw を握り潰さない。 0 件返却は
//   正常 (= まだ pull 未配線 / 全 card future due)。
//
// 比較戦略:
// - cards.due は ISO8601 文字列で保存 (Dexie 統一)。 ISO8601 は lexicographic
//   compare で時系列正しく動くため、 `card.due <= nowIso` で due 判定可能。
// - FSRS scheduler を client で動かす必要はない (本 sprint 範囲外)、 単純な日付
//   比較で十分。

import { getClientDb, type ClientCard } from '@/lib/client-db'
import { toCard } from '@/lib/db/cards-pull'
import type { Card } from '@/lib/db/schema'

export async function getDueCardsFromDexie(
  userId: string,
  limit: number,
  now: Date = new Date(),
): Promise<Card[]> {
  const nowIso = now.toISOString()
  const userCards = await getClientDb()
    .cards.where('user_id')
    .equals(userId)
    .toArray()
  const due = userCards
    .filter((c: ClientCard) => c.due <= nowIso)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
    .slice(0, limit)
  return due.map(toCard)
}
