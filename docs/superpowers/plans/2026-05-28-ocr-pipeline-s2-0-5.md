# OCR pipeline 改修 (S2.0.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** production で OCR upload が 30s timeout で fail する問題を、 Flash only pipeline + per-attempt 220s + overall 720s deadline + 40 page 制限で解消する。

**Architecture:** `lib/ai/clients/gemini.ts` の per-attempt timeout を拡張、 `lib/ai/ocr.ts` を Flash only 化 + backoff 延長 + overall deadline、 `process.ts` / upload page で maxDuration + deadline message + 40 page server enforce、 `upload-form.tsx` で 40 page client enforce。 CLAUDE.md ルール 6 を抽象化し具体値を docs へ移動。

**Tech Stack:** Next.js 15 App Router / TypeScript strict / @google/genai SDK / Drizzle / Vitest / Vercel (maxDuration 800s 設定済)

**spec 源**: OT kickoff brief (spec 確定済、 brainstorming skip 承認)。 現行調査は session 内で実施済。

---

## 全体ルール (各 task 共通、 冒頭一度)

- **TDD 厳守**: 失敗 test (赤) → 最小実装 (緑) → commit。 test code は generator が書く (本 plan にコード片を載せない = CLAUDE.md「Plan の書き方」 規律)
- **絶対ルール**: CLAUDE.md AI ルール 5 (429 即時停止・retry 禁止) を維持。 test では実 Gemini API 禁止・mock 必須 (`vi.mock('@/lib/ai/clients/gemini')`)。 無限ループで叩くコード禁止
- **確定事項 (議論不要)**: Vercel maxDuration 800s は OT 設定済 / schema・JSON parse retry 不採用 / Pro 単価 (cost.ts) 残置 / 連打防御の追加実装は scope 外 / 40 page は暫定固定値
- **命名**: 定数 UPPER_SNAKE / 関数 camelCase。 コメントは「なぜ」 のみ、 plan-local task 番号をコメントに残さない
- **中間 commit**: 各 task は `wip(ocr-s205):` prefix (= feat/fix でないので Stop hook 非対象)。 最終 Task 10 で `reset --soft` 集約 → 単一 `fix(ocr)` commit + canonical review + [reviewed]
- 各 task 完了条件の最低線: 該当 test 緑 + 全 suite regression なし + Critical 0

---

### Task 1: gemini.ts per-attempt timeout 220s + Retry-After 取得

**Files:** Modify `lib/ai/clients/gemini.ts` / Test `lib/ai/clients/gemini.test.ts` (無ければ新規)

- **目的**: 1 回の Gemini call の timeout を 30s → **220s** に拡張し、 SDK error から Retry-After を取得できるか調査して取得 helper を用意する。
- **制約**: `GEMINI_TIMEOUT_MS` を 220_000 に。 AbortController 方式維持、 timeout error message は `lib/ai/ocr.ts` の `isTransientError` の `/timeout/i` にマッチする文言を維持。 Retry-After: @google/genai の error object 構造 (ApiError 等) を調査し、 header / retryDelay を取り出す helper `parseRetryAfterMs(err): number | null` を export。 **取得不可と判明したら helper は常に null を返す実装で確定** (brief: 不可なら static のみで OK)。
- **完了条件**: timeout 値が 220s である test + `parseRetryAfterMs` の unit test (取得可: 値、 不可/欠落: null) + 既存 gemini 関連 test regression なし。

---

### Task 2: ocr.ts Pro fallback 撤去 (Flash only)

**Files:** Modify `lib/ai/ocr.ts` / Test `lib/ai/ocr.test.ts`

- **目的**: `runOcrPipeline` を Flash only に簡素化し、 Pro fallback 経路を削除する。
- **制約**: Flash 失敗 (HTTP / parse / 0 cards / 429) は即 throw (Pro へ移らない)。 `modelChain` は `['flash']` 固定。 `cost.ts` の pro 単価定義は **触らない** (dead code 残置)。 `isRateLimitError` の即停止維持。 error message は user 向けでなく診断用 (process.ts 側が user 文言に変換)。
- **完了条件**: 既存「Flash 0 cards → Pro fallback」「Flash JSON parse fail → Pro fallback」「Flash + Pro both fail」 の 3 test を「Flash 失敗で即 throw (Pro 呼ばない)」 に反転 + Flash only happy path + 429 即停止 test 維持 + Pro が一度も callGemini されない assertion。

---

### Task 3: ocr.ts backoff 延長 + retry 対象拡張 + Retry-After 優先

**Files:** Modify `lib/ai/ocr.ts` / Test `lib/ai/ocr.test.ts`

- **目的**: `callWithRetry` の backoff を現行 500ms/1000ms → **5s+jitter(0-2s) / 20s+jitter(0-5s)** の 2 段階に延長し、 retry 対象に network error を加え、 Retry-After があれば static より優先する。
- **制約**: `MAX_HTTP_RETRIES=2` 維持 (= 3 attempts)。 `isTransientError` を 5xx (500/502/503/504) + timeout + network error (例: ECONNRESET / ENOTFOUND / fetch failed) に拡張。 backoff は attempt 0→5s+rand(0-2s)、 attempt 1→20s+rand(0-5s)。 `parseRetryAfterMs` (Task 1) が非 null ならその値を優先。 jitter は test 可能なよう乱数注入できる形に (= Math.random 直書きを避け、 seed/injector か固定可能に)。 429 即停止維持。
- **完了条件**: backoff 2 段階の test (fake timer + 乱数固定で待機時間検証) + network error が retry 対象になる test + Retry-After 優先の test + 既存 transient 503 retry test を新 backoff に調整。

---

### Task 4: ocr.ts overall job deadline 720s

**Files:** Modify `lib/ai/ocr.ts` / Test `lib/ai/ocr.test.ts`

- **目的**: `runOcrPipeline` 全体を **720s** で自前停止し、 後処理用に 80s (800-720) を確保する。
- **制約**: pipeline 本体を `Promise.race([pipeline, deadlineTimer])` で wrap。 deadline timer は `setTimeout` で 720_000ms 後に **識別可能な専用 error** (= 専用 message marker か custom Error subclass、 process.ts が分岐できるもの) を reject。 正常完了時は timer を必ず clear (leak 防止)。 deadline 定数 `OCR_OVERALL_DEADLINE_MS = 720_000`。
- **完了条件**: 720s 超過で deadline error が throw される test (fake timer) + 正常完了で deadline timer が clear される test + deadline error が他 error と識別可能であることの test。

---

### Task 5: process.ts maxDuration + deadline user-friendly markFailed

**Files:** Modify `app/(app)/app/upload/page.tsx` (maxDuration) + `app/(app)/app/upload/_actions/process.ts` (markFailed message) / Test `process.test.ts`

- **目的**: Server Action の実行時間上限を宣言し、 overall deadline 起因の失敗時に user-friendly な errorMessage を保存する。
- **制約**: `export const maxDuration = 800` を **upload page.tsx** に置く (Context7 確認済: Server Actions の maxDuration は page level の route segment config に従う)。 process.ts の OCR pipeline catch で、 Task 4 の deadline error を識別したら markFailed の errorMessage と GEMINI_FAILED の user 文言を「処理時間が長すぎました、 ページ数を減らして再 upload してください」 に分岐。 deadline 以外の通常失敗は既存文言維持。 markFailed の errorMessage は既存 `slice(0,500)` 維持。
- **完了条件**: deadline error → user-friendly message が markFailed / 戻り値に乗る test + 通常 GEMINI_FAILED は既存文言維持の test + maxDuration export の存在確認。

---

### Task 6: 40 page 制限 (server enforce)

**Files:** Modify `app/(app)/app/upload/_actions/process.ts` / (定数 file 新規 or 既存) / Test `process.test.ts`

- **目的**: 1 回の upload の合算 totalPages 上限 40 を server で enforce する。
- **制約**: `OCR_MAX_PAGES = 40` 定数を client/server 共有できる場所に置く (例: `lib/ai/ocr-limits.ts` 新規、 もしくは既存 shared 定数 file)。 plan-limits (`canRunOcr`) とは **独立 check** = guard tx の totalPages 算出後・`canRunOcr` とは別に `totalPages > OCR_MAX_PAGES` を弾く (両方適用 = 実質 min(plan limit, 40))。 専用 error code `PAGE_LIMIT_EXCEEDED` を `ProcessUploadErrorCode` に追加、 user 文言「1 回のアップロードは合計 40 ページまでです」。 exam / source_documents INSERT 前に early return (plan-limits 超過と同じ早期 return パターン)。
- **完了条件**: totalPages=41 で `PAGE_LIMIT_EXCEEDED` early return + DB 書き込みなし の test + 40 page 以内は通過の test + plan-limits と独立動作の確認。

---

### Task 7: 40 page 制限 (client enforce + UI 文言)

**Files:** Modify `app/(app)/app/upload/_components/upload-form.tsx` / Test (該当 component test)

- **目的**: client 側で 40 page 超過時に submit を抑止し、 user に事前明示する。
- **制約**: Task 6 の `OCR_MAX_PAGES` 定数を共有。 既存 `submitDisabled` 集約 (`anyProcessing || anyError || totalExceeded || overQuota || alreadyAtQuota`) に `totalRequestedPages > OCR_MAX_PAGES` を追加。 UI 文言「合計 40 ページまでアップロード可能です」 を事前 (file 選択前から or 超過時) に表示。 既存 plan-limits 残量 banner と併存 (どちらの上限に当たったか user が分かる表示)。
- **完了条件**: totalRequestedPages=41 で submit disabled + 文言表示の test + 40 以内は submit 可能の test。

---

### Task 8: 連打防御調査 (記録のみ、 実装なし)

**Files:** Create `docs/superpowers/sessions/2026-05-28-ocr-s205-rapid-click-investigation.md` (記録のみ)

- **目的**: 同 user 同ファイル連続 click の連打防御の既存実装を調査し、 十分性を記録する。
- **制約**: **実装変更なし** (scope 外、 別 sprint 化判断は OT)。 調査対象: client `submitDisabled` (submitting 中 disabled) + server 側 advisory xact lock + in-flight 行 check (process.ts guard tx)。 既存で十分か / 不足 (例: 同一 file 二重 click の最初の 1 発が走る前の窓) を記録。
- **完了条件**: session log に「既存防御の構成 + 十分性判定 + (不足あれば) 別 sprint 候補」 を記録、 コード変更ゼロ。

---

### Task 9: CLAUDE.md ルール 6 抽象化 + 具体値を docs へ移動

**Files:** Modify `CLAUDE.md` + `docs/02-tech-spec.md`

- **目的**: CLAUDE.md ルール 6 を原則のみに抽象化し、 具体値を設計 doc に移す。
- **制約**: CLAUDE.md ルール 6 (現行「timeout 30s 必須、 その他は指数バックオフ 最大 3 回」) を「外部 API call にはタイムアウトを必ず設定する」 程度の原則に。 具体値 (Flash 220s × 3 attempts + backoff 5s/20s + overall deadline 720s + Pro fallback 廃止 + Flash only + retry 対象 5xx/timeout/network・非対象 4xx/429/JSON/schema) を `docs/02-tech-spec.md` の新規「AI API 呼び出し仕様」 section に記述。 移動先が 02-tech-spec.md で不適切と判明したら OT 確認。 役割境界ルール (設計書は実装時に書き換えない) に留意し、 これは設計確定の記録として追記。
- **完了条件**: CLAUDE.md ルール 6 抽象化 + docs に具体値 section 追加 (= 実装ロジック変更なし、 docs commit)。

---

### Task 10: 総合確認 + canonical review + fix(ocr) [reviewed]

**Files:** (全 task 集約)

- **目的**: full suite + typecheck 後、 canonical review を通して単一 commit に集約する。
- **制約**: `pnpm test` 全 pass + `pnpm tsc --noEmit` clean を controller 確認。 wip commit 群を `reset --soft` で集約。 `requesting-code-review` skill canonical 経路 (general-purpose subagent / template 改変なし)。 commit は `fix(ocr):`。 **裏取り category 該当**: OCR は外部 API + 課金対象処理 → CLAUDE.md「重要 Fix の裏取り (外部副作用)」 に該当する可能性。 review pass → commit (tag 無し) → **OT 実機確認 (production-like で OCR 実走) → amend で [reviewed]** の手順を取る (= review pass だけで [reviewed] 付与しない)。 commit 直前に review ログ 4 点を chat 明示。
- **完了条件**: 全 suite pass + typecheck clean + Critical 0 + Important 0 (or OT 承認残置) + OT 実機確認後に [reviewed]。

---

## Self-Review (writing-plans checklist)

**1. Spec coverage**: OCR pipeline 改修 = Task 1 (timeout 220s + Retry-After) / Task 2 (Pro 撤去) / Task 3 (backoff + retry 対象) / Task 4 (overall deadline) / Task 5 (maxDuration + deadline message)。 連打防御調査 = Task 8。 CLAUDE.md 抽象化 + docs = Task 9。 40 page = Task 6 (server) + Task 7 (client)。 = brief scope 1-4 全カバー。

**2. Placeholder scan**: コード片は CLAUDE.md 規律により意図的に非記載。 各 task 3 要素を具体明示、 TBD/TODO なし。 Retry-After 取得可否・deadline error 識別方法は「調査 + fallback 確定方針」 として明示済 (= 実装時に確定する旨を制約に記載)。

**3. Type consistency**: `OCR_MAX_PAGES` (Task 6/7 共有) / `OCR_OVERALL_DEADLINE_MS` (Task 4) / `GEMINI_TIMEOUT_MS` (Task 1) / `parseRetryAfterMs` (Task 1→3) / `PAGE_LIMIT_EXCEEDED` (Task 6) / `MAX_HTTP_RETRIES` (Task 3、 既存維持) — 命名一貫。

**判断点記録 (claude.ai 確認不要と判断)**: (a) maxDuration 置き場 = upload page.tsx (Context7 確認済)。 (b) 40 page = plan-limits と独立 check (brief 通り)。 (c) docs 移動先 = 02-tech-spec.md 新 section (不適切なら OT 確認の余地を Task 9 制約に明記)。 (d) deadline error 識別 = custom marker/subclass (実装時確定)。

---

## 行数 / 実行モード

- 本 plan 行数は別途報告。 CLAUDE.md 上限 250 / STOP 300。
- execution mode は OT 指示待ち。 推奨 subagent-driven-development (task 単位 fresh subagent + 二段 review)。 Task 10 の裏取り (OT 実機確認) は subagent では完結せず OT 介在。
