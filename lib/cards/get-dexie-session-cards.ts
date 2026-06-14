// get-dexie-session-cards — Dexie cards (S-local-2 で mirror 済) から smart
// session 用 due cards を取得し、 server Card 型に変換して返す (S-local-3 Task 2)。
//
// 役割境界:
// - Dexie cards table の唯一の "read for session" 入口。 ここで `[user_id+due]`
//   compound index (v7) の range cursor + `.limit(N)` で tenant filter + due 範囲
//   + 上限件数を一括処理し、 呼出側 (StudySessionHost) は Card[] のみ見れば良い
//   構造にする。
// - 失敗 (Dexie 例外) は呼出側で catch する想定で throw を握り潰さない。 0 件返却は
//   正常 (= まだ pull 未配線 / 全 card future due)。
//
// 比較戦略:
// - cards.due は ISO8601 文字列で保存 (Dexie 統一)。 ISO8601 は lexicographic
//   compare で時系列正しく動くため、 compound index `[user_id+due]` の range bound
//   `between([uid,'0'],[uid,nowIso], true, true)` で due 判定可能。
// - FSRS scheduler を client で動かす必要はない (本 sprint 範囲外)、 単純な日付
//   比較で十分。

import { getClientDb } from '@/lib/client-db'
// client component から transitive import されるため、 `@/lib/db/cards-pull` (server-
// only) ではなく pure mapper module から直接 import する。
import { toCard } from '@/lib/db/cards-mapper'
import type { Card } from '@/lib/db/schema'

export async function getDueCardsFromDexie(
  userId: string,
  limit: number,
  now: Date = new Date(),
): Promise<Card[]> {
  const nowIso = now.toISOString()
  // Y-2 T-B7: compound index `[user_id+due]` (v7) で due ASC を index 順 cursor
  // で enumerate し、 .limit(N) で body fetch を最大 N 件に抑える。 第 1 要素
  // user_id の equals fix で tenant 漏れを構造保証 (T-B4 / T-B6 と同形)。
  // .between() の第 4 引数 true (includeUpper) は必須: default は upper
  // exclusive で `due == nowIso` ぴったりの card を session から落とす real bug
  // となる (T-B6 §補-E.3 で確立、 dashboard-actions.tsx:50 と同文面)。
  // index 順が due ASC 構造的に成立するため .sortBy() は呼ばない (呼ぶと内部で
  // 全件 materialize → JS sort になり index 利点を消す)。
  const userCards = await getClientDb()
    .cards.where('[user_id+due]')
    .between([userId, '0'], [userId, nowIso], true, true)
    .limit(limit)
    .toArray()
  return userCards.map(toCard)
}
