# RLS Phase 3 Wave 2 — 実装記録

- **日付**: 2026-07-21
- **plan**: `docs/superpowers/plans/2026-07-21-rls-phase3-wave2.md`(OT 承認・論点1-5 + finalize TOCTOU pin 追加)
- **commit range**: `3bf658a..7131872`(develop・**未 push**)
  - `3bf658a` docs(plan): plan 確定 + Codex plan cross-check [no-review]
  - `2cf7b04` feat(rls): 5 表配線 + unit test 適応 [reviewed]
  - `7131872` feat(rls): policy + iso 証明 + COVERAGE [reviewed]
- **実装方式**: subagent-driven-development 起動。ただし本 harness の Agent は async(background)で write auto-deny + 通知取りこぼしの既知リスクに該当するため、**実装(writer)は controller 直実装(foreground)**、**canonical review(read-only)のみ subagent** で回した。

## 対象 5 表と配線

study_sessions / user_settings / assets / source_documents / upload_records。各表の残存 raw getDb を既存 `withTenantTx` で context 下に入れ、Wave1 同型 policy を張った。

- **study_sessions**: review-events/bulk Phase 0 `upsertSessionGuarded` を単純 wrap(processSession 合流せず=部分成功の意味論保存)。
- **user_settings**: save-session-limit/custom/fsrs(write 3)+ settings/page・study/custom・study/smart(read 3)。PK=user_id 単独。
- **assets**: reserve insert / **finalize は read tx → headObject(R2 外部 I/O)→ write tx の 2 分割**(kickoff「1 tx bundle」からの逸脱・OT 論点2 承認済。tx が I/O を跨がない・TOCTOU 防御=`status='reserved'` WHERE)/ resolve select。
- **source_documents**: getExamStatusMap:44 / hasActiveProcessingUpload:167 / exams/status route:49(reconcileStale:86 は既 context 済)。
- **upload_records**: upload/page:97 `getCurrentMonthOcrPages` caller 差替(canRunOcr は既 guard tx)。

## flip 前 raw-site 完全性 re-grep(Task 6)

5 表 production 全 site を機械 grep → 未 wrap raw getDb は 0。既 context 済(変更なし)= card-field-handlers:181 / exams/list:154 / handle-clerk-event(C12)/ upload-persistence / upload-guard / reconcileStaleProcessing。詳細 = COVERAGE.md「既 context 済サイト」。

## gate(全 exit 0)

- lint 0 / typecheck 0 / build 0 / **test(default)3799 green** / **test:iso 21 files 197 green** / audit 0(3 low + 3 moderate・high 未満)。

## red 検証(test 増)

- **rls-wave2 単独防御**: global-setup の wave2-enable を無効化 → **21/23 fail**(read/write 隔離・WITH CHECK・P0RLS 崩壊)→ 復元後 green。
- **rls-partial-mixed on 隔離/原子性**: owner `ALTER TABLE ai_usage_users DISABLE ROW LEVEL SECURITY` → **2/3 fail**(on 隔離 + atomicity)→ 復元後 green。
- **finalize TOCTOU guard**: write tx の UPDATE WHERE から `eq(assets.status,'reserved')` 除去 → `asset-actions.test.ts:503`(WHERE contains reserved)fail → 復元後 43 green。

## review(commit 前・Crit0/Imp0 で収束)

- **canonical**(`superpowers:requesting-code-review`・general-purpose read-only・opus・template 改変なし): **Critical 0 / Important 0 / Minor 3**(全 docs/観測性)。Minor#1(COVERAGE に既 context 済サイト明記)反映済。#2(best-effort が context 失敗を握る=既存不変・scope 外)/ #3(finalize re-SELECT の tx 同居=意図的記録)は記録のみ。判定 = Ready to merge。
- **Codex 独立**(`scripts/ai/codex-review.sh`): **Critical 0 / Important 0 / Minor 0**(detector PASS)。保存 = `docs/codex/2026-07-21-rls-p3-wave2.md`。

## 残(OT)= push → stg 実証

**重要 Fix(データ保全=テナント隔離)ゆえ本 session doc を [reviewed] の正記録とする**(push→smoke の順で amend 窓が閉じるため)。stg 手順(plan §stg 実証):

1. **適用順序厳守**: 配線済コードを push → stg deploy 完了確認 → **その後** `rls-p3-wave2-enable.sql` を stg SQL Editor で適用(push だけでは効かない・順序逆転は旧コード×RLS-on で P0RLS)。新 function なし。
2. **RLS-on smoke**(stg URL): study 開始 / session limit・FSRS mode 保存 / OCR upload(source_documents/upload_records/assets 経路)が RLS-on で従来どおり。P0RLS/42501/5xx=0・`current_user=recallmint_app`。
3. **rollback 演習**: `disable.sql` → 確認 SQL(policy 5 行 / relrowsecurity 0 行)→ re-enable(冪等)→ `pg_policies` で 5 表 qual/with_check/roles/cmd 一致 spot-check。
4. **after 計測** = drift 分離のため prod flip 直前(同日 before とセット)。Wave2 stg では取らない。
5. prod flip は Phase 3 全表完了後(本 Wave では prod policy 不出し)。

## stg 実証結果(2026-07-21・CC 実走・Playwright MCP・stg URL / policy=OT 適用済 pg_policies 5/relrowsecurity 5)

RLS-on 下で配線経路を中心に実走。**P0RLS / 42501 / 5xx = 0**(console error は sign-in の装飾 SVG の CSP img-src block 1 件のみ=Wave2 無関係・既存 cosmetic)。

| # | 項目 | 結果 | 証拠 / 副作用 |
|---|---|---|---|
| 1 | review-events/bulk(study_sessions Phase 0 withTenantTx 初実機) | **PASS** | smart 10 問完答→**POST /api/review-events/bulk ×2 = 200**(P0RLS なら 503)。study_sessions/answer_events(10)/reviews(10)/study_days/cards FSRS 更新 |
| 2 | user_settings(save 3 + read 3) | **PASS** | settings/study-smart/study-custom 全 render(read OK)。saveSessionLimit/Custom/Fsrs = **POST /app/settings ×3 = 200** + refresh GET 200。副作用: sessionLimit 5→10 / custom 5→20 / fsrsMode on→off |
| 3 | OCR upload(source_documents/upload_records + 月次クォータ read) | **PASS** | quota「300/300」表示(getCurrentMonthOcrPages read)。Gemini「✅ 2 問抽出」→ **POST /app/upload 200**(runUploadGuardTx source_documents insert + completeUploadTx upload_records insert)+ **/api/exams/status 200×3**(配線した source_documents read)。副作用: exam 1 + source_document 1 + card 2 + upload_records 1 + Gemini ~1p |
| 4 | assets finalizeAsset(2 tx 分割・**テーブルビュー実添付**) | **PASS** | table view「問題文に画像を追加」→ reserveAsset 200 → **R2 PUT 200 OK**(`recallmint-dev/users/{uuid}/…webp`・owner namespace・**userId 非 undefined**)→ finalizeAsset(2tx)200 → **entity-mutations/bulk 200**(card_asset_refs)。**follow-up「テーブルビュー add の R2 実添付未検証(meta.userId undefined 懸念)」を close**(bug 非表面化) |
| 5 | pull 6-stream + entity-mutations/bulk 回帰 | **PASS** | /api/pull(6 cursor: cards/exams/tombstones/tag_categories/tag_options/card_tags)= 200 + /api/study-days/pull 200 + entity-mutations/bulk 200(Wave1 8 表 + P2 継続正常) |
| 6 | current_user / session_user='recallmint_app'(psql) | **PASS**(OT 実走) | OT が psql で `current_user` / `session_user` とも **recallmint_app** を確認(CC は stg/prod 判別不能で未実行→OT 実施)。app 接続が least-priv role = RLS 迂回しないことを裏取り |
| 7 | P0RLS / 42501 / 5xx = 0 | **PASS** | 全経路 200。console error = sign-in の CSP img cosmetic 1 件のみ(RLS 無関係) |

**OT 確認(2026-07-21)= Wave 2 完全 close**:
- **item 6**: psql で current_user / session_user とも **recallmint_app** 確認済(上表反映)。
- **logs**: Vercel / Supabase とも **P0RLS / 42501 / 5xx = 0**。
- **rollback 演習**: `disable` → policy 5 行 / relrowsecurity **0 行** → `re-enable`(冪等)→ 5 行 / 5 行 → **enable 状態で終了**。期待どおり(disable=RLS 無効化のみ・policy 残置)。
- **人力 smoke 1 周**: 違和感なし。
- **smoke 副作用**(test user へ実書込): exam1 / source_document1 / card2 / upload_records1 / asset1(R2 webp)/ card_asset_refs1 / study_session・answer_events(10)・reviews(10) / user_settings 変更(smart10/custom20/fsrs off)/ Gemini ~1p。

→ **RLS Phase 3 Wave 2 完全 close**(range `3bf658a..HEAD`・stg 実証まで完了)。

## セキュリティ follow-up(公開前必須・未実施)

- **stg `DATABASE_URL_APP` パスワード露出**: Wave 2 smoke 中、CC が `.env.local` の redaction 目的の sed を誤り、**stg app-role(recallmint_app・least-priv)のパスワードを CC のコマンド出力に一度露出**。範囲 = **stg のみ・prod 非露出**・外部送信なし(ローカル context 内)。**rotation は未実施** → **公開前(次の prod deploy 前)に rotation 実施**を follow-up として記録。※本 doc に「rotation 済」記載はしない(実施は公開前)。

## 次セッション引き継ぎ(RLS Phase 3 残)

- **最終 hardening wave**: 非対象 5 表(global 3 = ai_usage/stripe_events/clerk_events + contact_messages + integration_failures)の **role grant 縮小**(contact=INSERT+DELETE / integration=INSERT のみ 等・SELECT/UPDATE revoke)+ **raw getDb 封じ込め**(repository/apply 層を TenantTx のみ受領へ・DDD tx 境界整理)+ **非 tenant handle**(owner-only 台帳化 or DEFINER 経路)。
- **prod 有効化**: Phase 3 全表(Wave1+2 +最終 hardening)完了後、**同日 before/after 計測とセット**で prod policy flip(drift 分離)。
- **push 状況**: feat 2 commit(`2cf7b04`/`7131872`)は OT push 済(stg deploy + policy 適用済で smoke 実走)。以降の docs commit(session/close 追記)は OT の追随 push 対象。
