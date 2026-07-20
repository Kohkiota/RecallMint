# RLS-P2: closure 5 表 実証 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。

**Goal:** {users, exams, cards, tombstones, study_days} に RLS を有効化し、「動く・漏れない・遅くならない」を test:iso + stg で実証する。
**Spec(正本・凍結):** `docs/superpowers/specs/2026-07-20-rls-p2-representative-closure-design.md`(§ 参照は全てこの spec)。
**Architecture:** tx 冒頭 `set_config('app.user_id', …, true)` + loud plpgsql 関数 + 表単位 policy(users のみコマンド別 + SECURITY DEFINER 3 本)。migration 2 分割(0025 functions → code → 0026 policies)。

## Global Constraints(全 task 共通)

- 既存挙動の保全が最優先。変更は spec 明示箇所のみ。Gemini prompt / `ocr-extract.ts` 不可触。`eq(userId)` は全経路で残す。
- feat/fix commit = canonical review(`requesting-code-review` デフォルト経路)+ Codex(`scripts/ai/codex-review.sh`)pass → `[reviewed]`。test 増 = red 検証 + 簡易 review、commit message に「red 検証」。宣言 token は Stop hook 準拠。
- helper の tx 参加は「optional 末尾引数 `dbc: DB | TenantTx = getDb()`」パターンで統一(既存 caller 無改変・tx caller が明示注入。`processMutation(db,…)` と同型)。
- 新規 env なし。`.env.example` 変更なし。tx 内外部 I/O 禁止(spec §0.2)。
- per-task gate: 変更 file の unit + `pnpm test:iso` green(Task 8 以降は RLS on 状態)。sprint 完了 gate は Task 12。

---

### Task 0: drizzle pgPolicy 採否評価(Step 0)

- 目的: policy 定義を drizzle `pgPolicy`(schema.ts 定義 + generate)で持つか手書き SQL migration で持つかを確定(spec 確定 8)。
- 制約: Context7 + registry 直叩きで drizzle-orm 0.45.2 の `pgPolicy` / `.enableRLS()` の migration 生成挙動(TO role 指定 / `(SELECT fn())` 式 / per-command)を裏取り。**適用 SQL 内容は spec §2.2-2.3 と同一に保てることが採用条件**。表現不能なら手書き SQL(0005/0007 の data-migration 前例機構)。
- 完了条件: 採否 + 根拠 1 段落を session doc に記録(コード変更なし・commit は docs)。以降 task は決定に従う。

### Task 1: migration 0025 — loud 関数 + SECURITY DEFINER 3 本

- 目的: `app_current_user_id()`(STABLE plpgsql、`nullif(current_setting('app.user_id', true), '')` NULL で **RAISE ERRCODE '28000'**。28000 = invalid_authorization_specification: app role が他で発生させない標準 code、42501 と区別可・test で pin)/ `app_bootstrap_user_from_clerk(text) RETURNS SETOF users`(STABLE)/ `app_resolve_user_for_stripe(p_by text, p_value text) RETURNS TABLE(id uuid, deleted_at timestamptz)`(whereFor 4 arm の忠実移植)/ `app_scrub_deleted_user(uuid) RETURNS void`(現行 scrub UPDATE の忠実移植・再設計禁止)。
- 制約: 3 本は SECURITY DEFINER + `SET search_path = public` + `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO recallmint_app`。migration は additive(旧コード無影響)。
- 完了条件: migrate green(test:iso 既存 85 本不変)+ 新規 iso test: RAISE の SQLSTATE pin / bootstrap の 0-1 行 / resolver 4 arm / scrub の NULL 化 3 列(**red 検証**: 関数 DROP 状態で fail)→ [reviewed]。

### Task 2: tenant-tx wrapper

- 目的: `lib/db/tenant-tx.ts` 新設 — `export type TenantTx = Parameters<Parameters<DB['transaction']>[0]>[0]` / `setTenantContext(tx, userId)`(`SELECT set_config('app.user_id', ${userId}, true)`)/ `withTenantTx<T>(db, userId, fn)`(db.transaction + 冒頭 setTenantContext)。
- 制約: 新レイヤーはこの 2 形態のみ(spec §2.7)。userId は UUID 文字列を検証せずそのまま渡す(検証は DB 側 ::uuid cast + loud 関数)。
- 完了条件: unit(mock db で set_config が先頭に発行される / fn の戻り値透過 / throw 透過)green(**red 検証**)→ [reviewed]。

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

- 目的: user.created = 事前採番(`crypto.randomUUID()`)+ 存在チェック(bootstrap 関数)→ set_config → `INSERT (id, clerk_id, email)`(RETURNING・onConflict 不使用。race は clerk_id UNIQUE → outer catch 200 + 通知)。user.deleted = resolve を bootstrap 関数へ + tx 冒頭 set_config + scrub を `app_scrub_deleted_user` 呼出へ + notifyOps 文言中立化(spec §2.6)。
- 制約: dedupe-first 順序不変。Group I DELETE 群・assets UPDATE・runTransactionWithRetry・Stripe cancel ループ不変。metadata sync の gate 条件(新規時のみ)同値。
- 完了条件: webhook route 既存 test(Group I invariant 含む)green + 新規 unit: 事前採番 INSERT 形 / 再配信 no-op / 文言(**red 検証**)→ [reviewed]。重要 fix(認証・削除)につき tag は OT 実機確認後の規律に従う。

### Task 7: stripe 経路配線

- 目的: `handle-stripe-event.ts` / `upgrade/actions.ts` の users 触り経路の冒頭に `app_resolve_user_for_stripe` → **deleted_at 非 NULL = log + skip**(新規明示挙動)→ set_config → 既存 whereFor write 群は不変。
- 制約: `.returning → matched` 分岐(saveProjection / applyDeletedReset)維持。checkout Step 1 / 予約 clear 系の 0 行 semantics 維持(spec §2.5)。webhook 200 契約・idempotency 不変。
- 完了条件: 既存 stripe test green + 新規 unit: 退会後 log+skip(**red 検証**)→ [reviewed]。重要 fix(決済)tag 規律同上。

### Task 8: migration 0026(RLS on)+ 既存 iso test 追随

- 目的: 5 表 `ENABLE ROW LEVEL SECURITY` + policy 群(共通形 4 表 = FOR ALL / users = SELECT・INSERT・UPDATE・DELETE なし、spec §2.2-2.3 の SQL を Task 0 決定の機構で)。既存 iso test の追随: 検証用 ground-truth read を owner 接続(`TEST_DATABASE_URL` client)へ、app 関数直呼びを withTenantTx 包みへ。
- 制約: 追随は「保証不変の整理」(呼出形の変更のみ・assertion 不変)として commit message に宣言。policy 式は `(SELECT app_current_user_id())` 包み。
- 完了条件: **test:iso 全本 green(RLS on)** = 「動く」の証明。→ migration 部 [reviewed]。

### Task 9: 新規 iso test — RLS 単独防御 / context 漏れ / ghost JWT

- 目的: spec §3.1-2〜4 — ① `eq(userId)` なし直接 query で A context から B 行が read 不可視・write 0 行 or 拒否(5 表 × read/write 代表)② A/B 交互 tx(COMMIT/ROLLBACK 両系)で残留なし + set_config なし tx / tx 外 query が SQLSTATE 28000(未設定 NULL / revert 空文字の両形態)③ ghost(scrub 済み UUID)context で 5 表 read 0 行・write 0 行 or 拒否。
- 制約: seed は owner・検証も owner ground-truth。decoy 適格性は Iso-1 の規律準拠。
- 完了条件: 全 assertion green + **red 検証 = 5 表の policy を DISABLE した変異状態で ①③ が fail することを実測**(commit message 記録)→ [reviewed]。

### Task 10: 新規 test — null 契約 pin + lifecycle behavioral

- 目的: spec §3.1-5〜6 — getCurrentUser 分岐 pin(Task 5 unit を iso でも実 PG 化: ghost = null で bootstrap 不発火)/ 再削除 no-op / created 遅着 = 新規行 / 退会後 stripe log+skip / dedupe-first 順序 pin(現状 pin・変更なし)。
- 制約: 実 PG(iso suite)。webhook handler は auth seam mock なし(署名 event 由来のため handleEvent 直呼び)。
- 完了条件: green + red 検証(各 pin の変異 1 件、例: dedupe 順序入替で fail)→ [reviewed]。

### Task 11: stg 反映 runbook + after 計測手順

- 目的: OT 実行手順の全文確定(docs): ① stg 0025 migrate(ADMIN inline)→ ② push / deploy → ③ 0026 migrate → ④ CC smoke(通常一巡 + current_user + error log に 28000 なし)→ ⑤ after 計測(Perf-0b 同条件・spec §3.2 の基準数値)→ ⑥ 2nd Clerk test user 作成 + A/B 交互 pull ×30 の純度突合 → rollback 手順(5 表 DISABLE)。**prod 反映はしない**(Phase 2 = stg 限定)。
- 制約: 計測は Playwright MCP・warm 5 捨て 30 回・nearest-rank。手順 doc は live runbook(docs/ops or audit)として commit。
- 完了条件: runbook doc commit([no-review])。実走は push 後 OT 指示(標準フロー 3)。

### Task 12: sprint 完了 gate + 完了報告

- 目的: whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm typecheck` / `pnpm build` / `pnpm test`(full)/ `pnpm test:iso` 全 exit 0 → 報告(「whole-repo lint exit 0 確認済」「test:iso green 確認済」明記)。
- 制約: `--no-verify` 禁止。review dispatch 観点 list に whole-repo lint / test:iso 実行確認を含める。
- 完了条件: 全 gate green + session doc(実装記録)commit + stop checkpoint 報告で停止(push・stg 反映は OT)。

---

## 依存関係 / 順序

Task 0 → 1 →(2 → 3 → 4 → 5 → 6 → 7)→ 8 → 9 → 10 → 11 → 12。Task 2-7 は RLS off で進行(挙動不変)、Task 8 で test 環境の RLS が on になる。3-7 の並べ替えは可だが 8 より前必須。

## Red 検証の分類申告(test-only commit 用)

Task 9-10 は test-only「増」= red 検証必須 + 簡易 review。Task 8 の既存 iso 追随は「保証不変の整理」。混在 diff は分割 commit で回避。
