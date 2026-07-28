# tests/fixtures/ocr — OCR golden fixtures

`lib/ai/ocr-golden.test.ts` が使う「実 Gemini 応答 → parse 出力」の golden fixture 一式。

## 中身

| ファイル | 内容 | 追跡 |
|---|---|---|
| `mock-exam-page1.png` / `.pdf` | golden 入力(架空の擬似試験問題・OT 生成) | commit |
| `<name>.response.json` | 本番モデル (`gemini-2.5-flash`) + 本番 prompt/schema での**生応答 text(逐語)** | commit |
| `<name>.expected-cards.json` | `parseOcrResponse(<name>.response.json)` の出力 `ExtractedCard[]` を pin | commit |

## 生成方法(再現)

```
tsx --env-file=.env.local scripts/ai/ocr-capture-fixture.ts --image tests/fixtures/ocr/<name>.png --name <name>
```

`scripts/ai/ocr-capture-fixture.ts`(T5)が response と expected-cards を pair で atomic に書く(既存は上書きしない)。

## provenance / 意味(誤解防止)

- `expected-cards.json` は **capture 時の `parseOcrResponse` 出力の auto 生成**であり、**人手校正されていない**。= **OCR 品質の golden ではない**。
- golden test が検出するのは **parse/validate 層(`parseOcrResponse` / zod)の drift のみ**。モデル出力そのものの drift は検出しない(録画応答は凍結)。②-1/②-2 でのモデル出力変化検出は「再 capture して baseline と diff」or「`ocr-compare.ts` 再実行」が実体。SDK 形状 drift は `lib/ai/clients/gemini-sdk-contract.ts` が `pnpm typecheck` で検出(別レイヤー)。
- 内容は**架空**(擬似試験問題)ゆえ本文込みで commit してよい(判断14)。実教材由来の応答は commit しない。

詳細: `docs/superpowers/specs/2026-07-27-ocr-regression-foundation-design.md` §4-(a) / `docs/ops/ocr-regression-foundation-runbook.md`。
