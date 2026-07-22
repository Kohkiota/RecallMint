# RecallMint 統合ステータス todo v47(2026-07-18〜21 セッション統合)

- 版: **v47**(v46 = OT 管理正本を本体とし、本 doc は 2026-07-18〜21 セッションの全成果を統合した完全版)
- 更新: 2026-07-21 / 種別: 全 sprint 横断ステータス + roadmap
- 位置づけ: claude.ai の view。**最終優先順位は OT 決定が優先**。各ステータスは実コード verify / closure doc / stg 実証に基づく。
- **v46 突合の注記**: 「todo v46」は OT 管理で本 repo に無い。本 v47 は (a) 今セッション成果(完全把握)+ (b) repo-visible backlog(`docs/next-sprints-priority.md` v18 相当 + `docs/cache-fix-roadmap.md` + MEMORY)を統合したもの。**v46 固有の OT 項目(未 repo 化の backlog / 優先順位)は OT が v46→v47 に反映**する前提。参照正本: 各 closure doc / spec / plan(下記 path)。

---

## 0. 本セッション(2026-07-18〜21)= devcontainer 健全化 → テナント隔離基盤 → RLS 本体実証

一本の流れ: **C1/C2(devcontainer 掃除・版 pin)→ Iso-0/1(実 PG 2 テナント統合テスト基盤)→ Perf-0/0b(RLS before 計測)→ RLS-P1(app role 分離)→ RLS-P2(closure 5 表で RLS 本体を実証・stg Phase A-C 合格)**。テナント隔離を「構造 pin(eq-spy)」から「実 PG behavioral + DB 強制(RLS)」へ引き上げた。

---

## 1. ✅ 本セッションでクローズ

### C1 — devcontainer 掃除
- chrome-devtools MCP **全削除**(0/24 セッションで実使用ゼロの実測根拠)/ noVNC 削除 / A-1〜A-7 整理 / post-create postcondition 化(`fail()` 検証)/ deny 2 行。
- 帰結: **Playwright MCP が唯一のブラウザ MCP**。正記録: `docs/superpowers/sessions/2026-07-18-c1-workflow-cleanup-execution.md` / MEMORY `reference_stg` `project_c1_devcontainer_workflow_cleanup`。

### C2 — version pin 統一(f3e6aa5 / 7140945)
- playwright MCP **0.0.78** / context7 **3.2.4** / Codex **0.144.5**(worktree-snapshot contract gate 通過)/ `.devcontainer/README.md` 新設(pin 一覧・更新手順・責務表)/ headless 回帰 fix(`--headless` 明示。`@latest` の壊れ方 = headless 既定の版依存変化 → MCP bump 時の確認項目化)。
- **OT rebuild 待ち**(checklist=C2 doc §7、rebuild 後 `codex login` 再実行必須)。正記録: `docs/superpowers/sessions/2026-07-18-c2-version-pin-unification.md`。

### Iso-0 / Iso-1 — 実 PG 2 テナント統合テスト基盤(launch blocker 解消)
- devcontainer 常駐 **PostgreSQL 17** + `test:iso`(`vitest.integration-pg.config.ts`・単一 fork 直列)+ 2 テナント fixture + 完全性 assertion(三者一致)+ `withTenant`/`asTenant` seam。
- **OCR owner 述語 fix**(completeUploadTx / markFailed に user_id 述語追加)。
- **全 sprint 完了 gate に `test:iso` 恒久組込み**(CLAUDE.md 反映済・無条件)。
- eq-spy の限界を明文化(構造 pin でありテナント隔離の証明でない)。正記録: `docs/audit/2026-07-18-tenant-isolation-integration-test-factfinding.md` / `docs/superpowers/specs/2026-07-18-tenant-isolation-integration-test-design.md`。

### Perf-0 / Perf-0b — RLS before 計測
- RLS(SET LOCAL + tx 包み)が直撃する並列/tx 構造の全列挙: **並列衝突 3 箇所**(/api/pull 6-way・upload RSC N=2・entity-mutations bulk group 並列)/ **§6.6 発見**(runUploadGuardTx が tx 保持中に別接続 read)。before warm p50/p95 = stg 実測(数字表は doc §3.2)。正記録: `docs/audit/2026-07-18-rls-performance-before-factfinding.md`。

### RLS-P1 — 実行 role 分離(ee341f2 [reviewed] 他)
- 非所有者 role **`recallmint_app`**(LOGIN NOSUPERUSER NOBYPASSRLS・CRUD grant のみ)/ `getDb()`=**`DATABASE_URL_APP`** / **無印 `DATABASE_URL` 全廃** / `getAdminDb()`=`DATABASE_URL_ADMIN`(migration/operator)/ owner URL は常設環境に置かず実行時供給。爆発半径制限(DDL/TRUNCATE を app 経路から構造排除)。正記録: `docs/superpowers/specs/2026-07-18-rls-p1-app-role-separation-design.md` / session 同名。

### RLS-P2 — closure 5 表で RLS 本体を実証(range a546be6..2a2debb・全 [reviewed])★本セッションの主成果
- **5 表** {users, exams, cards, tombstones, study_days} に RLS policy 有効化。SDD Task 0-12、canonical + Codex fix loop で **Critical/Important 実バグ 6+ 件捕捉・全収束**、最終 whole-branch review Crit0/Imp0・完全性 sweep clean。
- gate: lint0 / tsc0 / build0 / **test 3781** / **test:iso 143(RLS on)**。
- **stg 実証 Phase A-C 全合格**:
  - Phase A(RLS off・deploy 健全性): read 一巡 全 200・P0RLS 0。
  - Phase B(RLS on・write 含む): entity-mutations/review-events 両 write tx が RLS 下で正常適用・study_days server 反映・**P0RLS 0**。性能 = RLS 自体 ~+6ms(安価)、pull 直列化 ~+47〜69ms(baseline drift と混在・§残件)。
  - Phase C(pooler 純度): A/B 4 boundary × 並行 burst = **~180 req 純度突合・双方向漏れ 0**(300 vs 4 の非対称一度も破れず)。Supavisor 接続再利用で app.user_id 漏れなし。
- **prod は 0025 functions + 新コードまで反映・policy は stg 限定**(Phase 2)。**main への local ff-merge 済(3050f5b)・origin/main は未 push**(push = prod deploy 誘発、0025 prod 適用が前提)。
- 正記録: spec/plan/session `docs/superpowers/{specs,plans,sessions}/2026-07-20-rls-p2-representative-closure*` / runbook `docs/ops/rls-p2-stg-runbook.md` / Codex raw `docs/codex/2026-07-20-rls-p2-task*`。

### テスト品質監査 follow-up(前セッション 3 件のうち 2 件を本セッションで解消)
- ① 実 PG 2 テナント統合テスト = **Iso-1 で解消**。② RLS 導入判断 = **RLS-P1/P2 で実行**。③ ReviewLog 保持 = S2.1 Step 0(未着手・下記 horizon)。

---

## 2. 設計資産(RLS 実証で確立・Phase 3 / 他プロジェクト再利用可)

- **tx-local context**: GUC `app.user_id` を各 tx 冒頭 `set_config('app.user_id', <uuid>::uuid::text, true)`(COMMIT/ROLLBACK で消滅 = pooler 越しで漏れない)。`withTenantTx` / `setTenantContext`(`lib/db/tenant-tx.ts`)。
- **loud 関数** `app_current_user_id()`: 未設定/空文字で **SQLSTATE `P0RLS`** RAISE(silent 0 行を許さない)。cast を set_config に含め不正 uuid を設定時 loud 化。
- **policy 形**: 共通 4 表 = FOR ALL USING=WITH CHECK `user_id=(SELECT app_current_user_id())`(initPlan 化)/ **users = コマンド別**(select・update に `deleted_at IS NULL`・**DELETE policy なし=deny**)。FORCE RLS しない(owner bypass で seed/migrate/operator 素通し)。
- **users bootstrap 循環の解**: **SECURITY DEFINER 3 本**(clerk_id resolve / stripe 4-anchor resolve / scrub・定義者関数ゆえ RLS 素通し・関数自身が条件を書く)。scrub は definer 自衛(p_user_id≠context で RAISE)。
- **claim-first 認証**: getCurrentUser は claim あり=id で read(0 行→null・bootstrap fallback せず)/ claim なし=definer bootstrap。isNull(deletedAt) を app 層でも二重防御(ghost 回帰 fix)。
- **users lifecycle write**: RETURNING/upsert 禁止（**users lifecycle 限定**）+ **事前採番 INSERT** / 退会後 Stripe = **log + skip** / tx 内 外部 I/O 禁止（projectStripeSubscription を分解）。
- **policy 適用機構**: migration にせず versioned SQL(`db/policies/rls-p2-{enable,disable}.sql`・冪等 DROP IF EXISTS 付)+ global-setup 適用。「0025 functions → deploy → policies」の順序を守るため(逆順は P0RLS)。

---

## 3. 学習・原則への追加(本セッション・CC 整理)

1. **RLS 起因の 0 行は既存の意図された冪等吸収(outbox 再送/webhook 再配信/double-click)と識別不能 → loud 設計(context 未設定=例外)の必然**。silent RLS だと全 unchecked-silent 箇所が漏れの隠蔽点化する。
2. **SECURITY DEFINER は RLS を素通しする → 関数自身が条件(自衛検査・最小返却列・p_by allowlist)を書く**。
3. **owner でのテストは policy 未適用の誤認を生む**(SQL Editor / owner 接続は RLS を bypass ゆえ「動いた」が検証にならない)。stimulus は app-role+context、観測のみ owner。
4. **baseline drift 対策 = flip 直前の同日 before 再取得**(runbook §5 に反映済 `3050f5b`)。数日跨ぎ before は network floor/instance 状態 drift でコード変更・RLS 増分を汚染する(実測: pull delta が DB 仕事皆無なのに +77ms)。
5. **`@latest` の壊れ方 = headless 既定の版依存変化**(C2・MCP bump 時は headless 挙動を確認)。
6. **統合レビューの型が機能**: 私案(CC drafting)→ 外部レビュー ×N(GPT/Codex 独立論点・anchor 防止)→ 独自裏取り(現物再確認)→ 現場確認(実装依存の事実確定)→ 統合(誰の指摘か明示・OT 判断)。RLS-P2 で実バグ 6+ 件を捕捉した dual-review + 再 review の実効性の記録。

---

## 4. 次セッション horizon

### 🔜 Phase 3(最優先)= RLS 全表展開 + 標準化
- 残り **14 表(user_id 保持 19 − closure 5)への RLS 展開**(共通形 policy + set_config 配線 = 本 sprint の型の反復)。
- **tx 境界の DDD 整理 = Step 0 正式項目**: use-case 入口で withTenantTx / repository・apply 層は TenantTx のみ受領 / raw getDb 封じ込め(lint / export 制限)。Phase 2 の「5 表 helper の dbc 必須引数」が第一歩。
- **tag 3 表(tag_categories/tag_options/card_tags)+ review-ingest 系(reviews/answer_events/study_sessions)の完全 closure**(Phase 2 で partial 残置)。
- **prod 有効化**(全表 RLS on 後・**§5 の直前 before 計測付き**)。**drizzle pgPolicy** を schema 定義に昇格するか評価(Task 0 = 表現可・非意味差 2 点・schema↔SQL drift-detection test 要)。
- **loud alert 設計**(P0RLS を専用 log event 化・本番展開時 alert 条件)。

### 残件記録(受容済み残余 / trigger 付き)
- **完全同時並行 pooler 検証**(2 device/profile)= 受容済み残余(接続再利用漏れは 180 req で確認済・完全同時は OT)。
- **pull 直列化 +47〜69ms** = 許容確定(背景 sync 経路)。**trigger = Phase 3 計測で継続超過**なら高度化(チャンク分割)起票。
- **列単位 GRANT**(Phase 3+ 検討)。
- **公開前 PII 監査(バケット・公開前にまとめて判断)**: ① stg `DATABASE_URL_APP` パスワード rotation(Wave2 で露出・未実施)② integration_failures が user 削除で scrub されない(clerkId/stripeCustomerId/context jsonb/errorMessage 残置)③ contact_messages を app-role が全行 SELECT 可能に留まる(GDPR `DELETE WHERE user_id` が PG の「WHERE 参照列に SELECT」要求ゆえ RLS-P3 hardening で table SELECT を保持・**列単位 `SELECT(user_id)` 化で app-role の contact 全行 PII 読み取りを解消可**・上記 列単位 GRANT と同トラック)。
- current_user = recallmint_app(DB `SELECT current_user`)/ server-log P0RLS 確定不在 = OT 残件(browser 不可)。

### Phase 3 の後
- **launch 残件の再棚卸し**(v46 の backlog と突合)。下記 §5 の未着手 backlog を Phase 3 完了時点で再優先度付け。

---

## 5. carry-forward backlog(repo-visible・OT が v46 と突合)

### 短期(launch blocker 寄り)
- **LocalSync MVP**(card 編集/削除の local-first 化)— spec 確定・schema scaffold 済・sync helper/bulk route/orchestrator/inline Dexie 化 未着手。inline 編集 ~2.5s→~50ms。母艦: `docs/cache-fix-roadmap.md` §5。
- **試験セットの手動新規作成経路**(OCR 代替・OT 提案)— spec 未着手。schema source 列 / manual dummy 行 / card 手動追加 UI 等の論点。

### 中期(spec/idea)
- **波3**(TS6 + Stripe 22.2.0 + minor 群・dep matrix v1.3 §3.3 正本)。
- **S2.1** FSRS smart 復習(launch-viable minimum)+ **ReviewLog 保持確認**(S2.1 Step 0・card 状態だけでは replay 不能)。
- **S2.0b** tag schema 移行 + inline 編集 + bulk 編集(大スコープ)。
- **S2.2 / S2.3** dashboard / custom 練習。

### 後回し / launch 後
- 選択肢 attach error の表示位置(狭い delete cell・Minor)/ 画像上限 10 枚の単位表示観察 / safe-area(`viewport-fit=cover` 導入時のみ再燃)/ テーブルビュー画像の実 attach smoke(Sprint T 未検証残)/ 複数端末対応を捨てる判断は不可逆。

---

## 6. ワークフロー不変事項(次セッションでも維持)

- sprint フロー: brainstorm→spec→writing-plans→codex-plan-review / 実装 = subagent-driven-development(CLAUDE.md 準拠へ適応 = implementer は commit せず controller が canonical + Codex → [reviewed])。
- review→commit の一方向則 / feat・fix は canonical(requesting-code-review デフォルト経路)+ Codex 必須 / 重要 fix(決済・認証・削除)は runtime 検証 = stg smoke。
- 完了 gate: whole-repo lint(--max-warnings=0)+ test:iso green を全 sprint 無条件。依存/Next/lockfile 触る時は install --frozen-lockfile + typecheck + build 追加。
- OT 出力規律: chat は結論のみ・番号 bullet・判断必要 yes/no・詳細は doc path。
