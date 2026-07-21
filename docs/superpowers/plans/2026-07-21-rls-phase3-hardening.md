# RLS Phase 3 最終 hardening wave 実装 Plan

> **For agentic workers:** 実装は `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)。各 task の完了条件に review pass + gate + [reviewed] を含む。Codex plan cross-check 反映済(`docs/codex/2026-07-21-plan-RLS-P3-hardening.md`)。

**Goal:** RLS 対象 18 表 stg 実証済の現状に、getDb 封じ込め(withTenantTx 一本化 + 非 tenant handle carve-out + lint 恒久 enforce)/ RLS 非対象 5 表の grant 縮小 / policy drift-detection / P0RLS loud alert を実装し、Phase 3 の prod 有効化以外を完了させる。

**Architecture:** ① tenant 経路 = `withTenantTx(userId, fn)`(getDb を内部化)② 非 tenant 経路 = 明示 `getNonTenantDb()`(app-role・context 無し)③ getDb は lib/db/ 内部限定を lint enforce ④ RLS 非対象 5 表は grant を最小コマンドへ(唯一の防壁)⑤ policy 適用状態は versioned SQL のまま drift-detection test で pin。

**Tech Stack:** Next.js 16 App Router / Drizzle + postgres-js / PostgreSQL RLS / Vitest(test:iso 実 PG 2 テナント)/ ESLint flat config `no-restricted-imports`。

## Global Constraints(全 task 共通・冒頭一度)

- **新規設計をしない**。Step 0 fact-finding(`docs/audit/2026-07-21-rls-phase3-step0-tx-boundary-factfinding.md`)+ v47 論点の実施・整理のみ。仕様変更が要れば停止して OT 相談。
- **prod への一切の適用禁止**(grant SQL 含む)。stg 適用は OT 手動(SQL Editor)。
- getDb 分類(現 HEAD 実測)= A-wrapped 26 / A-manualtx 7 / **STRUCTURAL-nontenant 7** / raw-tenant gap **0**。7 構造的 site = webhooks/stripe:33・webhooks/clerk:69・handle-stripe-event:74・handle-clerk-event:84・auth/ensure-user:46・integration-failures:120・contact:61。
- **RLS 対象 = 18 表**(P2 5 + Wave1 8 + Wave2 5・users 含む)。**RLS 非対象 = 5 表**(global 3 = ai_usage/stripe_events/clerk_events + contact_messages + integration_failures)。gate/runbook/coverage/期待 catalog は全て「18」で統一。
- policy は drizzle migration にしない(spec §2.9・versioned SQL 維持)。列単位 GRANT / password rotation は本 wave 対象外。
- 各 feat/fix task: canonical review(general-purpose + template 改変なし)→ Codex(`scripts/ai/codex-review.sh`)→ 未解決 Crit0/Imp0 → [reviewed]。決済/認証/削除/grant に触る task は smoke まで tag 保留(session doc を正記録)。
- 各中間 task の review 観点に「**新規 raw getDb 混入ゼロ**」を含める(lint enforcement は Task 4 まで landing しないため・Codex#20)。
- **署名変更(Task 2/3)の挙動不変 gate**(OT 確定 2026-07-21): 決済(Stripe 系 unit)・認証/削除(lifecycle 系 iso)の既存 test が **無修正で green**。署名変更で test 修正が必要になったら挙動変更の兆候として**即停止・報告**(仕様不変ゆえ fixture 更新の正当事由なし)。
- 本 wave は brainstorming を skip(OT 承認・skill 方針 B)。根拠 = spec が Step 0 fact-finding + v47 で凍結・新規設計なし。実装方式 = subagent-driven-development。
- gate: 完了時 whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit` 全 exit 0。baseline fail と本 wave regression を実行記録で区別。

---

## Task 1: 非 tenant handle `getNonTenantDb()` 新設 + 7 構造的 site 配線

**目的:** app-role(DATABASE_URL_APP)で接続するが tenant context を張らない経路を `lib/db/index.ts` に明示化し、7 構造的 site を raw getDb → getNonTenantDb へ振替。

**制約:** 命名 = `getNonTenantDb`(OT 承認で確定・§論点2)。getDb の memoized client を共有(新規 pool 不可・context は tx-local set_config で pool 漏洩なし = 前提)。各 site に「なぜ非 tenant か」1 行コメント(pre-tenant resolve / event dedup / audit / 匿名 の分類)。integration-failures:120 は `process.env.DATABASE_URL_APP ? getNonTenantDb() : getAdminDb()`(owner 分岐は operator script 限定・prod runtime は DATABASE_URL_APP 必須ゆえ owner に落ちない = fail-open でないことを確認・Codex#6)。**残余リスク記録**: getNonTenantDb は通常 `DB` 型を返すため tenant 表アクセスを型で防げない — 防壁は lint(Task4)+ コメント + review のみ(Codex#1/#5)。

**完了条件:** 7 site が getNonTenantDb 経由・挙動不変(webhook dedup / resolve / audit / contact)。unit/typecheck green。review pass + Codex Crit0/Imp0。**認証/決済/削除に触るため [reviewed] は stg smoke 後**(session doc 正記録)。

## Task 2: `withTenantTx(userId, fn)` 署名変更 + A-wrapped 26 site 変換

**目的:** caller が getDb を import せず tenant tx を張れるよう `withTenantTx` を `(userId, fn)` へ(getDb を tenant-tx.ts 内部取得)。`withTenantTx(getDb(), userId, fn)` 形の A-wrapped 26 site + test helper(`tests/integration/pg/setup/as-tenant.ts` 等の直接 caller)を機械変換。

**制約:** setTenantContext / TenantTx は不変。変換は「`getDb(),` 引数除去 + 未使用 `const db = getDb()` 除去 + getDb import 除去」の機械反復。決済(upgrade/actions・handle-stripe-event)/ 認証(handle-clerk-event)/ 削除(delete-exam)file を含む — logic 変更禁止・挙動保存が絶対。tx 境界(開始/commit/rollback 単位・context 前 query なし)不変(Codex#1.4)。

**完了条件:** A-wrapped 26 + test caller が新署名。context 非漏洩・A/B tx 残渣なしは既存 `rls-context.test.ts` が回帰しないこと。tenant tx 挙動不変(pull/review-ingest/entity-mutations/決済/認証 既存 test green)。typecheck/unit/**test:iso** green。review pass + Codex Crit0/Imp0。決済/認証/削除含むため [reviewed] は stg smoke 後。

## Task 3: A-manualtx 7 site 変換(helper を TenantTx 受領へ)+ TenantDb 絞り込み判断

**目的:** `const db = getDb(); db.transaction(tx => { setTenantContext(tx,uid); … })` 形の 7 site(delete-exam:43 / process:212 / upload-persistence:116 / entity-mutations/bulk:232 / ai-usage-counter:26 / source-doc-status:84 / review-events/bulk:84)を getDb 非依存へ。単一 tx → `withTenantTx(uid, fn)`、multi-tx(entity-mutations の per-mutation loop・review-events の upsert+processSession)→ per-iteration `withTenantTx`。

**制約:** `db: DB` 受領 helper(processMutation/processSession/runUploadGuardTx 等)は DDD 規約(apply 層 = TenantTx のみ・tenant-tx.ts:6)に従い `tx: TenantTx` 受領へ。**保存確認**(Codex#1.4/#2): per-mutation の独立 commit/rollback 境界・nested tx/savepoint 有無・tx handle が tx 終了後に保持されない・loop fail-fast/partial-commit 意味・context 前 query なし。**withTenantTx/getNonTenantDb に素直に収まらない site が出たら握りつぶさず停止・OT 報告**(escape hatch 要否検出)。

**完了条件:** 7 site が getDb 非依存。review-ingest 冪等・entity-mutations per-op 境界・OCR guard 挙動不変(該当 test:iso/unit green)。**TenantDb の `DB` arm が全 helper で未使用になれば `TenantTx` へ絞る**(spec §4.1 申し送り消化・Codex#1.5)。使用が残る/ripple 大なら理由記録し据え置き。typecheck/unit/test:iso green。review pass + Codex Crit0/Imp0。

## Task 4: getDb export 制限 + no-restricted-imports lint(恒久 enforce)

**目的:** getDb の外部 import を遮断し、tenant = withTenantTx / 非 tenant = getNonTenantDb の二択を lint 恒久化。

**制約:** getDb export 自体は残す(lib/db 内部が相対 import で使用)— **遮断は lint**(Codex#2.2)。既存 domain-purity block の型を踏襲し、**迂回路を網羅**(Codex#2.1): `@/lib/db` alias の `importNames:['getDb']` + `@/lib/db/*` patterns + 相対 import(`./index`/`../db` 等)+ dynamic import。**test 除外は最小限**(`**/*.test.ts` + integration setup fixture のみ)、production→test helper 逆流がないこと(Codex#2.3/#4)。`files:` glob の route-group `(...)` / dynamic `[...]` は `\\(...\\)` `\\[...\\]` escape。lint が落ちる production site が残れば無理に通さず報告。

**完了条件:** whole-repo `pnpm lint` --max-warnings=0 exit 0。getDb 外部 import 0。**負例 fixture で lint rule が違反を実検出することを確認**(Codex#2.4/#3・rule 自体の red)。getNonTenantDb import は違反しない。review pass + Codex Crit0/Imp0 → **[reviewed]**(logic 不変)。

## Task 5: grant 縮小 SQL + global-setup 配線 + test:iso 全 revoke matrix pin + runbook

**目的:** RLS 非対象 5 表の app-role grant を最小コマンドへ(唯一の防壁)。blanket `ON ALL TABLES` 後段に REVOKE を versioned SQL で追加。

**制約:** 縮小 = contact_messages:INSERT+DELETE / integration_failures:INSERT / stripe_events:INSERT+SELECT / clerk_events:INSERT+SELECT / ai_usage:SELECT+INSERT+UPDATE(SELECT は RETURNING・ON CONFLICT 式に必要・Codex#3.3)。新 file `db/roles/recallmint_app-grants-phase3.sql`(**再実行冪等・base grants→revoke 順固定**・Codex#3.7)、global-setup.ts が base grants 直後に適用。**残余リスク記録**: command GRANT は行隔離を与えない(contact 全削除・ai_usage 全更新の blast radius 残存)/ ALTER DEFAULT PRIVILEGES 維持ゆえ将来の新非 RLS 表は再び blanket CRUD(Codex#3.1/#3.5)。

**完了条件:** test:iso で **5 表 × 全 revoke コマンドの 42501 matrix**(brief「各表1」を強化・`role-privilege.test.ts` の `assertRejectsWithPermissionDenied` 流用・.cause walk)+ **実 query 形の positive control**(stripe/clerk INSERT+RETURNING・ai_usage ON CONFLICT DO UPDATE・contact DELETE WHERE — sequence 権限含め実効確認・Codex#3.3/#3.6/#3.9)。fixture は非衝突 + cleanup。COVERAGE.md 追記。runbook に **has_table_privilege / role_table_grants readback SQL**(SQL Editor 成功≠実効権限・Codex#3.8)。test:iso green。review pass + Codex Crit0/Imp0。**grant は監査/決済境界ゆえ [reviewed] は stg 適用確認後**。

## Task 6: policy drift-detection test(選択肢 B)+ COVERAGE.md

**目的:** versioned SQL(db/policies)と実 DB の RLS 状態乖離を検出。**選択肢 B 採用**(A=migration 昇格は §2.9 の operator 手動適用 model を反転し enablement を deploy に結合するため不採用・§論点1)。

**制約:** test:iso に drift 検出追加 — **policy 全定義を突合**(Codex#4.1/#4.2・name+cmd だけでは誤 predicate が green): `pg_class.relrowsecurity`(18 true / 非対象 5 false)+ `relforcerowsecurity` 期待 + `pg_policies` の (schema, tablename, policyname, roles, cmd, permissive, qual, with_check) を期待カタログと完全一致 + users の per-command 構成 + DELETE policy 不在 + **18 表以外に意図しない policy が無いこと**。期待カタログ = hardcoded 独立 oracle(db/policies と二重管理 = fixture-completeness と同思想・review 規約で対応・Codex#4.3)。

**完了条件:** 期待カタログと実 DB(global-setup 適用済)一致 green。**代表 mutation 3 種で red 検証**(policy drop / qual 改変 / role 変更 — 保証増ゆえ commit「red 検証」・Codex#12)。**test:iso は repo SQL↔test DB の整合のみ検出**(手動適用 stg/prod drift は非検出)ため、runbook に **operator 用 read-only drift 監査 SQL**(同 assertion を実 DB へ・Codex#4.4)を追記。app_current_user_id() の drift は既存 `rls-functions.test.ts` が behavioral 担保(Codex#4.5)。COVERAGE.md に drift-detection 節。review pass + Codex Crit0/Imp0 → **[reviewed]**。

## Task 7: P0RLS loud alert(小・write-path scope)

**目的:** P0RLS(context 未設定で app_current_user_id が RAISE)発生時に notifyOps 経路へ記録が残る口を追加。現状 Vercel Logs 頼み → 「発生 = 記録が残る」へ。

**制約:** 既存 `recordIntegrationFailure`(integration_failures INSERT + notifyOps Discord)を使用 — 新規監視 SaaS 禁止。新 catalog key 1 つ + `reportRlsContextFailure(err, {route, op})` helper。**設計要件**(Codex#5): SQLSTATE `P0RLS` を **.cause chain walk で識別**(既存 `hasSqlState` 流用)/ route・op は**列挙定数 allowlist**(自由文字列禁止 = PII 非搭載担保)/ **await して記録**(fire-and-forget は serverless で消失・元 5xx は既に失敗ゆえ latency 許容)+ 内側 try/catch で notify 失敗を握り原例外を再 throw(既存 HTTP status/例外伝播/log を変えない)。配線先 = 既存 serializeDbError catch site(entity-mutations/bulk・delete-exam)。**scope 明示**: 本 task は write-path のみ — **P0RLS 到達し得る未配線経路(pull read 等)を列挙し report**(一般保証にしない・brief「握りつぶさず報告」・Codex#5.1/#13/#14)。read path 全面配線は follow-up。alert storm(regression 時多発)は「= 実障害の loud signal」として受容(rate-limit は過剰実装・記録のみ)。

**完了条件:** P0RLS catch → recordIntegrationFailure 発火を unit test で pin(mock・PII 非混入 assert・保証増ゆえ「red 検証」)。serializeDbError の観測専用契約を壊さない。未配線経路 list を session doc に記録。typecheck/unit green。review pass + Codex Crit0/Imp0 → [reviewed]。

---

## 明示的にやらないこと

- prod への一切の適用(grant SQL 含む)= 有効化セッションで一括。
- 列単位 GRANT / password rotation / 型レベル capability 制限(getNonTenantDb) / grant 行隔離 / ALTER DEFAULT PRIVILEGES model 変更 / P0RLS alert storm rate-limit / P0RLS read path 全面配線 = 本 wave 対象外(残余リスクは各 task に記録)。

## stg 実証(OT が push 後・CC が DevTools/psql or OT 実機)

- grant SQL 適用(SQL Editor)→ **適用確認 = has_table_privilege readback で 5 表 × 全コマンドの実効権限**(意図的 42501 単発でなく matrix・Codex#19)+ policy drift 監査 SQL(Task6)。
- smoke: contact 送信(匿名 + 会員)/ webhook 受信(Stripe or Clerk 実イベント 1 発)/ OCR 1 枚 — 非 tenant handle 経路が従来どおり。P0RLS / 意図しない 42501 / 5xx = 0。
- 42501 の意図的発火(revoke 済コマンドを app-role で)で grant 実効確認。P0RLS alert 経路の故障注入は安全な方法があれば実施(無ければ unit の mock 実証 + follow-up・Codex#6.2 / CC 環境制約なら OT/据え置き)。

## prod 有効化成果物の準備(適用はしないが整備・Codex#6.4)

runbook に grant + policy の **prod 適用順 / readback / rollback / 失敗時停止条件**を明記(grant 縮小は非 RLS 5 表限定で policy 有効化と独立ゆえ順序非依存 = その旨も記載)。

## 確定事項(OT 承認 2026-07-21)

1. **Task 6 = 選択肢 B(drift-detection)確定**。A(migration 昇格)は §2.9 の「enablement を deploy から分離(operator 手動適用・staged/rollback 可能)」の設計反転ゆえ不採用。
2. **Task 1 命名 = `getNonTenantDb` 確定**。`global` は 7 site の実態(pre-tenant resolve / audit / 匿名含む)に対し不正確。能力を正確に示す `NonTenant` を採用。
3. **Task 2+3 = 1 wave 続行**確定。commit/gate/smoke は Task 単位分離で監査可能性を確保。
4. **brainstorming skip 承認**確定。spec は Step 0 fact-finding + v47 で凍結・新規設計なし宣言を根拠に skip(writing-plans は実行済)。
