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

import {
  getClientDb,
  type ClientCard,
  type ClientExam,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { getSyncMeta, SYNC_META_KEYS } from './sync-meta'
import { logger } from '@/lib/logger'

const PULL_ENDPOINT = '/api/pull'

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

// server /api/pull レスポンス形。 server の ClientTombstone を import せず inline 定義
// (client/server は JSON 契約で疎結合、 U4 採択)。
type PullResponse = {
  cards: ClientCard[]
  exams: ClientExam[]
  tombstones: {
    entity_type: 'exam' | 'card' | 'tag_category' | 'tag_option'
    entity_id: string
    deleted_at: string
  }[]
  tag_categories: ClientTagCategory[]
  tag_options: ClientTagOption[]
  cursors: {
    cards: string | null
    exams: string | null
    tombstone: string | null
    tag_categories: string | null
    tag_options: string | null
  }
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
  tagCategoryCount: number
  tagOptionCount: number
}

const FAIL: PullDeltaResult = {
  ok: false,
  cardCount: 0,
  examCount: 0,
  tombstoneCount: 0,
  tagCategoryCount: 0,
  tagOptionCount: 0,
}

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
  const [sinceCards, sinceExams, sinceTombstone, sinceTagCategories, sinceTagOptions] =
    await Promise.all([
      getSyncMeta(SYNC_META_KEYS.cardsCursor),
      getSyncMeta(SYNC_META_KEYS.examsCursor),
      getSyncMeta(SYNC_META_KEYS.tombstoneCursor),
      getSyncMeta(SYNC_META_KEYS.tagCategoriesCursor),
      getSyncMeta(SYNC_META_KEYS.tagOptionsCursor),
    ])

  const params = new URLSearchParams()
  if (sinceCards !== undefined) params.set('since_cards', sinceCards)
  if (sinceExams !== undefined) params.set('since_exams', sinceExams)
  if (sinceTombstone !== undefined) params.set('since_tombstone', sinceTombstone)
  if (sinceTagCategories !== undefined)
    params.set('since_tag_categories', sinceTagCategories)
  if (sinceTagOptions !== undefined)
    params.set('since_tag_options', sinceTagOptions)

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
  const {
    cards,
    exams,
    tombstones,
    tag_categories: tagCategories,
    tag_options: tagOptions,
    cursors,
  } = response.body
  if (
    !Array.isArray(cards) ||
    !Array.isArray(exams) ||
    !Array.isArray(tombstones) ||
    !Array.isArray(tagCategories) ||
    !Array.isArray(tagOptions) ||
    typeof cursors !== 'object' ||
    cursors === null
  ) {
    return FAIL
  }

  // §4: 1 tx で upsert + tombstone 削除 + cursor write
  const db = getClientDb()
  await db.transaction(
    'rw',
    [db.cards, db.exams, db.tag_categories, db.tag_options, db.sync_meta],
    async () => {
      // upsert (clear なし = id-upsert のみ)
      if (cards.length) await db.cards.bulkPut(cards)
      if (exams.length) await db.exams.bulkPut(exams)
      // Tag-1: tag マスタの upsert は tombstone 適用 *前* に行う。
      // 同 pull 内で「同 id の create + delete」 が同居しても、 後段の tombstone
      // bulkDelete で正しく消える順序を保証する。
      if (tagCategories.length) await db.tag_categories.bulkPut(tagCategories)
      if (tagOptions.length) await db.tag_options.bulkPut(tagOptions)

      // tombstone bulkDelete — mirror 削除反映の唯一経路。
      // サーバー側で card/exam/tag_category/tag_option を物理削除する経路は必ず
      // tombstone を INSERT すること (さもないと mirror が stale 化する)。
      // 不変条件は delete-card.ts / delete-exam.ts / tag apply 関数 (registry) 参照。
      const cardIds = tombstones
        .filter((t) => t.entity_type === 'card')
        .map((t) => t.entity_id)
      const examIds = tombstones
        .filter((t) => t.entity_type === 'exam')
        .map((t) => t.entity_id)
      const tagCategoryIds = tombstones
        .filter((t) => t.entity_type === 'tag_category')
        .map((t) => t.entity_id)
      const tagOptionIds = tombstones
        .filter((t) => t.entity_type === 'tag_option')
        .map((t) => t.entity_id)
      if (cardIds.length) await db.cards.bulkDelete(cardIds)
      if (examIds.length) await db.exams.bulkDelete(examIds)
      if (tagCategoryIds.length) await db.tag_categories.bulkDelete(tagCategoryIds)
      if (tagOptionIds.length) await db.tag_options.bulkDelete(tagOptionIds)

      // cursor write (非 null のみ。 null = 据え置き)
      if (cursors.cards)
        await db.sync_meta.put({ key: SYNC_META_KEYS.cardsCursor, value: cursors.cards })
      if (cursors.exams)
        await db.sync_meta.put({ key: SYNC_META_KEYS.examsCursor, value: cursors.exams })
      if (cursors.tombstone)
        await db.sync_meta.put({
          key: SYNC_META_KEYS.tombstoneCursor,
          value: cursors.tombstone,
        })
      if (cursors.tag_categories)
        await db.sync_meta.put({
          key: SYNC_META_KEYS.tagCategoriesCursor,
          value: cursors.tag_categories,
        })
      if (cursors.tag_options)
        await db.sync_meta.put({
          key: SYNC_META_KEYS.tagOptionsCursor,
          value: cursors.tag_options,
        })
    },
  )

  return {
    ok: true,
    cardCount: cards.length,
    examCount: exams.length,
    tombstoneCount: tombstones.length,
    tagCategoryCount: tagCategories.length,
    tagOptionCount: tagOptions.length,
  }
}

// ---------------------------------------------------------------------------
// runGuardedPull — in-flight guard + 多タブ Web Locks (ifAvailable skip)
// ---------------------------------------------------------------------------

// pull 同期用の単一固定 lock 名 (origin 内全タブ共有)。
export const PULL_LOCK_NAME = 'recallmint:pull'

export type PullGuardOutcome = 'ran' | 'inflight-skip' | 'lock-busy'

// Web Locks の最小型 (lib.dom の LockManager から本 module が使う部分のみ)。
// review-flush.ts の MinimalLockManager を手本に複製し、 callback 戻り値型を
// Promise<PullGuardOutcome> に置き換えたもの (共通 util 抽出はしない = U2 採択)。
type MinimalLockManager = {
  request: (
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<PullGuardOutcome>,
  ) => Promise<PullGuardOutcome>
}

type GuardedPullDeps = {
  reason?: string
  pull?: () => Promise<PullDeltaResult>
  locks?: MinimalLockManager | undefined
}

// 'locks' を明示指定すると navigator を見ない (undefined 指定で非対応 path を test 可能)。
function resolveLocks(deps: GuardedPullDeps): MinimalLockManager | undefined {
  if ('locks' in deps) return deps.locks
  // defensive: navigator.locks の存在チェックのみ。
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks as unknown as MinimalLockManager
  }
  return undefined
}

// 1 タブ内の in-flight pull を skip するための module-scope フラグ。
// 多タブ排他は Web Locks に委ねる。
let pullInFlight = false

// pullDelta を「1 タブ内 in-flight skip」+「多タブ Web Locks (ifAvailable skip)」で囲む。
// in-flight guard を最外に置く理由: locks.request の呼出自体もスキップするため、
// Lock API の非同期コストを払わずに即 return できる。
// fallback (locks なし) は直接実行する理由: Web Locks 非対応環境でも pull を止めない。
//   多重 pull は server 側 cursor 更新の冪等性で吸収される。
export async function runGuardedPull(deps: GuardedPullDeps = {}): Promise<PullGuardOutcome> {
  if (pullInFlight) {
    logger.info({ event: 'pull.inflight_skip', reason: deps.reason })
    return 'inflight-skip'
  }
  pullInFlight = true
  try {
    const pull = deps.pull ?? (() => pullDelta())
    const locks = resolveLocks(deps)
    if (!locks) {
      // Web Locks 非対応 (defensive): lock なしで直接 pull。
      await pull()
      return 'ran'
    }
    return await locks.request(PULL_LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        // 他タブが lock を保持中 → pull せず即 return (queue で待たない)。
        logger.info({ event: 'pull.lock_busy', lockName: PULL_LOCK_NAME, reason: deps.reason })
        return 'lock-busy'
      }
      await pull()
      return 'ran'
    })
  } finally {
    pullInFlight = false
  }
}
