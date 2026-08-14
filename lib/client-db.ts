// client-db — Dexie (IndexedDB) wrapper。 PWA local-first 設計の真実 source
// (docs/02-tech-spec.md §14)。 ブラウザ専用 module (server から import しない)。
//
// 役割:
// - exams / cards: server からの pull 結果を保持し、 演習 / 編集の
//   読み出し source を Dexie に一元化 (§9.1 で旧 StaleWhileRevalidate キャッシュは
//   廃止、 ここが正本)。
// - answer_events: 演習中の回答確定で即時 insert (debounce なし、 §14.7.1)。
//   bulk flush で /api/review-events/bulk に送信し、 server から sync OK を受領で
//   sync_status='synced' へ。 復習の正本は server answer_events 1 表 (FSRS 整合
//   Sprint A)、 client 側は送信待ちの outbox。
// - entity_mutations: mutation-driven push の汎用 outbox (S-sync-1 で旧 card_mutations
//   から汎用化)。 entity_type + entity_id で対象 entity を識別、 server 送信は
//   debounce、 mutation_id で冪等化。 現状の entity_type は 'card' のみ、 後続で
//   タグマスター等を追加予定。
// - sync_meta: 同期ステート (last pull cursor、 削除遅延キャッシュ等) の key-value。
//
// 型方針:
// - timestamp はすべて ISO8601 string (§14.3a / §14.4 / §14.5 仕様)。 Dexie は Date
//   も保存できるが、 sync payload にそのまま乗せられる string で統一する方が単純。
// - cards.due / updated_at も ISO 文字列 (lexicographic compare で時系列正しく動く)。
// - sync_status: 'pending' (未送信) / 'syncing' (送信中) / 'synced' (確定) /
//   'failed' (最終失敗、 user 介入待ち)。

import Dexie, { type Table } from 'dexie'
import type { EntityMutationEnvelope } from '@/lib/sync/shared/mutation-schemas'

// ---------------------------------------------------------------------------
// 共通 enum
// ---------------------------------------------------------------------------

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed'

// ---------------------------------------------------------------------------
// テーブル row 型
// ---------------------------------------------------------------------------

// exams: server から pull した最新確定値の cache。 編集は entity_mutations 経由のため
// ローカルでは原則 read-only (pull 上書きのみ)。
export type ClientExam = {
  id: string
  user_id: string
  name: string
  content_version: number
  created_at: string
  updated_at: string
}

// cards: 同上。 sync_status は v1.x の双方向同期で使う余地のため schema に index は
// 載せておくが、 MVP では mutations 経由で push するためここは原則 'synced' 固定。
export type ClientCardOption = {
  id: string
  // Sprint I W5: 画像紐付けの内部不変 identity(server `CardOption.uid` と同義)。
  uid?: string
  text: string
  is_correct: boolean
  explanation?: string
}

export type ClientCardImage = {
  key: string
  target: string
  alt: string
  source_ref?: string
  url?: string
}

// media_assets (画像フェーズ A v8): 添付画像 asset の client 側状態 mirror。
// server `assets` テーブル(migration 0023)と対で、 upload saga の 'uploading' 状態を
// local に持つ (server は 'reserved'|'ready' のみ、 client は saga 進行中の
// 'uploading' / 失敗時 'failed' も持つ点が非対称、 spec §2.3)。
export type ClientMediaAsset = {
  id: string // = assetId (UUIDv4)
  user_id: string
  status: 'uploading' | 'ready' | 'failed'
  mime: string
  byte_size: number
  width: number
  height: number
  hash: string
  created_at: string // ISO
}

// media_download_jobs (画像フェーズ A v8): デッキ一括 DL の進捗 row (spec §6)。
// PK は複合 [user_id+exam_id] (1 exam につき進行中ジョブは 1 個)。
export type ClientMediaDownloadJob = {
  exam_id: string
  user_id: string
  status: 'downloading' | 'done'
  total: number
  done_count: number
  added_asset_ids: string[]
  started_at: string // ISO
}

export type ClientCard = {
  id: string
  user_id: string
  exam_id: string
  source_document_id?: string | null
  title: string
  question_label?: string | null
  base_order: number
  question_text: string
  options: ClientCardOption[]
  correct_answer_ids: string[]
  explanation_text?: string | null
  memo?: string | null
  images: ClientCardImage[]
  answered: boolean
  last_correct?: boolean | null
  current_streak: number
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  reps: number
  lapses: number
  state: 0 | 1 | 2 | 3
  learning_steps: number
  last_review?: string | null
  content_version: number
  created_at: string
  updated_at: string
  sync_status: SyncStatus
}

// answer_events: FSRS 整合 Sprint A の新 wire (spec §1.1 / §4.1)。 local_id は Dexie
// auto-increment、 event_id は冪等化キー。
// - user_id: flush の owner-scope 選別 ([user_id+sync_status]) と、 synced / failed 化を
//   閉じた scope に限定するための列 (アカウント切替中の応答が別 user に作用しない)。
// - session_id: event ごとの label (server 側に親表はない)。
// - rating: scheduling の唯一の入力ゆえ必須 (旧 optional + server derive は廃止)。
// - last_attempted_at は 24h drop 撤去に伴い削除 (読み手なし)。
export type ClientAnswerEvent = {
  local_id?: number
  event_id: string
  user_id: string
  session_id: string
  card_id: string
  selected_answer_ids: string[]
  is_correct: boolean
  rating: 1 | 2 | 3 | 4
  answered_at: string
  elapsed_ms?: number
  sync_status: SyncStatus
}

// entity_mutations (S-sync-1 で旧 card_mutations を汎用化): mutation-driven push の
// 汎用 outbox row。 entity_type で対象 entity ('card' / 'tag_category' / 'tag_option' /
// 'card_move') を識別し、 entity_id は対象 entity の PK。
// op は registry (server) で定義される文字列、 card では 'update_field' | 'create' | 'delete'、
// tag_category / tag_option も同 3 op (Tag-1)。
// 例外は 'card_move' (Grid-3): この entity は **移動操作そのもの (op instance)** で、
// entity_id は client 生成のその instance uuid (対象 card 群は patch.cards が持つ)、
// op は 'move' の 1 つだけ。 coalesce key (`${entity_type}:${entity_id}:${op}`) が
// instance ごとに別になるため、 連続する移動は潰し合わず enqueue 順に全件送られる
// (schema.ts の entity_mutations comment と同じ裁定)。
//
// T5: entity_type / op / patch の 3-tuple を `EntityMutationEnvelope` 経由で
// discriminated union として narrow する (`lib/sync/shared/mutation-schemas.ts`)。
// mutation_id / edited_at / sync_status / last_attempted_at / local_id は outbox metadata
// として intersection で乗せる。
//
// user_id: flush の owner-scope 選別 ([user_id+sync_status]) と、 synced / failed /
// attempted 化を閉じた scope に限定するための outbox metadata 列 (answer_events と同設計)。
// 共有ブラウザでのアカウント切替中に別 user の pending へ作用しないための client 側
// 誤送信防止であり、 認可境界ではない (wire payload には載せず、 server は auth 由来の
// user.id のみを信頼する)。
export type ClientEntityMutation = EntityMutationEnvelope & {
  local_id?: number
  mutation_id: string
  user_id: string
  edited_at: string
  sync_status: SyncStatus
  last_attempted_at?: string | null
}

// tag_categories / tag_options (Tag-1): 試験横断のタグマスタ mirror。
// server pull で同期する read-only mirror、 編集は entity_mutations 経由 (Tag-2 以降の UI で配線)。
// select_type は作成後 immutable (server schema は text、 immutability は UI 担保)。
export type ClientTagCategory = {
  id: string
  user_id: string
  name: string
  select_type: 'single' | 'multi'
  color?: string | null
  sort_key?: string | null
  created_at: string
  updated_at: string
}

export type ClientTagOption = {
  id: string
  user_id: string
  category_id: string
  name: string
  color?: string | null
  sort_key?: string | null
  created_at: string
  updated_at: string
}

// card_tags (Tag-2b): card ↔ tag_option の junction の read-only mirror。
// server pull で同期する 1:1 mirror、 sync_status は持たない (tag_categories /
// tag_options と同方針)。 PK は複合 [card_id+option_id]。
export type ClientCardTag = {
  card_id: string
  option_id: string
  user_id: string
  created_at: string
}

// sync_meta: key-value。 用途は呼出側に委ねる (例: last_pull_at / pending_count 等)。
export type ClientSyncMeta = {
  key: string
  value: unknown
}

// study_days: server study_days table の mirror (S-perf-3 / dashboard 高速化)。
// day は JST date 文字列 'YYYY-MM-DD'。 PK は複合 [user_id+day] (server 側 PK と同型)。
// streak / todayCount を Dexie から算出するために pull。 直近 90 日のみ保持。
export type ClientStudyDay = {
  user_id: string
  day: string
  review_count: number
  correct_count: number
  distinct_card_count: number
}

// ---------------------------------------------------------------------------
// Dexie DB
// ---------------------------------------------------------------------------

export class ClientDb extends Dexie {
  exams!: Table<ClientExam, string>
  cards!: Table<ClientCard, string>
  answer_events!: Table<ClientAnswerEvent, number>
  // S-sync-1: 旧 `card_mutations` を `entity_mutations` に汎用化 (Sprint B v11/v12 で
  // owner-scope 化)。
  entity_mutations!: Table<ClientEntityMutation, number>
  sync_meta!: Table<ClientSyncMeta, string>
  // S-perf-3: server study_days を pull する mirror table (streak / todayCount 算出用)。
  // 複合 PK `[user_id+day]` で server PK 構造と一致 (idempotent な bulkPut が成立)。
  study_days!: Table<ClientStudyDay, [string, string]>
  // Tag-1: 試験横断のタグマスタ mirror。 server pull で同期する read-only mirror。
  tag_categories!: Table<ClientTagCategory, string>
  tag_options!: Table<ClientTagOption, string>
  // Tag-2b: card ↔ tag_option junction の read-only mirror。 PK は複合 [card_id+option_id]。
  card_tags!: Table<ClientCardTag, [string, string]>
  // 画像フェーズ A (v8): 添付画像 asset の client 状態 mirror。 PK = id (=assetId)。
  media_assets!: Table<ClientMediaAsset, string>
  // 画像フェーズ A (v8): デッキ一括 DL の進捗 row。 PK は複合 [user_id+exam_id]。
  media_download_jobs!: Table<ClientMediaDownloadJob, [string, string]>

  constructor() {
    super('recallmint')
    this.version(1).stores({
      exams: 'id, user_id, updated_at, content_version',
      cards:
        'id, exam_id, user_id, due, updated_at, content_version, sync_status',
      user_settings: 'user_id',
      study_sessions: 'session_id, exam_id, mode, status, sync_status',
      answer_events: '++local_id, event_id, session_id, card_id, sync_status',
      card_mutations: '++local_id, mutation_id, card_id, sync_status',
      sync_meta: 'key',
    })
    // v2 (S-perf-3): study_days mirror 追加。 既存 table の schema は変更せず、
    // 新規 store のみ追加するため、 v1 → v2 upgrade は単純な store 追加で済む。
    this.version(2).stores({
      study_days: '[user_id+day], user_id, day',
    })
    // v3 (S-sync-1): card_mutations を entity_mutations に rename + 汎用化。
    // stg は truncate 済 / アクティブユーザー 0 のため、 旧 store の保持データを
    // migrate せず drop して新 store を空で start する (`card_mutations: null` で
    // 旧 store を削除)。 client 側に残る pending mutation はこの upgrade で失われるが、
    // 該当 user は 0 想定なので問題なし。
    this.version(3).stores({
      card_mutations: null,
      entity_mutations:
        '++local_id, mutation_id, [entity_type+entity_id], sync_status',
    })
    // v4 (Tag-1): tag_categories / tag_options mirror store 追加。 既存 table の schema は
    // 変更せず、 新規 store のみ追加するため、 v3 → v4 upgrade は単純な store 追加で済む。
    // category_id index は「カテゴリ配下 option 列挙」 の Dexie query 用 (Tag-2 以降の UI で使用)。
    this.version(4).stores({
      tag_categories: 'id, user_id, updated_at',
      tag_options: 'id, user_id, category_id, updated_at',
    })
    // v5 (Tag-2b): card_tags mirror store 追加。 既存 table の schema は変更せず、 新規
    // store のみ追加するため、 v4 → v5 upgrade は単純な store 追加で済む。
    // PK は複合 `[card_id+option_id]` (server schema と一致、 idempotent な bulkPut が成立)。
    // index:
    //   - card_id: 「あるカードの card_tags を列挙 / 一括削除」 (案 a 取り直し経路)
    //   - option_id: 「あるオプションの cascade purge」 (tombstone)
    //   - user_id: 「該当 user の card_tags 全削除」 (将来の reset 経路で使用余地)
    this.version(5).stores({
      card_tags: '[card_id+option_id], card_id, option_id, user_id',
    })
    // v6 (Y-2 T-B4): cards に compound index `[user_id+exam_id]` を追加。
    // /app/exams の per-exam 集計を「user 全 cards を materialize (~2k 件、 nested
    // field 含む) → JS で countByExam を集計」 から、 per-exam の
    // `where('[user_id+exam_id]').equals([U, e.id]).count()` (Dexie 内部で
    // isPlainKeyRange true → native `IDBIndex.count(IDBKeyRange)` 直送、
    // row 本体 fetch なしの B-tree range count) に置換するための index。
    // owner isolation は index 第 1 要素 user_id の equals fix で構造保証する
    // (他 user の cards に index 経路で到達不能)。 過去 v2 / v4 / v5 と同形の
    // 純粋 index 追加 (store drop なし、 既存データ保持、 upgrade callback 不要)。
    this.version(6).stores({
      cards:
        'id, exam_id, user_id, due, updated_at, content_version, sync_status, [user_id+exam_id]',
    })
    // v7 (Y-2 T-B6 / T-B7 共用 migration): cards に compound index `[user_id+due]` を追加。
    // dashboard-actions の dueCount 件数 query (T-B6) と get-dexie-session-cards の
    // due 期限到来分 fetch (T-B7) で共用。 列順 `[user_id, due]` = 等価条件 (user_id) →
    // 範囲条件 (due) の B-tree 原則 (v6 `[user_id+exam_id]` と同形)。 native
    // `IDBIndex.count(IDBKeyRange)` で row 本体 fetch なしの range count が成立する。
    // owner isolation は index 第 1 要素 user_id の equals fix で構造保証 (T-B4 と同)。
    // v2 / v4 / v5 / v6 と同形の純粋 index 追加 (store drop なし、 既存データ保持、
    // upgrade callback 不要)。 plan L147 初稿の「既存」 主張は事実誤認 (Step 0 §3 で
    // 確認、 sessions/2026-06-14-y2-t-b6-step0.md)、 本 v7 で新規追加が確定経路。
    this.version(7).stores({
      cards:
        'id, exam_id, user_id, due, updated_at, content_version, sync_status, [user_id+exam_id], [user_id+due]',
    })
    // v8 (画像フェーズ A Task 6): media_assets / media_download_jobs store 追加。
    // 既存 store の schema は変更せず、 新規 store のみ追加するため、 v7 → v8 upgrade は
    // v2 / v4 / v5 / v6 / v7 と同形の単純 store 追加で済む (store drop なし、 既存データ
    // 保持、 upgrade callback 不要。 spec §2.3)。
    // media_assets index:
    //   - user_id: owner scope 列挙 (起動時 sweep の stale 'uploading' 検出等)
    //   - [user_id+hash]: 同一ユーザー内 dedup lookup (spec §3.5)
    //   - status: 'uploading'/'failed' の横断検出 (flush gate / sweep)
    // media_download_jobs index:
    //   - PK [user_id+exam_id]: 1 exam につき進行中ジョブは 1 個 (server PK 構造と対称)
    //   - user_id / status: 起動時 sweep での中断ジョブ('downloading' 残骸) 検出
    this.version(8).stores({
      media_assets: 'id, user_id, [user_id+hash], status',
      media_download_jobs: '[user_id+exam_id], user_id, status',
    })
    // v9 (FSRS 整合 Sprint A): study_sessions 廃止 + 旧 wire の answer_events 破棄。
    // 旧 store には rating 欠落 / user_id 不在の pending 行が残りうるため、 index 変更
    // (= 行を保持する ALTER) ではなく store ごと drop して持ち越しを構造的に断つ
    // (v3 の `card_mutations: null` と同形)。 ユーザー 0 につき許容 (spec §10)。
    this.version(9).stores({
      study_sessions: null,
      answer_events: null,
    })
    // v10: answer_events を新 schema で再作成 (空 store で start)。 Dexie は 1 つの
    // version 内で同名 store の drop + create を表現できない (stores() は table 名を
    // キーに持つ 1 object) ため、 drop (v9) と create (v10) を 2 version に分ける。
    // index:
    //   - &event_id: 冪等キーの一意性を store 側で強制 (同 event の二重 add を弾く)
    //   - [user_id+sync_status]: flush の owner-scope 選別と件数 count (等値 2 列)
    // card_id / session_id / 単独 sync_status の index は読み手が居ないため持たない。
    this.version(10).stores({
      answer_events: '++local_id, &event_id, [user_id+sync_status]',
    })
    // v11 (Sprint B DB 掃除): 死 store `user_settings` の drop (設定の現役読み経路は
    // server RSC で、 この mirror には pull writer も reader も居ない) と、
    // entity_mutations の drop を 1 version に同居させる。
    // entity_mutations の旧行は user_id を持たないため、 index 変更 (= 行を保持する
    // ALTER) ではなく store ごと drop して持ち越しを構造的に断つ (v9 の answer_events
    // と同形)。 端末に残る未同期 mutation はこの upgrade で失われるが、 ユーザー 0
    // 前提につき許容 (spec §5.3 裁定 5)。
    this.version(11).stores({
      user_settings: null,
      entity_mutations: null,
    })
    // v12: entity_mutations を owner-scope schema で再作成 (空 store で start)。
    // Dexie は 1 version 内で同名 store の drop + create を表現できないため、
    // drop (v11) と create (v12) を 2 version に分ける (v9→v10 と同形)。
    // index:
    //   - &mutation_id: 冪等キーの一意性を store 側で強制。 modifyByKeys の
    //     `where('mutation_id').anyOf(...)` の lookup 経路も兼ねる。
    //   - [user_id+sync_status]: flush の owner-scope 選別 / coalesce scan / stale 隔離
    //     (等値 2 列)。
    // 旧 `[entity_type+entity_id]` は宣言のみで読み手が居らず (coalesce は in-memory
    // scan)、 単独 `sync_status` は全 query が owner-scope 化で置換されるため持ち越さない。
    this.version(12).stores({
      entity_mutations: '++local_id, &mutation_id, [user_id+sync_status]',
    })
  }
}

// シングルトン取得。 ブラウザ環境でのみ instantiate (SSR / node 実行時は触らない)。
let _db: ClientDb | null = null

export function getClientDb(): ClientDb {
  if (typeof indexedDB === 'undefined') {
    throw new Error(
      'getClientDb() called outside browser (indexedDB unavailable)',
    )
  }
  if (_db === null) {
    _db = new ClientDb()
  }
  return _db
}
