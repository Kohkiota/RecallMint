# DB schema 全体棚卸し(復習ドメイン外)— fact-finding 第 3 弾(2026-08-11)

- 目的: 復習ドメイン再設計と同時に DB 全体の歪みを一掃する候補の確定。ユーザー 0 前提・破壊的変更自由。判定基準 = **production の読み手の有無**(「将来使うかも」は残す理由にしない)。
- 方法: repo 現物のみ(`lib/db/schema.ts` / `drizzle/migrations/meta/0033_snapshot.json` / 全表 grep)。実装なし。
- 既済み参照: 第 1 弾 `2026-08-11-fsrs-consistency-factfinding.md` / 第 2 弾 `2026-08-11-review-domain-schema-inventory.md`(answer_events / reviews / cards FSRS 列 / study_sessions / study_days は再掲しない)。
- 実 DB(stg/prod)の行数・実データは**未確認**。

**総数**: schema.ts = **25 表** / snapshot = 25 表(一致)。schema.ts 冒頭コメント(:1)の「26 tables」は**現物と 1 ズレ(stale)**。復習ドメイン 5 表を除く **20 表**が本 doc の対象。

---

## 1. 全表の一覧と生死判定

判定語彙: **生** = 書き手・読み手とも production にある / **W-only** = 書くが読まない / **判定注記**は右列。

| 表 | 1 行 = | 列数 | 書き手(代表) | 読み手(代表) | 判定 |
|---|---|---|---|---|---|
| users | 1 ユーザー(認証・課金状態) | 16 | clerk webhook(`handle-clerk-event.ts`)/ stripe webhook(`subscription-repository.ts`) | 認証 resolve(`ensure-user.ts`)/ 課金 UI(settings/upgrade)/ checkout(`upgrade/actions.ts:68` email) | **生** |
| ai_usage | 1 日のグローバル Gemini call 数 | 2 | `incrementAiUsage`(`ai-usage-counter.ts:29`) | `getTodayAiUsageGlobal`(:56。`GEMINI_DAILY_LIMIT` gate・`submit-upload.ts:523`) | **生** |
| ai_usage_users | 1 (user, 日) の Gemini call 数 | 3 | `incrementAiUsage`(:37) | **なし**(grep 全 0。quota は upload_records が担う) | **W-only**。書き続ける理由 = `docs/02-tech-spec.md:75`「ユーザー別 AI 利用量(S1.8 で配線、月次 OCR quota とは無関係)」— 消費者の記述なし |
| stripe_events | 1 webhook event(冪等キー) | 3 | stripe route(:40 insert + ON CONFLICT returning) | 同 insert の RETURNING が dedupe 判定(= 読みは existence のみ。`type` 列は書くだけ) | **生**(dedupe として) |
| clerk_events | 同上(Clerk) | 3 | clerk route(:82) | 同上 | **生** |
| integration_failures | 外部連携失敗 1 件(台帳) | 17 | `recordIntegrationFailure`(`lib/integration-failures.ts`) | **app からなし**(app-role は RLS 42501・OT が SQL で引く。schema.ts:215「SQL で引ける台帳」と意図明記) | **W-only(意図宣言あり)** |
| exams | 1 試験 | 9 | create-exam / submit-upload(auto 作成)/ `bumpExamCardCount` | 一覧(`lib/exams/list.ts`)/ pull / upload gate | **生**(ただし 3 列に問題 — §2) |
| cards(非 FSRS 列) | 1 MCQ | 28 | OCR publish / `apply-card-mutation` / `card-field-handlers` | 一覧・編集・演習・pull ほか多数 | **生** |
| source_documents | 1 OCR 作業(exam と同寿命) | 15 | submit-upload INSERT(:577)/ pipeline・status 更新 | status poll(`source-doc-status.ts`)/ result page | **生**(2 列死 — §2) |
| upload_records | OCR 月次 quota 台帳 1 件(append-only) | 8 | `publish-prepared.ts:233` / markFailed 系 | `canRunOcr` の月次 SUM(`ai-usage-mcq.ts:55-63`。**pagesProcessed + status + createdAt のみ**) | **生**(3 列 W-only — §2) |
| user_settings | 1 user の設定 | 6 | settings 3 action | settings page / study smart・custom page | **生** |
| contact_messages | 問い合わせ 1 件 | 8 | `submitContact`(`lib/actions/contact.ts:86`) | **なし**(SELECT ゼロ・管理 UI なし。status 更新経路もなし) | **W-only(受信箱・OT が外部で読む想定)**。schema.ts:527「DB INSERT 実装は Sprint A-3+」は**実装済で stale** |
| entity_mutations(server) | 適用済み mutation 1 件(冪等 dedupe ログ) | 10 | bulk route の log INSERT(:155-167) | **mutationId の存在チェックのみ**(:126-127)。entityType/entityId/op/patch/editedAt/appliedAt は書くだけ(forensic) | **準 W-only**(dedupe キー 1 列だけ生) |
| tag_categories | タグカテゴリ 1 件 | 8 | tag-crud → registry apply(`apply-tag-mutation.ts`) | pull → tags UI(name/color/sort_key/select_type すべて表示・並びに使用) | **生** |
| tag_options | タグ選択肢 1 件 | 8 | 同上 | 同上 + `tag_options_category_name_uq` が重複拒否 | **生** |
| card_tags | card↔option の junction 1 本 | 4 | `handleTagOptionIds` / `applyOcrTags` | pull → card 表示・filter(`join-card-tags` / `get-custom-session-cards`) | **生** |
| tombstones | 削除伝播シグナル 1 件 | 6 | delete-exam / card delete / tag delete(registry) | `tombstones-pull` → `/api/pull` → client bulkDelete | **生** |
| assets | R2 画像バイトの台帳 1 件 | 13 | reserve/finalize(`upload.ts`)/ crop(`crop-and-store.ts`)/ GC lanes(`asset-gc.ts`) | resolve(`get-asset.ts`)/ GC mark・promote・collect / dedup lookup(user_id+hash) | **生**(1 列死 — §2) |
| card_asset_refs | 画像参照 1 本(GC 権威) | 5 | `handleImages`(単一点・schema.ts:857)/ crop | GC の参照ゼロ判定 / resolve | **生** |
| upload_operations | 冪等 upload/OCR 操作の状態機械 1 件 | 17 | submit-upload / pipeline(fenced CAS)/ publish | live-op gate / status poll / result summary(`result-summary-view.ts`)/ 冪等 replay(`submit-upload.ts:445`) | **生** |
| asset_derivations | crop の provenance 1 件(assets 1:1) | 10 | `crop-and-store.ts:238` INSERT | **なし** | **W-only(意図宣言あり)**: schema.ts:956-959「将来 GC 後も追跡可能に残す 1:1 台帳」 |

W-only 4 表のうち**書き続ける理由が doc に無いのは `ai_usage_users` のみ**(integration_failures / asset_derivations は schema comment に意図明記、contact_messages は受信箱として成立)。

---

## 2. 死列・到達不能値の全量(復習ドメイン外)

### 2.1 どこからも読まれない列

| 表.列 | 書き手 | 根拠 |
|---|---|---|
| `exams.card_count` | `bumpExamCardCount`(card create/delete/OCR と同 tx・負ガード付き) | 読み手 = `exams-pull.ts:19`(client へ運ぶ)のみで、**client は「exams.card_count を使わず cards mirror から動的集計」と明言**(`exam-list-live.tsx:9`)。server 側 SELECT ゼロ(`lib/exams/list.ts` に cardCount 出現なし)。= 誰も読まない非正規化キャッシュを bump し続けている |
| `source_documents.mode` | submit-upload INSERT(:581) | 読み手ゼロ。用途だった discard 判定(schema.ts:389-394「discard 時に server 側 DB から判定する真実 source」)は **旧経路撤去(②-4a S-5)で discard action ごと消滅**(`upload/_actions/` に discard 系ファイルなし) |
| `source_documents.ocr_cost_yen` | `upload-persistence.ts` / markFailed(0 埋め) | SELECT ゼロ。コスト集計はどこにも実装されていない |
| `upload_records.ocr_cost_yen` | `publish-prepared.ts:233` | 同上(quota SUM は pagesProcessed のみ・`ai-usage-mcq.ts:55`) |
| `upload_records.filename` / `file_size_bytes` | 同上 | SELECT ゼロ(quota SUM に不参加)。source_documents から複写しただけ |
| `assets.reference_count` | default 0 のみ(書き手も実質なし) | 読み書きゼロ。**同時に dormant 宣言された `unreferenced_at` は GC v2 の中核に昇格済**(`asset-state.ts` / `asset-gc.ts`)なので、schema.ts:819-820・843 の「reference_count / unreferenced_at は dormant」コメントは**半分 stale** |
| `integration_failures.retry_count` / `next_retry_at` / `resolved_at` / `resolution_note` | default / なし | dormant 宣言どおり(schema.ts:222-224)。読み書きゼロ |
| `contact_messages.status` | default `'open'` のみ(明示指定しない・`contact.ts:95`) | 読み手ゼロ・更新経路ゼロ |
| `stripe_events.type` / `clerk_events.type` | webhook route insert | 読み手ゼロ(dedupe は eventId のみ。forensic) |
| `entity_mutations.entity_type/entity_id/op/patch/edited_at/applied_at/created_at`(server) | log INSERT | 読み手ゼロ(dedupe は mutationId+userId のみ・route.ts:126-133) |
| `exams.question_no_format` | **書き手ゼロ** | 読み手 = pull mapper(`exams-pull.ts:17`)→ client mirror に格納 → **client 読み手もゼロ**(`client-db.ts:45` の型定義のみ)。両側完全死 |

### 2.2 書き手すら無い列・到達不能な状態

| 対象 | 内容 | 根拠 |
|---|---|---|
| `exams.archived_at` | **書き手ゼロ**(`update(exams)` は card-count のみ、archive を set する箇所なし)。「ダウングレード時の自動アーカイブ」(schema.ts:251-252)は未実装 | 一方で読み手は多数: 一覧 filter(`list.ts:42` isNull)/ client filter(`exam-list-live.tsx:32`)/ upload gate(`submit-upload.ts:553` archived なら reject)/ 詳細 UI「(アーカイブ済)」表示(`exam-detail-view.tsx:205`)。**全読み手が常に NULL を読む = archived 分岐は全部 dead code** |
| `contact_messages.status` の `'in_progress'` / `'resolved'` | UPDATE 経路なし・到達不能 | §2.1 と同根 |
| `upload_operations.source_document_id` の NULL | 「旧経路が生成時点で未確定だった名残で nullable(単一 invocation 経路は sync tx で必ず確定させる)」(schema.ts:890-891)と**名残を自認** | 現経路では INSERT 時に必ず確定(`submit-upload.ts:577-601` 同 tx)。NOT NULL 化可能な nullable |
| `assets.status` の `'deleted'` | 到達**可能**(GC collect の中間マーカー・`asset-gc.ts:124`)— 死ではない(誤解しやすいので明記) | — |

### 2.3 default が実質未使用の列(常に明示値で上書き)

- `source_documents.status` default `'processing'` — INSERT が明示指定(`submit-upload.ts:585`)。
- `source_documents.pages_processed` default 0 / `cards_extracted` default 0 — 完了時に明示更新、INSERT 時 default 使用は正当(こちらは生)。
- `upload_operations.status` default `'processing'` — INSERT 明示。default は「union に無い値を書かないための防御」(schema.ts:919-921)と理由記載あり。
- 逆に default が仕事をしている例: `contact_messages.status`(明示指定しない設計・contact.ts:17)、cards の FSRS 列(server create は default 依存・第 2 弾 §2.4)。

---

## 3. 重複・非正規化の全量

### 3.1 同じ意味の値を複数表に持つ列

| 値 | 保持箇所 | 同期機構 / 壊れる経路 |
|---|---|---|
| exam の card 件数 | `exams.card_count` ⟷ cards 実行数 ⟷ client の動的集計(`exam-list-live`) | bump は同 tx(`card-count.ts`)だが**読み手が動的集計に移行済み**で整合の意味が消失。壊れても誰も気づかない(読まれないから) |
| card の画像参照 | `cards.images` jsonb 配列(wire/表示)⟷ `card_asset_refs`(GC 権威) | **意図的二重持ち**(schema.ts:855-857)。同期単一点 = `handleImages`。legacy 非 UUID entry は配列のみに存在(refs に入らない)と宣言済み。「書く経路を増やす時は refs 同期必須」が慣習規律 |
| OCR 実績(filename / file_size / pages / cost / status) | `source_documents` ⟷ `upload_records` | 台帳分離は設計判断(Bug A: discard で quota 返金・schema.ts:448-451)だが、quota に必要なのは pagesProcessed + status + createdAt のみ。**filename / file_size_bytes / ocr_cost_yen の複写は読み手なしのコピー** |
| OCR 結果サマリ | `source_documents.cards_extracted` 等 ⟷ `upload_operations.result_summary` jsonb | 両方書かれ、result page は operation 側(`result-summary-view.ts`)を読む。source_documents 側 cards_extracted の読み手は status poll 系。2 正本 |
| PDF ページ数 | `source_documents.pages_total` ⟷ `upload_operations.expected_source_count` | **同一 CAS で 2 表に書く**(`commitPdfCountCas`・schema.ts:408-410 / 934-939)。fenced CAS が同期機構(強い方) |
| AI 呼び出し数 | `ai_usage`(global)⟷ `ai_usage_users`(per-user) | 同 tx 二重 upsert(`ai-usage-counter.ts:28-43`)。per-user 側は読み手なし(§1) |
| 削除の記録 | `tombstones`(client 伝播正本)⟷ `entity_mutations` op='delete' の log ⟷ 退会 handler の明示 DELETE | 3 系統が別目的(伝播 / 冪等 / GDPR)で併存。tombstone だけが伝播に効く(architecture.md §2) |
| ユーザーのプラン状態 | `users.plan/subscription_status/...` ⟷ Stripe 側の真実 | webhook 同期(clear site 複数で順序非保証を吸収・architecture.md §7)。既知の設計 |

### 3.2 慣習(値の一致・暗黙対応)でしか保たれない表間関係

- `entity_mutations.entity_id` → cards / tag_categories / tag_options の PK(**FK なし**・registry が保証と宣言・schema.ts:656-657)
- `tombstones.entity_id` → 物理削除済み行(FK 原理的に不可・schema.ts:784)
- `assets.object_key` ⟷ R2 実体(DB 外。GC 2 レーン契約 = architecture.md §11)
- `cards.images[].key` ⟷ `assets.id`(`isAssetKey` 形式判定の慣習。refs 経由でのみ DB 保証)
- `study_sessions.card_ids` ⊇ `answer_events.card_id`(検証なし・第 2 弾 §2.9)
- `users.clerk_id` の「active 行では NOT NULL 相当」invariant(scrub のため nullable・handler が担保と宣言・schema.ts:73-75)

### 3.3 client / server の同概念別定義(第 2 弾 §2.8 以外)

| 概念 | server | client | 注記 |
|---|---|---|---|
| asset の状態語彙 | `reserved/ready/deleting/deleted`(`asset-state.ts:19`) | `uploading/ready/failed`(`client-db.ts:79`) | **意図的非対称**(saga 進行中状態は client のみ・spec §2.3 と宣言) |
| exam の card 件数 | card_count 列(bump) | cards mirror の `IDBIndex.count`(Y-2 T-B4) | 定義が分岐し server 側が取り残された(§3.1) |
| 「設定」 | user_settings 表(RSC 読み) | Dexie `user_settings` store = **死 store**(§7) | mirror 設計が中途 |

---

## 4. 制約の欠落

### 4.1 CHECK 制約

**25 表すべてに CHECK ゼロ**(snapshot の checkConstraints 全空)。TS `$type` / zod / アプリ層 invariant のみで守っている値域の全量:

- enum 系: `users.plan` / `subscription_status` / `billing_interval`、`exams.question_no_format`、`source_documents.status` / `file_type` / `mode`、`upload_records.status`、`contact_messages.status` / `category`、`tombstones.entity_type`、`entity_mutations.entity_type` / `op`、`tag_categories.select_type`、`assets.status` / `mime`、`upload_operations.status`(+ 復習ドメイン分は第 2 弾 §1.7)
- 非負・数値: 各 count 列 / `byte_size` / `width` / `height` / `pages_*` / `attempt_count` / `lease_version`
- 注: integration_failures(schema.ts:217-219)と assets(:817-818)は「CHECK を張らずアプリ層 catalog で enforce」を**意図として宣言**している。他の表は宣言なしの単なる欠落。

### 4.2 UNIQUE の欠落候補

| 箇所 | 現状 | 所見 |
|---|---|---|
| `assets (user_id, hash)` | 非 UNIQUE index のみ(dedup lookup 用・:848) | dedup はアプリ層 best-effort で**同 hash 複数行が併存しうる**。壊れはしないが「dedup」の保証は無い |
| `exams (user_id, name)` | 制約なし | 同名 exam 重複可。意図の記録なし(未確認) |
| `tag_categories (user_id, name)` | 制約なし | **意図的**(schema.ts:689「別 id で同名共存、OCR 流入で merge しない方針との整合」) |
| `reviews` の対応キー | なし | 第 2 弾 §6-2(復習ドメイン) |

### 4.3 FK cascade が意味論と食い違う疑い

| FK | 宣言 | 疑い |
|---|---|---|
| **全表の `user_id → users` CASCADE** | cascade | **構造的に一度も発火しない**。users は soft delete(物理 DELETE しない)ため、user_id CASCADE は全 20+ 表で dead 機構。実削除は Group I 明示 DELETE + 親 cascade(handle-clerk-event.ts:214-236 が自認: 「users.id への FK ON DELETE CASCADE は発火しない」)。宣言は「将来 users を物理削除に変えた時」のためだけに在る |
| `upload_operations.exam_id` CASCADE | 「1 exam に対する 1 回の upload 操作」(schema.ts:898) | 冪等 ledger が exam 削除で消え、同 idempotency_key の再送が新規扱いになる。exam 独立を選んだ upload_records と**台帳としての寿命設計が非対称**(exam 削除後の再送は exam_not_found になるため実害は薄い) |
| `answer_events` / `reviews` の card CASCADE | — | 第 2 弾 §6-3(履歴が card と共倒れ) |
| `contact_messages.user_id` CASCADE + 退会明示 DELETE | 「個人情報削除依頼対応のため hard delete」(schema.ts:527) | 意図的(サポート履歴より GDPR 優先)— 食い違いではない(記録として明記) |
| `card_asset_refs.asset_id` RESTRICT | 参照中 asset の誤削除拒否(:859-861) | 意味論と整合(正当)。対照的に `asset_derivations.asset_id` は CASCADE で、RESTRICT にした場合 exam cascade が FK 違反する実測記録あり(:961-965)— 判断の根拠が書かれている良例 |

### 4.4 NOT NULL / nullable の疑い

- `upload_operations.source_document_id`: NOT NULL 化可能(§2.2・名残と自認)。
- `users.email` / `clerk_id`: scrub のため nullable は意図(schema.ts:70-75)。
- `source_documents.pages_total`: CAS 窓のため nullable は意図(:408-410)。
- `study_sessions.exam_id` nullable: smart セッション(exam 横断)で正当。

---

## 5. index の過不足

### 5.1 使われていない疑い(対応する production query が見つからない)

| index | 根拠 |
|---|---|
| `answer_events_user_idx` / `card_idx` / `session_idx`(3 本) | 表自体に production SELECT ゼロ(§1・第 2 弾)。FK 削除(cards cascade)には card_idx が効くため cascade 用としてだけ生きる。session_idx は SET NULL 用(現行経路で不発) |
| `study_sessions_user_idx` / `exam_idx` | 表に SELECT ゼロ。exam_idx は SET NULL cascade 用のみ |
| `entity_mutations_entity_idx (entity_type, entity_id, edited_at)` | dedupe は mutationId UNIQUE(+userId)のみ使用(route.ts:126-133)。schema.ts:257-259 の client 側コメントが言う「entity-scoped coalesce」は **Dexie 側 index の話**で server 表のこの index に対応 query なし |
| `cards_answered_idx (user_id, exam_id, answered)` | answered を WHERE する server query 未発見(回答状態フィルタは client/Dexie 側・`card-filter-predicates.ts`)。**未確認**(全 query の網羅走査はしていない) |
| `source_docs_user_exam_idx` | **schema comment 自身が冗長を自認**(:436-437「user_exam_created の prefix で冗長 — follow-up で要検討」) |
| `reviews_card_idx (card_id, reviewed_at)` | reviews の唯一の読み query(distinct 集計)は user_id + 日付式で card_idx 不使用。cards cascade 削除にだけ効く |
| `card_tags_user_idx` | 対応 query = 退会 handler …だが card_tags は Group II(明示 DELETE しない)。将来 reset 用と client-db 側コメントにあるのみ |

### 5.2 欠けている疑い

| query | 現状 |
|---|---|
| `upsertStudyDays` の distinct 集計: `WHERE user_id AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date IN (...)`(`session-repository.ts:221-228`) | `(user_id, reviewed_at)` index は**式条件に 2 列目が効かない**(user_id prefix のみ)。式 index なし。行数増で per-flush の集計が劣化する形。実行計画は未確認 |
| `getExamsForUser`: `WHERE user_id AND archived_at IS NULL ORDER BY updated_at DESC`(`list.ts:42-43`) | `exams_user_id_idx` で足りる規模(user あたり exam 数十)。問題なし |
| 月次 quota SUM(`ai-usage-mcq.ts`) | `upload_records_user_created_idx (user_id, created_at)` が range に効く。status filter は後段。問題なし |

---

## 6. FK 連鎖・寿命の全体図

### 6.1 削除連鎖(全表版)

```
user 削除(退会 webhook・users は soft delete):
  【重要】user_id CASCADE は全表で不発(users 行を物理削除しないため)
  明示 DELETE(Group I): exams / study_days / contact_messages / ai_usage_users /
    upload_records / user_settings / study_sessions / tombstones /
    entity_mutations / tag_categories + assets は status='deleting' へ UPDATE(唯一の例外)
  親 cascade(Group II): exams → cards / source_documents / upload_operations
    cards → answer_events / reviews / card_tags / card_asset_refs
    tag_categories → tag_options → card_tags
  users 行: PII scrub(email/clerk_id NULL)+ deleted_at。stripe id 群は保持
  残置: stripe_events / clerk_events(user 非紐付け)/ integration_failures(FK なし・意図)
  網羅性: route invariant test が「Group I 集合 = handler 明示 DELETE 集合」を pin

exam 削除(delete-exam action):
  exams ─CASCADE→ cards(→ answer_events / reviews / card_tags / card_asset_refs)
        ─CASCADE→ source_documents(→ cards.source_document_id は先に card ごと消滅)
        ─CASCADE→ upload_operations(冪等 ledger 消滅・§4.3)
  study_sessions.exam_id ─SET NULL(行残置)
  assets: 行は残る(参照ゼロ化 → GC lane が mark→promote→collect)
  tombstones: exam + 配下 card 各々に明示 INSERT(client 伝播)
  upload_records: 影響なし(exam 独立・意図)

card 削除: cards → answer_events / reviews / card_tags / card_asset_refs CASCADE
tag_category 削除: → tag_options CASCADE → card_tags CASCADE(+ tombstones INSERT)
asset 削除: card_asset_refs.asset_id RESTRICT が参照中削除を拒否 /
  asset_derivations CASCADE(1:1 provenance 同時消滅)
source_document 単独削除: 経路なし(exam cascade でのみ消える)
```

### 6.2 退会 scrub の PII 残置疑い

| 対象 | 現状 | 記録の有無 |
|---|---|---|
| `integration_failures`(clerkId / stripeCustomerId / context / errorMessage) | 残置 | **documented**(architecture.md「残余リスク」・公開前判断) |
| `contact_messages` の**匿名行**(user_id NULL・email あり) | 退会 DELETE は `WHERE user_id` のため**匿名行は対象外・無期限残置** | 記録**なし**(残余リスク一覧に匿名行への言及なし — 追加候補) |
| `users.stripe_customer_id` / subscription 系 | 保持 | documented(correlation key・schema.ts:14-16) |
| `upload_records.filename` | 退会で DELETE(Group I)— 生存中のみ | 問題なし(ただし filename 自体が読み手なし・§2.1) |
| Dexie(端末側)全 store | 退会で何も消えない | 第 2 弾 §5.1。全表に拡大しても同じ |

### 6.3 保持方針が未決の表(復習ドメイン外)

- `stripe_events` / `clerk_events`: 無期限蓄積・掃除なし・退会でも残る(event id + type のみで PII なし)。
- `integration_failures`: 意図的残置(公開前判断 pending)。
- `contact_messages` 匿名行: §6.2。
- `entity_mutations`(server): 退会 DELETE はあるが生存中は無期限(1 編集 = 1 行)。
- `ai_usage` / `ai_usage_users`: 日次行が無期限(行数小・実害薄いが方針なし)。
- `asset_derivations`: assets と 1:1 で GC に追随(assets 側の方針に従属)— 未決ではない。

---

## 7. Dexie(client)側の全 store 棚卸し

`lib/client-db.ts`(v8)の全 **13 store**:

| store | server 対応 | 同期方向 | 掃除経路 |
|---|---|---|---|
| exams | exams | pull(6 stream) | tombstone bulkDelete |
| cards | cards | pull + pullBack | tombstone bulkDelete |
| **user_settings** | user_settings | **なし(pull writer 不在)** | — |
| study_sessions | study_sessions | push のみ | **なし(無期限)** |
| answer_events | answer_events | push のみ | **なし(無期限・synced/failed とも)** |
| entity_mutations | entity_mutations(server は適用ログ = 別意味) | push のみ | **なし(synced 行無期限。30d 超 pending の failed 隔離はあるが削除はしない)** |
| sync_meta | **対応なし(client-only cursor)** | — | なし(キー数固定・有界) |
| study_days | study_days | 専用 pull(90 日 full-window) | `clear()` + bulkPut(有界) |
| tag_categories | tag_categories | pull | tombstone |
| tag_options | tag_options | pull | tombstone + client cascade purge |
| card_tags | card_tags | pull | pull 時の changed-card purge + tombstone cascade |
| media_assets | assets(状態語彙非対称・§3.3) | 独自 saga | sweep(stale uploading/failed 削除)+ blob reclaim |
| media_download_jobs | **対応なし(client-only 進捗)** | — | sweep + 完了時 delete |

- **死 store**: `user_settings` — 書き手・読み手とも**ゼロ**(grep `\.user_settings\.` production 0 件)。`client-db.ts:135-137` が「pull writer 不在で現状未使用」と自認。設定は RSC server 読み(Q-5)。
- **server に対応物の無い store**: sync_meta / media_download_jobs(どちらも client-only として意図的)。
- **client に対応物の無い server 表**: reviews / tombstones(信号であって mirror 不要)/ ai_usage 系 / stripe_events / clerk_events / integration_failures / source_documents / upload_records / upload_operations / asset_derivations / contact_messages / users(auth は Clerk・課金表示は RSC)。
- **無期限蓄積 3 store**: study_sessions / answer_events / entity_mutations(synced 行)。

---

## 8. 歪み候補の総括(復習ドメイン外・重い順)

1. **全表の user_id CASCADE が構造的に不発**(users soft delete)。削除の実機構は handler 明示 DELETE + 親 cascade + invariant test で、FK 宣言は読み手を誤解させる dead 機構。handler コメントは自認しているが schema 冒頭(:3-7)は「FKs use CASCADE for user-owned data hierarchy … users 完全削除で全関連データを連動削除するため」と**発火する前提の説明のまま**(stale)。
2. **exams.archived_at: 書き手なしの状態を読み手多数が防御し続ける**。一覧 filter / upload gate / UI 表示 / client filter 全部が常に NULL を読む dead 分岐(§2.2)。「ダウングレード自動アーカイブ」は宣言のみ。
3. **exams.card_count: 読み手が消滅した非正規化キャッシュを bump し続けている**。client は動的集計に移行済みと明言(`exam-list-live.tsx:9`)、server 読み手ゼロ。負ガード付き bump ロジック + pull 帯域が純コスト(§2.1)。
4. **W-only 表 4 + 準 W-only 1**(ai_usage_users / integration_failures / asset_derivations / contact_messages / entity_mutations server)。うち **ai_usage_users だけは書き続ける理由の記録が無い**(§1)。integration_failures / asset_derivations は意図宣言あり。
5. **schema comment の stale 群**: 冒頭「26 tables」(実 25)/ 冒頭の user cascade 説明(→ 1)/ assets「reference_count / unreferenced_at は dormant」(後者は GC 中核に昇格済・§2.1)/ contact_messages「DB INSERT 実装は Sprint A-3+」(実装済)。**comment を信じると現物を誤読する**状態。
6. **source_documents.mode の用途消滅**(discard 経路撤去・§2.1)+ ocr_cost_yen が source_documents / upload_records の両方で write-only。コスト追跡は「書いてはいるが見る手段がない」。
7. **CHECK 全面ゼロ(25 表)**。意図宣言があるのは integration_failures / assets の 2 表のみで、残りは単なる欠落(§4.1)。users.plan / subscription_status のような課金判定列も DB 無防備。
8. **upload_records と source_documents の列複写**(filename / file_size_bytes / ocr_cost_yen — 読み手なしの 3 列を台帳分離時にコピーした・§3.1)。
9. **assets (user_id, hash) 非 UNIQUE**: 「dedup lookup」は保証なし(同 hash 複数行併存可・§4.2)。
10. **未使用 index 群**: answer_events 3 本 / study_sessions 2 本 / entity_mutations_entity_idx / reviews_card_idx / cards_answered_idx(未確認 1 点含む)/ source_docs_user_exam_idx(冗長自認)(§5.1)。
11. **Dexie user_settings 死 store** + settings が mirror 設計から外れた server-only 読み(中途な非対称・§7)。
12. **upload_operations.exam_id CASCADE による冪等 ledger の消滅**(upload_records の exam 独立方針と非対称・§4.3)。
13. **contact_messages 匿名行の PII(email)が残余リスク一覧に未記載**(§6.2)。
14. **stripe_events / clerk_events の無期限蓄積**(保持方針なし・実害は薄い・§6.3)。
15. **upload_operations.source_document_id の名残 nullable**(NOT NULL 化可能と自認・§2.2)。

---

## 9. 機械的一覧表(統廃合・削除・制約追加の候補)

判定基準 = 現物の読み手の有無。**採否は OT 判断**(本表は候補の列挙のみ)。「要検討」= 読み手はないが意図宣言 or 外部読者(OT/将来)が明記されているもの。

### 9.1 表の統廃合候補

| 表 | 種別 | 根拠 |
|---|---|---|
| ai_usage_users | **削除候補**(または読み手を作る) | 読み手ゼロ・理由の記録なし(§1)。global の ai_usage で daily gate は成立 |
| answer_events / reviews | **統合候補**(復習ドメイン再設計の本丸) | 第 2 弾 §6-1(1 event の情報が 2 表分割・どちらも不完全) |
| study_sessions | **要検討**(車輪の再定義 or 削除) | server 読み手ゼロ・completed 不達・abandoned 到達不能(第 2 弾 §3.2)。client flush の transport 単位としてだけ機能 |
| asset_derivations | 維持(意図宣言あり) | schema.ts:956-959。ただし「読む日」が来るまで W-only |
| integration_failures | 維持(意図宣言あり・OT 読者) | schema.ts:215 |
| Dexie user_settings store | **削除候補** | 書き手・読み手ゼロ(§7) |

### 9.2 列の削除候補

| 表.列 | 種別 | 根拠 |
|---|---|---|
| exams.question_no_format | 削除候補(両側死) | §2.1 |
| exams.archived_at | 削除候補 or 書き手実装(どちらかに倒す) | §2.2(現状は dead 分岐の維持コストのみ) |
| exams.card_count | 削除候補(bump ロジックごと) | §2.1 |
| source_documents.mode | 削除候補 | §2.1(用途消滅) |
| source_documents.ocr_cost_yen / upload_records.ocr_cost_yen | 削除候補 or 集計読み手を作る | §2.1 |
| upload_records.filename / file_size_bytes | 削除候補 | §2.1 |
| assets.reference_count | 削除候補 | §2.1(unreferenced_at と違い昇格しなかった側) |
| integration_failures.retry_count / next_retry_at / resolved_at / resolution_note | 削除候補(dormant 宣言 4 列) | §2.1 |
| contact_messages.status | 削除候補 or 運用 UI 実装 | §2.1 |
| stripe_events.type / clerk_events.type | 要検討(forensic として軽い) | §2.1 |
| entity_mutations の forensic 列(op/patch/edited_at/applied_at 等) | 要検討(dedupe に必要なのは mutation_id + user_id のみ) | §1 |
| study_sessions.query / answer_events.elapsed_ms / answer_events.sync_status ほか | 復習ドメイン分は第 2 弾 §6-5 | — |
| upload_operations.source_document_id の nullable | NOT NULL 化候補 | §2.2 |

### 9.3 制約追加候補

| 対象 | 種別 | 根拠 |
|---|---|---|
| enum 系全列(§4.1 の列挙) | CHECK 追加 | 全表 CHECK ゼロ。特に users.plan / subscription_status(課金判定)と assets.status / upload_operations.status(状態機械)が優先度高 |
| count / size / pages 系 | CHECK(>= 0) | §4.1 |
| reviews.rating / cards.state | CHECK(1-4 / 0-3) | 第 2 弾 §6-11 |
| assets (user_id, hash) | UNIQUE 化の要否判断 | §4.2(dedup の保証を DB に持たせるか) |
| exams (user_id, name) | UNIQUE の要否判断(意図未記録) | §4.2 |
| reviews.reviewed_at の defaultNow() | default 撤去候補 | 第 2 弾 §6-13(罠) |
| 未使用 index 群(§5.1) | DROP 候補 | 対応 query なし |
| distinct 集計の式 index | 追加の要否判断 | §5.2(実行計画未確認のまま先走らない) |
| schema.ts stale comment 群(§8-5) | 修正候補(schema 変更と同時に) | comment が現物を誤説明 |

### 9.4 追記(2026-08-12)— Sprint B「DB 全体掃除」での採否結果

本節は**後日追記**。上の §9.1〜9.3 は 2026-08-11 時点の候補列挙のまま**書き換えていない**(調査時点の snapshot として保存する)。OT 裁定と実装の結果は下表で読む。

- 設計の正 = `docs/superpowers/specs/2026-08-12-sprint-b-db-cleanup-design.md`(凍結)
- 実施記録 = `docs/superpowers/sessions/2026-08-12-sprint-b-db-cleanup.md`
- DDL の現物 = `drizzle/migrations/0036_sprint_b_db_cleanup.sql`(**未適用**。適用手順 = `docs/ops/sprint-b-db-cleanup-runbook.md`)

#### 9.1(表の統廃合候補)

| 候補 | 結果 |
|---|---|
| ai_usage_users | **維持**。削除しない — 読み手は app でなく**運用者**(濫用 user の特定・ban 判断で OT が SQL を引く)。「読み手ゼロ」は app 内の話で死表を意味しない。意図を schema comment に明記して解消 |
| answer_events / reviews 統合 | **Sprint A(2026-08-11)で解消済**(`reviews` は表ごと廃止) |
| study_sessions | **Sprint A で表ごと廃止** |
| asset_derivations / integration_failures | 維持(既存の意図宣言を再掲のみ) |
| Dexie `user_settings` store | **削除**(Dexie v11 で drop) |

#### 9.2(列の削除候補)

| 候補 | 結果 |
|---|---|
| exams.question_no_format / archived_at / card_count | **3 列とも削除**(0036)。`archived_at` は読み手(一覧 filter / upload gate / UI / client filter)ごと撤去 — **upload 受付 gate が消えることを受容**(architecture.md §7 に記録) |
| source_documents.mode | **削除**(0036) |
| source_documents.ocr_cost_yen / upload_records.ocr_cost_yen | **削除**(0036)。ただし `costYen` の計算チェーン(`cost.ts` / `ocr.ts`)は**残す** — upload エラー詳細表示という生きた読者があるため。消したのは DB 列と台帳 insert 値、およびそれで不要化した引数まで |
| upload_records.filename / file_size_bytes | **削除**(0036) |
| assets.reference_count | **削除**(0036)。`unreferenced_at` は GC v2 の中核に昇格済で対象外 |
| integration_failures の dormant 4 列 | **削除**(0036) |
| contact_messages.status | **維持**。将来の管理 UI の状態列(それまで OT が SQL で更新)という意図を schema comment に明記。加えて **CHECK を追加**(open / in_progress / resolved) |
| stripe_events.type / clerk_events.type | **維持**(forensic の意図を再掲) |
| entity_mutations の forensic 列 | **維持** |
| upload_operations.source_document_id の nullable | **NOT NULL 化**(0036)。併せて FK を `SET NULL` → `CASCADE` に張替(両立しないため。architecture.md §2 に不変条件を記録) |

#### 9.3(制約追加候補)

| 候補 | 結果 |
|---|---|
| enum 系 / count・size・pages 系 | **CHECK 27 本を追加**(0036 = enum 13 + 非負 12 + 正数 2)。基準は spec §5.2(enum = 課金判定・状態機械・sync/冪等の分岐に使う文字列列 / 非負 = server 自身が計算して書く課金・quota・台帳・統計系)。**相関制約**(`correct_count <= review_count` / `pages_processed <= pages_total`)は**張らない** — 前者は同一 SQL からの絶対値再集計で冗長、後者は PDF count phase の途中状態で一時的に不等が成立しうるため |
| reviews.rating / cards.state | **Sprint A で解決済**(`cards_state_range` + answer_events 3 本。改名しない) |
| 未使用 index 群 | **3 本削除**(`entity_mutations_entity_idx` / `source_docs_user_exam_idx` / `cards_answered_idx`)。残りは Sprint A で**表ごと消滅**済。`source_docs_user_exam_idx` は `source_docs_user_exam_created_idx` の厳密 prefix という削除根拠を、**実データ EXPLAIN で適用後に確認する**(runbook §4 — 小さい fixture では planner が seq scan を選ぶため自動テストに入れられない) |
| assets (user_id, hash) UNIQUE / exams (user_id, name) UNIQUE / distinct 集計の式 index | **非スコープ**(spec §7)。前者のトリガー = image dedup の実機能化(同 hash の正当な複数 asset を弾く恐れ)。残り 2 件は裁定一覧に無く現状維持 |
| reviews.reviewed_at の defaultNow() | **Sprint A で表ごと廃止** |
| schema.ts stale comment 群 | **解消**(冒頭の user cascade 説明 / assets dormant / contact_messages 実装状況 / source_document_id の nullable 名残 / card_count 非正規化説明) |

#### §8 の歪みのうち本 sprint で解消しなかったもの

**残るのは #12 / #13 / #14 の 3 件**(spec §6 の対応表と一致)。いずれも**意図的な非スコープ**であって、見落としではない。

| # | 歪み | なぜ残すか |
|---|---|---|
| **#12** | `upload_operations.exam_id` CASCADE で冪等 ledger が消滅する | OT 裁定一覧に無い。exam 削除後に同一 idempotency_key で再送が来ても `exam_not_found` に落ちるため実害が薄い。**なお 0036 で `source_document_id` 側にも CASCADE が増えた**(上記 9.2)ので、ledger の消滅経路は 1 本増えている — この 2 つは同じ判断の下にある |
| **#13** | 匿名 contact_messages の PII(email) | **既に記録済み — 追記しない**。`docs/architecture.md` §4「GDPR 削除契約」に決定行(**匿名 contact_messages(user_id null)は退会 scrub の対象外**・決定 2026-07-22 / 明文化 2026-07-26・理由込み)があり、末尾の「残余リスク(公開前 PII 判断)」にも contact_messages の項が載っている。**§8-13 の「残余リスク一覧に未記載」という記述は現況と食い違う**(2026-08-12 に architecture.md を現物確認)。重複エントリは作らない |
| **#14** | stripe_events / clerk_events の無期限蓄積 | 保持方針が未決・実害が薄い。retention の実制御は spec §7 で非スコープ確定 |

---

## 付記: 三部作の関係

- 第 1 弾: 復習 flush の並走・24h・real 精度・順序ガード(動的挙動)
- 第 2 弾: 復習ドメイン 5 表の構造(静的全量)
- 本 doc(第 3 弾): 残り 20 表 + Dexie 13 store の全量。再設計 sprint の scope 判断(復習ドメインだけ直すか、§9 の一掃を同時にやるか)の材料。
