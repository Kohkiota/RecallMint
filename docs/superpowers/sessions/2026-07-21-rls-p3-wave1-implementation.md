# RLS-P3 Wave 1 実装記録(配線ゼロ 8 表の RLS 有効化)

- **日付**: 2026-07-21
- **範囲**: `cc9d7f4`(Step0 追補2 docs)→ `02c220b`(feat [reviewed])→ `50f7674`(docs [no-review])。develop・**未 push**。
- **性質**: Phase 3 Wave 1 = P2 の型を厳密反復。新規設計なし。policy SQL 追加 + test:iso 追加 + tag 3 表 RLS 化に伴う既存 test 2 本の adaptation。
- **正本**: `docs/audit/2026-07-21-rls-phase3-step0-tx-boundary-factfinding.md`(§5.3 Wave 定義 / 追補 / 追補2)。

## 1. 成果

8 表(全て write/read path が既に `setTenantContext` 済 = 配線ゼロ)を P2 同型の共通形 policy で RLS 有効化:
`reviews` / `answer_events` / `tag_categories` / `tag_options` / `card_tags` / `entity_mutations` / `card_asset_refs` / `ai_usage_users`。

- **policy**: `db/policies/rls-p3-wave1-enable.sql`(8 表・`FOR ALL TO recallmint_app`・`USING = WITH CHECK = user_id = (SELECT public.app_current_user_id())`・冪等 `DROP POLICY IF EXISTS`・`SET lock_timeout='5s'`)+ `rls-p3-wave1-disable.sql`(対称・DISABLE only)。P2 `rls-p2-enable.sql` と byte-faithful。
- **test:iso 配線**: `global-setup.ts` が p2-enable 直後に wave1-enable を owner client で適用(毎 run RLS on)。
- **tx 配線追加なし**(8 表とも context 済)。

## 2. test:iso(本丸)

- **新規 `rls-wave1.test.ts`**(28 ケース): read 単独防御 ×8 / write 単独防御 ×8(app 層 eq を外し policy 単独で隔離・owner で B 不変検証 + A positive control)/ loud P0RLS(context 未設定 read+write)×8 / answer_events `event_id` ON CONFLICT が RLS 越しで不変 ×2 / `card_asset_refs`+`entity_mutations` dual-table write ×2。
- **red 検証**: global-setup の wave1-enable を skip → `rls-wave1` が **25 fail**(RLS 依存の隔離・loud・cross-tenant WITH CHECK が全滅、ON CONFLICT 不変系 3 のみ pass)。pin が効く実証。復元は `git checkout`(その際 Wave1 wiring も巻き戻ったため再 add・green 再確認済)。
- **COVERAGE.md**: 表 3(Wave1 8 表 matrix)+ review-ingest 特有 + adaptation + OUT(非対象 5 + Wave2 5)を追記。

## 3. 既存 test adaptation(tag 3 表 RLS 化の必須帰結・assertion 不変)

OT 承認済み(論点1):
- **`write-isolation.test.ts`**(applyTagOptionUpdate block): `applyTagOptionUpdate(getDb(), …)` が raw getDb(context 無し)で tag_options を叩いていたため RLS on で P0RLS。→ **asTenant(A) 呼出 + owner 検証**へ書換。隔離 assertion('failed' + B 不変)は保存 = RLS(USING)+ app 層 eq(userId)の二重防御(OT 制約遵守)。`getDb` import 除去。
- **`rls-partial-chain.test.ts`**: 2 block(pull 6-stream / tag mutation)が全表 RLS 化で mixed でなくなる → **改称 + comment 更新**(mixed→full-RLS)。全 `expect` 不変。

## 4. checkpoint 判断(OT 承認経緯)

1. **論点1**(tag 3 表 RLS 化が既存 2 test に波及)→ OT 承認(8 表続行・隔離 assertion 保存・canonical 明示チェック)。
2. **論点2**(rls-partial-chain の partial 前提消失)→ OT 承認(full-RLS regression へ改称)。
3. **binary**(改称後に「partial-RLS 混在 tx が安全」の intentional 証明が他 test に残るか)= **NO**(cascade/ghost/delete-isolation は別物・lifecycle-behavioral は child data 無しで incidental)→ **follow-up 台帳記録**(§追補2)。**Wave 2 で新設**(off 表 study_sessions 等 × RLS 表の mixed tx が実在・clean に作れる。C12 lifecycle は Wave1 後すでに mixed だが OT 指示で Wave2 集約)。

## 5. gate(全 exit 0)

- **whole-repo lint exit 0 確認済** / typecheck 0 / build 0 / unit **3781** green / **test:iso green 確認済(171・P2 143 → +28)**。

## 6. review(canonical → Codex・Crit/Imp 0 で収束・1 周)

- **canonical**(`superpowers:requesting-code-review` デフォルト経路・general-purpose + template 改変なし): **Critical 0 / Important 0 / Minor 4**(Ready to merge: Yes)。Minor1(loud-write の seqscan 依存)+ Minor3(cross-tenant ON CONFLICT 文言精度)= comment 明確化済 / Minor4(stg runbook Wave1 節)= 追記済 / Minor2(app 層単独 pin が RLS で二重化)= 情報記録。
- **Codex**(`scripts/ai/codex-review.sh rls-p3-wave1`・独立・canonical 結論非提示): **Critical 0 / Important 0 / Minor 0**。git clean detector PASS。保存 = `docs/codex/2026-07-21-rls-p3-wave1.md`。
  - **incident**: 初回 Codex は `401 Unauthorized`(codex login 未実行・C2 devcontainer rebuild 申し送り)で走破せず → OT が `codex login` 再実行後に再走・pass。

## 7. stg 実証 handoff(push 後・OT 指示で CC 実走)

Wave 1 は **stg 限定**(prod は Phase 3 全表完了後・部分 RLS を prod に出さない)。runbook §10 に手順追記済:
- OT: push → stg deploy → `db/policies/rls-p3-wave1-enable.sql` を SQL Editor(owner)適用(0025 functions は P2 で適用済ゆえ policy のみ)。
- CC smoke(push 後・DevTools/Playwright MCP): pull 全 6 stream / review-events/bulk / entity-mutations/bulk が RLS on で従来どおり通ること・`P0RLS`/`42501`/5xx 0 件・`current_user='recallmint_app'`。
- rollback 演習: `rls-p3-wave1-disable.sql` 1 枚で復元・re-enable 冪等(§3.2 同型)。
- **after 計測(perf)は Wave1 単体では取らない**(Wave1〜2 出揃い後・prod 有効化直前に同日 before とセット)。

## 8. 次

- **Wave 2**: `study_sessions` / `user_settings` / `assets` / `source_documents` / `upload_records`(各 standalone raw write/read の context 配線後に RLS 化)+ **partial-RLS behavioral 証明の新設**(§追補2 follow-up)。
- **非対象 5 表**: global 3 + `contact_messages` + `integration_failures`(RLS 張らず・最終 hardening wave で grant 縮小 + getDb 封じ込め)。
