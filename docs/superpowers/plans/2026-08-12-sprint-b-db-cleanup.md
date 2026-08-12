# Sprint B — DB 全体掃除 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** spec r4(`docs/superpowers/specs/2026-08-12-sprint-b-db-cleanup-design.md`・凍結済)の一掃を、常時 green の 9 task で実装する。

**Architecture:** 先に schema 非依存の独立 task(§2 分類 / FlushResult / 読み手・書き手の code 側掃除 / owner-scope 化)で参照を絶ち、migration 0036 は**1 task・1 generate**に集約する。NOT NULL default 無しの列(mode / filename / file_size_bytes)の writer 撤去は 0036 と同 commit(それ以外の code 掃除は先行可能 — 列が残っていても未参照なら無害)。

**Tech Stack:** Drizzle(`pnpm db:generate --name=...` / `db:migrate`)/ Dexie + fake-indexeddb / Vitest + `pnpm test:iso`(実 PG)。

## Global Constraints(全 task に適用・spec 冒頭と同一)

- spec r4 は凍結。仕様変更が要る事態は停止して OT 相談。
- 各 feat task = canonical review(superpowers:requesting-code-review 既定経路)pass → Codex(`scripts/ai/codex-review.sh <topic>`)Critical 0・Important 0 → `[reviewed]` commit。test-only task は増減分岐(Task 8 参照)。
- 削除で green にしない — 置換 pin(下表)を同 task で置く。`--no-verify` 全面禁止。
- ユーザー 0 前提(破壊 upgrade・deploy 窓の受容は裁定済み)。実 API 禁止・AI 呼び出しは mock。
- schema comment は TS comment(schema.ts)が正本。`COMMENT ON` 導入しない。

## 置換 pin 対応表(削除 → それを置き換える保証)

| 削除 | 置換 pin(置き場所) |
|---|---|
| `exams.archived_at` 読み手分岐 | 一覧が archived 条件なしで user 全 exam を返す(`list.ts` test)/ `submit-upload` が存在 exam へ受理・不在は `exam_not_found`(`archived` discriminator 無しの戻り形)/ client filter 無しで全件表示(`exam-list-live` test) |
| `exams.card_count` + bump | create / delete が cards 行の insert/delete **のみ**行う(`apply-card-mutation` test から bump assert を除去し「exams を UPDATE しない」を pin)/ 件数表示は Dexie 動的集計(既存 `exam-list-live` test 継続 green) |
| `exams.question_no_format` | pull mapper の出力 shape に field が無い(`exams-pull` test の shape assert 更新) |
| `upload_records` の 3 列 + `source_documents.mode` / `ocr_cost_yen` | upload_records insert が `{ userId, pagesProcessed, status }` のみ(persistence / publish / reconcile の各 test)/ 月次 quota SUM 不変(`ai-usage-mcq` 既存 test 継続 green) |
| Dexie `user_settings` store | upgrade test で store 不在 + 他 store データ残存(Task 6) |
| `FlushResult` 3 field | `classifyFlushResults` が残 3 field(synced/failed/httpStatus)で全 outcome を分類(既存 test の fixture 縮小で継続 green) |
| index 3 本 | op registry / ASSET_STATUSES の集合一致 pin + status polling の EXPLAIN(Task 8) |
| null 分岐 3 file | NOT NULL 型化で TS が不在を強制 + iso の 23502 pin(Task 8) |

---

### Task 1: Dexie upgrade spike(feasibility・plan 先頭)

- 目的: fake-indexeddb 上で「素の Dexie に `version(10)` + v10 累積 schema で DB 名 `recallmint` を構築 → seed → close → `new ClientDb()`(v12 宣言)open」で upgrade が実走するかを実証する(spec §5.3 検証手段 1 の前提)。
- 制約: scratch test file 1 本のみ(`lib/client-db.upgrade.test.ts` の雛形を兼ねる)。現行 ClientDb は変更しない。v10 fixture は `client-db.ts` v1〜v10 宣言から転記(過去 version は不変の歴史的事実 — 一度きり)。
- 分岐(spec 確定): **成立** → Task 6 の自動 upgrade test を正とし本 file を発展させる / **不成立** → stg 実機 smoke(DevTools MCP・2 タブ観点込み)を upgrade 検証の正とし、Task 6 から自動 test を落として plan 注記を更新(OT へ 1 行報告)。
- 完了条件: 判定と根拠(実行 log)を chat 報告。成立時のみ雛形を Task 6 で commit(本 task 単独 commit なし)。

### Task 2: classifyBulkError の 400 到達可能化(spec §2・独立)

- 目的: `PERMANENT_PG_CODES = {23514, 23502, 22P02, 22001, 22003}` を新設し `classify-bulk-error.ts` の `.code` 判定層に追加。42xxx / 23503 / 23505 / 未知は transient のまま。
- 制約: ZodError 先行・cause 再帰・depth 上限・default transient は不変。両 route のコード変更なし(分類だけで 400 が到達可能になる)。file 冒頭 comment の「列の育て方」を維持し、permanent 側にも同方針を追記。
- test: unit matrix(5 code → permanent-4xx / 42601・42703・42P01・42883 → transient / 23503・23505 → transient / 未知 → transient / DrizzleQueryError と素の cause chain / ZodError 優先 / depth 上限)+ 両 route test(permanent code → 400 `invalid_payload`・42xxx → 503・未知 → 503)+ client pin(400 応答で pending 残置・synced/failed 無変更を両 outbox の既存 test に追加)。
- 完了条件: 上記 test green + whole lint 0 + canonical・Codex Critical/Important 0 → `[reviewed]`。

### Task 3: FlushResult 3 field 撤去(spec §3.4・独立)

- 目的: `sessionSynced` / `reachable` / `attempted` を `FlushResult` 型・`noFlushResult()`・両 flush 実装(`review-events.ts` / `entity-mutations.ts`)から撤去。
- 制約: `classifyFlushResults` のロジック不変(残 3 field のみで判定済み・spec §1.10-8)。test fixture の 3 field 参照を除去。
- 完了条件: `pnpm test` green(flush / flush-trigger / review-flush 系)+ `[reviewed]`。

### Task 4: exams.archived_at の読み手撤去 + 置換 pin(schema 未変更)

- 目的: spec §3.1 の archived_at 行の全読み手分岐を削除(list.ts / submit-upload.ts の reject 分岐と `archived` discriminator / upload-form.tsx:976 / upload-error-types comment / exam-detail-view / page.tsx / exam-list-live / exams-pull mapper / ClientExam)。
- 制約: schema.ts の列は残す(未参照の列は無害・DROP は Task 7)。挙動変更は「archived 概念の消滅」のみ — 置換 pin 対応表 1 行目を同 task で置く。
- 完了条件: 置換 pin green + `pnpm test` green + `[reviewed]`。

### Task 5: card_count / question_no_format の code 側掃除(schema 未変更)

- 目的: `card-count.ts` file 削除 + bump 呼出 3 箇所(apply-card-mutation ×2 / upload-persistence:52)+ seed(`seed-perf-exam.ts:490,651`)+ `exams-pull.ts:17,19` mapper + `ClientExam` の 2 field 撤去。comment 波及(publish-prepared:108,203 / inline-card-list / delete-card-button / create-exam:14)。
- 制約: `card.create` の `cascadeLike: true` は**維持**し、registry comment を「根拠(card_count bump)は消滅・並列化再検証まで保守的維持」(card.delete は card_count 言及のみ除去)に書換(裁定済)。apply-card-mutation の delete 側 step 1 の examId 取得が bump 専用なら縮小。
- 完了条件: 置換 pin 対応表 2〜3 行目 green + registry の 9 op / 4 cascadeLike enumerate test 不変 green + `[reviewed]`。

### Task 6: entity_mutations owner-scope 化 + Dexie v11/v12(spec §3.2 / §5.3)

- 目的: `client-db.ts` に v11 `{ user_settings: null, entity_mutations: null }` / v12 `{ entity_mutations: '++local_id, &mutation_id, [user_id+sync_status]' }` を追加し、`ClientUserSettings` 削除・`ClientEntityMutation` に `user_id: string` 追加。outbox の選別・coalesce・stale 隔離を `[user_id+sync_status]` に、synced/failed/attempted 化は owner-scope select で確定した id 集合に閉じる(answer_events と同設計)。
- Interfaces(後続と reviewer が依存): `enqueueEntityMutation(input: EnqueueEntityMutationInput & { user_id: string })` / `getPendingEntityMutations(userId: string)` / `dropStalePendingEntityMutations(userId, now, maxAgeMs)` / `flushAllPendingEntityMutations(userId: string, client?)` / `runGuardedEntityMutationFlush(userId: string, deps?)` / `EntityMutationFlushTrigger({ userId }: { userId: string })`(`layout.tsx:72` に `user.id` を渡す)。
- 制約: wire payload に user_id を載せない(server 認可境界不変)。呼出 14 箇所(spec §5.3 列挙)へ userId を供給 — mirror 行 / props 由来。ConstraintError の新規 handling・userId 不能分岐・versionchange handler は作らない(spec で非採用確定)。
- test: owner-scope pin(別 owner の pending を flush・synced 化しない / coalesce が owner を跨がない)+ Task 1 成立時は upgrade test(v10 構築 → v12: user_settings 不在・entity_mutations 空 + 新 index・exams データ残存・新規空 DB 作成)。
- 完了条件: 上記 test green + `pnpm test` green + `[reviewed]`。

### Task 7: migration 0036 + schema.ts 一括編集(1 generate)

- 目的: schema.ts を spec §3.1 / §3.3 / §5.1 / §5.2 / §5.4 / §4 どおり一括編集し、migration 0036 を 1 回の generate で得る。同 commit で「migration 無しでは落ちる」code を撤去: mode / filename / file_size_bytes / ocr_cost_yen の書込チェーン(completeUploadTx・markFailed の不要引数 / source-doc-status RETURNING 縮小 / publish-prepared insert 値と上流合算の要否確認)+ null 分岐 3 file(NOT NULL 型化で dead 化)。`asset-state.ts` に `ASSET_STATUSES as const` を追加し type 導出を反転(iso pin の前提・Task 8 が使う)。
- **生成手順**(spec §9): ① schema.ts 編集(DROP 列 13 / index 3 / FK `references(..., { onDelete: 'cascade' })` + `.notNull()` / `check()` 27 本 = `<table>_<column>_<enum|nonneg|positive>`、NULL 可は `col IS NULL OR ...` 形)② `pnpm db:generate --name=sprint_b_db_cleanup`(0033 の命名慣行)③ 生成 SQL を目視: DROP COLUMN ×13 / DROP INDEX ×3 / FK DROP+ADD CONSTRAINT(ON DELETE cascade)/ SET NOT NULL ×1 / ADD CONSTRAINT CHECK ×27 **のみ**で、表 DROP/CREATE が無いこと(あれば停止・OT 相談)④ 再度 `pnpm db:generate` が **no-diff**(snapshot/journal ↔ schema.ts 整合)⑤ `pnpm test:iso`(空 DB への 0036 適用を兼ねる)。
- 制約: 手動 SQL 編集はしない(generate 出力が spec の DDL 構成と一致しない場合は schema.ts 側で直す)。iso fixture(`fixture-completeness` / seed helper)の削除列参照を同 commit で追随。
- 完了条件: `pnpm test` + `pnpm test:iso` + `pnpm typecheck` + `pnpm build` green / no-diff 確認 / 置換 pin 対応表 4 行目 green / `[reviewed]`。

### Task 8: 検証群(test-only・保証「増」)

- 目的: iso(実 PG)に spec §9 の検証を置く: CHECK 27 本の境界値・NULL・違反値(violate INSERT が 23514 / NULL 可 2 列 + pages_total の NULL 通過)/ **集合一致 pin 2 本**(`entity_mutations_op_enum` ↔ registry op key 集合・`assets_status_enum` ↔ `ASSET_STATUSES`)/ FK 削除 3 経路(exam cascade・退会 handler・source_documents 直接 DELETE → upload_operations 残ゼロ)/ `source_document_id` の NOT NULL 違反 23502 / status polling query の EXPLAIN が `source_docs_user_exam_created_idx` を使う確認。
- 制約: test-only「増」= **red 検証必須**(gate を**個別に**変異 — 例: CHECK 1 本を schema から外して当該 test だけが fail するのを migration 適用前 DB 等で実証。まとめ壊し禁止)+ 簡易 review(Codex 可)。commit message に「red 検証」記録行。
- 完了条件: `pnpm test:iso` green + red 実証記録 + `[reviewed]`。

### Task 9: runbook + docs 波及 + sprint 完了 gate

- 目的: `docs/ops/sprint-b-db-cleanup-runbook.md` 新規(spec §9 の全項目: diagnostic SQL 27 本 / null 0 確認 / 適用順 = code deploy → drain(`status IN ('processing','prepared')` 0 件 + 900s・窓中 OT 無操作)→ migrate / lock_timeout・statement_timeout / postflight pg_catalog 照合 / backup と停止点 / TOCTOU 位置づけ / Dexie 不可逆注記)。architecture.md 3 点(archived gate 受容 / FK 不変条件 = upload_operations は source_documents と生死共有・単独削除経路新設時は再判断 / 「残る pending は transient のみ」への既知例外)+ 第 3 弾 §9 へ解消注記 + 残存 #12/#13/#14(#13 は残余リスク一覧の記載確認・無ければ 1 行)+ sessions 実施記録。
- 完了条件(sprint 完了 gate): whole-repo `pnpm lint --max-warnings=0` exit 0 / `pnpm test` / `pnpm test:iso` green / `pnpm run audit` exit 0 / `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` exit 0 / docs commit(`[no-review]`)/ 完了報告に gate 3 行(lint / test:iso / audit)明記 → **停止・OT 判断待ち**(push・stg smoke は OT 指示後)。

---

## 実行順・commit 単位

Task 1(spike・commit なし)→ 2 / 3 / 4 / 5 / 6 は相互独立(各 1 commit・並列可だが SDD では逐次)→ 7(4・5 完了が前提: 読み手・書き手が消えてから列を落とす)→ 8 → 9。stg 反映(push → migrate → smoke: Dexie upgrade 実機 + upload 一巡)は sprint 完了後の OT 判断。
