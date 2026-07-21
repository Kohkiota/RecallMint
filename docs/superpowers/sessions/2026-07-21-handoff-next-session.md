# 次セッション引き継ぎ(2026-07-21 セッション締め)

> **新セッション冒頭に貼付け用。** RecallMint(local-first 学習 SaaS)。CLAUDE.md が絶対ルール。

## 1. today の到達点(2026-07-18〜21)
- **RLS-P2 完了**: closure 5 表 {users, exams, cards, tombstones, study_days} で RLS 本体を実証。SDD Task 0-12・range `a546be6..2a2debb`・全 [reviewed]。iso 143(RLS on)/ test 3781 / lint0 tsc0 build0。最終 whole-branch review Crit0/Imp0・完全性 sweep clean。
- **stg 実証 Phase A-C 全合格**: A(RLS off deploy 健全)/ B(RLS on・write 含む・P0RLS 0・RLS 自体 ~+6ms)/ C(pooler 純度 ~180 req 双方向漏れ 0)。
- **git 状態**: `develop` = `origin/develop` = `3050f5b`(push 済)。**`main` は local ff-merge 済(3050f5b)だが `origin/main` は `e10ce32` のまま未 push**。
- 前提サブ成果: C1/C2(devcontainer 掃除・版 pin・OT rebuild + `codex login` 待ち)/ Iso-0/1(test:iso 基盤)/ Perf-0/0b(before 計測)/ RLS-P1(recallmint_app role)。
- 統合ステータス: `docs/todo-v47-integrated-status.md`(本セッション全成果 + backlog)。

## 2. 次タスク = **Phase 3(RLS 全表展開 + 標準化)**
最優先。Phase 2 の型の反復 + 標準化。着手時は brainstorm→spec→plan→codex-plan-review の full flow。
1. 残り **14 表への RLS 展開**(共通形 policy + set_config 配線)。
2. **tx 境界の DDD 整理 = Step 0**: use-case 入口で withTenantTx / repository は TenantTx のみ受領 / raw getDb 封じ(lint・export 制限)。Phase 2 の dbc 必須引数が第一歩。
3. **tag 3 表 + review-ingest 系(reviews/answer_events/study_sessions)の完全 closure**(Phase 2 partial 残置)。
4. **prod 有効化**(全表後・**flip 直前に同日 before 計測**・runbook §5 準拠)。**drizzle pgPolicy** schema 昇格を Task 0 で評価(drift-detection test 要)。
5. loud alert 設計(P0RLS 専用 log event)。

## 3. 着手前に必ず確認する OT 残件 / ブロッカー
- **origin/main push = prod deploy 可否**(未実行)。push するなら **prod に 0025 functions 適用が前提**(未適用の prod に新コードが出ると app_bootstrap/resolve/scrub/contact 経路が 500)。**Phase 2 policy は prod に出さない**(stg 限定)。
- **OT rebuild 待ち**(C2・rebuild 後 `codex login` 再実行必須)。
- current_user=recallmint_app 確認 / server-log P0RLS 確定不在 = OT の DB/Vercel Logs(browser 不可)。
- 完全同時並行 pooler(2 profile)= 受容済み残余。
- pull 直列化 +47〜69ms = 許容確定・trigger = Phase 3 計測で継続超過なら高度化起票。

## 4. ワークフロー不変事項
- 実装 = subagent-driven-development(implementer は commit せず・controller が canonical `requesting-code-review` + Codex `scripts/ai/codex-review.sh` → fix loop Crit0/Imp0 → `[reviewed]` commit)。review→commit 一方向則。
- 完了 gate: whole-repo `pnpm lint --max-warnings=0` + `pnpm test:iso` green を**全 sprint 無条件**。dep/Next/lockfile 触る時は install --frozen-lockfile + typecheck + build 追加。
- 重要 fix(決済・認証・削除・外部副作用)の runtime 検証 = stg smoke。
- subagent dispatch は foreground(run_in_background 禁止)。LSP diagnostics が編集途中 stale を出す既知挙動 → clean tsc(tsbuildinfo 削除)で ground truth を取る。
- OT 出力規律: 結論のみ・番号 bullet・判断必要 yes/no・詳細 doc path。

## 5. 参照 doc パス
- 統合ステータス: `docs/todo-v47-integrated-status.md`
- RLS-P2: spec `docs/superpowers/specs/2026-07-20-rls-p2-representative-closure-design.md` / plan `docs/superpowers/plans/2026-07-20-rls-p2-representative-closure.md` / session `docs/superpowers/sessions/2026-07-20-rls-p2-representative-closure-implementation.md` / runbook `docs/ops/rls-p2-stg-runbook.md`
- 設計基盤: Perf-0 `docs/audit/2026-07-18-rls-performance-before-factfinding.md` / Iso-0 `docs/audit/2026-07-18-tenant-isolation-integration-test-factfinding.md` / RLS-P1 `docs/superpowers/specs/2026-07-18-rls-p1-app-role-separation-design.md`
- 現場確認: `docs/audit/2026-07-20-rls-p2-lifecycle-null-affected-rows-factfinding.md`
- Codex raw: `docs/codex/2026-07-20-rls-p2-task*.md`
- テスト資産: `tests/integration/pg/`(RLS 単独防御/per-command/context/ghost/cascade/partial + COVERAGE.md)/ `lib/db/tenant-tx.ts` / `db/policies/rls-p2-{enable,disable}.sql` / `drizzle/migrations/0025_rls_p2_functions.sql`
- MEMORY: `project_rls_p2_representative_closure` / `project_c1_devcontainer_workflow_cleanup` / `reference_stg`
