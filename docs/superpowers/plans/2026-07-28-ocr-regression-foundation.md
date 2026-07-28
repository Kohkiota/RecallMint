# ②-0 OCR 回帰検出の土台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ②-1(SDK 版上げ)・②-2(モデル移行)・②-4(図版切り出し)の「変化を検出・比較・go/no-go 判断」できる機構を、本番挙動を変えずに先に作る。

**Architecture:** (a) 実応答 fixture を pin する golden test + SDK 型契約アサート、(b) 5モデル × arm A/B のモデル比較スクリプト(1画像実コスト算出)、(c) box_2d の HTML overlay 可視化。実 API を叩く capture/(b)/(c) は OT 合図でのみ実行。**(b)(c) の初回実走まで ②-0 に含む(実行 CC / 判定 OT)。**

**Tech Stack:** TypeScript strict / Vitest 4 / tsx 直実行 / @google/genai 1.50.1(版は据置)/ Gemini Developer API。

**正本 spec:** `docs/superpowers/specs/2026-07-27-ocr-regression-foundation-design.md`(設計判断・§12=Codex 反映はこちら。本 plan は task 分解)。

## Global Constraints(全 task 共通・spec §1/§3/§12 verbatim)

- **不変**: `@google/genai` 版(1.50.1)/ `cost.ts` の `modelId()` 戻り値 / 本番 `runOcrPipeline`・`callGemini` 挙動 / 本番 `buildDiscoverPrompt`・`buildDiscoverResponseJsonSchema` の内容。唯一の app 触点 = T1 の `parseOcrResponse` pure export(挙動不変)。
- **arm B schema/prompt はスクリプト側のみ**。arm B schema は本番 `buildDiscoverResponseJsonSchema()` 出力を **deep-clone して figure_regions 注入**(手書き複製禁止)。
- **実 API 規律**: 実走は capture/(b)/(c) のみ・**OT 合図で CC が実行**(自発禁止)。**逐次実行** + **429 は結果保存後に run 全体停止**・retry 追加禁止(SDK 内部 retry は残る=本番同挙動)・timeout 必須。**OT の実 API 合図は 1 回**(capture T9 + (b) arm A + (c) T10 が続けて走る)。**arm B は arm A 結果後の OT `--arm-model` 指定(2 つ目の gate)を待つ**・初回から全モデルで回さない。
- **usage 欠測は N/A**(0 に潰さない)。**box_2d 異常は補正せず raw 併記 + invalid 明示**。**model 由来テキストは HTML escape**。
- **比較は alignment**(`sort_key`→`title`、選択肢は `id`)。**致命的差分は field-level 原文 diff を正本**、否定/数値/単位/記号は強調のみ。
- **box_2d**: `[y_min, x_min, y_max, x_max]` 0-1000 のまま受け変換は内部のみ。
- **loud failure**: golden の fixture 0 件は RED(skip 禁止)+ orphan/duplicate fixture は fail。
- **命名**: file kebab-case / 関数 camelCase / 定数 UPPER_SNAKE。import 順 外部→内部→相対。コメントは「なぜ」。
- **review**: feat/保証の増 は canonical(native reviewer)+ Codex(`scripts/ai/codex-review.sh`)→ `[reviewed]`。保証の増は red 検証必須。chore/docs は `[no-review]`。
- **単価**(spec §10・$/1M・標準tier): 2.5-flash 0.30/2.50, 3.1-flash-lite 0.25/1.50, 3.5-flash-lite 0.30/2.50, 3.6-flash 1.50/7.50, 3.5-flash 1.50/9.00。課金 output = candidatesTokenCount + thoughtsTokenCount。
- **擬似問題**: golden 入力 = 架空擬似試験 `tests/fixtures/ocr/mock-exam-page1.png`/`.pdf`(commit 済 `2b93d4a`)。実教材は `scripts/ai/ocr-samples/`(gitignored・非commit)で (b)(c) 専用。

---

### Task 1: `parseOcrResponse` pure export(app 触点)

**目的:** golden(T9)/capture(T5)が本番と同一 parse/validate を呼べるよう private `parseAndValidate` を pure export 化。
**Files:** Modify `lib/ai/ocr.ts:149-164`(rename + export、`runPipelineInner:198` 追随)。
**Interfaces — Produces:** `export function parseOcrResponse(text: string): ExtractedCard[]`。
**制約:** rename + export のみ。挙動不変(zod `responseSchema` 不変・呼び出し不変)。scope 外不可。

- [ ] `pnpm test lib/ai/ocr.test.ts` baseline green 確認。
- [ ] `parseAndValidate` → `export function parseOcrResponse` に rename、内部呼び出し追随。
- [ ] `pnpm typecheck` 0 / `pnpm test lib/ai/ocr.test.ts` green(挙動不変実証)。
- [ ] commit: `feat(ocr): parseAndValidate を parseOcrResponse として pure export (挙動不変) [reviewed]`。

---

### Task 2: SDK 型契約アサート(保証の増・即 red 検証可)

**目的:** `@google/genai` が版上げで response/param 形を変えたら `pnpm typecheck` が fail する型ガード。
**Files:** Create `lib/ai/clients/gemini-sdk-contract.ts`(`.test.` 無し = vitest 非収集 / tsc 収集)。
**制約:** runtime export 無し。**実 `generateContent` 引数型から config を導出**し、使用 field の**存在・代入可能性**を検証(厳密一致は無害な型狭まりで false-fail するため避ける)。触るのは code が実際に読む field のみ。unused に eslint 警告時は局所 `eslint-disable`。
**Interfaces — Consumes:** `@google/genai` の型。

- [ ] `text`(string|undefined 相当の存在/代入)、`usageMetadata` の promptTokenCount/candidatesTokenCount/**thoughtsTokenCount**、候補の **finishReason**(T3/T6 が読む)、config 形(responseMimeType/responseJsonSchema/abortSignal)を generateContent 引数型に `satisfies` で照合。
- [ ] **red 検証**: 使用 field を存在しない名に誤記 → `pnpm typecheck` fail を確認 → 戻す。
- [ ] `pnpm typecheck` 0(正形で pass)/ `pnpm lint` 0 / vitest が本 file を拾わない確認。
- [ ] commit(「red 検証」記録): `test(ocr): @google/genai response/param 形の型契約アサート追加 [reviewed]`。

---

### Task 3: 共有 script infra(gemini-raw / figure-detect-schema / load-images)

**目的:** capture/(b)/(c) が共有する raw 呼び出し・arm B/box2d schema・画像読込。
**Files:** Create `scripts/ai/lib/gemini-raw.ts` / `figure-detect-schema.ts` / `load-images.ts`。Test `scripts/ai/lib/gemini-raw.test.ts`。
**制約:** 本番 `callGemini`/`modelId` を触らない。retry 追加禁止(SDK 内部 retry は残す=本番同挙動、無効化 config あれば使う)。timeout(AbortController)必須。schema description 最小・box_2d 順序のみ明記。load 画像は ext allowlist、未知は throw。
**Interfaces — Produces:**
- `callGeminiRaw(p: { modelId: string; files: GeminiInputFile[]; prompt: string; responseJsonSchema: Record<string,unknown>; timeoutMs?: number }): Promise<{ text: string; finishReason: string | undefined; usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number } }>`(欠測は undefined=**0 に潰さない**。`GeminiInputFile` は `lib/ai/clients/gemini.ts` から import)。
- `buildArmBResponseSchema(): Record<string,unknown>`(本番 schema 出力を deep-clone → 各 card に optional `figure_regions: [{ box_2d, target, label? }]` 注入)/ `buildArmBPromptSuffix(): string`。
- `buildBox2dVizSchema(): Record<string,unknown>`(`{ regions: [{ box_2d, target, label? }] }`)/ `buildBox2dVizPrompt(): string`。target 語彙は OCR ネイティブ `question`/`option_{id}`/`explanation`(保存側 mapping は ②-4 持ち越し)。
- `loadImageInline(path: string): GeminiInputFile`(png/jpg/jpeg/webp/pdf→mime、未知拡張子は throw)。

- [ ] `gemini-raw.test.ts`: `@google/genai` を `vi.mock`(既存 `gemini.test.ts` パターン)。thoughtsTokenCount 込みの応答で usage が undefined 保持で返る / finishReason が返る / 空 text throw / **timeout 経路で timer 解放 + abort 後の遅延成功を採用しない**を assert。
- [ ] 実装 → `pnpm test scripts/ai/lib/gemini-raw.test.ts` green / typecheck 0 / lint 0。
- [ ] commit: `feat(ocr-tools): 共有 script infra (raw 呼び出し + arm B/box2d schema + 画像読込) [reviewed]`。

---

### Task 4: 純粋 helper(pricing / blank-line / box-overlay)+ tests

**目的:** コスト算出・表直下空行判定・box_2d→CSS% を決定論 pure 関数化し pin。
**Files:** Create `scripts/ai/lib/pricing.ts` / `blank-line-below-table.ts` / `box-overlay.ts` + 各 `*.test.ts`。
**制約:** `blank-line` は `segmentMdTables` 再利用(**root-level 表限定**=blockquote/list 内表は対象外・明記)。pricing 表は spec §10・出典 URL+取得日コメント。lib/ 昇格しない。
**Interfaces — Produces:**
- `estimateUsdPerImage(u: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }, modelId: string): number | null`(output = candidates+thoughts。**未知モデル or 必要 token 欠測は `null`=N/A**)。`PRICE_TABLE`。
- `analyzeTablesBlankLine(text: string): Array<{ tableIndex: number; hasBlankLineBelow: boolean }>`(table segment 直後 text segment が空行始まりか。呼び出し側が card/field path を付す)。
- `boxToPercent(box2d: unknown): { valid: true; left: number; top: number; width: number; height: number } | { valid: false; reason: string }`(4要素/NaN/範囲外[0-1000]/min≥max/ゼロ面積 は `valid:false`)。

- [ ] failing test → **fail 確認(red 検証)**: `estimateUsdPerImage` の期待値 + 欠測で null + 未知モデルで null / `analyzeTablesBlankLine` で表直後空行あり/なし + 表末尾 2 例 / `boxToPercent([100,200,600,700])`→`{valid:true,left:20,top:10,width:50,height:50}` + 不正 3 例→`valid:false`。
- [ ] 実装 → `pnpm test scripts/ai/lib` green / typecheck 0 / lint 0。
- [ ] commit(「red 検証」記録): `feat(ocr-tools): pricing/blank-line/box-overlay の pure helper + tests [reviewed]`。

---

### Task 5: capture スクリプト(fixture 取り込み機構)

**目的:** 本番モデル+本番 prompt/schema で 1 画像を叩き golden fixture pair を安全に書く。
**Files:** Create `scripts/ai/ocr-capture-fixture.ts` + Test `scripts/ai/ocr-capture-fixture.test.ts`。
**制約:** モデル `gemini-2.5-flash` 固定、prompt/schema は本番。expected は T1 `parseOcrResponse` で生成。**safe name(path traversal 防止)/ 既存 fail(無言上書き禁止)/ pair atomic(temp→rename)**。実 API は OT 合図で実行。
**Interfaces — Consumes:** `callGeminiRaw`(T3)/ `parseOcrResponse`(T1)/ 本番 `buildDiscoverPrompt`・`buildDiscoverResponseJsonSchema`。

- [ ] CLI: `tsx scripts/ai/ocr-capture-fixture.ts --image <path> --name <safeName>`。`<name>.response.json`(生 text)+ `<name>.expected-cards.json`(`parseOcrResponse` 出力 pretty)を `tests/fixtures/ocr/` へ atomic 書込。
- [ ] test: `callGeminiRaw`・`node:fs` mock。既知 raw から 2 ファイルが正内容で書かれる / 既存時 fail / 不正 name reject を assert(実 API 非依存)。
- [ ] `pnpm test scripts/ai/ocr-capture-fixture.test.ts` green / typecheck 0 / lint 0。
- [ ] commit: `feat(ocr-tools): golden fixture capture スクリプト (安全書込) [reviewed]`。

---

### Task 6: モデル比較スクリプト(arm A/B・実コスト・評価観点)

**目的:** 5モデル × arm を回し致命的差分が埋もれない比較レポートを出す。
**Files:** Create `scripts/ai/ocr-compare.ts` + Test `scripts/ai/ocr-compare.test.ts`。
**制約:** モデル軸=arm A、arm A/B 比較=1 モデル(`--arm-model`)。画像 1 枚ずつ独立呼び出し。**逐次** + error は HTTP/model不在/429/timeout/parse/empty で分類、**429 は保存後 run 全停止**。判定は OT。
**Interfaces — Consumes:** T3(callGeminiRaw/arm B schema)/ 本番 prompt・schema / T4(estimateUsdPerImage/analyzeTablesBlankLine)/ T1(parseOcrResponse)。
**Produces(pure・test 対象):** `alignCards(a,b): Array<{ key; a?; b? }>`(sort_key→title)/ `diffCardFields(a,b): FieldDiff[]`(field-level 原文 diff=正本)/ `highlightCriticalSignals(text): { negations; numbers; units; symbols }`(強調のみ)/ `buildComparisonReport(runResults): string`。

- [ ] CLI: `--images <dir> --models <csv> --arm A|B|both --arm-model <id>`。既定 models = spec §4-(b) の 5。dir 列挙は決定論 sort。
- [ ] pure 群の failing test → fail 確認 → 実装(diff は alignment 後の field-level、強調は否定/数値/単位/記号、選択肢個数+末尾 id、表直下空行 field-path 付、1画像 estimatedUsd+現行2.5-flash比[N/A 含む]、finishReason)。
- [ ] オーケストレーション + provenance JSON(modelId/SDK版/日時/arm/prompt・schema・image hash/timeout/finishReason/usage/raw/parse 成否/error 分類)を `scripts/ai/ocr-samples/out/` へ。実 API 部は `callGeminiRaw` mock。
- [ ] `pnpm test scripts/ai/ocr-compare.test.ts` green / typecheck 0 / lint 0。
- [ ] commit(「red 検証」記録): `feat(ocr-tools): モデル×arm 比較スクリプト (実コスト+評価観点+provenance) [reviewed]`。

---

### Task 7: box_2d 可視化スクリプト(HTML overlay)

**目的:** 図版 box_2d を元画像に矩形 overlay して OT が目視判定する HTML を出す。
**Files:** Create `scripts/ai/ocr-box2d-viz.ts` + Test `scripts/ai/ocr-box2d-viz.test.ts`。
**制約:** 依存追加ゼロ(base64 埋め込み・% 配置)。box_2d 変換は `boxToPercent`(T4)。**target/label は escape**、**invalid box は raw 座標併記で明示**(補正しない)。EXIF orientation は現状 raw 座標併記で緩和(caveat・spec §12-B)。
**Interfaces — Consumes:** T3(callGeminiRaw/buildBox2dVizSchema/buildBox2dVizPrompt/loadImageInline)/ T4(boxToPercent)。
**Produces(pure・test 対象):** `renderOverlayHtml(imageDataUri: string, regions: Array<{ box_2d: unknown; target: string; label?: string }>): string`。

- [ ] `renderOverlayHtml` failing test(valid→% absolute div + escape 済 target ラベル / invalid box→raw 座標 + invalid 表示 / `<script>` 混入 target が escape される)→ fail 確認 → 実装。
- [ ] CLI: `tsx scripts/ai/ocr-box2d-viz.ts --images <dir>`。画像毎 `.html` を `scripts/ai/ocr-samples/out/` へ。実 API 部 mock。
- [ ] `pnpm test scripts/ai/ocr-box2d-viz.test.ts` green / typecheck 0 / lint 0。
- [ ] commit(「red 検証」記録): `feat(ocr-tools): box_2d HTML overlay 可視化スクリプト [reviewed]`。

---

### Task 8: gitignore + runbook(chore + docs)

**目的:** 実教材/出力を gitignore し、OT 実行手順を runbook 化。
**Files:** Modify `.gitignore`。Create `docs/ops/ocr-regression-foundation-runbook.md`。
**制約:** ロジック変更なし。`scripts/ai/ocr-samples/` は内容を ignore しつつ将来の README/テンプレは negation で追跡可能に(全潰し回避)。

- [ ] `.gitignore`: `scripts/ai/ocr-samples/**` を ignore + `!scripts/ai/ocr-samples/README.md`(等 negation)。
- [ ] runbook: **擬似問題(golden・commit 済 `tests/fixtures/ocr/`)vs 実教材((b)(c)・gitignored `scripts/ai/ocr-samples/`・非commit)の使い分け** / capture 合図→実行 / (b)(c) 実行コマンド + arm A/B 比較モデルは (b) 初回結果で OT 指定 / 判定観点 / 「golden はモデル出力 drift を捕まえない=②-1/②-2 は再 capture diff or (b) 再実行」の役割分担。
- [ ] commit: `chore(ocr-tools): ocr-samples を gitignore + 実行 runbook [no-review]`(runbook は `docs(...) [no-review]` 分割可)。

---

### Task 9: golden harness + capture 実走 close(OT gate)

**目的:** golden test を擬似問題の実応答で live 化し ②-0 を完了 gate まで着地。
**Files:** Create `lib/ai/ocr-golden.test.ts` / `tests/fixtures/ocr/README.md` / `tests/fixtures/ocr/mock-exam-page1.response.json`・`.expected-cards.json`(capture 生成)。入力 png/pdf は commit 済(`2b93d4a`)。生成元 `mock-exam.html` は OT 配置後に tracked commit(provenance)。
**制約:** fixture 0 件 = RED(`expect(files.length).toBeGreaterThan(0)`)+ orphan/duplicate fail。capture 実走は **OT の実 API 合図後**のみ(内容確認 gate 不要=架空)。OT 合図は T10 と共通(1 回)。harness は capture と同 task に束ね T1-T8 間の suite green を保つ。
**Interfaces — Consumes:** `parseOcrResponse`(T1)/ capture スクリプト(T5)。

- [ ] `lib/ai/ocr-golden.test.ts`: `tests/fixtures/ocr/*.response.json` 列挙 → 0件RED guard + response/expected pair 完全性(orphan fail)→ `describe.each` で `expect(parseOcrResponse(readRaw)).toEqual(readExpected)`。README に fixture 形式 + provenance(auto 生成・parse drift 用・OCR 品質 golden でない)明記。
- [ ] **OT gate**: OT が実 API capture 合図。→ 合図まで停止。
- [ ] 合図後: `tsx scripts/ai/ocr-capture-fixture.ts --image tests/fixtures/ocr/mock-exam-page1.png --name mock-exam-page1` → fixture pair commit → golden green 確認。
- [ ] **red 検証(2 種)**: ① 一時的に fixture 列挙を空にして 0件RED guard が fail する実証 ② `expected-cards.json` を 1 箇所改変して mismatch fail 実証 → 両方戻す。commit message に「red 検証」。
- [ ] 完了 gate: `pnpm lint`(--max-warnings=0)/ `pnpm test` / `pnpm typecheck` / `pnpm test:iso` / `pnpm run audit` 全 exit0 を報告 chat に各1行。
- [ ] commit: `test(ocr): 擬似問題 golden fixture + parse 層 pin (0件RED+改変 red 検証済) [reviewed]`。

---

### Task 10: 実教材での (b)(c) 初回実走(OT gate・判定材料提示)

**目的:** ②-1/②-2/②-4 の判断材料を ②-0 内で揃える。**実行 CC / 判定 OT**。
**Files:** 新規コードなし(T6/T7 のスクリプトを実走)。出力は `scripts/ai/ocr-samples/out/`(gitignored)。
**制約:** 実 API は OT 合図後のみ。**arm B を初回から全モデルで回さない**。CC は良し悪しを判定しない(材料提示のみ)。
**Interfaces — Consumes:** `scripts/ai/ocr-compare.ts`(T6)/ `scripts/ai/ocr-box2d-viz.ts`(T7)。

- [ ] **OT gate1(実 API 合図・T9 と共通の 1 回)**: OT が実教材(3-5枚・選択肢図≥1・MD表≥1)を `scripts/ai/ocr-samples/` に配置 + 合図。→ 合図まで停止。
- [ ] batch1: `tsx scripts/ai/ocr-compare.ts --images scripts/ai/ocr-samples --arm A`(5 モデル)+ `tsx scripts/ai/ocr-box2d-viz.ts --images scripts/ai/ocr-samples`(arm A と独立ゆえ同 batch)→ 出力(比較レポート + 可視化 HTML)を OT に提示。
- [ ] **OT gate2(`--arm-model` 指定)**: OT が arm A 結果を見て比較モデルを指定。→ 停止・待機。
- [ ] batch2: `tsx scripts/ai/ocr-compare.ts --images scripts/ai/ocr-samples --arm B --arm-model <OT指定>` → 出力を OT に提示。
- [ ] 完了 = 判定材料一式(arm A/B 比較・実コスト・評価観点・box_2d HTML)を OT に提示。良し悪し判定は OT。出力は gitignored ゆえ commit 対象なし。

---

## Self-Review(spec 突合)

- **spec §4-(a)** golden+型契約 → T1・T2・T9。 **§4-(b)** 比較 → T3・T4・T6。 **§4-(c)** box2d → T3・T4・T7。 **共有** → T3・T4。 **capture** → T5。 **§5/§12-C 擬似問題+OT gate** → T9(入力 commit 済)。 **§8 gitignore/runbook** → T8。 **§12-D (b)(c) 初回実走** → T10。 **§12-A Codex 反映** → Global + T2/T3/T4/T5/T6/T7/T9 に分散 fold。gap なし。
- **placeholder scan**: full file 中身は未記載(spec 参照)。各 step に具体 assert / signature。TODO/TBD なし。
- **型整合**: `parseOcrResponse` / `callGeminiRaw`(text+finishReason+usage{prompt/candidates/thoughts/total?}) / `estimateUsdPerImage`(同名 optional 消費) / `analyzeTablesBlankLine` / `boxToPercent`(valid 判別) / `buildArmB*`・`buildBox2dViz*` / compare pure 群 は task 間一致。
