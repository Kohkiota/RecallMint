# RLS-P2 closure 5 表 実証 — 実装記録(Task 0-12)

- 日付: 2026-07-20 / branch: `develop`(未 push)
- spec: `docs/superpowers/specs/2026-07-20-rls-p2-representative-closure-design.md`
- plan: `docs/superpowers/plans/2026-07-20-rls-p2-representative-closure.md`
- 方式: `superpowers:subagent-driven-development`。CLAUDE.md 準拠へ適応 = implementer は commit せず、controller が canonical(`requesting-code-review`)+ Codex(`scripts/ai/codex-review.sh`)review → fix loop(Crit0/Imp0)→ commit([reviewed])。review→commit 一方向則。

## 結論
- **code 実装(Task 0-10)完了・全 review 通過・commit 済**。Task 11 = OT runbook。全 sprint gate green。
- **RLS は test:iso で有効化済**(policy on・iso 143 green)。**stg/prod への policy 適用 + smoke + 性能 + pooler 検証は OT**(runbook `docs/ops/rls-p2-stg-runbook.md`)= sprint 完了の残条件。
- **これは code 完了の中間 checkpoint**。sprint 完了 = OT push 後の stg 実証(smoke + after 計測 + pooler)合格まで(spec §4)。

## commit(range 起点 `cf91d41`)
| commit | Task | 内容 | tag |
|---|---|---|---|
| `a546be6` | 1 | 0025 loud 関数 + SECURITY DEFINER 3 本(bootstrap/stripe-resolve/scrub)| feat [reviewed] |
| `b4434bc` | 2 | `withTenantTx`/`setTenantContext` wrapper | feat [reviewed] |
| `daf8bcc` | 3 | read 経路 tx 化(5 表 read・dbc 必須・pull 6-way→1tx 直列)| feat [reviewed] |
| `65a15c4` | 4 | write tx に set_config(9 本一律)+ §6.6 fix + create-exam | feat [reviewed] |
| `cb5871e` | 5 | getCurrentUser claim-first + contact bootstrap + **ghost fix** | feat [reviewed] |
| `b45cbdc` | 6 | clerk lifecycle(事前採番 created / scrub 関数 deleted / 文言中立化)| feat [reviewed] |
| `72ccd98` | 7 | stripe 経路 context 配線 + 退会 log+skip | feat [reviewed] |
| `552d78e` | 8 | 5 表 RLS policy 有効化 + iso test 追随 | feat [reviewed] |
| `a3ff570` | 9 | RLS 単独防御 behavioral test 群(35 本)| test [reviewed] |
| `e216600` | 10 | null 契約 + lifecycle 実 PG pin + COVERAGE.md | test [reviewed] |
| `0c51869` | 11 | stg 反映 runbook | docs [no-review] |
| 他 | — | Task0 pgPolicy 評価(下記 Phase 3)/ codex raw findings(`docs/codex/2026-07-20-rls-p2-task*`)| docs |

## review で捕捉した実バグ(dual-review + 再 review の価値)
- **Task 5 Critical**(canonical・Codex 見逃し): claim-present が clerk_id→id lookup に変わり、RLS-off で scrub 済み ghost 行(id 残存・deleted_at 付)を getCurrentUser が非 null 返し → 削除後 60s JWT window で write/Stripe 経路(`!user` のみ check)が通る回帰。→ claim-present read に `isNull(deletedAt)` 先取り(将来 policy 述語の app 層二重防御)+ iso 回帰 test。
- **Task 5 Important**(Codex 再 review): 修正後、旧契約(ghost 行が返る)を assert する mock unit test が矛盾 → 新契約(ghost→null)に書換。
- **Task 7 Important ×2**(Codex 再 review・fix loop 3 周): ① unlinked(resolve→null)path が未 pin ② checkout が clerkId のみ resolve で削除済 user(clerk_id NULL 化)を log+skip し損ねる → customerId fallback(clerkId primary 維持・safe additive)。
- **Task 8 Critical**(両レビュアー一致・canonical empirical 再現): enable.sql が postgres-js `.simple()`(単一暗黙 tx)下で re-run 時 `CREATE POLICY already exists` → batch 全 rollback → re-enable が RLS silent off。→ `DROP POLICY IF EXISTS` 冪等化 + `.simple()` empirical 再検証(recovers YES)。
- **Task 10 Important**: subscription.updated skip test の no-I/O/no-write assertion が skipIfDeleted 変異で未判別(retrieve は checkout のみ / sync は A-4 gate / no-write は RLS policy)→ honest disclosure(log-emission のみ genuine red・Task7 checkout test へ cross-ref)。

## 最終 whole-branch review(Task 12)
- **Critical 0 / Important 0**。完全性 sweep = **RLS 表 access で context 未確立の経路ゼロ**(全 read helper が dbc + 全 caller が withTenantTx / 全 write-tx が冒頭 setTenantContext / apply 層は context 下 tx のみ / users 特殊経路は definer 3 本 signature 一致 / operator は owner)。cross-task 整合(deleted_at IS NULL 層が getCurrentUser・policy・stripe skip で一致 / definer signature 一致 / users DELETE policy 不在と app 経路一致)・deploy 順序・rollback 安全(app-WHERE が二層目)を確認。
- Minor: M1(COVERAGE.md の OCR write 記述 stale → 本 commit で dual-enforced に訂正)/ M2(rolling-deploy P0RLS window・runbook 記載済・self-heal・no action)。

## gate(Task 12)
- whole-repo `pnpm lint`(--max-warnings=0)**exit 0** / `pnpm typecheck` exit 0 / `pnpm build` exit 0 / `pnpm test`(full)**237 files 3781 passed** / `pnpm test:iso`(RLS on)**18 files 143 passed**。

## 設計の要点(spec 準拠)
- GUC `app.user_id`(tx-local `set_config(…, true)`)+ loud `app_current_user_id()`(未設定 = SQLSTATE **P0RLS** RAISE)。policy = 4 表 FOR ALL / users コマンド別(select・update に deleted_at IS NULL / DELETE policy なし = deny)。
- users bootstrap 循環は SECURITY DEFINER 3 本(clerk_id resolve / stripe 4-anchor resolve / scrub)で解消。scrub は definer 自衛(p_user_id ≠ app_current_user_id() で RAISE)。
- users lifecycle write は RETURNING/upsert 不使用・事前採番 INSERT。退会後 Stripe = log + skip。tx 内 外部 I/O 禁止(projectStripeSubscription を分解し saveProjection のみ tx 内)。RLS 有効後も `eq(userId)` 全経路維持(二重防御)。
- policy は migration にせず versioned SQL(`db/policies/`)+ global-setup 適用(spec §2.9・prod は runbook 手動)。

## Phase 3 申し送り(spec §4.1)
1. **tx 境界の DDD 整理を Phase 3 Step 0 正式項目に**: use-case 入口で withTenantTx / repository・apply 層は TenantTx のみ受領 / raw getDb 封じ込め(lint / export 制限)。Phase 2 の「5 表 helper の dbc 必須引数」はその第一歩。
2. **標準反復部分 vs 特殊設計部分の切り分け**: 標準 = 共通形 policy + set_config 配線(全表展開は本 sprint の型の反復)。特殊 = users の definer 3 本 / lifecycle / Stripe / review-ingest の完全 closure(reviews/answer_events/study_sessions)= Phase 3 で再設計対象。
3. **loud 例外の alert 条件設計**(P0RLS を専用 log event 化・経路/query 種別・UUID/PII 非搭載。本番展開時 alert)。
4. **drizzle pgPolicy(Task 0 評価済)**: 0.45.2 は per-table/per-command/ENABLE を表現可(非意味差 = AS PERMISSIVE 明示 + role 名 quote)。Phase 3 で policy を migration 昇格する際は schema↔SQL drift-detection test 要。
5. **null 契約 3 SSR-render class 未担保**(COVERAGE.md 明記: layout SyncingPage / RSC null render / marketing 匿名)= SSR render test(別 task・data leak でなく UX)。
6. **Task 9/10 Minor**(optional polish): UPDATE WITH CHECK の inline positive control / stg runbook の Clerk test-mode regex 確定。

## 未 push
本 session の全 commit は未 push(OT が報告確認 → push → stg deploy → OT runbook 実行)。stg 実証(smoke + after 計測 + pooler)合格で sprint 完了。
