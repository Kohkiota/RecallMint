# 実 PostgreSQL 2 テナント統合テスト Implementation Plan

> **For agentic workers:** 実装は `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)。step は checkbox で追跡。

**Goal:** 常駐 PG17 に 2 テナントを置き、テナント隔離を **挙動として**(B の行が A の read/delta に混ざらない・A が B の行を write/delete できない・A 自身は成功する)検証する統合 suite を新設し、OCR 2 write の owner 述語欠落を fix する。

**Architecture:** `tests/integration/pg/` に専用 vitest config(**直列実行**)+ globalSetup(DB provision + 25 migration 適用)+ 集約 safety guard(DATABASE_URL hard-set + 全 URL allow-list)+ 2 テナント fixture + **三者一致**完全性 assertion。real `getDb()`(postgres-js/TCP/native PG)を通し auth seam のみ mock。既存 mock suite と物理・config 分離。

**Tech Stack:** PostgreSQL 17(devcontainer 常駐)/ postgres-js 3.4.9 + drizzle-orm 0.45.2 + `drizzle-orm/postgres-js/migrator`(既存)/ Vitest 4.1.5。**新 npm dep 追加なし。**

前提 spec: `docs/superpowers/specs/2026-07-18-tenant-isolation-integration-test-design.md`(Codex cross-check 反映済 = `docs/codex/2026-07-18-plan-iso1-tenant-isolation.md`)。

## Global Constraints(全 task 共通)

- **乗り物固定**: 常駐 PG17。`DATABASE_URL` 差替のみでアプリコード不変。**新 suite は `@/lib/db` を mock しない**(real getDb)。auth 経路のみ tenant 別 mock。
- **安全境界(集約 guard)**: URL 定数 + guard を 1 module に集約。`DATABASE_URL` を **hard-set(代入・`??=` 非依存)**。allow-list = URL 全体 parse で **protocol=postgres(ql) / host=`127.0.0.1` 固定 / port 固定 / DB 名=固定 `recallmint_test`(完全一致)** 以外は throw(parse 失敗・空 host・IPv6・想定外 port も throw)。**検査済 URL そのものを接続に使う**(TOCTOU 防止)。**globalSetup 自身も接続前に guard を呼ぶ**(setupFiles は globalSetup を保護しない)。
- **直列実行**: PG suite config は `fileParallelism: false` + 単一 fork。TRUNCATE+reseed の安全性はこれに依存。切替/teardown で `closeDb()`、DROP 前に `pg_terminate_backend`。
- **実行境界**: PG suite は `pnpm test`(既存 ~3765)から exclude。`pnpm test:iso` で実行(devcontainer cluster 必須)。sprint 完了 gate = whole-repo `pnpm lint` exit 0 + `pnpm test` 既存不変 + `pnpm test:iso` green。
- **anti-vacuous green(全 assertion 必須)**: ① **positive control**(A 自身の期待行が返る / A 自身の write・delete が成功)+ ② **negative**(A の結果に B の既知 id 0 件 / A から B への write・delete が 0 行かつ B 不変)の**対**。B の decoy は対象 query の **非 owner 条件(active/archivedAt/status/`since`/JOIN/timestamp 精度)を全て満たす**こと。
- **代表 RED(family 境界のみ)**: 構造共有 family(pull 6 stream=単一 `getDeltaRows`)は代表 1 本 + 完全性 assertion。**family 境界(read 混入/delta 混入/write 越境/delete 越境/OCR)は個別 RED**。RED は本番 owner `eq` を一時除去 →「**既知の B id が返った/B の既知 field が変わった/B 行が消えた**」を実測(単なる例外・件数変化での RED は不可)→ 復元。commit message に「red 検証」。multi-stage owner check(deleteExam)は変異段階を事前特定。
- **代表主義の限界(明記)**: 「代表 + 完全性」は *実装共有* family にのみ適用可。単なる SQL idiom コピー(実装非共有)は代表が他経路を保証しない。family 判定は「factory/共通 repository/共通 handler を実際に共有するか」で厳格化。
- **review/tag**: test 增分 = red 検証 + 簡易 review → `[reviewed]`。**OCR fix = `fix()` security 相当**(canonical `requesting-code-review` + Codex、Critical/Important 0 まで)。
- **簡潔性/DDD/YAGNI**: 最小実装・既存 pattern 準拠。RLS/migration 網羅化/webhook・operator behavioral 化はしない。
- **user_id 保持 19 table**(完全性母集団・全て seed): reviews / ai_usage_users / integration_failures / exams / cards / source_documents / upload_records / study_days / user_settings / contact_messages / study_sessions / answer_events / entity_mutations / tag_categories / tag_options / card_tags / tombstones / assets / card_asset_refs。

## File 構成(新規/変更)

- 変更 `.devcontainer/post-create.sh`(PG17)/ `.devcontainer/devcontainer.json`(postStartCommand)/ `.devcontainer/README.md`
- 変更 `vitest.config.ts`(exclude)/ `package.json`(`test:iso`)/ `app/(app)/app/upload/_actions/upload-persistence.ts`(O1)
- 新規 `vitest.integration-pg.config.ts`
- 新規 `tests/integration/pg/setup/{db-url,global-setup,fixture,completeness,with-tenant}.ts`
- 新規 `tests/integration/pg/{fixture-completeness,read-isolation,delta-isolation,write-isolation,delete-isolation,ocr-owner-scope}.test.ts`
- 新規 `tests/integration/pg/COVERAGE.md`(IN/OUT 棚卸し表)

---

## Phase G — 土台(harness)

### Task G1: devcontainer PG17 常駐
**目的**: post-create で PG17 を導入・起動し restart 跨ぎで再起動。
**制約**: base image default apt は PG16 → **PGDG apt repo(key+codename+apt update)追加 → `postgresql-17`**(既存 Stripe/Chrome の第三者 apt repo pattern 準拠)。**運用定数を固定**: role/DB/port/PGDATA/cluster 名/認証方式。5432 forward 追加なし。`set -euo pipefail`+`fail()` 様式。
**主 file**: `post-create.sh`(install+cluster init+role+`recallmint_test` 用意+**postcondition: 実 test role で `psql 'SELECT 1'` 成功**(`pg_isready` だけでは認証/権限を保証しない)、失敗で非0)/ `devcontainer.json`(`postStartCommand` = **未作成/既起動/停止中の全状態で冪等**な cluster start)/ `README.md`(pin+手順+責務表)。
**完了条件**: 現コンテナで手動実行 → test role で `SELECT 1` OK + postcondition が停止時非0。full lint exit0。**OT rebuild で postStart 永続を実機確認**(申し送り)。`[no-review]`(script)。

### Task G2: vitest PG config + 集約 safety guard
**目的**: PG suite 専用 config と URL 定数 + allow-list guard を作る。
**制約**: Global Constraints「安全境界」「直列実行」「実行境界」厳守。guard は接続前(module 評価/明示 call)で throw。
**主 file**: `tests/integration/pg/setup/db-url.ts`(`TEST_DATABASE_URL` 定数 + `assertLocalTestDb(url): void` + hard-set export)/ `vitest.integration-pg.config.ts`(include `tests/integration/pg/**/*.test.ts`・`fileParallelism:false`・単一 fork・globalSetup・setupFiles)/ `vitest.config.ts`(`exclude: ['tests/integration/pg/**']`)/ `package.json`(`test:iso`)。
**完了条件**: `assertLocalTestDb` unit = Supabase 様 host / `localhost` / 別 port / 別 DB 名 / parse 不能で **throw**、`127.0.0.1:<port>/recallmint_test` で pass。**guard mutation RED**(guard を no-op 化 → 危険 URL で throw しなくなる=RED、**接続関数 spy が呼ばれ*ない*ことで確認**・実接続しない)。`pnpm test` に PG suite が混ざらない(exclude 確認)。red 検証記録 + 簡易 review → `[reviewed]`。

### Task G3: globalSetup(guard→provision→migrate)
**目的**: suite 開始時に clean な `recallmint_test` を作り 25 migration 適用。
**制約**: globalSetup 冒頭で `assertLocalTestDb`(外部 env 不参照・定数使用)→ maintenance DB 接続 → 対象 DB の残存 backend `pg_terminate_backend` → `DROP DATABASE IF EXISTS`→`CREATE`→ `migrate({migrationsFolder: <config 相対で解決した絶対 path>})`。全接続を例外時も finally close。drizzle-kit push 不使用。
**主 file**: `tests/integration/pg/setup/global-setup.ts`(`setup()`/`teardown()`)。
**完了条件**: globalSetup 後、**必須 table 名(19+users 等)+ migration journal 適用 + 主要 column/FK 存在**を assert(単なる count でなく)。migrate が PG17 で完走。full lint。`[reviewed]`(增: table 名 pin の red = migrate skip で RED)。

### Task G4: fixture + 三者一致完全性 + withTenant + COVERAGE
**目的**: A/B を全 19 table に seed、完全性を三者一致で機構保証、auth seam helper、IN/OUT 棚卸し。
**制約**: fixture は A/B row id を返す。seed 前提行順(users→exams/tag_categories→cards/tag_options→…→study_sessions→reviews/answer_events)を解決。完全性 = **Drizzle introspect ∪ 実 PG catalog(`information_schema.columns`)∪ expected-19 明示 list の三者一致**+ 全 19 に A/B ≥1 行。**exclusion は isolation-assertion 集合からのみ**(seed は全 19)。`withTenant(user,fn)` は route/action 経路のみ `getCurrentUser` mock(DB real)。`COVERAGE.md` に 62 call site の IN/OUT + 理由表(Iso-0 §1.2 起点)。
**主 file**: `tests/integration/pg/setup/{fixture,completeness,with-tenant}.ts` + `fixture-completeness.test.ts` + `COVERAGE.md`。
**完了条件**: 完全性 test green。**harness 自己検証**: (a) 任意 1 table の seed を外す→三者不一致/行欠落で RED、(b) expected-19 に無い user_id table を schema に足す想定→不一致で RED(復元・red 検証記録)。per-test `TRUNCATE...RESTART IDENTITY CASCADE`+再 seed 動作確認。`[reviewed]`。

---

## Phase R — read / delta 隔離

### Task R1: read 混入 assertion(パターン代表)
**目的**: owner-scoped read が B を A に混ぜず、A 自身は返すことを検証。
**制約**: **代表 RED = `getActiveExamsForUser`**(owner 述語 `eq(exams.userId)` + `isNull(archivedAt)` のみ = 単一 owner 述語除去で B の active exam が直接漏れる clean な代表)。decoy 適格性 = B の exam は **非 archived**。positive = A の active exam が返る。追加 behavioral(非 RED)= `getCardsForExam`(**examId filter が userId を shadow する**ため RED 代表に不適 — behavioral のみ)/`getSessionCards`/`getReviewStatsForUser`/settings read。
**主 file**: `tests/integration/pg/read-isolation.test.ts`。
**完了条件**: green(positive+negative 対)+ **read 混入 RED**(`lib/exams/list.ts` の `eq(exams.userId,…)` 除去 → **B の既知 exam id が A の結果に出現**を実測・復元)。commit「red 検証」→ `[reviewed]`。

### Task R2: delta 混入 assertion(パターン代表)
**目的**: pull delta が A の `since` で B を返さず A は返すことを検証。
**制約**: **代表 RED = `getDeltaRows` 経由 `getCardsDelta`**(6 stream の単一 factory 代表)。境界値: B 行を A の `since` **より後**に置き A 行も同範囲、`>`/`>=`・timestamp 同値・tz による偶然除外を避ける。positive = A の delta に A 行。追加 behavioral(非 RED)= `getAllStudyDaysForUser`(別関数)+ 残 5 stream 1 assert ずつ。
**主 file**: `tests/integration/pg/delta-isolation.test.ts`。
**完了条件**: green + **delta 混入 RED**(`lib/db/pull-delta.ts` の `eq(config.userIdCol,userId)` 除去 → **B の既知 id が A の delta に出現**・復元)。commit「red 検証」→ `[reviewed]`。

---

## Phase W — write / delete 越境

### Task W1: write 越境 assertion(パターン代表)
**目的**: A が B の card を更新できず、A は自 card を更新できることを検証。
**制約**: **代表 RED = `updateCardField`**(apply write の `and(eq(id),eq(userId))` 代表・実装共有を確認)。A の userId + B の card_id → 0 行 & B の値不変。positive = A の userId + A の card_id → 成功 & 値変化。追加 behavioral(非 RED)= `applyTagOptionUpdate`/`applyCardFinalStates`/`finalizeAsset`。
**主 file**: `tests/integration/pg/write-isolation.test.ts`。
**完了条件**: green(positive+negative)+ **write 越境 RED**(`card-field-handlers.ts` の `eq(cards.userId,…)` 除去 → **B の card 値が変わる**・復元)。commit「red 検証」→ `[reviewed]`。

### Task W2: delete 越境 assertion(パターン代表)
**目的**: A が B の exam を削除できず、A は自 exam を削除できることを検証(cascade 含む)。
**制約**: **代表 RED = `deleteExam`**。三段 owner check ゆえ**変異対象段階を事前特定**(owner SELECT の `eq(exams.userId)` を外すと child/DELETE が B に到達するか実測で確認)。A userId + B exam_id → 0 行 & B の exam+cards 不変。positive = A userId + A exam_id → 削除成功 & cascade。追加 behavioral(非 RED)= `applyTagCategoryDelete`/`applyCardDelete`。
**主 file**: `tests/integration/pg/delete-isolation.test.ts`。
**完了条件**: green(positive+negative)+ **delete 越境 RED**(特定した段階の owner `eq` 除去 → **B の exam が消える**・復元)。commit「red 検証」→ `[reviewed]`。

---

## Phase O — OCR owner 述語 fix(独立 commit・最後)

### Task O1: completeUploadTx / markFailed owner 述語追加
**目的**: OCR 完了/失敗 write の cross-tenant 成功を塞ぐ(fix)。
**制約**: **DB 層のみ**(Gemini prompt/`ocr-extract.ts`/response schema 不可触)。`.where(eq(sourceDocuments.id,id))` → `.where(and(eq(id),eq(sourceDocuments.userId,userId)))`。両関数 userId 受領済 = signature 不変。affected-rows 取得は **postgres-js/drizzle 実戻り値を実 DB で確認**。`completeUploadTx`: 正常経路**厳密 1 行**、0 行で throw(**呼出元契約=retry/既完了との衝突有無を先に調査**、衝突あれば OT 確認 §論点 B-4)。`markFailed`: 0 行 warn(no-throw 維持・**PII/機密 id を warn に載せない**)。
**主 file**: 変更 `upload-persistence.ts` + 新規 `tests/integration/pg/ocr-owner-scope.test.ts`。
**完了条件**: 順序厳守 — (1) **RED**: `completeUploadTx`/`markFailed` を **userId=A・sourceDocumentId=B で直接呼び**、fix 前に B の doc が更新される(= DB 層述語欠落。上位 auth の検証ではない)を実測 → (2) fix → (3) **GREEN**: 観測は関数契約別(complete=throw / fail=warn、両者 B の doc 不変、正常単一テナントは 1 行維持で回帰なし)。**canonical + Codex** Critical/Important 0。push→smoke 要否は実装時判断。`fix()` + `[reviewed]`(smoke 要時 session doc 正記録)。

---

## Self-Review(spec 対応確認)

- spec §2 harness → G2(config/guard 集約)/ G3(globalSetup guard→migrate)/ G4(fixture/三者一致/withTenant/COVERAGE)。✓
- 課題1(vacuous green: positive+negative 対 / decoy 適格性 / 三者一致 / 代表 RED 因果)→ Global Constraints + G4 + R1/R2/W1/W2。✓
- 課題2(IN/OUT 監査成果物)→ G4 COVERAGE.md。✓ 課題3(guard scope・globalSetup)→ G2/G3。✓ 課題4(PG17 運用定数/postStart 冪等/postcondition 認証)→ G1。✓ 課題5(直列/exclude/gate)→ Global Constraints + G2。✓
- spec §4 OCR(実 DB affected-row 確認/契約別観測/A文脈=DB層/呼出契約調査)→ O1。✓
- phase G→R→W→O 一致。✓ 代表主義の限界明記。✓
- 未 placeholder / 型整合(`assertLocalTestDb`/`TEST_DATABASE_URL`/`makeTenantFixture`/`withTenant`/`getDeltaRows`)✓。
- 残 OT 論点は spec §8-B(命名/allow-list 強度/CI regression/OCR throw)に集約。
