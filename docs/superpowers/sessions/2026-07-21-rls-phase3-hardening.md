# RLS Phase 3 最終 hardening wave — session log

- **日付**: 2026-07-21〜
- **plan**: `docs/superpowers/plans/2026-07-21-rls-phase3-hardening.md`
- **実装方式**: subagent-driven-development(review-before-commit 適応: implementer は commit しない → controller が canonical + Codex → [reviewed] commit)
- **BASE**: `c7efb55`(plan 確定 docs commit)

## Task 状況

| Task | 内容 | commit | 状態 |
|---|---|---|---|
| T1 | getNonTenantDb 新設 + 7 構造的非 tenant site 配線 | `608fcfe` | [reviewed] |
| T2 | withTenantTx(userId,fn) 署名変更で getDb 封じ込め | `0822d7b` | [reviewed] |
| T3 | A-manualtx 7 site を getDb-free 化(封じ込め達成) | `4488403` | [reviewed] |
| T4 | getDb export 制限 + no-restricted-imports lint(恒久 enforce) | `02661f8` | [reviewed] |
| T5 | 非 RLS 5 表 grant 縮小 + test:iso 42501 matrix + runbook | `e07fbfe` | [reviewed] |
| T6 | policy drift-detection(選択肢 B)+ COVERAGE.md | `653c694` | [reviewed] |
| T7 | P0RLS loud alert(write-path scope) | `c4244b6` | [reviewed] |

**Wave 完了(2026-07-22)**: 全 7 task [reviewed](各 canonical + Codex Crit0/Imp0)+ **最終 whole-branch review(opus)Ready to merge Crit0/Imp0**(cross-task coherence 確認: getDb 封じ込め provably complete=production の getDb は lib/db 内部のみ / T5↔T6↔T7 内部整合 / behavior-preserving。final Minor#1=review-events Phase 0 catch も P0RLS 配線→c4244b6 で対処 / Minor#2=wave 対象外の stale コメントゆえ触らず)。gate: **lint0 / typecheck0 / build0 / test 3829 / test:iso 217** 全 green。**audit のみ** 無関係な新規 high(`sharp<0.35.0` GHSA-f88m-g3jw-g9cj・libvips CVE-2026-33327 他・**patched >=0.35.0 あり**)で fail = 本 wave は依存不変ゆえ由来せず、dep bump(sharp override)/ ignoreGhsas は OT 判断(audit 台帳規律)。**残: push + stg 実証(grant SQL 適用 + readback + smoke)= OT**。range = `608fcfe..c4244b6`(+ plan `c7efb55`)・develop・**未 push**。

---

## T2 裁定記録(OT 2026-07-21)— withTenantTx 署名変更 tripwire

tripwire「決済/認証/削除の既存 test が無修正 green・要修正なら即停止報告」の趣旨は **assertion 集合の不変**であって test ファイル無修正の字義ではない。ensure-user.test の getDb mock 追加は署名変更で DB 注入点が caller→withTenantTx 内部へ移ったことへの**機械配管追従**(全 webhook test と同型・assertion 変更 0・RED 実証済で getDb 未 mock 起因を確認)であり、挙動変更の隠蔽に当たらない。approach b(withTenantTx(db,…) 旧入口を残す wrapper)は「tenant 入口 1 本」の hardening 目的と矛盾するため不採用。OT 明示保護 test(Stripe unit / lifecycle・delete iso)は署名変更でも無修正 green。

## T3 裁定記録 — Codex P1 を false-positive と確定(override 監査記録)

Codex 主張「entity-mutations で getDb 失敗が envelope 503→per-mutation 200 に退行 / test が mask」。**反証 3 根拠**:
1. getDb は auth(getCurrentUser→ensure-user:49 getNonTenantDb)で memoize、init 失敗は 500 で surface = envelope の getDb path は旧新とも到達不能。
2. connection-drop-during-mutation は旧新とも per-mutation catch→200-failed で Task3 不変。
3. `failed[]` は client が pending 残置→次 flush で再送(`lib/sync/entity-mutations.ts:338-343` L343 コメント)= silent lost write なし。

canonical(独立 opus)も同結論(Minor 格)。過剰防御コード(unreachable path の envelope DB validation)は簡潔性規律により追加せず。route.ts:220 コメントの over-claim(getDb/connection 断が envelope 到達)は主張精度のため訂正済。

---

## T4 getDb-ban 完成確定 — 全列挙・全カバー・RED pin(OT 2026-07-21 指示)

Codex の逐次発覚方式(r1〜r4)でなく、**DB handle を import しうる場所を先に全列挙**し 1 周で閉じた。

### (1) executable scope 全列挙(.ts/.tsx を含む全 dir)+ getDb-ban block 対応

| scope | `files:` glob | block | getDb ban | 例外(ignores) |
|---|---|---|---|---|
| lib/** | `lib/**/*` | Block A-getdb | ✓ | `lib/db/**`, `*.test.ts(x)` |
| lib/{stripe,reviews,cards,tags,media}/domain/** | 各 domain glob | domain blocks(GETDB_BAN 合成) | ✓ | `*.test.ts` |
| components/** | `components/**/*` | Block A-getdb | ✓ | `*.test.ts(x)` |
| app/** | `app/**/*`(+`app/**/_lib/**`) | app getdb blocks | ✓ | `*.test.ts` |
| tests/** | `tests/**/*.ts(x)` | tests block | ✓ | `*.test.ts(x)`, `fixture.ts` |
| **scripts/**** | `scripts/**/*.ts` | **Block getDb-scripts(本 wave 追加)** | ✓ | `scripts/**/*.test.ts` |
| root `*.ts` | `*.ts`(非再帰) | Block getDb-root | ✓ | `*.test.ts`, `*.d.ts` |
| types/** | (`.d.ts` のみ) | — | n/a(declaration・runtime import 不可) | — |

→ **executable scope は 8 種全て cover**(scripts 追加で完了)。非 cover は types(=.d.ts で import 不可)のみ。DB handle import 実在集合: production 非 test の getDb import は **ゼロ**(内部 `lib/db/tenant-tx.ts` のみ)、scripts は getAdminDb(4 file・allowed)。

### (2) notation 全カバー(lib/db/index.ts に解決しうる import 文字列)× GETDB_BAN

`GETDB_BAN` = paths(`@/lib/db` importNames:['getDb'])+ regex(`^(?:@/lib/db|(?:\.\./)+lib/db|(?:\.\./)+db|\./db)(?:/index)?/?$`, importNames:['getDb'])。

| notation | 例 | カバー |
|---|---|---|
| alias | `@/lib/db` | paths ✓ |
| alias 末尾スラッシュ | `@/lib/db/` | regex ✓ |
| alias subpath | `@/lib/db/index`, `@/lib/db/index/` | regex ✓ |
| 相対 db | `../db`, `../../db`, `../db/`, `../db/index` | regex ✓ |
| 相対 lib/db | `../lib/db`, `../../lib/db` | regex ✓ |
| 同一 dir(lib root) | `./db`, `./db/` | regex ✓ |

**非 ban(negatives)**: `getNonTenantDb` / `getAdminDb` / `import type { DB }` / `closeDb` = importNames:['getDb'] のみ対象ゆえ通過。**exempt**: `*.test.ts(x)`(全 scope)/ `*.d.ts` / `lib/db/**` 内部 / tests `fixture.ts`。

### (3) 塞ぎ残しゼロ RED pin — throwaway file × 実 eslint(30/30 PASS)

`scratchpad/getdb-red-sweep.sh`: 各 (scope × notation) の throwaway file を作り実 `npx eslint` にかけ、getDb は FLAG / 非 getDb・exempt は CLEAN を実証 → 全削除(probe 残存ゼロ確認)。

- **21 FLAG**(10 scope × alias getDb + 11 notation)全て弾かれる = 各 scope・各書き方が実弾で reject。
- **9 CLEAN**(5 negatives: getNonTenantDb×3/type DB/getAdminDb-in-scripts + 4 exempt: test×3/lib/db 内部)= over-ban なし。
- 合計 **PASS=30 / FAIL=0**。

永続 regression: `tests/lint/import-boundary.test.ts` 39 tests(scope・notation・negative・exempt を lintText で pin、RED 検証済)。whole-repo `pnpm lint` --max-warnings=0 exit 0 / typecheck 0。

→ **executable scope 全列挙・全 notation カバー・各書き方 RED pin 済**を確定。以降 Codex は本照合を 1 回確認のみ(周回しない)。

---

## T5 裁定記録 — contact_messages の table-level SELECT 保持(OT 承認 2026-07-22)

非 RLS 5 表の grant 縮小のうち contact_messages のみ brief spec(`INSERT+DELETE`・SELECT revoke)から逸脱し **`INSERT+DELETE+SELECT` / `UPDATE` のみ revoke** とした。理由: GDPR 削除経路 `handle-clerk-event.ts:219` の `DELETE FROM contact_messages WHERE user_id = …` は、PostgreSQL が **DELETE の WHERE で参照する列に SELECT 権限**を要求するため、SELECT を revoke すると削除自体が 42501 で破綻する(PG17 実証: SELECT-revoked→42501 / granted→成功 / bare DELETE(WHERE 無し)→成功)。列単位 `SELECT(user_id)` は plan で out-of-scope ゆえ、table-level SELECT が唯一の correctness 解。攻撃面は UPDATE revoke で縮小維持。他 4 表(integration_failures INSERT のみ / stripe_events・clerk_events INSERT+SELECT / ai_usage SELECT+INSERT+UPDATE)は brief どおり。

残余リスク(app-role が contact_messages(email/PII)を全行 SELECT 可)は **v47 todo「残件記録 > 公開前 PII 監査(バケット)」**に rotation / integration_failures PII 残置と併記(列単位 SELECT 化で公開前にまとめて判断)。

---

## T7 実装記録 — P0RLS loud alert(write-path scope)

**成果物:**
- `lib/db/p0rls.ts`(新規): production の `hasSqlState` / `isP0RLS`(.cause chain walk)。test-only の `tests/integration/pg/setup/rls-assert.ts` は本 module を re-export し実装単一化(依存方向 = production ← test の一方向・pure module ゆえ I/O 依存なし)。
- `lib/integration-failures.ts`: catalog key `rls_context_missing` 追加(`{ service:'db', operation:'rls.context_missing', workflow:null, failureCode:'state_mismatch' }`・既存 axis 語彙内)。
- `lib/db/report-rls-context-failure.ts`(新規): `reportRlsContextFailure(err, {route, op})`。非 P0RLS は即 return(short-circuit)/ P0RLS は `await recordIntegrationFailure`(fire-and-forget は serverless で消失ゆえ await)/ context は enum allowlist(`RlsAlertRoute` / `RlsAlertOp`)の route/op のみ = PII 非搭載 / inner try/catch で記録経路 throw を握り再 throw しない(既存 HTTP status / 例外伝播 / log 不変)。
- 配線: entity-mutations/bulk(serial per-mutation catch + parallel per-mutation catch + envelope catch の 3 catch)/ delete-exam(catch)/ review-events/bulk(processSession catch)。既存 test は無修正 green(additive 確認)。
- test: `lib/db/report-rls-context-failure.test.ts`(6 本・recordIntegrationFailure mock)+ integration-failures.test.ts に key pin 追加 & tuple 数 8→9。**RED 検証 2 件**: (a) `.cause` walk 除去 → nested-P0RLS test のみ fail / (b) userId leak 注入 → PII-free assert fail。両者 revert 後 green。

### T7 未配線経路(REPORTED GAP・read-path 全面配線は follow-up)

本 task の scope は **write-path の serializeDbError catch site のみ**。以下は P0RLS 到達し得る(= `withTenantTx` 内で tenant query を発行する)が **serializeDbError / reportRlsContextFailure を経由しない**ため、P0RLS が発生しても integration_failures 台帳に残らず generic 500 / unhandled throw になる。**「全 P0RLS = 必ず記録」の一般保証は主張しない**。

- **read routes(catch→500、serializeDbError なし)**: `app/api/pull/route.ts` / `app/api/study-days/pull/route.ts` / `app/api/dashboard/stats/route.ts` / `app/api/exams/status/route.ts`(後者は auth 例外 rethrow の非対称あり)。いずれも `catch (err) → Response.json({error:'internal'}, 500)`。
- **server actions(withTenantTx 使用・serializeDbError 経由しない)**: `create-exam.ts` / `exams/[id]/_actions/asset-actions.ts` / `settings/_actions/save-{custom-session-limit,fsrs-mode,session-limit}.ts` / `upgrade/actions.ts` / `upload/_actions/{process,upload-guard,upload-persistence}.ts`。
- **その他 tenant query helper**: `lib/cards/get-session-cards.ts` / `lib/exams/source-doc-status.ts` / `lib/ai-usage-counter.ts` / `lib/db/pull-delta.ts`(呼出元 route 側 catch に依存)。
- **entity-mutations の group-level fatal catch**(`route.ts` の `Promise.allSettled` map 内 outer catch)は **意図的に未配線**。この catch は `assertSequentialPath` / `logger.warn` / `serializeDbError` 自身の meta-throw のみを拾い、DB query の P0RLS はその内側の per-mutation catch(配線済)が先に握るため P0RLS は構造的に到達しない。

follow-up 候補: read-path を含む横断配線を単一 wrapper(例: tenant route handler の共通 catch で `reportRlsContextFailure` を必ず通す)へ寄せる。本 wave では過剰実装として見送り(alert storm rate-limit と同じく plan 対象外)。

**follow-up 注意(catalog key の射程)**: SQLSTATE `P0RLS` は migration 0025 の 3 関数が RAISE する — `app_current_user_id()`(context 未設定)/ `app_resolve_user_for_stripe()`(invalid p_by)/ `app_scrub_deleted_user()`(scrub 対象不一致)。本 wave の 3 write-path はいずれも resolve/scrub 関数を呼ばないため到達する P0RLS は context-missing のみで、subject「tenant context missing on write path」は正確。ただし follow-up で Stripe resolve / scrub path を配線する際は、`isP0RLS` を context-missing message へ絞るか catalog key を分割し、subject の誤分類を避けること(canonical T7 Minor #2)。
