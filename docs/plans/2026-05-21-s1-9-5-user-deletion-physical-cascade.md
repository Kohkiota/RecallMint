# S1.9.5 user 削除時の関連データ物理削除 + Stripe timeout 強化 実装プラン

**Goal:** Clerk `user.deleted` webhook で削除済 user の個人コンテンツ
(exam / card / source_document / review / study_day / contact_message) を FK cascade で
物理削除し、 transient DB error への retry 耐性を持たせ、 Stripe client timeout を短縮する。

**Architecture:** `handleUserDeleted` を「users SELECT → Stripe cancel ループ
(transaction 外) → DB transaction (UPDATE deleted_at + exams / study_days /
contact_messages DELETE) を最大 3 回 retry」に再構成 (採用案 T-A / 順序 S-2)。
exams DELETE は FK cascade で cards / source_documents / reviews を連動削除。
失敗は `deletion_failures` (`failure_kind='data_deletion'`) + Discord 通知で記録、
forward-only (rollback なし)。

**Tech Stack:** Next.js Route Handler / Drizzle ORM (neon-serverless transaction) /
PostgreSQL FK cascade / Stripe SDK / Svix。

事前調査: commit `31c436a` / `5382d9c` (`docs/superpowers/sessions/2026-05-21-s1-9-5-*`)。
**設計前提の注意**: 本 sprint は webhook 処理が Vercel function maxDuration 内に
収まることを前提とする。 `vercel.json` は clerk webhook を `maxDuration: 60` に明示
設定しており (kickoff 設計前提の 600s と相違)、 launch 段階 (sub 数 0〜1) では
Stripe loop + transaction + retry は十分収まる。 `vercel.json` の整合は本 sprint
scope 外。

---

## 全体ルール (各タスクから参照のみ、 再掲しない)

- **TDD**: 各タスク test 先行、 実装コードは Generator が書く。 実 Stripe / Clerk / DB は
  叩かず mock (CLAUDE.md テスト方針)。
- **TypeScript strict** 維持。 ファイル名 kebab-case / 関数 camelCase。
- **review**: feat task は `superpowers:requesting-code-review` skill (general-purpose
  subagent、 template 改変なし) 経由の formal review を通す。 Critical 0 件必須。
- **裏取り**: 本 sprint は削除 / 決済 (Stripe) / Clerk webhook / 外部副作用に該当。
  feat task は review pass → commit (tag 無し) → **OT staging smoke 観察** →
  `git commit --amend` で `[reviewed]` 付与。 例外: **T3** (純粋関数、 副作用なし) は
  review pass で即 `[reviewed]`。 **T5 / T6 / T7** (docs / chore、 ロジック変更なし) は
  review・tag 不要。
- **不変箇所**: `clerk_events` idempotency / POST outer-catch の always-200 /
  Stripe `cancelWithRetry` のロジック (kickoff §不採用、 regression 回避)。
- **migration 不要**: `failure_kind` は DB 上 CHECK 制約なし text、 `$type` union 拡張は
  code-only。 新規 env var なし。
- commit のみ。 staging への push は OT 判断。

## ファイル構成

- `lib/stripe.ts` — Stripe client に `timeout: 10000` 追加 (T1)
- `lib/db/transient-error.ts` (新規) — `isTransientDbError` 純粋関数 (T3)
- `lib/db/transient-error.test.ts` (新規) — 同 unit test (T3)
- `lib/db/schema.ts` — `deletionFailures.failureKind` union に `'data_deletion'` 追加 (T2)
- `app/api/webhooks/clerk/route.ts` — `handleUserDeleted` 再構成 +
  `recordDataDeletionFailure` 新設 + retry (T2 / T4)
- `app/api/webhooks/clerk/route.test.ts` — `getDb` mock 拡張 + test 追加・改訂 (T2 / T4)
- `docs/02-tech-spec.md` — §6 アカウント削除フロー更新 (T5)
- 不在 spec 参照を含む code file (comment のみ) — T6

---

## タスク

### - [ ] T1: Stripe client timeout 10s 短縮

**Files:** Modify `lib/stripe.ts`

- **目的**: stripe-node default timeout (80s) が webhook の function budget を圧迫する
  構造を防ぐ。 1 件の hang で削除フロー全体を巻き込まないよう 10s で諦める。
- **制約**: `new Stripe(key, {...})` の option に `timeout: 10000` を足すのみ。
  `cancelWithRetry` のロジック・既存 catch 経路は不変 (timeout 超過は通常の Stripe API
  error として throw され、 既存 per-sub catch → `recordFailure` に流れる)。 §Stripe key
  検証ロジックは触らない。 「なぜ 10s か」をコメントで明記。
- **完了条件**: `lib/stripe.test.ts` 全 green (client construction 不変)、 diff は
  timeout option + comment のみ。 `pnpm build` pass。 code-review Critical 0。
  決済関連 → 裏取り対象 (§全体ルール)。

### - [ ] T2: handleUserDeleted で子データ物理削除 (transaction、 retry なし)

**Files:** Modify `app/api/webhooks/clerk/route.ts`, `lib/db/schema.ts`,
`app/api/webhooks/clerk/route.test.ts`

- **目的**: D1 解消。 `handleUserDeleted` を再構成し削除済 user の個人コンテンツを
  物理削除する。 本タスクでは retry なし (T4 で追加)。
- **制約**:
  - `schema.ts`: `deletionFailures.failureKind` の `$type` union に `'data_deletion'`
    追加 (migration 不要)。
  - `handleUserDeleted` 再構成: ① users を `clerkId` で SELECT し `{id,
    stripeCustomerId}` 取得、 0 行なら既存どおり `notifyOps` "...not synced" して
    return。 ② `customerId` あれば既存の Stripe cancel ループ (transaction 外、
    `recordFailure` 既存挙動不変) を実行、 無ければ skip。 ③ `db.transaction` 内で
    `UPDATE users SET deleted_at=now()` + `DELETE exams` + `DELETE study_days` +
    `DELETE contact_messages` (各 `WHERE user_id = <内部 id>`)。 exams DELETE は FK
    cascade で cards / source_documents / reviews を連動削除 (調査 doc §2.2)。
  - Stripe 失敗が記録されても DB transaction は実行する (forward-only)。 `upload_records`
    / `ai_usage_users` は触らない。
  - transaction が throw した場合 (本タスクは retry なし) → 新設
    `recordDataDeletionFailure` で `deletion_failures` に `failure_kind='data_deletion'`
    / `sub_id=NULL` / `error_message` に失敗 error 文字列を記録 + `notifyOps` subject
    `"user data deletion failure"`。 `recordFailure` (Stripe 用) は触らない。
  - 改修箇所のコメントは不在 spec (`§8.x`) を参照せず `docs/02-tech-spec.md §6` を参照。
- **完了条件**: test (正常系 = SELECT→Stripe→transaction で users update + 3 table
  delete / users 未同期 = SELECT 0 行 / `customerId` なし = Stripe skip + transaction 実行
  / transaction 失敗 = `recordDataDeletionFailure` 発火) 全 green。 `getDb` mock に
  select / delete / transaction を追加 (transaction は `process.test.ts:165-177`
  パターン流用)。 既存 route.test.ts 全 green。 `pnpm build` / `pnpm test` pass。
  code-review Critical 0。 削除 / Clerk webhook → 裏取り対象。

### - [ ] T3: isTransientDbError 純粋関数

**Files:** Create `lib/db/transient-error.ts`, `lib/db/transient-error.test.ts`

- **目的**: DB error を transient (retry 可) / permanent (即諦め) に分類する純粋関数。
  T4 の retry 判定で使用。 将来の cron sweep sprint でも再利用するため独立 file。
- **制約**: pg error の `code` を判定。 **transient** = `40001` (serialization_failure)
  / `40P01` (deadlock_detected) / `08` 始まり (connection_exception 全般) /
  `57P01`・`57P02`・`57P03` (shutdown / cannot_connect)。 加えて `code` を持たない
  connection 切断系 error (Neon WebSocket 切断) も transient 扱い。 それ以外
  (`23xxx` 整合性違反等を含む) は **permanent**。 純粋関数、 副作用・外部依存なし。
- **完了条件**: transient 各ケース / permanent (例 `23505`) / `code` なし connection
  error / 無関係 error を網羅する unit test 全 green。 code-review Critical 0 +
  `[reviewed]` (純粋関数、 裏取り対象外)。

### - [ ] T4: 子データ削除 transaction の retry 機構

**Files:** Modify `app/api/webhooks/clerk/route.ts`,
`app/api/webhooks/clerk/route.test.ts`

- **目的**: T2 の DB transaction を transient error に対し最大 3 回 retry し、 削除の
  信頼性を上げる。
- **制約**: `handleUserDeleted` の `db.transaction(...)` 呼び出しを retry loop で wrap
  (Stripe ループは wrap しない)。 `isTransientDbError` (T3) が true のときのみ retry、
  backoff `500ms / 1000ms / 2000ms` (`cancelWithRetry` / `callWithRetry` と思想統一)。
  permanent error は即中断。 retry 3 回全失敗 or permanent → `recordDataDeletionFailure`
  (T2 新設) を呼び、 `error_message` に「最終 error + 試行回数」を含める。 transaction は
  idempotent (`UPDATE deleted_at` / `DELETE WHERE` とも再実行安全) なので retry 安全。
- **完了条件**: test (transient → retry して成功 / transient 3 回全失敗 →
  `recordDataDeletionFailure` に試行回数記録 / permanent → retry せず即記録) を
  fake timers で検証。 既存 route.test.ts 全 green。 `pnpm build` / `pnpm test` pass。
  code-review Critical 0。 削除経路 → 裏取り対象。

### - [ ] T5: docs/02-tech-spec.md §6 アカウント削除フロー更新

**Files:** Modify `docs/02-tech-spec.md`

- **目的**: §6 (アカウント削除フロー) の記述を実装後の正確な内容へ更新。
- **制約**: 役割境界 — 設計書更新は本タスクのみで行う (実装タスクでは触らない)。
  更新点: 削除ロジックは `lib/users/delete.ts` ではなく `handleUserDeleted`
  (`app/api/webhooks/clerk/route.ts`) に inline / users は soft delete / 物理削除対象 =
  exams (cascade で cards・source_documents・reviews) + study_days + contact_messages /
  保持 = upload_records・ai_usage_users / transaction retry + `deletion_failures`
  記録の仕組み (本 sprint で新規確立、 plan00 流用ではない旨を明記)。
- **完了条件**: §6 が実装と一致。 docs commit (review・tag 不要)。

### - [ ] T6: 不在 spec 参照の除去

**Files:** comment のみ修正 — `lib/stripe.ts` / `lib/ops.ts` / `lib/logger.ts` /
`lib/auth/ensure-user.ts` / `instrumentation.ts` (`grep` で最終確認)

- **目的**: code / comment から、 存在しない `docs/superpowers/specs/` 配下 spec への
  dangling 参照を除去。
- **制約**: `grep -rn "docs/superpowers/specs"` で code file の全 hit を検出。
  account 削除関連 (account-deletion-redesign) は `docs/02-tech-spec.md §6` 参照へ
  書換。 それ以外の不在 spec (webhook-only-user-sync-design / webhook-error-strengthening
  / phase1-g-6 等) は spec path を削除し説明文のみ残す。 `Spec §N.M` の bare 参照も
  不在 spec を指すものは整理。 **実装ロジックは一切変更しない (comment のみ)**。
  `docs/superpowers/lessons/` 配下は履歴記録のため対象外。
- **完了条件**: code file への `grep` 再実行で不在 spec path の hit 0 件。
  `pnpm build` pass。 chore commit (review・tag 不要)。

### - [ ] T7: S1.9.5 sprint session log

**Files:** Create `docs/superpowers/sessions/2026-05-21-s1-9-5-user-deletion-physical-cascade.md`

- **目的**: sprint の実装結果・review 結果・裏取り結果を記録。
- **制約**: OT 出力規律準拠。 各 feat task の review 結果要約 (Critical / Important /
  Minor 件数) と staging smoke 結果を含める。
- **完了条件**: session log commit (docs、 review 不要)。 sprint 完了を OT に報告。

---

## Self-review

- **spec coverage**: kickoff §1 → T2 (transaction + 削除) / §2 → T3 + T4 (retry) /
  §3 → T2 (`failure_kind='data_deletion'` + `recordDataDeletionFailure`) / §4 → T1
  (Stripe timeout) / §5 → T5 / §6 → T6。 全項目に対応タスクあり。
- **type 一貫性**: `recordDataDeletionFailure` (T2 新設 → T4 で使用) / `isTransientDbError`
  (T3 新設 → T4 で使用) / `failure_kind='data_deletion'` (schema T2 → 全タスク) で
  命名一致。
- **placeholder**: なし。

**最終行数: 188 行 / 上限 250。**
