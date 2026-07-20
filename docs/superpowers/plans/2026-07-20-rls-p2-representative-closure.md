# RLS-P2: closure 5 表 実証 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。

**Goal:** {users, exams, cards, tombstones, study_days} に RLS を有効化し、「動く・漏れない・遅くならない」を test:iso + stg で実証する。
**Spec(正本・凍結):** `docs/superpowers/specs/2026-07-20-rls-p2-representative-closure-design.md`(§ 参照は全てこの spec)。
**Architecture:** tx 冒頭 `set_config('app.user_id', …, true)` + loud plpgsql 関数 + 表単位 policy(users のみコマンド別 + SECURITY DEFINER 3 本)。migration 2 分割(0025 functions → code → 0026 policies)。

## Global Constraints(全 task 共通)

- 既存挙動の保全が最優先。変更は spec 明示箇所のみ。Gemini prompt / `ocr-extract.ts` 不可触。`eq(userId)` は全経路で残す。
- feat/fix commit = canonical review(`requesting-code-review` デフォルト経路)+ Codex(`scripts/ai/codex-review.sh`)pass → `[reviewed]`。test 増 = red 検証 + 簡易 review、commit message に「red 検証」。宣言 token は Stop hook 準拠。
- helper の tx 参加は「**必須**末尾引数 `dbc: DB | TenantTx`」で統一(配線漏れを compile error に倒す — codex cross-check 採用。optional default は不採用)。対象 = spec §2.7 の列挙 helper。
- 新規 env なし。`.env.example` 変更なし。tx 内外部 I/O 禁止(spec §0.2)。
- per-task gate: 変更 file の unit + `pnpm test:iso` green(Task 8 以降は RLS on 状態)。sprint 完了 gate は Task 12。

---

### Task 0: drizzle pgPolicy 評価(Step 0・Phase 3 向け)

- 目的: Phase 2 の適用機構は versioned SQL で確定済(spec §2.9)。本 task は **Phase 3(policy の migration 昇格・全表展開)に向けた評価** — drizzle-orm 0.45.2 の `pgPolicy` / `.enableRLS()` が spec §2.2-2.3 と同一 SQL(TO role / `(SELECT fn())` / per-command)を表現できるかを Context7 + registry 直叩きで裏取り。
- 制約: コード変更なし。schema.ts と policy SQL の drift 検出手段(catalog 突合 test の要否)も 1 行評価。
- 完了条件: 採否 + 根拠 1 段落を session doc に記録(commit は docs)。Phase 2 の task には影響しない。

### Task 1: migration 0025 — loud 関数 + SECURITY DEFINER 3 本

- 目的: `app_current_user_id()`(STABLE plpgsql、`nullif(current_setting('app.user_id', true), '')` NULL で **RAISE `ERRCODE = 'P0RLS'`**(カスタム SQLSTATE — 標準 28000 は認証系と混同するため不採用・test で pin)/ `app_bootstrap_user_from_clerk(text) RETURNS SETOF users`(STABLE・全列返却の根拠は spec §2.3)/ `app_resolve_user_for_stripe(p_by text, p_value text) RETURNS TABLE(id uuid, deleted_at timestamptz)`(whereFor 4 arm 忠実移植・**p_by allowlist 外は RAISE**・返却 2 列最小)/ `app_scrub_deleted_user(uuid) RETURNS void`(現行 scrub UPDATE の忠実移植・再設計禁止・0 行 = no-op)。
- 制約: 3 本は SECURITY DEFINER + `SET search_path = public` + **本文完全修飾名** + 同一 migration 内で `REVOKE ALL FROM PUBLIC` → `GRANT EXECUTE TO recallmint_app`。migration は additive(旧コード無影響・RLS 状態を持たず prod 適用可)。
- 完了条件: migrate green(test:iso 既存 85 本不変)+ 新規 iso test: SQLSTATE `P0RLS` pin(NULL / 空文字両形態)/ bootstrap 0-1 行 / resolver 4 arm + allowlist 外 RAISE + 退会行返却 / scrub NULL 化 3 列・0 行 no-op(**red 検証**: 関数 DROP 状態で fail)→ [reviewed]。

### Task 2: tenant-tx wrapper

- 目的: `lib/db/tenant-tx.ts` 新設 — `export type TenantTx = Parameters<Parameters<DB['transaction']>[0]>[0]` / `setTenantContext(tx, userId)`(`SELECT set_config('app.user_id', (${userId})::uuid::text, true)` — **cast を設定文に含め不正形式を設定時に loud fail**)/ `withTenantTx<T>(db, userId, fn)`(db.transaction + 冒頭 setTenantContext)。
- 制約: 新レイヤーはこの 2 形態のみ(spec §2.7)。
- 完了条件: unit(set_config が先頭 / 戻り値・throw 透過 / 不正 uuid で reject)green(**red 検証**)。実 PG 検証(GUC 可視・ROLLBACK 後消滅・savepoint 維持)は Task 9 に集約 → [reviewed]。

### Task 3: read 経路の tx 化(5 表 read)

- 目的: `/api/pull`(getDeltaRows + 6 module に dbc 引数 → route handler を withTenantTx 1 tx 直列化)/ `/api/study-days/pull` / `/api/dashboard/stats`(streak.ts raw SQL 2 本)/ `lib/exams/list.ts` 4 関数 / `get-session-cards` / upload page の `getActiveExamsForUser` 呼出、を withTenantTx + dbc 注入に配線。
- 制約: クエリ本文・WHERE・wire format 不変(dbc 注入と tx 包みのみ)。RLS off 状態では挙動同一。
- 完了条件: 既存 unit(mock)+ test:iso 85 本 green。route contract test 不変。→ [reviewed]

### Task 4: 既存 tx 10 本の set_config + §6.6 fix + create-exam

- 目的: 10 tx(guard / saveExtractedCards / completeUploadTx / markFailed / delete-exam / incrementAiUsage / processMutation / handleUserDeleted※ / processSession / reconcileStaleProcessing)の冒頭に `setTenantContext(tx, userId)`。※handleUserDeleted の users 系変更は Task 6。`canRunOcr` / `getCurrentMonthOcrPages` / `getTodayAiUsageGlobal` に dbc 引数を追加し guard tx から tx を渡す(spec §2.8、upload-guard.ts:90 コメント訂正)。`create-exam` の単文 INSERT を withTenantTx 化。
- 制約: bulk = per-mutation tx 維持(group 並列温存)。OCR 3-tx 維持・Gemini tx 外。advisory lock 下の quota 判定順序不変。
- 完了条件: 既存 unit + test:iso green(guard の nested 接続が消えたことは §6.6 対象 2 関数の呼出形 unit で pin・**red 検証**)→ [reviewed]。

### Task 5: getCurrentUser claim-first + contact

- 目的: `getCurrentUser()` を spec §2.4 の claim-first 形へ(claim あり = withTenantTx(dbUserId) + `WHERE id`・0 行 → null・bootstrap fallback しない / claim なし = `app_bootstrap_user_from_clerk` のみ / session なし = throw 不変・`cache()` 維持)。`lib/actions/contact.ts` の clerk_id lookup を bootstrap 関数呼出へ。
- 制約: 戻り型 `Promise<User | null>` 不変。null 契約の受け側 7 分類(FF §2.2)無改変。getAuthContext 不変。
- 完了条件: unit で分岐 4 系(claim+行 / claim+ghost=null / 無 claim+未同期=null / 無 session=throw)pin(**red 検証**)+ test:iso green → [reviewed]。

### Task 6: clerk lifecycle 配線

- 目的: user.created = 事前採番(`crypto.randomUUID()`)→ **単一 withTenantTx(新 uuid)内で** 存在チェック(bootstrap 関数)→ 不在なら `INSERT (id, clerk_id, email)`(RETURNING・onConflict 不使用。race は clerk_id UNIQUE → outer catch 200 + 通知 = 現行 silent skip との差は通知のみ、spec §2.5)。user.deleted = resolve を bootstrap 関数へ + tx 冒頭 set_config + scrub を `app_scrub_deleted_user` 呼出へ + notifyOps 文言中立化(spec §2.6)。
- 制約: dedupe-first 順序不変。Group I DELETE 群・assets UPDATE・runTransactionWithRetry・Stripe cancel ループ不変。metadata sync の gate 条件(新規時のみ)同値。
- 完了条件: webhook route 既存 test(Group I invariant 含む)green + 新規 unit: 事前採番 INSERT 形 / 再配信 no-op / 文言(**red 検証**)→ [reviewed]。重要 fix(認証・削除)につき tag は OT 実機確認後の規律に従う。

### Task 7: stripe 経路配線

- 目的: `handle-stripe-event.ts` / `upgrade/actions.ts` の users 触り経路の冒頭に `app_resolve_user_for_stripe` → **deleted_at 非 NULL = log + skip**(新規明示挙動)→ set_config → 既存 whereFor write 群は不変。
- 制約: `.returning → matched` 分岐(saveProjection / applyDeletedReset)維持。checkout Step 1 / 予約 clear 系の 0 行 semantics 維持(spec §2.5)。webhook 200 契約・idempotency 不変。
- 完了条件: 既存 stripe test green + 新規 unit: 退会後 log+skip(**red 検証**)→ [reviewed]。重要 fix(決済)tag 規律同上。

### Task 8: policy 適用(RLS on)+ 既存 iso test 追随

- 目的: `db/policies/rls-p2-enable.sql`(5 表 ENABLE + policy 群 + `SET lock_timeout`。共通形 4 表 = FOR ALL / users = コマンド別・DELETE policy なし、spec §2.2-2.3)+ `rls-p2-disable.sql`(rollback)を新設し、**test:iso global-setup が migrate 後に適用**(grants file と同機構。migration にしない理由 = spec §2.9)。既存 iso test の追随: 検証用 ground-truth read を owner 接続(`TEST_DATABASE_URL` client)へ、app 関数直呼びを withTenantTx 包みへ。
- 制約: **刺激は app role・観測のみ owner** の境界を維持(app 実挙動を owner で迂回して green にしない — codex cross-check 採用)。追随は「保証不変の整理」宣言。policy 式は `(SELECT app_current_user_id())` 包み。
- 完了条件: **test:iso 全本 green(RLS on)** = 「動く」の証明。→ [reviewed]。

### Task 9: 新規 iso test — RLS 単独防御 / per-command / context 漏れ / ghost / cascade

- 目的: spec §3.1-2〜6, 10 — ① `eq(userId)` なし直接 query の単独防御(5 表 × read/write 代表)② per-command: cards 4 操作(INSERT WITH CHECK / UPDATE USING / **user_id 付替え WITH CHECK 拒否** / DELETE 0 行)+ users 6 項目(scrub 行 SELECT・UPDATE 不可 / INSERT id≠context 拒否 / id 変更拒否 / DELETE 常時拒否 / definer scrub のみ成功)③ A/B 交互 tx 残留なし + `P0RLS` loud(NULL / 空文字・空表・対象 0 行の実挙動 pin)+ wrapper 実 PG(GUC 可視 / ROLLBACK 後消滅 / savepoint 維持)④ ghost: read 0 行 / INSERT 拒否(SQLSTATE 実測 pin)/ UPDATE・DELETE 0 行 + **owner で残存行なし確認** ⑤ cascade: app role deleteExam(A)完走 + B decoy 不変 ⑥ partial 連鎖回帰(bulk cards+tags / pull mixed 6 stream 挙動不変)。
- 制約: seed = owner / 刺激 = app / 観測 = owner。decoy 適格性は Iso-1 規律準拠。
- 完了条件: 全 assertion green + **red 検証 = 表単位 DISABLE で当該 leak 群 fail + cards・users は USING / WITH CHECK clause 単位変異(恒真化)で該当 assert のみ fail → 復旧 green 再確認**(commit message 記録)→ [reviewed]。

### Task 10: 新規 test — null 契約 pin + lifecycle behavioral

- 目的: spec §3.1-7〜8 — getCurrentUser 分岐 pin(実 PG: ghost = null で bootstrap 不発火)/ 再削除 no-op(中立文言)/ created 遅着 = 新規行 / 退会後 stripe log+skip(**外部副作用が skip より先に起きないこと含む**)/ dedupe-first 順序 pin。**null 契約 7 分類 × 担保 test の対応表を COVERAGE.md に追記**(+ 5 表 × 操作 × 経路の適用マトリクス、spec §2.7)。
- 制約: 実 PG(iso suite)。webhook handler は auth seam mock なし(署名 event 由来のため handleEvent 直呼び)。
- 完了条件: green + red 検証(各 pin の変異 1 件、例: dedupe 順序入替で fail)+ COVERAGE.md 更新 → [reviewed]。

### Task 11: stg 反映 runbook + after 計測手順

- 目的: OT 実行手順の全文確定(docs): ① stg 0025 migrate(ADMIN inline)→ ② push / deploy → ③ `rls-p2-enable.sql` SQL Editor 適用 + 確認 SQL(`pg_policies` / `relrowsecurity`)→ ④ **rollback 演習**(disable → 簡易 smoke → 再 enable)→ ⑤ CC smoke(通常一巡 + current_user + error log に `P0RLS` なし)→ ⑥ after 計測(Perf-0b 同条件・spec §3.2 基準)+ **OT が pool 指標記録**(utilization / wait / peak)→ ⑦ 2nd Clerk test user + A/B **交互 ×30 と並行同時 ×N** の純度突合。**prod 反映はしない**が、Phase 2 中の prod deploy は 0025 prod 適用とセット(spec §4)。
- 制約: 計測は Playwright MCP・warm 5 捨て 30 回・nearest-rank。手順 doc は live runbook として commit。
- 完了条件: runbook doc commit([no-review])。実走は push 後 OT 指示(標準フロー 3)。

### Task 12: code 完了 gate + checkpoint 報告

- 目的: whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm typecheck` / `pnpm build` / `pnpm test`(full)/ `pnpm test:iso` 全 exit 0 → 報告(「whole-repo lint exit 0 確認済」「test:iso green 確認済」明記)。session doc に Phase 3 申し送り(標準反復部分 vs 特殊設計部分の切り分け / alert 設計)を記録。
- 制約: `--no-verify` 禁止。review dispatch 観点 list に whole-repo lint / test:iso 実行確認を含める。
- 完了条件: 全 gate green + session doc commit + **stop checkpoint 報告で停止**。**これは code 完了の中間 checkpoint であり sprint 完了ではない — sprint 完了 = OT push 後の stg 実証(Task 11 実走・spec §3.2-3.3)合格**(codex cross-check 採用)。

---

## 依存関係 / 順序

Task 0 → 1 →(2 → 3 → 4 → 5 → 6 → 7)→ 8 → 9 → 10 → 11 → 12。Task 2-7 は RLS off で進行(挙動不変)、Task 8 で test 環境の RLS が on になる。3-7 の並べ替えは可だが 8 より前必須。

## Red 検証の分類申告(test-only commit 用)

Task 9-10 は test-only「増」= red 検証必須 + 簡易 review。Task 8 の既存 iso 追随は「保証不変の整理」。混在 diff は分割 commit で回避。
