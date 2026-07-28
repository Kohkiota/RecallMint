# ②-0 OCR 回帰検出の土台 — 設計 (spec)

- 日付: 2026-07-27 (更新: 2026-07-28 — OT 追加 7 点 + 研究結果 反映)
- status: draft (OT review 待ち)
- 前段 fact-finding: 本 sprint kickoff の調査回答 + 単価/images[] 追加研究 (chat / 未 doc 化)
- 関連: ②-1 (SDK 版上げ)・②-2 (モデル移行)・②-3 (表直下空行)・②-4 (画像切り出し) の**前段**

## 1. 位置づけと不変条件

②-0 は、後続の ②-1 (SDK 版上げ) と ②-2 (モデル移行) の「変化を検出できる状態」を先に作る sprint。
fact-finding で「SDK・モデル・プロンプトのどれが変わっても全テストが green のまま」と判明したため、検出機構だけを先に埋める。

**絶対不変条件 (本 sprint で変えないもの):**

- `@google/genai` の版 (1.50.1 のまま。版上げは ②-1)。
- `lib/ai/cost.ts` の `modelId()` が返すモデル ID (`gemini-2.5-flash` / `gemini-2.5-pro` のまま。モデル移行は ②-2)。
- OCR 本番パイプライン (`runOcrPipeline` / `callGemini`) の**挙動**。本番 prompt (`buildDiscoverPrompt`) / 本番 response schema (`buildDiscoverResponseJsonSchema`) の内容。
- app 本体の runtime 挙動。唯一許す app 触点 = §4-(a) の `parseAndValidate` の **pure export 化** (挙動不変の可視性変更のみ)。
- **arm B の探索 schema / prompt はスクリプト側にのみ持つ**。本番 schema / prompt の改変ではない (§4-(b) arm B)。

**設計原則:** loud failure over silent green (本 project 恒久規律)。検出機構を作る sprint 自身が false-green を作らないこと。

## 2. スコープ

### In scope (CC 成果物)

- (a) recorded-response golden test + SDK 型契約アサート。
- (b) モデル比較スクリプト。**モデル軸** (5 モデル、任意 ID 可) × **呼び出し方軸** (arm A = 本番 schema のみ / arm B = 本番 schema + 図版 box_2d)。1 画像あたり実コスト算出 (thinking 含む) + 評価観点整形。
- (c) box_2d 可視化スクリプト (探索用、HTML overlay)。
- fixture 取り込み機構 (capture スクリプト) + 実行 runbook。
- 実 fixture の commit まで (擬似問題 capture を OT 合図で実走、本 sprint 内で完結)。
- **実教材での (b)(c) 初回実走**(判定材料一式を OT に提示するところまで。良し悪しの判定は OT・§12-D)。

### Out of scope

- SDK 版上げ・モデル ID 変更 (②-1 / ②-2)。cost.ts の単価補正 (§10 の②-2送り 3 点)。
- 表直下空行の**修正** (②-3。本 sprint は「表直下空行の有無」を観測するだけ)。
- 画像切り出し pipeline の**実装**、および図版統合の保存側設計 (②-4。本 sprint は box_2d の go/no-go 判断材料を出すだけ。§11 の持ち越し 4 点)。
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
  - `usageMetadata.promptTokenCount` / `candidatesTokenCount` / **`thoughtsTokenCount`** が `number | undefined` (thoughts は §4-(b) のコスト算出で使うため型固定に含める)。
  - `callGemini` が渡す config 形 (`responseMimeType` / `responseJsonSchema` / `abortSignal`) を SDK の generateContent パラメータ型に `satisfies` で照合。
- SDK が版上げでフィールド改名/削除すると **tsc が fail** する。
- 正確な export 型名 (`GenerateContentResponse` 等) は install 済 1.50.1 の `.d.ts` で実装時に確認。unused type const は eslint 上必要なら `eslint-disable` 局所付与。

### (b) モデル比較スクリプト (`scripts/ai/ocr-compare.ts`)

**目的:** 同一画像群を複数モデル × 呼び出し方に通し、差分を OT が判定できる形で出す。

**軸1 — モデル (既定リスト、安い順を含む):**
- `gemini-2.5-flash` (現行 baseline・必須・比較の基準)
- `gemini-3.1-flash-lite`
- `gemini-3.5-flash-lite`
- `gemini-3.5-flash`
- `gemini-3.6-flash`
- 任意モデル ID を引数で指定可。**`gemini-2.5-flash-lite` は既定から除外** (現行 2.5-flash と同じ 2026-10-16 引退予定で移行先にならない)。
- 方針は「安い順に試し、品質が足りればそこで確定」。判定は OT。

**軸2 — 呼び出し方 (arm):**
- **arm A** = 本番 prompt (`buildDiscoverPrompt`) + 本番 schema (`buildDiscoverResponseJsonSchema`) のみ (現行と同一)。
- **arm B** = arm A + 図版検出 (図版のみの box_2d)。schema/prompt は arm B 専用にスクリプト側で組む (下記)。
- **全モデル × 全 arm は回さない**。モデル軸は arm A で回す。arm A/B の比較は **1 モデルで足りる** (box_2d 追加が文字抽出を劣化させるかが見えればよい)。比較対象モデルは (b) 初回実行結果を見て **OT が指定**。

**処理単位:** サンプル画像を **1 枚ずつ独立に** 1 回の generateContent に通す (box_2d を単一画像基準で曖昧なく扱うため + 1 画像あたりコストを出すため)。※本番 process.ts の複数ファイル一括とは異なる (探索の既知の割り切り。runbook に明記)。

**arm B の探索 schema (B2 — 別平坦 field):**
- 本番 card schema に、既存 `images[]` とは**別の平坦 field** `figure_regions` を **card 単位**で追加 (options[] の兄弟。所有者/選択肢の下への入れ子にしない):
  ```
  figure_regions?: Array<{
    box_2d: [number, number, number, number]  // [y_min, x_min, y_max, x_max] 0-1000 正規化
    target: string                            // "question" | "option_{id}" | "explanation" (OCR 語彙・options[].id と一致)
    label?: string
  }>
  ```
- **required にしない** (図が無いとき hallucination を誘発しないため。図があるときのみ返す)。
- **図版のみ座標**。文字領域の座標は返させない (出力膨張で末尾選択肢欠落を招くため)。
- **box_2d は [y_min,x_min,y_max,x_max] 0-1000 のまま**受け、変換は内部でのみ (順序変更で精度低下の報告あり)。
- **schema の description は最小**にする (response schema 自体が毎回 input トークンとして送られるため)。ただし box_2d の座標順序だけは明示。
- target 語彙は **OCR ネイティブ (`question`/`option_{id}`/`explanation`)** を使う (§10 参照。保存側 `option:<id>` へのマッピングは ②-4 の持ち越し)。
- arm B 用 prompt = 本番 prompt に「図版領域を検出し box_2d と target を figure_regions に返す」指示ブロックをスクリプト側で連結 (本番 `buildDiscoverPrompt` は改変しない)。

**usageMetadata と 1 画像コスト:**
- 各呼び出しで full usageMetadata を取得: `promptTokenCount` / `candidatesTokenCount` / **`thoughtsTokenCount`** / `totalTokenCount`。
- **課金 output = candidatesTokenCount + thoughtsTokenCount** (公式: thinking は output 単価。§10)。
- スクリプト側 price 表 (公式標準単価・§10、出典 URL と取得日をコメント明記) で **1 画像あたり実コスト (USD)** を算出し、**現行 2.5-flash baseline との差**を併記 (lite 系が現行より安い/同額かを OT が一目で見られるように)。

**評価観点の整形 (OT 判定材料):** 平均文字誤り率でなく、以下が埋もれない並べ方にする。
- **致命的差分**: 否定語の有無 (「ない」↔「ある」)、数値、単位 (10mg↔100mg)、記号の変化。モデル間 diff の**先頭**に置く。
- 選択肢の**個数**と、**末尾選択肢の欠落**有無。
- 各本文フィールド (`question_text`/`explanation_text`/`options[].text`/`.explanation`) の **表直下空行の有無** (§4 共有 blank-line helper。②-3 判定用)。

**出力:** gitignore 済ローカル (`scripts/ai/ocr-samples/out/`) に整形レポート (Markdown・上記観点順) + 生 JSON。
**エラー処理:** モデル/arm ごとに try/catch。あるモデルが応答しない (例: 2.5-flash が前倒し shutdown で不可) 場合、**その事実を結果として出力**し他は続行。429 は即停止 (retry しない)。判定は OT、スクリプトは実行・観測・整形のみ。

### (c) box_2d 可視化スクリプト (`scripts/ai/ocr-box2d-viz.ts`)

**目的:** ②-4 (画像切り出し) の go/no-go を pipeline 実装前に目視判断する探索。

- **探索専用**の呼び出し (box_2d の局在化に特化。arm B と同じ figure_regions の形・target 語彙・box_2d 順序を共有):
  - 応答形: `{ regions: Array<{ box_2d: [y_min,x_min,y_max,x_max], target, label? }> }` (0-1000 正規化・y 先のまま)。
  - `target` を**各矩形に返させる** (`question`/`option_{id}`/`explanation`。選択肢に図がある問題の切り出し先判別に必須)。
- 可視化: **依存追加ゼロの HTML overlay**。
  - `<img src="data:<mime>;base64,...">` (ローカル画像を base64 埋め込み = 自己完結)。
  - 各 region を `position:absolute` の `<div>` で重ね、**% で配置** (`left = x_min/10`、`top = y_min/10`、`width = (x_max-x_min)/10`、`height = (y_max-y_min)/10`。0-1000→%は /10)。各矩形に `target` ラベル。
  - % 配置は img のアスペクト比に自動追従するため、**元画像 px 寸法も画像処理ライブラリも不要**。
- 出力: 画像ごとに `.html` を `scripts/ai/ocr-samples/out/` へ。OT がブラウザで目視判定。

### 共有 (script-scoped)

- `scripts/ai/lib/gemini-raw.ts` — raw モデル文字列で generateContent を叩く薄い caller。引数 `(modelId, files, prompt, responseJsonSchema)` → `{ text, promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount }` (**thoughts を含む full usage を返す**)。タイムアウト/abort を自前に持ち、429 は即 throw。capture・(b)・(c) の 3 箇所で使う (rule of three)。本番 `callGemini`/`modelId` は**一切触らない**。
- `scripts/ai/lib/pricing.ts` — 公式標準単価表 (§10、$/1M tokens) + `estimateUsdPerImage({promptTokens, candidatesTokens, thoughtsTokens}, modelId)` (課金 output = candidates+thoughts)。出典 URL・取得日をコメント。pure 関数 → 単体 test。
- `scripts/ai/lib/blank-line-below-table.ts` — `hasBlankLineBelowTable(text)`。`lib/markdown/segment-md-tables.ts` の `segmentMdTables` を再利用し、table segment 直後 text segment が空行始まりかを判定する pure 関数。②-3 に流用しうるが本 sprint では scripts 側に置き lib/ 昇格しない (scope creep 回避)。単体 test。
- `scripts/ai/lib/figure-detect-schema.ts` — arm B / (c) が共有する figure_regions 探索 schema + prompt 断片 (box_2d 順序のみ明示・description 最小)。
- `scripts/ai/lib/load-images.ts` — ローカル画像 → base64 + mime。

### capture (fixture 取り込み機構、`scripts/ai/ocr-capture-fixture.ts`)

- 入力: 画像 1 枚 + fixture 名。
- **本番モデル (`gemini-2.5-flash`) + 本番 prompt / schema** (arm A 相当) で 1 回叩き、生応答 text を取得。
- `tests/fixtures/ocr/<name>.response.json` に生 text、`parseOcrResponse(raw)` の出力を `<name>.expected-cards.json` に保存 (test と同一 parse 関数)。
- OT 合図で CC が実行 (§3)。

## 5. sequencing と OT gate

1. **CC (自走)**: (a) の型契約 + golden harness (fixture 0 件 = RED)、(b)(c)(capture) スクリプト + 共有 + pure helper 単体 test を実装。この時点で golden は **RED** (実 fixture 未投入。論点2 で許容 = 順序問題)。
2. **golden の入力 = 擬似試験問題** (OT 生成・架空・`tests/fixtures/ocr/mock-exam-page1.png`/`.pdf` として commit 済 = §12-C)。OT が試験画像を別途渡す必要はない。
3. **OT gate1 = 実 API 合図 1 回**: OT が実教材 (3〜5 枚、**選択肢に図あり ≥1** / **MD 表あり ≥1**) を `scripts/ai/ocr-samples/` (gitignored・**非 commit**) に配置し、実 API 実走の合図を出す (fixture 本文の内容確認 gate は不要=架空・判断14)。この 1 合図で capture(擬似問題)と (b) arm A・(c) が続けて走る。
4. **CC (合図後・batch1)**: ① 擬似問題を capture → `tests/fixtures/ocr/` に response + expected-cards を commit → golden **green** 化 → **red 検証** (§6・0件RED実証 + expected改変)。② 実教材で **(b) arm A(5 モデル)** + **(c) box_2d** を実走 → 判定材料を OT に提示。
5. **OT gate2 = `--arm-model` 指定**: OT が arm A 結果を見て arm A/B 比較モデルを指定 → CC 停止・待機。
6. **CC (指定後・batch2)**: **(b) arm B**(指定モデル)を実走 → 提示。**分担 = 実行 CC / 判定 OT**((b)(c) が OT 担当なのは判定の話。実行は CC)。②-0 完了 = 判定材料一式提示まで。

`.env.local` に key 有りだが、実 API 実走 (capture/(b)/(c)) は必ず OT 合図を待つ。

## 6. テスト & red 検証戦略

CLAUDE.md「test-only 変更は保証の増減で分岐」+「保証の増 = red 検証必須」に従う。

- **SDK 型契約 (保証の増):** 誤った型アサート (例: `text` を `number` と主張) を一時的に書き `pnpm typecheck` が **fail** することを実証 → 戻す。commit message に「red 検証」記録。fixture 不要ゆえ**実装完了時点で実証可能**。
- **golden test (保証の増):** 実 fixture commit 後、`expected-cards.json` を 1 箇所改変 (or parse 層を変異) させ test が **fail** することを実証。commit message に「red 検証」記録。
- **pure helper (blank-line 判定 / box_2d→% 変換 / pricing 算出):** 決定論的 pure 関数として単体 test (実 API 非依存)。red 検証。
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
- **新規 runtime 依存なし**。box_2d 可視化は HTML overlay で dep 回避。price 表はスクリプト内の静的データ (依存でない)。
- `.gitignore` に `scripts/ai/ocr-samples/` を追加 (ローカル画像 + 実行出力。commit するのは `tests/fixtures/ocr/` の応答 JSON fixture のみ)。

## 9. リスク / 未決 (実装時に潰す)

- モデル存在は公式 pricing で全 GA 確認済 (2.5-flash / 3.1-flash-lite / 3.5-flash-lite / 3.5-flash / **3.6-flash も GA**)。`@google/genai` 1.50.1 から文字列指定で呼べる想定 (SDK はモデル名を素通し)。呼べない/schema 非対応なら (b) のエラー処理がその事実を出力する = 想定内。
- 3.5-flash 等の thinking は enum (`thinking_level`) 化されるが、本番 prompt も arm A/B も thinking config を**渡さない** (両モデル default 挙動を比較) = 破壊的変更に触れない。thinking 消費量はモデル差として `thoughtsTokenCount` に現れ、コストへ反映される。
- `gemini-sdk-contract.ts` が tsconfig の include 対象に入ることを、わざと壊して tsc fail を確認することで inclusion と red 検証を同時に担保。
- capture の `expected-cards.json` は「その時点の parse 出力」= baseline。②-1/②-2 では再 capture して baseline と diff することが「変化検出」の実体 (golden 単体はモデル出力 drift を捕まえない。drift は (b) 再実行 or 再 capture diff で顕在化) — runbook に役割分担を明記。

## 10. 前提訂正の記録 (claude.ai 誤前提 / 公式単価)

**(A) 現行 images[] の意味論 — 前回指示「既存 images[] を平坦拡張」は誤前提に基づく。訂正を記録:**
- **誤**: 現行 OCR の images[] は図を検出しており、②-4 で不足するのは座標だけ。
- **正**: images[] は**本文中の図参照表現 (別冊No.N / 図X / 下図) の記録**であり、図そのものの検出ではない。本番 prompt は「画像本体は切り出さない・中身解釈しない」と**明示的に逆を指示** (`lib/ai/prompts/ocr-extract.ts:112-114,233`)。
- **誤因**: OCR 側の target 語彙 (`question`/`option_1`/`explanation`、`ocr-extract.ts:124-129`) と、手動添付経路の語彙 (`question_text`/`option:<id>`、`lib/validation/card.ts:120-125`) の**混同**。
- **正しかった点**: 「images[] は平坦な jsonb 配列で `card_asset_refs` がそこから射影される」という**平坦性の認識は正**。反証されたのは意味論であって構造ではない (だから B2 も平坦を維持)。
- OCR の key は `q013-img-1` 形式の**プレースホルダ** (非 UUID)。`isAssetKey` で refs 射影からも描画からも除外される (非描画設計、`card-field-handlers.ts:213`/`card-image-gallery.tsx:507`)。

**「1 回統合を第一候補に据える」判断は維持 (根拠を差し替え):**
- 崩れた根拠: 「既存構造が稼働、項目追加で済む」= 反証済み。
- 維持される根拠: 2 回に分けると 2 回目の呼び出しが 1 回目の生成した option id を知らず、図版所属の対応づけを新規に作る必要がある (既存構造の有無と無関係な構造的問題)。
- **反証は arm A/B 比較の価値を上げた**: prompt 方針を「切り出さない」→「図を検出して座標を返す」へ転換するため、文字抽出への影響が事前に読めず、実測の必要性が上がった。

**(B) 公式単価 (出典 `https://ai.google.dev/gemini-api/docs/pricing`、標準/同期 tier、$/1M tokens):**

| モデル | input | output |
|---|---|---|
| gemini-2.5-flash (baseline) | 0.30 | 2.50 |
| gemini-3.1-flash-lite | 0.25 | 1.50 |
| gemini-3.5-flash-lite | 0.30 | 2.50 |
| gemini-3.6-flash | 1.50 | 7.50 |
| gemini-3.5-flash | 1.50 | 9.00 |

- thinking は **output 単価で課金** ("including thinking tokens")。`thoughtsTokenCount` は `candidatesTokenCount` と別集計 (`genai.d.ts:4772`)。課金 output = candidates + thoughts。
- 集計サイトの「安い側」説は全て公式標準単価の 50% = **Batch API 割引値の誤記**。標準単価は「高い側」が正。
- **cost.ts 照合 = 一致** (`flash 0.3/2.5` = 公式 2.5-flash / `pro 1.25/10.0` = 公式 2.5-pro ≤200k)。
- **②-2 送り (本 sprint 変更しない) の記録**: ① cost.ts が `thoughtsTokenCount` を output に加算しているか要確認 (未加算なら過小計上) ② 2.5-pro `>200k` tier 未モデル化 ③ audio input rate 未対応 (OCR=image ゆえ実害なし)。
- 含意: 3.1-flash-lite (0.25/1.50) は現行 2.5-flash より**安く**、3.5-flash-lite は**同額**。lite 系で品質が足りれば値上がりなしで期限対応が完了しうる → (b) は 1 画像実コストを現行比で出す。

## 11. ②-4 へ持ち越す論点 (本 sprint では決めない)

②-0 の探索結果 (box_2d 精度が実用に足るか) が出る前に設計しても無駄になるため、以下は ②-4 の設計事項として記録し、②-0 では扱わない:

1. 参照メモ entry と図版 entry の関係 (統合するか別々に持つか。本文の「下図」参照メモと切り出した図が同一対象を指す場合の扱い)。
2. target 語彙のマッピング (OCR 側 `option_1` ↔ 保存側 `option:<id>`)。
3. placeholder key (`q013-img-1` 形式) → UUID asset への昇格経路。
4. 現状の非描画設計を、切り出し画像に対してどう変えるか。

## 12. Codex plan cross-check の設計確定 + 擬似問題 fixture 方針

Codex 独立論点 (`docs/codex/2026-07-28-plan-ocr-regression-foundation.md`) を反映した**設計確定**。plan の task 制約/interface に落とす。

**(A) 比較・検出の正確性 (fold 済):**
- `callGeminiRaw` は `finishReason` を返す。末尾選択肢欠落を **MAX_TOKENS 打切り**と区別するため (両者を混同すると比較が誤る)。
- usage 欠測は **0 でなく N/A** (token/コストを nullable 化。0 だとコスト優位を偽装)。
- カード比較は index でなく **`sort_key`→`title` で alignment**、選択肢は **`id` 照合** (1 枚欠落で全崩れを防ぐ)。
- 致命的差分は **field-level 原文 diff を正本**、否定語/数値/単位/記号抽出は**強調のみ** (日本語否定・全角数字・μ/± を regex で取りこぼすため)。
- 表直下空行は **card×field×表番号の粒度**で出す。`segmentMdTables` は **root-level 表限定** (blockquote/list 内表は評価対象外 = 明記)。
- arm B schema は本番 `buildDiscoverResponseJsonSchema()` の**出力を deep-clone して figure_regions を注入** (手書き複製の drift 防止)。
- box_2d 異常 (要素数/NaN/範囲外/min>max/ゼロ面積) は**補正せず raw 併記 + invalid 明示**。HTML overlay は target/label を **escape** (ローカル HTML でも injection 防止)。
- 実行は**逐次** + **429 は結果保存後に run 全体を停止**。SDK 1.50.1 は内部 retry を持つ (prod gemini.ts で確認済) ため、CC は retry を足さず「1 call = 複数 HTTP になりうる (本番同挙動)」を明記 (無効化 config は実装時確認)。error は HTTP/model不在/429/timeout/parse/empty で分類。
- SDK 型契約は「実 `generateContent` 引数型から config 導出 + 使用 field の存在・代入可能性」で検証 (厳密一致は無害な型狭まりで false-fail するため避ける)。
- compare 出力に provenance (modelId/SDK版/日時/arm/prompt・schema・image hash/timeout/finishReason/usage/raw/parse 成否/error 分類)。
- capture の安全書込: safe name (path traversal 防止) / 既存 fail (無言上書き禁止) / pair atomic (temp→rename)。
- golden: **0 件 RED を実証** (空 fixture で count guard が実際に fail することを確認) + orphan/duplicate fixture を fail。

**(B) fold せず caveat 化 (YAGNI):** EXIF orientation 完全対応 → overlay に raw 座標併記で緩和。Unicode 正規化網羅 → field-level 原文 diff が正本ゆえ heuristic の穴は非致命。

**(C) 擬似問題 fixture 方針 (判断14・OT 生成物差し替え):**
- golden の入力は OT 生成の**架空**擬似試験 (`mock-exam-page1.png`/`.pdf`)。実在教材・著作物を含まず、ヘッダ/フッタに架空明記 → **本文も含め commit 可**、内容確認 gate 不要。
- **配置**: gitignored の `scripts/ai/ocr-samples/` (実教材 drop-zone) とは別に、**tracked な `tests/fixtures/ocr/` に png/pdf を配置** (commit 済 `2b93d4a`)。理由 = 入力素材 + 派生 fixture (response/expected) を同一 tracked ディレクトリに置き golden を再現可能な自己完結単位にする (Codex 指摘の fixture provenance)。生成元 `mock-exam.html` も OT が `tests/fixtures/ocr/` に配置予定 → **tracked commit** (生成元 provenance・条件追加時の撮り直し再現用。png/pdf だけでは再現不能なため)。
- 擬似問題は 3 条件充足を目視確認済: 問1=正誤組合せ表 + 直後注記行 (②-3 条件) / 問2=選択肢 a〜d に別図 (②-4 target 判定) / 問3=否定設問「正しくないもの」+「現れることはない」+ 単位 mg/%/℃ + 桁区切り 1,500 mg。
- **expected-cards の provenance**: capture 時の `parseOcrResponse` 出力を pin = **parse 層 drift 検出**用であり **OCR 品質の golden ではない** (auto 生成・未校正)。README に明記。

**(D) 完了境界 (判断15 = (ii) 採用・訂正):** ②-0 完了 = 機構 + golden live + **実教材での (b)(c) 初回実走(判定材料一式を OT に提示)まで**。実走を後続に切ると ②-1 着手時に材料が無く、土台を先に作った意味が薄れるため。**分担 = 実行 CC / 判定 OT**(「(b)(c) は OT」は判定の話であって実行を OT に寄せる意味ではない)。実行順 = (b) arm A(5 モデル)→ OT が `--arm-model` 指定 → (b) arm B → (c)(arm A と独立ゆえ順序任意)。**arm B を初回から全モデルで回さない**(--arm-model の決めが無意味になる)。実 API 合図は 1 回にまとめ、capture(T9)と (b) arm A(T10)が続けて走る。
