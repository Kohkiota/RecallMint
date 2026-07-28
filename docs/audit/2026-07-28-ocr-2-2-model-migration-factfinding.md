# ②-2 モデル移行(gemini-2.5-flash → gemini-3.1-flash-lite)fact-finding

- 日付: 2026-07-28
- Sprint: ②-2(OCR track)
- 目的: 移行して初めて画面に出る類の問題を先に潰すための事実収集。**方針決定はしない**(判断材料のみ)。
- 調査方法: read-only(実 API 不使用)。Bash stdout が断続破損したため file 内容は Read tool で直読・path/行番号のみ Bash 併用。

---

## §0 移行の核 = 単一点(modelId)+ 結合変更(pricing)

- prod OCR pipeline は **flash 単独**(`lib/ai/ocr.ts:178` `modelChain=['flash']`・`callWithRetry('flash',…)`・Pro fallback なし)。モデル文字列は **`lib/ai/cost.ts:38 modelId(kind)`** の 1 点で決まる(`flash → 'gemini-2.5-flash'`)。`lib/ai/clients/gemini.ts:109` が `model: modelId(input.model)` で送出。
- **移行 = `modelId('flash')` を `'gemini-3.1-flash-lite'` に変える 1 行**(prompt/schema は不変・`buildDiscoverPrompt`/`buildDiscoverResponseJsonSchema` は無改変)。
- **結合変更(必須)**: `cost.ts:15 PRICING_USD_PER_1M['flash'] = {input:0.3, output:2.5}` は 2.5-flash 単価。lite 移行後もこの値のままだと **lite の token を 2.5-flash 単価で円計上 = 過大**。lite 単価は `scripts/ai/lib/pricing.ts:9 PRICE_TABLE['gemini-3.1-flash-lite'] = {input:0.25, output:1.5}` に既定義。→ cost.ts の flash 単価を lite 値へ更新要。
- **命名の含み(spec 判断)**: `ModelKind='flash'` が実体 `gemini-3.1-flash-lite` を指すのは軽い misnomer。`OcrPipelineResult.modelChain`/`tokenUsage.model`/`estimateCostYen(model)` が ModelKind に依存するため、rename は churn 大。最小は「'flash' を主 OCR モデルのラベルとして温存 + コメント」。
- **pricing 二重定義(事実)**: cost.ts(ModelKind 別・JPY 本体計上)と pricing.ts(model 文字列別・USD eval script)は目的・通貨が別。統合は非推奨だが、lite 単価が cost.ts 側で正しいことの担保が要る。

---

## §1 `![図](qNNN-img-1)` の本文混入(移行後に画面へ出る問題)

- **card content の markdown 描画は `MdTableText` 単一経路**(`components/markdown/md-table-text.tsx`)。app 内に react-markdown 直使用なし(rg 確認: md-table-text.tsx / segment-md-tables.ts / test のみ)。question_text は display で `MdTableText` に渡る(`inline-text-field.tsx:319` 編集面 / `session-runner.tsx` 学習面・同経路)。
- `MdTableText` の挙動(`md-table-text.tsx:31-49`):
  - **text セグメント = 素の text node**(markdown 非処理・`segment-md-tables.ts:45` は表以外を逐語 text 化)。
  - **table セグメントのみ react-markdown**。その `img` override(:33)は **`alt` のみ描画・`<img>` 不出力・src は DOM 未到達**(CSP img-src 回避・不変条件③)。
- **結論**: lite が `![図](qNNN-img-1)` を question_text に混入させた場合 —
  - **表の外(通常の本文)** → text セグメントゆえ **literal 文字列 `![図](qNNN-img-1)` がそのまま表示**(壊れた画像 request は発生しない・strip もされない=見た目が汚い)。
  - **表セル内** → react-markdown img override で **alt(`図`)のみ表示**。
  - いずれも**壊れた `<img src="qNNN-img-1">` は構造的に出ない**(images[] placeholder 非描画設計とは別に、markdown 記法は上記経路で無害化)。
- **gap(判断材料)**: images[] 経由の画像参照設計は「本文に markdown 画像記法が直接来る」ケースを想定していない。表外混入時の literal 表示は cosmetic 劣化。抑制するなら描画側(text セグメントから `![...](...)` を除去 or alt 抽出)= ②-3 と同型の「描画側単一点」。**発生頻度が prompt 依存かモデル依存かはコードからは不明(T10 の実測=モデル依存の傾向)**。

---

## §2 option id 付番方式変更(ア/イ/ウ → a/b/c or 数字)

- **schema に format 制約なし**: `lib/ai/ocr.ts:32 optionSchema.id = z.string()`、`:49 correct_answer_ids = z.array(z.string())`。ア/イ/ウ も a/b/c も等価。
- **突合は値一致(format 非依存)**: `deriveCorrectAnswerIds`(`lib/cards/domain/card-rules.ts:45`)= `options.filter(is_correct).map(o=>o.id)`。correct_answer_ids は「正解 option の id」そのもの。server 再生成(client patch 非信用)。
- **画像添付は id と別の不変 uid**: option は表示ラベル `id` と内部不変 `uid`(UUID)を持ち、画像キーは `option:<uid>`(`use-card-options.ts:86`)。id 形式変更は画像添付に無影響。
- **card 単位で閉じる**: option id は card 内でのみ意味を持つ。横断的に id 形式を仮定する処理は検出されず。→ **既存カナ card と新規 a/b/c card の混在は無害**(各 card が自 card の id を参照)。
- **編集追加時のみ format 推論**: `nextOptionId(existing)`(`lib/cards/next-option-id.ts:14`)= 全 [a-z]→次英字 / 全数字→max+1 / それ以外(カナ/mix/空)→`opt-N`。
  - 現行カナ card に「+ 追加」→ 既に `opt-N`(移行前からの既存挙動)。
  - lite の a/b/c card に「+ 追加」→ `d`(**むしろ改善**)。数字 card→ max+1。
- **結論**: **移行で regression なし**。むしろ新規 card の追加 UX が opt-N → a/b/c/d に改善。唯一の非自明: lite が `a)` や大文字 `A` 等 nextOptionId 非該当形式を出すと追加が `opt-N` fallback(壊れではない・安全側)。

---

## §3 cost.ts の thoughtsTokenCount 未加算 + ②-0 の他 2 件

- **本体の gap(確認)**: `cost.ts:26 estimateCostYen(model, inputTokens, outputTokens)` は input/output 2 種のみ。`outputTokens` は `gemini.ts:153` で `candidatesTokenCount ?? 0`。**thoughtsTokenCount は callGemini が返さず(`gemini.ts` の GeminiCallResult に無い)、ocr.ts も一度も触れない**。→ 本体は thinking 課金を**計上しない**(2.5-flash 等 thinking するモデルで output コスト過小)。
- **②-0 helper との差**: `pricing.ts:39 billedOutputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)`(公式: thinking は output 単価)。lite の欠測 thoughtsTokenCount を 0 扱い。→ helper は正しく、本体だけ未対応。
- **修正範囲(見積)= 3 file**: ① `gemini.ts` の GeminiCallResult に thoughtsTokenCount 追加(`res.usageMetadata?.thoughtsTokenCount`)② `ocr.ts` の tokenUsage に透過 ③ `cost.ts estimateCostYen` の output 側に加算。
- **lite との関係**: 3.1-flash-lite は thinking 非返却(実測)ゆえ **移行自体はこの gap を発火させない**(欠測=0)。本体の correctness gap は latent。→ **②-2 に含めるか別 sprint かは OT 判断**(cost.ts を単価で触るついでに直す=機会的 / scope 最小主義なら別立て)。
- **他 2 件(判断材料)**:
  - **2.5-pro >200k tier 未モデル化**: `modelId('pro')`/`estimateCostYen('pro')` は **prod OCR で不到達**(pipeline flash 単独・他の `'pro'` 出現は Stripe plan で無関係)。→ ②-2 無関係・**据え置き妥当**。
  - **audio input rate 未対応**: OCR pipeline に audio mime 経路なし(rg で 0 hit)。→ ②-2 無関係・**据え置き妥当**。

---

## §4 表直下の空行(②-3 の要否判定)

- **空行はモデル生出力由来**(描画解釈由来ではない): `segmentMdTables`(`segment-md-tables.ts`)の不変条件 = 「value 連結 === 入力(完全一致)」(:6-9)。表前後の空行を **trim せず逐語保存**。描画は保存するだけ。
- **detector は既存**: `scripts/ai/lib/blank-line-below-table.ts analyzeTablesBlankLine(text)` が table segment 直後 text の空行始まり(`/^\r?\n[ \t]*\r?\n/`)を per-table 判定。②-0 の eval signal で ocr-compare が消費。
- **②-3 は未実装**: ②-0 spec `docs/superpowers/specs/2026-07-27-ocr-regression-foundation-design.md:37` 「表直下空行の**修正**(②-3)。本 sprint は有無を観測するだけ」。:143 「detector は ②-3 に流用しうるが本 sprint では scripts 側に置き lib/ 昇格しない(scope creep 回避)」。→ ②-3 = 描画側の決定的 fix(単一点)は**設計文書なし・未着手**。
- **結論 / 判断材料**: ②-2 の compare(arm A/B)に「表直下空行の有無」は既に eval signal として乗る。T10 では lite=空行あり / 2.5-flash=なし(kickoff 記載)。移行で空行が**増える**可能性はあるが、**②-3 の描画側決定的 fix でモデル任せにせず吸収**する方針は不変(観測結果に関わらず ②-3 は取り消さない)。→ ②-2 は**観測項目に含める**のみ・fix はしない。

---

## §5 判断材料まとめ(OT へ)

| # | 項目 | 事実 | ②-2 での扱い(判断材料) |
|---|---|---|---|
| 0 | 移行本体 | modelId 1 行 + cost.ts flash 単価を lite 値へ | 必須(単価更新は結合必須)。ModelKind 命名は温存 or rename の判断 |
| 1 | 本文 markdown 画像混入 | MdTableText で literal 表示(壊れ画像なし)。表外=literal / 表内=alt | cosmetic 劣化。描画側で抑制するか(②-3 型)= 判断 |
| 2 | option id 形式 | 値一致・card 内閉・uid 別・混在無害・追加は改善 | **対処不要**(regression なし) |
| 3 | thoughtsTokenCount 本体 | 未加算(latent)。lite は非発火。修正 3 file | ②-2 で機会的に直すか別 sprint か = 判断 |
| 3b | 2.5-pro tier / audio | prod OCR 不到達 / 経路なし | **据え置き**(②-2 無関係) |
| 4 | 表直下空行 | モデル出力由来・detector 既存・②-3 未着手 | 観測のみ・fix は ②-3(不変) |

**移行が実際に触る file(最小)**: `lib/ai/cost.ts`(modelId + flash 単価)。thoughtsTokenCount を含めるなら + `lib/ai/clients/gemini.ts` + `lib/ai/ocr.ts`。§1 の描画抑制を含めるなら + `components/markdown/md-table-text.tsx`(or segment 側)。

**実 API 比較(arm A/B)は spec 確定後・OT 合図で ocr-compare.ts 実行**(fact-finding では未実行)。
