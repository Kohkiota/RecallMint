// pull delta orchestrator — 統合 GET /api/pull 参照の増分 merge。
// cursor 3本 (cards/exams/tombstone) を sync_meta から read し ?since_* で叩き、
// 1 tx で bulkPut upsert + tombstone bulkDelete + cursor write を適用する。
//
// 失敗時の不変性:
// - network throw / non-2xx / response body 不正のいずれも、 tx を開く前に return。
//   Dexie cards / exams / sync_meta いずれも touch しない。
//
// mirror 削除反映の不変条件:
// clear() は使わず id-upsert のみ行うため、 mirror から card/exam を消す唯一の経路は
// tombstone bulkDelete (下記 §tx)。 サーバー側で card/exam を物理削除する経路は
// 必ず tombstone を INSERT すること (さもないと client mirror が stale 化する)。
// → pull.ts 参照。 server 側の不変条件は delete-card.ts / delete-exam.ts にも明記。

import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { getSyncMeta, SYNC_META_KEYS } from './sync-meta'

const PULL_ENDPOINT = '/api/pull'

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

// server /api/pull レスポンス形。 server の ClientTombstone を import せず inline 定義
// (client/server は JSON 契約で疎結合、 U4 採択)。
type PullResponse = {
  cards: ClientCard[]
  exams: ClientExam[]
  tombstones: { entity_type: 'exam' | 'card'; entity_id: string; deleted_at: string }[]
  cursors: { cards: string | null; exams: string | null; tombstone: string | null }
}

export type PullApiClient = {
  get: (path: string) => Promise<{
    ok: boolean
    status: number
    body: PullResponse | null
  }>
}

export type PullDeltaResult = {
  ok: boolean
  cardCount: number
  examCount: number
  tombstoneCount: number
}

const FAIL: PullDeltaResult = { ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0 }

// ---------------------------------------------------------------------------
// defaultClient: fetch ラッパ。 throw → {ok:false,status:0,body:null}
// ---------------------------------------------------------------------------

const defaultClient: PullApiClient = {
  get: async (path) => {
    try {
      const res = await fetch(path, { method: 'GET' })
      let body: PullResponse | null = null
      try {
        body = (await res.json()) as PullResponse
      } catch {
        body = null
      }
      return { ok: res.ok, status: res.status, body }
    } catch {
      return { ok: false, status: 0, body: null }
    }
  },
}

// ---------------------------------------------------------------------------
// pullDelta
// ---------------------------------------------------------------------------

export async function pullDelta(
  client: PullApiClient = defaultClient,
): Promise<PullDeltaResult> {
  // §1: cursor read + URLSearchParams 構築 (存在分のみ set)
  const [sinceCards, sinceExams, sinceTombstone] = await Promise.all([
    getSyncMeta(SYNC_META_KEYS.cardsCursor),
    getSyncMeta(SYNC_META_KEYS.examsCursor),
    getSyncMeta(SYNC_META_KEYS.tombstoneCursor),
  ])

  const params = new URLSearchParams()
  if (sinceCards !== undefined) params.set('since_cards', sinceCards)
  if (sinceExams !== undefined) params.set('since_exams', sinceExams)
  if (sinceTombstone !== undefined) params.set('since_tombstone', sinceTombstone)

  const query = params.toString()
  const path = query ? `${PULL_ENDPOINT}?${query}` : PULL_ENDPOINT

  // §2: fetch (throw → defaultClient が {ok:false} を返す)
  let response: Awaited<ReturnType<PullApiClient['get']>>
  try {
    response = await client.get(path)
  } catch {
    return FAIL
  }

  if (!response.ok || !response.body) {
    return FAIL
  }

  // §3: shape 検証 (tx を開く前に完了 → 失敗時不変性)
  const { cards, exams, tombstones, cursors } = response.body
  if (
    !Array.isArray(cards) ||
    !Array.isArray(exams) ||
    !Array.isArray(tombstones) ||
    typeof cursors !== 'object' ||
    cursors === null
  ) {
    return FAIL
  }

  // §4: 1 tx で upsert + tombstone 削除 + cursor write
  const db = getClientDb()
  await db.transaction('rw', db.cards, db.exams, db.sync_meta, async () => {
    // upsert (clear なし = id-upsert のみ)
    if (cards.length) await db.cards.bulkPut(cards)
    if (exams.length) await db.exams.bulkPut(exams)

    // tombstone bulkDelete — mirror 削除反映の唯一経路。
    // サーバー側で card/exam を物理削除する経路は必ず tombstone を INSERT すること
    // (さもないと mirror が stale 化する)。不変条件は delete-card.ts / delete-exam.ts 参照。
    const cardIds = tombstones
      .filter((t) => t.entity_type === 'card')
      .map((t) => t.entity_id)
    const examIds = tombstones
      .filter((t) => t.entity_type === 'exam')
      .map((t) => t.entity_id)
    if (cardIds.length) await db.cards.bulkDelete(cardIds)
    if (examIds.length) await db.exams.bulkDelete(examIds)

    // cursor write (非 null のみ。 null = 据え置き)
    if (cursors.cards)
      await db.sync_meta.put({ key: SYNC_META_KEYS.cardsCursor, value: cursors.cards })
    if (cursors.exams)
      await db.sync_meta.put({ key: SYNC_META_KEYS.examsCursor, value: cursors.exams })
    if (cursors.tombstone)
      await db.sync_meta.put({ key: SYNC_META_KEYS.tombstoneCursor, value: cursors.tombstone })
  })

  return { ok: true, cardCount: cards.length, examCount: exams.length, tombstoneCount: tombstones.length }
}
