# ②-0 OCR 回帰検出の土台 — 設計 (spec)

- 日付: 2026-07-27
- status: draft (OT review 待ち)
- 前段 fact-finding: 本 sprint kickoff の調査回答 (chat / 未 doc 化)
- 関連: ②-1 (SDK 版上げ)・②-2 (モデル移行)・②-3 (表直下空行)・②-4 (画像切り出し) の**前段**

## 1. 位置づけと不変条件

②-0 は、後続の ②-1 (SDK 版上げ) と ②-2 (モデル移行) の「変化を検出できる状態」を先に作る sprint。
fact-finding で「SDK・モデル・プロンプトのどれが変わっても全テストが green のまま」と判明したため、検出機構だけを先に埋める。

**絶対不変条件 (本 sprint で変えないもの):**

- `@google/genai` の版 (1.50.1 のまま。版上げは ②-1)。
- `lib/ai/cost.ts` の `modelId()` が返すモデル ID (`gemini-2.5-flash` / `gemini-2.5-pro` のまま。モデル移行は ②-2)。
- OCR 本番パイプライン (`runOcrPipeline` / `callGemini`) の**挙動**。本番 prompt (`buildDiscoverPrompt`) / 本番 response schema (`buildDiscoverResponseJsonSchema`) の内容。
- app 本体の runtime 挙動。唯一許す app 触点 = §4-(a) の `parseAndValidate` の **pure export 化** (挙動不変の可視性変更のみ、§4-(a) 参照)。

**設計原則:** loud failure over silent green (本 project 恒久規律)。検出機構を作る sprint 自身が false-green を作らないこと。

## 2. スコープ

### In scope (CC 成果物)

- (a) recorded-response golden test + SDK 型契約アサート。
- (b) モデル比較スクリプト (現行 2.5-flash vs 後継 3.5-flash、任意モデル ID 可)。
- (c) box_2d 可視化スクリプト (探索用、HTML overlay)。
- fixture 取り込み機構 (capture スクリプト) + 実行 runbook。
- 実 fixture の commit まで (OT 画像提供 + OT 合図での capture 実走を経て、本 sprint 内で完結)。

### Out of scope

- SDK 版上げ・モデル ID 変更 (②-1 / ②-2)。
- 表直下空行の**修正** (②-3。本 sprint は「表直下空行の有無」を観測するだけ)。
- 画像切り出し pipeline の**実装** (②-4。本 sprint は box_2d の go/no-go 判断材料を出すだけ)。
- スクリプトの日次上限 / ai_usage カウント連携 (スクリプトは app を経由せず Gemini 直叩き。OT 合図での低頻度手動実行のみ。§6 参照)。
- package.json への npm script alias 追加 (既存 `scripts/stripe-test-clock-verify.ts` 同様、tsx 直実行を runbook に記載)。

## 3. 実行主体と実 API 規律

- 実 Gemini を叩くのは **capture / (b) / (c) のみ**。いずれも **OT の合図で CC が実行**する。CC は自発的に実 API を叩かない (CLAUDE.md「生成は明示トリガーのみ / 無料枠」規律)。
- `.env.local` に `GEMINI_API_KEY` は存在する (実走可能)。だが実走は OT 合図 gate を必ず通す。
- スクリプトの実 API 呼び出しは 429 受信で即停止・リトライ禁止 (CLAUDE.md AI ルール 2)。タイムアウト必須。

## 4. 設計 (deliverable 別)

### (a) recorded-response golden test + SDK 型契約

**目的:** 「実応答由来の parse/validate 出力」を pin し、parse 層 regression と SDK 形状 drift を検出可能にする。

**app 触点 (唯一の本体変更):**
`lib/ai/ocr.ts` の private `parseAndValidate(text): ExtractedCard[]` を **pure export** 化する (`export function parseOcrResponse(text)` にリネーム or export 付与。`runPipelineInner` は同関数を呼び続ける)。理由 = 本番 zod (`responseSchema`) は `.strict()` でないため unknown key を **strip** する。capture が書く `expected-cards.json` を pipeline 出力と**厳密一致**させ、golden を「parse/validate 層の出力そのもの」に直結させるには、生 `JSON.parse` でなく本番と同一の parse 関数を test・capture 双方から呼ぶ必要がある。**挙動は不変** (純粋関数の公開範囲のみ変更)。

**fixture 形式 (`tests/fixtures/ocr/`、commit する):** 1 サンプル = 2 ファイルの pair。
- `<name>.response.json` — Gemini 生応答 text を**そのまま**保存 (test 時は opaque string として扱う。中身は valid JSON だが再整形しない)。
- `<name>.expected-cards.json` — `parseOcrResponse(<name>.response.json)` の出力 (`ExtractedCard[]`) を pin。
- vitest snapshot は**使わない** (`-u` で silent 更新される risk を排し、明示 commit ファイルの deep-equal にする = loud failure)。

**golden test (`lib/ai/ocr-golden.test.ts`):**
- `tests/fixtures/ocr/` から `*.response.json` を列挙。
- **`expect(files.length).toBeGreaterThan(0)`** — fixture 0 件は **RED** (論点2)。
- `describe.each(pairs)`: 各 pair で `expect(parseOcrResponse(readRaw(name))).toEqual(readExpected(name))`。
- app 本体 mock 不要 (pure 関数を直接叩く)。`vi.mock` も不要。

**SDK 型契約アサート (`lib/ai/clients/gemini-sdk-contract.ts`):**
- `.test.` を含まない plain `.ts` → vitest の include glob (`**/*.test.ts(x)`) に**掛からない** / tsc (`pnpm typecheck`) は拾う。
- `@google/genai` の型を import し、wrapper が実際に触るフィールドを型レベルで固定:
  - `GenerateContentResponse['text']` が `string | undefined`。
  - `usageMetadata.promptTokenCount` / `candidatesTokenCount` が `number | undefined`。
  - `callGemini` が渡す config 形 (`responseMimeType` / `responseJsonSchema` / `abortSignal`) を SDK の generateContent パラメータ型に `satisfies` で照合。
- SDK が版上げでフィールド改名/削除すると **tsc が fail** する。
- 正確な export 型名 (`GenerateContentResponse` 等) は install 済 1.50.1 の `.d.ts` で実装時に確認。unused type const は eslint 上必要なら `eslint-disable` 局所付与。

### (b) モデル比較スクリプト (`scripts/ai/ocr-compare.ts`)

**目的:** 同一画像群を複数モデルに通し、差分を OT が判定できる形で出す。

- 入力: 画像ディレクトリ (既定 `scripts/ai/ocr-samples/`) + モデル ID list (既定 `['gemini-2.5-flash','gemini-3.5-flash']`、引数で任意指定可)。
- 各モデルで **本番と同一** の prompt (`buildDiscoverPrompt`) + 同一 response schema (`buildDiscoverResponseJsonSchema`) を使い、モデル ID **だけ**差し替える (§4 共有 caller)。→ 差が「モデル差」に isolate される。
- 出力 (各モデル・各画像ごと):
  - 抽出カード (`ExtractedCard[]`) と、モデル間 diff。
  - `usageMetadata` 実測 (input / output token 数)。
  - 各本文フィールド (`question_text` / `explanation_text` / `options[].text` / `.explanation`) の **MD 表直下に空行があるか** (§4 共有 blank-line helper)。②-3 の要否判定用。
- 出力先: gitignore 済ローカルディレクトリ (`scripts/ai/ocr-samples/out/`) に整形レポート (Markdown) + 生 JSON。
- **エラー処理:** モデルごとに try/catch。あるモデルが応答しない (例: 2.5-flash が 2026-10-16 前倒し shutdown で不可) 場合、**その事実を結果として出力**し他モデルは続行。429 は即停止 (retry しない)。
- スクリプトは実行・観測・整形のみ。判定は OT。

### (c) box_2d 可視化スクリプト (`scripts/ai/ocr-box2d-viz.ts`)

**目的:** ②-4 (画像切り出し) の go/no-go を pipeline 実装前に目視判断する探索。

- **探索専用**の prompt + response schema (本番 OCR とは別):
  - 応答形: `{ regions: [{ box_2d: [y_min, x_min, y_max, x_max], target: string, label?: string }] }`。
  - `box_2d` は **[y_min, x_min, y_max, x_max] の 0〜1000 正規化 (y 先)** のまま受ける (座標順を変えると精度低下の報告があるため)。変換は内部でのみ行う。
  - `target` を**各矩形に返させる** (`question_text` / `explanation_text` / `memo` / `option:<id>` を許容語彙として prompt で提示)。選択肢に図がある問題の切り出し先判別に必須。
- 可視化: **依存追加ゼロの HTML overlay**。
  - `<img src="data:<mime>;base64,...">` (ローカル画像を base64 埋め込み = 自己完結)。
  - 各 region を `position:absolute` の `<div>` で重ね、**% で配置** (`left = x_min/10`、`top = y_min/10`、`width = (x_max-x_min)/10`、`height = (y_max-y_min)/10`。0-1000→%は /10)。
  - 各矩形に `target` ラベルを描画。
  - % 配置は img のアスペクト比に自動追従するため、**元画像 px 寸法も画像処理ライブラリも不要** (新ライブラリ事前相談 / server decoder を回避)。
- 出力: 画像ごとに `.html` を `scripts/ai/ocr-samples/out/` へ。OT がブラウザで目視判定。

### 共有 (script-scoped)

- `scripts/ai/lib/gemini-raw.ts` — raw モデル文字列で generateContent を叩く薄い caller。引数 `(modelId, files, prompt, responseJsonSchema)` → `{ text, inputTokens, outputTokens }`。タイムアウト/abort を自前に持ち、429 は即 throw。capture・(b)・(c) の 3 箇所で使う (rule of three を満たすため抽出)。本番 `callGemini` / `modelId` は**一切触らない** (本番シグネチャ不変)。
- `scripts/ai/lib/blank-line-below-table.ts` — `hasBlankLineBelowTable(text): { field 単位の判定 }`。`lib/markdown/segment-md-tables.ts` の `segmentMdTables` を再利用し、table segment の直後 text segment が空行始まりかを判定する pure 関数。②-3 に流用しうるが、本 sprint では scripts 側に置き lib/ への昇格はしない (scope creep 回避)。
- `scripts/ai/lib/load-images.ts` (必要なら) — ローカル画像を読み base64 + mime を返す小関数。

### capture (fixture 取り込み機構、`scripts/ai/ocr-capture-fixture.ts`)

- 入力: 画像 1 枚 + fixture 名。
- **本番モデル (`gemini-2.5-flash`) + 本番 prompt / schema** で 1 回叩き、生応答 text を取得。
- `tests/fixtures/ocr/<name>.response.json` に生 text を保存し、`parseOcrResponse(raw)` の出力を `<name>.expected-cards.json` に保存 (test と同一 parse 関数)。
- OT 合図で CC が実行 (§3)。

## 5. sequencing と OT gate

1. **CC (自走)**: (a) の型契約 + golden harness (fixture 0 件 = RED)、(b)(c)(capture) スクリプト + 共有 + pure helper 単体 test を実装。この時点で golden は **RED** (実 fixture 未投入。論点2 で許容 = 順序問題)。
2. **OT gate**: OT が試験画像 (3〜5 枚、選択肢に図あり ≥1 / MD 表あり ≥1) を `scripts/ai/ocr-samples/` に配置し、**capture 実走の合図**を出す。
3. **CC (OT 合図後)**: capture を実走 → `tests/fixtures/ocr/` に response + expected-cards を commit → golden **green** 化 → golden の **red 検証** (§6) → 完了 gate。
4. (b)(c) の実走・判定は OT (分担どおり)。CC は runbook で手順提示。

`.env.local` に key 有りだが、2・3 の実 API 実走は必ず OT 合図を待つ。

## 6. テスト & red 検証戦略

CLAUDE.md「test-only 変更は保証の増減で分岐」+「保証の増 = red 検証必須」に従う。

- **SDK 型契約 (保証の増):** 誤った型アサート (例: `text` を `number` と主張) を一時的に書き、`pnpm typecheck` が **fail** することを実証 → 戻す。commit message に「red 検証」記録。fixture 不要ゆえ**実装完了時点で実証可能**。
- **golden test (保証の増):** 実 fixture commit 後、`expected-cards.json` を 1 箇所改変 (or parse 層を変異) させ test が **fail** することを実証。commit message に「red 検証」記録。
- **pure helper (blank-line 判定 / box_2d→% 変換):** 決定論的 pure 関数として単体 test (実 API 非依存)。red 検証。
- **スクリプト本体 (実 API 部分):** 実 API は test で叩かない (mock 必須)。共有 caller は mock、pure 部分のみ assert。
- スクリプトの日次上限 enforcement は**持たない** (out of scope)。OT 低頻度手動 + 429 即停止で運用リスクを抑える。

## 7. review 分類 (commit 単位、実装時に確定)

- app 触点 (`parseOcrResponse` export) + スクリプト (b)(c)(capture)(共有) = **feat** → canonical review (superpowers native reviewer) + Codex 独立レビュー → `[reviewed]`。
- golden test / 型契約 / helper test = **保証の増** → red 検証 + 簡易 review → `[reviewed]`。
- `.gitignore` 追記 = **chore** → `[no-review]`。
- spec / runbook = docs → `[no-review]` (即 commit)。
- 完了 gate: whole-repo `pnpm lint` (--max-warnings=0) exit 0 / `pnpm test` green / `pnpm typecheck` 0 / `pnpm test:iso` green / `pnpm run audit` exit 0。報告 chat に各 1 行明記。

## 8. 追加/変更する env・依存

- **新規 env なし** (`GEMINI_API_KEY` は既存)。モデル ID はスクリプト引数/既定値。
- **新規 runtime 依存なし**。box_2d 可視化は HTML overlay で dep 回避。
- `.gitignore` に `scripts/ai/ocr-samples/` を追加 (ローカル画像 + 実行出力。commit するのは `tests/fixtures/ocr/` の応答 JSON fixture のみ)。

## 9. リスク / 未決 (実装時に潰す)

- `@google/genai` 1.50.1 SDK から `gemini-3.5-flash` を**文字列指定で呼べる**想定 (SDK はモデル名を hardcode せず素通し)。呼べない/schema 非対応なら (b) のエラー処理がその事実を出力する = 想定内。
- 3.5-flash の thinking は enum (`thinking_level`) 化されるが、本番 prompt は thinking config を**渡さない**ため (b) の比較でも未指定 (両モデル default 挙動を比較) = 破壊的変更に触れない。
- `gemini-sdk-contract.ts` が tsconfig の include 対象に入ることを、わざと壊して tsc fail を確認することで inclusion と red 検証を同時に担保。
- capture の `expected-cards.json` は「その時点の parse 出力」= baseline。②-1/②-2 では再 capture して baseline と diff することが「変化検出」の実体 (golden 単体はモデル出力 drift を捕まえない。drift は (b) 再実行 or 再 capture diff で顕在化する — この役割分担を runbook に明記)。
