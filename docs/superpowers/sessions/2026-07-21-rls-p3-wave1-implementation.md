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
- rollback 演習: `rls-p3-wave1-disable.sql`(**RLS 無効化のみ**・`DROP POLICY` 無 = policy カタログ残置だが不活性 → **挙動は RLS 前と同一**)。disable 後の確認 SQL 期待値 = **policy 8 行 / relrowsecurity 0 行** → re-enable 冪等(§3.2 同型)。
- **after 計測(perf)は Wave1 単体では取らない**(Wave1〜2 出揃い後・prod 有効化直前に同日 before とセット)。

## 7.5 stg 実証結果(2026-07-21・RLS-on 確認)

**policy 適用の経緯**(記録): 当初 OT が push 前提で smoke 指示 → CC が「Wave1 は policy-only(app コード変更ゼロ)= push は stg 挙動不変・browser は RLS-active/inactive を区別不能」と指摘 → OT が policy 未適用を確認 → `rls-p3-wave1-enable.sql` を stg 適用(確認 SQL 2 本が各 8 行 = 8 policy + 8 表 relrowsecurity=t)→ RLS-on で再走。

- **RLS-off 先行 smoke ×2**(policy 未適用中): **「app 非破壊確認」のみ**として区別記録。全 `/api` 200・error 0 だが、app 層 `eq(userId)` が同結果を返すため **RLS enforcement の証明ではない**。
- **RLS-on smoke**(policy 適用後・CC・Playwright MCP・全 7 req 200):
  - **item1 pull 6 stream = PASS**: `/api/pull`→200・error:null・6 stream owner data(cards300/exams1/tombstones1066/**tag_categories7/tag_options28/card_tags1621**)。`/api/study-days/pull`→200。app 自身の auto-pull も 200。
  - **item2 review-events/bulk = PASS**: 200 `{ok,failed:[]}`・reps 前進(非 vacuous)= answer_events/reviews/cards/study_days が RLS Phase1+2 tx で書けた。
  - **item3 entity-mutations/bulk = PASS**: 200 `{applied:1,failed:[]}`・memo 適用 = cards + entity_mutations が per-mutation tx で書けた。**card_asset_refs は test:iso dual-table(直接 pin)+ 同一 C9 tx/context 共有で担保**・live image-attach ref 書込は R2 saga 不可ゆえ保留(既存 image follow-up と整合)。
  - **item5 client = PASS**: 全 `/api` 200・5xx 0・console error 0(Clerk sign-in の CSP SVG noise のみ・RLS 無関係)。
  - **配線漏れ反証**: RLS-on で P0RLS/42501/5xx が 1 件も出ない = 8 表の全 read/write 経路が context 済(漏れがあれば当該経路で P0RLS/500 になる)。
- **item4 current_user = PASS**(CC・psql + `.env.local` の `DATABASE_URL_APP`): `current_user = recallmint_app`(session_user 同・db=postgres・host=`aws-1-ap-northeast-1.pooler.supabase.com:6543` = stg pooler)。app 接続が least-privilege role = **RLS 素通しでない**(false-green 排除)。
- **item5 server-log = PASS**(OT・2026-07-21): Vercel + Supabase 両ログとも **P0RLS / 42501 / 5xx = 0 件**。
- **item6 rollback 演習 = PASS**(OT・2026-07-21): `rls-p3-wave1-disable.sql` 適用後の中間状態 = **pg_policies 8 行 / relrowsecurity 0 行**。disable.sql は `DROP POLICY` を含まない設計(P2 完全対称・**RLS 無効化のみ**)ゆえこれが正しい期待値 — **policy はカタログに残置するが RLS 無効時は不活性**で、挙動は RLS 前と同一。re-enable は既存 policy 上でエラーなく通過(**冪等実証**)→ 最終 8 行 / 8 行・enable 状態で終了。

**判定** = policy 適用(OT)∧ current_user=recallmint_app(item4)∧ RLS-on app 非破壊(item1/2/3/5-client)∧ server-log 0 件(item5・OT)∧ rollback 冪等(item6・OT)∧ test:iso RLS 単独隔離(green)→ **Wave 1 stg 実証 完全 close(全 item PASS・2026-07-21)**。

**smoke 副作用**(test1・PERF-SEED 300 中・計 5 枚を実書込): review = `5248b623`(reps 0→2)/`774380ca` / memo = `0e6f605a` / `bc348629` / `ceb44ce5`。負荷計測は Wave1〜2 出揃い後ゆえ 5/300 は無視可(要 pristine なら reseed 手順あり)。

## 8. 次

- **Wave 2**: `study_sessions` / `user_settings` / `assets` / `source_documents` / `upload_records`(各 standalone raw write/read の context 配線後に RLS 化)+ **partial-RLS behavioral 証明の新設**(§追補2 follow-up)。
- **非対象 5 表**: global 3 + `contact_messages` + `integration_failures`(RLS 張らず・最終 hardening wave で grant 縮小 + getDb 封じ込め)。
