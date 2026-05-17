// Drizzle schema — mcq-platform (12 tables, Sprint A-2 baseline)
//
// FKs use CASCADE for user-owned data hierarchy
// (Sprint A-2 で plan00 既定の NO ACTION から変更、 users 完全削除
// (GDPR / 個人情報保護法削除依頼) で全関連データを連動削除するため)。
// All user_id FKs (exams / cards / source_documents / study_days /
// ai_usage_users / reviews / contact_messages) cascade on user deletion.
// source_documents → cards uses SET NULL (OCR source deletion preserves
// extracted cards).
// Only users uses soft delete (deleted_at) for Stripe/audit retention;
// other tables use hard delete.
//
// ルール A: 全 timestamp は withTimezone: true (timestamptz 統一)。 date 型は
// mode: 'string'。
// ルール B: stripe_events / ai_usage / clerk_events を除く全 table に user_id を
// 持ち、 users.id (UUID) に FK。 auth provider 切替時の影響を Clerk 関連 column
// のみに局所化。 deletion_failures は audit table で FK なし
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
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Custom property schema types (exams.property_schema の TS 型)
// ---------------------------------------------------------------------------
export type PropertyType =
  | 'single_select'
  | 'multi_select'
  | 'number'
  | 'boolean'
  | 'date'
  | 'text'

export type PropertyDef = {
  name: string
  type: PropertyType
  select_options?: string[]
  default_value?: unknown
  is_system?: boolean
  display_order: number
}

export type PropertySchema = PropertyDef[]

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
// users (PK = id uuid; clerk_id is a UNIQUE NOT NULL connector)
// id (UUID) は internal PK (auth provider 非依存 identity)、 clerk_id は Clerk
// session 連携 key (UNIQUE NOT NULL)。 soft delete via deleted_at (Stripe /
// audit retention のため users のみ採用)。
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').notNull().unique(),
  email: text('email').notNull(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  plan: text('plan')
    .$type<'free' | 'standard' | 'pro'>()
    .notNull()
    .default('free'),
  // subscription_status: Stripe emits more states (trialing, incomplete,
  // incomplete_expired, unpaid, paused). Webhook handler normalizes to these
  // 3 (trialing -> active, unpaid -> past_due, etc.) before writing.
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
// deletion_failures (Stripe cancel 失敗 audit、FK 制約なし) — 変更なし
// user_id (uuid) と clerk_id (text) を両保持: UUID 軸 grouping + Clerk
// Dashboard で grep する audit context 維持。
// 詳細: lessons/2026-04-30-users-schema-decoupling.md
// ---------------------------------------------------------------------------
export const deletionFailures = pgTable('deletion_failures', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  clerkId: text('clerk_id').notNull(),
  subId: text('sub_id'),
  failureKind: text('failure_kind')
    .$type<'list' | 'cancel' | 'customer_missing'>()
    .notNull(),
  errorMessage: text('error_message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
})

// ---------------------------------------------------------------------------
// exams (mcq 新規、property_schema が肝)
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
    propertySchema: jsonb('property_schema')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<PropertySchema>(),
    questionNoFormat: text('question_no_format').$type<
      'numeric' | 'hierarchical' | 'free'
    >(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('exams_user_id_idx').on(t.userId)],
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
    images: jsonb('images')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<CardImage[]>(),
    // カスタムプロパティ (exams.property_schema に従って格納)
    customProps: jsonb('custom_props')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
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
    index('cards_props_gin_idx').using('gin', t.customProps),
    index('cards_answered_idx').on(t.userId, t.examId, t.answered),
    index('cards_exam_idx').on(t.examId),
  ],
)

// ---------------------------------------------------------------------------
// source_documents (OCR アップロード元の管理、hard delete)
// 同時実行制限はアプリ層で `WHERE user_id = ? AND status = 'processing' LIMIT 1`
// チェック。 file_url NULL = OCR 完了後 R2 元ファイル破棄済。
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
    fileType: text('file_type')
      .$type<'pdf' | 'image' | 'csv' | 'markdown'>()
      .notNull(),
    fileUrl: text('file_url'),
    filename: text('filename').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    status: text('status')
      .$type<'uploading' | 'processing' | 'completed' | 'failed'>()
      .notNull()
      .default('uploading'),
    pagesProcessed: integer('pages_processed').notNull().default(0),
    pagesTotal: integer('pages_total'),
    cardsExtracted: integer('cards_extracted').notNull().default(0),
    ocrCostYen: integer('ocr_cost_yen'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('source_docs_user_exam_idx').on(t.userId, t.examId),
    index('source_docs_status_idx').on(t.userId, t.status),
  ],
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
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
)

// ---------------------------------------------------------------------------
// contact_messages (お問い合わせ、§2.3.7 仮構造 + Sprint A-2 確定)
// user_id は nullable (未認証受付可、CASCADE で users hard delete に追随)。
// 個人情報削除依頼対応のため hard delete。 DB INSERT 実装は Sprint A-3+。
// ---------------------------------------------------------------------------
export const contactMessages = pgTable('contact_messages', {
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
})

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
export type DeletionFailure = typeof deletionFailures.$inferSelect
export type NewDeletionFailure = typeof deletionFailures.$inferInsert
export type Exam = typeof exams.$inferSelect
export type NewExam = typeof exams.$inferInsert
export type Card = typeof cards.$inferSelect
export type NewCard = typeof cards.$inferInsert
export type SourceDocument = typeof sourceDocuments.$inferSelect
export type NewSourceDocument = typeof sourceDocuments.$inferInsert
export type StudyDay = typeof studyDays.$inferSelect
export type NewStudyDay = typeof studyDays.$inferInsert
export type ContactMessage = typeof contactMessages.$inferSelect
export type NewContactMessage = typeof contactMessages.$inferInsert
