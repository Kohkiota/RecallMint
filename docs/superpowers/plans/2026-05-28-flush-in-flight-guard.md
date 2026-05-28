# flush in-flight guard (cache-fix 問題 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** flush 並走による同 events 二重 POST を event_id ベース module-level Set で排除し、 経路 3 の同期 race gate を撤去して silent retry に倒す。

**Architecture:** `lib/sync/review-events.ts` に in-flight guard を一元化 (経路 1/2/全組合せをカバー)、 経路 2 を全 session group flush 化、 session-runner は経路 2 差し替え + 経路 3 撤去のみ。 bulk route / submit-review-tx 本体は触らず順序保証 test だけ追加。

**Tech Stack:** TypeScript strict / Dexie (fake-indexeddb) / Vitest / ts-fsrs / Next.js Client Component

**spec:** `docs/superpowers/specs/2026-05-28-flush-in-flight-guard-design.md` (4e954fd 承認済)

---

## 全体ルール (各 task 共通、 冒頭一度)

- **TDD 厳守**: 各 task は失敗 test (赤) → 最小実装 (緑) → commit。 test code は generator が書く (本 plan にコード片を載せない = CLAUDE.md「Plan の書き方」 規律)
- **絶対ルール**: 全 query は `WHERE user_id` 前提 (server)、 AI / Stripe / Clerk は本 sprint 無関係。 timestamp は ISO8601 string (§14)
- **命名**: ファイル kebab-case / 関数 camelCase / 定数 UPPER_SNAKE
- **touch 禁止**: `app/api/review-events/bulk/route.ts` 本体 / `lib/cards/submit-review-tx.ts` 本体 / `lib/client-db.ts` schema / pull 系 (= 問題 3 scope)
- **review**: 最終 task で `requesting-code-review` skill canonical 経路 (general-purpose subagent / template 改変なし)、 Critical 0 + [reviewed]。 裏取り category (決済 / 認証 / 削除 / 外部副作用) 非該当 → review pass で即 [reviewed] 可
- 各 task 完了条件は「該当 test 緑 + 全 suite regression なし + Critical 0」 を共通の最低線とし、 task 固有条件を追記

---

### Task 1: getAllPendingAnswerEvents helper

**Files:** Modify `lib/sync/review-events.ts` / Test `lib/sync/review-events.test.ts`

- **目的**: 経路 2 の「全 session pending 取得」 を意図明示する named helper を追加する。
- **制約**: `getPendingAnswerEvents(undefined)` への薄い委譲で実装 (= 全 `sync_status='pending'` を session 横断で返す)。 既存 `getPendingAnswerEvents` / `countPendingAnswerEvents` の signature は不変。 browser 専用 (getClientDb)。
- **完了条件**: 2 session に跨る pending を 1 call で全件返す test 緑 + 既存 17 it regression なし + Critical 0。

---

### Task 2: flushPendingEvents in-flight guard

**Files:** Modify `lib/sync/review-events.ts` / Test `lib/sync/review-events.test.ts`

- **目的**: module-level `inFlightEventIds: Set<string>` を導入し、 同 event_id を含む POST の並走重複を排除する。
- **制約**: Set は module scope (memory のみ、 IDB 非保持)。 `flushPendingEvents` 内部で「pending 取得 → in-flight 除外 → 除外後 events を Set add → try POST → finally Set delete」。 除外後 0 件 **かつ元 pending > 0** のときは POST せず early return (spec §2.4)。 元から 0 件 (純 session-only flush) は従来通り POST。 `FlushResult.attempted` は除外後実送信数 (spec §2.6)、 新 field 追加なし。 タイムアウト保険なし (Vercel 30s abort が finally 保証、 spec §2.2)。
- **完了条件**: (a) 同 session 2 回連続 invoke で POST 1 回・2 回目 skip、 (b) 別 session 並走は独立 POST、 (c) POST reject 時 finally で Set remove (再 invoke で再 pickup)、 (d) 部分 in-flight (5 件中 3 件在庫) で残 2 件のみ送信、 の 4 test 緑 + 既存 attempted 期待値調整 + Critical 0。

---

### Task 3: flushAllPendingEvents (全 session group flush)

**Files:** Modify `lib/sync/review-events.ts` / Test `lib/sync/review-events.test.ts`

- **目的**: 経路 2 用に、 全 session pending を session_id で group 化し各 session を並列 flush する helper を追加する。
- **制約**: 命名は `flushAllPendingEvents`。 `getAllPendingAnswerEvents()` → session_id で group → 各 session に `flushPendingEvents(sessionId)` を `Promise.allSettled` で並列発火。 in-flight 除外は `flushPendingEvents` 内部に委譲 (本 helper では Set を触らない)。 client (BulkApiClient) は引数で受け取り各 flush に委譲 (test 注入用)。
- **完了条件**: 3 session 分の pending が session 別に分配され 3 回 flush される test 緑 + 一部 session の flush 失敗が他 session を巻き込まない (allSettled) test 緑 + Critical 0。

---

### Task 4: session-runner 経路 2 差し替え + 経路 3 撤去

**Files:** Modify `app/(app)/app/study/smart/_components/session-runner.tsx` / Test `app/(app)/app/study/smart/_components/session-runner.test.tsx`

- **目的**: finished useEffect を group flush に切替え、 完了画面「ダッシュボードへ」 を即 navigation に簡素化し NavState を撤去する。
- **制約**: 経路 1 (`runSubmit` 内 IIFE) は touch 不要 (guard は flushPendingEvents 内部に吸収)。 経路 2 useEffect は `completeStudySession(sessionId)` 維持 + `flushPendingEvents(sessionId)` → `flushAllPendingEvents()` に差し替え。 経路 3: `NavState` type / `navState` state / `setNavState` / warning UI / 「保存中…」 label 切替 / `handleDashboardNav` を完全撤去、 button は `onClick={() => router.push('/app')}`。 失敗 user-visible 表示なし (silent retry)。
- **完了条件**: S-cache-3.1 flush gating describe (3 件) を「click で即 push・flush を await しない・warning UI 出ない」 に反転 + NavState 関連 assertion 削除 + 「finished で flushAllPendingEvents が呼ばれる」 test 緑 + 全 suite regression なし + Critical 0。

---

### Task 5: F2 getPendingAnswerEvents 戻り順整合 test

**Files:** Test `lib/sync/review-events.test.ts` (実装変更なし)

- **目的**: 同 card 複数 events の apply 順序の前提となる「pending 戻り順 = 投入順」 を test で固定する。
- **制約**: `lib/sync/review-events.ts` の実装は変更しない (test only)。 Dexie `++local_id` auto-increment 順と `answered_at` 昇順が一致する前提を verify。 異なる answered_at で順次 record した events が投入順で返ることを確認。
- **完了条件**: 戻り順 invariant test 緑 + Critical 0。

---

### Task 6: F1 同 card 順次 apply invariant test

**Files:** Create `lib/cards/submit-review-tx.sequential.test.ts` (新規) / submit-review-tx 本体は touch なし

- **目的**: 同 card に複数 events を順次 `submitReviewTx` する際、 FSRS state が累積更新されることを invariant で固定する。
- **制約**: 既存 `submit-review-tx.test.ts` は file-level で `rate()` を mock しており invariant 確認不能なため、 **別 file で実 ts-fsrs `rate()` を使用**。 tx は stateful mock (= 前 apply の cards 更新結果を次 select が返す) で「同 card N events 順次 apply」 を実 DB なしで再現。 期待値は hard-coded せず **invariant check**: (i) `due` が apply ごとに将来方向へ進む、 (ii) `reps` が events 数分 increment、 (iii) `currentStreak` は correct (rating>=2) 連続で increment / incorrect (rating=1) で 0 reset。
- **完了条件**: 上記 invariant 3 点を満たす順次 apply test 緑 + ts-fsrs version 非依存 (hard-coded 値なし) + Critical 0。

---

### Task 7: F3 per-event tx loop 順序 test

**Files:** Test `app/api/review-events/bulk/route.test.ts` / route 本体は touch なし

- **目的**: bulk route の per-event tx loop が payload の events 配列順で `submitReviewTx` を呼ぶ (= 同 card 複数 events が answered_at 順 apply) ことを固定する。
- **制約**: `app/api/review-events/bulk/route.ts` 本体は変更しない (test only)。 既存 mock 基盤 (submitReviewTx mock の call 記録) を利用し、 同 card_id を含む複数 events payload を投げて `submitReviewTx` の呼出順 = payload 順を assert。
- **完了条件**: 呼出順 = payload 順の test 緑 + 既存 16 it regression なし + Critical 0。

---

### Task 8: 総合確認 + canonical review + 集約 commit

**Files:** (全 task の変更を集約)

- **目的**: full suite + typecheck 総合確認後、 canonical review を通して [reviewed] commit する。
- **制約**: `pnpm test` 全 pass + `pnpm tsc --noEmit` clean を controller が直接確認。 `requesting-code-review` skill canonical 経路 (general-purpose subagent / template 改変なし) で review。 commit は `fix(study):` (= 並走重複の bug fix)。 裏取り category 非該当 → review pass で即 [reviewed] 可。 commit 直前に review ログ 4 点 (経路 / 結果 Critical-Important-Minor / Important 残置有無 / [reviewed] 宣言) を chat 明示。
- **完了条件**: 全 suite pass + typecheck clean + Critical 0 + Important 0 (or OT 承認付き残置) + [reviewed] tag 付与。

---

## Self-Review (writing-plans checklist)

**1. Spec coverage**: 経路 3 削除 (Task 4) / in-flight guard (Task 2) / getAllPendingAnswerEvents (Task 1) / group flush (Task 3) / F1 (Task 6) / F2 (Task 5) / F3 (Task 7) / FlushResult attempted 調整 (Task 2) / 既存 test 反転 (Task 4) / 総合 review (Task 8) = spec §2-4 全カバー。 §5 スコープ外 (bulk schema / refactor / outbox rename / TTL) は task 化せず (= 意図的除外)。

**2. Placeholder scan**: コード片は CLAUDE.md 規律により意図的に非記載 (= generator が TDD で書く)。 各 task は目的 / 制約 / 完了条件の 3 要素を具体明示、 TBD / TODO なし。

**3. Type consistency**: helper 名は全 task で一貫 — `getAllPendingAnswerEvents` (Task 1/3) / `flushAllPendingEvents` (Task 3/4) / `flushPendingEvents` (Task 2/3、 既存 signature 維持) / `inFlightEventIds` (Task 2)。 `FlushResult.attempted` の意味論 (除外後実送信数) は Task 2 で定義し他 task で踏襲。

**判断点記録**: F1 (Task 6) は既存 mock file と分離し実 `rate()` + stateful tx mock を使う (= spec §4.3 plan 委譲範囲、 claude.ai 確認不要と判断)。

---

## 行数

本 plan = 124 行 (CLAUDE.md 上限 250 内)。

## 実行モード

spec / plan 確定済。 execution mode は OT 指示待ち (本 sprint は plan まで)。 推奨は subagent-driven-development (= task 単位 fresh subagent + 二段 review)。
