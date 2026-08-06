# ②-3 本文 markdown 画像記法の描画側 enforce — 完了記録

- 日付: 2026-07-29
- Sprint: ②-3(OCR track)
- 状態: **実装完了・未 push**(feat 1 commit `[reviewed]`)。描画変更ゆえ smoke 要否は OT 判断。
- spec: `docs/superpowers/specs/2026-07-29-ocr-2-3-inline-image-enforce-design.md`(§4.2 に実装時修正の記録)
- plan: `docs/superpowers/plans/2026-07-29-ocr-2-3-inline-image-enforce.md`

## commit(develop・未 push)

| SHA | 内容 | tag |
|---|---|---|
| fdc8e0d | fact-finding | `[no-review]` |
| a3b7f3c / 301bc6b | spec 起草 + AST-offset 修正 | `[no-review]` |
| a7d040e / dfa1552 | plan + 311行判断記録 | `[no-review]` |
| `05703b7` | **feat**: 本文 markdown 画像記法を描画側で除去(AST-offset・契約 test 固定) | **`[reviewed]`** |

(この上に ②-2 P2 `ceb228d` / FF・spec・plan の docs も未 push)

## 実装結論

- **`stripInlineImages`(pure・`lib/markdown/strip-inline-images.ts`)**: mdast の image/imageReference ノードの position offset を取り、元文字列から後ろ向きに該当範囲のみ削除。**AST を再文字列化しない**(改行/表整形を壊さず「改行 \n 保持」prompt ルール + segmentMdTables 不変条件と両立)。regex 不使用ゆえ code span / code block / escape `\![` / nested paren / reference を誤らず、**正解選択肢を消さない**(canonical adversarial probe + unit test で実証)。空白 3 分岐(行唯一→行削除 / 段落途中→構文のみ / 表セル→区切り温存)。冪等 + 性質(再 parse で image ノード 0)pin。
- **strip の適用点 = markdown 描画経路の entry point**: `segmentStrippedForRender(value) = segmentMdTables(stripInlineImages(value))` を `MdTableText` / `MdTableBlock` が使用。hasTable 判定と描画が**同一の strip 後 segments** を共有。`MdTableSegments` は raw 描画へ戻し**非 export 化**(この 2 component の内側での bypass footgun 除去)。`img: () => null` は防御。
  **適用範囲は「この 2 component を通る描画」に限られ、card 本文がユーザーに届く全経路を覆ってはいない**(2026-08-06 の stg smoke で確定)。実例 = upload result page の preview は `lib/exams/list.ts` の `snippet(question_text, 80)` を素のテキストとして出しており strip を通らず、`![](q010-img-1)` が生表示される。**当初この bullet は「単一点 = entry-point strip」と書いていたが、その完全性の主張は偽だった。** 経緯と観測 = `docs/superpowers/sessions/2026-08-06-ocr-2-4a-close-stg-smoke.md` §4 / 教訓 = `docs/superpowers/lessons/2026-08-06-single-point-claims-decay-silently.md`。
- **契約変更(意図的)**: `md-table-text.test.tsx` の旧 pin『表内画像記法 → alt 表示』を『alt も出さない(非表示)』へ。target 単位契約の描画側強制であり見栄え調整ではない = 契約を test で固定し直した。
- **既存データ**: render 時処理ゆえ ②-2 後の混入カードも migration なしで一律救済。

## review(fix ループ)

- **canonical**(2 回): r0 → Ready With fixes(Minor 1=stale header 修正)。**最終 wiring 再レビュー → Ready to merge=Yes / Critical 0 / Important 0 / Minor 2**(MdTableSegments 非 export 化・p/div test hardening とも対処)。両回とも helper の AST-offset・image-only・no-restringify を独立検証。
- **Codex**(3 回・収束): **r1 Important 1**(cross-segment reference: セグメント独立 parse は definition が別セグメントの `![x][id]` を解決できず除去漏れ)→ **r2 Important 1**(r1 修正が導入: whole-value re-segment で hasTable 変化 → `<table> in <p>` mismatch)→ **r3 Critical 0 / Important 0 / Minor 0**(entry-point strip で両方構造的に解消)。
- **教訓**: r1 の「whole document で strip」修正が r2 の wrapper 不整合を生んだが、**strip を entry point に置き hasTable/render を同一 segments に揃える**ことで両方を一度に解消(patch でなく構造修正)。Codex md = `docs/codex/2026-07-29-ocr-2-3-inline-image{,-r2,-r3}.md`。

## 完了 gate(全 exit 0)

- whole-repo `pnpm lint --max-warnings=0`: **0**
- `pnpm typecheck`: **0**
- `pnpm build`: **0**
- `pnpm test`: **0**(252 files / 4041 tests・既存 flaky も今回 fail せず)
- `pnpm test:iso`: **0**(217)
- `pnpm run audit`: **0**(prod high 0 / dev high 1 = brace-expansion allowlist)

## smoke 判断材料(OT へ)

描画変更ゆえ stg smoke 候補。**何を見れば十分か**:
- 演習(学習面)/ 編集面で、本文に `![…](…)` を含むカードを表示 → **literal な `![…]` 文字列も壊れ画像も出ない**こと。表内・表外の両方。
- 表を含むカードで表構造が保たれる(区切り温存・`<table> in <p>` の hydration warning が console に出ない)こと。
- 画像記法を含まない通常カードの表示が**不変**(回帰なし)。
- stg での混入カードは ②-2 移行後の実 OCR で生成されたものが対象(`![…](qNNN-img-N)` 混入は arm 比較で 3 画像中 2 に観測)。mirror 直注入でも再現可。

## 持ち越し(②-4)

spec §7 記録済: prompt 画像記述 3 件整理 / bbox 保持 / ambiguous target 許容 / test 素材(mock-exam-page2 tracked + 実教材 non-commit)。
