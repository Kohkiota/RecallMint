# ②-1 @google/genai 2.x 版上げ — Phase 2(再 capture + baseline diff)記録

- 日付: 2026-07-28
- Sprint: ②-1(OCR track)
- 前段: `2026-07-28-genai-2x-bump-phase1.md`(Phase 1 = bump 本体・全 gate green)
- 状態: **Phase 2 完了。②-1 全体完了(未 push 分は Phase 1 で OT push 済 → Phase 2 は commit ゼロ)**

## 実行

- **使用モデル**: `gemini-2.5-flash`(本番 modelId・凍結対象・不変)
- **SDK 版**: `@google/genai@2.13.0`(Phase 1 で bump 済)
- **入力**: `tests/fixtures/ocr/mock-exam-page1.png`(baseline と同一画像)
- **手段**: 使い捨て harness(`scripts/ai/recapture-phase2-tmp.ts`・実行後削除)から既存 `runCapture({imagePath, name, fixturesDir})` を `fixturesDir` = scratchpad で呼出。本番 prompt/schema・単回呼出(retry なし)。
- **書込先**: scratchpad(`<scratchpad>/ocr-recapture/`)のみ。**tracked `tests/fixtures/ocr/` には一切書込なし**(実行後 `git status` 空・fixtures 無変更を確認)。

## 判定結果 = PASS

### 最重要実証: parse 成功(zod schema 通過)

再 capture で `mock-exam-page1.expected-cards.json` が生成された = **2.13.0 SDK の応答が本番 `parseOcrResponse`(zod responseSchema)を通過**した。mock テストでは得られない、実応答 × 実 SDK × 実 schema の互換実証。**これで SDK 互換は確定**。

### 構造差: ゼロ(SDK 起因の非互換なし)

JSON 型シェイプ(key path + 型・値は無視)を機械比較:
- **RESPONSE(生応答 text の envelope)**: baseline と new で型シェイプ完全一致。
- **CARDS(`ExtractedCard[]`)**: 型シェイプ完全一致。field 集合 = `correct_answer_ids, images, options, question_text, sort_key, title`(両者同一)。card 枚数 = 3(両者同一)。
- field の増減・rename・型変化・envelope 変化 = **検出ゼロ**。

### 内容差: あり(Gemini 非決定性・想定内・合格)

同一画像・同一 prompt でも値は揺れる:
- `sort_key`: `"1"` → `"001"`(ゼロ埋めの揺れ)。連動して image `key` も `q2-img-1` → `q002-img-1`。
- `question_text`: 字句の揺れ(`120 °C` → `120 ℃`・注記行 `※表中…` の有無)。
- option `text`: 読取の揺れ(`"a"/"b"/"c"/"d"` → `""`)。
- image `alt`: 描写の揺れ(`四角形/円/三角形/星形` → `図形a/図形b/図形c/図形d`)。

いずれも同一 field・同一型の値変化。**構造差ではない**。OT 判定基準「内容が揺れても parse が通れば合格」に合致。

## 結論

②-1 の第二目的(②-0 検出機構が版上げに機能する実証)を Phase 1(型契約 typecheck / golden / mock)+ Phase 2(実応答 parse 通過 + 構造差ゼロ)で完遂。**SDK 互換確定・②-2 へ持ち越す SDK 起因リスクなし**。tracked fixture は無変更(baseline は 1.x 録画のまま = parse 層 pin として不変・SDK 非依存ゆえ正しい)。
