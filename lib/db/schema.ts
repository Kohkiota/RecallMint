// Drizzle schema — mcq-platform (23 tables; FSRS 整合 Sprint A で reviews / study_sessions を廃止)
//
// FKs use CASCADE for user-owned data hierarchy
// (Sprint A-2 で plan00 既定の NO ACTION から変更)。
// ただし users は物理 DELETE されない soft delete 表 (`:10-16` 参照) のため、
// user_id CASCADE は実運用では発火しない。 実際の全データ削除は退会時 webhook
// handler (handleUserDeleted) が各表へ user_id 指定で明示 DELETE を発行し、
// その配下は親子 cascade (例: exams の明示 DELETE → cards/source_documents が
// exam_id CASCADE で追随) が担う。 user_id CASCADE は将来 users を物理削除方式
// へ切り替える場合の defense として保持する (現状は不発)。
// All user_id FKs (exams / cards / source_documents / study_days /
// user_settings / ai_usage_users / answer_events / contact_messages) は
// この defense の対象。
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
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
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
  // Sprint I W5: 画像紐付けの内部不変 identity(UUID v4・ユーザー不可視・非再利用)。
  // `id`(a/b/c 等)は表示ラベルでユーザー編集可 + 削除後再利用されるため、画像 target は
  // uid を参照する(rename/削除で mis-attach しない)。型は optional(既存 fixture 互換)だが
  // 全生成経路が mint し、書込境界の `optionSchema.uid`(z.uuid 必須)が uid 無しを reject する。
  uid?: string
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
// ai_usage (グローバル日次カウンタ、JST date) — 変更なし
// ---------------------------------------------------------------------------
export const aiUsage = pgTable('ai_usage', {
  date: date('date', { mode: 'string' }).primaryKey(),
  count: integer('count').notNull().default(0),
})

// ---------------------------------------------------------------------------
// ai_usage_users (ユーザー別日次カウンタ、複合 PK)
// FK ON DELETE: NO ACTION → CASCADE (Sprint A-2、users hard delete 整合性確保)
// abuse 対応台帳: app に読み手は無いが死列ではない。 濫用 user の特定・ban 判断は
// 運用者が SQL で本表を直接引く。 書き手 = lib/ai-usage-counter.ts の UPSERT のみ。
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
// dedup は event_id (PK) 単独で完結する。 type 列は app の分岐に使わない forensic
// 列 (どの event 種別が到達したかの事後調査用)。
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
// 踏襲 (state integer / difficulty double precision / last_review。 real →
// double precision は FSRS 整合 Sprint A Task 3・spec §1.3)。 source_documents →
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
    // FSRS 整合 Sprint A Task 3(spec §1.3 / §7.1): この block の DB default を撤去。
    // 初期値は lib/cards/domain/initial-fsrs-state.ts の 1 定義から全 insert 経路が
    // 明示 set する(default 撤去済 = 供給漏れは INSERT 時 NOT NULL 違反で loud fail)。
    answered: boolean('answered').notNull(),
    // NULL = 未回答
    lastCorrect: boolean('last_correct'),
    currentStreak: integer('current_streak').notNull(),
    // FSRS 状態 (plan00 既存命名踏襲)
    due: timestamp('due', { withTimezone: true }).notNull(),
    // real → double precision(Task 3): FSRS 計算(ts-fsrs)は倍精度で行われるため、
    // 単精度 real への丸めは値の drift を招く。書込側 cast(session-repository.ts)も
    // ::double precision に合わせて変更する。
    stability: doublePrecision('stability').notNull(),
    difficulty: doublePrecision('difficulty').notNull(),
    elapsedDays: integer('elapsed_days').notNull(),
    scheduledDays: integer('scheduled_days').notNull(),
    reps: integer('reps').notNull(),
    lapses: integer('lapses').notNull(),
    // 0=New, 1=Learning, 2=Review, 3=Relearning。CHECK は下記 extras 参照。
    state: integer('state').$type<0 | 1 | 2 | 3>().notNull(),
    learningSteps: integer('learning_steps').notNull(),
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
    // FSRS 整合 Sprint A Task 3(spec §1.3): state は ts-fsrs の 4 状態(0-3)のみが
    // 有効値。DB default 撤去に合わせ、無効値の混入を DB 層でも塞ぐ。
    check('cards_state_range', sql`${t.state} BETWEEN 0 AND 3`),
  ],
)

// ---------------------------------------------------------------------------
// source_documents (OCR アップロード元の管理、hard delete)
// OCR ジョブの作業 / trace table。 exam とライフサイクルを共有し、 exam 削除で
// FK CASCADE 連動削除される。 月次 quota 集計には使わない (S1.9.1 で upload_records
// に分離)。 アップロードファイル自体は画像なら inline base64 で Gemini に渡す
// のみで永続化しない。 PDF は count/render phase のため `src/` prefix で R2 に
// 一時ステージングされる (client presigned PUT、②-4b T8。upload-pipeline.ts が
// パイプライン出口で明示 deleteObject し、 取りこぼしは R2 lifecycle rule
// (`src/` maxAge 86400s) が受け皿になる)。
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
    // URL / client 改竄に対して堅牢化。 default なし = upload action で必ず set。
    mode: text('mode').$type<'new' | 'existing'>().notNull(),
    fileType: text('file_type')
      .$type<'pdf' | 'image' | 'csv' | 'markdown'>()
      .notNull(),
    filename: text('filename').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    // S1.9.1: 'uploading' を廃止 (R2 presigned upload 段階の状態だったが、
    // inline base64 方式では到達経路がない)。 upload action は常に 'processing'
    // で INSERT するため default も 'processing' に変更。
    status: text('status')
      .$type<'processing' | 'completed' | 'failed'>()
      .notNull()
      .default('processing'),
    pagesProcessed: integer('pages_processed').notNull().default(0),
    // PDF を含む upload は作成時 NULL で INSERT され、count phase の fenced CAS
    // (`commitPdfCountCas`・upload-pipeline.ts)が実ページ数確定時に書く(spec D6・
    // expected_source_count と同一 CAS)。画像のみの upload は作成時に確定値(NULL 窓なし)。
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
// answer_events から再集計する派生値だが、cards 削除の影響を受けない独立表として持つ。
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
// 個人情報削除依頼対応のため hard delete。 DB INSERT 実装済み (lib/actions/contact.ts)。
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
    // 将来の管理 UI 用の状態列。 UI が無い間は運用者が SQL で直接更新する運用の
    // ため、 'in_progress' / 'resolved' が app から到達不能なのは仕様(死列ではない)。
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
// answer_events (FSRS 整合 Sprint A・spec §1.1 — 復習の唯一の正本)
// 全回答 event の恒久記録。reviews / study_sessions は本表に統合して廃止した。
// PK = client 採番 event_id (冪等キーと PK の一本化・surrogate id 廃止)。
// card_id は **FK を張らない**: 学習履歴はユーザーに帰属し、card 削除後も残る
// dangling を正規状態とする (従来 cascade 設計の意図的 override)。session_id も
// FK なしのラベル。よって削除経路は user_id だけになり、退会 handler の明示
// DELETE (Group I) が必須 — 網羅性は invariant test が担保する。
// ---------------------------------------------------------------------------
export const answerEvents = pgTable(
  'answer_events',
  {
    eventId: uuid('event_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id').notNull(),
    sessionId: uuid('session_id'),
    selectedAnswerIds: jsonb('selected_answer_ids')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    // 統計・フィルタの正誤定義 (scheduling は rating・spec §6 の 2 本立て)。
    isCorrect: boolean('is_correct').notNull(),
    // 1=Again, 2=Hard, 3=Good, 4=Easy。scheduling の正誤定義。
    rating: integer('rating').$type<1 | 2 | 3 | 4>().notNull(),
    // clamp 済み値 (min(raw, created_at))。raw は保存しない。
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull(),
    elapsedMs: integer('elapsed_ms'),
    // 順序ガードの結果。ingest 時点の判定で以後不変 (再評価しない)。
    applied: boolean('applied').notNull(),
    // server 受信時刻を app 層で明示 set する (clamp 上界と同一時刻源にして
    // answered_at <= created_at の CHECK を厳密成立させるため DB now() を使わない)。
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // card_id 系 index は張らない (現読み手ゼロ・必要時に CREATE INDEX 一発)。
    index('answer_events_user_idx').on(t.userId, t.answeredAt),
    check('answer_events_rating_range', sql`${t.rating} BETWEEN 1 AND 4`),
    check(
      'answer_events_elapsed_ms_nonneg',
      sql`${t.elapsedMs} IS NULL OR ${t.elapsedMs} >= 0`,
    ),
    check(
      'answer_events_answered_at_le_created_at',
      sql`${t.answeredAt} <= ${t.createdAt}`,
    ),
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
// assets (画像フェーズ A 新設、migration 0023) — R2 ホスト画像バイトの台帳。
// card row と独立 (reservation 時点で card 未確定 / (user_id, hash) dedup lookup /
// reserved→ready 状態遷移が card と無関係) のため cards.images に内包しない。
// object_key は 'users/{user_id}/{assetId}.{webp|png|jpg}' 形式で UNIQUE (jpg は
// iOS/WebKit 修正の fallback で元 jpeg を直 PUT する際の拡張子。 R2 key の
// 一意性を DB 側でも担保)。status / mime は DB CHECK を張らずアプリ層 invariant
// とする (Sprint 2 integration_failures catalog 前例と同判断)。
// unreferenced_at は画像 GC v2 の中核列に昇格済み (mark/promote/sweep の判定を
// lib/media/domain/asset-state.ts が pure に表現し、 lib/storage/asset-gc.ts の
// reconciler と app/(app)/app/upload/_actions/publish-prepared.ts が読み書きする)。
// reference_count のみ将来の orphan 掃除用の枠のまま dormant (列のみ確保、
// アプリコードは一切読み書きしない)。
// pull 同期非対象 (学習データでない、client 側は Dexie media_assets が別途持つ)。
// user 削除: cascade で台帳は消える (R2 object 自体の自動掃除は scope 外)。
// 詳細: docs/superpowers/specs/2026-07-12-image-phase-a-design.md §2.1
// ---------------------------------------------------------------------------
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull().unique(),
    mime: text('mime').notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    hash: text('hash').notNull(),
    status: text('status').notNull().default('reserved'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    // dormant: 将来の orphan 掃除 (手動 SQL) 用の枠。アプリコードは読み書きしない
    // (unreferencedAt と異なり本列のみ dormant — 上記 table comment 参照)。
    referenceCount: integer('reference_count').notNull().default(0),
    unreferencedAt: timestamp('unreferenced_at', { withTimezone: true }),
  },
  (t) => [
    index('assets_user_hash_idx').on(t.userId, t.hash),
    index('assets_user_status_idx').on(t.userId, t.status),
  ],
)

// ---------------------------------------------------------------------------
// card_asset_refs (画像 GC v2 Task G1 新設) — 画像参照の正規化テーブル。
// GC 権威。cards.images 配列は wire/表示として残す(二重持ち・legacy 非 UUID OCR
// entry は配列のみで refs に入らない)。
// cards.images を書く経路を増やす時は refs 同期必須(現状 handleImages 実質単一点)。
// ordinal は同 field_key 内順序のみ。target 横断の元配列全体順は保存しない。
// card_id は cards cascade (card 削除で refs も連動削除)。asset_id は RESTRICT
// (cards とは非対称 — 参照中 asset の誤削除を DB で拒否)。user_id は card_tags
// 前例どおり cascade FK。
// 詳細: docs/superpowers/specs/2026-07-13-image-gc-normalized-refs-design.md §4.1
// ---------------------------------------------------------------------------
export const cardAssetRefs = pgTable(
  'card_asset_refs',
  {
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    ordinal: integer('ordinal').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.fieldKey, t.ordinal] }),
    index('card_asset_refs_asset_idx').on(t.assetId),
  ],
)

// ---------------------------------------------------------------------------
// upload_operations (②-4a Phase A Task 2 新設) — 冪等 upload/OCR 操作の状態機械 ledger。
// 1 クライアント操作 (idempotency_key) : 1 行。正常遷移は
// processing → prepared → completed、失敗は terminal_failed。
// lease_version/lease_expires_at は「この invocation が生存している」表明 (live-op
// gate と pipeline の fenced CAS が読む)。source_document_id は旧経路が生成時点で
// 未確定だった名残で今は nullable だが、単一 invocation 経路は sync tx で必ず
// 確定させるため実質必須値 (本 sprint の後続 task で NOT NULL 化する予定)。
// 以降 (lease_expires_at / last_error_code / prepared_schema_version /
// prepared_hash / prepared_payload / result_summary / completed_at) も
// 状態遷移が進むまで値を持たない nullable 列。UNIQUE(user_id, idempotency_key) で
// 同一ユーザー内の再送を同一行に収束させる。
// Realtime publication 非追加: 本 repo は Supabase realtime publication を管理して
// いない (追加すべき対象が存在しない、意図的に何もしない)。
// exam_id: exam cascade (この ledger は 1 exam に対する 1 回の upload 操作)。
// source_document_id: 現在は FK が ON DELETE SET NULL だが、NOT NULL 化と
// 両立しないため本 sprint の後続 task で FK を ON DELETE CASCADE へ張り替える
// (source_documents の単独 DELETE 経路が production に存在しない現物確認により、
// cascade で失われる操作記録は無いと判断)。「削除後も操作記録は残す」という
// 旧意図は単独削除経路が無いことで既に空洞化している。 将来 source_documents の
// 単独 DELETE 経路を新設する場合は、この operation 保持方針 (cascade で消える)
// を再判断すること。
// 詳細: .superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/task-2-brief.md
// ---------------------------------------------------------------------------
export const uploadOperations = pgTable(
  'upload_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    sourceDocumentId: uuid('source_document_id').references(() => sourceDocuments.id, {
      onDelete: 'set null',
    }),
    // 'processing' = ②-4a 単一 invocation 経路(spec 2026-08-04 §4.5)が sync phase で
    // 作る「実行中」状態。'prepared' = payload commit 済(crop/publish 待ち)。
    // S-5 の旧経路撤去で旧 flow の 2 値を union から外した — DB CHECK は無いが、
    // 列 default は migration 0032 で 'processing' へ移した(default に頼る INSERT が
    // union に無い値を書かないため)。
    status: text('status')
      .$type<'prepared' | 'processing' | 'completed' | 'terminal_failed'>()
      .notNull()
      .default('processing'),
    leaseVersion: bigint('lease_version', { mode: 'number' }).notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    preparedSchemaVersion: integer('prepared_schema_version'),
    preparedHash: text('prepared_hash'),
    preparedPayload: jsonb('prepared_payload').$type<Record<string, unknown>>(),
    resultSummary: jsonb('result_summary').$type<Record<string, unknown>>(),
    // 受領枚数 manifest。publish 時の pages_processed / upload_records の記帳は
    // この列を独立 oracle として使う。**確定タイミングは経路で異なる**(spec D6):
    // 画像のみの upload は operation 作成時(INSERT)に確定する immutable な値。
    // PDF を含む upload は作成時 `0` sentinel で INSERT され(submit-upload.ts)、
    // count phase の fenced CAS(`commitPdfCountCas`・upload-pipeline.ts)が実
    // ページ数で確定する — CAS 成功後は同じく immutable(以降この列を書く経路は無い)。
    expectedSourceCount: integer('expected_source_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('upload_operations_user_idempotency_uq').on(
      t.userId,
      t.idempotencyKey,
    ),
    index('upload_operations_user_status_idx').on(t.userId, t.status),
  ],
)

// ---------------------------------------------------------------------------
// asset_derivations (②-4a Phase A Task 3 新設) — crop 由来の provenance メタ。
// assets 行の payload (R2 バイト) が将来 NULL 化/GC された後も、「どの領域を、
// どういうパディング/検出パラメータで切り出したか」を追跡可能に残すための
// 1:1 台帳 (PK = asset_id 自身、assets への 1:1 拡張)。
// asset_id は cascade (derivation は provenance メタに過ぎず、
// assets 行 (crop 結果) が消えれば存在意義が無くなる)。RESTRICT は当初検討したが
// (card_asset_refs.asset_id 前例)、本表は
// tenant 階層 (exam 削除 → cards cascade → assets cascade) の
// 末端で、上位が正しく連鎖削除できる必要があるため不適 (iso RED: rls-cascade /
// delete-isolation / rls-ghost の exam cascade 削除が RESTRICT で FK 違反した)。
// orig_bbox/clamped_bbox は検出座標系の jsonb (shape は usecase 層で zod 検証、
// DB 列は shape を強制しない — query/patch jsonb 列と同じ方針)。
// GDPR: user_id cascade で users 削除に連動 (cascade 対象)。
// 詳細: .superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/task-3-brief.md
// ---------------------------------------------------------------------------
export const assetDerivations = pgTable('asset_derivations', {
  assetId: uuid('asset_id')
    .primaryKey()
    .references(() => assets.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  origBbox: jsonb('orig_bbox').notNull().$type<Record<string, unknown>>(),
  paddingPct: real('padding_pct').notNull(),
  clampedBbox: jsonb('clamped_bbox').notNull().$type<Record<string, unknown>>(),
  cropW: integer('crop_w').notNull(),
  cropH: integer('crop_h').notNull(),
  detectTarget: text('detect_target').notNull(),
  pipelineVersion: text('pipeline_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// Type exports for downstream use
// ---------------------------------------------------------------------------
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
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
export type Asset = typeof assets.$inferSelect
export type NewAsset = typeof assets.$inferInsert
export type CardAssetRef = typeof cardAssetRefs.$inferSelect
export type NewCardAssetRef = typeof cardAssetRefs.$inferInsert
export type UploadOperation = typeof uploadOperations.$inferSelect
export type NewUploadOperation = typeof uploadOperations.$inferInsert
export type AssetDerivation = typeof assetDerivations.$inferSelect
export type NewAssetDerivation = typeof assetDerivations.$inferInsert
