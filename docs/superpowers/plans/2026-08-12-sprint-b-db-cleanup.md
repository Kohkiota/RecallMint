# Sprint B — DB 全体掃除 実装 plan(r2 — Codex cross-check 反映済み)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** spec r4(`docs/superpowers/specs/2026-08-12-sprint-b-db-cleanup-design.md`・凍結済)の一掃を、常時 green の 9 task で実装する。

**Architecture:** 先に schema 非依存の独立 task(§2 分類 / FlushResult / 読み手・書き手の code 側掃除 / owner-scope 化 / comment 一掃)で参照を絶ち、migration 0036 は **1 task・1 generate** に集約する。NOT NULL default 無しの列(mode / filename / file_size_bytes)の writer 撤去は 0036 と同 commit(他の code 掃除は先行可 — 未参照の列は残っていても無害)。iso 検証群は migration task 内で **red-first**(0036 適用前は自然に fail)で書き、人工的な gate 変異による red 検証は行わない(Codex plan 指摘 2/3 反映)。

**Tech Stack:** Drizzle(`pnpm db:generate --name=...` / `db:migrate`)/ Dexie + fake-indexeddb / Vitest + `pnpm test:iso`(実 PG)。

## Global Constraints(全 task に適用)

- spec r4 は凍結。生成 DDL が spec の構成にならない等、仕様に触る事態は停止して OT 相談(custom SQL migration の採用は OT 裁定事項)。
- 各 feat task = canonical review(superpowers:requesting-code-review 既定経路)pass → Codex(`scripts/ai/codex-review.sh <topic>`)Critical 0・Important 0 → `[reviewed]` commit。
- 削除で green にしない — 置換 pin(下表)を同 task で置く。`--no-verify` 全面禁止。
- ユーザー 0 前提(破壊 upgrade・deploy 窓は裁定済)。AI 呼び出しは mock。schema comment は TS comment が正本(`COMMENT ON` 不使用)。

## 置換 pin 対応表(削除 → それを置き換える保証)

| 削除 | 置換 pin(置き場所) |
|---|---|
| `exams.archived_at` 読み手分岐 | 一覧が archived 条件なしで user 全 exam を返す(`list.ts` test)/ `submit-upload` が存在 exam へ受理・不在は `exam_not_found`(`archived` discriminator 無しの戻り形)/ client filter 無し全件表示(`exam-list-live` test) |
| `exams.card_count` + bump | create / delete が cards 行の insert/delete **のみ**行う(`apply-card-mutation` test を「exams を UPDATE しない」pin に置換)/ 件数は Dexie 動的集計(既存 `exam-list-live` test 継続 green) |
| `exams.question_no_format` | pull mapper の出力 shape に field が無い(`exams-pull` test の shape assert 更新) |
| `upload_records` 3 列 + `source_documents.mode` / `ocr_cost_yen` | upload_records insert が `{ userId, pagesProcessed, status }` のみ(persistence / publish / reconcile の各 test)/ 月次 quota SUM 不変(`ai-usage-mcq` 既存 test 継続 green) |
| Dexie `user_settings` store | upgrade test で store 不在 + 他 store データ残存(Task 6) |
| `FlushResult` 3 field | `classifyFlushResults` が残 3 field で全 outcome を分類(既存 test の fixture 縮小で継続 green) |
| index 3 本 | **DROP 直前の query 不在 re-grep**(Task 8 の step・調査時点からの drift 防止)+ `source_docs_user_exam_created_idx` の EXPLAIN は **stg runbook 側**(小規模 fixture の planner は seq scan を選び flaky・Codex plan 指摘 5) |
| CHECK 対象 2 列の既存「CHECK 無し」宣言 | 語彙集合(registry op key / `ASSET_STATUSES`)から**受理/拒否 INSERT を動的生成**する iso pin(`pg_get_constraintdef` の文字列解析はしない・Codex plan 独立 11) |
| null 分岐 3 file | NOT NULL 型化で TS が不在を強制 + iso の 23502 pin(Task 8) |

---

### Task 1: Dexie upgrade spike(feasibility・plan 先頭)

- 目的: fake-indexeddb 上で「素の Dexie に `version(10)` + v10 累積 schema で DB 名 `recallmint` を構築 → seed → close → `new ClientDb()`(v12 宣言)open」で upgrade が実走するかを実証(spec §5.3 検証手段 1 の前提)。
- 制約: scratch test file 1 本(`lib/client-db.upgrade.test.ts` 雛形を兼ねる)。現行 ClientDb は変更しない。v10 fixture は `client-db.ts` v1〜v10 から転記(過去 version は不変 — 一度きり)。test は専用 file(vitest の per-file 隔離で fake-indexeddb は干渉しない)。
- 分岐(spec 確定): **成立** → Task 6 の自動 upgrade test を正とし本 file を発展 / **不成立** → stg 実機 smoke(DevTools MCP・2 タブ観点込み)を正とし、Task 6 から自動 test を落として plan 注記を更新(OT へ 1 行報告)。不成立時は spike file を破棄(未 commit)し判定 log を session doc へ。
- 完了条件: 判定と根拠(実行 log)を chat 報告。本 task 単独の commit なし。

### Task 2: classifyBulkError の 400 到達可能化(spec §2・独立)

- 目的: `PERMANENT_PG_CODES = {23514, 23502, 22P02, 22001, 22003}` を新設し `classify-bulk-error.ts` の `.code` 判定層に追加。42xxx / 23503 / 23505 / 未知は transient のまま。
- 制約: ZodError 先行・cause 再帰・depth 上限・default transient は不変。両 route のコード変更なし。「列の育て方」comment を permanent 側にも追記。**architecture.md の「残る pending は transient のみ」への既知例外 1 行を同 commit で更新**(コードと文書の意味論を跨ぎ commit で矛盾させない・Codex plan 指摘 18)。
- test: unit matrix(5 code → permanent-4xx / 42601・42703・42P01・42883 → transient / 23503・23505 → transient / 未知 → transient / DrizzleQueryError と素の cause chain / ZodError 優先 / depth 上限)+ 両 route test(permanent code → 400 `invalid_payload`・42xxx → 503・未知 → 503)+ client pin(400 応答で pending 残置・synced/failed 無変更を両 outbox で)。
- 完了条件: 上記 test green + `[reviewed]`。

### Task 3: FlushResult 3 field 撤去(spec §3.4・独立)

- 目的: `sessionSynced` / `reachable` / `attempted` を `FlushResult` 型・`noFlushResult()`・両 flush 実装(`review-events.ts` / `entity-mutations.ts`)から撤去。
- 制約: `classifyFlushResults` のロジック不変(残 3 field のみで判定済・spec §1.10-8)。test fixture の 3 field 参照を除去。
- 完了条件: `pnpm test` green + `[reviewed]`。

### Task 4: exams.archived_at の読み手撤去 + 置換 pin(schema 未変更)

- 目的: spec §3.1 archived_at 行の全読み手分岐を削除(list.ts / submit-upload.ts の reject 分岐と `archived` discriminator / upload-form.tsx:976 / upload-error-types comment / exam-detail-view / page.tsx / exam-list-live / exams-pull mapper / ClientExam)。
- 制約: schema.ts の列は残す(DROP は Task 8)。挙動変更は archived 概念の消滅のみ — 置換 pin 対応表 1 行目を同 task で置く。
- 完了条件: 置換 pin green + `pnpm test` green + `[reviewed]`。

### Task 5: card_count / question_no_format の code 側掃除(schema 未変更)

- 目的: `card-count.ts` file 削除 + bump 呼出 3 箇所(apply-card-mutation ×2 / upload-persistence:52)+ seed(`seed-perf-exam.ts:490,651`)+ `exams-pull.ts:17,19` mapper + `ClientExam` 2 field 撤去 + comment 波及(publish-prepared:108,203 / inline-card-list / delete-card-button / create-exam:14)。
- 制約: `card.create` の `cascadeLike: true` は**維持**し registry comment を「根拠(card_count bump)消滅・並列化再検証まで保守的維持」に書換(裁定済・card.delete は card_count 言及のみ除去)。apply-card-mutation delete 側 step 1 の examId 取得が bump 専用なら縮小。
- 完了条件: 置換 pin 対応表 2〜3 行目 green + registry の 9 op / 4 cascadeLike enumerate test 不変 green + `[reviewed]`。

### Task 6: entity_mutations owner-scope 化 + Dexie v11/v12(spec §3.2 / §5.3)

- 目的: `client-db.ts` に v11 `{ user_settings: null, entity_mutations: null }` / v12 `{ entity_mutations: '++local_id, &mutation_id, [user_id+sync_status]' }` を追加、`ClientUserSettings` 削除・`ClientEntityMutation` に `user_id: string` 追加。選別・coalesce・stale 隔離を `[user_id+sync_status]` に、synced/failed/attempted 化は owner-scope select で確定した id 集合に閉じる(answer_events と同設計)。
- Interfaces(後続と reviewer が依存): `enqueueEntityMutation(input: EnqueueEntityMutationInput & { user_id: string })` / `getPendingEntityMutations(userId: string)` / `dropStalePendingEntityMutations(userId, now, maxAgeMs)` / `flushAllPendingEntityMutations(userId: string, client?)` / `runGuardedEntityMutationFlush(userId: string, deps?)` / `EntityMutationFlushTrigger({ userId })`(`layout.tsx:72` に `user.id`)。
- 制約: wire payload に user_id を載せない(server 認可境界不変 — client owner-scope は誤送信防止の best-effort と comment 明記)。呼出 14 箇所(spec §5.3 列挙)へ userId 供給。ConstraintError 新規 handling・userId 不能分岐・versionchange handler は作らない(spec 確定)。
- test: owner-scope pin(別 owner の pending を flush・synced/failed/attempted 化しない / stale 隔離が別 owner を跨がない / coalesce が owner を跨がない)+ 並走 flush の in-flight 排除既存 test 継続 + Task 1 成立時は upgrade test(v10 → v12: user_settings 不在・entity_mutations 空 + 新 index・exams データ残存・新規空 DB 作成)。
- 完了条件: 上記 green + **旧 API 残存ゼロの機械確認**(`rg "where\('sync_status'\)" lib` 等が entity_mutations 系で 0 件・Codex plan 指摘 9)+ `[reviewed]`。

### Task 7: schema comment 一掃 + ASSET_STATUSES tuple(DDL 無し)

- 目的: spec §4(ai_usage_users / contact_messages.status / stripe・clerk type / user_id CASCADE 冒頭書換)+ §5.4 の comment 修正(card_count 関連は Task 5 で処理済の残り)+ `asset-state.ts` に `export const ASSET_STATUSES = ['reserved','ready','deleting','deleted'] as const` を追加し `type AssetStatus = (typeof ASSET_STATUSES)[number]` へ導出反転(pure 維持・利用側無変更)。#11/#12 の「CHECK を張らない」宣言を「DB CHECK = backstop / アプリ層 = SSoT + 語彙追加 3 点更新 + CHECK 先行 deploy 順」へ書換。
- 制約: DDL・挙動変更なし(comment + 型導出の反転のみ)。Task 8 の migration diff から comment 変更を分離してレビュー精度を上げる(Codex plan 指摘 1 反映)。
- 完了条件: `pnpm typecheck` + `pnpm test` green + `[no-review]`(ロジック変更なし。ASSET_STATUSES は型等価の refactor — 保証不変)。

### Task 8: migration 0036 + iso 検証群(red-first・1 generate)

- 目的: schema.ts を spec §3.1 / §3.3 / §5.1 / §5.2 どおり編集し 0036 を 1 回の generate で得る。同 commit: mode / filename / file_size_bytes / ocr_cost_yen の書込チェーン撤去(completeUploadTx・markFailed の不要引数 / source-doc-status RETURNING 縮小 / publish-prepared insert 値と上流合算の要否確認)+ null 分岐 3 file 撤去 + iso fixture(fixture-completeness / seed helper)追随。
- **手順**: ① **iso 検証群を先に書き 0035 状態で red を記録**(CHECK 27 本の境界値・NULL・違反 23514 / 語彙集合からの受理・拒否動的生成 pin ×2 / FK 削除 3 経路で upload_operations 残ゼロ / NOT NULL 違反 23502)② **DROP 対象の query 不在 re-grep**(3 index + 13 列 — 調査時点からの drift 確認)③ schema.ts 編集(check() 27 本 = `<table>_<column>_<enum|nonneg|positive>`・NULL 可は `col IS NULL OR ...` / FK `{ onDelete: 'cascade' }` + `.notNull()` / 列・index 削除)④ `pnpm db:generate --name=sprint_b_db_cleanup` ⑤ 生成 SQL 目視: DROP COLUMN ×13 / DROP INDEX ×3 / FK DROP+ADD(ON DELETE cascade)/ SET NOT NULL ×1 / ADD CHECK ×27 **のみ**・表 DROP/CREATE 無し・constraint 名 / NULL 意味論が spec 一致(不一致は schema.ts 側で修正、表現不能なら停止 → OT 相談)⑥ 再 `pnpm db:generate` が**新 file を作らない** + `git status` clean(no-diff gate)⑦ `pnpm test:iso` で ① が green 化。
- 制約: 生成 SQL の手動編集禁止。red → green の実記録(① の fail log)を commit message に「red 検証」として残す(gate 個別変異は不要 — 適用前 red が自然な実証)。
- 完了条件: `pnpm test` + `pnpm test:iso` + `pnpm typecheck` + `pnpm build` green / no-diff / 置換 pin 対応表 4 行目 green / `[reviewed]`。

### Task 9: runbook + docs 波及 + sprint 完了 gate

- 目的: `docs/ops/sprint-b-db-cleanup-runbook.md` 新規: diagnostic SQL 27 本(PK + 実値・NULL 可列の NULL 件数)/ source_document_id null 0 確認 / 適用順 = code deploy → drain(`status IN ('processing','prepared')` 0 件 + Function 上限経過 — **上限値は vercel.json の現物から転記**・窓中 OT 無操作)→ `pnpm db:migrate` / **drain 不達時の分岐**(stuck operation は原因確認 → 既存 terminalize / reconcile 経路 or 手動 SQL で terminal 化、解消まで migrate 延期)/ lock_timeout・statement_timeout / postflight pg_catalog 照合 / backup と停止点(stg は任意・prod 適用 runbook は prod 反映判断時に別途)/ TOCTOU 位置づけ / Dexie 不可逆注記 / stg 適用が「データ入り 0035 → 0036」経路の実証を兼ねる旨 / `source_docs_user_exam_created_idx` の EXPLAIN(stg 実データ)。
- docs 波及: architecture.md 残 2 点(archived gate 受容 / FK 不変条件 = upload_operations は source_documents と生死共有・単独削除経路新設時は再判断)+ 第 3 弾 §9 へ解消注記 + 残存 #12/#13/#14(#13 は残余リスク一覧の記載確認・無ければ 1 行)+ sessions 実施記録。
- 制約: **runbook は commit 前に Codex 簡易 review を通す**(運用リスクが最も高い文書・Codex plan 指摘 11。他 docs は `[no-review]`)。
- 完了条件(sprint 完了 gate): whole-repo `pnpm lint --max-warnings=0` / `pnpm test` / `pnpm test:iso` / `pnpm run audit` / `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` 全 exit 0、完了報告に gate 3 行(lint / test:iso / audit)明記 → **停止・OT 判断待ち**。sprint 完了(code + docs)と deploy readiness(push → migrate → stg smoke: Dexie upgrade 実機 2 タブ + upload 一巡)は別 phase — 後者は OT 指示後。

---

## 実行順・commit 単位

Task 1(spike・commit なし)→ 2 / 3 / 4 / 5 / 6 / 7 は相互独立(各 1 commit・SDD では逐次)→ 8(4・5・7 完了が前提: 参照と comment が消えてから列を落とす)→ 9。

## Codex plan cross-check の非採用(理由つき・spec 凍結による)

expand-contract 3 段 / quarantine 状態の新設 / `[user_id+mutation_id]` 複合 UNIQUE / retention 実制御 / v11 中断・blocked の自動検証 / deploy compatibility test(新 code + 旧 schema の失敗確認 = 受容済み窓そのもの)— いずれも spec r4 で裁定・非採用確定済み。課金 3 列の相関非保証は spec §5.2 が明記済み。
