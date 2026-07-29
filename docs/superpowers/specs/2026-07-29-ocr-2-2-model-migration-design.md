# ②-2: OCR モデル移行(gemini-2.5-flash → gemini-3.1-flash-lite)設計 (spec)

- 日付: 2026-07-29
- Sprint: ②-2(OCR track / ②-1 SDK 版上げの直後)
- 種別: 本番モデル ID の置換(proven・単一点)+ 付随 cost 計上 fix
- モデル: Opus
- 前提: fact-finding = `docs/audit/2026-07-28-ocr-2-2-model-migration-factfinding.md`(§6 に OT 確定事項)

## 1. 目的

本番 OCR pipeline が使うモデルを `gemini-2.5-flash` → `gemini-3.1-flash-lite` へ移行する。②-1 で SDK を分離済のため、**本 sprint の変更源はモデル 1 つ**(+ 独立 commit で cost 計上の latent fix)。移行の妥当性は arm A/B 比較(②-0 T10 で既に 40-45% コスト・致命シグナル同等・box2d go・503 無しを実測済。本 sprint で再確認 + 移行固有項目を観測)で担保する。

## 2. 非目標(凍結・本 sprint で変えない)

- 本番 prompt(`lib/ai/prompts/ocr-extract.ts` / `buildDiscoverPrompt`)。移行後に本文へ混入する `![図](qNNN-img-1)` の**描画側 enforce は ②-3 へ**(§8)。prompt 強化(「不要」→「禁止」)は ②-4 へ(§8)。
- 本番 response schema(`buildDiscoverResponseJsonSchema`)。
- OCR pipeline 構造(`lib/ai/ocr.ts` の retry / fallback / deadline)。
- script 側の baseline literal: `CAPTURE_MODEL_ID` / `BASELINE_MODEL_ID`(= `'gemini-2.5-flash'`)は**比較の基準**ゆえ据え置き(prod モデルとは別概念)。
- golden fixture(1.x-SDK / 2.5-flash 録画)は parse 層 pin ゆえ**据え置き**(モデル変更に対し不変が正)。

## 3. 移行の核 = 単一点(modelId)

prod OCR は flash 単独(`ocr.ts:178 modelChain=['flash']`)。モデル文字列は `lib/ai/cost.ts:38 modelId(kind)` の 1 点で決まる。

- `modelId('flash')` の返り値リテラルを `'gemini-3.1-flash-lite'` に変える(**実体のモデル ID はこの 1 箇所のみ**。二重に書かない — 論点 3)。
- `ModelKind='flash'` は歴史的ラベルとして温存(rename の churn を避ける)。コメントで「実体は modelId() の定数が単一 source」を明示。
- prompt/schema は不変ゆえ、pipeline の他コードは無改変。

## 4. 変更(2 commit・変更源が別)

### 4.1 commit A — モデル移行(migration)

- `lib/ai/cost.ts`:
  - `modelId('flash')` → `'gemini-3.1-flash-lite'`(単一リテラル + コメント)。
  - `PRICING_USD_PER_1M['flash']` を `{input:0.3, output:2.5}`(2.5-flash 単価)→ **`{input:0.25, output:1.5}`**(lite 単価・出典 = `scripts/ai/lib/pricing.ts:9 PRICE_TABLE['gemini-3.1-flash-lite']`)。ModelKind キーゆえ pricing.ts(model 文字列キー・USD eval)とは別テーブルだが lite 単価は一致させる。drift 防止にコメントで pricing.ts を相互参照(統合はしない = 目的/通貨が別・YAGNI)。
- test(`lib/ai/cost.test.ts`): `modelId('flash')` が lite 文字列であることを pin / `estimateCostYen('flash', …)` が lite 単価で算出することを pin(**保証増 = red 検証必須**)。

### 4.2 commit B — thoughtsTokenCount 本体計上 fix(独立 correctness fix)

移行とは別 commit(片方のみ revert しうる・論点 1)。lite は thinking 非返却ゆえ移行では非発火だが、本体の計上ロジックの latent gap を解消する。

- `lib/ai/clients/gemini.ts`: `GeminiCallResult` に `thoughtsTokens: number` 追加(`res.usageMetadata?.thoughtsTokenCount ?? 0`)。
- `lib/ai/ocr.ts`: `OcrPipelineResult.tokenUsage` entry に `thoughtsTokens` を透過(callWithRetry の返り型にも追加)。
- `lib/ai/cost.ts`: `estimateCostYen(model, inputTokens, outputTokens, thoughtsTokens=0)` に第 4 引数追加。**課金 output = outputTokens + thoughtsTokens**(公式: thinking は output 単価。②-0 helper `pricing.ts:39` と同式)。デフォルト 0 で既存呼出は後方互換。
- test: cost.test.ts で thoughts が output 課金に反映されることを pin / gemini.test.ts で thoughtsTokens 露出を pin / ocr.test.ts で pipeline 透過を pin(**保証増 = red 検証必須**)。

## 5. Phase 構成

### Phase 1(offline・実 API 不要・ここで commit)

- commit A(§4.1)+ commit B(§4.2)を実装。
- **回帰確認**: golden test green(parse 層無傷)/ `gemini-sdk-contract.ts` typecheck 通過(SDK 不変ゆえ自明だが gate)。unit test の red 検証(§4)。
- 完了 gate 全通過(§7)。canonical + Codex review → 各 commit `[reviewed]`。

### Phase 2(OT 実 API 合図・arm A/B 比較)

- `scripts/ai/ocr-compare.ts` を **arm mode** で実行: `--arm both --arm-model gemini-3.1-flash-lite`(baseline=2.5-flash と lite を同一画像で比較)。実行手段は既存 script(prod pipeline を経由しない raw call)。
- **判定基準は ②-1 から反転**: ②-1 は「構造差のみ停止・内容差は無視」だったが、**②-2 は内容差(品質差)そのものが評価対象**。取り違えると品質劣化を非決定性として見逃す。→ **diff の目視に依存させず `ocr-compare.ts` の alignment(sort_key/title 突合)+ field-level 原文 diff に寄せる**(揺れと劣化を構造的に区別)。
- **観測項目**: 致命シグナル(数値/単位/否定)の baseline 同等性 / box2d 目視 go / 503 無し / コスト(~40-45% 見込み)/ option id 形式(a/b/c or 数字)/ 表直下空行の有無(detector)/ `![…](…)` 本文混入の頻度。
- **停止条件**: 致命シグナルの baseline 比劣化(数値・単位・否定の取りこぼし)や box2d NG 等、T10 の結論を覆す品質劣化を検出 → **停止して OT に上げる**(②-2 の可否判断は OT・CC 側で決めない)。
- Phase 2 は原則コード変更なし(観測 + 報告)。fixture 上書きなし。

## 6. Phase 順序(commit-then-confirm を既定)

②-0 T10 が lite 品質を実測済(移行の根拠)ゆえ、**Phase 1 で commit → Phase 2 で arm 再確認**(②-1 と同型)を既定とする。arm compare は prod modelId 非依存(script が arm-model を直接叩く)ゆえ commit 前後どちらでも実行可能。品質劣化検出時は revert 可能。

## 7. 完了 gate(全 exit 0)

依存は触らない(install なし)ため frozen-lockfile は不要。

- whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm build` / `pnpm test` / `pnpm test:iso` / `pnpm run audit`
- 既存 flaky(`inline-text-field` / `card-image-gallery`)は当該 file 単体 PASS で切り分け報告(retry 糊塗禁止)。

## 8. 持ち越し(記録)

### ②-3(描画側単一点・prompt を触らない)

- **本文 markdown 画像混入 `![…](…)` の描画側 enforce**。性質は **「cosmetic な癖の調整」ではなく「target 単位契約に対する lite の逸脱を描画側で強制する」**(§fact-finding §1')。→ **契約として test で固定**する形(見栄え調整ではない)。実装点 = `MdTableText` / segment 側の単一点で text セグメントの `![…](…)` を除去 or alt 抽出。壊れ画像は出ない(実害なし)ため ②-2〜②-3 間の本文汚染は許容。

### ②-4(prompt 画像関連の一括整理・②-2/②-3 では触らない)

②-4(図版切り出し)が prompt を触る際にまとめて処理(同一箇所ゆえ最安):

1. `IMAGE_REFERENCE_RULES` 冒頭コメント「画像本体の中身解釈はしない(AI は別冊画像を切り出せない)」(`ocr-extract.ts:108,115`): 別冊は今も正しいが**同一ページ内の図は誤り**(box_2d 座標取得を ②-0 で実証)→ 書き換え。
2. `COMMON_EXTRACTION_RULES` の「画像は抽出しない」(`:233`): ②-4 の方針変更そのもの。放置すると prompt 内矛盾。
3. 「プレースホルダ埋め込みについて」行(`:152-155`)の削除(実測根拠なき消極的打ち消し・lite に非効)。

## 9. commit 構成と tag

- **commit A**(移行): `feat(ai)`(本番モデルの挙動変更)+ `[reviewed]`。canonical + Codex。
- **commit B**(thoughtsTokenCount fix): `fix(ai)` + `[reviewed]`。canonical + Codex。
- **docs**: `docs(...)` + `[no-review]`。
- 重要 Fix 裏取り(決済/認証/削除/外部副作用)には非該当(cost は内部 ocr_cost_yen 計上で Stripe 決済ではない)。arm compare は品質 smoke(実機課金なし)。

## 10. リスクと停止条件

- **停止(即 OT)**: Phase 2 arm compare で T10 結論を覆す品質劣化(致命シグナル劣化 / box2d NG)。Phase 1 で golden/typecheck/build fail(移行が parse/型に波及したシグナル = 想定外)。
- **想定リスク低**: 移行は modelId 1 点 + 単価。prompt/schema 不変ゆえ parse 契約は不変。T10 で lite 品質は実測済。
- **Codex plan cross-check**: 省略(proven 置換・fact-finding 完了・diff 小)。要否は OT 裁量、異議あれば実施。

## 11. spec 凍結

本 spec は実装フェーズで書き換えない。§2 の凍結対象に触れる必要が出たら停止して OT 相談。
