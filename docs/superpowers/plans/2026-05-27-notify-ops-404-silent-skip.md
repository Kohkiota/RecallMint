# notifyOps 404 silent skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lib/auth/clerk-metadata.ts` の Clerk Backend API 呼出が 404 を返したとき、 notifyOps を fire せず silent skip + `ok:true` を返すよう変更し、 Discord 通知ノイズを削減する。

**Architecture:** catch 内に 1 つの判定分岐を挟む single-file 変更。 検出は Clerk 公式の `isClerkAPIResponseError` (from `@clerk/nextjs/errors`) + `err.status === 404`。 404 以外の挙動 (notifyOps + ok:false) は無変更。 軽量観測性のため `console.debug` 1 行残す。

**Tech Stack:** Next.js 15 / TypeScript strict / @clerk/nextjs 7.x / Vitest + hoisted mock

**関連 spec:** `docs/superpowers/specs/2026-05-27-notify-ops-404-silent-skip-design.md` (実装イメージ / 設計判断 3 点 / test plan 詳細 / YAGNI 明示)

**関連 roadmap:** `docs/cache-fix-roadmap.md` §④-4

---

## Plan-wide rules

各 task 共通 (再掲しない):

- **CLAUDE.md 絶対ルール準拠**: Clerk 認証 §4 (全 query で `user_id` 絞り — 本 task 該当なし、 認証 helper 自体の変更) / Stripe / AI は本 task で touch しない
- **TDD 厳守**: failing test 先行 → 実装 → green → review → commit。 順序逆転禁止
- **既存 5 test case 維持**: 改修不要、 新規 1 case のみ追加 (合計 6)
- **既存挙動の不変条件**: 404 以外の status / network / generic Error は `notifyOps + ok:false` 維持。 既存 case 5 (Clerk 5xx 経路) が verify する
- **OT 出力規律**: 完了 / 着手 / blocker 等のみ chat、 詳細は session log
- **review 経路**: `superpowers:requesting-code-review` skill canonical (general-purpose subagent + 厳格 prompt + template 改変なし)
- **commit tag**: feat/fix は `[reviewed]`。 本 task は実装ロジック変更を含むため formal review 必須 (= `[no-review]` 不可)
- **完了判定**: 各 task の test + `pnpm exec tsc --noEmit` clean + `pnpm test -- --run` 全 pass + Critical 0 / Important 0
- **やらないこと** (spec §3 Out 参照): 他 Clerk API 呼出箇所への横展開 / notifyOps 自体の改修 / 401 / 403 / 410 / 422 等への拡張

---

## Task 1: 404 silent skip 実装 + test 追加 (TDD 1 サイクル)

**Files:**
- Modify: `lib/auth/clerk-metadata.ts`
  - import 追加: `isClerkAPIResponseError` from `@clerk/nextjs/errors`
  - catch 冒頭に 404 判定分岐: `isClerkAPIResponseError(err) && err.status === 404` で `console.debug` 1 行 + `return { ok: true }`
  - docstring「失敗ポリシ」 section に 404 例外条項を追記 (spec §1 結論サマリの文言ベース)
- Modify: `lib/auth/clerk-metadata.test.ts`
  - 既存 5 case 改修なし
  - 新規 1 case 追加: `ClerkAPIResponseError` (status=404) を `mockRejectedValueOnce` に注入、 (1) `mockNotifyOps` 呼ばれない / (2) 戻り値 `{ ok: true }` / (3) `console.debug` 1 回呼出 + 第 1 引数に `'user not found'` 含むことを assert
  - `console.debug` spy は `vi.spyOn(console, 'debug')` を本 case 内 (or `beforeEach`) で setup、 `afterEach` で restore
  - `ClerkAPIResponseError` は `@clerk/nextjs/errors` から import、 constructor: `new ClerkAPIResponseError('Not Found', { data: [], status: 404, clerkTraceId: 'test-trace' })`

**目的:** spec §1 / §4 / §5 に従い 404 silent skip を 1 ファイル粒度で実装、 既存挙動を壊さないことを test で verify。

**制約:**
- 検出は spec §5 の `isClerkAPIResponseError + err.status === 404` パターンに準拠 (Clerk 公式 helper、 repo 内 `delete-button.tsx:7` で既使用済 pattern)
- `console.debug` の payload key は `clerkId` (function 引数の命名と一致、 spec §5)
- 既存 case 5 (`new Error('Clerk 5xx')` を rejected) が新 404 path に乗らないことを確認 (= 既存挙動 test が改修不要なまま valid である事実は本 task で破壊しない)
- TypeScript strict / kebab-case file / camelCase fn (CLAUDE.md コーディング規約)

**Steps:**

- [ ] **Step 1.1**: 新規 test case を先に書く (failing test、 spec §6 の新規 1 case 仕様に準拠)
- [ ] **Step 1.2**: `pnpm test -- --run lib/auth/clerk-metadata.test.ts` で FAIL を verify (期待 fail message: 「`notifyOps` が呼ばれた」 / 「`ok: false` が返った」)
- [ ] **Step 1.3**: `lib/auth/clerk-metadata.ts` に import + catch 内 404 分岐 + docstring 追記を実装
- [ ] **Step 1.4**: `pnpm test -- --run lib/auth/clerk-metadata.test.ts` で PASS (6 case green) を verify
- [ ] **Step 1.5**: `pnpm exec tsc --noEmit` で clean を verify
- [ ] **Step 1.6**: `pnpm test -- --run` 全件 pass を verify (regression なし)
- [ ] **Step 1.7**: `superpowers:requesting-code-review` skill canonical 経路で review (general-purpose subagent + template 改変なし)
- [ ] **Step 1.8**: review 結果を chat で declare (経路 / Critical N / Important N / Minor N / Important 残置の有無)
- [ ] **Step 1.9**: Critical 0 / Important 0 を確認後、 [reviewed] tag 付き commit

**完了条件:**

- 新規 1 case + 既存 5 case 全 pass (合計 6)
- `pnpm test -- --run` 全 pass (regression なし)
- `pnpm exec tsc --noEmit` clean
- review Critical 0 / Important 0
- commit message 末尾 `[reviewed]` tag

---

## Self-review (本 plan)

spec カバレッジ:

- [x] spec §3 In: catch 内 404 判定 + silent return → Task 1 Step 1.3
- [x] spec §3 In: docstring 「失敗ポリシ」 section 追記 → Task 1 Step 1.3 (Files セクションで明示)
- [x] spec §3 In: test に 404 case 1 件追加 → Task 1 Step 1.1
- [x] spec §4 判断 1: 戻り値 `ok: true` → Files セクション + 新規 test の (2)
- [x] spec §4 判断 2: `console.debug` 1 行 → Files セクション + 新規 test の (3)
- [x] spec §4 判断 3: 404 以外無変更 → Plan-wide rules「既存挙動の不変条件」
- [x] spec §6 新規 case の assertion 3 点 → Files セクション
- [x] spec §6 `ClerkAPIResponseError` 構築方法 → Files セクション
- [x] spec §7 完了条件 → Task 1 完了条件 + Plan-wide rules

placeholder scan: TBD / TODO / 「適切に」 等の vague 語なし。

type / 命名整合性: `clerkId` / `mockNotifyOps` / `mockUpdateUserMetadata` 等は既存 test file の命名と一致。

scope: 1 task で完結、 sub-project 分割不要。

**最終行数: 95 行 / 上限 250**
