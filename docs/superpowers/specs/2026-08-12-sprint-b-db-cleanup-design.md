# Sprint B — DB 全体掃除 設計 spec(r4)

- 状態: **ドラフト(Fable 再作成・r3 への Codex cross-check 反映済み・OT 承認待ち)**。**実装開始条件 = 本 spec の承認 + §8 の新規 3 点の裁定**(Codex r3 指摘 22)。承認後 writing-plans へ。
- 経緯: r2(Opus 作成・9fe9f52)を下書きとして扱い、Fable が **Step 0 を全件再実走** + **設計判断(§2 / §5.2 / §5.3 / §9)を白紙から再導出**(= r3)。r2 の Codex cross-check(`docs/codex/2026-08-12-plan-sprint-b-db-cleanup-spec.md`)は既知として取り込み、r3 に対する 2 回目の cross-check(`docs/codex/2026-08-12-plan-sprint-b-db-cleanup-spec-r3.md`)の反映を「(Codex r3 …)」で帰属表示する。
- 入力: `docs/audit/2026-08-11-db-schema-full-inventory.md`(第 3 弾)§8/§9 + OT 裁定(採否確定済み。本 spec は**実現形の設計のみ**を扱う)。r2 の OT 確認点 5 件は**全て承認済み**(archived_at gate 消滅の architecture.md 受容 / CHECK 27 本許容 / width・height `> 0` / FlushResult 撤去の entity 波及受容 / Dexie 破壊 upgrade 受容)。
- 前提: ユーザー 0・破壊的変更自由・互換レイヤー不要。Sprint A(migration 0034/0035)適用済みが起点。次 migration は 0036。

## 0. 目的

第 3 弾 §8 の歪み 15 件のうち OT 裁定で「掃除する」と決まった分を一掃する。死列・死 store・死 index を消し、生きている W-only 表には意図を schema comment として刻み、壊れたら課金・冪等性が狂う列に CHECK を張る。Sprint A follow-up 2 件(classifyBulkError の 400 到達不能 / entity_mutations outbox の owner-scope)を引き取る。

---

## 1. Step 0 の結果(Fable による全件再実走)

**確認方法**: production コード(`lib/` `app/` `scripts/`、`*.test.*` 除外)を rg で列挙し、schema 定義・型宣言・mapper 通過と、実際に値を読む箇所を区別。全主張を file:symbol で再確認した。

| # | 対象 | 主張 | 再々確認 | 根拠(file:symbol) |
|---|---|---|---|---|
| 1.1 | Dexie `user_settings` store | 書き手・読み手ゼロ | **確認** | 宣言のみ `client-db.ts:241,268`。production の `.user_settings` 参照 0 件(PG 表 `user_settings` は現役 — 消すのは Dexie store のみ)。test の `db.user_settings.clear()`(`review-events.test.ts:34`)は追随削除 |
| 1.2 | `exams.question_no_format` | 両側完全死 | **確認** | 書き手ゼロ。読み手 = `exams-pull.ts:17` mapper と `ClientExam`(`client-db.ts:44`)の運搬のみ |
| 1.3 | `exams.card_count` | server 読み手ゼロ | **確認** | 書き手 = `bumpExamCardCount`(`card-count.ts:24`)。**呼出は 3 箇所**: `apply-card-mutation.ts:116,172` / **`upload-persistence.ts:52`(r2 は漏らしていた)** / seed `seed-perf-exam.ts:490,651`。`pull.ts:73,83,293` の `cardCount` は `PullDeltaResult` 統計で無関係。client は `exam-list-live.tsx:47` が Dexie 動的集計 |
| 1.4 | `exams.archived_at` | 書き手ゼロ・読み手多数の dead 分岐 | **確認** | `update(exams).set` に archivedAt を書く経路ゼロ。読み手 = `list.ts:42,54,68` / `submit-upload.ts:148,546,553` / `exams/[id]/page.tsx:59` / `exam-detail-view.tsx:42,54,205` / `exam-list-live.tsx:32` / `exams-pull.ts:18` + **`upload-form.tsx:976` の `result.archived`(r2 は漏らしていた)** |
| 1.5 | `source_documents.mode` | 用途消滅 | **確認** | 書き手 = `submit-upload.ts:582`(`mode: destination.mode`)のみ。読み手 0 件(`destination.mode` は UI union で別物・exam 解決に残す) |
| 1.6 | `ocr_cost_yen`(2 表) | write-only | **確認** | 書き手 = `upload-persistence.ts:85,105,153` / `publish-prepared.ts:239`(null)/ `source-doc-status.ts:358`(0)。SELECT ゼロ。**ただし costYen 値自体には UI の生きた読者がある**(§1.10-3) |
| 1.7 | `upload_records.filename` / `file_size_bytes` | 読み手なしコピー | **確認** | `uploadRecords` の読み手は quota SUM(`ai-usage-mcq.ts:55-63`: pagesProcessed / status / createdAt / userId)と退会 DELETE のみ。書き手 = insert 4 箇所(`upload-persistence.ts:100,148` / `source-doc-status.ts:352` / `publish-prepared.ts:234`) |
| 1.8 | `assets.reference_count` / `integration_failures` dormant 4 列 | dormant | **確認** | schema 定義 + comment 以外の参照 0 件(`asset-actions.ts:100` は comment 言及のみ → 書換) |
| 1.9 | `cards_answered_idx` | 対応 query 不在 | **確認 = 削除可** | `cards.answered` を WHERE する server query ゼロ。回答状態フィルタは client Dexie(`card-filter-predicates.ts:61`) |

**index 3 本の削除根拠**(§3.3 の裏付け):

- `entity_mutations_entity_idx`(entityType, entityId, editedAt): server query は dedupe SELECT(`entity-mutations/bulk/route.ts:126-131` = mutationId UNIQUE + userId)と log INSERT(`:166`)と退会 DELETE(userId → `entity_mutations_user_idx` が担う)のみ。編成列を使う query ゼロ
- `source_docs_user_exam_idx`(user_id, exam_id): `source_docs_user_exam_created_idx`(user_id, exam_id, created_at DESC)の**厳密 prefix**(先頭 2 列が列順・方向とも一致・`schema.ts:411,422-426`)。exam FK cascade は `source_docs_exam_idx`(`schema.ts:416`)が別に担う
- `cards_answered_idx`: §1.9

### 1.10 r2 からの乖離・追加で判明したこと(重要)

1. **`upload_operations.source_document_id` の FK は `onDelete: 'set null'`(`schema.ts:853-855`)で、NOT NULL 化と両立しない**。source_documents 行が削除されると SET NULL action が発火し、NOT NULL 列への SET NULL は違反エラーになる。現物確認: `delete(sourceDocuments)` の単独経路は **production に 0 件**(削除は exam cascade / 退会 handler の `delete(exams)`(`handle-clerk-event.ts:270`)経由のみ)。この場合 exam cascade 内で upload_operations 自身も exam_id cascade で消えるが、**SET NULL trigger と cascade delete の実行順は PG 内部順序に依存**し、順序が不利なら退会・exam 削除ごと失敗する。→ **§5.1 で FK action を `cascade` に変更する**(r2 に無い設計追加・OT 確認点 §8-1)。schema comment の「source_document 削除後も操作記録は残したい」(`schema.ts:838-839`)は単独削除経路の消滅により空洞化しており、併せて書き直す。
2. **`card.create` の `cascadeLike: true` は card_count bump のみを根拠にしている**(`entity-mutation-registry.ts:271-276`)。bump 撤去で前提が消える。flag を落とすのは bulk 並列化の挙動変更 = 本 sprint の scope 外のため、**保守的に維持し comment を「根拠消滅・並列化再検証まで保守的維持」に書き換える**(OT 確認点 §8-2)。`card.delete` の cascadeLike は tombstone + DELETE の cross-entity 書込で自立(comment から card_count 言及のみ除去)。
3. **ocr_cost_yen の削除境界**: `costYen` は `upload-error-types.ts:34` → `upload-form.tsx:1347-1348`(エラー詳細表示)の生きた読者を持つ。よって削除は「DB 列 + 台帳 insert 値 + それで不要化する引数」まで — `estimateCostYen`(`cost.ts`)/ `ocr.ts:225-231` の計算チェーンは**残す**。不要化する引数の現物: `completeUploadTx` の `filename` / `totalSize` / `ocrCostYen`(`upload-persistence.ts:68-72` — uploadRecords insert 専用)/ `markFailed` の `audit.filename` / `fileSizeBytes` / `ocrCostYen`(`:119-122`)/ `source-doc-status.ts:242-243` RETURNING の filename・fileSizeBytes 縮小 / `publish-prepared.ts:234-241` の insert 値と上流(`upload-pipeline.ts:919-935` の file_size_bytes 合算は publish 記帳専用なら削除連鎖 — 実装時に唯一の消費先であることを確認して削る)。
4. **DROP COLUMN の deploy 順序は SELECT 側だけでなく INSERT 側にも制約がある**: `source_documents.mode` / `upload_records.filename` / `file_size_bytes` は **NOT NULL かつ default 無し**。新 code(値を組み立てない)が旧 schema に INSERT すると 23502 で失敗する。→ §9 の適用順で明示的に受容する(OT 確認点 §8-3)。
5. **r2 §5.4 の「schema.ts:1 = 26 tables」は既に是正済み**。現物は「23 tables; FSRS 整合 Sprint A で reviews / study_sessions を廃止」で実表数 23 と一致 → 本 spec では対象から外す。
6. `upload_operations.source_document_id` の null 分岐の実パス: `app/(app)/app/upload/_lib/terminalize-abandoned-operation.ts`(`failSourceDocumentForTerminalOp` の `if (sourceDocumentId === null) return`)/ 同 `_lib/publish-prepared-plan.ts`(`buildCardRows` / `buildResultSummary` の ctx 型 `string | null`)/ `_actions/publish-prepared.ts:131`(null throw)。FK を cascade にすれば「source doc 削除で null になる」経路も消え、これらは真に dead になる(NOT NULL 化と同 commit で撤去)。
7. **owner-scope 化の波及は enqueue 側だけでなく flush orchestrator 側にも及ぶ**: `runGuardedEntityMutationFlush` は現状 userId 無しで flush する(`entity-mutation-flush.ts:44`)。呼出 production 14 箇所(§5.3)。
8. FlushResult 3 field(attempted / sessionSynced / reachable)の production 読者ゼロを確認: `classifyFlushResults`(`review-flush.ts:57-71`)が読むのは failedEventIds / syncedEventIds / httpStatus のみ。

---

## 2. 冒頭タスク — `classifyBulkError` の 400 分岐を到達可能にする

**現状**(再確認済): `permanent-4xx` を返すのは ZodError のみ(`classify-bulk-error.ts:63`)。SQLSTATE は transient 集合に無ければ**全て default `transient`**(`:86`)に落ち、コード欠陥由来の永続エラーが 503 → client が backoff 再送し続ける。Sprint A spec §2.1 の「permanent-4xx → 400」分岐は両 route(`review-events/bulk/route.ts:91` / `entity-mutations/bulk/route.ts:363-365`)に実在するが**到達不能**。

**変更**: `PERMANENT_PG_CODES` を新設し、classifyChain の `.code` 判定(`:73-77` の層)に追加する。

**分類の原理(Fable 再導出 — r2 と同結論)**: 400 に入れてよいのは「**同一 payload の再送が現 schema 契約の下で決して成功しない**」かつ「**payload の形だけから決定的に失敗する**」code のみ。DB 状態や deploy 状態に依存する失敗は再送で解消しうるため transient に残す。

- **`permanent-4xx`(5 code)**: `23514` check_violation / `23502` not_null_violation / `22P02` invalid_text_representation / `22001` string_data_right_truncation / `22003` numeric_value_out_of_range — いずれも共有 zod を通過した payload が DB 制約で落ちる = client/server 契約 drift バグの signal で、payload 決定的。
- **transient のまま(意図的)**: `42601` / `42703` / `42P01` / `42883`(server/deploy 欠陥 — 修正 deploy 後に同一 payload が通るため retry が正しい。400 にすると server 欠陥を client 責任に転嫁する)/ `23503` / `23505`(DB 状態依存 — 順序競合・並走で発生しうる)/ 既存 transient 集合(40001 / 40P01 / 57014 / 08xxx / 53300 / 57P03)。
- **default = `transient` 維持**(未知 DB error で silent lost write を作らない、既存裁定)。
- 優先順位: PERMANENT / TRANSIENT 集合は**互いに素**なので判定順は挙動に影響しない。ZodError 先行判定(`:63`)と cause 再帰(`:79-82` — inner が permanent-4xx なら透過する既存構造)は不変。
- **列の育て方**(既存 comment `:14-18` の方針を維持): 実発生 code は serializeDbError の log(`review_events.bulk.tx_failed` / `entity_mutations.bulk.envelope_failed`)で観測し、集合へ追加する。これが「誤分類の監視方法」。

**client 側の帰結**(再確認済): 400 を受けた client は **outbox を terminal 化せず pending 残置**する(review: chunk 中断 `review-events.ts:224-236`、terminal 'failed' 化は 200 応答の failed[] のみ `:239-242` / entity: 非 2xx で Dexie 無変更 `entity-mutations.ts:322-336`)。`classifyFlushResults` は 'permanent' を返し **backoff 自動 retry だけが止まる**(次の自然 trigger では再送される)。

**分類語の定義を明確化**(Codex r3 独立 1: 「permanent なのに再送」の見かけ矛盾への応答): この 'permanent' は「**自動 backoff retry の対象外**」を意味する retry 分類であり、outbox の終端化(synced / failed)とは**独立の軸**。終端化しない理由 = 契約 drift バグ由来の 400 で学習記録を failed 隔離すると、server 側修正後に自然回復する道を断つ(データ保全を優先)。Sprint A spec §3「残る pending は transient のみ」はこの既知例外を持つ形になるため、**architecture.md の不変条件記述を「+ 既知例外: 契約 drift 由来の 400(pending 残置・トリガー再送で server 修正後に自然回復)」へ更新する**(spec 凍結のため Sprint A spec 自体は書き換えない)。

**誤分類の blast radius が列挙方式を正当化する**(Codex r3 独立 2 / 指摘 2 への応答): 23502 / 22003 / 23514 は server 側欠陥(INSERT 列漏れ・計算変換・制約定義ミス)でも発生しうるという指摘は正しい。ただし本設計の 400 は書込放棄を伴わない(pending 残置)ため、server 欠陥を 400 と誤分類したコスト = 「backoff が止まる」だけで、修正 deploy 後の自然 trigger 再送で回復する。constraint 名や処理段階まで見る精密分類は、この軽い帰結に対して過剰(YAGNI — 「列の育て方」の観測駆動で足りる)。400 応答 body は既存どおり `{ error: 'invalid_payload' }` 固定で DB 内部情報を漏らさない(詳細は serializeDbError の server log のみ)。

**責務境界は既存のまま**(Codex r3 独立 3): entity 側の per-mutation 失敗は 200 + `failed[]`(巻き添えなし)、envelope 400/503 は tx 開始失敗等の全体障害。review 側は 1 tx 設計(Sprint A 確定)ゆえ envelope 失敗 = chunk 全体 pending。本 sprint はこの境界を変えない。

**test(両 route + unit)**: (a) 5 つの permanent code → 400 (b) 42xxx → 503 (c) 23503/23505 → 503 (d) 未知 code → 503 (e) DrizzleQueryError / 非 Drizzle wrap の cause chain 奥の PG code (f) ZodError との優先順位 (g) depth 上限。client 側は「400 → pending 残置・synced/failed 無変更」を両 outbox で pin(既存 test があれば流用)。

---

## 3. 削除

### 3.1 列(migration 0036 = `ALTER TABLE ... DROP COLUMN`)

| 表.列 | 併せて消すコード(file:symbol) |
|---|---|
| `exams.question_no_format` | `exams-pull.ts:17` mapper 行 / `ClientExam.question_no_format` |
| `exams.card_count` | `lib/cards/card-count.ts` file ごと / 呼出 3 箇所: `apply-card-mutation.ts:116,172`(delete 側 step 1 の examId 取得が bump 専用なら併せ縮小)+ **`upload-persistence.ts:52`** / `exams-pull.ts:19` / `ClientExam.card_count` / `seed-perf-exam.ts:490,651` / comment 波及: `entity-mutation-registry.ts:90-94,269-276,280-282`(§1.10-2 の書換)・`publish-prepared.ts:108,203`・`inline-card-list.tsx:358-359,427`・`delete-card-button.tsx:10-12`・`create-exam.ts:14` |
| `exams.archived_at` | 全読み手分岐ごと: `list.ts:42` isNull 条件 + 戻り値型 `:54,68` / `submit-upload.ts:546-554` reject 分岐 + `:148` の `{ outcome:'exam_not_found'; archived }` discriminator(→ `archived` field 撤去)/ **`upload-form.tsx:976`** / `upload-error-types.ts:4` comment / `exam-detail-view.tsx:42,54,205` / `exams/[id]/page.tsx:59` / `exam-list-live.tsx:32` / `exams-pull.ts:18` / `ClientExam.archived_at` |
| `source_documents.mode` | `submit-upload.ts:582` の insert 値(`destination.mode` は exam 解決用に残す) |
| `source_documents.ocr_cost_yen` / `upload_records.ocr_cost_yen` | §1.10-3 の削除境界: insert 値 4 箇所 + 不要化引数(completeUploadTx / markFailed / source-doc-status RETURNING / publish-prepared)。`cost.ts` / `ocr.ts` の計算チェーンは**残す**(UI エラー詳細の読者あり) |
| `upload_records.filename` / `file_size_bytes` | insert 4 経路の値組み立て(`upload-persistence.ts:100-107,148-155` / `source-doc-status.ts:352-360` + RETURNING 縮小 / `publish-prepared.ts:234-241` + 上流合算の要否確認) |
| `assets.reference_count` | comment 書換のみ(`schema.ts:758,782-783` / `asset-actions.ts:100`) |
| `integration_failures.retry_count` / `next_retry_at` / `resolved_at` / `resolution_note` | schema comment(`schema.ts:196-198`)の dormant 言及書換のみ |

client mirror 注記: `ClientExam` の 3 field 撤去に Dexie migration は不要(exams store にこれらの index 無し・旧行の残存 prop は次回 pull の bulkPut 全置換で消える)。

### 3.2 Dexie store

- `user_settings` store を drop(§5.3 の v11)。`ClientUserSettings` 型・table 宣言(`client-db.ts:132-141,241,268`)削除。設定は server RSC 読みが現役機構(`settings/page.tsx` / `study/smart/page.tsx`)。

### 3.3 index(migration 0036 = `DROP INDEX`)

- `entity_mutations_entity_idx` / `source_docs_user_exam_idx` / `cards_answered_idx` — 根拠と代替は §1 の裏付け表。

### 3.4 TypeScript の死に field

- `FlushResult` の `sessionSynced` / `reachable` / `attempted`(`review-events.ts:123-135`)。読者は test のみ(§1.10-8)。両 outbox(`review-events.ts` / `entity-mutations.ts`)と `noFlushResult()` から横断撤去、test 追随。`classifyFlushResults` は判定に使っておらず不変。

---

## 4. 維持 + 意図の明記(schema.ts comment のみ・DDL 変更なし)

| 対象 | 追記する意図 |
|---|---|
| `ai_usage_users` | **abuse 対応台帳**(濫用 user の特定・ban 判断)。読み手 = 運用者(OT が SQL)。書き手 = `ai-usage-counter.ts:37-41` upsert。app に読み手が無いことは死列を意味しない |
| `contact_messages.status` | **将来の管理 UI の状態列**。それまで OT が SQL で更新。`'in_progress'` / `'resolved'` が app から到達不能なのは仕様 |
| `stripe_events.type` / `clerk_events.type` | forensic(event 種別の事後調査)。dedupe は `event_id` のみが担う |
| `integration_failures` / `asset_derivations` / `entity_mutations` の forensic 列 | 既存の意図宣言を維持(再掲のみ) |
| 全表の `user_id` CASCADE | FK は**維持**(将来 users 物理削除への defense)。schema 冒頭(`schema.ts:3-7`)の「users 完全削除で連動削除する」という発火前提の説明を「users は soft delete(`:10-16` 自認済)ゆえ user_id CASCADE は不発 — 実削除は退会 handler の明示 DELETE + 親 cascade」に書き直す |

---

## 5. 変更・追加

### 5.1 `upload_operations.source_document_id` → NOT NULL + FK action 変更(r2 から変更)

- migration: `ALTER TABLE upload_operations ALTER COLUMN source_document_id SET NOT NULL` + **FK を `ON DELETE SET NULL` → `ON DELETE CASCADE` に張り替え**(constraint DROP → ADD)。schema.ts は `.notNull().references(..., { onDelete: 'cascade' })`。
- 根拠(§1.10-1): SET NULL と NOT NULL は両立しない。単独削除経路ゼロの現物では cascade で失われる記録も無い。operation は source doc 無しで意味を持たない(`publish-prepared.ts:131` が null を内部不整合 throw で扱う現行意味論とも一致)。
- 事前確認 SQL(runbook): `SELECT id FROM upload_operations WHERE source_document_id IS NULL;` → 0 行でなければ中断。
- null 分岐の撤去(§1.10-6 の 3 file)。schema comment(`schema.ts:829-833,838-839`)の nullable 名残説明・SET NULL 意図を書換え、**「source_documents の単独 DELETE 経路を新設する際は operation 保持方針(cascade で消える)を再判断せよ」という将来防御の 1 行を残す**(Codex r3 独立 4: 「経路が無い」はコード現況であり DB 不変条件ではない、への応答)。
- iso test は削除 3 経路を分けて pin(Codex r3 指摘 8): (a) exam 削除 cascade (b) 退会 handler(`delete(exams)` 経由)(c) source_documents 直接 DELETE(SQL レベル)— いずれも upload_operations 行が残らず・エラーにもならないこと / NOT NULL 違反 INSERT が 23502 になること。

### 5.2 CHECK 制約(27 本 — 承認済み)

**基準**(再導出で明文化): enum = 課金判定・状態機械・sync/冪等の分岐に使う文字列列。非負 = **server が自ら計算して書く課金・quota・台帳・統計系の count / bytes / pages / 寸法**。除外(理由つき): `contact_messages.category`(triage ラベル・状態機械でない)/ `integration_failures` 4 軸(catalog = SSoT の既存宣言 + 組合せ妥当性は単列 CHECK で表現不能)/ cards の FSRS 数値列(ts-fsrs 出力・client 反映値で server は素通し)/ `content_version` / `lease_version`(単調カウンタ・課金冪等に非直結)/ `user_settings.session_limit` 等(nullable 設定値)/ `asset_derivations.crop_w/crop_h/padding_pct`(W-only forensic)。`cards.state` / `answer_events.rating` 等は Sprint A で CHECK 済(既存 4 本 = `cards_state_range` + answer_events 3 本、改名しない)。

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
| 11 | `entity_mutations.op` | create / update_field / delete | NOT NULL |
| 12 | `assets.status` | reserved / ready / deleting / deleted | NOT NULL |
| 13 | `upload_operations.status` | prepared / processing / completed / terminal_failed | NOT NULL |

NULL 意味論: PG の CHECK は NULL を通す。#2/#3 は `col IS NULL OR col IN (...)` と書き NULL 許容が意図であることを制約式に表す。他 11 本は列自体 NOT NULL のため `col IN (...)`。

#### #11 / #12 の整合機構(アプリ層 SSoT と DB CHECK の二重定義を地獄にしない形)

再導出の結論 = **r2 の機構を採用**(単一定義への統合案 — registry / `AssetStatus` を schema.ts が値 import して CHECK 式を生成 — も検討したが、registry の型再編 + schema.ts への runtime import 追加で blast radius が大きく、簡潔性規律の最小実装に反するため不採用):

- 役割: **DB CHECK = backstop / アプリ層 = SSoT**。既存の「CHECK を張らない」宣言(`asset-state.ts:2-4` / `schema.ts:597` 周辺)はこの形に書き換える(撤回でなく役割の明確化)。
- 機械検証: iso(実 PG・`tests/integration/pg/`)で `pg_get_constraintdef` から許容値集合を読み出し、`op` は registry(`ENTITY_MUTATION_REGISTRY` の内側 op key 集合 — runtime 列挙可)と、`assets.status` はアプリ層の状態語彙と**集合一致**を assert。どちら向きの drift も red。
- **`AssetStatus` は現状 type-only alias(`asset-state.ts:19`)で runtime 比較不能**(Codex r3 指摘 4 — 現物確認で確定)。`asset-state.ts` に `export const ASSET_STATUSES = ['reserved','ready','deleting','deleted'] as const` を追加し `type AssetStatus = (typeof ASSET_STATUSES)[number]` へ導出を反転する(pure module 制約は維持・既存の型利用側は無変更)。iso はこの runtime tuple と比較する。
- 運用: op / status の語彙追加 = registry(or tuple)+ schema.ts CHECK + migration の 3 点更新。iso が同期を強制し、migration no-diff gate が schema.ts↔migration の乖離を塞ぐ。**語彙拡張時の deploy 順は「CHECK を広げる migration 先行 → 新値を書く code deploy」**(旧 CHECK が新値を弾くため・Codex r3 指摘 5)。この手順を schema comment に 1 行残す。
- schema comment は TS comment(schema.ts)が意図の正本という既存 convention に従う。PG 側 `COMMENT ON` は導入しない(新 convention の追加 = YAGNI・Codex r3 指摘 20 は非採用)。

#### 非負(14 本)

`ai_usage.count` / `ai_usage_users.count` / `source_documents.file_size_bytes` / `source_documents.pages_processed` / `source_documents.pages_total`(**NULL 可** — PDF count phase 前・`col IS NULL OR col >= 0`)/ `upload_records.pages_processed` / `study_days.review_count` / `study_days.correct_count` / `study_days.distinct_card_count` / `assets.byte_size` / `assets.width` / `assets.height` / `upload_operations.attempt_count` / `upload_operations.expected_source_count`

- `width` / `height` は **`> 0`**(承認済)、他は `>= 0`。
- 相関制約(`correct_count <= review_count` / `pages_processed <= pages_total`)は**張らない**: study_days は同一 SQL からの絶対値再集計で冗長、pages は PDF count phase の途中状態(`expected_source_count` 0 sentinel → CAS 確定)で一時不等が成立しうる。単列非負のみを対象と明記。

#### 命名規約と適用手順

- 制約名 = `<table>_<column>_<kind>`(`kind` = `enum` / `nonneg` / `positive`)。既存 4 本(`cards_state_range` / answer_events 3 本)は改名しない。
- 事前確認 SQL は diagnostic(違反行の PK + 実値を返す)。enum は `WHERE col IS NOT NULL AND col NOT IN (...)` + NULL 可列は NULL 件数を別掲。
- TOCTOU: 確認と DDL の間に webhook(Stripe/Clerk)書込が入りうるが、`ADD CONSTRAINT` は既存行を検証しながらロックを取るため、すり抜け行があっても **DDL 自身が失敗して安全側**。事前確認は「失敗を事前に知る」ためで正しさの根拠ではない(runbook 明記)。`NOT VALID` → `VALIDATE` 2 段はユーザー 0・行数僅少のため採らない(YAGNI)。

### 5.3 entity_mutations outbox(client)の owner-scope 化

Step 0 再確認: `lib/sync/entity-mutations.ts` に user 参照ゼロ / `runGuardedEntityMutationFlush` も userId 無し(`entity-mutation-flush.ts:44`)。answer_events(Sprint A)と同型の穴。**wire payload は変えない**(server は従来どおり auth 由来 `user.id` のみを信頼 — 認可境界は不変。owner-scope は client の誤送信防止)。

**Dexie version 設計**(r2 の曖昧さを確定): 現 head v10。

- **v11**: `{ user_settings: null, entity_mutations: null }`(2 つの drop を 1 version に同居)
- **v12**: `{ entity_mutations: '++local_id, &mutation_id, [user_id+sync_status]' }`(v9→v10 前例どおり drop→create を 2 version に分割。Dexie は同一 version 内で同名 store の drop+create を表現できない)
- 旧 store の index 棚卸し(非持越の根拠): `[entity_type+entity_id]` は宣言のみで coalesce は in-memory scan(`entity-mutations.ts:76-85`)= 読み手ゼロ / 単独 `sync_status` は全 query が owner-scope 化で `[user_id+sync_status]` に移行 / `mutation_id` は `modifyByKeys` の `where('mutation_id').anyOf(...)`(`outbox-ops.ts:47-52`)が要るため維持し、v10 の `&event_id` 前例に合わせ **`&` unique 化**(冪等キーの store 側強制)。
- **pending 喪失の受容**(承認済・裁定 5): v11 の drop で端末残留の未同期 mutation は失われる。ユーザー 0 前提。upgrade transaction 内での user_id 補完は採らない(補完不能行の扱いが複雑化)。

**コード変更**:

- `ClientEntityMutation` に `user_id: string` 追加(outbox metadata 側・envelope には足さない)
- 選別・遷移の owner-scope 化: `getPendingEntityMutations(userId)` / enqueue の coalesce scan / `dropStalePendingEntityMutations(userId, ...)` を `[user_id+sync_status]` query に。synced / failed / attempted 化は owner-scope select で確定した mutation_id 集合に閉じる(answer_events と同じ設計 — UUID key ゆえ update 側の追加 user 述語は不要)
- `enqueueEntityMutation` input に `user_id` 必須追加。呼出元 = `runOptimistic*` 3 経路(`optimistic-mutation.ts:100,189,279`)/ `tag-crud.ts` / `reorder-handlers.ts:59,111` — いずれも編集対象 mirror 行が `user_id` を保持しており、そこから供給
- `flushAllPendingEntityMutations(userId, client?)` / `runGuardedEntityMutationFlush(userId, deps?)` 化。呼出 production 14 箇所(`optimistic-mutation.ts:110,199,291` / `use-card-options.ts:204,287` / `reorder-handlers.ts:80,128` / `inline-text-field.tsx:222` / `upload.ts:775,812,850` / `category-row.tsx:120` / `option-row.tsx:159` / `entity-mutation-flush-trigger.tsx:93`)に userId を供給。trigger は `ReviewFlushTrigger` と同型の props 化(`layout.tsx:65` で `user.id` 供給済・`:72` に同じ値を渡すだけ)
- `collectBlockedImageMutationIds` は pure(入力が既に owner-scope)/ media_assets の uploading gate は asset UUID の大域一意性により user-scope 不要(既存 comment `entity-mutations.ts:273-276` のまま)
- logout / user 切替: 他 user の行は残置され、その user の flush だけが拾う(answer_events と同じ意味論)。userId 取得不能時の新分岐は作らない(認証済 layout 配下でのみ mount される既存前提を維持)
- 認証主体と mirror 行 `user_id` の一致(Codex r3 独立 8 への応答): mirror の読み経路が全て user-scoped query(`[user_id+...]` index / where 句)である既存構造により、UI が編集対象にできる行 = 認証主体の行。enqueue に別 user の user_id が来る経路は構造的に無く、不一致検査の新設はしない
- `&mutation_id` unique 化の衝突(Codex r3 指摘 11 への応答): mutation_id は enqueue / coalesce とも `newId()`(UUIDv4)採番で、同 id の二重 add は構造的に起きない。ConstraintError の新規 handling は作らない

**upgrade 経路の検証手段**(Sprint A で「既存 DB への upgrade path は自動 test で走らない」と確定済みのため、本 sprint で新設する):

1. **自動 test(新規)**: fake-indexeddb(導入済・`vitest.setup.ts`)上で、素の Dexie に `version(10)` + v10 累積 schema を宣言して DB 名 `recallmint` を構築 → user_settings 行・旧 shape の entity_mutations pending 行・exams 行を seed → close → `new ClientDb()` を open して v11/v12 upgrade を実走 → assert: user_settings store 不在 / entity_mutations 空 + 新 index 集合(`Table.schema` で検証)/ 無関係 store(exams)のデータ残存。新規空 DB が最終 schema で作成できることも同 file で pin。**feasibility(fake-indexeddb での versioned 再 open)は plan 先頭 task で spike**し、不成立なら手段 2 を正とする。
   - v10 fixture の drift 懸念(Codex r3 指摘 10)への応答: 過去 version の schema は**不変の歴史的事実**であり、fixture は `client-db.ts` の v1〜v10 宣言から一度きり転記して凍結する(以後の v13+ 追加でも fixture は変わらない)。転記の正確性は review で照合。
   - v11 中間停止・upgrade 失敗(Codex r3 指摘 9)への応答: v11/v12 は同一 open で連続適用され、IDB の versionchange tx は失敗時に原子的 rollback → 再 open で再実行される(IDB 保証に依拠)。中間状態専用の handling は作らない。
2. **stg 実機 smoke(DevTools MCP)**: deploy 前に stg で現行 app を開き v10 DB を作る → deploy 後 reload → IDB inspect(store 集合・index・console error 無し)を証拠つきで記録。観点に **2 タブ同時 open(旧 version 保持タブがある状態の upgrade blocked → 解消)** を含める(Codex r3 指摘 9 の部分採用。専用 versionchange handler の新設は既存 v1〜v10 と同リスクのため scope 外)。

### 5.4 stale comment 一掃(schema.ts 内 TS comment)

| 箇所 | 現状 | 修正 |
|---|---|---|
| `schema.ts:3-7` | user cascade が発火する前提の説明 | §4 のとおり書き直し(`:1` の表数 23 は**是正済みを確認** — r2 の当該項目は削除) |
| `schema.ts:758,782-783` | 「reference_count / unreferenced_at は dormant」 | `unreferenced_at` は GC v2 中核に昇格済(`asset-state.ts` / `asset-gc.ts` / `publish-prepared.ts` が読む)。`reference_count` は §3.1 で削除 → 一文ごと書換 |
| `schema.ts:511` | 「DB INSERT 実装は Sprint A-3+」 | 実装済(`contact.ts:86`)に修正 |
| `schema.ts:360-361` | 「inline base64 のみ・R2 非経由」 | ②-4b で PDF は `src/` prefix 一時保存 — 現状に合わせる |
| `schema.ts:829-839` | source_document_id の nullable 名残 + SET NULL 意図 | §5.1 の形(NOT NULL + cascade)に書換 |
| `schema.ts:240-244` ほか | card_count の非正規化説明 | 列削除に伴い削除(§3.1 の comment 波及と同時) |

---

## 6. 消える歪みとの対応表(第 3 弾 §8)

| # | 歪み | 扱い |
|---|---|---|
| 1 | user_id CASCADE 不発 | **誤説明のみ解消**(機構は意図的維持・§4) |
| 2 | archived_at dead 分岐 | **解消**(§3.1) |
| 3 | card_count 無駄 bump | **解消**(§3.1。cascadeLike は保守的維持・§8-2) |
| 4 | W-only 表 4 + 準 1 | **意図未記録の解消**(全て維持裁定・ai_usage_users の理由を §4 で記録) |
| 5 | schema comment stale 群 | **解消**(§5.4。表数は是正済み確認) |
| 6 | mode 用途消滅 + ocr_cost write-only | **解消**(§3.1) |
| 7 | CHECK 全面ゼロ | **部分解消**(27 本・§5.2。相関制約は非対象) |
| 8 | 列複写 | **解消**(§3.1) |
| 9 | assets (user_id, hash) 非 UNIQUE | **非スコープ**(§7) |
| 10 | 未使用 index 群 | **解消**(3 本・§3.3。残 4 本は Sprint A で表ごと消滅済) |
| 11 | Dexie user_settings 死 store | **解消**(§3.2) |
| 12 | upload_operations.exam_id CASCADE で冪等 ledger 消滅 | **残す**(裁定に無し。exam 削除後の再送は exam_not_found で実害薄) |
| 13 | 匿名 contact_messages の PII | **残す**(公開前判断として管理 — 記録先の現況は Codex 指摘 13 の乖離があるため、実装時に architecture.md 残余リスク一覧へ 1 行あることを確認し、無ければ追記) |
| 14 | stripe/clerk_events 無期限蓄積 | **残す**(保持方針未決・実害薄) |
| 15 | source_document_id 名残 nullable | **解消**(§5.1・FK action 変更込み) |

残る歪み = #12 / #13 / #14(記録のみ)。

---

## 7. 非スコープ(明記)

- `assets (user_id, hash)` UNIQUE 化 — トリガー = image dedup の実機能化(同 hash の正当な複数 asset を弾く恐れ)
- `cards` の 3 責務分割 / FSRS 状態別表化 — トリガー = LMS 着手
- 死表の DROP は無し(W-only 表は全て維持裁定)
- 相関 CHECK / `NOT VALID`→`VALIDATE` 2 段 — §5.2 の理由
- `entity_mutations` の (user_id, mutation_id) 複合 UNIQUE 化 — グローバル UNIQUE + dedupe の `eq(userId)` 併用(`route.ts:126-131`)で cross-user 誤 skip は起きない。server 認可境界は auth 由来 `user.id` のまま
- `exams (user_id, name)` UNIQUE / distinct 集計の式 index(第 3 弾 §9.3 の要否判断 2 件)— 裁定一覧に無し = 現状維持と解釈
- `card.create` の cascadeLike 撤去(並列化の挙動変更)— §8-2 のとおり別判断へ

---

## 8. OT 確認点(本 spec で新規 — r2 の 5 件は承認済み・再掲しない)

1. **FK action の変更(§5.1)**: `upload_operations.source_document_id` の `ON DELETE SET NULL` → `CASCADE`。NOT NULL 化の健全性に必須(SET NULL 発火 = NOT NULL 違反で退会・exam 削除が壊れうる)。「source doc 削除後も操作記録を残す」旧意図は、単独削除経路ゼロの現物では既に空洞。**承認可否**。
2. **`card.create` の `cascadeLike: true` を保守的維持(§1.10-2)**: 根拠だった card_count bump は消えるが、flag 撤去 = bulk 並列化の挙動変更で本 sprint の scope 外。comment を「根拠消滅・保守的維持」に書き換えて残す。**維持で良いか(撤去は別 task 起票か)**。
3. **deploy 順序の受容(§9)**: code deploy → migrate の窓で、新 code の upload 系 INSERT(mode / filename / file_size_bytes が NOT NULL default 無し)が一時失敗する。ユーザー 0 で受容し、drain 条件(processing / prepared 0 件 + 旧 function 生存上限)を待って migrate する運用で良いか。中間 migration(先に NOT NULL 緩和)を挟む 3 段方式は取らない(YAGNI)。

補足: 確認点 1 の承認には、architecture.md への FK 不変条件の反映(「upload_operations は source_documents と生死を共にする / 単独削除経路の新設時は保持方針を再判断」)と、§6-13 の残余リスク一覧の記載確認(無ければ 1 行追記)を含む(Codex r3 指摘 21 の範囲整理)。

## 9. 進め方・完了条件

- **migration 0036 構成**: `DROP COLUMN` ×13 / `DROP INDEX` ×3 / FK 張替(DROP+ADD CONSTRAINT)×1 / `SET NOT NULL` ×1 / `ADD CONSTRAINT CHECK` ×27。表の DROP/CREATE 無し = policy/grant は落ちない(生じたら Sprint A runbook 形式を踏襲)。drizzle-kit generate 1 回に収め、snapshot/journal と schema.ts の no-diff を gate。
- **適用順** = code deploy → drain 確認 → migrate。
  - migrate 先行が不可の理由: 旧 code の Drizzle select は削除列を明示列挙するため、読み経路(exam 一覧等)が全面的に壊れる。
  - code 先行の代償(§1.10-4): 窓の間、新 code の source_documents / upload_records INSERT が 23502 で失敗(upload のみ・読みは無傷)。ユーザー 0 で受容(§8-3)。
  - **drain 条件**(旧 deployment の残存 invocation 対策): 新 deployment ACTIVE 確認後、`SELECT count(*) FROM upload_operations WHERE status IN ('processing','prepared')` = 0 **かつ** 直近 deploy から Function 上限(900s)経過を確認してから migrate。**`prepared` を含める理由**(Codex r3 指摘 17 から導出): prepared 残があると publish 経路が upload_records へ filename 等を INSERT するため、窓を跨ぐ publish が新旧どちらの組でも失敗する。旧 code の残存 OCR invocation も migrate 後に削除列 INSERT で失敗するため、両 status ゼロを確認してから適用する。
  - 窓の間は OT(唯一の利用者)が upload / publish 操作をしない、を runbook 手順に明記する。maintenance UI / 受付停止機構は作らない(ユーザー 0 に対して過剰・YAGNI — Codex r3 指摘 16 は部分採用)。
  - migrate 後の code rollback 不可(DROP COLUMN 不可逆)。適用前に pg_dump(stg は任意・prod は必須)。drizzle migrate は file 単位 tx = 部分適用は残らない(適用失敗時はエラー解消まで再実行、rollback はしない)。
  - Dexie v11/v12 は code deploy と同時に不可逆(訪問ブラウザから順次 upgrade)。
- **runbook**(新規 `docs/ops/sprint-b-db-cleanup-runbook.md`): CHECK 27 本の diagnostic SQL(PK + 実値・NULL 可列の NULL 件数別掲)/ source_document_id null 0 確認 / 適用順と drain 条件 / TOCTOU の位置づけ / バックアップと停止点(prod 適用時は restore 検証済み backup を前提にする・Codex r3 指摘 18)/ migration session の `lock_timeout` / `statement_timeout` 明示設定(行数僅少だが hang 時に fail-fast させる・Codex r3 指摘 6)/ **postflight 照合 SQL**(pg_catalog から削除列の不在・index 不在・FK action・NOT NULL・CHECK 27 本の validated を一括確認・Codex r3 指摘 19)/ `/api/exams/status` の DISTINCT ON query が `source_docs_user_exam_created_idx` を使うことの EXPLAIN 1 本(index 削除後の実 PG 確認・Codex r3 指摘 15)。
- **test 追随は同 commit・削除で green にせず置換 pin を置く**: archived 条件なしで exam 一覧・upload が動く / 件数は Dexie 動的集計で card create・delete 後も正しい / 別 owner の mutation を flush・synced 化しない / Dexie upgrade(§5.3 手段 1)/ CHECK の境界値・NULL・違反値(iso)/ #11・#12 の集合一致 pin(iso)/ NOT NULL 違反 + FK cascade(iso)/ §2 の分類 matrix(unit + 両 route)+ 400 → pending 残置(両 outbox)/ 空 DB と Sprint A 適用済み DB の双方に 0036 が適用可能(iso 起動が空 DB 適用を兼ねる)。
- **完了条件**: whole-repo lint 0 / `pnpm test` / `pnpm test:iso` green / `pnpm run audit` 0 / `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` 0 / migration no-diff / canonical + Codex review で Critical 0・Important 0 → `[reviewed]` / docs 波及(architecture.md: archived gate 受容 1 行 + FK cascade 変更の不変条件反映 + 「残る pending は transient のみ」への既知例外追記(§2)+ 第 3 弾 §9 へ「本 sprint で解消」注記 + 残存 #12/#13/#14 明示 + sessions 実施記録)。
