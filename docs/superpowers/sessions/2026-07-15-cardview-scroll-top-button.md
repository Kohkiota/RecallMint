# カードビュー scroll-top ボタン移植(独立 UX task)完了記録

- **日付**: 2026-07-15
- **branch**: `develop`(未 push・OT push 待ち)
- **位置づけ**: Sprint F(カードビュー仮想化)クローズ後の**独立 UX 追加**。Sprint F commit には混ぜない(OT 指示)。
- **着手前宣言**: skill 方針 C(brainstorming/writing-plans 全 skip・OT brief が scope+完了条件+やらないこと+実装手段を 1-2 file 粒度で指定済 + open 論点は read-only 調査で解決)。ただし feat ゆえ TDD + canonical + Codex review は実施。

## 目的・結論

テーブルビュー(`exam-card-table`)にある「先頭へスクロール」ボタンがカードビュー(`InlineCardList`)に無く不便との OT 要望。**テーブルビューと同一 presentation** のボタンを card-view へ移植。カードビューは `useWindowVirtualizer` = **window スクロール**のため検知/click 対象のみ差し替え。**canonical + Codex 双方 Crit0/Imp0 で収束・gate green**。

## commit

| commit | 種別 | tag |
|---|---|---|
| `dfef8e3` | feat(exams): scroll-top ボタン移植(window scroll 版)| `[reviewed]` |
| `85b2b82` | docs(codex): Codex review 記録 | `[no-review]` |

- 触ったファイル: `inline-card-list.tsx`(+38)/ `inline-card-list.test.tsx`(+49)。新 dep なし・migration なし・`.env` 変更なし。

## design 判断(現物調査ベース)

1. **共有 component 化せず分岐(presentation のみ揃える)**: table = element scroll(`tableContainerRef` の collapsed 由来)/ card = window scroll。検知が構造的に別、かつ card-view には condition-bar collapse も selection/action-bar も無く gating も別(単純閾値)。**実重複 2 箇所 = rule-of-three 未満ゆえ共有化しない**(簡潔性規律)。table の Button JSX を verbatim 複製し検知だけ window 版に。
2. **表示検知**: `window.addEventListener('scroll', …, {passive:true})` + `setShowScrollTop(window.scrollY > 400)`。cleanup で同一 fn 参照を remove(leak なし)、mount 時 `onScroll()` 1 回で復元スクロールの初期状態を反映。hysteresis 不要(fixed ボタンは本文レイアウトを変えず collapse のような feedback loop が無い)。onClick = `window.scrollTo({top:0,behavior:'smooth'})`。
3. **`data-testid="scroll-top-button"` 再利用は安全**: `exam-detail-view` が `{view==='card' && …}` / `{view==='table' && …}` で相互排他 render のため 2 ボタンが同時に DOM に載らない(全 .tsx grep で E2E consumer も不在)。
4. **safe-area(`env(safe-area-inset-bottom)`)= 付与しない(要否判断 = 不要)**:
   - ① 参照するテーブルビューのボタンも非付与ゆえ「視覚一致」のため揃える(付与すると reference と乖離)。
   - ② 現 viewport(`app/layout.tsx:66` は `themeColor/width/initialScale` のみ、**`viewport-fit=cover` 不在**)下では `env(safe-area-inset-*)` が**全デバイスで 0(inert)**。
   - ③ その mode では iOS Safari が CSS viewport 自体を safe-area 手前に inset するため、`bottom-4` の fixed ボタンは home indicator と**構造的に被らない**。
   - → env() 追加は無効果 + S2b「先回り実装しない」に反する。**実効対処は `viewport-fit=cover` 導入(app 全 fixed 要素の再検証を要する app-wide 変更・CC 実機検証不可)= 別 sprint 持ち越し**。

## review 結果

- **canonical**(`requesting-code-review` 既定経路・general-purpose + `code-reviewer.md` 改変なし): **Ready to merge = Yes・Crit0 / Imp0 / Minor3**。Minor = ① 閾値 400 vs table 24(**behavioral 差**・plan は視覚一致のみ要求ゆえ許容だが OT へ surface)② presentation 重複(rule-of-three で放置正・3 箇所目で抽出)③ safe-area コメントに parity 論拠追記推奨 → **反映済**。①② は記録のみ。
- **Codex**(`codex-review.sh cardview-scroll-top-button`・canonical 結論非開示): **Crit0 / Imp0 / Minor0**・git clean detector PASS。raw = `docs/codex/2026-07-15-cardview-scroll-top-button.md`。
- fix ループ **1 周で収束**(未解決 Critical 0 かつ Important 0)。

## gate

- whole-repo `pnpm lint`(--max-warnings=0)**exit 0**。
- `pnpm typecheck` **exit 0**。
- `inline-card-list.test.tsx` **30/30 green**(scroll-top 3 test 追加・#1 は threshold=-1 neuter で RED 化して非空振り確認)。

## TDD

RED(button 不在で #2「scroll で出現」/#3「click で window.scrollTo」が fail・#1「初期非表示」は hidden 状態で trivially pass)→ 実装 → GREEN(30/30)→ #1 非空振りを neuter で確認。

## follow-up の解決

- **safe-area(旧 S2b follow-up「iOS 実機で scroll-top ボタン下端が home indicator と被るか未検証」)**: 上記 design 判断 4 により、**現 viewport-fit(cover 不在)下では非該当(構造的に非重複・env() inert)**と結論。「未検証」から「非該当・`viewport-fit=cover` 導入時のみ再燃」へ更新し `docs/next-sprints-priority.md` §4 に記載。
