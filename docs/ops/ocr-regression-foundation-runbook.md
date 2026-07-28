# ②-0 OCR 回帰検出の土台 — 実行 runbook

- 対象: `scripts/ai/ocr-capture-fixture.ts`(capture)/ `scripts/ai/ocr-compare.ts`(モデル比較 b)/ `scripts/ai/ocr-box2d-viz.ts`(box_2d 可視化 c)
- 正本 spec: `docs/superpowers/specs/2026-07-27-ocr-regression-foundation-design.md` / plan: `docs/superpowers/plans/2026-07-28-ocr-regression-foundation.md`
- 前提: すべて `tsx` 直実行。実 Gemini を叩くのは capture / (b) / (c) のみで、**OT の実 API 合図でのみ実行**(CC は自発的に叩かない)。**429 受信で即停止・リトライしない**。`GEMINI_API_KEY` は `.env.local`。

## 0. 素材の使い分け(重要)

| 用途 | 置き場 | commit | 内容 |
|---|---|---|---|
| golden (capture) | `tests/fixtures/ocr/mock-exam-page1.png` / `.pdf` | **追跡(commit 済)** | 架空の擬似試験問題 |
| (b) 比較 / (c) box_2d | `scripts/ai/ocr-samples/`(README 以外) | **非 commit**(gitignore) | OT が置く実教材(3〜5枚・png/jpg/jpeg/webp) |
| 実行出力(レポート / HTML) | `scripts/ai/ocr-samples/out/` | 非 commit(gitignore) | — |

commit するのは `tests/fixtures/ocr/` の**応答 fixture のみ**(実教材そのものは commit しない)。box_2d 可視化は `<img>` 描画のため **PDF は不可**(渡しても skip + warn される)。

## 1. OT gate と実行順(実 API 合図は 1 回)

OT が実教材を `scripts/ai/ocr-samples/` に配置し、**実 API 実走の合図を 1 回**出す。合図後、CC が下記 batch1 を続けて実行する。

### batch1(合図後・CC 実行)

1. **golden capture**(擬似問題):
   ```
   tsx scripts/ai/ocr-capture-fixture.ts --image tests/fixtures/ocr/mock-exam-page1.png --name mock-exam-page1
   ```
   → `tests/fixtures/ocr/mock-exam-page1.response.json` + `.expected-cards.json` を commit → golden test(`lib/ai/ocr-golden.test.ts`)が green 化。
2. **(b) arm A sweep**(5 モデル・実教材):
   ```
   tsx scripts/ai/ocr-compare.ts --images scripts/ai/ocr-samples --arm A
   ```
   → `scripts/ai/ocr-samples/out/compare-armA-<ts>.md`(+ JSON)を OT に提示。
3. **(c) box_2d 可視化**(実教材・arm A と独立ゆえ同 batch):
   ```
   tsx scripts/ai/ocr-box2d-viz.ts --images scripts/ai/ocr-samples
   ```
   → 画像毎の `scripts/ai/ocr-samples/out/<filename>.html` を OT に提示(ブラウザで矩形を目視)。
   - **HTML の開き方**: VS Code の Live Preview 拡張で右クリック → Show Preview、または `python3 -m http.server`(ポート転送)で開く。HTML は画像を base64 で自己完結しているため、**コンテナ外へコピーしても表示可能**。

### OT gate 2 → batch2

4. OT が arm A 結果を見て **arm A/B 比較モデル `--arm-model` を指定**。
5. **(b) arm A/B 比較**(指定モデルで両 arm 実行):
   ```
   tsx scripts/ai/ocr-compare.ts --images scripts/ai/ocr-samples --arm both --arm-model <OT指定モデル>
   ```
   → `compare-both-<model>-<ts>.md` を OT に提示。

> **コマンド訂正(重要)**: plan / spec の当初記載では batch2 を `--arm B` としていたが、`--arm B` 単独では arm A の脚が無く A/B ペアを作れない(T6 review で判明)。**正しくは `--arm both --arm-model X`**(arm A と arm B を同一 run で X に実行しペアを形成)。standalone `--arm B` はスクリプトが reject する。

## 2. 出力の見方(判定は OT)

比較レポートは「平均文字誤り率」でなく、以下が埋もれない並び:

- **致命的差分**(先頭): 否定語の有無 / 数値 / 単位 / 記号の変化(field-level 原文 diff が正本。否定・数値・単位・記号の強調は補助)。
- 選択肢の**個数**と**末尾選択肢の欠落**(「MISSING TAIL OPTION」= 個数減 / 「tail option id changed」= 並べ替え・改称)。
- 各本文フィールドの**表直下空行の有無**(②-3 判定用。root-level 表のみ・blockquote 内表は対象外)。
- **1 画像あたり実コスト**(USD・課金 output = candidates + thoughts・現行 `gemini-2.5-flash` 比。usage 欠測は `N/A`)。
- finishReason(末尾欠落が出力上限打切りか否かの判別)。

スクリプトは実行・観測・整形のみ。良し悪しの判定は OT が行う。

## 3. drift 検出の役割分担(誤解防止)

- **golden test** は「実応答 → parse/validate 層の出力」を pin する = **parse 層の drift のみ**を検出する。モデル出力そのものの drift は捕まえない。expected-cards は capture 時の parse 出力の auto 生成 = **OCR 品質の golden ではない**(未校正)。
- **②-1(SDK 版上げ)/ ②-2(モデル移行)での変化検出**の実体 = **再 capture して baseline(committed fixture)と diff** する、または **(b) を再実行**してモデル間差を見る。
- **SDK 形状の drift** は `lib/ai/clients/gemini-sdk-contract.ts` が `pnpm typecheck` で検出する(別レイヤー)。

## 4. 応答不能時 / エラー

- あるモデルが応答しない(例: `gemini-2.5-flash` が 2026-10-16 前倒し shutdown で不可)場合、その事実がレポートに error 分類(http-status / model-not-found / 429 / timeout / parse / empty)で出る。他モデルは続行。**429 のみ run 全体を即停止**(exit code 非ゼロ)。
- その場合 ②-2 は「移行判断」でなく「期限対応」になる(OT 判断)。
