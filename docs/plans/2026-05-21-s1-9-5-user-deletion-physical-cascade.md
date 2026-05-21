# S1.9.5 user 削除時の関連データ物理削除 + Stripe timeout 強化 実装プラン

**Goal:** Clerk `user.deleted` webhook で削除済 user の個人コンテンツ
(exam / card / source_document / review / study_day / contact_message) を FK cascade で
物理削除し、 transient DB error への retry 耐性を持たせ、 Stripe client timeout を短縮する。

**Architecture:** `handleUserDeleted` を「users SELECT → Stripe cancel ループ
(transaction 外) → DB transaction (UPDATE deleted_at + exams / study_days /
contact_messages DELETE) を最大 3 回 retry」に再構成 (採用案 T-A / 順序 S-2)。
exams DELETE は FK cascade で cards / source_documents / reviews を連動削除。
失敗は既存 `recordFailure` を拡張して `deletion_failures`
(`failure_kind='data_deletion'`) + Discord 通知で記録、 forward-only (rollback なし)。

**Tech Stack:** Next.js Route Handler / Drizzle ORM (neon-serverless transaction) /
PostgreSQL FK cascade / Stripe SDK / Svix。

事前調査: commit `31c436a` / `5382d9c` (`docs/superpowers/sessions/2026-05-21-s1-9-5-*`)。
再精査 (本プラン改訂の根拠): commit ログ参照。
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
- **review**: feat task (T1 / T2 / T3) は `superpowers:requesting-code-review` skill
  (general-purpose subagent、 template 改変なし) 経由の formal review を通す。
  Critical 0 件必須。
- **裏取り**: 本 sprint の feat task は全て削除 / 決済 (Stripe) / Clerk webhook /
  外部副作用に該当。 review pass → commit (tag 無し) → **OT staging smoke 観察** →
  `git commit --amend` で `[reviewed]` 付与。 **T4 / T5** (docs、 ロジック変更なし) は
  review・tag 不要。
- **不変箇所**: `clerk_events` idempotency / POST outer-catch の always-200 /
  Stripe `cancelWithRetry` の retry ロジック (kickoff §不採用、 regression 回避)。
- **migration 不要**: `failure_kind` は DB 上 CHECK 制約なし text、 `$type` union 拡張は
  code-only。 新規 env var なし。
- commit のみ。 staging への push は OT 判断。

## ファイル構成

- `lib/stripe.ts` — Stripe client に `timeout: 10000` 追加 (T1)
- `lib/db/schema.ts` — `deletionFailures.failureKind` union に `'data_deletion'` 追加 (T2)
- `app/api/webhooks/clerk/route.ts` — `handleUserDeleted` 再構成 / `recordFailure` 拡張
  (T2) / retry loop + `isTransientDbError` local 関数 (T3)
- `app/api/webhooks/clerk/route.test.ts` — `getDb` mock 拡張 + test 追加・改訂 (T2 / T3)
- `docs/02-tech-spec.md` — §6 アカウント削除フロー更新 (T4)
- 不在 spec 参照を含む code file (comment のみ) — T4

---

## タスク

### - [ ] T1: Stripe client timeout 10s 短縮

**Files:** Modify `lib/stripe.ts:71`

- **目的**: stripe-node default timeout (80s) が webhook の function budget を圧迫する
  構造を防ぐ。 1 件の hang で削除フロー全体を巻き込まないよう 10s で諦める。
- **制約**: 現状 `new Stripe(key, { maxNetworkRetries: 2 })` の option に
  `timeout: 10000` を足すのみ (1 行修正)。 `cancelWithRetry` のロジック・既存 catch
  経路は不変 (timeout 超過は通常の Stripe API error として throw され、 既存 per-sub
  catch → `recordFailure` に流れる)。 §Stripe key 検証ロジックは触らない。 「なぜ 10s
  か」をコメントで明記。
- **完了条件**: `lib/stripe.test.ts` 全 green (client construction 不変)、 diff は
  timeout option + comment のみ。 `pnpm build` pass。 code-review Critical 0。
  決済関連 → 裏取り対象 (§全体ルール)。

### - [ ] T2: handleUserDeleted で子データ物理削除 (transaction、 retry なし)

**Files:** Modify `app/api/webhooks/clerk/route.ts`, `lib/db/schema.ts`,
`app/api/webhooks/clerk/route.test.ts`

- **目的**: D1 解消。 `handleUserDeleted` を再構成し削除済 user の個人コンテンツを
  物理削除する。 本タスクでは retry なし (T3 で追加)。
- **制約**:
  - `schema.ts:193`: `deletionFailures.failureKind` の `$type` union に
    `'data_deletion'` 追加 (migration 不要)。
  - `handleUserDeleted` (route.ts:122-191) 再構成: ① users を `clerkId` で SELECT し
    `{id, stripeCustomerId}` 取得、 0 行なら既存どおり `notifyOps` "...not synced" して
    return (現状の UPDATE-RETURNING による未同期検知を SELECT に移す)。 ② `customerId`
    あれば既存の Stripe cancel ループ (transaction 外、 `recordFailure` 既存挙動不変) を
    実行、 無ければ skip。 ③ `db.transaction` 内で `UPDATE users SET deleted_at=now()`
    + `DELETE exams` + `DELETE study_days` + `DELETE contact_messages`
    (各 `WHERE user_id = <内部 id>`)。 exams DELETE は FK cascade で cards /
    source_documents / reviews を連動削除 (調査 doc §2.2)。
  - Stripe 失敗が記録されても DB transaction は実行する (forward-only)。 `upload_records`
    / `ai_usage_users` は触らない。
  - **失敗記録は既存 `recordFailure` (route.ts:202-229) を拡張して再利用** (新関数は
    作らない): `kind` union に `'data_deletion'` を追加し、 `notifyOps` subject を
    `kind==='data_deletion'` のとき `'user data deletion failure'`、 それ以外は既存
    `'stripe sub cancel failure during deletion'` に分岐。 既存 3 caller
    (cancel / list / customer_missing) の出力は byte 不変 (regression なし)。
    data_deletion は `subId=null` で呼ぶ (list / customer_missing が既に null を渡して
    おり構造差なし)。 transaction が throw したら `recordFailure({kind:'data_deletion',
    subId:null, errorMessage})` を呼ぶ。
  - 改修箇所のコメントは不在 spec (`§8.x`) を参照せず `docs/02-tech-spec.md §6` を参照。
- **完了条件**: test (正常系 = SELECT→Stripe→transaction で users update + 3 table
  delete / users 未同期 = SELECT 0 行 / `customerId` なし = Stripe skip + transaction 実行
  / transaction 失敗 = `recordFailure` data_deletion 発火) 全 green。 `getDb` mock 拡張:
  既存 `chain()` (route.test.ts:60-70) に `.from` / `.limit` を追加、 `getDb` 返り値
  (route.test.ts:29-34) に `select` / `delete` / `transaction` を追加 (`transaction` は
  既存 `chain()` スタイルに合わせて `fn(txApi)` 構造で新設、 process.test.ts:171-183 を
  参考)。 既存 route.test.ts 全 green。 `pnpm build` / `pnpm test` pass。
  code-review Critical 0。 削除 / Clerk webhook → 裏取り対象。

### - [ ] T3: 子データ削除 transaction の retry 機構

**Files:** Modify `app/api/webhooks/clerk/route.ts`,
`app/api/webhooks/clerk/route.test.ts`

- **目的**: T2 の DB transaction を transient error に対し最大 3 回 retry し、 削除の
  信頼性を上げる。
- **制約**:
  - **transient 判定**: `isTransientDbError` を route.ts 内の **local 非 export 関数**
    として実装 (ocr.ts:72 の local `isTransientError` と同じ codebase pattern。 独立
    file 化はしない — 唯一の caller が本 retry であり、 cron sweep sprint は未確定の
    ため将来再利用を justification にしない)。 transient = pg error `code` が `40001` /
    `40P01` / `08` 始まり / `57P01`・`57P02`・`57P03`、 または `code` を持たない
    connection 切断系 error。 それ以外 (`23xxx` 整合性違反等) は permanent。
  - **retry loop**: `handleUserDeleted` の `db.transaction(...)` 呼び出しを route.ts
    内 local function の retry loop で wrap (Stripe ループは wrap しない)。
    `isTransientDbError` true のときのみ retry、 backoff `500 / 1000 / 2000ms`
    (callWithRetry ocr.ts:82-112 と同値構造。 共有 helper 抽出は ocr.ts への波及 =
    scope 外のため行わず inline)。 permanent は即中断。 transaction は idempotent
    (`UPDATE deleted_at` / `DELETE WHERE` とも再実行安全) なので retry 安全。
  - retry 3 回全失敗 or permanent → T2 拡張済 `recordFailure({kind:'data_deletion'})`
    を呼び、 `errorMessage` に「最終 error + 試行回数」を含める (どの DELETE 失敗かは
    pg error が relation 名を含む)。
- **完了条件**: test (transient code → retry して成功 / transient 3 回全失敗 →
  `recordFailure` data_deletion に試行回数記録 / permanent code → retry せず即記録 /
  代表 transient code を数件) を fake timers で検証。 既存 route.test.ts 全 green。
  `pnpm build` / `pnpm test` pass。 code-review Critical 0。 削除経路 → 裏取り対象。

### - [ ] T4: docs/02-tech-spec.md §6 更新 + 不在 spec 参照の整理

**Files:** Modify `docs/02-tech-spec.md`, および不在 spec 参照を含む code file
(`lib/stripe.ts` / `lib/ops.ts` / `lib/logger.ts` / `lib/auth/ensure-user.ts` /
`instrumentation.ts`、 comment のみ)

- **目的**: §6 (アカウント削除フロー) を実装後の正確な内容へ更新し、 同時に code から
  不在 spec への dangling 参照を除去 (両者とも docs hygiene、 review 不要のため統合)。
- **制約**:
  - 役割境界 — 設計書更新は本タスクのみで行う (実装タスクでは触らない)。 §6 更新点:
    削除ロジックは `lib/users/delete.ts` ではなく `handleUserDeleted`
    (`app/api/webhooks/clerk/route.ts`) に inline / users は soft delete / 物理削除対象
    = exams (cascade で cards・source_documents・reviews) + study_days +
    contact_messages / 保持 = upload_records・ai_usage_users / transaction retry +
    `deletion_failures` 記録の仕組み (本 sprint で新規確立、 plan00 流用ではない旨)。
  - spec 参照除去: `grep -rn "docs/superpowers/specs"` で code file の全 hit
    (現状 5 file 6 箇所) を検出。 account 削除関連は `docs/02-tech-spec.md §6` 参照へ
    書換、 その他の不在 spec は path を削除し説明文のみ残す。 `Spec §N.M` bare 参照も
    同様に整理。 **実装ロジックは一切変更しない (comment のみ)**。
    `docs/superpowers/lessons/` 配下は履歴記録のため対象外。
- **完了条件**: §6 が実装と一致。 code file への `grep` で不在 spec path の hit 0 件。
  `pnpm build` pass。 docs commit (review・tag 不要)。

### - [ ] T5: S1.9.5 sprint session log

**Files:** Create `docs/superpowers/sessions/2026-05-21-s1-9-5-user-deletion-physical-cascade.md`

- **目的**: sprint の実装結果・review 結果・裏取り結果を記録。
- **制約**: OT 出力規律準拠。 各 feat task の review 結果要約 (Critical / Important /
  Minor 件数) と staging smoke 結果を含める。
- **完了条件**: session log commit (docs、 review 不要)。 sprint 完了を OT に報告。

---

## Self-review

- **spec coverage**: kickoff §1 → T2 / §2 → T3 / §3 → T2 (`recordFailure` 拡張) /
  §4 → T1 / §5 → T4 (§6 更新) / §6 → T4 (spec 参照除去)。 全項目に対応タスクあり。
- **再精査での改訂点**: ① `recordDataDeletionFailure` 新設 → 既存 `recordFailure`
  拡張に変更 (90% 重複・regression なし)。 ② `lib/db/transient-error.ts` 独立 file →
  route.ts 内 local 関数に変更 (ocr.ts 先例・cron sprint 未確定)。 ③ 旧 T5/T6 を T4 に
  統合 (docs hygiene 2 件・いずれも review 不要)。 7 タスク → 5 タスク。
- **type 一貫性**: `recordFailure` の `kind` union に `'data_deletion'` 追加 (T2 →
  T3 で使用) / `isTransientDbError` (T3 local) / `failure_kind='data_deletion'`
  (schema T2 → 全タスク) で命名一致。
- **placeholder**: なし。

**最終行数: 187 行 / 上限 250。**
