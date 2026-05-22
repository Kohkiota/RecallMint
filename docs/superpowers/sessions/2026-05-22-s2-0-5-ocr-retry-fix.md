# S2.0.5 sprint log — OCR retry を AI 絶対ルール 5/6 に準拠

- 日付: 2026-05-22
- branch: `develop` (commit のみ、push は OT)
- commit: `c59bde9` (`fix(ai): S2.0.5 OCR retry を AI 絶対ルール 5/6 に準拠`)
- 事前調査: `docs/superpowers/sessions/2026-05-22-ocr-503-retry-trace.md`
- 本 log は `c59bde9` の **[reviewed] 相当の確定記録** (下記「tag の扱い」参照)

## 結論

CLAUDE.md「AI API 呼び出しの絶対ルール」抵触 2 件 — ルール 5 (429 受信時は
即時停止・リトライ禁止) / ルール 6 (タイムアウト必須 30 秒) — を修正。
formal review pass (Critical 0) + staging smoke で OCR 正常動作を確認済。

## 実装内容

| # | ルール | 内容 |
|---|---|---|
| 1 | ルール 6 (timeout 必須 30 秒) | `lib/ai/clients/gemini.ts` の `callGemini` に `AbortController` ベースの 30 秒 timeout (`GEMINI_TIMEOUT_MS = 30_000`) を追加。 SDK `GenerateContentConfig.abortSignal` で in-flight request を client 側から abort。 timeout 由来の abort error は message に "timeout" を含めて正規化し、 `isTransientError` の retry 経路に乗せる |
| 2 | ルール 5 (429 即時停止・リトライ禁止) | `lib/ai/ocr.ts` の `isTransientError` から 429 を分離。 新 `isRateLimitError` (429 / "rate limit" / RESOURCE_EXHAUSTED) を新設。 `callWithRetry` は 429 を retry せず即 throw、 `runOcrPipeline` は Flash 429 時に Pro fallback もスキップして即停止。 5xx (500/502/503/504) と timeout/unavailable は従来どおり指数バックオフ retry を維持 |

対象 file: `lib/ai/clients/gemini.ts` / `lib/ai/clients/gemini.test.ts` /
`lib/ai/ocr.ts` / `lib/ai/ocr.test.ts`。 全 444 test pass / `tsc` clean。

## review

`superpowers:requesting-code-review` skill canonical 経路 (skill template +
general-purpose subagent、 template 改変なし)。

**Critical 0 / Important 0 / Minor 4** (すべて記録のみ):

- backoff コメント注記の polish (`ocr.ts`)
- 「30 秒未満で応答」 test の `useFakeTimers` が装飾的 (`gemini.test.ts`)
- timeout 正規化の string-match coupling (`gemini.ts` ↔ `ocr.ts` を "timeout"
  という substring で結合)
- timeout→retry の cross-file test 不在

## smoke 確認 (OT 実機観察)

- **staging DB 環境で OCR upload が正常完走することを OT が確認 (2026-05-22)**。
- S2.0.5 は §重要 Fix の裏取り「外部副作用 (外部 API 呼び出し)」対象。
  review pass のみでは確定とせず、 本 smoke をもって動作確認完了とする。

## tag の扱い ([reviewed] 相当)

`c59bde9` は §裏取り 手順に従い `[reviewed]` tag 無しで commit した。 本来は
OT 実機観察後に `git commit --amend` で `[reviewed]` を追記する規定だが、
`c59bde9` は既に HEAD から複数 commit 前にあり amend に `git rebase` を要する
ため、 履歴改変を避けて amend は行わない。

代わりに本 session log + follow-up commit (`chore: S2.0.5 [reviewed]
confirmed`) を **`[reviewed]` 相当の確定記録**とする。

要約: `c59bde9` = formal review pass (Critical 0 / Important 0 / Minor 4) +
staging smoke 確認済 = **[reviewed] 相当**。
