# S1 stg smoke — 動的ヘッダーメニュー + 条件バー(2026-07-03)

- 環境: `https://stg.recallmint.nekotest.net`(develop HEAD b844c6e デプロイ反映済)
- ツール: Playwright MCP(chrome-devtools MCP は Target closed で不可 → memory どおり fallback)
- 対象 exam: ①②③⑤ = 39-card(`17af78ea`)/ ④ = `[PERF-SEED] 300-card`(`fb10b7cf`)
- 全項目 **PASS**・console error 0(全 exam ページ)・回帰/破壊なし

## stale deploy チェック(前提)
既定 view で列トグルが `ml-auto`=true・条件ゼロで ConditionBar=null・wrapper 子1個でも toggle が右端(left 953/right 1011=wrapper 右端一致)。**M1 fix がデプロイ反映済 = 最新 build 確認**。stale なし。

## ① menu × resize 非干渉 — PASS
- 連続正解数 メニューを開いた状態で resize handle を操作 → menu 開いたまま維持・sort 誤誘発なし(chip 0)。
- 実 drag(Playwright dragTo)で 連続正解数 幅 96→241px = resize 機能動作。drag 中も sort chip 0 = **resize handle の stopPropagation 有効**。

## ② 複数 sort + filter chip 操作 — PASS
- 直近正誤 昇順 + 連続正解数 降順(multi-sort)+ 直近正誤=直近正解(filter)→ chip 3 個が配列順(sort 2 → filter)で表示: `並び替え: 直近正誤 ↑` / `並び替え: 連続正解数 ↓` / `回答状態: 直近正解`。filter dot(●)+ ソートグリフ(▲/▼)も表示。
- sort chip click で flip(↑→↓)/ filter chip × で個別解除(filter dot 自然消灯)/ すべてクリア で全解除 → バー消滅(chip 0)→ wrapper 1 児に戻り **toggle 右端維持(M1 regression シナリオそのもので fix 有効)**。
- 証拠: smoke-02a-menu-open.png / smoke-02b-chips.png

## ③ hidden 列条件の可視・解除 — PASS
- 連続正解数(sort)+ 直近正誤(filter)に条件付与 → 列トグルで両列 hide → header 消失でも動的バーに chip 残存(sort/filter 両方)。
- chip × で解除 → バー消滅・列は hide 状態維持(トグル state 独立)・toggle 右端維持。
- 証拠: smoke-03-hidden-col-chips.png

## ⑤ mobile viewport(375px)— PASS
- テーブル view 維持・メニュー展開(popover viewport 内 196–340 ≤ 375)・sort chip 追加(bar 8–280 ≤ 375 溢れなし)。
- **M1 fix mobile 確認**: 既定 view で toggle 右寄せ(right 352=wrapper 352・子1個)。chip ありでも右端維持。
- 証拠: smoke-05a-mobile-default.png / smoke-05b-mobile-chip.png

## ④ 大量行 listOffset(300-card)— PASS(数千でなく 300)
- 仮想化有効: DOM 行 ~8/描画対象 window、全体 scrollHeight ~41k–44kpx。
- 条件ゼロ: wrapper 下端 225 = table 先頭 225(listOffset 一致)。
- 条件追加(最終回答日時 昇順): wrapper 下端 225→235・**table 先頭も 235 に追従**(listOffset がバー高さ変化に追随)。中間スクロール(~21813px)でも行連続 anomaly 0。
- 条件削除: wrapper 下端 235→225・**table 先頭 225 復帰**。全操作で行の gap/overlap anomaly 0。
- 留保: 対象は 300-card(plan 想定「数千行」に満たない)。stg に数千行 exam は不在。300 行でも仮想化 + listOffset 追従は明確に発火・検証済。数千行での再検証が必要なら seed(OT 判断)。

## 後片付け
- 列表示 state(連続正解数/直近正誤 の hide)は localStorage persist ゆえ smoke 後に再表示へ復元。最終状態 = 4 条件列表示・chips 0 のクリーン。
