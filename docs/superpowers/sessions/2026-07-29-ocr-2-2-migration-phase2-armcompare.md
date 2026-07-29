# ②-2 OCR モデル移行 — Phase 2(arm A/B 比較)記録

- 日付: 2026-07-29
- Sprint: ②-2(OCR track)
- 前段: `2026-07-29-ocr-2-2-migration-phase1.md`(Phase 1 = 移行 + thoughts fix・全 gate green・OT push 済)
- 状態: **Phase 2 完了 = ②-2 全体完了(判定 PASS・停止条件非該当)**。commit ゼロ(観測 + 報告のみ)。

## 実行

- command: `pnpm exec tsx --env-file=.env.local scripts/ai/ocr-compare.ts --images scripts/ai/ocr-samples --models gemini-2.5-flash --arm both --arm-model gemini-3.1-flash-lite`
- `--models gemini-2.5-flash` 指定で baseline のみに絞り(DEFAULT_MODELS 全 5 sweep を回避)、arm A = [2.5-flash, lite 自動追加] + arm B = [lite]。**3 leg × 3 画像 = 9 実 call**。無関係モデル(3.5-flash-lite/3.6-flash/3.5-flash)は sweep せず(OT: 5 倍単価の根拠なし)。
- 対象 = 実教材 sample 3 画像(`scripts/ai/ocr-samples/`・gitignore 済・非 commit)。出力 = `out/compare-both-gemini-3.1-flash-lite-<ts>.{md,json}`(gitignore 済・**実教材ゆえ非 commit**)。
- exit 0(429 halt なし・全 finishReason=STOP)。

## 判定 = PASS(致命シグナル劣化なし)

**判定軸(唯一の合否)= 致命シグナル(数値/単位/否定)の field-level 原文 diff。** report の "(missing)" 大量出力は **sort_key 表記揺れ("001" vs "1")+ option id 表記揺れ**(この run では baseline=latin a/b/c・lite=kana ア/イ/ウ)による alignment 齟齬で、同一 card が別 key 扱いされているだけ(OT 警告どおり・fact-finding で無害確定ゆえ評価対象外)。内容を手動照合した結果:

- **数値**: 主要 3 税目 / 物価指数の表数値(基準年・比較年の価格/数量)/ 指数値(95・114・120)/ 年(2023)= **全一致**(全角³ ↔ 半角 3・空白有無 等の表記差のみ・値は不変)。
- **否定**: 「含まない」「含まれない」= **全保持**。
- **単位・記号**: 保持。
- **card/option 脱落なし**: optionCount 一致(5/5・5/5・4/4)。card 数一致。

→ **lite は致命シグナルを baseline 同等に保持。停止条件(致命劣化/box2d NG)非該当。**

## 観測(判定軸外)

- **コスト(1 画像 USD)**: lite/baseline = 36.5% / 32.3% / 33.6% ≈ **約 34%**(想定 40-45% より安い)。baseline 2.5-flash は thoughts 969-1446 token を **commit B の fix で正しく計上**しており、lite(thoughts N/A = thinking 非返却)との差が正確に反映された(thoughts fix の実効性も間接実証)。
- **arm B(box_2d)**: 3 画像とも STOP + parse 成功 = **機能 go**(503 なし)。視覚 box2d go は ②-0 T10 実証済(本 run では再実施せず)。
- **503**: なし。
- **表直下空行**: baseline chushou1 の 1 表 = 空行なし。lite は表を blockquote 化(shared_context 内)= root-level detector 対象外。→ ②-3 判定材料は限定的(lite は表を blockquote に寄せる傾向)。
- **`![…](…)` 本文混入**: lite が 3 画像中 **2** で question_text に混入(`![下図](qN-img-1)` / `![](qN-img-1)`)。**②-3 持ち越し材料(target 単位契約への逸脱)**。頻度は中程度。

## 結論

lite への移行は**品質面で安全**(致命シグナル保持・脱落なし・コスト約 34%)。②-2 完了。SDK(②-1)とモデル(②-2)を分離した狙いどおり、変更源 1 つで品質確認できた。持ち越し = ②-3(本文 `![…](…)` 描画側 enforce = 契約強制)/ ②-4(prompt 画像 3 件)。
