// sort-like-server — server の `ORDER BY sort_key, created_at` を
// Dexie 配列上で再現する純関数。 Dexie hook / React に依存しないため
// node テスト・custom session selector・inline-card-list から共用できる。

import type { ClientCard } from '@/lib/client-db'

// server (getCardsForExam) の `ORDER BY sort_key, created_at` を Dexie 配列上で再現。
// Postgres ASC は NULL を末尾に置くため、 sort_key 非 null を辞書順 ASC で先に、
// null は末尾、 同 key 内 (null 同士含む) は created_at ASC を tiebreak とする。
export function sortLikeServer(a: ClientCard, b: ClientCard): number {
  const aKey = a.sort_key ?? null
  const bKey = b.sort_key ?? null
  if (aKey !== bKey) {
    if (aKey === null) return 1 // null は後ろ (NULLS LAST)
    if (bKey === null) return -1
    return aKey < bKey ? -1 : 1
  }
  // 同 sort_key (null 同士含む): created_at ASC
  if (a.created_at === b.created_at) return 0
  return a.created_at < b.created_at ? -1 : 1
}
