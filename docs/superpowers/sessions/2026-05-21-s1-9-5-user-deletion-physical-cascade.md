# S1.9.5 sprint log — user 削除時の関連データ物理削除 + Stripe timeout 強化

- 日付: 2026-05-21
- branch: `develop`
- plan: `docs/plans/2026-05-21-s1-9-5-user-deletion-physical-cascade.md` (commit `1ab4f60`)
- 事前調査: `31c436a` / `5382d9c` (`docs/superpowers/sessions/2026-05-21-s1-9-5-{user-deletion-physical-cascade-investigation,deletion-current-impl-trace}.md`)
- 実行方式: subagent-driven development (実装 subagent → spec 適合 review → formal code review)

## 概要

S1.9.4 事前調査で D1 として発見した「user 削除経路が soft delete のみで FK cascade が
永久に発火せず、 削除済 user の個人コンテンツが Postgres に永続残存」を解消。
Clerk `user.deleted` webhook の `handleUserDeleted` を再構成し、 子データを物理削除。
併せて Stripe client timeout を短縮し webhook function budget を保護。

## タスク別結果

| task | commit | 種別 | review (C/I/M) | 裏取り |
|---|---|---|---|---|
| T1 Stripe timeout 10s | `309d8c6` | feat [reviewed] | 0 / 0 / 1 | staging smoke (T2 と一括) |
| T2 子データ物理削除 transaction | `f8e4783` | feat [reviewed] | 0 / 3 / 3 | staging smoke OK |
| T3 transaction retry 機構 | `52e6c56` | feat [reviewed] | 0 / 0 / 4 | staging smoke OK |
| T4 tech-spec §6 + spec 参照整理 | `2ffc90d` | docs | review 不要 | — |
| T5 sprint session log | (本 commit) | docs | review 不要 | — |

review は全 feat task で `superpowers:requesting-code-review` canonical 経路
(`code-reviewer.md` template + general-purpose subagent、 template 改変なし) を使用。
Critical は全 task 0 件。

### T1 — Stripe client timeout 10s 短縮

`lib/stripe.ts` の `new Stripe(...)` に `timeout: 10000` を追加。 stripe-node default
80s が webhook の Vercel function budget を圧迫する構造を防ぐ。
Minor 1: コメントの最悪値 `~30s` が retry backoff 未計上で自己矛盾 → `~35s 程度` に
即修正済。

### T2 — handleUserDeleted で子データ物理削除 (transaction)

`handleUserDeleted` を「users SELECT → Stripe cancel ループ (transaction 外) →
DB transaction (`UPDATE deleted_at` + `exams`/`study_days`/`contact_messages` DELETE)」
に再構成。 `exams` DELETE の FK cascade で `cards`/`source_documents`/`reviews` を
連動削除。 `recordFailure` を `failure_kind='data_deletion'` 対応に拡張 (新関数を作らず
既存拡張、 既存 3 caller の Discord 出力は byte 不変)。 `schema.ts` の `failureKind`
union 拡張 (migration 不要)。
Important 3 件の処理:
- **I-1** (T2 単体は retry が無く、 transaction 失敗時に soft-delete もされず子データも
  残る): T2 の仕様 (retry は T3)。 **process 対応** — T2 を T3 なしで production
  (main) merge しない。 sprint 末に T3 込みで main merge。
- **I-2** (transaction 失敗 test が `db.transaction` 自体の reject を mock し、 inner
  statement throw を模さない): **T3 で対応済**。
- **I-3** (`errorMessage: String(err)` の診断値、 neon driver が pg code を落とす懸念):
  **T3 で対応済**。
Minor 3: stale `§8.x` spec 参照 (T4 で対応済) / import 行長 / tx mock shape 差異
(記録のみ)。

### T3 — 子データ削除 transaction の retry 機構

route.ts に `isTransientDbError` (pg error 分類、 local 非 export) と
`runTransactionWithRetry` (local 非 export) を追加。 transient な pg error
(`40001`/`40P01`/`08*`/`57P01-03`/code 無し connection 切断) は初回 + 最大 3 retry
= 計 4 試行、 backoff 500/1000/2000ms。 permanent (`23xxx` 等) は即中断。
transaction は idempotent (`UPDATE deleted_at`/`DELETE WHERE`) ゆえ retry 安全。
T2 review の I-2 (realistic な「callback 内 statement throw」 harness) / I-3
(`errorMessage` に pg code 明示 + 試行回数) も本 task で対応。
Minor 4 件 (いずれも未修正、 cosmetic / future-sprint):
- M-1: `fn` 型が Drizzle 内部型に間接依存 (action 不要)。
- M-2: 到達不能な `throw lastErr` (exhaustiveness、 現状可)。
- M-3: codeless error → transient 扱いは code-bug 由来 error も 4 回 retry しうる
  (有界・~3.5s)。 cron-sweep sprint で `isTransientDbError` 再利用時に防御的 narrowing
  を検討。
- M-4: test ⑤ の `advanceTimersByTimeAsync(0)` が紛らわしい (cosmetic)。

### T4 — tech-spec §6 更新 + 不在 spec 参照の整理

実装ロジック変更なし (コメント / docs のみ)。 bounded scope (OT 承認済):
- tech-spec: §6 アカウント削除フロー節 / §8 Logic 7 / 散在 4 箇所
  (line 403/736/806/866) を実装に整合。
- full-path `docs/superpowers/specs/` 参照 6 箇所 / 5 file を除去 (`route.ts` の
  bare `§8.x` も整理)。
- 無関係 file の bare `§N.M` 参照 20+ 箇所は scope 外 → 別 docs-hygiene sprint。
完了条件: code file の `docs/superpowers/specs` path hit 0 件 / `pnpm build` pass。

## 裏取り (staging / production smoke) 結果

決済 / Clerk webhook / 削除を伴う変更のため CLAUDE.md「重要 Fix の裏取り」に従い、
review pass → commit (tag 無し) → OT staging smoke → `[reviewed]` amend の手順を実施。

**T1 + T2 一括 smoke (T2 完了時) — 全項目 OK**:
- 削除前 DB: exams 2 / cards 26 / source_documents 2 / reviews 10 / study_days 5 /
  contact_messages 1 / upload_records 2 / ai_usage_users 1
- 削除後 DB: 上記 6 子テーブル全て 0、 `upload_records` 2 / `ai_usage_users` 1 残存、
  `users.deleted_at` set 済
- `deletion_failures`: 0 行 (失敗なし)
- webhook: Execution Duration 3.12s (maxDuration 上限内)、 Status 200、
  error/warning/fatal 0、 Memory 278MB / 2048MB
- T1 (Stripe timeout) は単体観察不可のため本 smoke の Stripe cancel 正常動作で間接確認
  (OT 承認)。

**T3 smoke — 全項目 OK**:
- 削除前後の DB は T1+T2 smoke と同一挙動 (6 子テーブル全削除 / 2 テーブル残存 /
  `deleted_at` set / `deletion_failures` 0)
- webhook 経路: `/api/webhooks/clerk` POST 200 → `/api/me/deletion-status` polling
  4 回連続 200 → `completed` 判定 → `/sign-out-deleted` 200 redirect 完走
- error / warning なし

transient retry / permanent 分類の挙動は staging で意図的再現が不可能なため、
route.test.ts の unit test 17 件 (fake timers) が担保。

**Production smoke (main merge + 本番デプロイ後) — 全項目 OK**:
- 本番環境で削除フロー完走: `/api/webhooks/clerk` POST 200 →
  `/api/me/deletion-status` polling `completed` → `/sign-out-deleted` redirect 完走
- D1 (cascade dormant) の解消を本番環境で最終確認。

## 既知の積み残し / follow-up (別 sprint)

- **docs-hygiene sprint**: 無関係 file の bare `§N.M` spec 参照 20+ 箇所
  (route-groups §4.6 / structured-logger §3 / webhook-error-strengthening §2 /
  deletion-status §3.x 等) の整理。
- **S1.9.6 cron sweep**: Vercel cron による `deletion_failures`
  (`resolved_at IS NULL`) 自動 retry sweep (kickoff §不採用で別 sprint 化)。
- **vercel.json maxDuration 整合**: clerk webhook が `maxDuration: 60` に明示設定
  (kickoff 設計前提の 600s と相違)。 launch 段階 (sub 数 0〜1) は budget 内で問題なし。
- **T3 M-3**: `isTransientDbError` の codeless-error 防御的 narrowing
  (code-bug 由来 error の過剰 retry 回避)。 S1.9.6 cron sweep で本関数を再利用する
  際に併せて検討。

## 検証コマンド

- 起動: `pnpm dev`
- テスト: `pnpm test` (sprint 完了時点 358 件 green)
- ビルド: `pnpm build`

## sprint closure

全 5 task 完了。 feat 3 commit は全て formal review (Critical 0) + OT staging smoke を
経て `[reviewed]`。 staging smoke + production smoke の両方で削除フロー完走を確認し、
D1 (cascade dormant) を解消。 358 unit test all green。
develop → main は fast-forward merge 済 (本 closure commit も同梱)。 schema 変更なし
(`failureKind` の `$type` union 拡張のみ = compile-time、 DB migration 不要)。
origin への push は OT 実施。
