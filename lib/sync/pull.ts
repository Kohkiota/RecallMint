// pull delta orchestrator — 統合 GET /api/pull 参照の増分 merge。
// cursor 6本 (cards/exams/tombstone/tag_categories/tag_options/card_tags) を sync_meta から
// read し ?since_* で叩き、 1 tx で bulkPut upsert + tombstone bulkDelete + cursor write を
// 適用する。
//
// owner による空間的分離 (S-local-2 / spec §5):
// - cursor key は userId 名前空間 (`${base}:${userId}`)。 pullDelta は開始時に渡された
//   userId を capture し、 read と write の両方に同じ値を使う。 「現在の user」 を表す
//   mutable な状態を完了時に参照してはならない (遅着レスポンスが次 user の namespace を
//   汚す race を再生産するため)。
// - 応答は tx を開く前に owner 検証する (下記 §3a)。
//
// 失敗時の不変性:
// - network throw / non-2xx / response body 不正 / owner 検証違反のいずれも、 tx を
//   開く前に return。 Dexie cards / exams / sync_meta いずれも touch しない。
//
// cursor CAS (spec §3):
// - §1 の cursor read と §4 の apply tx の間には network 窓があり、 その間に
//   sign-out purge / sign-in sweep が sync_meta を消しうる。 空になった mirror へ
//   旧 cursor 由来の delta を apply して新 cursor を書くと、 次回 pull が delta 継続に
//   なり purge で消えた行が永続的に silent 欠落する。 これを防ぐため apply tx の
//   先頭 (§4-(0)) で cursor 6 本を tx 内再読し、 §1 の snapshot と全一致しなければ
//   tx ごと abort する。
//
// mirror 削除反映の不変条件:
// clear() は使わず id-upsert のみ行うため、 mirror から card/exam を消す唯一の経路は
// tombstone bulkDelete (下記 §tx)。 サーバー側で card/exam を物理削除する経路は
// 必ず tombstone を INSERT すること (さもないと client mirror が stale 化する)。
// → pull.ts 参照。 server 側の不変条件は delete-card.ts / delete-exam.ts にも明記。
//
// card_tags の同期穴対策 (Tag-2b 案 a):
//   card_tags 単体の cursor は created_at base なので「関連付けのみ外す `[A,B] → []`」 の
//   ような whole-set 縮小は増分に乗らない。 書込側は cards.updated_at を bump する規約
//   を持ち、 本 pull は cards 増分 (1) で変更カードを検知 → (2) で当該カードの card_tags を
//   IDB から全削除 → (3) で card_tags 増分の bulkPut で新集合を upsert する順序を保つ。

import {
  getClientDb,
  type ClientCard,
  type ClientExam,
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'
import { getSyncMeta, scopedSyncMetaKey, SYNC_META_KEYS } from './sync-meta'
import { withWebLock, type MinimalLockManager } from './with-web-lock'
import { logger } from '@/lib/logger'

const PULL_ENDPOINT = '/api/pull'

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

// server /api/pull レスポンス形。 server の ClientTombstone を import せず inline 定義
// (client/server は JSON 契約で疎結合、 U4 採択)。
type PullResponse = {
  // spec §5.1a: 応答の出所 (server が認証した user.id)。 client の capture 値と
  // 突き合わせて全体 reject するための echo。
  owner_user_id: string
  cards: ClientCard[]
  exams: ClientExam[]
  tombstones: {
    entity_type: 'exam' | 'card' | 'tag_category' | 'tag_option'
    entity_id: string
    deleted_at: string
  }[]
  tag_categories: ClientTagCategory[]
  tag_options: ClientTagOption[]
  card_tags: ClientCardTag[]
  cursors: {
    cards: string | null
    exams: string | null
    tombstone: string | null
    tag_categories: string | null
    tag_options: string | null
    card_tags: string | null
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
  cardTagCount: number
}

const FAIL: PullDeltaResult = {
  ok: false,
  cardCount: 0,
  examCount: 0,
  tombstoneCount: 0,
  tagCategoryCount: 0,
  tagOptionCount: 0,
  cardTagCount: 0,
}

// apply tx 先頭の cursor CAS 不一致を表す module-private sentinel (spec §3)。
// Dexie の tx abort は例外でしか起こせないため、 この型で abort 理由を識別し、
// 呼出側で silent FAIL 契約 ({ok:false}) へ正規化する。 export しない = 外部から
// この経路を throw / catch できない (誤って通常の IDB 障害と混同させないため)。
class CursorCasMismatchError extends Error {
  constructor() {
    super('pull: cursor CAS mismatch')
  }
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
  userId: string,
  client: PullApiClient = defaultClient,
): Promise<PullDeltaResult> {
  // §0: fail-closed。 空 userId は network にも Dexie にも触れずに FAIL
  // (未認証状態からの誤 kick を無名前空間の書込に落とさない)。
  if (!userId) return FAIL

  // §1: cursor read + URLSearchParams 構築 (存在分のみ set)。
  // key は capture した userId の名前空間 (B の cursor は A の pull から見えない)。
  const [
    sinceCards,
    sinceExams,
    sinceTombstone,
    sinceTagCategories,
    sinceTagOptions,
    sinceCardTags,
  ] = await Promise.all([
    getSyncMeta(SYNC_META_KEYS.cardsCursor, userId),
    getSyncMeta(SYNC_META_KEYS.examsCursor, userId),
    getSyncMeta(SYNC_META_KEYS.tombstoneCursor, userId),
    getSyncMeta(SYNC_META_KEYS.tagCategoriesCursor, userId),
    getSyncMeta(SYNC_META_KEYS.tagOptionsCursor, userId),
    getSyncMeta(SYNC_META_KEYS.cardTagsCursor, userId),
  ])

  const params = new URLSearchParams()
  if (sinceCards !== undefined) params.set('since_cards', sinceCards)
  if (sinceExams !== undefined) params.set('since_exams', sinceExams)
  if (sinceTombstone !== undefined) params.set('since_tombstone', sinceTombstone)
  if (sinceTagCategories !== undefined)
    params.set('since_tag_categories', sinceTagCategories)
  if (sinceTagOptions !== undefined)
    params.set('since_tag_options', sinceTagOptions)
  if (sinceCardTags !== undefined)
    params.set('since_card_tags', sinceCardTags)

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
    owner_user_id: ownerUserId,
    cards,
    exams,
    tombstones,
    tag_categories: tagCategories,
    tag_options: tagOptions,
    card_tags: cardTags,
    cursors,
  } = response.body
  if (
    !Array.isArray(cards) ||
    !Array.isArray(exams) ||
    !Array.isArray(tombstones) ||
    !Array.isArray(tagCategories) ||
    !Array.isArray(tagOptions) ||
    !Array.isArray(cardTags) ||
    typeof cursors !== 'object' ||
    cursors === null
  ) {
    return FAIL
  }

  // §3a: owner 検証 (spec §5.1a)。 tx を開く前に済ませ、 違反時は mirror / cursor とも
  // 一切書かずに FAIL を返す。 log は event 名 + 件数のみ (userId / payload 内容は出さない)。
  const counts = {
    cards: cards.length,
    exams: exams.length,
    tombstones: tombstones.length,
    tagCategories: tagCategories.length,
    tagOptions: tagOptions.length,
    cardTags: cardTags.length,
  }
  // (a) owner echo。 field 欠落 (undefined) も不一致として reject する。
  // tombstone は user_id を持たない (lib/db/tombstones-pull.ts の ClientTombstone) ため
  // 行検証が原理的に不能で、 空 payload / tombstone-only 応答の owner 検証は
  // この echo が単独で担う。
  // 副次: /api/pull の emptyBody (sign-up race の静的リテラル) は owner_user_id を
  // 構造上持てないため常にここで reject されるが、 payload 空 + cursors 全 null で
  // 書くものが無く実害はない (特例分岐を設けず uniform な reject 規則を保つ)。
  if (ownerUserId !== userId) {
    logger.warn({ event: 'pull.owner_echo_mismatch', ...counts })
    return FAIL
  }
  // (b) owner 列を持つ 5 stream の全行検証 (echo だけでは行単位の混入を捕まえられない)。
  const ownedStreams: { user_id: string }[][] = [
    cards,
    exams,
    tagCategories,
    tagOptions,
    cardTags,
  ]
  if (ownedStreams.some((rows) => rows.some((row) => row.user_id !== userId))) {
    logger.warn({ event: 'pull.owner_row_mismatch', ...counts })
    return FAIL
  }

  // §4: 1 tx で cursor CAS + upsert + tombstone 削除 + cursor write
  // Tag-2b 案 a の取り直し経路を含む。 順序は厳守 (本 file 冒頭コメント参照):
  //   0. cursor CAS 再読        // 不一致なら何も書かずに tx ごと abort
  //   1. cards.bulkPut          // 既存
  //   2. 変更カード分の card_tags 全削除  // ★案 a の核心 (空集合化対応)
  //   3. card_tags.bulkPut      // 新集合の上書き
  //   4. tombstone bulkDelete (cards/exams/tag_categories/tag_options/card_tags cascade)
  //   5. cursor write
  const db = getClientDb()
  try {
    await db.transaction(
      'rw',
      [
        db.cards,
        db.exams,
        db.tag_categories,
        db.tag_options,
        db.card_tags,
        db.sync_meta,
      ],
      async () => {
        // (0) cursor CAS (spec §3)。 §1 で読んだ 6 値と tx 内再読を厳密比較し、 1 本でも
        // 動いていたら (値変化 / 消失 / 出現) 何も書かずに abort する。 undefined
        // (cursor 不在) も比較対象の値であり、 不在 → 値ありも不一致として扱う。
        // これは owner 検証 (§3a) とは別物: owner 検証は「誰のデータか」 を tx を開く前に
        // 確定させる規律 (validate-before-tx・凍結) で、 CAS は「読取から tx までに store が
        // 動いたか」 を見る並行性検証ゆえ tx 内でしか意味を持たない。 役割が違うので
        // 「検証は tx の前」 の規律とは矛盾しない。
        const casPairs = [
          [SYNC_META_KEYS.cardsCursor, sinceCards],
          [SYNC_META_KEYS.examsCursor, sinceExams],
          [SYNC_META_KEYS.tombstoneCursor, sinceTombstone],
          [SYNC_META_KEYS.tagCategoriesCursor, sinceTagCategories],
          [SYNC_META_KEYS.tagOptionsCursor, sinceTagOptions],
          [SYNC_META_KEYS.cardTagsCursor, sinceCardTags],
        ] as const
        for (const [key, captured] of casPairs) {
          // key は §1 の read / §4-(5) の write と同じ capture 値 (userId) で構成する。
          if ((await getSyncMeta(key, userId)) !== captured) {
            throw new CursorCasMismatchError()
          }
        }

        // (1) cards upsert (clear なし = id-upsert のみ)
        if (cards.length) await db.cards.bulkPut(cards)
        if (exams.length) await db.exams.bulkPut(exams)
        // Tag-1: tag マスタの upsert は tombstone 適用 *前* に行う。
        // 同 pull 内で「同 id の create + delete」 が同居しても、 後段の tombstone
        // bulkDelete で正しく消える順序を保証する。
        if (tagCategories.length) await db.tag_categories.bulkPut(tagCategories)
        if (tagOptions.length) await db.tag_options.bulkPut(tagOptions)

        // (2) 変更カード分の旧 card_tags 全削除 (Tag-2b 案 a)。
        // server が card_tags=[] を返す「whole-set 縮小」 ケースでも、 変更カードの
        // 旧行を消してから (3) で空 bulkPut することで IDB 側に旧行が残らない。
        // changedCardIds.length === 0 のときは delete スキップ (no-op、 衝突回避)。
        const changedCardIds = cards.map((c) => c.id)
        if (changedCardIds.length) {
          await db.card_tags
            .where('card_id')
            .anyOf(changedCardIds)
            .delete()
        }
        // (3) card_tags upsert (新集合の bulkPut)。 length 0 は no-op。
        if (cardTags.length) await db.card_tags.bulkPut(cardTags)

        // (4) tombstone bulkDelete — mirror 削除反映の唯一経路。
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
        // Tag-2b: card_tags cascade purge (option 削除 / card 削除起点)。
        // server cascade で物理削除済の card_tags は cursor に乗らない (DELETE は
        // SELECT 増分に出ない) ため、 client 側で tombstone から導出して purge する。
        // user_id は idempotent (どの user も自分の owner-scoped 行のみ持つ)、
        // idempotent な (2)/(3) 経路とも衝突しない (option_id / card_id ベースの
        // 別 index で別行を消す)。
        if (tagOptionIds.length) {
          await db.card_tags
            .where('option_id')
            .anyOf(tagOptionIds)
            .delete()
        }
        if (cardIds.length) {
          await db.card_tags.where('card_id').anyOf(cardIds).delete()
        }

        // (5) cursor write (非 null のみ。 null = 据え置き)。
        // key は §1 の read と同じ capture 値 (userId) で構成する — 遅着した pull が
        // 次 user の namespace に書かないための核心 (spec §5.1 capture 原則)。
        if (cursors.cards)
          await db.sync_meta.put({
            key: scopedSyncMetaKey(SYNC_META_KEYS.cardsCursor, userId),
            value: cursors.cards,
          })
        if (cursors.exams)
          await db.sync_meta.put({
            key: scopedSyncMetaKey(SYNC_META_KEYS.examsCursor, userId),
            value: cursors.exams,
          })
        if (cursors.tombstone)
          await db.sync_meta.put({
            key: scopedSyncMetaKey(SYNC_META_KEYS.tombstoneCursor, userId),
            value: cursors.tombstone,
          })
        if (cursors.tag_categories)
          await db.sync_meta.put({
            key: scopedSyncMetaKey(SYNC_META_KEYS.tagCategoriesCursor, userId),
            value: cursors.tag_categories,
          })
        if (cursors.tag_options)
          await db.sync_meta.put({
            key: scopedSyncMetaKey(SYNC_META_KEYS.tagOptionsCursor, userId),
            value: cursors.tag_options,
          })
        if (cursors.card_tags)
          await db.sync_meta.put({
            key: scopedSyncMetaKey(SYNC_META_KEYS.cardTagsCursor, userId),
            value: cursors.card_tags,
          })
      },
    )
  } catch (err) {
    // CAS abort だけを既存の silent FAIL 契約へ正規化する (log は event 名のみ)。
    // それ以外 (IndexedDB 障害等) は CAS 導入前と同じく caller へ伝播させる —
    // 握り潰すと mirror 破損が無音化するため、 catch 範囲は sentinel に限定する。
    if (err instanceof CursorCasMismatchError) {
      logger.warn({ event: 'pull.cursor_cas_mismatch' })
      return FAIL
    }
    throw err
  }

  return {
    ok: true,
    cardCount: cards.length,
    examCount: exams.length,
    tombstoneCount: tombstones.length,
    tagCategoryCount: tagCategories.length,
    tagOptionCount: tagOptions.length,
    cardTagCount: cardTags.length,
  }
}

// ---------------------------------------------------------------------------
// runGuardedPull — in-flight guard + 多タブ Web Locks (ifAvailable skip)
// ---------------------------------------------------------------------------

// pull 同期用の単一固定 lock 名 (origin 内全タブ共有)。
export const PULL_LOCK_NAME = 'recallmint:pull'

export type PullGuardOutcome = 'ran' | 'inflight-skip' | 'lock-busy'

type GuardedPullDeps = {
  // pullDelta へ渡す capture 値 (必須)。 呼出元は自身が保有する内部 userId を渡す。
  userId: string
  reason?: string
  pull?: () => Promise<PullDeltaResult>
  locks?: MinimalLockManager<PullGuardOutcome> | undefined
}

// 1 タブ内の in-flight pull を skip するための module-scope フラグ。
// 多タブ排他は Web Locks に委ねる。
let pullInFlight = false

// pullDelta を「1 タブ内 in-flight skip」+「多タブ Web Locks (ifAvailable skip)」で囲む。
// in-flight guard を最外に置く理由: locks.request の呼出自体もスキップするため、
// Lock API の非同期コストを払わずに即 return できる。 lock wrap は共有 helper
// (lib/sync/with-web-lock) に委譲、 fallback (locks なし) は helper が直接 run() を回す。
//   多重 pull は server 側 cursor 更新の冪等性で吸収される。
export async function runGuardedPull(deps: GuardedPullDeps): Promise<PullGuardOutcome> {
  if (pullInFlight) {
    logger.info({ event: 'pull.inflight_skip', reason: deps.reason })
    return 'inflight-skip'
  }
  pullInFlight = true
  try {
    const pull = deps.pull ?? (() => pullDelta(deps.userId))
    return await withWebLock<PullGuardOutcome>({
      lockName: PULL_LOCK_NAME,
      run: async () => {
        await pull()
        return 'ran'
      },
      onLockBusy: () => {
        // 他タブが lock を保持中 → pull せず即 return (queue で待たない)。
        logger.info({ event: 'pull.lock_busy', lockName: PULL_LOCK_NAME, reason: deps.reason })
        return 'lock-busy'
      },
      // 'locks' key 明示時のみ helper に転送 (undefined で非対応 path test)。
      ...('locks' in deps ? { locks: deps.locks } : {}),
    })
  } finally {
    pullInFlight = false
  }
}
