# S1.9.4 並列 OCR upload guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一 user の並列 OCR upload を「1 user 1 ジョブ」 に制限する。server-side enforcement (advisory xact lock + in-flight 行 check) を主、UI guard を advisory 第一層とする。

**Architecture:** `processUpload` 冒頭を 1 つの短い `db.transaction` で囲い、`pg_try_advisory_xact_lock` で同時起動の race を防ぎ、既存 `status='processing'` 行 (15 分 window) の有無で in-flight ジョブを弾く。lock は exam/source_documents INSERT までで commit 解放し、OCR 本体 (最大 600s) は transaction 外。`/app/upload` page は render 時に reconcile → in-flight 判定で upload form を出し分ける。

**Tech Stack:** Next.js 15 App Router / TypeScript strict / Drizzle ORM / PostgreSQL (Neon) / Vitest。

**作業ブランチ:** `develop`。 事前調査: `docs/superpowers/sessions/2026-05-20-s1-9-4-parallel-ocr-guard-and-cascade-investigation.md`

---

## 全体ルール (各タスク共通、再掲しない)

- TypeScript strict 維持。ファイル名 kebab-case / 関数 camelCase / 定数 UPPER_SNAKE_CASE。
- 全 DB query は owner-scoped (`WHERE user_id = ?`)。
- feat commit は `superpowers:requesting-code-review` skill 経由の formal review 必須。Critical 0 で commit、commit 直前に review 経路・結果要約を OT 応答内に明示、`[reviewed]` tag を付与。
- 本 sprint は 決済 / 認証 / 削除 いずれにも非該当。外部 API (Gemini) 呼び出し自体は変更せず、その前段に concurrency guard を足すのみ → per-commit の OT 実機 gate は設けない。sprint 全体で kickoff §設計前提の staging smoke (develop push → staging smoke → main merge) を経る。
- **migration なし** (advisory lock 採用の利点。schema 変更ゼロ)。新規環境変数なし。`.env.example` 変更なし。
- maxDuration 600s は Vercel dashboard 設定済 (S1.9.3 確定)、code 変更不要。
- UI は既存 Card / Button の世界観に統一 (紫グラデ・テンプレ AI デザイン禁止)。UI 変更は Chrome DevTools モバイルビューで検証。
- 不採用 (kickoff 確定): 案 (a) FOR UPDATE / 案 (b) partial unique index は採らない。D1 (cascade dormant) は S1.9.5 へ切り出し、本 sprint 非対象。

## ファイル構成 (新規ファイルなし)

- 変更: `app/(app)/app/upload/_actions/process.ts` — server guard + `UPLOAD_IN_PROGRESS` code (T1)
- 変更: `app/(app)/app/upload/_actions/process.test.ts` — guard path の test (T1)
- 変更: `app/(app)/app/upload/_components/upload-form.tsx` — `UPLOAD_IN_PROGRESS` の error 表示 (T2)
- 変更: `lib/exams/source-doc-status.ts` — `hasActiveProcessingUpload` helper (T3)
- 変更: `app/(app)/app/upload/page.tsx` — UI guard 統合 (T4)

## 実装順序と commit

T1 → T2 → T3 → T4 (逐次)。commit は 2 本: **commit A = T1+T2** (server guard 一式)、**commit B = T3+T4** (UI guard 一式)。各 commit 時点で build green 維持。

---

### Task 1: server-side 並列 guard (process.ts)

**Files:** Modify `app/(app)/app/upload/_actions/process.ts` / `process.test.ts`

**目的:** `processUpload` に「1 user 1 OCR ジョブ」 の server-side enforcement を追加。advisory xact lock で同時起動 race を防ぎ、in-flight ジョブ check で並列を弾く。

**制約:**
- `ProcessUploadErrorCode` union に `UPLOAD_IN_PROGRESS` を追加。
- guard は plan-limits (`canRunOcr`) / daily-limit (`getTodayAiUsageGlobal`) guard より **前** に配置 (kickoff 指定)。
- 1 つの `db.transaction` で以下を順に実行し、最後に commit:
  1. `pg_try_advisory_xact_lock(hashtext(<userId>::text))` を tx handle (raw `sql`) で取得 → false なら `UPLOAD_IN_PROGRESS` を return (同時起動 race の loser)。
  2. in-flight 行 check: `source_documents` を tx handle で `WHERE user_id=? AND status='processing' AND created_at >= now()-interval '15 minutes' LIMIT 1` → 存在すれば `UPLOAD_IN_PROGRESS` を return。
  3. exam 確定 (新規 INSERT / 既存 validate) + `source_documents` INSERT (`status='processing'`)。
- **両方 (advisory lock + in-flight check) が必須**: advisory lock 単独は ms 窓の race しか防がず、先行ジョブの OCR 走行中 (lock 解放済) の並列起動を防げない。in-flight check が「1 ジョブ」 の実効ルール、advisory lock がその check+INSERT を race-free にする。
- OCR pipeline 以降 (Gemini call / cards INSERT / 完了 transaction) は **transaction の外**。lock を OCR 本体 (最大 600s) に持ち込まない。
- in-flight check の 15 分 window は stale orphan (>15min、reconcile 前) で誤発火させないための safety net。閾値は `STALE_PROCESSING_MS` と整合させる。
- 既存 plan-limits / daily-limit helper は pure read のため tx handle 必須でない (現状の `getDb()` のままで可)。tx handle に属させるのは advisory lock + in-flight check + exam/source_documents INSERT のみ。
- `UPLOAD_IN_PROGRESS` の user 文言: 「処理中の OCR があります。完了をお待ちいただくか『試験一覧』 で状況をご確認ください」 主旨。
- hashtext 衝突は無関係 user の稀な直列化のみで correctness 影響なし (許容、kickoff 指定)。

**完了条件:** `process.test.ts` の既存 test が transaction 再構成後も green (mock を必要に応じ更新)。新規 test で 2 guard path を検証 — advisory lock 取得失敗 → `UPLOAD_IN_PROGRESS` / in-flight processing 行あり → `UPLOAD_IN_PROGRESS`。`pnpm build` green。review Critical 0。(commit は T2 と一括)

- [ ] failing test (2 guard path) を追加 → guard を実装 → green、既存 test も green に更新
- [ ] `pnpm build` / `pnpm test` 確認

---

### Task 2: upload-form の UPLOAD_IN_PROGRESS 表示 (upload-form.tsx)

**Files:** Modify `app/(app)/app/upload/_components/upload-form.tsx`

**目的:** server が `UPLOAD_IN_PROGRESS` を返したとき upload-form が整合した error 表示をする。

**制約:**
- `runProcess` の既存 `!result.ok` handler は任意 code を phase=error にして `result.error` を表示する汎用処理。`UPLOAD_IN_PROGRESS` の文言 (server 設定) はこれで自動表示される。
- 追加対応: `result.code === 'UPLOAD_IN_PROGRESS'` のとき error phase に `hideRetryHint: true` を設定し「ファイルを変更して再度お試しください」 サブタイトルを抑止する (ファイルの問題ではないため。`hideRetryHint` は S1.9.3 T1 で導入済の仕組みを流用)。
- `ProcessUploadErrorCode` への `UPLOAD_IN_PROGRESS` 追加は T1 で完了済 (upload-form は process.ts から型を import するため型側の追加対応は不要)。
- `ErrorDetails` (dev 詳細パネル) は `code` を文字列描画するのみ、新 code 専用処理は不要。

**完了条件:** `pnpm build` green / `pnpm test` 既存 green。`UPLOAD_IN_PROGRESS` error 時に retry hint サブタイトルが出ないことをコードで確認。review Critical 0 + `[reviewed]`。commit A = `feat(upload): server-side 並列 OCR guard (advisory xact lock) [reviewed]` (T1+T2)。

- [ ] `UPLOAD_IN_PROGRESS` 時の `hideRetryHint` 設定を実装
- [ ] `pnpm build` / `pnpm test` 確認
- [ ] requesting-code-review (T1+T2 統合 diff) → Critical 0 → commit A

---

### Task 3: hasActiveProcessingUpload helper (source-doc-status.ts)

**Files:** Modify `lib/exams/source-doc-status.ts`

**目的:** UI guard 用に「current user に in-flight の OCR ジョブがあるか」 を返す軽量 helper を新設。

**制約:**
- `hasActiveProcessingUpload(userId: string): Promise<boolean>` を追加。
- query: `source_documents` を `WHERE user_id=? AND status='processing' AND created_at >= now()-interval '15 minutes' LIMIT 1`。`source_docs_status_idx (user_id, status)` 直撃の軽量 query。
- 15 分 window は T1 の server-side check と条件を揃える (in-flight 判定の定義 drift を避ける)。閾値は同 file の既存定数 `STALE_PROCESSING_MS` と整合する形で表現。
- best-effort: 同 file の既存方針 (`getExamStatusMap` が DB エラーで空 Map を返す) に揃え、try-catch で例外時は `logger.warn` + `false` を返す。理由 = UI guard は advisory 層で真の enforcement は T1 の server guard、helper 失敗時は form を出す側に倒す。
- file header コメントの「N エクスポート」 表記があれば更新する。

**完了条件:** `pnpm build` green。DB query 関数のため専用 unit test は不要 (`getExamStatusMap` 等と同じ S1.9.3 precedent)。review Critical 0。(commit は T4 と一括)

- [ ] `hasActiveProcessingUpload` を実装、`pnpm build` / `pnpm test` 確認

---

### Task 4: /app/upload page の UI guard 統合 (upload/page.tsx)

**Files:** Modify `app/(app)/app/upload/page.tsx`

**目的:** `/app/upload` render 時に in-flight ジョブを検知し、あれば upload form の代わりに案内を出す。

**制約:**
- `app/(app)/app/upload/page.tsx` (既に Server Component) の render 冒頭で順に: (1) `await reconcileStaleProcessing(user.id)` (stale cleanup 先行)、(2) `await hasActiveProcessingUpload(user.id)`。
- (2) が `true` → `<UploadForm>` を描画せず、「処理中につき完了までお待ちください」 主旨の案内 + 試験一覧 (`/app/exams`) への link を描画。案内は既存 `Card` / `Button` の世界観、紫グラデ等禁止。inline JSX で可 (新規 component ファイル不要)。
- (2) が `true` のときは `getActiveExamsForUser` / `getCurrentMonthOcrPages` の fetch は不要 (UploadForm を出さないため) → スキップする。
- (2) が `false` → 従来通り `Promise.all([getActiveExamsForUser, getCurrentMonthOcrPages])` で fetch し `<UploadForm>` を描画。
- reconcile は best-effort + idempotent。試験一覧 page との二重実行は安全 (S1.9.3 確認済)。

**完了条件:** `pnpm build` green / `pnpm test` 既存 green。in-flight processing 行があるとき案内が出て form が出ない / ないとき従来通り form が出る。モバイルビューで案内 UI を確認。review Critical 0 + `[reviewed]`。commit B = `feat(upload): /app/upload の並列 upload UI guard [reviewed]` (T3+T4)。

- [ ] page.tsx に reconcile → hasActiveProcessingUpload → 条件分岐描画を実装
- [ ] `pnpm build` / `pnpm test` / モバイルビュー確認
- [ ] requesting-code-review (T3+T4 統合 diff) → Critical 0 → commit B
