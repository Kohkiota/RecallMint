// Drizzle schema — mcq-platform (21 tables; S1.9.1 で upload_records 追加)
//
// FKs use CASCADE for user-owned data hierarchy
// (Sprint A-2 で plan00 既定の NO ACTION から変更、 users 完全削除
// (GDPR / 個人情報保護法削除依頼) で全関連データを連動削除するため)。
// All user_id FKs (exams / cards / source_documents / study_days /
// user_settings / ai_usage_users / reviews / contact_messages) cascade on user deletion.
// source_documents → cards uses SET NULL (OCR source deletion preserves
// extracted cards).
// Only users uses soft delete (deleted_at) for Stripe/audit retention;
// other tables use hard delete.
// GDPR: users 行は audit/correlation のため残置するが、退会時に webhook handler
// (app/api/webhooks/clerk/route.ts handleUserDeleted) で PII 列 (email, clerk_id)
// を NULL に scrub する。 stripe_customer_id は cus_xxx 単体で個人特定不能なため
// 監査 correlation key として保持する。 scrub は冪等 (NULL 上書き)、
// clerk_events.event_id dedup と組み合わせて再送安全。
//
// ルール A: 全 timestamp は withTimezone: true (timestamptz 統一)。 date 型は
// mode: 'string'。
// ルール B: stripe_events / ai_usage / clerk_events を除く全 table に user_id を
// 持ち、 users.id (UUID) に FK。 auth provider 切替時の影響を Clerk 関連 column
// のみに局所化。 integration_failures は audit table で FK なし
// (template ポータビリティ重視)。
//
// 詳細: docs/02-tech-spec.md §2 / lessons/2026-04-30-users-schema-decoupling.md
import { sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Card-internal JSON types (cards.options / cards.images の TS 型)
// ---------------------------------------------------------------------------
export type CardOption = {
  id: string
  text: string
  is_correct: boolean
  explanation?: string
}

export type CardImage = {
  key: string
  target: string
  alt: string
  source_ref?: string
  url?: string
}

// ---------------------------------------------------------------------------
// users (PK = id uuid; clerk_id is a UNIQUE connector, nullable for GDPR scrub)
// id (UUID) は internal PK (auth provider 非依存 identity)、 clerk_id は Clerk
// session 連携 key (UNIQUE)。 soft delete via deleted_at (Stripe / audit
// retention のため users のみ採用)。
// GDPR PII scrub: 退会時 (handleUserDeleted) に email / clerk_id を NULL に
// 上書きするため、両列とも nullable とする (PG UNIQUE は NULL を重複扱いしない
// ので clerk_id は UNIQUE のまま保持)。 active な user 行では NOT NULL 相当
// (INSERT path で必ず値を与える) という invariant を webhook handler 側で担保。
// 同一 Clerk 元 user の revival は発生しない (Clerk は userId を一度限り採番)
// ため、 scrub 済み行 (clerk_id=NULL) と新規 user.created (異なる新 clerk_id) は
// ON CONFLICT 衝突せず、 新規行が作られて旧 scrub 行は audit として残る = 仕様通り。
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').unique(),
  email: text('email'),
  stripeCustomerId: text('stripe_customer_id').unique(),
  // in-place プラン変更の識別 key。1 user 1 active subscription invariant を
  // 保持し、subscription 系 webhook (created/updated/deleted) で populate/clear する。
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  // 方針C: ダウングレード予約 (subscription_schedule) のトラッキング 3 列。
  // changePlan のダウングレード経路で set、release 完了 webhook で clear する。
  // scheduledDowngradeScheduleId: ブロック条件の本体 (§5.5) + release 照合 #1 (§6.4)。
  // scheduledTargetPriceId: 予約先 price。release 照合 #5 (§6.4) で使用。
  // scheduledChangeEffectiveAt: schedule phase0 の end_date。UI 表示専用 (切替発効日時)。
  scheduledDowngradeScheduleId: text('scheduled_downgrade_schedule_id'),
  scheduledTargetPriceId: text('scheduled_target_price_id'),
  scheduledChangeEffectiveAt: timestamp('scheduled_change_effective_at', {
    withTimezone: true,
  }),
  plan: text('plan')
    .$type<'free' | 'standard' | 'pro'>()
    .notNull()
    .default('free'),
  // subscription_status: Stripe emits more states (trialing, incomplete,
  // incomplete_expired, unpaid, paused). Webhook handler normalizes to these
  // 3 (trialing -> active, unpaid -> past_due, etc.) before writing.
  //
  // 注: past_due は 2 つの semantics を兼ねる:
  //   (a) past_due + plan IN ('standard','pro') = 初回支払失敗 retry 期間中、
  //       grace window でアクセス保持
  //   (b) past_due + plan='free'                = unpaid/incomplete 由来の
  //       downgrade 完了後 (max retry 経過 or 初回支払未完了)
  // downstream UI は (plan, subscriptionStatus) 組合せで区別する必要あり
  // (route.ts resolvePlanFromSub 参照)。 4 値化 (unpaid 別立て) は v1.x 検討。
  subscriptionStatus: text('subscription_status').$type<
    'active' | 'past_due' | 'canceled'
  >(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  // キャンセル予定日時: Stripe が返す cancel_at を保存。null = キャンセル予約なし。
  cancelAt: timestamp('cancel_at', { withTimezone: true }),
  // 課金サイクル: NULL = 課金プランなし (free)、'month' = 月額、'year' = 年額。
  // plan 軸 (free/standard/pro) と直交し、 機能差は plan のみが決定。 cycle は
  // 表示・upsell・price_id 選択にのみ使用。 webhook で price_id → (plan, interval)
  // を解決して同時更新 (lib/stripe/price-mapping.ts 参照)。
  //
  // Invariants (webhook handler + price-mapping で担保):
  //   plan='free'                 ⇒ billingInterval IS NULL
  //   plan IN ('standard','pro')  ⇒ billingInterval IN ('month','year')
  // 例外: 本列導入 (2026-05-17) 以前の課金 user の billingInterval は NULL の
  // まま、 次回 webhook 受信時に resync される (この transition window のみ
  // paid plan && interval NULL が legal、 frontend は NULL を 'month' として
  // 暫定表示する fallback 必須)。
  billingInterval: text('billing_interval').$type<'month' | 'year'>(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

// ---------------------------------------------------------------------------
// reviews (FSRS 評価履歴、append-only)
// word_id → card_id (Sprint A-2)、 FK 先は cards.id、 onDelete cascade。
// (user_id, reviewed_at) index = streak query、 (card_id, reviewed_at) index =
// カード別履歴取得 (§2.8)。
// ---------------------------------------------------------------------------
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    // 1=Again, 2=Hard, 3=Good, 4=Easy
    rating: integer('rating').$type<1 | 2 | 3 | 4>().notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('reviews_user_reviewed_idx').on(t.userId, t.reviewedAt),
    index('reviews_card_idx').on(t.cardId, t.reviewedAt),
  ],
)

// ---------------------------------------------------------------------------
// ai_usage (グローバル日次カウンタ、JST date) — 変更なし
// ---------------------------------------------------------------------------
export const aiUsage = pgTable('ai_usage', {
  date: date('date', { mode: 'string' }).primaryKey(),
  count: integer('count').notNull().default(0),
})

// ---------------------------------------------------------------------------
// ai_usage_users (ユーザー別日次カウンタ、複合 PK)
// FK ON DELETE: NO ACTION → CASCADE (Sprint A-2、users hard delete 整合性確保)
// ---------------------------------------------------------------------------
export const aiUsageUsers = pgTable(
  'ai_usage_users',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date] })],
)

// ---------------------------------------------------------------------------
// stripe_events / clerk_events (Webhook idempotency) — 変更なし
// ルール B 例外: idempotency table で event 単位、 user_id 持たず。
// ---------------------------------------------------------------------------
export const stripeEvents = pgTable('stripe_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const clerkEvents = pgTable('clerk_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// integration_failures (課金系・外部連携の失敗を SQL で引ける台帳。Sprint 2 で旧
// 削除失敗専用 audit table を廃止し本 table に一般化・吸収)。4 軸判別列
// (service / operation / workflow / failure_code) の語彙と
// 組合せの妥当性は DB CHECK でなくコード側 catalog (lib/integration-failures.ts)
// で enforce するため $type<> union は付けない (catalog を語彙の SSoT に一本化)。
// FK なし (audit 行は user 削除後も残置)。
// user_id / error_message nullable (webhook 文脈に userId 無し・anomaly 検知系は
// 合成エラー文字列を作らない)。retry_count / next_retry_at / resolved_at /
// resolution_note は手動回収用で Sprint 2 では読み書きしない (dormant)。index は
// PK のみ (YAGNI)。
// 詳細: specs/2026-07-10-sprint2-integration-failures-design.md §4
// ---------------------------------------------------------------------------
export const integrationFailures = pgTable('integration_failures', {
  id: uuid('id').primaryKey().defaultRandom(),
  service: text('service').notNull(),
  operation: text('operation').notNull(),
  workflow: text('workflow'),
  failureCode: text('failure_code').notNull(),
  userId: uuid('user_id'),
  clerkId: text('clerk_id'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  scheduleId: text('schedule_id'),
  context: jsonb('context').notNull(),
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionNote: text('resolution_note'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// exams (mcq 新規)
// hard delete (deleted_at なし、Sprint A-2 確定)。 archived_at で
// ダウングレード時の自動アーカイブ (NULL = アクティブ)。
// ---------------------------------------------------------------------------
export const exams = pgTable(
  'exams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    questionNoFormat: text('question_no_format').$type<
      'numeric' | 'hierarchical' | 'free'
    >(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // 非正規化 (B1 / S2.0c): この exam に属する cards 件数のキャッシュ列。
    // 試験一覧の件数表示を cards への JOIN+GROUP BY 集計から定数読みに変える。
    // card の INSERT (process.ts の OCR bulk) / DELETE (delete-card.ts) と
    // 同一 transaction で増減する。 exam 削除時は exam 行ごと消えるため更新不要。
    // 単体 card 作成 (createCard) は未実装、 実装時に +1 を同 tx で行うこと。
    cardCount: integer('card_count').notNull().default(0),
    // S-cache-0 (§14.9): local-first 同期用の version 列。 server 側 bulk API が
    // mutation 適用時に +1 する楽観ロック相当の数値。 client は受領済 version を
    // 保持し、 push 時に比較に使う。
    contentVersion: integer('content_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('exams_user_id_idx').on(t.userId),
    // 増分 pull (getExamsDelta: WHERE user_id = ? AND updated_at >= ?) を全行 scan
    // から range scan にする複合 index。 列順は user_id 等価 → updated_at 範囲 →
    // id (将来の keyset pagination 前方互換、 cards と同方針)。
    index('exams_user_updated_id_idx').on(t.userId, t.updatedAt, t.id),
  ],
)

// ---------------------------------------------------------------------------
// cards (mcq メインテーブル、words を置換)
// hard delete (deleted_at なし、Sprint A-2 確定)。 FSRS カラム命名は plan00
// 踏襲 (state integer / difficulty real / last_review)。 source_documents →
// cards は SET NULL (OCR 元削除しても抽出 card は保持)。
// ---------------------------------------------------------------------------
export const cards = pgTable(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    sourceDocumentId: uuid('source_document_id').references(
      () => sourceDocuments.id,
      { onDelete: 'set null' },
    ),
    // コンテンツ
    title: text('title').notNull(),
    sortKey: text('sort_key'),
    questionText: text('question_text').notNull(),
    options: jsonb('options').notNull().$type<CardOption[]>(),
    correctAnswerIds: jsonb('correct_answer_ids').notNull().$type<string[]>(),
    explanationText: text('explanation_text'),
    // S2.0b-1: ユーザーが card 毎に自由メモを追記 (試験詳細 inline 編集で入力)。
    memo: text('memo'),
    images: jsonb('images')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<CardImage[]>(),
    // 学習統計 (デノーマライズ、 mcq 新規追加)
    answered: boolean('answered').notNull().default(false),
    // NULL = 未回答
    lastCorrect: boolean('last_correct'),
    currentStreak: integer('current_streak').notNull().default(0),
    // FSRS 状態 (plan00 既存命名踏襲)
    due: timestamp('due', { withTimezone: true }).notNull().defaultNow(),
    stability: real('stability').notNull().default(0),
    difficulty: real('difficulty').notNull().default(0),
    elapsedDays: integer('elapsed_days').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    // 0=New, 1=Learning, 2=Review, 3=Relearning
    state: integer('state').$type<0 | 1 | 2 | 3>().notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0),
    lastReview: timestamp('last_review', { withTimezone: true }),
    // S-cache-0 (§14.9): local-first 同期用の version 列 (exams と同様)。
    contentVersion: integer('content_version').notNull().default(0),
    // 監査
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('cards_sort_idx').on(t.userId, t.examId, t.sortKey),
    index('cards_due_idx').on(t.userId, t.due),
    index('cards_answered_idx').on(t.userId, t.examId, t.answered),
    index('cards_exam_idx').on(t.examId),
    // C1 (S2.0c): source_document_id は FK (ON DELETE SET NULL) だが index が
    // 無いと source_documents 削除時の SET NULL cascade が cards 全表 seq scan に
    // なる。 owner-scoped な getCardsForSourceDocument の絞り込みも兼ねる。
    index('cards_source_document_idx').on(t.sourceDocumentId),
    // 増分 pull (getCardsDelta: WHERE user_id = ? AND updated_at >= ?) を全行 scan
    // から range scan にする複合 index。 列順は user_id 等価 → updated_at 範囲 →
    // id。 id は将来の keyset pagination (ORDER BY updated_at, id + LIMIT) で index
    // 再作成を避けるための前方互換 (現クエリは ORDER BY 無しのため機能上は
    // (user_id, updated_at) で足りる)。
    index('cards_user_updated_id_idx').on(t.userId, t.updatedAt, t.id),
  ],
)

// ---------------------------------------------------------------------------
// source_documents (OCR アップロード元の管理、hard delete)
// OCR ジョブの作業 / trace table。 exam とライフサイクルを共有し、 exam 削除で
// FK CASCADE 連動削除される。 月次 quota 集計には使わない (S1.9.1 で upload_records
// に分離)。 アップロードファイル自体は inline base64 で Gemini に渡すのみで永続化
// しない (R2 非経由)。
// ---------------------------------------------------------------------------
export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    // S1.9.2: この upload が exam を新規作成したか (= 'new') / 既存 exam に
    // 追加したか (= 'existing') を記録。 discard 時に「auto 作成 exam を
    // cascade 削除するか / 既存 exam を残すか」 を server 側で DB から判定する
    // 真実 source。 旧来 client が examWasAutoCreated を持ち回っていたのを廃止し、
    // URL / client 改竄に対して堅牢化。 default なし = processUpload で必ず set。
    mode: text('mode').$type<'new' | 'existing'>().notNull(),
    fileType: text('file_type')
      .$type<'pdf' | 'image' | 'csv' | 'markdown'>()
      .notNull(),
    filename: text('filename').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    // S1.9.1: 'uploading' を廃止 (R2 presigned upload 段階の状態だったが、
    // inline base64 方式では到達経路がない)。 processUpload は常に 'processing'
    // で INSERT するため default も 'processing' に変更。
    status: text('status')
      .$type<'processing' | 'completed' | 'failed'>()
      .notNull()
      .default('processing'),
    pagesProcessed: integer('pages_processed').notNull().default(0),
    pagesTotal: integer('pages_total'),
    cardsExtracted: integer('cards_extracted').notNull().default(0),
    // S1.9.1: integer → numeric(10,4)。 cost を小数で保持 (integer 切り捨ての
    // 集計誤差を排除)。 mode:'number' で TS 上は number として読み書きする。
    ocrCostYen: numeric('ocr_cost_yen', {
      precision: 10,
      scale: 4,
      mode: 'number',
    }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('source_docs_user_exam_idx').on(t.userId, t.examId),
    index('source_docs_status_idx').on(t.userId, t.status),
    // C2 (S2.0c): exam_id 単独の FK cascade 用。 source_docs_user_exam_idx は
    // (user_id, exam_id) 複合で exam_id が非先頭のため、 exam 削除時の
    // cascade (WHERE exam_id = ?) に使えず seq scan になる。
    index('source_docs_exam_idx').on(t.examId),
    // D1 (S2.0c): /api/exams/status の polling 用。 DISTINCT ON (exam_id)
    // ORDER BY exam_id, created_at DESC を index 走査で解決する。 user_id 固定後
    // は (exam_id, created_at DESC) 順で並ぶため、 exam ごと最新行を先頭で拾える。
    // 註: source_docs_user_exam_idx (user_id, exam_id) は本 index の prefix で
    // 冗長になる — drop は scope 外 (D1 は「追加」指定)、 follow-up で要検討。
    index('source_docs_user_exam_created_idx').on(
      t.userId,
      t.examId,
      t.createdAt.desc(),
    ),
  ],
)

// ---------------------------------------------------------------------------
// upload_records (OCR 月次利用台帳、S1.9.1 新設、append-only)
// source_documents が「OCR 作業 table (exam と同寿命、 discard / cascade で消える)」
// と「月次 quota 集計元」 を兼ねていたため、 discard 物理削除で quota が返金される
// 構造欠陥があった (Bug A)。 集計元を本 table に分離し、 OCR 完了 / 失敗時に
// append のみ、 discard では一切 touch しない。 これにより月次消費は monotonic。
// exam_id は持たない (台帳は exam から独立、 exam 削除の影響を受けない)。
// 月次 quota = 当月 (JST 月境界) かつ status='completed' の pages_processed SUM。
// ---------------------------------------------------------------------------
export const uploadRecords = pgTable(
  'upload_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    // 月次 quota SUM の対象列 (status='completed' の行のみ集計)。
    pagesProcessed: integer('pages_processed').notNull().default(0),
    ocrCostYen: numeric('ocr_cost_yen', {
      precision: 10,
      scale: 4,
      mode: 'number',
    }),
    // 失敗も台帳として append する (status='failed')。 quota SUM は completed で
    // 絞るため failed 行は消費に計上されない。
    status: text('status').$type<'completed' | 'failed'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('upload_records_user_created_idx').on(t.userId, t.createdAt)],
)

// ---------------------------------------------------------------------------
// study_days (学習日カレンダー、ユーザー単位、複合 PK)
// reviews と独立で持つことで cards 削除の影響を受けない (§2.5.4)。
// day は JST 日付 'YYYY-MM-DD'。
// ---------------------------------------------------------------------------
export const studyDays = pgTable(
  'study_days',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    reviewCount: integer('review_count').notNull().default(0),
    correctCount: integer('correct_count').notNull().default(0),
    distinctCardCount: integer('distinct_card_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
)

// ---------------------------------------------------------------------------
// user_settings (ユーザー設定、S2.1 新設 / S2.2 fsrs_mode 追加 / S2.3 nullable 化)
// session_limit: smart モード用 1 session あたりの最大 card 数。nullable = 上限なし、default 20。
// custom_session_limit: custom モード用 上限。nullable = 上限なし、default 20 (未設定を示す)。
// fsrs_mode: false=通常 (回答時 client が rating 自動マッピング)、
//   true=上級 (user が Again/Hard/Good/Easy を直接押す)。
// PK = user_id (1 user 1 行、UPSERT で lazy init)。
// ---------------------------------------------------------------------------
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  sessionLimit: integer('session_limit').default(20),
  customSessionLimit: integer('custom_session_limit').default(20),
  fsrsMode: boolean('fsrs_mode').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

// ---------------------------------------------------------------------------
// contact_messages (お問い合わせ、§2.3.7 仮構造 + Sprint A-2 確定)
// user_id は nullable (未認証受付可、CASCADE で users hard delete に追随)。
// 個人情報削除依頼対応のため hard delete。 DB INSERT 実装は Sprint A-3+。
// ---------------------------------------------------------------------------
export const contactMessages = pgTable(
  'contact_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    // default 'general': contact form (Sprint A-2 stub) は category 未提示で
    // INSERT する想定。 form 側に category select 追加は Sprint A-3+ で実装、
    // それまでは default で fallback。
    category: text('category')
      .$type<'general' | 'bug' | 'takedown' | 'billing' | 'other'>()
      .notNull()
      .default('general'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status')
      .$type<'open' | 'in_progress' | 'resolved'>()
      .notNull()
      .default('open'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // C3 (S2.0c): user_id FK (ON DELETE CASCADE) 用 index。 user 削除時の
  // cascade および clerk webhook の明示 delete が seq scan になるのを防ぐ。
  (t) => [index('contact_messages_user_idx').on(t.userId)],
)

// ---------------------------------------------------------------------------
// study_sessions (S-cache-0 / §14.9 新設)
// 演習セッションのメタ情報。 session_id は client (uuidv4) 採番、 PK。
// answer_events.session_id の FK 参照先。 ライフサイクル: 演習開始で
// 'active' 行を insert、 完了で 'completed' + completed_at 更新、 離脱/放置で
// 'abandoned'。 server 側は bulk API 経由で受領した値を upsert する (client が
// 真実 source)。
// ---------------------------------------------------------------------------
export const studySessions = pgTable(
  'study_sessions',
  {
    sessionId: uuid('session_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // exam_id は set null (非 cascade)、 user.deleted 削除経路は user_id のみ。
    // users は soft delete のため user_id cascade も発火せず、 handler 明示 DELETE
    // が必須 (handler 集約コメント参照、 invariant test で網羅性検証)。
    examId: uuid('exam_id').references(() => exams.id, { onDelete: 'set null' }),
    mode: text('mode').$type<'smart' | 'custom'>().notNull(),
    cardIds: jsonb('card_ids')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    query: jsonb('query').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    status: text('status')
      .$type<'active' | 'completed' | 'abandoned'>()
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // §13.14 設計原則「updated_at 全テーブル (差分同期の基準)」 に整合。
    // status / completed_at 等の遷移ごとに $onUpdate で自動更新され、
    // last-write-wins な bulk upsert (§14.8) の判定 hook となる。
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('study_sessions_user_idx').on(t.userId, t.startedAt),
    index('study_sessions_exam_idx').on(t.examId),
  ],
)

// ---------------------------------------------------------------------------
// answer_events (S-cache-0 / §14.9 新設)
// 回答イベントの生ログ。 reviews (rating 履歴) とは別系統で並走、 選択肢ベース
// 生ログを保持する。 event_id UNIQUE で bulk API の冪等化を担保。
// session_id は study_sessions に SET NULL FK (session 行が消えても event は残す)。
// ---------------------------------------------------------------------------
export const answerEvents = pgTable(
  'answer_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull().unique(),
    // session_id は set null (非削除経路)。 削除は card_id → cards (exams 経由
    // cascade) または user_id (users soft delete のため発火せず、 cards 経由が
    // 実経路) で行われるため、 handler に answer_events を明示 DELETE しない
    // (= Group II、 二重記述しない)。 集約コメントは handler 側、 網羅性は
    // invariant test で担保。
    sessionId: uuid('session_id').references(() => studySessions.sessionId, {
      onDelete: 'set null',
    }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    selectedAnswerIds: jsonb('selected_answer_ids')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    isCorrect: boolean('is_correct').notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull(),
    elapsedMs: integer('elapsed_ms'),
    // server 側は受領確定のみを記録 (集計用途、 client の SyncStatus 4 値
    // とは目的が異なる)。 .$type で 'synced' に narrow し、 bulk API 実装時に
    // client SyncStatus を誤って書き込まないよう型 level で防ぐ。
    syncStatus: text('sync_status').$type<'synced'>().notNull().default('synced'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('answer_events_user_idx').on(t.userId, t.answeredAt),
    index('answer_events_card_idx').on(t.cardId, t.answeredAt),
    index('answer_events_session_idx').on(t.sessionId),
  ],
)

// ---------------------------------------------------------------------------
// entity_mutations (旧 card_mutations から汎用化、 S-sync-1)
// mutation-driven push の汎用 outbox + 冪等化 dedupe ログ。 mutation_id UNIQUE で
// 再送安全性を担保。 entity_type で対象 entity (card / 将来 tag_category 等) を識別、
// entity_id は対象 entity の PK。 entity_type ごとに参照先 table が異なるため
// entity_id に FK は付けず、 app 層 (apply registry) で整合保証する。
// op は registry で定義する文字列 (現状 card: 'update_field' | 'create' | 'delete')。
// patch jsonb は client が確定した部分更新 payload で、 server 側 registry の
// apply 関数が解釈する。
// ---------------------------------------------------------------------------
export const entityMutations = pgTable(
  'entity_mutations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mutationId: uuid('mutation_id').notNull().unique(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    op: text('op').notNull(),
    patch: jsonb('patch').notNull().$type<Record<string, unknown>>(),
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('entity_mutations_entity_idx').on(t.entityType, t.entityId, t.editedAt),
    index('entity_mutations_user_idx').on(t.userId, t.editedAt),
  ],
)

// ---------------------------------------------------------------------------
// tag_categories (Tag-1 新設) — タグカテゴリのマスタ。試験横断 (全 exam 共通 1 空間)。
// select_type は作成後 immutable (DB level は text のまま、 immutability は UI 担保)。
// name は同 user 内で重複可 (別 id で同名共存、 OCR 流入で merge しない方針との整合)。
// 削除は user_id direct cascade のため Group I (handler に明示 DELETE)。
// 子 (tag_options / card_tags) は category_id 経由で連鎖削除される。
// ---------------------------------------------------------------------------
export const tagCategories = pgTable(
  'tag_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    selectType: text('select_type').$type<'single' | 'multi'>().notNull(),
    color: text('color'),
    sortKey: text('sort_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // pull delta 用 (WHERE user_id=? AND updated_at >= ?)
    index('tag_categories_user_updated_idx').on(t.userId, t.updatedAt, t.id),
  ],
)

// ---------------------------------------------------------------------------
// tag_options (Tag-1 新設) — タグカテゴリ配下の選択肢。
// UNIQUE(category_id, name) で同カテゴリ内の重複を弾く (rename / category 間移動の
// 衝突は per-mutation failed として client にフィードバック)。
// category_id cascade のため、 tag_categories 削除で連動削除 (Group II)。
// ---------------------------------------------------------------------------
export const tagOptions = pgTable(
  'tag_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => tagCategories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    sortKey: text('sort_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('tag_options_user_updated_idx').on(t.userId, t.updatedAt, t.id),
    index('tag_options_category_idx').on(t.categoryId),
    uniqueIndex('tag_options_category_name_uq').on(t.categoryId, t.name),
  ],
)

// ---------------------------------------------------------------------------
// card_tags (Tag-1 新設) — card ↔ tag_option の junction。
// 複合 PK (card_id, option_id)。 多重 cascade chain (card_id / option_id / user_id)
// により Group II として扱う (user.deleted handler で明示 DELETE しない)。
// Tag-1 では table のみ作成し、 client 側書込経路 (card outbox の whole-set field 相乗り) は
// 未実装 (Tag-2 で実装)。 OCR 分解書込は Tag-3 で実装。
// ---------------------------------------------------------------------------
export const cardTags = pgTable(
  'card_tags',
  {
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    optionId: uuid('option_id')
      .notNull()
      .references(() => tagOptions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.optionId] }),
    index('card_tags_option_idx').on(t.optionId),
    index('card_tags_user_idx').on(t.userId),
  ],
)

// ---------------------------------------------------------------------------
// tombstones (S-delete-0 / §1 新設)
// exam・card 統合 tombstone テーブル。 対象行は物理削除済のため entityId に FK 不可。
// userId FK は cascade (user 削除時に tombstone も連動削除)。
// Tag-1: entity_type に 'tag_category' | 'tag_option' を $type 拡張 (text 列なので
// migration 不要、 型のみ)。
// ---------------------------------------------------------------------------
export const tombstones = pgTable(
  'tombstones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entityType: text('entity_type')
      .$type<'exam' | 'card' | 'tag_category' | 'tag_option'>()
      .notNull(),
    entityId: uuid('entity_id').notNull(), // FK 不可: 対象は物理削除済
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('tombstones_user_deleted_idx').on(t.userId, t.deletedAt),
    uniqueIndex('tombstones_entity_uq').on(t.entityType, t.entityId),
  ],
)

// ---------------------------------------------------------------------------
// Type exports for downstream use
// ---------------------------------------------------------------------------
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Review = typeof reviews.$inferSelect
export type NewReview = typeof reviews.$inferInsert
export type AiUsage = typeof aiUsage.$inferSelect
export type AiUsageUser = typeof aiUsageUsers.$inferSelect
export type StripeEvent = typeof stripeEvents.$inferSelect
export type ClerkEvent = typeof clerkEvents.$inferSelect
export type NewClerkEvent = typeof clerkEvents.$inferInsert
export type IntegrationFailure = typeof integrationFailures.$inferSelect
export type NewIntegrationFailure = typeof integrationFailures.$inferInsert
export type Exam = typeof exams.$inferSelect
export type NewExam = typeof exams.$inferInsert
export type Card = typeof cards.$inferSelect
export type NewCard = typeof cards.$inferInsert
export type SourceDocument = typeof sourceDocuments.$inferSelect
export type NewSourceDocument = typeof sourceDocuments.$inferInsert
export type UploadRecord = typeof uploadRecords.$inferSelect
export type NewUploadRecord = typeof uploadRecords.$inferInsert
export type StudyDay = typeof studyDays.$inferSelect
export type NewStudyDay = typeof studyDays.$inferInsert
export type UserSettings = typeof userSettings.$inferSelect
export type NewUserSettings = typeof userSettings.$inferInsert
export type ContactMessage = typeof contactMessages.$inferSelect
export type NewContactMessage = typeof contactMessages.$inferInsert
export type StudySession = typeof studySessions.$inferSelect
export type NewStudySession = typeof studySessions.$inferInsert
export type AnswerEvent = typeof answerEvents.$inferSelect
export type NewAnswerEvent = typeof answerEvents.$inferInsert
export type EntityMutation = typeof entityMutations.$inferSelect
export type NewEntityMutation = typeof entityMutations.$inferInsert
export type TagCategory = typeof tagCategories.$inferSelect
export type NewTagCategory = typeof tagCategories.$inferInsert
export type TagOption = typeof tagOptions.$inferSelect
export type NewTagOption = typeof tagOptions.$inferInsert
export type CardTag = typeof cardTags.$inferSelect
export type NewCardTag = typeof cardTags.$inferInsert
export type Tombstone = typeof tombstones.$inferSelect
export type NewTombstone = typeof tombstones.$inferInsert
