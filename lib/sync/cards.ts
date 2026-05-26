// cards sync helper — server `/api/cards/pull` から user の全 cards を取得し、
// Dexie `cards` table を atomic に replace。 成功時のみ sync_meta を update。
// S-local-2 Task 4 (§14.11 local-first MVP)。
//
// 役割境界:
// - PullApiClient: fetch 周りの DI 境界。 test では mock を注入する。
// - pullAllCards: replace 戦略 (clear + bulkPut) を transaction 内で行い、 race を
//   排除する。 失敗は silent (= 次トリガで再試行、 既存 review-events と同方針)。
//
// 失敗時の不変性:
// - network throw / non-2xx / response body 不正のいずれも、 Dexie cards / sync_meta
//   いずれも touch しない。 user data に影響を与えない最重要不変条件。

import { getClientDb, type ClientCard } from '@/lib/client-db'
import { SYNC_META_KEYS } from './sync-meta'

const CARDS_PULL_ENDPOINT = '/api/cards/pull'

export type PullApiClient = {
  get: (path: string) => Promise<{
    ok: boolean
    status: number
    body: { cards?: ClientCard[]; now?: string; error?: string } | null
  }>
}

export type PullResult = {
  ok: boolean
  count: number
}

// fetch 既定実装。 test では injection で差し替える (review-events.ts の defaultClient
// と同 pattern)。 失敗は throw ではなく { ok:false, status:0, body:null } で返し、
// 呼出側の silent return 経路に乗せる。
const defaultClient: PullApiClient = {
  get: async (path) => {
    try {
      const res = await fetch(path, { method: 'GET' })
      let body: { cards?: ClientCard[]; now?: string; error?: string } | null = null
      try {
        body = (await res.json()) as typeof body
      } catch {
        body = null
      }
      return { ok: res.ok, status: res.status, body }
    } catch {
      return { ok: false, status: 0, body: null }
    }
  },
}

export async function pullAllCards(
  client: PullApiClient = defaultClient,
): Promise<PullResult> {
  let response: Awaited<ReturnType<PullApiClient['get']>>
  try {
    response = await client.get(CARDS_PULL_ENDPOINT)
  } catch {
    return { ok: false, count: 0 }
  }
  if (!response.ok || !response.body) {
    return { ok: false, count: 0 }
  }
  const { cards, now } = response.body
  if (!Array.isArray(cards) || typeof now !== 'string') {
    return { ok: false, count: 0 }
  }

  const db = getClientDb()
  await db.transaction('rw', db.cards, db.sync_meta, async () => {
    await db.cards.clear()
    if (cards.length > 0) {
      await db.cards.bulkPut(cards)
    }
    await db.sync_meta.put({ key: SYNC_META_KEYS.lastCardPullAt, value: now })
  })
  return { ok: true, count: cards.length }
}
