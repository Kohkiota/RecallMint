// get-session-cards — スマート復習の出題プールを server 側で組む fallback query
// (Dash-1 Home v1 §8.5 で選定契約を変更。client の Dexie 経路が主・本経路は mirror
// が空/失敗のときの代替)。
//
// 選定そのものは pure module `lib/cards/domain/session-pool.ts` が持ち、本 module は
// 「候補行を読む」ことと「型を詰め替える」ことしかしない(client 経路
// `get-dexie-session-cards.ts` と同一関数を消費する = 2 実装のずれを構造的に排除)。
//
// 読み方(なぜ 2 本の SELECT か): 選定条件を SQL に写すと契約が 2 箇所に増えるため、
// SQL では**選定に要る行の上位集合**だけを取り、判定は全て pure module に任せる。
// - 復習候補: state ≠ 0 かつ (due < 今日の終わり **または** first_reviewed_at が今日
//   以降 **または** state ∈ {1,3})。
//   - 2 つ目の OR は u(当日導入数)のため。今日導入して翌日以降へ飛んだカードを
//     取りこぼすと K の枠が過大になる(soft limit の唯一の強制点が緩む)。
//   - 3 つ目の OR は `nextAvailableAt` のため。未到来の短期 step は定義上 state 1/3
//     しか成りえないので、この 1 枝で pure module の戻り値が全項目そろう(fix round
//     1/5: 「pool しか使わないから nextAvailableAt は不正確でよい」を撤回 —
//     部分的に間違った値を返す関数は次の consumer への罠になる)。Review 本体を
//     無条件に読むわけではないので追加コストは「今日以降に持ち越された学習中
//     カード」ぶんに限られる。
// - 新規候補: state = 0 を base_order ASC, id ASC で K 件。k ≤ K なので pure module が
//   選ぶ先頭 k 件は必ずこの K 件に含まれる(上位集合)。全新規カードは due = 作成
//   時刻ゆえ無条件に読むと exam 全件 scan になるため、順序 + LIMIT で抑える。

import { and, asc, eq, gte, inArray, lt, ne, or } from 'drizzle-orm'
import { selectSessionPool, type SessionPoolCard } from '@/lib/cards/domain/session-pool'
import { DAILY_NEW_DEFAULT } from '@/lib/dashboard/domain/metric-constants'
import { cards, exams, type Card } from '@/lib/db/schema'
import { jstDayRange, todayInJst } from '@/lib/jst'
import type { TenantDb } from '@/lib/db/tenant-tx'

// pure module は snake_case の最小形を要求するため、drizzle 行をその形に詰め替えつつ
// 元行を持ち回る(選定結果から Card へ戻すのに再検索を要らなくする)。
type ServerPoolCard = SessionPoolCard & { row: Card }

function toPoolCard(row: Card): ServerPoolCard {
  return {
    id: row.id,
    exam_id: row.examId,
    state: row.state,
    due: row.due,
    base_order: row.baseOrder,
    first_reviewed_at: row.firstReviewedAt,
    row,
  }
}

/**
 * 選択試験の出題プール(spec §8.5)を `session_limit` cap 付きで返す。
 *
 * @param userId  テナント識別子 (必須)
 * @param examId  選択中の試験 (spec §8.5: 全試験横断ではない)
 * @param limit   session_limit (1 以上)。null = 上限なし
 * @param dbc     tenant context 下の接続ハンドル (withTenantTx 由来の tx)
 * @param now     判定基準時刻 (省略時は new Date())
 */
export async function getSessionCards(
  userId: string,
  examId: string,
  limit: number | null,
  dbc: TenantDb,
  now?: Date,
): Promise<Card[]> {
  const db = dbc
  const at = now ?? new Date()
  const { startAt, endAt } = jstDayRange(todayInJst(at))

  const examRows = await db
    .select({ dailyNewTarget: exams.dailyNewTarget })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
    .limit(1)
  const dailyNewTarget = examRows[0]?.dailyNewTarget ?? null

  const reviewRows = await db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.userId, userId),
        eq(cards.examId, examId),
        ne(cards.state, 0),
        or(
          lt(cards.due, endAt),
          gte(cards.firstReviewedAt, startAt),
          inArray(cards.state, [1, 3]),
        ),
      ),
    )
  const newRows = await db
    .select()
    .from(cards)
    .where(
      and(eq(cards.userId, userId), eq(cards.examId, examId), eq(cards.state, 0)),
    )
    .orderBy(asc(cards.baseOrder), asc(cards.id))
    .limit(dailyNewTarget ?? DAILY_NEW_DEFAULT)

  const { pool } = selectSessionPool<ServerPoolCard>({
    cards: [...reviewRows, ...newRows].map(toPoolCard),
    examId,
    dailyNewTarget,
    now: at,
  })
  // session_limit の cap は**選定後**に掛ける。SQL 側の LIMIT で切ると、未到来の
  // 短期 step(プールに入らない行)が席を食って client 経路と結果が食い違う
  // (client は全候補から選んでから cap する)。cap 前のプールは W2 の内訳とも
  // 同じ集合であるべきなので、切るのは最後の 1 手に限る。
  const capped = limit === null ? pool : pool.slice(0, limit)
  return capped.map((candidate) => candidate.row)
}
