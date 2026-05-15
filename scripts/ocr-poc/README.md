# OCR PoC (Phase 0b)

Gemini 2.5 の OCR + 構造化抽出精度を測る独立スクリプト。本実装 (`lib/ai/`) には影響しない。
PoC で精度が確認できたら `lib/ai/gemini.ts` に昇格させる。

`docs/02-tech-spec.md §7` の Structured Output パターン
(`responseMimeType: 'application/json'` + 動的 `responseSchema`) を縮小コピーしたもの。

## ファイル構成と役割

| ファイル        | 役割                                                                                                                                                                | こういう時にいじる                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **`prompt.ts`** | **AI への指示文 (system + user prompt)**。何をどう抽出してほしいか、`custom_props` の埋め方ルール、画像/レイアウトの扱い等                                          | **AI の挙動を変えたい時はまずここ**。誤抽出が多い、特定フィールドの説明を足したい、自由発見モードを試す等                          |
| `schema.ts`     | `property_schema.json` (`PropertyDef[]`) を Gemini の `responseSchema` に変換するビルダ。`single_select`→STRING+enum、`multi_select`→ARRAY+enum、`number`→NUMBER 等 | 新しい `type` (boolean / date / text) をサポートしたい、必須フィールド (`title` / `question_text` / `options` 等) の構造を変えたい |
| `run.ts`        | CLI エントリ。引数解釈 / fixture 読み込み / Gemini 呼び出し / フォールバック制御 / 結果 JSON 保存                                                                   | CLI 引数を増やしたい、フォールバック発動条件 (cards=0 等) を変えたい、出力 JSON の `meta` を増やしたい                             |
| `cost.ts`       | `usageMetadata` のトークン数から円換算。Flash / Pro の単価と JPY/USD レートを直書き                                                                                 | Gemini 公式価格改定、円ドルレート変更                                                                                              |
| `fixtures/`     | 試験ごとの PDF + `property_schema.json` (gitignored)                                                                                                                | PoC 対象を追加する                                                                                                                 |
| `results/`      | 実行結果 JSON (gitignored、自動生成)                                                                                                                                | —                                                                                                                                  |

> **ちょい変えたい時の決定木**
>
> - AI への伝え方を変えたい → `prompt.ts`
> - AI に「何を抽出してほしいか」の枠を変えたい → fixtures の `property_schema.json`
> - 抽出する値の **型** を増やしたい (現状 single_select / multi_select / number のみ) → `schema.ts`
> - 抽出する **標準フィールド** (title 等) を変えたい → `schema.ts` (固定部)
> - 上記いずれでもない挙動を足したい → `run.ts`

## fixture 配置

```
scripts/ocr-poc/fixtures/<exam>/
├── property_schema.json   PropertyDef[] (docs/02-tech-spec.md §2.5.1)
├── *.pdf                  1 件以上 (50 ページ未満を推奨)
└── ...
```

`property_schema.json` の例:

```json
[
  {
    "name": "章番号",
    "type": "single_select",
    "select_options": ["第1章", "第2章"],
    "display_order": 1
  },
  {
    "name": "区分",
    "type": "single_select",
    "select_options": ["前編", "後編"],
    "display_order": 2
  }
]
```

ここに書いたフィールドが AI 抽出結果の `cards[].custom_props` のキーになる。
**PDF から明示的に読み取れるメタだけを書く** (分類・難易度等、事前知識や意味推論が必要なものは入れない)。

## 実行

```bash
# 単発 Flash
pnpm tsx scripts/ocr-poc/run.ts <exam>

# Pro
pnpm tsx scripts/ocr-poc/run.ts <exam> --model pro

# Flash → Pro フォールバック (Flash が parse 失敗 or cards=0 のとき)
pnpm tsx scripts/ocr-poc/run.ts <exam> --fallback

# フォールバック経路を強制検証 (Flash をスキップして失敗模擬)
pnpm tsx scripts/ocr-poc/run.ts <exam> --fallback --simulate-flash-fail
```

`.env.local` に `GEMINI_API_KEY` が必要。

## 出力

`results/{exam}_{model}_{timestamp}.json`:

```json
{
  "cards": [
    /* responseSchema.cards.items に従った構造化抽出 */
  ],
  "meta": {
    "exam": "sample-001",
    "model_used": "flash",
    "model_chain": ["flash"],
    "fallback_enabled": false,
    "simulated_flash_fail": false,
    "duration_ms": 12345,
    "input_tokens": 8421,
    "output_tokens": 1932,
    "estimated_cost_yen": 1.04,
    "pdf_files": ["sample-001/material-01.pdf"],
    "property_schema_count": 3
  }
}
```

フォールバック経由で Pro まで進んだ場合は `model_chain: ["flash", "pro"]` と `flash_error` が記録される。

## やっていないこと

- DB 保存 / 画像 bbox 抽出 / 50 ページ超の PDF 分割 / UI / API Route 化
- `lib/ai/` への変更 (PoC は独立)
- `fixtures/` と `results/` は `.gitignore` で commit 対象外

## コスト推定の根拠

`cost.ts` の `PRICING_USD_PER_1M` に Gemini 2.5 公式単価を直書き
(Flash: in $0.30 / out $2.50、Pro: in $1.25 / out $10、150 JPY/USD)。
公式値が変わったら手動更新。
