# Sprint B — DB 全体掃除 設計 spec(r2)

- 状態: **ドラフト(Codex cross-check 反映済み・OT 承認待ち)**。承認後 writing-plans へ。
- Codex cross-check: `docs/codex/2026-08-12-plan-sprint-b-db-cleanup-spec.md`(1 パス)。r1→r2 の変更は「(Codex #n)」で帰属表示。**r1 は裁定で確定済みの 2 列を CHECK 対象から除外提案しており、これは「採否の再検討は不要」という前提への逸脱だった**(Codex 指摘 1)。r2 で撤回し、裁定どおり対象に含めたうえで既存宣言との整合機構を設計する。
- 入力: `docs/audit/2026-08-11-db-schema-full-inventory.md`(第 3 弾)§9 + OT 裁定(採否は確定済み。本 spec は**実現形の設計のみ**を扱い、採否を再検討しない)。
- 前提: ユーザー 0・破壊的変更自由・互換レイヤー不要。Sprint A(migration 0034/0035)適用済みの現状が起点。
- **Step 0(現物確認)実施済み** — 結果は §1。CLAUDE.md「調査規律」の 3 行に従い、削除対象の「読み手ゼロ」主張を file:symbol で再検証した。第 3 弾との乖離は §1.9 に明記。

## 0. 目的

第 3 弾 §8 が列挙した歪み 15 件のうち、OT 裁定で「掃除する」と決まった分を一掃する。**死列・死 store・死 index を消し、生きている W-only 表には意図を schema comment として刻み、壊れたら課金・冪等性が狂う列に CHECK を張る**。加えて Sprint A の follow-up 2 件(400 分岐の到達不能 / entity_mutations の owner-scope)を引き取る。

---

## 1. Step 0 の結果(現物確認・第 3 弾の再検証)

**確認方法**: `rg` で production コード(`lib/` `app/` `scripts/`、`*.test.*` 除外)の参照を列挙し、schema 定義・型宣言・mapper の通過だけの箇所と、実際に値を読む箇所を区別した。

| # | 対象 | 主張 | 再確認の結果 | 根拠(file:line) |
|---|---|---|---|---|
| 1.1 | Dexie `user_settings` store | 書き手・読み手ゼロ | **確認** | `lib/client-db.ts:241,268` に宣言のみ。`.user_settings` の production 参照 **0 件** |
| 1.2 | `exams.question_no_format` | 両側完全死 | **確認** | 書き手ゼロ。読み手は `lib/db/exams-pull.ts:17` が client へ運ぶのみ、client は `lib/client-db.ts:44` の型宣言だけ |
| 1.3 | `exams.card_count` | server 読み手ゼロ | **確認**(下記の紛らわしい一致を排除) | 書き手 = `lib/cards/card-count.ts:34`(`bumpExamCardCount`)/ 呼出 = `apply-card-mutation.ts:116,172` / seed `seed-perf-exam.ts:651`。**`lib/sync/pull.ts:73,83,293` の `cardCount` は `PullDeltaResult` の統計(`cards.length`)で本列と無関係**。client は `exam-list-live.tsx:9,47` が「`exams.card_count` を使わず cards mirror から動的集計」と明記のうえ `db.cards.where('[user_id+exam_id]').count()` を使用 |
| 1.4 | `exams.archived_at` | 書き手ゼロ・読み手多数の dead 分岐 | **確認** | `update(exams)` の set 節は repo 全体で 2 箇所のみ(`card-count.ts:35-38` = cardCount+updatedAt / `seed-perf-exam.ts:650-653` = 同)で **archivedAt を書く経路は皆無**。読み手 = `lib/exams/list.ts:42`(`isNull` filter)/ `submit-upload.ts:546,553`(archived なら reject)/ `exam-detail-view.tsx:205`(UI 表示)/ `exam-list-live.tsx:32`(client filter)/ `exams-pull.ts:18` |
| 1.5 | `source_documents.mode` | 用途消滅 | **確認** | 書き手 = `submit-upload.ts:581` のみ。読み手 **0 件** |
| 1.6 | `ocr_cost_yen`(2 表) | write-only | **確認** | 書き手 = `upload-persistence.ts:85,105` / `publish-prepared.ts:239`(null)/ `source-doc-status.ts:358`(0)。**SELECT する箇所ゼロ** |
| 1.7 | `upload_records.filename` / `file_size_bytes` | 読み手なしコピー | **確認** | 書き手 = `source-doc-status.ts:355-356` / publish 経路。月次 quota は `lib/ai-usage-mcq.ts:55-63` が `pagesProcessed` + `status` + `createdAt` のみを使う |
| 1.8 | `assets.reference_count` / `integration_failures` dormant 4 列 | dormant | **確認** | schema 定義以外の参照 **0 件** |
| 1.9 | `cards_answered_idx`(第 3 弾 §5.1 の**未確認 1 点**) | 対応 query 不在の疑い | **確認 = 対応 query なし** | `cards.answered` を WHERE する server query は存在しない。ヒットは全て列の select/代入(`session-repository.ts:50,262` / `cards-mapper.ts:30,68` / `ingest-review-events.ts:127`)。回答状態フィルタは client 側 Dexie(`card-filter-predicates.ts`)で、この index を使わない。→ **削除可**(第 3 弾の「未確認」を解消) |

### 1.10 第 3 弾との乖離・追加で判明したこと

- **`upload_operations.source_document_id` の NOT NULL 化には null 分岐の撤去が伴う**。現物に null を明示的に扱う分岐が 3 箇所ある: `terminalize-abandoned-operation.ts:62,65`(`if (sourceDocumentId === null) return`)/ `publish-prepared-plan.ts:214,241`(型が `string | null`)/ `publish-prepared.ts:131`(`if (sourceDocumentId === null)`)。列を NOT NULL にすると**これらは到達不能な dead branch になる**ため、列変更と同 commit で撤去する(残すと「起きえない分岐の握り」= 簡潔性規律違反)。
- **`upload_records.filename` / `file_size_bytes` は「書かれていない列」ではなく「書かれるが読まれない列」**。削除は列だけでなく **書込側 3 経路の値組み立ても削る**(第 3 弾は「複写」とだけ書いていた)。
- 第 3 弾 §5.1 が挙げた未使用 index のうち **`answer_events` 3 本 と `reviews_card_idx` は Sprint A の 0035 で表ごと消滅済み**(本 sprint の対象外)。残る対象は `entity_mutations_entity_idx` / `source_docs_user_exam_idx` / `cards_answered_idx` の **3 本**。

---

## 2. 冒頭タスク — `classifyBulkError` の 400 分岐を到達可能にする

**現状**(`lib/retry/classify-bulk-error.ts:57-86`): `permanent-4xx` を返すのは `ZodError` のときだけで、`TRANSIENT_PG_CODES` / `TRANSIENT_POSTGRESJS_CONN_CODES` に無い SQLSTATE は**すべて末尾の `return 'transient'` に落ちる**。結果、CHECK 違反(23514)・不正テキスト表現(22P02)・構文エラー(42601)といった**コード欠陥由来の永続エラーが 503 になり、client が無限に再送する**。Sprint A spec §2.1(r4)が「permanent-4xx → 400」と書いた分岐は現状**到達不能**。

**変更**: `PERMANENT_PG_CODES` を新設し、classifyChain の PG code 判定に **transient 判定より先**に置く。

**分類の軸(Codex 指摘 4・独立 8 — r1 から縮小)**: 「永続的」と「client 4xx」は**別軸**である。400 は「送った payload がこの schema では受理できない」の意味に限る。r1 は 42xxx(syntax / undefined table・column・function)まで 400 に入れていたが、これは**server の deploy 欠陥を client の責任として扱う**誤りだった。42xxx は deploy を直せば同じ payload が通るため **retry が正しい挙動**であり、transient のまま残す。

- **`permanent-4xx`(= 400)に入れるのは payload 由来のデータ形不正のみ**:
  - `23514` check_violation / `23502` not_null_violation
  - `22P02` invalid_text_representation / `22001` string_data_right_truncation / `22003` numeric_value_out_of_range
- **transient のまま残す(意図的)**: `42601` / `42703` / `42P01` / `42883`(server 欠陥 — 修正 deploy で自然回復)/ `23503` foreign_key_violation・`23505` unique_violation(**順序競合や並走で起こりうる**ため、保守的に retry 側へ倒す)/ `40001` / `40P01`(既存)。
- **default は `transient` のまま**(未知 DB error で silent lost write を作らない、という既存の裁定を維持)。

**client 側の帰結を明示**(Codex 独立 8): 現行実装では **400 は当該 chunk を中断し、event は `pending` のまま残る**(`failed[]` による terminal 化は 200 応答のときだけ)。したがって 400 化しても**書込を放棄しない** — Sprint A spec §3 の「残る pending は transient のみ」の例外として、既知の Minor(共有 schema を通ったのに 400 = client/server 不一致バグ)に該当する。この不変条件を route test で pin する。

**波及**: この helper は review-events と entity-mutations の両 bulk route が共有する。**両 route の 400 分岐が同時に到達可能になる**ため、両方の route test に pin を追加する: (a) データ形不正 PG code → 400 (b) 42xxx → 503 (c) 未知 code → 503 (d) `cause` chain の奥に PG code が居る場合・`ZodError` との優先順位。Sprint A spec §2.1 の文言はこの変更で**初めて実態と一致**する(spec は凍結のため書き換えず、本 spec がその解消を宣言する)。

---

## 3. 削除

### 3.1 列(migration = `ALTER TABLE ... DROP COLUMN`)

| 表.列 | 併せて消すコード |
|---|---|
| `exams.question_no_format` | `exams-pull.ts:17` の mapper 行 / `ClientExam.question_no_format`(`client-db.ts:44`) |
| `exams.card_count` | `lib/cards/card-count.ts` **file ごと** / `apply-card-mutation.ts:116,172` の呼出 / `exams-pull.ts:19` / `ClientExam.card_count` / `seed-perf-exam.ts:649-653` の最終更新 |
| `exams.archived_at` | **全読み手の archived 分岐ごと**: `list.ts:42` の `isNull` 条件 + 返り値型の `archivedAt`(:54,68)/ `submit-upload.ts:546,553`(archived reject 分岐 + `{ outcome:'exam_not_found', archived:true }` の戻り値形)/ `exam-detail-view.tsx:42,54,205`(prop + 「(アーカイブ済)」表示)/ `exams/[id]/page.tsx:59` / `exam-list-live.tsx:32` の filter / `exams-pull.ts:18` / `ClientExam.archived_at` |
| `source_documents.mode` | `submit-upload.ts:581` の insert 値(`destination.mode` 自体は exam 解決に使うので残す) |
| `source_documents.ocr_cost_yen` | `upload-persistence.ts:72,85,105` の引数と insert 値 / `source-doc-status.ts:358` |
| `upload_records.ocr_cost_yen` | `publish-prepared.ts:239` / `source-doc-status.ts:358` |
| `upload_records.filename` / `file_size_bytes` | `source-doc-status.ts:355-356` の値組み立て / publish 経路の同等箇所 |
| `assets.reference_count` | なし(参照ゼロ) |
| `integration_failures.retry_count` / `next_retry_at` / `resolved_at` / `resolution_note` | なし(参照ゼロ) |

### 3.2 Dexie store

- `user_settings` store を **v11 で `null` 指定して drop**(`client-db.ts:241` の table 宣言と `ClientUserSettings` 型も削除)。設定は server RSC 読みが現役機構で、この store は pull writer が存在しない。

### 3.3 index(migration = `DROP INDEX`)

- `entity_mutations_entity_idx` — dedupe は `mutation_id` UNIQUE + `user_id` のみを使う
- `source_docs_user_exam_idx` — `source_docs_user_exam_created_idx` の prefix で冗長(schema comment が自認済み)
- `cards_answered_idx` — Step 0 §1.9 で対応 query 不在を確認

### 3.4 TypeScript の死に field

- `FlushResult` の `sessionSynced` / `reachable` / `attempted`(`lib/sync/review-events.ts`)。**entity 側と共有 shape のため両 outbox を横断して撤去**する(Sprint A follow-up (b))。`classifyFlushResults` は `failedEventIds` と `syncedEventIds` のみで判定できるので、判定ロジックは不変。

---

## 4. 維持 + 意図の明記(schema comment のみ・DDL 変更なし)

「読み手が app に無い」ことと「不要」は別だという裁定を、**表の定義に隣接する形で残す**(session doc は経緯であって定義ではない)。

| 対象 | 追記する意図 |
|---|---|
| `ai_usage_users` | **abuse 対応台帳**(Gemini API を濫用する user の特定・ban 判断)。読み手 = 運用者(OT が SQL で引く)。`integration_failures` と同型で、app に読み手が無いことは死列を意味しない |
| `contact_messages.status` | **将来の管理 UI の状態列**。それまでは OT が SQL で更新する。`'in_progress'` / `'resolved'` が app から到達不能なのは仕様 |
| `stripe_events.type` / `clerk_events.type` | forensic(どの event 種別が来たかの事後調査)。dedupe は `event_id` のみが担う |
| `integration_failures` / `asset_derivations` / `entity_mutations` の forensic 列 | 既存の意図宣言を維持(再掲のみ) |
| **全表の `user_id` CASCADE** | FK は**維持**(将来 users を物理削除に変える際の defense)。ただし schema 冒頭 comment の「users 完全削除で全関連データを連動削除する」という**発火する前提の説明が stale** — 実削除は退会 handler の明示 DELETE + 親 cascade であり、users は soft delete なので user_id CASCADE は発火しない、と書き直す |

---

## 5. 変更・追加

### 5.1 `upload_operations.source_document_id` → NOT NULL

- migration: `ALTER TABLE upload_operations ALTER COLUMN source_document_id SET NOT NULL`
- **事前確認 SQL**(runbook §): `SELECT count(*) FROM upload_operations WHERE source_document_id IS NULL;` → 0 でなければ中断(既存行が violate すると migration が失敗する)
- **null 分岐の撤去**(§1.10): `terminalize-abandoned-operation.ts:62,65` / `publish-prepared-plan.ts:214,241` / `publish-prepared.ts:131` の型と guard を non-null 化

### 5.2 CHECK 制約(**27 本** — Step 0 で確定)

**張る基準** = 壊れたら**課金・冪等性・状態機械**が狂う列 + 非負(count / bytes / pages)。**張らない基準** = 表示にしか使わない文字列列。

**本数について**(Codex 指摘 2): 裁定の「15〜20 本」は Step 0 前の見積りで、裁定自身が「実際の対象列一覧は Step 0 で確定」としていた。現物を突き合わせた結果は **enum 13 + 非負 14 = 27 本**。基準を満たす列を漏らさず拾うとこの数になる(削除対象列は除外済み)。**本数の増加のみ OT 確認点**(§8-2)。

#### enum(13 本)

| # | 列 | 許容値 | NULL |
|---|---|---|---|
| 1 | `users.plan` | free / standard / pro | NOT NULL |
| 2 | `users.subscription_status` | active / past_due / canceled | **NULL 可**(未課金) |
| 3 | `users.billing_interval` | month / year | **NULL 可**(free) |
| 4 | `source_documents.file_type` | pdf / image / csv / markdown | NOT NULL |
| 5 | `source_documents.status` | processing / completed / failed | NOT NULL |
| 6 | `upload_records.status` | completed / failed | NOT NULL |
| 7 | `contact_messages.status` | open / in_progress / resolved | NOT NULL |
| 8 | `tag_categories.select_type` | single / multi | NOT NULL |
| 9 | `tombstones.entity_type` | exam / card / tag_category / tag_option | NOT NULL |
| 10 | `entity_mutations.entity_type` | card / tag_category / tag_option | NOT NULL |
| 11 | **`entity_mutations.op`** | create / update_field / delete | NOT NULL |
| 12 | **`assets.status`** | reserved / ready / deleting / deleted | NOT NULL |
| 13 | `upload_operations.status` | prepared / processing / completed / terminal_failed | NOT NULL |

**NULL 意味論を明記**(Codex 独立 2/3): PostgreSQL の CHECK は NULL を通す。#2/#3 は `col IS NULL OR col IN (...)` と書き、**NULL 許容が意図であること**を制約式自身に表す。他 11 本は列が NOT NULL なので `col IN (...)` で足りる。

#### #11 `entity_mutations.op` と #12 `assets.status` の整合機構(Codex 指摘 1・独立 1)

裁定どおり**対象に含める**。ただしこの 2 列は「アプリ層が SSoT」という既存の意図宣言を持つため、**DB CHECK を二重定義にしない機構**を設ける:

- **DB CHECK は backstop、SSoT はアプリ層のまま**という関係を schema comment に明記(既存の「CHECK を張らない」宣言は**この形に書き換える** — 撤回ではなく役割の明確化)。
- **一致を test で機械検証**する(Sprint A の schema contract pin と同型): 実 PG の `pg_get_constraintdef` から CHECK の許容値集合を読み出し、**`op` は registry(`lib/sync/server/entity-mutation-registry.ts`)の key 集合と一致**、**`assets.status` は `AssetStatus`(`lib/media/domain/asset-state.ts:19`)の union と一致**することを iso で assert。片方だけ増える drift が red になる。
- 帰結として **op / status の語彙追加には migration が要る**(裁定が受け入れた性質)。この運用コストを schema comment に 1 行残す。

#### 非負(14 本)

`ai_usage.count` / `ai_usage_users.count` / `source_documents.file_size_bytes` / `source_documents.pages_processed` / `source_documents.pages_total`(**NULL 可** — PDF の count phase 前)/ `upload_records.pages_processed` / `study_days.review_count` / `study_days.correct_count` / `study_days.distinct_card_count` / `assets.byte_size` / `assets.width` / `assets.height` / `upload_operations.attempt_count` / `upload_operations.expected_source_count`

- `width` / `height` は **`> 0`**(0 の画像は無意味)、他は **`>= 0`**。→ §8-3 で確認。
- **相関制約は張らない**(Codex 独立 2): `correct_count <= review_count` / `pages_processed <= pages_total` は本 sprint の対象外(単列非負のみ)。理由 = study_days は絶対値再集計で両者が同一 SQL から出るため冗長、pages は count phase の途中状態で一時的に不等が成立しうる。**この非対象を明記する**。
- 削除対象列(`exams.card_count` / `assets.reference_count` / `integration_failures.retry_count` / `upload_records.file_size_bytes`)は除外済み。

#### 命名規約と適用手順

- 制約名 = **`<table>_<column>_<kind>`**(`kind` = `enum` / `nonneg` / `positive`)。例: `users_plan_enum` / `study_days_review_count_nonneg` / `assets_width_positive`。Sprint A の `cards_state_range` は既存のまま残す(改名しない)。
- **事前確認 SQL は count でなく diagnostic**(Codex 独立 3): 違反行の **PK と実値**を返す形にする。enum は `WHERE col IS NOT NULL AND col NOT IN (...)`(NULL 可列は別途 `WHERE col IS NULL` の件数も出す)。
- **TOCTOU**(Codex 独立 3): 事前確認から DDL までの間に書込が入りうる。ユーザー 0 でも webhook(Stripe/Clerk)は外部起因で走る。**`ADD CONSTRAINT` は既存行を検証しながらテーブルをロックするため、確認をすり抜けた行があっても DDL 自身が失敗して安全側に倒れる** — 事前確認は「失敗を事前に知る」ためのもので、正しさの根拠ではない、と runbook に明記する。`NOT VALID` → `VALIDATE` の 2 段は**採らない**(ユーザー 0・行数僅少でロック時間が問題にならないため。YAGNI)。

### 5.3 entity_mutations outbox(client)の owner-scope 化

Sprint A で answer_events に施したのと**同型**の穴。Step 0 で確認: `lib/sync/entity-mutations.ts` に `user_id` / `userId` の参照が **1 件も無い**。

- `ClientEntityMutation` に `user_id` を追加、Dexie index を `[user_id+sync_status]` に(v11 で store 再作成 — answer_events の v9→v10 前例に倣い **drop → create の 2 version**)
- pending 選別・synced/failed 化を userId で閉じる
- `enqueueEntityMutation` の呼出元に userId を供給(`runOptimistic*` 経由の caller すべて)

### 5.4 stale comment 一掃

| 箇所 | 現状 | 修正 |
|---|---|---|
| `schema.ts:1` | 「26 tables」 | 実 **23**(Sprint A で reviews / study_sessions が消えた) |
| `schema.ts:3-7` | user cascade が発火する前提の説明 | §4 のとおり書き直し |
| `assets` の comment | 「reference_count / unreferenced_at は dormant」 | `unreferenced_at` は **GC v2 の中核に昇格済み**(`asset-state.ts` / `asset-gc.ts`)。`reference_count` は §3.1 で削除するので、この一文ごと書き直す |
| `contact_messages` の comment | 「DB INSERT 実装は Sprint A-3+」 | **実装済み**(`lib/actions/contact.ts:86`) |
| `source_documents` の comment | R2 非経由の記述(follow-up 台帳から併合) | ②-4b で PDF は `src/` prefix に一時保存する形になったため実態と不一致 — 現状に合わせる |

---

## 6. 消える歪みとの対応表(第 3 弾 §8 の番号)

| # | 第 3 弾 §8 の歪み | 本 sprint の扱い |
|---|---|---|
| 1 | user_id CASCADE が全表で不発 | **解消(記述のみ)** — FK は維持し §4 で comment を訂正。機構は変えない |
| 2 | `exams.archived_at` が dead 分岐 | **解消** — 列 + 全読み手分岐を削除(§3.1) |
| 3 | `exams.card_count` の bump が無駄 | **解消** — 列 + bump ロジックごと削除(§3.1) |
| 4 | W-only 表 4 + 準 1 | **部分解消** — 全て維持裁定。ただし `ai_usage_users` の「理由の記録なし」は §4 で解消 |
| 5 | schema comment の stale 群 | **解消** — §5.4 |
| 6 | `source_documents.mode` の用途消滅 + ocr_cost の write-only | **解消** — §3.1 |
| 7 | CHECK 全面ゼロ | **部分解消** — **27 本**追加(§5.2)。`assets.status` / `entity_mutations.op` を含む(既存の宣言は「DB = backstop / アプリ層 = SSoT」へ書き換え + 一致を iso で pin)。相関制約は非対象 |
| 8 | upload_records と source_documents の列複写 | **解消** — §3.1 |
| 9 | `assets (user_id, hash)` 非 UNIQUE | **非スコープ**(§7) |
| 10 | 未使用 index 群 | **解消** — 3 本削除(§3.3)。残り 4 本は Sprint A で表ごと消滅済み |
| 11 | Dexie `user_settings` 死 store | **解消** — §3.2 |
| 12 | `upload_operations.exam_id` CASCADE で冪等 ledger が消える | **残す**(裁定に無い。exam 削除後の再送は exam_not_found になるため実害が薄い) |
| 13 | 匿名 contact_messages の PII 残置 | **残す**(architecture.md「残余リスク」で公開前判断として管理中) |
| 14 | stripe/clerk_events の無期限蓄積 | **残す**(保持方針は未決のまま・実害薄) |
| 15 | `upload_operations.source_document_id` の名残 nullable | **解消** — §5.1 |

**残る歪み = #12 / #13 / #14 の 3 件**(いずれも「記録のみ」で本 sprint 対象外)。

---

## 7. 非スコープ(明記)

- `assets (user_id, hash)` の UNIQUE 化 — **トリガー = image dedup を実機能として立てる時**。現状 dedup は best-effort で、UNIQUE を先に張ると同 hash の正当な複数 asset(異なる crop 由来など)を弾く可能性がある
- `cards` の 3 責務分割 / FSRS 状態の別表化 — **トリガー = LMS 着手**(Sprint A から継続)
- **死表そのものの DROP は無し** — `reviews` / `study_sessions` は Sprint A で処理済み。W-only 表(`ai_usage_users` / `integration_failures` / `asset_derivations` / `contact_messages`)は全て維持裁定
- **相関 CHECK**(`correct_count <= review_count` / `pages_processed <= pages_total`)— §5.2 の理由により単列非負のみ
- **`NOT VALID` → `VALIDATE` の 2 段適用** — ユーザー 0・行数僅少でロック時間が問題にならないため(YAGNI)
- **`entity_mutations` の mutation_id を (user_id, mutation_id) 複合 UNIQUE にすること**(Codex 独立 7)— 現状のグローバル UNIQUE + dedupe 時の `eq(userId)` 併用で cross-user の誤 skip は起きない。owner-scope 化は client 側の誤送信防止が目的で、**server 側の認可境界は従来どおり auth 由来 `user.id`**(client 供給値を信頼しない)という既存契約は変えない

---

## 8. OT 確認点(text 番号 bullet)

1. **`exams.archived_at` 削除に伴う挙動の変化**: `submit-upload` の「archived exam へのアップロードを拒否する」gate と、`exam_not_found` の `archived` discriminator が消える。**現状 archived は常に NULL なので実挙動は変わらない**が、将来アーカイブを実装する際はこの gate を再実装する必要がある。削除済み列に隣接する schema comment には残せないため(Codex 独立 11)、**`docs/architecture.md` の該当行に「archive 機能は未実装・再実装時は upload gate も必要」と 1 行残す**形でよいか。
2. **CHECK が 27 本になる**(裁定の見積り「15〜20 本」を超える・§5.2)。裁定自身が「実際の対象列一覧は Step 0 で確定」としており、基準(課金・冪等性・状態機械の enum + 非負 count/bytes/pages)を満たす列を漏らさず拾った結果。**本数の増加を許容してよいか、基準を絞るか**。
3. **`assets.width` / `height` を `> 0`(他は `>= 0`)にする**提案(§5.2)。0 寸法の画像は無意味だが、既存行に 0 が無いことは適用前 SQL で確認する。`>= 0` に統一する選択もある。
4. **`FlushResult` の 3 field 撤去は entity 側 outbox にも波及する**(§3.4)。Sprint A で「共有 shape ゆえ範囲外」と deferred したものの引き取りで、entity 側 test も同 commit で追随する。
5. **Dexie の破壊的 upgrade を明示的に受容する**(Codex 独立 6): `entity_mutations` store を drop→create すると、**端末に残っている未同期 mutation(pending)が失われる**。ユーザー 0 前提で許容する裁定でよいか(代替 = upgrade transaction 内で `user_id` を補完する形にすると、補完不能行の扱いを決める必要があり複雑化する)。

## 9. 進め方・完了条件

- **migration 構成**: `DROP COLUMN` × 13 / `DROP INDEX` × 3 / `SET NOT NULL` × 1 / `ADD CONSTRAINT CHECK` × 27。**DROP/CREATE する表は無い見込み**のため policy/grant は落ちない。もし生じたら Sprint A の runbook 形式(同一窓での再適用)を踏襲する。
- **runbook**(新規 `docs/ops/sprint-b-db-cleanup-runbook.md`):
  - CHECK 27 本の**違反行 diagnostic SQL**(PK + 実値を返す形。enum の NULL 可列は NULL 件数も別途)
  - `SELECT count(*) FROM upload_operations WHERE source_document_id IS NULL` → 0 確認
  - **適用順 = code deploy → migrate**。0034 のような DROP DEFAULT は無いが、**DROP COLUMN は旧 code が SELECT していると壊れる**ため順序は同じ。migrate 後の code rollback は不可(DROP COLUMN は戻せない)。
  - **旧インスタンス/旧 worker の drain 条件**(Codex 独立 9): Vercel の旧 deployment が残っていると削除列を SELECT して失敗する。切替完了を確認してから migrate する。
  - TOCTOU の位置づけ(§5.2 末尾)を明記。
- **test 追随は同 commit**。削除して green にするのではなく、**削除後の現行挙動を pin する置換テストを置く**(Codex 独立 12): archived 条件なしで exam 一覧・upload が動く / card create・delete 後も一覧件数が Dexie 動的集計で正しい / 別 owner の mutation を flush・update しない / Dexie upgrade が期待どおりの store 集合を作る / CHECK の境界値・NULL・違反値 / NOT NULL 違反 / permanent・transient・unknown SQLSTATE と nested cause。
- **index 削除の根拠**(Codex 独立 10): 3 本それぞれについて、代替 index と対象 query の対応表を plan に含める(`source_docs_user_exam_idx` は列順・sort 方向まで prefix 一致を確認)。
- 完了条件: whole-repo lint 0 / `pnpm test` / `pnpm test:iso` green / `pnpm run audit` 0 / `frozen-lockfile` + typecheck + build 0 / **migration no-diff + snapshot/journal と schema.ts の整合** / canonical + Codex で Critical 0・Important 0 → `[reviewed]` / docs 波及(architecture.md の該当行 + 第 3 弾 §9 に「本 sprint で解消」の注記 + §8 の残存 3 件の明示)。
