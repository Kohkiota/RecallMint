// client-db — Dexie (IndexedDB) wrapper。 PWA local-first 設計の真実 source
// (docs/02-tech-spec.md §14)。 ブラウザ専用 module (server から import しない)。
//
// 役割:
// - exams / cards / user_settings: server からの pull 結果を保持し、 演習 / 編集の
//   読み出し source を Dexie に一元化 (§9.1 で旧 StaleWhileRevalidate キャッシュは
//   廃止、 ここが正本)。
// - study_sessions: 演習開始時に client (uuidv4) で作成し、 answer_events の親に
//   なる。 status / completed_at は session ライフサイクルで更新。
// - answer_events: 演習中の回答 click で即時 insert (debounce なし、 §14.7.1)。
//   bulk flush で /api/review-events/bulk に送信し、 server から sync OK を受領で
//   sync_status='synced' へ。
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
  question_no_format?: 'numeric' | 'hierarchical' | 'free' | null
  archived_at?: string | null
  card_count: number
  content_version: number
  created_at: string
  updated_at: string
}

// cards: 同上。 sync_status は v1.x の双方向同期で使う余地のため schema に index は
// 載せておくが、 MVP では mutations 経由で push するためここは原則 'synced' 固定。
export type ClientCardOption = {
  id: string
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

export type ClientCard = {
  id: string
  user_id: string
  exam_id: string
  source_document_id?: string | null
  title: string
  sort_key?: string | null
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

// user_settings: 1 user 1 行。 PK = user_id。
export type ClientUserSettings = {
  user_id: string
  session_limit: number
  fsrs_mode: boolean
  created_at: string
  updated_at: string
}

// study_sessions: client 採番、 §14.3a 準拠。
// updated_at は §13.14 全テーブル更新基準に従い保持 (server upsert 判定 hook)。
export type ClientStudySession = {
  session_id: string
  exam_id?: string
  mode: 'smart' | 'custom'
  card_ids: string[]
  query?: Record<string, unknown>
  started_at: string
  completed_at?: string | null
  status: 'active' | 'completed' | 'abandoned'
  updated_at: string
  sync_status: SyncStatus
}

// answer_events: §14.4 準拠。 local_id は Dexie auto-increment、 event_id は冪等化キー。
// rating は FSRS モードで user が選んだ 1-4 を保持し、 bulk payload に含めて server に
// 届けるための optional 列 (Dexie schema の index 列ではない、 保存のみ)。
export type ClientAnswerEvent = {
  local_id?: number
  event_id: string
  session_id: string
  card_id: string
  selected_answer_ids: string[]
  is_correct: boolean
  answered_at: string
  elapsed_ms?: number
  rating?: 1 | 2 | 3 | 4
  sync_status: SyncStatus
  last_attempted_at?: string | null
}

// entity_mutations (S-sync-1 で旧 card_mutations を汎用化): mutation-driven push の
// 汎用 outbox row。 entity_type で対象 entity ('card' / 'tag_category' / 'tag_option') を
// 識別し、 entity_id は対象 entity の PK。
// op は registry (server) で定義される文字列、 card では 'update_field' | 'create' | 'delete'、
// tag_category / tag_option も同 3 op (Tag-1)。
//
// T5: entity_type / op / patch の 3-tuple を `EntityMutationEnvelope` 経由で
// discriminated union として narrow する (`lib/sync/shared/mutation-schemas.ts`)。
// mutation_id / edited_at / sync_status / last_attempted_at / local_id は outbox metadata
// として intersection で乗せる。
export type ClientEntityMutation = EntityMutationEnvelope & {
  local_id?: number
  mutation_id: string
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
  user_settings!: Table<ClientUserSettings, string>
  study_sessions!: Table<ClientStudySession, string>
  answer_events!: Table<ClientAnswerEvent, number>
  // S-sync-1: 旧 `card_mutations` を `entity_mutations` に汎用化。 entity_type +
  // entity_id の複合 index で entity-scoped coalesce 検索を高速化する余地を持つ
  // (現状の coalesce は sync_status 全 scan ベースで動くが、 将来 entity 数が増えた
  // ときに `[entity_type+entity_id]` で取り出せるよう index を宣言)。
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
