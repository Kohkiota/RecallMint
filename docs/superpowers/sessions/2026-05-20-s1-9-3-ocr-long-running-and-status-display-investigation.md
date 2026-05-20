# S1.9.3 事前調査 — OCR 長時間対応 + 試験一覧の処理中表示 + cost monitoring 整理

- 日付: 2026-05-20
- 種別: 事前調査 (実装変更 0、 doc 1 file のみ)
- 目的: S1.9.3 sprint 設計のための現状 trace + 設計選択肢列挙
- **本 doc は修正方針を提示しない**。 各案の selection は後段で claude.ai + OT が決定する。
- 調査対象 commit: `93e6052` (S1.9 シリーズ完了)、 branch `develop`

---

## 0. エグゼクティブサマリ (期待発見ポイントへの回答)

| # | 確認事項 | 結論 |
|---|---|---|
| 1 | streaming 使用有無 | **non-streaming**。 `callGemini` は `ai.models.generateContent` (単発)。 切替判断不要。 |
| 2 | 実 cost 計算経路の有無 | **実 token ベース**。 `usageMetadata.promptTokenCount` / `candidatesTokenCount` から計算。 ただし単価表は hardcode、 `thoughtsTokenCount` 未参照 (§7)。 |
| 3 | 試験一覧の fetch query 構造 | `getActiveExamsWithCardCount` は `exams LEFT JOIN cards` のみ。 **`source_documents` を一切 join していない**。 status tag 表示には新規 join / 別 query が要る (§3)。 |
| 4 | 15 分越え cleanup の実装場所 | 既存 cleanup ロジックなし。 lazy / cron / next-trigger / 表示時 derive の 4 系統を §4 で列挙。 |
| 5 | Vercel cron 使用有無 | **未使用**。 `vercel.json` に `crons` key なし。 cron 採用は新規 route + 設定が要る。 |

**追加の重要発見 (claude.ai が pre-bake していない論点)**:

- **D1 (最重要)**: kickoff は「maxDuration を 600 秒に設定済」 とするが、 **code 上に該当宣言が存在しない**。 `vercel.json` の `functions` は webhook 2 件 (`maxDuration: 60`) のみ。 `/app/upload` route segment にも `process.ts` にも `export const maxDuration` なし。 §1.6 参照 — 本設計の大前提なので OT 確認必須。
- **D2**: 「失敗 exam は user が手動削除」 (kickoff 方針 6) の受け皿となる **exam 削除 UI が現状存在しない**。 `/app/exams` は read-only (「S2 で正式 CRUD」)。 §3.5 参照。
- **D3**: 「アプリ閉じて後で確認」 案内は、 upload-form の既存 `beforeunload` / `popstate` ガード (「戻ると抽出結果が失われる」 と confirm dialog 発火) と意味的に矛盾する。 §6.3 参照。
- **D4**: GEMINI_FAILED 時、 失敗前に 200 OK で課金された Flash call の cost が記録されず 0 になる (`tokenUsage` が throw で失われる)。 §7.3 参照。

---

## 1. 現状の OCR 経路 trace

### 1.1 `processUpload` server action 構造

`app/(app)/app/upload/_actions/process.ts`。 外側 `processUpload` (102) は `_processUpload` を呼び `finally` で `revalidatePath('/', 'layout')` (111)。 `_processUpload` (115) の処理順:

1. `getCurrentUser` 認証 (118)
2. formData parse: `mode` / `examId` / `files` (122-155)
3. 推定ページ数算出 — PDF は `pdfPageCount`、 画像は 1 page (159-171)
4. **plan-limits enforce** `canRunOcr` — NG なら exam / source_documents INSERT 前に return (176-188)
5. **GEMINI_DAILY_LIMIT guard** — `getTodayAiUsageGlobal` ≥ limit で return (197-218)
6. **exam 確定** — `mode='new'` は `exams` INSERT (仮 name 「アップロード YYYY-MM-DD HH:mm」)、 `mode='existing'` は所有者 + archived validate (222-261)
7. **source_documents INSERT** — `status='processing'`、 `mode` 列も set (263-283)
8. files → base64 変換 (286-313)。 失敗時 `markFailed(cost 0)` → return `OTHER`
9. **OCR pipeline** `runOcrPipeline` (315-359)。 失敗時 `markFailed(cost 0)` + `notifyOps` → return `GEMINI_FAILED`
10. **cards bulk INSERT** (361-414)。 失敗時 `markFailed(cost=実値)` + `notifyOps` → return `SAVE_FAILED`
11. **完了更新** — 1 transaction で `source_documents` UPDATE(`status='completed'`) + `upload_records` INSERT (416-439)
12. preview data 構築 → `{ ok: true, data }` return (441-466)

INSERT 順序: **exams → source_documents → (OCR) → cards → (transaction) source_documents UPDATE + upload_records**。 exam と source_documents は OCR 前に確定するため、 **OCR 失敗時も exam 行と source_documents(failed) 行は残る** (これが §3 の「処理中 / 失敗 exam を一覧表示」 の前提)。

### 1.2 `markFailed` 経路 (process.ts:488)

`source_documents` を `status='failed'` + `errorMessage` に UPDATE し、 同 transaction で `upload_records` に `status='failed'` 行を append。 best-effort (UPDATE 自体が失敗しても throw せず `logger.warn` のみ、 506-526)。 → **markFailed の UPDATE 失敗時、 source_documents は 'processing' のまま残骸化しうる** (§4 の cleanup 対象の一つ)。

呼び出し 3 箇所と cost 引数:
- base64 変換失敗 (297): `pagesProcessed: 0, ocrCostYen: 0`
- OCR pipeline 失敗 (328): `pagesProcessed: 0, ocrCostYen: 0`
- cards INSERT 失敗 (387): `pagesProcessed: totalPages, ocrCostYen: pipelineResult.costYen` (実値)

### 1.3 `runOcrPipeline` の Gemini call 方法 (`lib/ai/ocr.ts`)

- **streaming 不使用** — `lib/ai/clients/gemini.ts:56` `ai.models.generateContent` (単発)。 `generateContentStream` は未使用。 GPT 調査の「OCR で streaming 非推奨」 と現状一致、 切替不要。
- **Flash → Pro fallback** (ocr.ts:148-192): Step1 Flash → Step2 (Flash が HTTP error / JSON parse 失敗 / cards=0 のいずれか) Pro fallback。 Pro でも失敗 → throw。
- **retry loop** (`callWithRetry`, ocr.ts:82): 各 model で初回 + 最大 2 retry (`MAX_HTTP_RETRIES=2`)。 transient 判定は message string match (`429|500|502|503|504` / `rate limit` / `timeout` / `unavailable`)。 backoff 500/1000/2000ms。
- **`onAttempt` callback** (ocr.ts:95): 各 callGemini 直前で発火。 caller が `incrementAiUsage` を呼ぶ。 失敗は握りつぶし。
- 1 upload あたり Gemini call は最大 6 回 (Flash 3 + Pro 3)。

### 1.4 `usageMetadata` の取得経路と保存先

- `callGemini` (gemini.ts:68-73): `res.usageMetadata` から `promptTokenCount` → `inputTokens`、 `candidatesTokenCount` → `outputTokens`。 **`thoughtsTokenCount` / `totalTokenCount` は未参照**。
- `runOcrPipeline` (ocr.ts:194-197): `tokenUsage[]` (成功した callGemini の実 token) を per-model 集計し、 `estimateCostYen` で合算 → `costYen`。
- 保存先: `processUpload` 完了 transaction (process.ts:428, 436) で `source_documents.ocr_cost_yen` と `upload_records.ocr_cost_yen` の両方に `pipelineResult.costYen` を書く。

### 1.5 `estimateCostYen` の現状 (`lib/ai/cost.ts`)

- 引数 `(model: ModelKind, inputTokens, outputTokens)`、 戻り値 `number` (円)。
- **実 usageMetadata token から計算** (pages × 単価 の estimate ではない)。 「estimate」 の名は**単価表が概算 hardcode** であることを指す。
- 単価表 `PRICING_USD_PER_1M` (cost.ts:11): Flash `{input:0.3, output:2.5}` / Pro `{input:1.25, output:10.0}` USD/1M tokens。 `JPY_PER_USD = 150` も hardcode。
- S1.9.2 で `Math.round` の integer 丸めを廃止、 小数 4 桁で保持 (`Math.round(usd*150*10000)/10000`, cost.ts:35)。 DB 列は `numeric(10,4)` (schema.ts:350, 387)。

→ **source_documents / upload_records の `ocr_cost_yen` は「実 token 数 × hardcode 単価」**。 純粋な estimate でも完全な実 cost でもない中間 (token は実値、 単価は概算)。

### 1.6 maxDuration の現状 (D1)

- `vercel.json`: `functions` に `webhooks/clerk` と `webhooks/stripe` の `maxDuration: 60` のみ。 upload 系の記載なし。
- `app/(app)/app/upload/page.tsx` / `process.ts` / 配下 layout に `export const maxDuration` 宣言 **なし** (`grep` で app/lib 全域確認済)。
- `next.config.ts` にも該当設定なし。
- 関連する古いコメント不整合: `upload-form.tsx:388` 「Vercel function が 60 秒で kill」 / `constants.ts:2` 「Vercel Pro 関数 timeout (900s」 / `CLAUDE.md` 「Pro 昇格で Function timeout 900s 化」。

→ kickoff の「maxDuration 600 秒設定済」 は code に反映されていない。 Vercel dashboard 側の project 設定か、 反映漏れか、 未着手かは本 trace の範囲では確定不能。 **長時間 OCR 設計の大前提なので OT 確認必須**。 Server Action の duration は呼び出し元 route segment の `maxDuration` に従う点も併せて要確認。

---

## 2. 試験一覧 (`/app/exams`) の現状実装 trace

### 2.1 一覧 page (`app/(app)/app/exams/page.tsx`)

Server Component。 `getActiveExamsWithCardCount(user.id)` で取得し、 exam ごとに `name` / `カード {cardCount} 件` / `最終更新 {formatRelativeJa(updatedAt)}` / 「詳細を見る」 Link を表示。 0 件時は「アップロードから始める」 CTA。 編集 / 削除 / 並び替え UI **なし** (「S2 で正式 CRUD」)。

### 2.2 fetch query (`lib/exams/list.ts`)

`getActiveExamsWithCardCount` (list.ts:36): `exams LEFT JOIN cards ON cards.exam_id = exams.id`、 `WHERE user_id=? AND archived_at IS NULL`、 `GROUP BY exam`、 `ORDER BY updated_at DESC`。 **`source_documents` を join していない**。 戻り値は `{id, name, updatedAt, cardCount}` のみ。 status 系の情報は一切ない。

### 2.3 「処理中 / 完了 / 失敗」 状態の現在の読み取り経路

- `exams` table に `status` column は **存在しない** (schema.ts:208-229)。
- 状態の真実 source は `source_documents.status` (`'processing' | 'completed' | 'failed'`, schema.ts:341) のみ。
- 現状の一覧 UI はこれを一切読まない。 結果として **OCR 失敗で auto 作成された `mode='new'` exam は「カード 0 件」 の通常 exam として一覧に並ぶ** (失敗の手掛かりなし)。
- 利用可能な index: `source_docs_user_exam_idx` on `(user_id, exam_id)`、 `source_docs_status_idx` on `(user_id, status)` (schema.ts:361-364)。

### 2.4 mode='new' / 'existing' の区別経路

S1.9.2 で `source_documents.mode` (`'new' | 'existing'`, NOT NULL, schema.ts:332、 migration `0005`) 追加済。 exam 単位ではなく source_documents 単位の属性。 「この exam が OCR auto 作成か」 を判定するには「その exam の最初の source_documents.mode='new'」 を見る必要がある。 exams table 自体には auto/manual の区別フラグなし (現状そもそも手動 exam 作成 UI がないため、 全 exam が OCR 由来)。

### 2.5 個別 exam page (`app/(app)/app/exams/[id]/page.tsx`)

`getExamByIdForUser` で所有 + archived 確認 (なければ `notFound()`)、 `getCardsForExam` で cards 一覧。 header に exam 名 / 作成・更新日時 / archived バッジ。 cards は read-only リスト (`sortKey` / `title` / question 抜粋 / 選択肢数 / プロパティ key)。 0 件時は「アップロードから追加」 CTA。 status / 削除 UI なし。

---

## 3. processing / failed 表示の設計選択肢 (列挙のみ)

試験一覧で「処理中」「失敗」 tag を出す案。 **選定はしない**。

### R1 — exam 行ごとに source_documents の status を集計して app 側で tag 算出
別 query で exam の source_documents を取り、 app code で「最新 (created_at DESC) の status」 を tag に変換。
- trade-off: 既存 `getActiveExamsWithCardCount` を改変せず追加 query で済む。 N+1 を避けるには「user の全 exam 分を 1 query で取り Map 化」 が要る。

### R2 — `exams.status` 列を追加して直接管理
migration で `exams.status` 追加、 `processUpload` / `markFailed` で更新。
- trade-off: 一覧 query は単純なまま (列を 1 つ select するだけ)。 一方で **multi-source_documents exam の意味論が破綻しやすい**: `mode='existing'` で既存 exam に新規 OCR を足して失敗した場合、 exam 全体を 'failed' にするのか? 完了済 cards があるのに 'failed' 表示は誤り。 exam-level status と upload-level status の混同。 migration + 二重管理 (source_documents.status と整合維持) のコスト。

### R3 — 一覧 query 側で source_documents を join + 集計
`getActiveExamsWithCardCount` に `source_documents` の join / 相関サブクエリを足し、 SQL で status 集計列を出す。
- trade-off: 1 query で完結。 ただし既に `LEFT JOIN cards + GROUP BY` をしているため、 さらに `source_documents` を素朴 join すると `exams × cards × source_documents` の行数膨張 → 集計が壊れる。 回避には相関サブクエリ / `DISTINCT ON` / 別 CTE が要り query 複雑度が上がる。

### R4 (現場発見) — status index を使った専用軽量 query
`source_docs_status_idx` on `(user_id, status)` を使い「当該 user の status IN ('processing','failed') の source_documents」 だけを 1 query で取得 → app 側で `examId` → status の Map を作り、 一覧結果に merge。
- trade-off: 既存一覧 query を全く触らない。 index 直撃で軽い (processing/failed は通常少数)。 completed の集計は不要 (tag を出すのは異常系のみ)。 §4 の「15 分越え判定」 と同じ source_documents fetch に相乗りできる。

### 全案共通の論点
- 「exam の status」 = 最新 source_documents か / 全 source_documents の論理和か (`mode='existing'` で過去成功 + 今回失敗 の混在時の表示)。
- 並列 OCR: 同一 exam に同時 2 upload は現状 UI 上ほぼ起きない (upload-form は 1 回 submit 単位) が、 異なる exam への並列はありうる。 exam 単位集計なら影響なし。
- `mode='new'` failed exam = 「0 cards + failed source_doc」。 「失敗 tag」 と「カード 0 件」 が重複表示になる扱い。

---

## 4. 15 分越え 'processing' の自動 failed 化 — 設計選択肢 (列挙のみ)

対象 = `source_documents.status='processing'` かつ `created_at` が 15 分以上前の行 (Vercel kill / markFailed の UPDATE 失敗 で残骸化したもの)。 kickoff 方針 5「row 削除はしない、 failed に変換」。

### C1 — 試験一覧 page fetch 時に lazy UPDATE
`/app/exams` レンダリング時に「当該 user の 15 分越え processing」 を `failed` に UPDATE。
- trade-off: read path に write が混入。 一覧を見たユーザーの分しか掃除されない (が、 残骸を見るのもそのユーザー本人のみなので実害は限定的)。 cron 設定不要。

### C2 — Vercel cron で定期実行
`vercel.json` に `crons` 追加 + 専用 API route (`CRON_SECRET` 認証) で全 user 横断 UPDATE。
- trade-off: 読み書き経路から分離でき clean。 **現状 cron は未使用 (vercel.json に `crons` なし)** のため、 route 新設 + secret env + `.env.example` 追記が要る。 cron invocation 自体は安価だが新規インフラ要素。

### C3 — 次の OCR 起動時に cleanup (`processUpload` 冒頭)
`processUpload` 開始時に「当該 user の 15 分越え processing」 を failed に UPDATE。
- trade-off: 追加 route / cron 不要。 ただし「二度と upload しないユーザー」 の残骸は永久に処理中表示のまま (ただし §3 で一覧に tag を出すなら、 そのユーザーは処理中 tag を見続ける)。

### C4 (現場発見) — DB を書かず「表示時 derive」
UPDATE せず、 §3 の tag 算出時に「`status='processing'` かつ `created_at > 15 分前` → 失敗として表示」 を read 側で判定。
- trade-off: write 経路ゼロ、 実装が tag ロジックに内包され最小。 ただし DB 上の `source_documents.status` は 'processing' のまま不整合に残る (kickoff 方針 5 の「'failed' に自動変換」 という文言は DB write を含意するため、 **DB を書くか表示だけ derive するかは設計の分岐点**)。 upload_records にも failed 行が append されないため、 monitoring/台帳の観点で差が出る。

### 全案共通の論点
- 15 分の根拠 = maxDuration (D1 で未確定) との関係。 maxDuration が 600s なら「越え」 判定閾は実 timeout より十分長く取る必要 (例: 完走しうる時間 + マージン)。 15 分 = 900s は CLAUDE.md の 900s 想定と整合するが、 maxDuration 実値次第。
- failed 化に伴い `upload_records` へ failed 行を追記するか否か (C1-C3 は追記可、 C4 は追記なし)。 月次 quota SUM は completed のみ対象なので消費計算には無影響、 影響するのは台帳 / monitoring のみ。

---

## 5. result page 改修方針確認

`/app/upload/result/[sourceDocumentId]/`。

### 5.1 現状
- `page.tsx`: Server Component。 `getSourceDocumentForUser` (id + examName のみ、 status は返さない) + `getCardsForSourceDocument`。 「✅ N 問抽出しました」 + preview リスト + `<ResultActions>`。 到達は OCR 成功時の `router.push` のみ。
- `_components/result-actions.tsx`: `'use client'`。 button 2 つ —
  1. 「保存して試験一覧へ」 = 単純 `<Link href="/app/exams">` (cards は確定済)
  2. 「破棄して再アップロード」 = `discardUpload(sourceDocumentId)` → `/app/upload`
  + amber 注意 banner (「破棄しても利用枠は戻らない」)。

### 5.2 「破棄して再アップロード」 廃止の影響範囲
- `result-actions.tsx`: button 2 と `handleDiscard` / `useRouter` / `useTransition` / `errorMsg` state / `Loader2` import / amber banner が不要化。 残るのは Link 1 本のみ → **`'use client'` 不要になり、 page.tsx (Server Component) への inline も選択肢** (現場発見、 案の一つ)。
- `discardUpload` (`_actions/discard.ts`): **唯一の呼び出し元が `result-actions.tsx`** (`grep` 確認済)。 button 廃止で discard.ts + `discard.test.ts` は dead code 化。
  - 論点: discard.ts の `mode='new'` 分岐 = 「auto 作成 exam を FK CASCADE で削除」 は、 §3/D2 で必要になる「失敗 exam の手動削除」 とロジックがほぼ同一。 **discard.ts を完全削除するか、 exam 削除機能へ転用するか** は分岐点 (案として両方ありうる)。

---

## 6. upload-form.tsx の改修方針確認

`app/(app)/app/upload/_components/upload-form.tsx`。

### 6.1 client timeout の現状
`runProcess` (upload-form.tsx:392-437) に `setTimeout(..., 90_000)` (395)。 90 秒経過で `timedOut=true` + `phase` を `error / code:'CLIENT_TIMEOUT'` に。 server がその後成功応答しても `if (timedOut) return` (417) で握りつぶす。 `Phase` 型 (69-77) に `error` variant、 `'CLIENT_TIMEOUT'` は `code` union の一員。

### 6.2 timeout 撤廃の改修対象
- `setTimeout` / `timedOut` / `clearTimeout` (395-417) を「90 秒経過で banner 表示、 spinner 継続」 に書き換え。
- spinner 継続 = `phase` を `'submitting'` のまま維持 (現状 success 時も submitting のまま `router.push`、 421-422 — この挙動は維持)。
- 90 秒経過 banner = 新規 state (`Phase` に variant 追加 or `submitting` と直交する boolean、 例 `{ kind:'submitting', longRunning:boolean }`) が要る。
- banner UI: 既存 submitting banner (485-502、 amber `role=alert`) があり、 ここに「アプリを閉じて後で試験一覧から確認することもできます」 の文言を 90 秒後に追加 or 別 banner。 新規 component を起こすかは設計判断。
- server kill (504 等) 時: 現状は `processUpload` の catch / 戻り値次第。 504 が `processUpload` の throw として届けば `runProcess` は catch 外 (try/finally のみ、 catch なし) — **現状 `runProcess` に try-catch がなく、 `processUpload` が throw すると unhandled** になる点に注意 (現場発見)。 「試験一覧で確認してください」 案内を出すには error handling 追加が要る。
- `'CLIENT_TIMEOUT'` code を `Phase`・`ErrorDetails` から除去するか (撤廃なら不要化)。

### 6.3 既存離脱ガードとの矛盾 (D3)
upload-form は submitting 中 `beforeunload` (標準 confirm dialog) + `popstate` sentinel (「戻ると抽出結果が失われる可能性があります」 confirm) で離脱を **能動的に block** している (138-181)。 submitting banner 文言 (498) も「閉じたり戻ったりしないでください。 中断しても利用枠は消費されます」。

新方針「90 秒後にアプリを閉じてよい」 と真っ向から矛盾する。 新モデルでは exam + source_documents は OCR 前に DB 確定済で、 閉じても server 側で OCR は完走しうる (= 「失われない」)。 → **beforeunload / popstate ガードと submitting banner 文言を、 90 秒経過後に緩和するか / 全廃するか / 文言だけ変えるか** は OT 判断必要。

### 6.4 設計の大前提 (要検証)
新方針「閉じても後で確認できる」 は **client 切断後も Vercel function が OCR を完走する** ことが前提。 これは Vercel serverless の一般的挙動 (client disconnect で function は中断しない) だが、 長時間 OCR ケースでの実挙動 + maxDuration 実値 (D1) は OT 実機確認推奨。

---

## 7. usageMetadata 保存の現状と改善余地

### 7.1 現状 (estimate か実 cost か)
§1.4-1.5 の通り **「実 token 数 × hardcode 単価」**。 token は `usageMetadata` の実値、 単価表 (`cost.ts:PRICING_USD_PER_1M`) と為替 (`JPY_PER_USD=150`) は hardcode。 pages × 単価 の純 estimate ではない。

### 7.2 改善余地 — `thoughtsTokenCount` 未参照
`callGemini` (gemini.ts:69-73) は `promptTokenCount` / `candidatesTokenCount` のみ参照。 **Gemini 2.5 系は `usageMetadata.thoughtsTokenCount` (thinking tokens、 output 料金で課金) を別 field で返す**。 `callGemini` の `config` に `thinkingConfig` 未設定 (gemini.ts:59-64) のため Flash は default で thinking 有効 → `thoughtsTokenCount` が非ゼロでも cost に計上されず、 **実コストを過小計上している可能性**。 (事実の指摘であり、 修正方針は提示しない。)

### 7.3 失敗時の cost 記録 (D4)
- pre-OCR / GEMINI_FAILED: `markFailed(ocrCostYen: 0)`。 **GEMINI_FAILED の場合、 Flash が 200 OK で課金された後に Pro 段で throw すると、 `runOcrPipeline` 内の `tokenUsage` は throw で失われ、 cost 0 で記録される** (process.ts:354-357 のコメントもこれを認める)。 kickoff の Gemini 公式仕様 (4xx/5xx 非課金、 200 OK 課金) を踏まえると、 200 で返った Flash 試行の cost を取りこぼす。
- SAVE_FAILED: `markFailed(ocrCostYen: pipelineResult.costYen)` で実値記録 (OCR 自体は成功済)。

### 7.4 stale estimate の有無
`ocr_cost_yen` は nullable。 processing 中は NULL、 完了 / 失敗時に 1 度だけ set。 **事前 estimate を書き込んでおく経路がないため、 stale estimate が残る問題は存在しない**。

### 7.5 単価表の場所
`lib/ai/cost.ts` の `PRICING_USD_PER_1M` (Flash / Pro)、 同 file の `JPY_PER_USD`。 公式値変更時は手動更新 (cost.ts:6 コメント)。

---

## 8. ai_usage / ai_usage_users の現状用途確認

### 8.1 用途と呼び出し経路
- `ai_usage` (global daily, JST date PK, schema.ts:141) / `ai_usage_users` (per-user daily, 複合 PK, schema.ts:150)。
- `incrementAiUsage` (`lib/ai-usage-counter.ts:20`): 1 transaction で両 table を `count = count + N` UPSERT。
- 呼び出し元は **`processUpload` の `onAttempt` callback のみ** (process.ts:321-323)。 `onAttempt` は `callWithRetry` 内で **各 callGemini 直前に発火** (ocr.ts:95) → Flash / Pro / retry 全試行で 1 回ずつ。 1 upload で最大 6 increment。
- → **OCR 失敗 / retry でも increment される** (call 試行回数 semantics、 ai-usage-counter.ts:12 コメントと一致)。

### 8.2 読み取り側
- `ai_usage` (global): `getTodayAiUsageGlobal` (ai-usage-counter.ts:49) → `processUpload` の GEMINI_DAILY_LIMIT guard でのみ参照。
- `ai_usage_users` (per-user): **読み取り元が code 上に存在しない** (`grep` 確認)。 書き込みのみ、 将来の per-user 分析 / audit 用の蓄積。

### 8.3 月次 OCR quota との関係
完全独立。 月次 quota = `upload_records` の `pages_processed` SUM (status='completed'、 JST 月境界、 `lib/ai-usage-mcq.ts`)。 ai_usage = Gemini **call 回数** の日次。 単位 (pages vs calls)・期間 (月 vs 日)・table すべて別系統。

### 8.4 本 sprint で touch するか
事実: §1-7 で挙げた改修経路 (長時間対応 / status 表示 / cost / result page / upload-form) は ai_usage / ai_usage_users の読み書きを一切経由しない。 touch 要否は OT 判断 (本 doc は方針提示しない)。

---

## 9. 未解決 / 要 OT 確認事項まとめ

| ID | 事項 | 区分 |
|---|---|---|
| D1 | maxDuration 600s が code に未反映。 Vercel 設定実態 + Server Action への適用方法 | **設計前提・最優先** |
| D2 | 「失敗 exam を手動削除」 の受け皿 (exam 削除 UI) が現状ゼロ。 S1.9.3 で新規実装か別 sprint か | スコープ判断 |
| D3 | 「閉じてよい」 案内 vs 既存 beforeunload/popstate ガード・banner 文言の矛盾 | 設計判断 |
| D4 | GEMINI_FAILED 時の Flash 200 OK 課金分の cost 取りこぼし | cost 精度判断 |
| §3 | exam status = 最新 source_doc か論理和か。 R1-R4 の選定 | 設計判断 |
| §4 | 15 分越え cleanup = DB write (C1-C3) か 表示 derive (C4) か。 cron 採用可否 | 設計判断 |
| §5 | discard.ts を完全削除か exam 削除機能へ転用か | 設計判断 |
| §7.2 | `thoughtsTokenCount` 未計上 (実コスト過小) を本 sprint で直すか | スコープ判断 |

以上。 各案の selection・修正方針は claude.ai + OT が後段で決定する。
