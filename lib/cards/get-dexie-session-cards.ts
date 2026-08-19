// get-dexie-session-cards — Dexie mirror からスマート復習の出題プールを取得し、
// server Card 型に変換して返す(Dash-1 Home v1 §8.5 で選定契約を変更)。
//
// 役割境界:
// - Dexie cards table の唯一の "read for session" 入口。選定そのものは pure module
//   `lib/cards/domain/session-pool.ts` が持ち、本 module は「行を読む」ことと
//   「型を詰め替える」ことしかしない(server fallback `get-session-cards.ts` と
//   同一関数を消費する = 2 実装のずれを構造的に排除する)。
// - 失敗 (Dexie 例外) は呼出側で catch する想定で throw を握り潰さない。 0 件返却は
//   正常 (= まだ pull 未配線 / 出題可能なカードが無い)。
//
// 読み方:
// - 選択試験の全カードを `[user_id+exam_id]` compound index (v6) で読む。旧実装の
//   `[user_id+due]` range + `.limit(N)` は使えない: 新契約の選定は state 別条件・
//   base_order 順の新規部・当日導入数 u を要求し、どれも due の range では表現
//   できない。owner isolation は index 第 1 要素 user_id の equals fix で構造保証
//   (Y-2 T-B4 と同形)。
// - K(`exams.daily_new_target`)は同じ mirror の exams 行から読む。

import { getClientDb } from '@/lib/client-db'
import { selectSessionPool } from '@/lib/cards/domain/session-pool'
// client component から transitive import されるため、 `@/lib/db/cards-pull` (server-
// only) ではなく pure mapper module から直接 import する。
import { toCard } from '@/lib/db/cards-mapper'
import type { Card } from '@/lib/db/schema'

/**
 * 選択試験の出題プール(spec §8.5)を `session_limit` cap 付きで返す。
 *
 * @param userId  テナント識別子 (必須)
 * @param examId  選択中の試験 (spec §8.5: 全試験横断ではない)
 * @param limit   session_limit (1 以上)。null = 上限なし
 * @param now     判定基準時刻 (省略時は new Date())
 */
export async function getDueCardsFromDexie(
  userId: string,
  examId: string,
  limit: number | null,
  now: Date = new Date(),
): Promise<Card[]> {
  const db = getClientDb()
  const [exam, clientCards] = await Promise.all([
    db.exams.get(examId),
    db.cards.where('[user_id+exam_id]').equals([userId, examId]).toArray(),
  ])

  // exams は PK 読みで owner 固定にならないため、K を採用する前に owner を確認する
  // (query は必ず owner scope という絶対ルール側に倒す。不一致なら未設定扱い = 既定 K)。
  const dailyNewTarget =
    exam && exam.user_id === userId ? (exam.daily_new_target ?? null) : null

  const { pool } = selectSessionPool({
    cards: clientCards,
    examId,
    dailyNewTarget,
    now,
  })
  // session_limit の cap は**選定後**に掛ける。読み出し側(Dexie の cursor / SQL の
  // LIMIT)で切ると、未到来の短期 step(プールに入らない行)が席を食って server 経路
  // と結果が食い違う。代償は「cap を超える行を materialize する」点だが、選択試験
  // 1 つぶんの mirror 読みであり、正しさを優先する。
  const capped = limit === null ? pool : pool.slice(0, limit)
  return capped.map(toCard)
}
