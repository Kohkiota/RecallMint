// event-order — 定義 doc §4-K の決定的順序規則(answered_at 昇順 + event_id 昇順)と、
// 初見(K)/復習(L 近似版)の分割(§4-K/§4-L)。§3.11 の履歴完全性前提が崩れる経路の
// 扱い(「判定不能は初見にしない」)はこの module の責務外(呼び出し元が §3.11 の 3 経路
// を検出して母集合から除外してから渡す前提 — ここは「渡された配列を正しい順で分割する」
// ことだけを担う)。
//
// PURE 制約(lib/*/domain 前例に倣う): I/O なし・DB / Dexie / next を import しない。

/**
 * 順序判定に必要な最小フィールド。`answered_at` は Dexie(ISO 文字列)/ server(Date)の
 * どちらのネイティブ表現でも渡せるよう `Date | string` を受け付ける
 * (card-classification.ts の `due` と同じ理由・同じ変換方針)。
 */
export interface DashboardEventInput {
  card_id: string
  event_id: string
  answered_at: Date | string
  is_correct: boolean
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

/**
 * 決定的順序の比較関数(定義 doc §4-K)。`answered_at` 昇順、同値は `event_id` 昇順。
 * `event_id` は UUIDv4 なので真の回答順を表さないが、必要なのは再現性のある一意化で
 * あって真の順序の復元ではない(§4-K の受容)。
 */
export function compareEvents(
  a: Pick<DashboardEventInput, 'answered_at' | 'event_id'>,
  b: Pick<DashboardEventInput, 'answered_at' | 'event_id'>,
): number {
  const at = toDate(a.answered_at).getTime() - toDate(b.answered_at).getTime()
  if (at !== 0) return at
  if (a.event_id < b.event_id) return -1
  if (a.event_id > b.event_id) return 1
  return 0
}

/**
 * card_id ごとに §4-K の順序で並べ、各 card の先頭 1 件を初見(K)、残りを復習(L 近似版)
 * に分割する(定義 doc §4-K/§4-L)。入力の並び順には依存しない(内部で card_id ごとに
 * 再ソートする)。first / review の各配列内の相対順は保証しない(呼び出し元は集合として
 * 消費する用途を想定 — 正答率の分母/分子計算に順序は不要)。
 */
export function splitFirstAndReview<T extends DashboardEventInput>(
  events: readonly T[],
): { first: T[]; review: T[] } {
  const byCard = new Map<string, T[]>()
  for (const ev of events) {
    const group = byCard.get(ev.card_id)
    if (group) group.push(ev)
    else byCard.set(ev.card_id, [ev])
  }

  const first: T[] = []
  const review: T[] = []
  for (const group of byCard.values()) {
    const sorted = [...group].sort(compareEvents)
    first.push(sorted[0])
    for (let i = 1; i < sorted.length; i++) review.push(sorted[i])
  }

  return { first, review }
}
