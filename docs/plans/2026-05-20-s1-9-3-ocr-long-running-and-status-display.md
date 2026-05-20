# S1.9.3 OCR long-running + 試験一覧 status 表示 + 削除 UI 前倒し Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OCR を client timeout 撤廃で長時間完走可能にし、試験一覧で処理中/失敗 exam を可視化し、失敗 exam を消すための削除 UI を S2 から先取りする。

**Architecture:** upload-form は 90 秒で離脱ガードを解除し「閉じてよい」案内へ切替 (server 完走前提)。試験一覧は専用軽量 query で source_documents の最新 status を merge 表示し、render 時に 15 分越え processing を best-effort で failed 化。result page の破棄 button を廃止し、その cascade 削除 logic を exam 削除 action へ転用。

**Tech Stack:** Next.js 15 App Router / TypeScript strict / Drizzle ORM / PostgreSQL (Neon) / Vitest。

**作業ブランチ:** `develop` (調査 doc commit `ebdbfc9` を含む)。sprint 完了時に `main` へ反映。

**事前調査:** `docs/superpowers/sessions/2026-05-20-s1-9-3-ocr-long-running-and-status-display-investigation.md`

---

## 全体ルール (各タスク共通、再掲しない)

- TypeScript strict 維持。ファイル名 kebab-case / 関数 camelCase / 定数 UPPER_SNAKE_CASE。
- 全 DB query は owner-scoped (`WHERE user_id = ?`)。
- feat/fix commit は `superpowers:requesting-code-review` skill 経由の formal review 必須。Critical 0 件で commit、commit 直前に review 経路・結果要約を OT 応答内に明示。
- commit tag: review 完了で `[reviewed]`。ただし **T6 (exam 削除 = 削除を伴う変更) は review pass 後 tag 無しで commit → OT 実機確認 → `git commit --amend` で `[reviewed]` 追記** (CLAUDE.md §重要 Fix の裏取り)。
- 新規環境変数なし。`.env.example` 変更なし。
- UI は既存 Card / Button の世界観に統一 (紫グラデ・白カード羅列・テンプレ AI デザイン禁止)。UI 変更は Chrome DevTools モバイルビューで検証。
- maxDuration 600s は Vercel dashboard で project default 設定済、code 変更不要。
- 不採用 (範囲外): D4 (GEMINI_FAILED の Flash cost 取りこぼし) / §7.2 (thoughtsTokenCount) / ai_usage・ai_usage_users は一切触らない。

## ファイル構成

- 変更: `app/(app)/app/upload/_components/upload-form.tsx` — long-running 対応 (T1)
- 変更: `app/(app)/app/upload/result/[sourceDocumentId]/_components/result-actions.tsx` — 破棄 button 廃止 (T2)
- 変更: `app/(app)/app/upload/result/[sourceDocumentId]/page.tsx` — ResultActions props 整理 (T2)
- 新規: `lib/exams/source-doc-status.ts` — status 集計 + stale cleanup helper (T3)
- 新規: `lib/exams/source-doc-status.test.ts` — 純関数 deriveExamStatuses の test (T3)
- 変更: `app/(app)/app/exams/page.tsx` — cleanup 実行 + status tag 描画 (T4) + 削除 button 配置 (T6)
- 新規: `app/(app)/app/exams/_actions/delete-exam.ts` — exam 削除 server action (T5)
- 新規: `app/(app)/app/exams/_actions/delete-exam.test.ts` — delete-exam の test (T5)
- 削除: `app/(app)/app/upload/_actions/discard.ts` + `discard.test.ts` — delete-exam へ転用 (T5)
- 新規: `app/(app)/app/exams/_components/delete-exam-button.tsx` — 削除 button client component (T6)

---

### Task 1: OCR long-running 対応 (upload-form)

**Files:** Modify `app/(app)/app/upload/_components/upload-form.tsx`

**目的:** client 90 秒 timeout (error 化) を撤廃。90 秒経過後は spinner を継続したまま「閉じてよい」案内へ切替え、server 完走を待つ。`processUpload` throw 時の error handling も整備。

**制約:**
- `runProcess` の `setTimeout`→`timedOut`→error 化 (`CLIENT_TIMEOUT`) を撤廃。`Phase` 型 / `ErrorDetails` から `'CLIENT_TIMEOUT'` を除去。
- 90 秒経過を表す state を追加 (`submitting` と直交する `longRunning` boolean 等)。spinner は `submitting` 中ずっと表示。
- 既存離脱ガード useEffect (`beforeunload` / `popstate`) の発火条件を `isSubmitting && !longRunning` 化 → 90 秒経過で解除。
- submitting banner: 90 秒未満は現行「閉じたり戻ったりしないでください」、90 秒以降は「AI が問題を抽出しています。通常より時間がかかっています。このまま閉じても、後で『試験一覧』から抽出結果を確認できます」主旨へ切替。
- `runProcess` に try-catch を追加。`processUpload` が throw (504 / network) したら `phase=error`、文言は「処理状況を確認できませんでした。『試験一覧』で結果をご確認ください」主旨。
- server 成功時の `router.push('/app/upload/result/...')` は維持。

**完了条件:** `pnpm build` green / `pnpm test` 既存 green。モバイル実機で 4 挙動確認 — 90 秒で案内 banner 出現 / spinner 継続 / back・タブ閉じの confirm が 90 秒後に出ない / 成功時 result page 遷移。review Critical 0 + `[reviewed]`。

- [ ] timeout→error 撤廃 + `longRunning` state + ガード条件 + banner 切替 + try-catch を実装
- [ ] `pnpm build` / `pnpm test` 確認、モバイル実機で 4 挙動確認
- [ ] requesting-code-review → Critical 0
- [ ] commit `fix(upload): OCR long-running 対応 (client timeout 撤廃 + 90 秒案内 banner) [reviewed]`

---

### Task 2: result page の「破棄して再アップロード」 button 廃止

**Files:** Modify `result-actions.tsx` / `result/[sourceDocumentId]/page.tsx`

**目的:** result page の破棄 button + amber 注意 banner + 関連 state/handler を削除し、「保存して試験一覧へ」 Link 1 本のみ残す。

**制約:**
- `result-actions.tsx` から `discardUpload` import / `handleDiscard` / `errorMsg` state / `useTransition` / `useRouter` / `Loader2` import / amber 注意 banner / 破棄 button を削除。
- 残るのは `<Link href="/app/exams">保存して試験一覧へ</Link>` のみ → `'use client'` も不要化して純表示 component にする。
- 未使用化する `sourceDocumentId` prop を `ResultActions` から除去、`page.tsx` の呼び出しも合わせて整理。
- `discard.ts` 本体はこのタスクでは削除しない (T5 で delete-exam へ転用)。

**完了条件:** `pnpm build` green。result page に「保存して試験一覧へ」 1 本のみ表示。review Critical 0 + `[reviewed]`。

- [ ] result-actions.tsx を Link 1 本に縮約、page.tsx の props 整理
- [ ] `pnpm build` / モバイルビュー確認
- [ ] requesting-code-review → Critical 0
- [ ] commit `fix(upload): result page の「破棄して再アップロード」 button 廃止 [reviewed]`

---

### Task 3: source-doc status helper 作成

**Files:** Create `lib/exams/source-doc-status.ts` / `lib/exams/source-doc-status.test.ts`

**目的:** 試験一覧用に (a) exam→status Map を返す関数、(b) 15 分越え processing を failed 化する関数を提供。

**制約:**
- 定数 `STALE_PROCESSING_MS = 15 * 60 * 1000` (= maxDuration 600s × 1.5) を本 file に定義。
- 純関数 `deriveExamStatuses(rows, now)`: source_doc 行 (`examId` / `status` / `createdAt`) を受け、exam ごとに `createdAt` 最新行を判定。最新が `completed` → entry 無し、`failed` → `'failed'`、`processing` かつ `createdAt < now - STALE_PROCESSING_MS` → `'failed'` (C4 fallback)、それ以外の `processing` → `'processing'`。戻り値 `Map<examId, 'processing'|'failed'>`。
- `getExamStatusMap(userId, now?)`: 当該 user の source_documents を `(examId, status, createdAt)` 射影で全件取得 (owner-scoped) し `deriveExamStatuses` に委譲。**status filter はかけない** (最新が completed のケースを正しく判定するため、調査回答 B)。
- `reconcileStaleProcessing(userId, now?)`: best-effort。1 transaction で `source_documents` の `status='processing' AND created_at < now - STALE_PROCESSING_MS` を `status='failed'` + `error_message`「処理時間の上限を超えたため中断されました」へ UPDATE し、`RETURNING` で得た行ぶんだけ `upload_records` に `status='failed'` 行を append (二重計上回避のため RETURNING 駆動、S1.9.1 台帳経路と整合)。例外は throw せず `logger.warn` のみ。

**完了条件:** `pnpm build` green。`source-doc-status.test.ts` で `deriveExamStatuses` の 4 分岐 (completed 無視 / failed / processing / 15 分越え processing→failed / 同一 exam で最新優先) が green。review Critical 0。

- [ ] `deriveExamStatuses` の failing test を書く → 実装 → green
- [ ] `getExamStatusMap` / `reconcileStaleProcessing` を実装
- [ ] `pnpm build` / `pnpm test` 確認 (commit は T4 とまとめる)

---

### Task 4: 試験一覧に cleanup 実行 + status tag 描画

**Files:** Modify `app/(app)/app/exams/page.tsx`

**目的:** 試験一覧 render 時に stale cleanup を実行し、各 exam 行に processing/failed tag を表示する。

**制約:**
- page は `getCurrentUser` で既に dynamic (auth-gated) のため、render 時の best-effort 書き込みは許容。`reconcileStaleProcessing(user.id)` を **`getActiveExamsWithCardCount` 取得より前** に await (cleanup → fetch の順序維持)。
- `getExamStatusMap(user.id)` を取得し、exam 一覧結果に `examId` で merge。
- 各 exam 行に inline `<span>` badge: `processing` =「処理中」、`failed` =「失敗」、Map に無し (completed) = badge 無し。色は既存 UI と調和 (processing = slate/amber 系、failed = red 系)、紫グラデ等禁止。
- 既存 `getActiveExamsWithCardCount` / `lib/exams/list.ts` は変更しない。

**完了条件:** `pnpm build` green。processing/failed の source_doc を持つ exam に対応 badge 表示、completed のみの exam は無 badge。15 分越え processing が failed 表示かつ DB 上も failed 化される。モバイルビュー確認。review Critical 0 + `[reviewed]`。

- [ ] exams/page.tsx に reconcile 呼び出し + status map merge + badge 描画を実装
- [ ] `pnpm build` / モバイルビュー / cleanup 経路を確認
- [ ] requesting-code-review → Critical 0
- [ ] commit `feat(exams): 試験一覧に processing/failed status 表示 + 15 分越え cleanup [reviewed]`

---

### Task 5: discard.ts を exam 削除 action へ転用

**Files:** Create `app/(app)/app/exams/_actions/delete-exam.ts` / `delete-exam.test.ts`。Delete `app/(app)/app/upload/_actions/discard.ts` / `discard.test.ts`

**目的:** discard.ts の exam cascade 削除 logic を `deleteExam(examId)` server action に転用する。

**制約:**
- `deleteExam(examId)`: `getCurrentUser` 認証 → `DELETE FROM exams WHERE id = ? AND user_id = ?` (owner-scoped 単一文)。cards / source_documents / reviews は FK CASCADE で連動削除 (discard.ts の `mode='new'` 分岐と同一挙動)。
- `finally` で `revalidatePath('/app/exams')` + `revalidatePath('/app/upload')` (upload の投入先 dropdown も exam 一覧依存)。
- 不在 / 他 user の examId は silent success (idempotent、discard.ts 踏襲)。戻り値は既存 `ActionResult`。
- discard.ts の `mode='existing'` 分岐 (exam を残し cards/source_documents のみ削除) は exam 削除では不要なため転用時に drop。
- `discard.ts` / `discard.test.ts` を削除 (T2 で唯一の呼び出し元 = result-actions は除去済)。
- `delete-exam.test.ts` は discard.test.ts の `getDb` mock パターンを踏襲し、owner 分離 / idempotent silent success / cascade 委譲を検証。

**完了条件:** `pnpm build` green。`delete-exam.test.ts` green。`grep -rn discardUpload app lib` が 0 件 (コメント含め参照ゼロ)。review Critical 0。

- [ ] delete-exam.ts を実装、delete-exam.test.ts を書いて green
- [ ] discard.ts / discard.test.ts を削除、`pnpm build` / `pnpm test` 確認 (commit は T6 とまとめる)

---

### Task 6: exam 削除 UI 統合

**Files:** Create `app/(app)/app/exams/_components/delete-exam-button.tsx`。Modify `app/(app)/app/exams/page.tsx`

**目的:** 試験一覧の各 exam 行に削除 button を追加し、`deleteExam` を呼ぶ。

**制約:**
- `delete-exam-button.tsx`: `'use client'`。`settings/delete-button.tsx` の inline confirm phase パターンを踏襲 (idle→confirm→deleting)。confirm phase で「この試験と含まれる cards / 学習履歴も削除され、元に戻せない」旨を red 系で明示。
- **Clerk reverification は使わない** — exam 削除は自前 DB の server action のみで Clerk sensitive call を含まないため (account 削除との違い)。
- `deleteExam` 呼び出しは `useTransition` で wrap、完了後 `router.refresh()` で一覧を再描画。
- exams/page.tsx: 各 exam 行に `<DeleteExamButton examId={exam.id} />` を「詳細を見る」近傍に併置 (outline / 小サイズ、red 系)。
- 削除確認の文言・配色は `settings/delete-button.tsx` と世界観統一。

**完了条件:** `pnpm build` green。一覧から exam 削除 → 当該 exam とその cards / source_documents / reviews が消え、一覧から除去される。モバイル実機確認。review Critical 0 → **tag 無しで commit → OT 実機確認 → `git commit --amend` で `[reviewed]` 追記** (削除を伴う変更)。

- [ ] delete-exam-button.tsx を実装、exams/page.tsx に配置
- [ ] `pnpm build` / `pnpm test` / モバイル実機で削除フロー確認
- [ ] requesting-code-review → Critical 0
- [ ] commit `feat(exams): exam 削除 UI 前倒し (S2 から先取り)` (tag 無し) → OT 実機確認 → `--amend` で `[reviewed]`

---

## 実装順序と commit

T1 → T2 → T3 → T4 → T5 → T6 (逐次)。commit は計 4 本: T1 / T2 / (T3+T4) / (T5+T6)。各 commit 時点で build green を維持。T6 のみ OT 実機確認を挟んで `[reviewed]` を後付け。
