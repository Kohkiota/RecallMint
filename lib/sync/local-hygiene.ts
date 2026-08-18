// local-hygiene — 共有ブラウザに残るローカル残骸の掃除(tag mirror hygiene sprint /
// spec §4 = sign-out purge・§5 = sign-in 異 owner sweep)。 client 専用 module
// (getClientDb / Cache API 依存)。
//
// 保証水準は **eventual hygiene**(best-effort): 発火保証・順序保証・完了待ちなし、
// 失敗は silent で次回実行が回収する。 表示保証(異 owner のデータを見せない)は
// correctness sprint の読み層が既に担っており、 本 module はそれを毀損しないことが
// 最上位の制約。 lock / marker / 完了待ち / 実行時 auth 再検証は導入しない(spec §0)。
//
// **不可侵集合**(owner を問わず触らない — spec §4.2):
//   1. pending / syncing / failed の outbox 行(answer_events / entity_mutations)
//   2. 非 'ready' の media_assets 行 + 対応 Cache blob
//      (entity-mutations.ts の flush gate が 'uploading' 行の存在を根拠に pending
//       images mutation を保留している。 行だけ消すと gate が開き、 実体の無い
//       image key を server に確定させる)
//   3. 'downloading' の media_download_jobs 行 + その added_asset_ids の Cache blob
//      (進行中デッキ DL の all-or-nothing を壊さない)
// ゆえに purge は「完全消去」ではない — 命名・コメントでもそう主張しない。
//
// **単一 rw tx**(spec §0 条件 1): Dexie の削除は触る全 store を跨ぐ 1 tx で行う。
// 「mirror だけ消えて cursor が残る」部分実行状態は、 同一 owner の再 sign-in で
// delta pull が消えた行を取り直さず silent 表示欠落を起こす。 pull の cursor CAS が
// 意味を持つ前提でもある(mirror clear と sync_meta clear を別 tx に分けると CAS が
// vacuous になる)。

import Dexie, { type Table } from 'dexie'
import { getClientDb, type ClientDb } from '@/lib/client-db'
import { logger } from '@/lib/logger'
import {
  deleteMediaCacheRequest,
  listMediaCacheRequests,
  parseMediaCacheKey,
} from '@/lib/media/cache'

// ClientDb の constructor が渡す DB 名(lib/client-db.ts)。 Dexie.exists の引数に
// だけ使う(getClientDb は名前を受け取らないため参照できない)。
const DB_NAME = 'recallmint'

// ---------------------------------------------------------------------------
// 分類表(spec §4.1)
// ---------------------------------------------------------------------------

/** 行の状態列。 media 系は `status`、 outbox 系は `sync_status`。 */
type HygieneStatusField = 'status' | 'sync_status'

/**
 * purge(sign-out・全 owner 対象)の削除規則。
 * `delete-status` は **陽形**(削除する値を列挙する)のみ — 否定形にすると将来
 * 追加された status が silent に削除対象へ入る(spec §4.1)。
 */
export type HygienePurgeRule =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'delete-status'
      readonly field: HygieneStatusField
      readonly value: string
    }

/** sweep(sign-in・異 owner のみ)の削除規則。 消費者は Task 5 の sweep 実行体。 */
export type HygieneSweepRule =
  | { readonly kind: 'foreign-owner' }
  | {
      readonly kind: 'foreign-owner-and-status'
      readonly field: HygieneStatusField
      readonly value: string
    }
  | { readonly kind: 'sync-meta-classify' }

export type HygieneStoreRule = {
  readonly purge: HygienePurgeRule
  readonly sweep: HygieneSweepRule
}

/**
 * store ごとの掃除規則(spec §4.1 の表)。 purge / sweep の実行体はこの表を消費する
 * — 判定を test 専用の別 pure 実装に持たせると、 判定と実削除が乖離しても誰も
 * 気付けないため。 ClientDb に store を追加したら purge / sweep 両方の規則を
 * ここに宣言する(網羅 pin が機械強制)。
 */
export const HYGIENE_STORE_RULES = {
  // mirror 6: server から再取得できる read-only mirror。
  exams: { purge: { kind: 'clear' }, sweep: { kind: 'foreign-owner' } },
  cards: { purge: { kind: 'clear' }, sweep: { kind: 'foreign-owner' } },
  study_days: { purge: { kind: 'clear' }, sweep: { kind: 'foreign-owner' } },
  tag_categories: { purge: { kind: 'clear' }, sweep: { kind: 'foreign-owner' } },
  tag_options: { purge: { kind: 'clear' }, sweep: { kind: 'foreign-owner' } },
  card_tags: { purge: { kind: 'clear' }, sweep: { kind: 'foreign-owner' } },
  // media: 'ready' / 'done' 以外は不可侵集合(spec §4.2)。
  media_assets: {
    purge: { kind: 'delete-status', field: 'status', value: 'ready' },
    sweep: { kind: 'foreign-owner-and-status', field: 'status', value: 'ready' },
  },
  media_download_jobs: {
    purge: { kind: 'delete-status', field: 'status', value: 'done' },
    sweep: { kind: 'foreign-owner-and-status', field: 'status', value: 'done' },
  },
  // outbox 2: 未送信(pending / syncing / failed)は owner 不問で不可侵。
  answer_events: {
    purge: { kind: 'delete-status', field: 'sync_status', value: 'synced' },
    sweep: {
      kind: 'foreign-owner-and-status',
      field: 'sync_status',
      value: 'synced',
    },
  },
  entity_mutations: {
    purge: { kind: 'delete-status', field: 'sync_status', value: 'synced' },
    sweep: {
      kind: 'foreign-owner-and-status',
      field: 'sync_status',
      value: 'synced',
    },
  },
  // sync_meta は purge / sweep で意図的に非対称(spec §5.1): 去る側は未知 key ごと
  // 全消し、 sign-in 側は既知 base の bare / 異 owner のみ削除。 sync_meta は
  // tx を mirror と共有する必要があるため必ずこの表に載る(単一 tx の要請)。
  sync_meta: { purge: { kind: 'clear' }, sweep: { kind: 'sync-meta-classify' } },
} as const satisfies Record<string, HygieneStoreRule>

export type HygieneStoreName = keyof typeof HYGIENE_STORE_RULES

/**
 * 分類表の store 名 → 実 Table の対応。 `Record<HygieneStoreName, Table>` を返すことで
 * 「表に名前があるが ClientDb に無い / その逆」 を型で検出する。
 */
function hygieneTables(db: ClientDb): Record<HygieneStoreName, Table> {
  return {
    exams: db.exams,
    cards: db.cards,
    study_days: db.study_days,
    tag_categories: db.tag_categories,
    tag_options: db.tag_options,
    card_tags: db.card_tags,
    media_assets: db.media_assets,
    media_download_jobs: db.media_download_jobs,
    answer_events: db.answer_events,
    entity_mutations: db.entity_mutations,
    sync_meta: db.sync_meta,
  }
}

async function applyPurgeRule(
  table: Table,
  rule: HygienePurgeRule,
): Promise<void> {
  switch (rule.kind) {
    case 'clear':
      await table.clear()
      return
    case 'delete-status':
      // 単独 sync_status index が無い store があるため全 store 一律で filter 走査に
      // 揃える(sign-out 時の一回走査で許容 — spec §4.1)。
      await table
        .filter(
          (row: Record<string, unknown>) => row[rule.field] === rule.value,
        )
        .delete()
      return
    default: {
      // 網羅チェック。 戻り値が void ゆえ default が無いと HygienePurgeRule に kind を
      // 足したとき「その store だけ何も削除されない」 silent no-op になる。
      const exhaustive: never = rule
      throw new Error(
        `unhandled purge rule: ${JSON.stringify(exhaustive)}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// sync_meta の sweep 分類(spec §5.1)
// ---------------------------------------------------------------------------

/**
 * sweep が bare / scoped 判定に使う base 名(cursor 6 + 旧 `exam_view_prefs` +
 * `selected_exam`)。
 * **`SYNC_META_KEYS` から自動導出しない**: 導出にすると key を足すたび sweep 対象が
 * 黙って増え、 将来 key を silent に消し続ける regression 源になる。 key 追加時に
 * 「sweep 対象か否か」の判断を明示的に踏ませ、 その強制は分類 pin(`SYNC_META_KEYS`
 * の全値が本 list ∪ `SWEEP_EXEMPT_BASES` に現れる)が担う。
 */
export const SWEEP_SYNC_META_BASES = [
  'cards_cursor',
  'exams_cursor',
  'tombstone_cursor',
  'tag_categories_cursor',
  'tag_options_cursor',
  'card_tags_cursor',
  'exam_view_prefs',
  // Dash-1 Home v1 Task 5: 選択中試験。exam_view_prefs と同型の owner scope 単一 key
  // なので同じ sweep 規則(bare 削除 / base:<self> 温存 / base:<other> 削除)に載せる。
  'selected_exam',
] as const satisfies readonly string[]

/**
 * sweep 対象外と**明示的に判断した** base(分類 pin が参照する除外 list)。 現状は空。
 * sweep させたくない key を `SYNC_META_KEYS` に足すときはここに載せる(pin を黙らせる
 * ためだけに足さない — 判断の記録である)。
 */
export const SWEEP_EXEMPT_BASES: readonly string[] = []

/**
 * sweep における sync_meta key の分類(spec §5.1 の厳密規則)。 各 base B について:
 * key === B(bare = owner 空間分離より前の旧 key)→ delete / key が `B:` 始まりなら
 * suffix が userId と完全一致で keep、 それ以外(空 suffix・複数 colon 等の malformed
 * 含む)は既知 base の namespace 内の残骸として delete / どの base にも該当しない key
 * (prefix 類似の `cards_cursor_v2` や未知 key)→ keep。
 *
 * 未知 key を**温存**するのは Cache blob と逆向きの fail-safe: sync_meta は機能状態で
 * 誤削除 = 機能破壊、 Cache blob は再取得可能(spec §4.1 の規約)。
 *
 * userId が非空であることは caller(`sweepForeignLocalData`)が保証する。
 */
export function classifySyncMetaKeyForSweep(
  key: string,
  userId: string,
): 'delete' | 'keep' {
  for (const base of SWEEP_SYNC_META_BASES) {
    if (key === base) return 'delete'
    if (key.startsWith(`${base}:`)) {
      return key.slice(base.length + 1) === userId ? 'keep' : 'delete'
    }
  }
  return 'keep'
}

async function applySweepRule(
  table: Table,
  rule: HygieneSweepRule,
  userId: string,
): Promise<void> {
  switch (rule.kind) {
    case 'foreign-owner':
      await table.where('user_id').notEqual(userId).delete()
      return
    case 'foreign-owner-and-status':
      // 陽形(削除する status を列挙)。 単独 status index が無い store があるため
      // 全 store 一律で filter 走査に揃える(purge 側と同じ判断)。
      await table
        .filter(
          (row: Record<string, unknown>) =>
            row.user_id !== userId && row[rule.field] === rule.value,
        )
        .delete()
      return
    case 'sync-meta-classify':
      // key が string でない行は分類できないため温存(sync_meta の fail-safe は温存側)。
      await table
        .filter(
          (row: Record<string, unknown>) =>
            typeof row.key === 'string' &&
            classifySyncMetaKeyForSweep(row.key, userId) === 'delete',
        )
        .delete()
      return
    default: {
      // 網羅チェック(applyPurgeRule と同趣旨 — 未処理 kind の silent no-op を防ぐ)。
      const exhaustive: never = rule
      throw new Error(`unhandled sweep rule: ${JSON.stringify(exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 保護 blob 集合(Dexie tx 後に算出 — Task 5 の sweep も同じ手順で再利用する)
// ---------------------------------------------------------------------------

/** Cache key(`/__media/<userId>/<assetId>`)と同じ粒度の照合キー。 */
function blobProtectionKey(userId: string, assetId: string): string {
  return `${userId}/${assetId}`
}

/**
 * 削除してはいけない Cache blob の集合を、 **tx 後に残存している行**から算出する。
 * tx が済んだ時点で削除条件に該当した行は既に消えているため、 残存行 = 不可侵集合
 * (sweep では加えて自 owner の行)そのものになる。 削除条件を再記述しないことで
 * 表と保護判定の乖離を防ぎ、 将来 status が増えても保護側は自動で安全側へ倒れる
 * (purge 後の残存 assets は非 'ready' のみ / 残存 jobs は 'downloading' のみ =
 * spec §4.2 の不可侵集合と一致)。
 *
 * Cache と IndexedDB を跨ぐ原子的 snapshot は存在しないため、 算出後に開始した
 * writer の blob が巻き込まれる TOCTOU は残る(spec §4.2 でレーン別に bound 済)。
 */
async function collectProtectedBlobKeys(
  db: ClientDb,
): Promise<ReadonlySet<string>> {
  const keys = new Set<string>()
  for (const asset of await db.media_assets.toArray()) {
    keys.add(blobProtectionKey(asset.user_id, asset.id))
  }
  for (const job of await db.media_download_jobs.toArray()) {
    for (const assetId of job.added_asset_ids) {
      keys.add(blobProtectionKey(job.user_id, assetId))
    }
  }
  return keys
}

// ---------------------------------------------------------------------------
// sign-out purge(spec §4)
// ---------------------------------------------------------------------------

async function purgeDexieStores(): Promise<{
  skipped: boolean
  protectedBlobKeys: ReadonlySet<string>
}> {
  // 未訪問 visitor に空 DB を作らないための guard(marketing page でも発火するため)。
  // 役割は不要生成の抑止のみで correctness 判定には使わない — exists → open の
  // race は受容(spec §4.3)。
  if (!(await Dexie.exists(DB_NAME))) {
    return { skipped: true, protectedBlobKeys: new Set() }
  }

  const db = getClientDb()
  const tables = hygieneTables(db)
  const names = Object.keys(HYGIENE_STORE_RULES) as HygieneStoreName[]

  await db.transaction('rw', Object.values(tables), async () => {
    for (const name of names) {
      await applyPurgeRule(tables[name], HYGIENE_STORE_RULES[name].purge)
    }
  })

  return { skipped: false, protectedBlobKeys: await collectProtectedBlobKeys(db) }
}

async function purgeCacheBlobs(
  protectedKeys: ReadonlySet<string>,
): Promise<{ deleted: number; kept: number }> {
  let deleted = 0
  let kept = 0
  for (const request of await listMediaCacheRequests()) {
    const parsed = parseMediaCacheKey(request.url)
    // 規約外 / malformed key は削除に倒す(再取得可能な blob ゆえ fail-safe の向きは
    // 削除 — sync_meta の未知 key を温存するのと意図的に非対称・spec §4.1)。
    if (
      parsed &&
      protectedKeys.has(blobProtectionKey(parsed.userId, parsed.assetId))
    ) {
      kept += 1
      continue
    }
    try {
      await deleteMediaCacheRequest(request)
      deleted += 1
    } catch {
      // best-effort: 1 key の失敗が残りの掃除を止めない(sweepStaleMedia と同規約)。
    }
  }
  return { deleted, kept }
}

async function runPurge(): Promise<void> {
  const dexie = await purgeDexieStores()
  // Cache 部は Dexie 部の skip とは独立に実行する(DB 不在でも orphan blob は掃除する)。
  // Dexie 部が **失敗** した場合は保護集合が確定しないため、 ここへは進まず伝播させる。
  const cache = await purgeCacheBlobs(dexie.protectedBlobKeys)
  // 発火の実挙動を stg smoke で確定させるための 1 行(空の end-state だけでは
  // 「発火した」 と「発火しなかった」 を区別できない — spec §10 手順 ④)。
  // event 名 + 件数のみ: userId / cache key / row 内容は出さない。
  // 失敗時は log を出さない(best-effort・失敗 silent の契約を変えない)。
  logger.info({
    event: 'local_hygiene.purge',
    dexie_skipped: dexie.skipped,
    cache_deleted: cache.deleted,
    cache_kept: cache.kept,
  })
}

// 同一 tab の並走 purge を 1 本に dedup する guard。 冪等性に加え、 重複 purge の
// 遅走が新 session に挟まる時間窓を延ばさないため(spec §4.3)。
let purgeInFlight: Promise<void> | null = null

/**
 * sign-out 時のローカル残骸の掃除(全 owner 対象)。 不可侵集合(pending / syncing /
 * failed の outbox・非 'ready' assets + blob・'downloading' jobs + added blob)は
 * 残るため、 これは完全消去ではない。 best-effort・fire-and-forget で、 失敗は
 * caller が握り潰す前提(次の実行機会が回収する)。
 */
export function purgeAllLocalData(): Promise<void> {
  if (purgeInFlight) return purgeInFlight
  const run = runPurge()
  // guard は Dexie + Cache の全工程を包含し、 成功 / 失敗の双方で必ず解除する
  // (settled promise を持ち続けると 2 回目以降の purge が恒久 no-op になる)。
  purgeInFlight = run.finally(() => {
    purgeInFlight = null
  })
  return purgeInFlight
}

// ---------------------------------------------------------------------------
// sign-in 異 owner sweep(spec §5)
// ---------------------------------------------------------------------------

async function sweepCacheBlobs(
  userId: string,
  protectedKeys: ReadonlySet<string>,
): Promise<{ deleted: number; kept: number }> {
  let deleted = 0
  let kept = 0
  for (const request of await listMediaCacheRequests()) {
    const parsed = parseMediaCacheKey(request.url)
    // 自 namespace は温存(sign-in した本人の blob)/ 保護 blob は **owner を問わず**
    // 温存(異 owner の進行中 DL / 非 'ready' asset に紐づく blob も不可侵)/
    // 規約外・malformed key は削除(再取得可能ゆえ fail-safe は削除側 — spec §4.1)。
    if (
      parsed &&
      (parsed.userId === userId ||
        protectedKeys.has(blobProtectionKey(parsed.userId, parsed.assetId)))
    ) {
      kept += 1
      continue
    }
    try {
      await deleteMediaCacheRequest(request)
      deleted += 1
    } catch {
      // best-effort: 1 key の失敗が残りの掃除を止めない(purge 部と同規約)。
    }
  }
  return { deleted, kept }
}

/**
 * sign-in 時に、 共有ブラウザへ残った**異 owner の残骸だけ**を回収する(spec §5)。
 * 触るのは異 owner 行と sync_meta の bare / `base:<other>` のみで、 自分の pull が
 * 読み書きする `base:<self>` namespace とは集合が交わらない(§5.2)。 purge と同じく
 * 不可侵集合(pending / syncing / failed の outbox・非 'ready' assets + blob・
 * 'downloading' jobs + added blob)は **owner を問わず** 残る。
 *
 * best-effort・fire-and-forget(失敗は caller が握り潰す前提)。 発火は mount 1 回で
 * 並走しないため purge のような in-flight guard は持たない。 purge の `Dexie.exists`
 * guard も持たない — 本関数の発火点は認証済み `(app)/app` 配下で、 同 layout の
 * PullTrigger が同じ DB をどのみち作るため「空 DB を作らない」意味がない。
 */
export async function sweepForeignLocalData(userId: string): Promise<void> {
  // fail-closed: 空 userId では Dexie / Cache とも一切触らない。
  // `where('user_id').notEqual('')` は **ほぼ全 owner の行を「異 owner」と判定** する
  // ため、 userId 未確定での誤呼出が全消去に化ける。
  if (!userId) return

  const db = getClientDb()
  const tables = hygieneTables(db)
  const names = Object.keys(HYGIENE_STORE_RULES) as HygieneStoreName[]

  await db.transaction('rw', Object.values(tables), async () => {
    for (const name of names) {
      await applySweepRule(
        tables[name],
        HYGIENE_STORE_RULES[name].sweep,
        userId,
      )
    }
  })

  // 保護集合は tx 後の残存行から算出する(purge と同一手順 — 削除条件を再記述しない)。
  const cache = await sweepCacheBlobs(userId, await collectProtectedBlobKeys(db))
  // 発火の実挙動を stg smoke で確定させるための 1 行(purge と同規律: event 名 +
  // 件数のみ / userId・cache key・row 内容は出さない / 失敗時は log しない)。
  logger.info({
    event: 'local_hygiene.sweep',
    cache_deleted: cache.deleted,
    cache_kept: cache.kept,
  })
}
