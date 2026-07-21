# RLS Phase 3 Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 軽配線 5 表(study_sessions / user_settings / assets / source_documents / upload_records)の残存 raw getDb 経路を tenant context 下に入れ、Wave 1 同型 policy で RLS 化し、partial-RLS 安全性を behavioral に証明する。

**Architecture:** 各 raw site を `withTenantTx` で包む(機械的 wrap・新規設計なし)→ `db/policies/rls-p3-wave2-enable.sql`(Wave 1 同型 tenant policy)+ global-setup で test:iso を RLS-on 化 → iso test で 5 表単独防御 + 配線経路の RLS-on 動作 + partial-RLS 混在 tx を pin。

**Tech Stack:** Next.js 16 / Drizzle / PostgreSQL(RLS)/ Vitest integration-pg(実 PG 2 テナント harness)。

## Global Constraints(全 task 共通・冒頭一度)

- **唯一の根拠** = Step 0 fact-finding(`docs/audit/2026-07-21-rls-phase3-step0-tx-boundary-factfinding.md`)。新規設計しない。迷ったら Wave 1 の `rls-p3-wave1-enable.sql` / `rls-single-defense.test.ts` に倣う。
- **不可触**: Gemini prompt / `lib/ai/ocr-extract.ts`。
- **配線 helper**: 既存 `withTenantTx(db, userId, fn)` / `setTenantContext`(`lib/db/tenant-tx.ts`)をそのまま使う。新 helper を作らない。
- **配線 → policy flip は per-table で不可分**(その表の全経路が context 済になってから flip)。test:iso は global-setup が全 policy を一括適用するため、**Task 1-5(全配線)完了後に Task 6(flip)**を置く。
- **prod flip しない**(stg のみ・Phase 3 全表完了後に prod)。本 sprint で prod policy は触らない。
- **RLS-on 表集合**(参照): P2=users/exams/cards/tombstones/study_days、Wave1=reviews/answer_events/tag_categories/tag_options/card_tags/entity_mutations/card_asset_refs/ai_usage_users。**恒久 off**=integration_failures/contact_messages/ai_usage/stripe_events/clerk_events。
- **schema 前提(Codex #5・要確認)**: 対象 5 表の `user_id` は **NOT NULL**(標準 tenant 表・cascade FK)ゆえ NULL 行が全 tenant 不可視化する問題は無い(nullable は off 側の integration/contact のみ)。Task 1 着手前に 5 表の user_id NOT NULL を schema で 1 度確認する。context に渡す userId は全 site で **auth 由来**(`getCurrentUser().id` / auth userId)= client 供給 ID を tenant key にしない(既存 trust-boundary 不変)。
- **完了 gate(sprint 完了時・全 exit 0)**: `pnpm lint`(--max-warnings=0)/ `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit`。配線を伴うため build/typecheck が効く。
- **review 規律**: feat = canonical(`superpowers:requesting-code-review` デフォルト経路)→ `scripts/ai/codex-review.sh` → 未解決 Crit0/Imp0 → `[reviewed]` commit。test 増分は red 検証必須 + 簡易 review。docs は `[no-review]`。commit=CC / push=OT。

---

### Task 1: study_sessions 配線(Phase 0 wrap)

**Files:** Modify `app/api/review-events/bulk/route.ts:91`

**目的:** Phase 0 の `upsertSessionGuarded(db, user, session)`(tx 外の素の getDb)を tenant context 下に入れる。
**制約:** 単純 wrap を採る(processSession tx への合流はしない — 合流は「Phase 0 失敗が Phase 1+2 まで巻き戻る」意味論変更ゆえ回避)。既存 try/catch(`classifyBulkError` → 503)の内側で wrap し、error 分類・`applied` 戻り・wire(200/503/400)を不変に保つ。`upsertSessionGuarded` は `DbExecutor` を受け、TenantTx は構造的に代入可。
**実装:** `;({ applied } = await withTenantTx(db, user.id, (tx) => upsertSessionGuarded(tx, user, session)))`
**完了条件:** `app/api/review-events/bulk/route.test.ts` + `tests/contract/review-events-bulk.contract.test.ts` green(挙動不変)。typecheck/build exit 0。

---

### Task 2: user_settings 配線(write 3 + read 3)

**Files:** Modify `save-session-limit.ts:20` / `save-custom-session-limit.ts:20` / `save-fsrs-mode.ts:23`(いずれも `app/(app)/app/settings/_actions/`)/ `app/(app)/app/settings/page.tsx:31` / `app/(app)/app/study/custom/page.tsx:20` / `app/(app)/app/study/smart/page.tsx:23`

**目的:** user_settings への素の getDb write 3 + read 3 を tenant context 下に入れる。
**制約:** PK=user_id 単独。各 site は単文(insert…onConflictDoUpdate / select)ゆえ `withTenantTx(db, user.id, (tx) => tx.insert(userSettings)…)` / `…(tx) => tx.select().from(userSettings)…` で最小 wrap。study/smart は既存 cards の `withTenantTx`(:38)と**別**に user_settings read を独立 wrap(cards tx へ合流させない=最小変更。settings と cards が別 snapshot になる非原子性は配線前から不変=意図的に維持・Codex #80)。ActionResult / 返り値 shape 不変。
**完了条件:** `save-*.test.ts` 3 本 + `settings/page.test.tsx` + `study/custom` + `study/smart/page.test.tsx` green。typecheck/build exit 0。

---

### Task 3: assets 配線(reserve / finalize / resolve)

**Files:** Modify `app/(app)/app/exams/[id]/_actions/asset-actions.ts`(reserve:104 / finalize:138-200 / resolve:245)

**目的:** assets への素の getDb 3 経路を tenant context 下に入れる。
**制約(設計判断・OT 承認要):** finalizeAsset は `select(:138) → headObject(R2 外部 HTTP・:163) → update(:174) → 条件 select(:191)` の構造。kickoff は「3 連を 1 tx に束ねる」だが、そのまま束ねると **tx が R2 I/O を跨いで DB 接続を network 往復ぶん保持**する。→ **(b) headObject を tx 外に出し「read tx → headObject → write(+条件 read)tx」の 2 分割**を採る(TOCTOU 防御は既存 `status='reserved'` WHERE 節で担保・tx 分離は correctness に不要。最小・「勝手に挙動を変えない」に整合。Codex cross-check も 2tx 妥当と同意)。2 分割で write-side が再確認する条件(`status='reserved'` + owner WHERE + byteSize 一致 + 0 行時の not-found/冪等分岐)は**現行と完全同一に保つ**(read/write 間の window は現行 no-tx 3 文と同幅=新規リスクなし)。reserve/resolve は単文 wrap(presignPutUrl/presignGetUrl は query 後・tx 外)。
**R2 境界(Task 7 test への申し送り):** finalizeAsset は headObject(R2)依存ゆえ iso で full path を叩けない → finalize の RLS 担保は **assets 単独防御(raw update 隔離)**で取り、full finalize(R2 mock)は既存 `asset-actions.test.ts` unit が担う。iso wired-path は reserve(DB insert)/ resolve(DB select)に限る。
**TOCTOU guard の test 固定(OT 指摘・主張でなく test で pin):** 2 分割後、2 つ目の tx(UPDATE)の `status='reserved'` WHERE 節が TOCTOU 窓を塞ぐことを test で固定する。既存 `asset-actions.test.ts` の atomic-guard 群(:503 WHERE に reserved 焼込 / :515 SELECT 時 reserved・UPDATE 0 行→`{ok:false}` / :542 0 行+re-SELECT deleting/消失→no-resurrection)を、mock を withTenantTx(`db.transaction`)対応に更新した**後も guard を実行して green** に保つ。**red 検証必須**: 2 つ目 tx の UPDATE WHERE から `eq(assets.status,'reserved')` を外す変異で :515/:542 が fail することを実証(= test が guard 除去を捕捉する証明)→ commit message に「**red 検証**」記録。
**完了条件:** `asset-actions.test.ts` green(atomic-guard 群が refactor 後も guard 実行)。typecheck/build exit 0。**逸脱点(bundle-1 → split)を commit message に明記し OT plan 承認を根拠にする。**

---

### Task 4: source_documents 配線(read 3)

**Files:** Modify `lib/exams/source-doc-status.ts`(getExamStatusMap:44 / hasActiveProcessingUpload:167)/ `app/api/exams/status/route.ts:49`

**目的:** source_documents の素の getDb read 3 経路を tenant context 下に入れる。
**制約:** `reconcileStaleProcessing`(:86)は**既に `setTenantContext` 済**(RLS-P2)= 触らない。3 read はいずれも best-effort try/catch 内の単文 select ゆえ `withTenantTx(db, userId, (tx) => tx.select…)` で最小 wrap。best-effort の握り(warn + 空 Map/false/[])を不変に保つ(context 失敗も既存 catch が拾う)。exams/status route の read は `withReadOnlyAuth` handler 内。
**完了条件:** `app/api/exams/status/route.test.ts` green。typecheck/build exit 0。

---

### Task 5: upload_records 配線(read 1・caller 差し替え)

**Files:** Modify `app/(app)/app/upload/page.tsx:95-97`

**目的:** `getCurrentMonthOcrPages(userId, getDb())` の素の getDb を tenant context 下に入れる。
**制約:** `getCurrentMonthOcrPages(userId, dbc)` は `dbc: TenantDb` 引数化済 = 関数は不改修、**caller のみ**差し替え: `getCurrentMonthOcrPages(userId, getDb())` → `withTenantTx(getDb(), userId, (tx) => getCurrentMonthOcrPages(userId, tx))`。行内コメント「uploadRecords は RLS-off ゆえ standalone getDb() で足りる」(:95)を RLS-on 反映に更新。もう 1 経路の `canRunOcr`(`upload-guard.ts:96`)は既に guard tx を渡す=context 済(触らない)。
**完了条件:** upload/page 関連 test green。typecheck/build exit 0。

---

### Task 6: policy SQL + global-setup flip

**Files:** Create `db/policies/rls-p3-wave2-enable.sql` / `db/policies/rls-p3-wave2-disable.sql`。Modify `tests/integration/pg/setup/global-setup.ts`(wave1 enable の直後に wave2 enable 適用を追加)

**目的:** 5 表に Wave 1 同型 tenant policy を張り、test:iso を RLS-on 化する。
**flip 前の raw-site 完全性再監査(必須・Codex #3):** flip 前に 5 表の schema symbol(`studySessions`/`userSettings`/`assets`/`sourceDocuments`/`uploadRecords`)を機械 grep し、Task 1-5 で列挙した以外の未 wrap getDb 経路(別名 import / helper 経由 / 直書き SQL)が無いことを確認。差分があれば配線を追加してから flip。
**制約:** enable = 5 表それぞれ `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + `DROP POLICY IF EXISTS …_tenant`(冪等)+ `CREATE POLICY …_tenant FOR ALL TO recallmint_app USING = WITH CHECK = user_id = (SELECT public.app_current_user_id())`。`SET lock_timeout='5s'`。識別子 qualification は Wave 1 を厳密踏襲(table 非修飾 / `(SELECT public.app_current_user_id())` は public 修飾)。disable = 5 表 `DISABLE ROW LEVEL SECURITY` のみ(DROP POLICY 含めない・policy 残置は不活性。再 enable は enable.sql の DROP+CREATE が定義を再適用するため drift 復活しない)。**`rls-p3-wave1-enable.sql` / `-disable.sql` を template に厳密反復**。global-setup は `RLS_WAVE2_ENABLE_FILE` 定数 + `readFileSync` + `.simple()` を wave1 の直後に足す(同一機構)。**`.simple()` は file 全体を 1 暗黙 tx で流す=5 表 enable は原子的**(途中失敗で ENABLE 群ごと rollback、DROP 前置で再適用安全)。`db/policies/` は deploy/migration runner の自動適用対象外(operator 手動・Wave 1 既定)= prod 誤適用しない。
**完了条件:** 既存 pg suite が RLS-on 化後も green(= Task 1-5 の配線が全経路を context 済にしている証明)。`pnpm test:iso` exit 0。

---

### Task 7: rls-wave2.test.ts(5 表 単独防御 + 配線経路 RLS-on 動作)

**Files:** Create `tests/integration/pg/rls-wave2.test.ts`

**目的:** 5 表の RLS 単独防御(policy 単独で隔離・USING と WITH CHECK の両性質)と、配線した **DB 層 query** が RLS-on 下で従来どおり動くことを pin。
**制約(Wave 1 同型):** fixture(`seedTwoTenants`)は 5 表とも A/B decoy を seed 済 = 再利用。① **単独防御**(`asTenant` + app 層 eq を外す)= 各表で **USING**〈A read が B 行を含まない / B 既存行狙い update が 0 行〉+ **WITH CHECK**〈`user_id=B` の insert/upsert が 42501(`assertRejectsWithRlsViolation`)/ A 行を B へ付替える update が拒否〉+ **fail-closed**〈context 未設定で代表 read **と** write が P0RLS(`assertRejectsWithP0RLS`)〉。USING と WITH CHECK は別性質ゆえ両方明示(Codex #6)。② **配線経路(DB 層)**= context 下で実関数/query が成功(P0RLS/42501 なし)+ owner 観測で A のみ変化: `upsertSessionGuarded`(asTenant 直呼び)/ save action の DB upsert 相当 / getExamStatusMap / getCurrentMonthOcrPages / reserveAsset。観測/seed は owner。
**保証層の限定(Codex 指摘・重要):** asTenant で helper/query を直呼びする本 test は **policy + DB 層配線**を保証するが、route/action/page の caller が実際に `withTenantTx` で包んだ事実は証明しない(iso で Next auth/cache/R2 境界を叩かない)。caller-site 配線の完全性は **Task 6 の機械 re-grep + canonical review + typecheck/build** で担保する(この分担を Task 9 COVERAGE の保証層列に明記)。全 site の context userId は auth 由来(`user.id`/`userId`)である事実も review 観点に含める。
**red 検証(必須・増):** 対象表を owner で `ALTER TABLE <t> DISABLE ROW LEVEL SECURITY` した throwaway 実行で単独防御ケースが fail することを実証(global-setup の手 revert に依存しない再現可能な手順)→ 使用コマンドと fail 出力を commit message に「**red 検証**」記録。
**完了条件:** `pnpm test:iso` green。簡易 review(主張の正確さ)。

---

### Task 8: partial-RLS 混在 tx の intentional 証明

**Files:** Create `tests/integration/pg/rls-partial-mixed.test.ts`

**目的:** 「**global-off 表 × tenant-on 表**が 1 tx に同居しても、on 表は隔離が効き off 表は従来どおり書け、かつ on 側違反時は tx 全体が原子的に rollback する」を behavioral に pin(Phase 3 wave 分割成立=partial 安全の根幹)。
**主張範囲の限定(Codex #15・重要):** 本証明は「**global-off × tenant-on の transaction 互換性**」に限る。tenant-owned 表が移行期間中 off である安全性、および off 側の tenant 隔離は**証明しない**(off は global で隔離対象外)。test 名(`rls-partial-mixed`)+ COVERAGE に主張範囲を明記する。
**制約(実経路選定):** Wave 2 後に残る stable な mixed tx = `incrementAiUsage`(`lib/ai-usage-counter.ts:29`)。1 tenant tx で `ai_usage`(**off**・global・PK=date)+ `ai_usage_users`(**on**)を UPSERT。doc 追補2 の「study_sessions off × on」は Wave 2 が study_sessions を on 化するため無効化 → 恒久 off global 表へ置換(clean な実在経路・人工 fixture 不要・escalation 不要)。テスト:
- (A) 実 `incrementAiUsage(A)` を走らせ owner 観測で `ai_usage[today]`(off)加算 + `ai_usage_users[A,today]`(on)加算 = 混在 tx が RLS-on 下で成立。**off 書込は実業務経路(incrementAiUsage)で行い、raw 任意 insert で「off 自由」を過剰仕様化しない**(Codex #16)。
- (B) `asTenant(A)` 1 tx 内で on 隔離を probe: `ai_usage_users` no-predicate read=A のみ・B decoy 不可視 / B 狙い write=0 行(USING)。
- (C) **原子性(Codex #90)**: mixed tx 内で ai_usage(off)を書いた後に ai_usage_users へ `user_id=B` write(WITH CHECK 42501)で throw させ、owner 観測で **ai_usage(off)も rollback**(加算されていない)= partial-RLS が partial commit を作らない証明。
- cleanup: `ai_usage` は truncate 対象外(user_id 無)ゆえ owner で対象 date を **beforeEach + afterEach** 掃除 + `now` 注入で決定化。test:iso は単一 fork 直列(`fileParallelism:false`)ゆえ worker 競合なし。
**red 検証(必須・増):** (B) on 隔離ケースを対象表 owner disable の throwaway 実行で fail 実証 → commit message「**red 検証**」(方法は Task 7 と同一)。
**完了条件:** `pnpm test:iso` green。簡易 review。

---

### Task 9: COVERAGE.md 追記

**Files:** Modify `tests/integration/pg/COVERAGE.md`

**目的:** Wave 2 の 5 表 × 主経路 × context 供給元 × RLS 単独防御 test の IN/OUT を Wave 1 節と同形で追記 + partial-RLS 証明(rls-partial-mixed)を記録。
**制約:** Wave 1 追記(表 3)と同一 format。加えて **保証層の分離**を明記(Codex 指摘): ①caller 配線(route/action/page が withTenantTx で包む)= review + Task 6 re-grep + build / ②policy 単独防御 = rls-wave2.test.ts / ③DB 層実経路 = rls-wave2.test.ts / ④stg smoke = operational(隔離証明でなく RLS-on 動作)。partial-RLS の主張範囲(global-off × tenant-on tx 互換)と実経路置換(study_sessions→ai_usage/ai_usage_users)の理由を 1 行明記。
**完了条件:** docs のみ → `[no-review]`(保証不変)。

---

## stg 実証(OT push 後・実装 task 外)

- **適用順序の厳守(Codex #13)**: ①配線済コードを push→stg deploy 完了を確認 → ②その後に enable.sql を **stg の SQL Editor で適用**(push だけでは効かない — Wave 1 教訓)。順序逆転(旧コード + RLS-on)は raw 経路 P0RLS を招くため禁止。新 function なし(0025 適用済)ゆえ policy SQL のみ。
- RLS-on smoke(stg URL): study 開始 / session limit・FSRS mode 保存 / OCR upload(source_documents/upload_records/assets 経路)が RLS-on で従来どおり。**P0RLS / 42501 / 5xx = 0**、`current_user = recallmint_app`。RLS-off 下の先行 smoke を validate と誤認しない。※テナント間 negative 隔離は **test:iso(同一 policy SQL 適用)が behavioral に担保**し、stg smoke は positive operational の層(Codex 指摘の層分離)。
- rollback 演習: `disable.sql`(先に RLS off・コードは据え置き可)→ 確認 SQL(policy 5 行 / relrowsecurity 0 行が正しい中間状態)→ re-enable(冪等)→ **再 enable 後に `pg_policies` で 5 表の qual / with_check / roles / cmd が期待値一致を spot-check**(Codex #100)。
- **after 計測** = drift 分離のため **prod flip 直前(同日 before とセット)を本命**とし Wave 2 stg では取らない(claude.ai 相談点)。
- **follow-up(scope 外・記録のみ)**: best-effort read(source_documents 空 Map 等)が RLS/context 障害を「データなし」に見せうる監視可能性(Codex #9/#36)は本 sprint scope 外。RLS 導入で悪化しない(既存 best-effort 不変)が、後続の観測強化候補として台帳化。
