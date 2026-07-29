# ②-2 OCR モデル移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans。Steps は checkbox(`- [ ]`)で追跡。

**Goal:** 本番 OCR モデルを `gemini-2.5-flash` → `gemini-3.1-flash-lite` へ移行(単一点 modelId + 単価)し、独立 commit で cost.ts の thoughtsTokenCount 計上 gap を解消する。妥当性は Phase 2 の arm A/B 比較で確認。

**Architecture:** prod OCR は flash 単独ゆえモデル文字列は `cost.ts modelId()` の 1 点で決まる。実体のモデル ID はここに 1 回だけ書く(二重書き禁止)。prompt/schema/pipeline は凍結。Phase 1(offline・2 commit)→ Phase 2(OT 合図・実 API arm 比較)。

**Tech Stack:** TypeScript strict / Vitest / @google/genai 2.13.0(②-1 で bump 済)。

## Global Constraints(spec verbatim・全 task に暗黙適用)

- **凍結**: prompt(`buildDiscoverPrompt`)/ schema(`buildDiscoverResponseJsonSchema`)/ OCR pipeline 構造 / script baseline literal(`CAPTURE_MODEL_ID`・`BASELINE_MODEL_ID` = `'gemini-2.5-flash'`)/ golden fixture。触る必要が出たら**停止して OT 相談**。
- **実体モデル ID は 1 箇所のみ**(`modelId()` の返り値リテラル)。ModelKind コメント等に実体 ID を二重に書かない。
- **lite 単価** = `{input: 0.25, output: 1.5}` USD/1M(出典 `scripts/ai/lib/pricing.ts:9`)。
- **commit 分離**: A(移行)/ B(thoughtsTokenCount fix)は別 commit(変更源が別・片方のみ revert しうる)。
- **完了 gate(全 exit 0)**: whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit`(依存不変ゆえ frozen-lockfile 不要)。
- **既存 flaky**(`inline-text-field` / `card-image-gallery`)は当該 file 単体 PASS で切り分け報告(retry 糊塗禁止)。
- **Phase 順序**: commit-then-confirm(Phase 1 commit → Phase 2 arm 確認)。
- **実 API**: Phase 1 は不使用。Phase 2 の arm 比較のみ OT 合図後に実行。

---

## Task 1: commit A — モデル移行(gemini-2.5-flash → gemini-3.1-flash-lite)

**目的:** modelId('flash') を lite に repoint + flash 単価を lite 値へ結合更新。cost を pin する既存 test を lite 値へ更新(red 検証)。

**Files:**
- Modify: `lib/ai/cost.ts:11-17`(PRICING flash)・`:38-40`(modelId)
- Test: `lib/ai/cost.test.ts`(modelId + flash 単価 assertion)・`lib/ai/ocr.test.ts:62`(costYen)

**制約:** 実体 ID は modelId() に 1 回。ModelKind 'flash' は温存。pro は不変。

- [ ] **Step 1: cost.test.ts を lite 期待値へ更新(先に test = red)**

`lib/ai/cost.test.ts`:
- `modelId('flash')` の期待を `'gemini-3.1-flash-lite'` に(:32-34 の it 名も更新)。
- flash 単価 test を lite 値へ(pro 行は不変):
```ts
it('Flash(lite): 1M input + 0 output = 0.25 USD * 150 JPY = 37.5 JPY', () => {
  expect(estimateCostYen('flash', 1_000_000, 0)).toBe(37.5)
})
it('Flash(lite): 0 input + 1M output = 1.5 USD * 150 JPY = 225 JPY', () => {
  expect(estimateCostYen('flash', 0, 1_000_000)).toBe(225)
})
it('small request (10k input + 1k output) Flash(lite) = 0.004 USD * 150 = 0.6 JPY', () => {
  expect(estimateCostYen('flash', 10_000, 1_000)).toBe(0.6)
})
it('sub-yen request (1k input + 0 output) Flash(lite) = 0.00025 USD * 150 = 0.0375 JPY', () => {
  expect(estimateCostYen('flash', 1_000, 0)).toBe(0.0375)
})
```
`lib/ai/ocr.test.ts:62`: `expect(result.costYen).toBe(82.5)` → `toBe(60)`(1M in + 100k out の lite: (0.25 + 0.15)*150 = 60)。

- [ ] **Step 2: 更新 test を走らせ red 確認**

Run: `pnpm vitest run lib/ai/cost.test.ts lib/ai/ocr.test.ts`
Expected: **FAIL**(旧 cost.ts は 2.5-flash 単価 / modelId は 2.5-flash を返すため新期待値と不一致)。この red が新 pin の有効性の実証。

- [ ] **Step 3: cost.ts を lite へ変更**

`lib/ai/cost.ts`:
```ts
// USD per 1M tokens。flash = 主 OCR モデル(②-2 で 2.5-flash → 3.1-flash-lite 移行)。
// lite 単価の出典 = scripts/ai/lib/pricing.ts PRICE_TABLE['gemini-3.1-flash-lite']。
// ここは JPY 本体計上(ModelKind キー)ゆえ pricing.ts(USD eval・model 文字列キー)とは
// 別テーブルだが lite 単価は一致させる(drift 注意)。
const PRICING_USD_PER_1M: Record<ModelKind, { input: number; output: number }> = {
  flash: { input: 0.25, output: 1.5 },
  pro: { input: 1.25, output: 10.0 },
}
```
```ts
// ModelKind 'flash' は主 OCR モデルの歴史的ラベル(②-2 で実体は lite へ移行)。
// 実体のモデル ID はこの modelId() が単一 source(二重定義しない)。
export function modelId(kind: ModelKind): string {
  return kind === 'flash' ? 'gemini-3.1-flash-lite' : 'gemini-2.5-pro'
}
```

- [ ] **Step 4: test green + 検出機構 pass 確認**

Run: `pnpm vitest run lib/ai/cost.test.ts lib/ai/ocr.test.ts lib/ai/ocr-golden.test.ts`
Expected: PASS(cost/ocr の新 pin green・golden は parse 層無傷で green)。
Run: `pnpm typecheck` → 0。

- [ ] **Step 5: canonical review + Codex**

canonical(`superpowers:requesting-code-review`・general-purpose + template 改変なし・観点に whole-repo lint / test:iso 含む)+ Codex(`scripts/ai/codex-review.sh ocr-2-2-migration`)。未解決 Critical 0 かつ Important 0 まで(上限 3 周)。

- [ ] **Step 6: commit A**

commit 直前宣言(chat 4 点)。
```bash
git add lib/ai/cost.ts lib/ai/cost.test.ts lib/ai/ocr.test.ts
git commit -m "feat(ai): OCR モデルを gemini-2.5-flash → gemini-3.1-flash-lite 移行 [reviewed]"
```

**完了条件:** modelId('flash')=lite / flash 単価=lite / cost・ocr test green(red 実証済)/ golden green / typecheck 0 / canonical+Codex Crit0 Imp0 / commit A `[reviewed]`。

---

## Task 2: commit B — thoughtsTokenCount 本体計上 fix

**目的:** callGemini が thoughtsTokenCount を露出 → pipeline が透過 → estimateCostYen が output 課金に加算(公式: thinking は output 単価)。lite は非発火だが本体の latent gap 解消。

**Files:**
- Modify: `lib/ai/clients/gemini.ts:47-51`(GeminiCallResult)・`:149-154`(return)
- Modify: `lib/ai/ocr.ts:82-86`(tokenUsage 型)・`:115`(callWithRetry 型)・`:193-197`(push)・`:214-217`(cost 計算)
- Modify: `lib/ai/cost.ts:26-36`(estimateCostYen 第4引数)
- Test: `lib/ai/cost.test.ts`・`lib/ai/clients/gemini.test.ts`・`lib/ai/ocr.test.ts`

**Interfaces:**
- Produces: `estimateCostYen(model, inputTokens, outputTokens, thoughtsTokens = 0)` / `GeminiCallResult.thoughtsTokens: number` / `OcrPipelineResult.tokenUsage[].thoughtsTokens: number`

- [ ] **Step 1: 新 test を書く(red)**

`lib/ai/cost.test.ts`(estimateCostYen が thoughts を output に加算):
```ts
it('Flash(lite): thoughtsTokens は output 課金に加算 (0 in + 1M out + 1M thoughts = (2M*1.5/1M)*150 = 450 JPY)', () => {
  expect(estimateCostYen('flash', 0, 1_000_000, 1_000_000)).toBe(450)
})
it('thoughtsTokens 省略時は 0 として従来どおり (0 in + 1M out = 225 JPY)', () => {
  expect(estimateCostYen('flash', 0, 1_000_000)).toBe(225)
})
```
`lib/ai/clients/gemini.test.ts`(callGemini が thoughtsTokens を露出):
```ts
it('usageMetadata.thoughtsTokenCount を thoughtsTokens として返す', async () => {
  mockGenerateContent.mockResolvedValue({
    text: '{"cards":[]}',
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200, thoughtsTokenCount: 50 },
  })
  const res = await callGemini({ model: 'flash', files: [], prompt: 'p', responseJsonSchema: {} })
  expect(res.thoughtsTokens).toBe(50)
})
it('thoughtsTokenCount 欠測時は thoughtsTokens=0', async () => {
  mockGenerateContent.mockResolvedValue({ text: '{"cards":[]}', usageMetadata: {} })
  const res = await callGemini({ model: 'flash', files: [], prompt: 'p', responseJsonSchema: {} })
  expect(res.thoughtsTokens).toBe(0)
})
```
`lib/ai/ocr.test.ts`: happy-path の mock(:47-51)に `thoughtsTokens: 0` を足し、tokenUsage assertion(:57-58)を `[{ model: 'flash', inputTokens: 1_000_000, outputTokens: 100_000, thoughtsTokens: 0 }]` に更新。加えて thoughts>0 の透過 test を 1 本追加(mock `thoughtsTokens: 200_000` → tokenUsage に反映 + costYen に加算されることを pin)。

- [ ] **Step 2: red 確認**

Run: `pnpm vitest run lib/ai/cost.test.ts lib/ai/clients/gemini.test.ts lib/ai/ocr.test.ts`
Expected: **FAIL**(estimateCostYen は 3 引数・callGemini は thoughtsTokens 未露出・tokenUsage に thoughtsTokens なし)。

- [ ] **Step 3: 実装(gemini.ts → ocr.ts → cost.ts)**

`lib/ai/clients/gemini.ts` GeminiCallResult に追加 + return:
```ts
export type GeminiCallResult = {
  text: string
  inputTokens: number
  outputTokens: number
  thoughtsTokens: number
}
// return 内:
return {
  text,
  inputTokens: usage.promptTokenCount ?? 0,
  outputTokens: usage.candidatesTokenCount ?? 0,
  thoughtsTokens: usage.thoughtsTokenCount ?? 0,
}
```
`lib/ai/ocr.ts`: callWithRetry 返り型 + tokenUsage 型に `thoughtsTokens: number` 追加、push を
`{ model: 'flash', inputTokens: flash.inputTokens, outputTokens: flash.outputTokens, thoughtsTokens: flash.thoughtsTokens }`、cost 計算を
`sum + estimateCostYen(u.model, u.inputTokens, u.outputTokens, u.thoughtsTokens)`。
`lib/ai/cost.ts` estimateCostYen:
```ts
export function estimateCostYen(
  model: ModelKind,
  inputTokens: number,
  outputTokens: number,
  thoughtsTokens = 0,
): number {
  const p = PRICING_USD_PER_1M[model]
  const usd =
    (inputTokens / 1_000_000) * p.input +
    ((outputTokens + thoughtsTokens) / 1_000_000) * p.output
  return Math.round(usd * JPY_PER_USD * 10_000) / 10_000
}
```

- [ ] **Step 4: green + gate**

Run: `pnpm vitest run lib/ai/cost.test.ts lib/ai/clients/gemini.test.ts lib/ai/ocr.test.ts`
Expected: PASS。
Run: `pnpm typecheck` → 0。`MOCK_OCR_RESULT`(contract test)が typecheck を割る場合のみ `thoughtsTokens: 0` を tokenUsage entry に追加(untyped mock ゆえ通常は不要)。

- [ ] **Step 5: canonical review + Codex**（Task 1 Step 5 と同経路・topic `ocr-2-2-thoughts`）

- [ ] **Step 6: commit B**
```bash
git add lib/ai/clients/gemini.ts lib/ai/ocr.ts lib/ai/cost.ts lib/ai/cost.test.ts lib/ai/clients/gemini.test.ts lib/ai/ocr.test.ts
git commit -m "fix(ai): cost.ts の thoughtsTokenCount 未計上を解消(output 課金へ加算) [reviewed]"
```

**完了条件:** callGemini が thoughtsTokens 露出 / pipeline 透過 / estimateCostYen 加算 / 新 test green(red 実証済)/ typecheck 0 / canonical+Codex Crit0 Imp0 / commit B `[reviewed]`。

---

## Task 3: Phase 1 完了 gate + stop checkpoint

**目的:** whole-repo 完了 gate を走らせ Phase 1 完了を報告して停止(OT push → Phase 2 合図の checkpoint)。

- [ ] **Step 1: 完了 gate**
```bash
pnpm lint --max-warnings=0
pnpm typecheck
pnpm build
pnpm test
pnpm test:iso
pnpm run audit
```
各 exit 0。`pnpm test` 既存 flaky は当該 file 単体 PASS で切り分け。

- [ ] **Step 2: stop checkpoint 報告**

chat に結論のみ: gate 各 exit 0(「whole-repo lint exit 0 確認済」「test:iso green 確認済」「pnpm run audit exit 0 確認済」明記)/ commit A・B の SHA / Phase 2(arm 比較)は OT 実 API 合図待ち、を報告して**停止**。

**完了条件:** 全 gate exit 0 / 3 必須 1 行明記 / commit A/B/docs SHA 提示 / OT 合図待ちで停止。

---

## Task 4: Phase 2 — arm A/B 比較(OT 実 API 合図後)

**目的:** lite を baseline(2.5-flash)と同一画像で比較し品質を確認。判定は内容差(品質差)= 評価対象。

**制約:** 実 API は OT 合図後のみ。コード変更なし(観測+報告)。fixture 上書きなし。

- [ ] **Step 1: arm 比較を実行(OT 合図後)**

Run: `pnpm exec tsx --env-file=.env.local scripts/ai/ocr-compare.ts --arm both --arm-model gemini-3.1-flash-lite`(実際の CLI 引数は script の usage に合わせる)。対象画像は既存 sample 群。

- [ ] **Step 2: 判定(②-1 から反転 = 内容差が評価対象)**

- **目視 diff に依存しない**。`ocr-compare.ts` の alignment(sort_key/title 突合)+ field-level 原文 diff で揺れと劣化を区別。
- **option id 表記揺れ(ア/イ/ウ vs a/b/c)は alignment に "(missing)" を大量に出すが中身は同一選択肢。「lite が選択肢を落とす」と読み違えない。fact-finding で無害確定ゆえ評価対象から外す。**
- **判定対象 = 致命シグナル(数値・単位・否定)の field-level 原文 diff**。加えて観測: box2d go/NG・503 有無・コスト(~40-45% 見込み)・表直下空行の有無・`![…](…)` 本文混入頻度。

- [ ] **Step 3: 停止条件**

致命シグナルの baseline 比劣化(数値/単位/否定の取りこぼし)or box2d NG = **停止して OT に上げる**。**対処方針は CC で決めない**(別モデル試行か ②-2 見送りかは OT 判断)。問題なければ報告して完了。

**完了条件:** arm 比較実行 / 判定を致命シグナル field diff に基づき実施(option id 揺れは除外)/ 品質劣化なし(あれば停止)/ 報告(session doc 記録)。

---

## Self-Review

- **Spec coverage:** §3 移行核 = Task 1 / §4.1 commit A = Task 1 / §4.2 commit B = Task 2 / §5 Phase1 = Task 1-3・Phase2 = Task 4 / §6 phase 順序 = Global + Task 順 / §7 gate = Task 3 / §10 停止条件 = Task 1 Step4・Task 4 Step3。凍結(§2)= Global Constraints。持ち越し(§8)は spec に記録済ゆえ plan task 化しない(②-2 では触らない)。全 spec 項に対応。
- **Placeholder scan:** TBD/TODO なし。全 code step に具体値(lite 単価・37.5/225/0.6/0.0375/60/450）。
- **Type consistency:** `estimateCostYen(model, inputTokens, outputTokens, thoughtsTokens=0)` / `GeminiCallResult.thoughtsTokens` / `tokenUsage[].thoughtsTokens` は Task 2 全 step で一致。
