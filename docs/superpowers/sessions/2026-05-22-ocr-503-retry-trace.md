# OCR 503 (transient error) retry 挙動 trace

調査日: 2026-05-22 / 種別: 調査のみ (コード編集ゼロ)
対象: `lib/ai/ocr.ts` / `lib/ai/clients/gemini.ts` /
`app/(app)/app/upload/_actions/process.ts` / `lib/ai-usage-counter.ts` /
`lib/ai-usage-mcq.ts` / `CLAUDE.md`

---

## 結論 (先出し)

- 503 は `isTransientError` で transient 扱いされ、`callWithRetry` が
  **モデルごとに最大 3 attempts** (初回 + retry 2) を exponential backoff
  (500 / 1000 ms 待機) で実行する。
- Flash で 503 を出し切ると Pro へ fallback し、Pro 側でも独立に同じ retry が
  走る。**最悪ケースで Gemini API は計 6 回**呼ばれる。
- **429 と 503 は同一視されている** (同じ正規表現 `\b(429|500|502|503|504)\b`
  で transient 判定)。CLAUDE.md「429 受信時は即時停止、リトライ禁止」と
  **抵触する** — 429 でも最大 6 回 retry される。
- Gemini call に **30 秒 timeout が設定されていない** (SDK / 自前いずれも無し)。
  CLAUDE.md「タイムアウト必須 30 秒」と**抵触**。
- backoff の最大回数 (per model 2 回) は CLAUDE.md「指数バックオフ最大 3 回」の
  範囲内だが、Flash + Pro 合算では計 4 回 backoff・計 6 call になる。
- 全 attempt が ai_usage counter を 1 回ずつ消費する。最悪 6 quota 消費。

---

## 1. transient error 判定 (`isTransientError`)

`lib/ai/ocr.ts:72-80`

```
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /\b(429|500|502|503|504)\b/.test(msg) ||
    /rate ?limit/i.test(msg) ||
    /timeout/i.test(msg) ||
    /unavailable/i.test(msg)
  )
}
```

判定対象 (いずれか 1 つでも match で transient = retry 対象):

| カテゴリ | パターン | 備考 |
|---|---|---|
| status code | `\b(429\|500\|502\|503\|504)\b` 単語境界マッチ | 503 含む。**429 も含む** |
| 文字列 | `/rate ?limit/i` | "rate limit" / "ratelimit" |
| 文字列 | `/timeout/i` | |
| 文字列 | `/unavailable/i` | 503 の SDK message にしばしば含まれる |

- 判定は err.message **文字列マッチ** (status code を instance property から
  読まない — `ocr.ts:71` コメントが「SDK error の status code は文字列に
  含まれる前提」と明記)。
- 503 は status code パターンと `unavailable` パターンの両方に該当し得る。

## 2. retry 回数と backoff (`callWithRetry`)

`lib/ai/ocr.ts:68`, `82-112`

| 項目 | 値 | 参照 |
|---|---|---|
| `MAX_HTTP_RETRIES` | `2` | `ocr.ts:68` |
| attempts / model | 初回 + 2 retry = **計 3** | `ocr.ts:90` ループ `attempt <= 2` |
| backoff 待機 | `500 * 2^attempt` ms | `ocr.ts:107` |
| 実際の待機列 | attempt0 失敗後 500ms / attempt1 失敗後 1000ms | attempt2 (最終) は待機せず throw |

- backoff コメントは `500 / 1000 / 2000` と書くが (`ocr.ts:107`)、
  実際には attempt2 が最終 attempt なので `2000ms` 待機は**発生しない**
  (`ocr.ts:106` で `attempt === MAX_HTTP_RETRIES` のとき即 throw)。
  実待機は 500ms と 1000ms の 2 回。
- 1 model あたり最大 **3 call**。

## 3. Flash → Pro fallback との関係

`lib/ai/ocr.ts:148-192`

挙動:

1. Step 1: `callWithRetry('flash', ...)` — Flash で最大 3 call。
2. Flash が transient error を出し切る (3 回とも 503) → `callWithRetry` が
   throw → `ocr.ts:159` の catch に入る → `flashError` に記録。
3. Step 2: `callWithRetry('pro', ...)` — **Pro 側で独立に最大 3 call**
   (`ocr.ts:166`)。Pro の retry counter は Flash と無関係に 0 から再カウント。
4. Pro も throw → `ocr.ts:169` で
   `OCR pipeline failed (Flash: ...; Pro: ...)` を throw。

最悪ケース call 数:

| model | call 数 |
|---|---|
| Flash | 3 (初回 + retry 2) |
| Pro | 3 (初回 + retry 2) |
| **合計** | **6** |

- fallback は「Flash の全 retry を尽くした後」に Pro へ移る (Flash retry 中に
  Pro へは移らない)。
- 注意: fallback トリガーは transient error だけでなく JSON parse 失敗 /
  `cards.length === 0` でも起きる (`ocr.ts:157-158`)。本 trace の主眼は 503 だが、
  503 経由でも parse 失敗経由でも Pro 側 retry は同じく独立に走る。

## 4. retry 全失敗時の挙動

### pipeline 側 throw する error message

`lib/ai/ocr.ts:169-171`

```
throw new Error(`OCR pipeline failed (Flash: ${flashError}; Pro: ${proMsg})`)
```

- Flash・Pro 両方の最終エラー message を 1 文字列に連結して throw。

### `processUpload` 側の扱い

`app/(app)/app/upload/_actions/process.ts:417-461`

| 処理 | 内容 | 参照 |
|---|---|---|
| status 更新 | `markFailed` で `source_documents.status='failed'`、`error_message` に message を 500 字 truncate して保存 | `process.ts:430`, `607` |
| upload_records | 同 transaction で `status='failed'` 行を append (quota SUM は completed のみ対象なので消費計上されない) | `process.ts:609-616` |
| notifyOps | `'ocr pipeline failed'` を Discord 通知 (userId / sourceDocumentId / examId / error 等) | `process.ts:437-447` |
| logger | `logger.error({ event: 'ocr.pipeline.failed', ... })` | `process.ts:448` |
| 戻り値 code | `GEMINI_FAILED` | `process.ts:451` |
| UI 表示文言 | `'混み合っているようです、 少し時間をおいてからお試しください'` | `process.ts:452` |
| details.rawError | throw された message 文字列 (開発環境のみ UI 表示、本番は非表示) | `process.ts:454-455` |

- `details` に `costYen` / `modelChain` は**入らない** (pipeline が throw する前に
  tokenUsage を tracking できていないため — `process.ts:456-458` コメント明記)。

## 5. CLAUDE.md AI 絶対ルールとの整合

CLAUDE.md「AI API 呼び出しの絶対ルール」該当条文:

> 5. **429 エラー受信時は即時停止、リトライ禁止**
> 6. タイムアウト必須（30 秒）、その他エラーは指数バックオフ最大 3 回

| ルール | 実装 | 整合 |
|---|---|---|
| 429 即時停止・リトライ禁止 | `isTransientError` が `\b(429\|...)\b` で 429 を transient 扱い。429 でも最大 6 回 retry | **抵触** |
| timeout 必須 30 秒 | Gemini call に timeout 設定なし (§6 参照) | **抵触** |
| 指数バックオフ最大 3 回 | per model 2 回 backoff (= retry 2 回)。Flash+Pro 合算で 4 回 backoff / 6 call | per model では範囲内。合算解釈なら超過 (論点) |

### 429 と 503 の扱い (重点)

- **429 と 503 は分離されていない**。`isTransientError` の単一正規表現
  `\b(429|500|502|503|504)\b` が両者を同じ「transient」 カテゴリに入れる
  (`ocr.ts:75`)。
- このため 429 (rate limit / quota 超過) を受信しても、503 と全く同じく
  `callWithRetry` が最大 3 回 retry し、Flash→Pro fallback も走る
  (= 最悪 6 call)。
- CLAUDE.md ルール 5「429 受信時は即時停止、リトライ禁止」は守られていない。
  実装上 429 専用の早期 throw 分岐は**存在しない**。
- (補足) `process.ts` 側に `GEMINI_DAILY_LIMIT` guard はあるが、これは
  「呼び出し前」のサービス全体カウント上限であり、API から返ってきた
  429 レスポンスに対する停止ではない (別レイヤ)。

## 6. timeout 設定

- `lib/ai/clients/gemini.ts:18` — `new GoogleGenAI({ apiKey })`。
  `httpOptions` / `timeout` を渡していない。
- `callGemini` 内 `ai.models.generateContent(...)` (`gemini.ts:57-66`) に
  `abortSignal` / timeout 指定なし。
- `callWithRetry` (`ocr.ts:82-112`) にも timeout ラップなし。
- `lib/ai/` 全体を grep しても `timeout` は backoff の `setTimeout` と
  `isTransientError` 内の文字列パターンのみ。**実 call timeout は未設定**。
- 結果: Gemini 応答が遅延し続けた場合、SDK / fetch のデフォルト挙動に依存。
  30 秒で能動的に切る仕組みはコード上に無い。
  `isTransientError` は `/timeout/i` を retry 対象に含むが、これは「timeout
  という文字列を含むエラーが返ってきた後」の判定であり、能動的な打ち切りでは
  ない。

## 7. onAttempt callback / counter 加算

`lib/ai/ocr.ts:91-101`, `process.ts:419-426`, `lib/ai-usage-counter.ts`

- `callWithRetry` は retry ループの**内側**で、`callGemini` 呼び出しの直前に
  毎回 `onAttempt(model)` を発火 (`ocr.ts:95-101`)。成功・失敗・retry すべての
  attempt で 1 回ずつ発火する。
- `processUpload` の `onAttempt` は `incrementAiUsage(user.id, 1)` を呼ぶ
  (`process.ts:423-425`)。
- `incrementAiUsage` は `ai_usage` (グローバル日次) と `ai_usage_users`
  (ユーザー別日次) を 1 transaction で `count + 1` UPSERT
  (`ai-usage-counter.ts:28-44`)。
- callback が throw しても `try/catch` で握りつぶし、OCR 本処理は止めない
  (`ocr.ts:96-100`、ベストエフォート計上)。

503 retry の quota 消費:

| シナリオ | onAttempt 発火回数 = ai_usage 加算 |
|---|---|
| Flash 1 発成功 | 1 |
| Flash 503 ×3 → Pro 1 発成功 | 3 + 1 = 4 |
| Flash 503 ×3 → Pro 503 ×3 (全失敗) | 3 + 3 = **6** |

- つまり 1 回の upload が、503 retry を経由すると `GEMINI_DAILY_LIMIT`
  カウントを最大 6 消費する。retry / fallback も等しく 1 quota として計上される
  (`ai-usage-counter.ts:12` コメント「成功・失敗・retry すべて 1 回ずつ計上」)。

---

## OT 判断用まとめ (再調整の検討材料 — 事実と論点のみ)

1. **429 と 503 の同一視**: `isTransientError` 単一正規表現が両者を transient
   扱い。CLAUDE.md ルール 5「429 即時停止・リトライ禁止」と抵触。429 でも
   最悪 6 call retry される。論点: 429 を transient 集合から外すか否か。
2. **timeout 未設定**: Gemini call に 30 秒 timeout が一切無い。CLAUDE.md
   ルール 6「タイムアウト必須 30 秒」と抵触。論点: SDK `httpOptions.timeout` /
   `AbortController` のどちらで入れるか、適用箇所 (callGemini 単位 か
   pipeline 全体 か)。
3. **最悪 call 数 6**: Flash 3 + Pro 3。retry / fallback が掛け算で効く。
   論点: per-model retry 回数 (`MAX_HTTP_RETRIES`) と fallback の両立で、
   503 のような「サービス全体が一時的に落ちている」ケースに 6 回叩く価値が
   あるか。
4. **backoff 回数の解釈揺れ**: per model は retry 2 回でルール「最大 3 回」内。
   ただし Flash+Pro 合算では 4 回 backoff・6 call。「最大 3 回」を pipeline
   全体で読むかモデル単位で読むかが未定義。
5. **backoff コメントと実挙動の乖離**: `ocr.ts:107` コメントは
   `500 / 1000 / 2000` だが最終 attempt は待機せず実待機は 500ms + 1000ms。
   挙動上の害は無いが、コメントが誤誘導 (記録のみ)。
6. **quota 消費**: 503 retry は `GEMINI_DAILY_LIMIT` を最大 6 消費。
   無料枠運用前提 (CLAUDE.md ルール 1) を踏まえ、retry が日次上限を早く
   食い潰すリスク。論点: retry 分を quota にカウントすべきか
   (現状は「全 attempt = 1 count」)。
7. **失敗時 details の欠落**: pipeline throw 時 `costYen` / `modelChain` が
   `process.ts` の details に乗らない。retry で実際に発生した cost が
   台帳 (`ocr_cost_yen`) に 0 で記録される (`process.ts:434` で
   `ocrCostYen: 0`)。論点: retry 中に発生した部分 cost をどう扱うか。
