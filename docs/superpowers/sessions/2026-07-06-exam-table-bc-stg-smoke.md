# Exam 詳細テーブル B+C fix — stg smoke(2026-07-06)

対象: `stg.recallmint.nekotest.net` / exam `5d51078f-0ff1-4568-a2a2-1403b5eeb2c9`(アップロード実データ・25 card・選択肢縦積みで行高 443px)。
ツール: Playwright MCP(chrome-devtools MCP は Target closed で起動不可 → memory の fallback 規約どおり切替)。
commit: develop `9e26995`(fix `[reviewed]`)反映後の stg。**全項目 PASS / console errors 0**。

## 結果サマリ

| 項目 | 結果 | 証拠 |
|---|---|---|
| B-1 select セル余白 click で行選択トグル ON | PASS | cell(443px 高・checkbox は top 6px)中央 click → checked=true / "1件選択中" |
| B-2 同セル再 click でトグル OFF | PASS | 再 click → checked=false / 選択数 UI 消滅 |
| B-3 checkbox 本体 click で二重発火せず単発トグル | PASS | checkbox 直 click → checked=true /"1件選択中"(stopPropagation で net no-op 回避) |
| B-4 th 全選択セル余白 click で全行トグル | PASS | elementFromPoint(22,125)=TH(非 checkbox)確認 → click → 全 25 選択 / header checked / 可視 7 行全 checked。再 click で全解除(0 / header unchecked) |
| B-5 非 select セル(問題文)click は選択非トグル | PASS | 問題文 cell click → textarea focus(inline 編集起動)/ 選択数 0 のまま |
| C-1 全列セル上揃え | PASS | body td 11 列すべて computed `vertical-align: top` + `align-top` class |
| C-2 長文セル複数行の上端揃い | PASS | screenshot(問題文複数行・選択肢 5 段・タグ +・解説 が行 top で揃う) |
| C-3 checkbox 上寄せ | PASS | 443px 行で checkbox top offset = 6px(中央 ~215px でない) |
| C-4 選択肢セル縦積み上揃え | PASS | screenshot(5 選択肢が top から縦積み) |
| C-5 pinned 列 上揃え + sticky 両立 | PASS | タイトル列 pin → select td(sticky/left 0)+ title td(sticky/left 32px)とも `vertical-align: top`。横 scroll 300px で固定保持。崩れなし |
| C-6 header th は align-middle 維持 | PASS | thead th computed `vertical-align: middle`(意図どおり body のみ top 化) |
| console errors 0 | PASS | セッション全体 errors=0(warning は Permissions-Policy 未知 feature + Clerk dev-keys のみ = 環境ノイズ・B+C 無関係) |

## 補足

- タグセル縦積み(C の一部): 本 exam はタグ未割当のため縦積み実データなし。ただしタグ列 td は computed `vertical-align: top` を確認済(構造的に全列一律)。実タグ縦積みの目視は別 exam / 別 task で担保可(cosmetic・低リスク)。
- 検証手法: 動作系(B)は Playwright click + React state 確定後の DOM 再読。th 余白 click は `elementFromPoint` で「checkbox でなく TH」を確認してから bubbling click を dispatch(余白当たり判定の faithful 再現)。align 系(C)は `getComputedStyle().verticalAlign` を正とし screenshot を補助証拠に。
- 副作用復元: pin は examViewPrefs V3 永続のため smoke 後に unpin して原状復帰(title td = static 確認済)。

## screenshot

- `assets/exam-bc-smoke-topalign-clean.png` — 通常表示・全列上揃え(選択肢 5 段・問題文複数行が top 揃い)
- `assets/exam-bc-smoke-pinned-scrolled.png` — タイトル列 pin + 横 scroll 300px(pinned 2 列が左固定・top 揃い保持)
- `assets/exam-bc-smoke-topalign.png` — 問題文 inline 編集起動時(B-5 の非トグル確認時)
