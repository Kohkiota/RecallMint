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
// - card_mutations: inline 編集の patch を貯める (§14.7.2)。 server 送信は 2000ms
//   debounce、 mutation_id で冪等化。
// - sync_meta: 同期ステート (last pull cursor、 削除遅延キャッシュ等) の key-value。
//
// 型方針:
// - timestamp はすべて ISO8601 string (§14.3a / §14.4 / §14.5 仕様)。 Dexie は Date
//   も保存できるが、 sync payload にそのまま乗せられる string で統一する方が単純。
// - cards.due / updated_at も ISO 文字列 (lexicographic compare で時系列正しく動く)。
// - sync_status: 'pending' (未送信) / 'syncing' (送信中) / 'synced' (確定) /
//   'failed' (最終失敗、 user 介入待ち)。

import Dexie, { type Table } from 'dexie'

// ---------------------------------------------------------------------------
// 共通 enum
// ---------------------------------------------------------------------------

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed'

// ---------------------------------------------------------------------------
// テーブル row 型
// ---------------------------------------------------------------------------

// exams: server から pull した最新確定値の cache。 編集は card_mutations 経由のため
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
  custom_props: Record<string, unknown>
  tags: string[]
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

// card_mutations: §14.5 準拠。 patch は §14.6 圧縮ルールに従い構築する (本 module は
// schema のみ、 圧縮ロジック自体は別所で実装)。
export type ClientCardMutation = {
  local_id?: number
  mutation_id: string
  card_id: string
  patch: Record<string, unknown>
  edited_at: string
  sync_status: SyncStatus
  last_attempted_at?: string | null
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
  card_mutations!: Table<ClientCardMutation, number>
  sync_meta!: Table<ClientSyncMeta, string>
  // S-perf-3: server study_days を pull する mirror table (streak / todayCount 算出用)。
  // 複合 PK `[user_id+day]` で server PK 構造と一致 (idempotent な bulkPut が成立)。
  study_days!: Table<ClientStudyDay, [string, string]>

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
