# ocr-samples — 実教材 drop-zone (非 commit)

②-0 OCR 比較 (`ocr-compare.ts`) と box_2d 可視化 (`ocr-box2d-viz.ts`) が使う**実教材画像**の置き場。

- **このディレクトリの中身は gitignore される**(この `README.md` のみ追跡)。実教材は著作物 / PII を含みうるため commit しない。
- OT が試験画像 (3〜5 枚・png/jpg/jpeg/webp。box_2d 可視化は `<img>` 描画のため PDF 不可) をここに置く。
- 実行出力は `scripts/ai/ocr-samples/out/`(gitignore)へ。
- **golden fixture 用の擬似問題は別**: `tests/fixtures/ocr/`(追跡・架空)にある。capture / golden はそちらを使う。

詳細な実行手順: `docs/ops/ocr-regression-foundation-runbook.md`。
