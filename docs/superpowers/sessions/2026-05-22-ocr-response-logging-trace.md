# OCR debug — Gemini response の log 出力状況 trace

- 日付: 2026-05-22
- 種別: 調査のみ (trace、 実装変更 0、 報告のみ)
- 目的: 「staging で OCR response を log で見る」 経路が確立できるかの判定材料

## 結論 (先出し)

- **現状、 Gemini response (raw text) は production / staging / dev のいずれでも一切 log
  出力されていない**。 成功時は 0 行、 失敗時も parse error の要約のみで raw body は出ない。
- logger には **log level filter が存在しない** (`info`/`warn`/`error` 全て無条件 emit)。
  よって「log level を下げて見る」 ことは不可能 — **log line の新規追加が必須**。
- 最小コストは `lib/ai/clients/gemini.ts` に 1 行追加。 ただし log 行サイズ truncate と
  本番無効化 (env gate) を設計に含めるべき。

## 1. Gemini call 後の response log 状況

| file | log |
|---|---|
| `lib/ai/clients/gemini.ts` `callGemini` | **なし**。 `ai.models.generateContent` → `res.text` → `{text, inputTokens, outputTokens}` を return するだけ。 `console.*` も `logger` も呼ばない。 |
| `lib/ai/ocr.ts` `runOcrPipeline` / `callWithRetry` / `parseAndValidate` | **なし**。 `logger` を import すらしていない。 |

→ OCR の成功 path で Gemini response はどこにも出力されない。

## 2. logger module の log level 設定

`lib/logger.ts`:

- structured JSON logger。 `logger.{info|warn|error}` → `emit()` → `console.{log|warn|error}` + `JSON.stringify`。
- **log level filtering なし**。 `info` / `warn` / `error` はすべて無条件に emit される。
  production / staging / development で挙動差は **ない** (全環境で全 level が出る)。
- 出力 JSON に `environment` field (`VERCEL_ENV ?? NODE_ENV ?? 'unknown'`) は付くが、
  これは **メタデータであって filter には使われない**。
- **環境変数で log の出る/出ないを制御する仕組みは存在しない**。

## 3. zod parse 前後の log 状況

`lib/ai/ocr.ts` `parseAndValidate(text)`:

- 処理: `JSON.parse(text)` → `responseSchema.safeParse(parsed)`。
- **raw response (parse 前の `text`) は log されない**。
- parse 失敗時は `throw new Error(...)`:
  - `JSON.parse` 失敗 → `'JSON parse failed: <message>'`
  - zod 失敗 → `'response shape invalid at <first issue path>: <first issue message>'`
- → error message に含まれるのは parse error の要約のみ。 **raw response body は含まれず、
  `text` はそのまま捨てられる**。
- この throw は pipeline 上位 (`runOcrPipeline`) で
  `'OCR pipeline failed (Flash: ...; Pro: ...)'` に wrap され、 `process.ts` の
  `logger.error({ event: 'ocr.pipeline.failed', err })` 経由で出力される。

## 4. Vercel logs で実際に見えるもの (process.ts OCR 経路)

`logger.*` → `console.*` → Vercel Function Logs は全 `console.*` 出力を capture する。
OCR 経路 (`processUpload`) で出る log:

| 箇所 | level | 内容 |
|---|---|---|
| `process.ts:269` | warn | guard transaction の異常系 (parallel guard 等) |
| `process.ts:448` | error | `ocr.pipeline.failed` — **OCR 全失敗時のみ**。 `err` = 展開済 Error (name/message/stack)。 message は parse error 要約まで |
| `process.ts:623` | warn | `markFailed` の best-effort 失敗 |

→ **OCR 成功時は Gemini response 関連の log は 0 行**。 失敗時も error message
(parse 要約) のみで raw response body は出ない。 現状 Vercel logs から Gemini response
の raw text は **一切確認できない**。

## 5. debug log を追加する場合の影響範囲

- **log level を下げるだけでは見えない** — level filter 自体が無いため。 raw response を
  見るには log line の新規追加が必須。
- 最小の追加点 (1 箇所):
  - `lib/ai/clients/gemini.ts` の `callGemini` で `res.text` 取得直後に
    `logger.info({ event: 'ocr.gemini.response', model, text })` を 1 行。
    成功・失敗を問わず全 response が Vercel logs に出る。
  - あるいは `lib/ai/ocr.ts` `parseAndValidate` の parse 失敗時に raw `text` を
    含めて log / throw する (失敗時のみに絞れる)。
- 留意点:
  - logger は「throw しない」 契約で既存 pattern も多数 → 追加自体は安全。
  - **response text は大きい** (数百問 OCR で数十〜数百 KB)。 Vercel log は 1 行あたり
    サイズ上限があり長大行は truncate される → 全文はそのままでは切れる。 debug 用途なら
    先頭 N 千字に truncate する / sourceDocumentId 単位で出すなどの工夫が要る。
  - `gemini.ts` は現状 logger 非依存 (clients 層)。 logger import 追加で
    clients → logger 依存が増えるが、 logger は `@/lib/ops` 非依存のため循環は生じない。
  - 本番で常時 response 全文を出力するのは PII / log コスト面で非推奨。 debug 時のみ
    有効化する env gate (例 `OCR_DEBUG_LOG`) を噛ませる設計が妥当。 現状そうした gate は
    無いため新設になる。

## OT 判定用まとめ

- 「staging で OCR response を log で見る」 経路 = **log line の新規追加が必要**
  (log level 調整では実現不可)。
- 最小 1 行 (`gemini.ts`) で確立可能。 ただし (a) log 行 truncate 対策、
  (b) 本番無効化の env gate を修正設計に含めること。
- 修正は本 trace とは別 commit (本 doc は調査のみ)。
