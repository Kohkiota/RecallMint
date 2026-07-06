# S5 列固定(column pinning)stg smoke 結果(2026-07-06)

- 対象: https://stg.recallmint.nekotest.net/app/exams/fb10b7cf-...(PERF-SEED 300-card exam)
- ツール: Playwright MCP(chrome-devtools MCP は target closed で起動不可 → memory の fallback 適用)
- HEAD: develop 6199fab(S5-1/2/3 push 済)
- 結果: **全 9 項目 PASS / console errors 0 / 300-card 仮想化正常・体感ラグなし**

## 項目別

- **① 固定**: タグ「固定表示」→ select/title/sort_key/question/options/tags が sticky、累積 left offset = 0/32/112/212/532/772(列幅と一致)。select も固定領域入り。
- **② 境界 border**: 最右 pinned(tags)の th/td に border-r 1px、他 0。
- **③ 境界移動**: 固定済み状態で非境界 title の「固定表示」→ 境界が title へ縮小(select/title のみ pinned)、border-r も title へ移動。
- **④ 解除**: boundary 列(title)メニューは「固定を解除」表示 → 押下で sticky th 0・start 変数 0・select も横スクロールで流れる(全列スクロール復帰)。
- **⑤ reload 復元 + V2→V3 migration**: tags 固定 → 永続 `{"version":3,...,"pinnedBoundary":"tags"}` → reload で境界復元。V2 record(hiddenColumns:['memo'])注入 → reload で table view + memo 非表示 + pinning なし(pinnedBoundary→null)。**mount 後も record は V2 のまま = lazy migration 確認**(無操作で spurious V3 write なし)。
- **⑥ hidden boundary + 復帰**: boundary=sort_key で sort_key 非表示 → border-r が title(最右可視 pinned)へ移動・hidden 列の start 変数除去。再表示で境界復帰(border-r=sort_key)。
- **⑦ resize 追従**: title を実ドラッグで 80→342px → sort_key の left が 112→374(=select32+title342)へ追従。start 変数・**memo 凍結中の body セル**・th viewport 位置すべて 374 一致。破綻なし(R3 機構を実ブラウザ確認)。
- **⑧ 縦横 sticky 交差**: 縦(scrollTop 1500)で見出し行 top:0 固定 + 横(scrollLeft 250)で select left:0 固定 = 交差セル両軸 sticky。問題文列は pinned 列の下へ潜行(不透過で透けず)。
- **⑨ hover 色 + 不透過**: pinned td は不透過白背景(下の scroll 内容を occlude・screenshot 03 で確定)。group-hover color-mix ルールは正特異度(0,2,0 > bg-background 0,1,0)で生成済。tint 自体が near-white(muted 96.5%)で pinned/非 pinned 差は sub-perceptual、視覚 screenshot で色差視認なし。※合成 hover の computed 読み取りは既存 tr:hover も透明と出る不安定さのため視覚+CSS ルール検証を採用。

## console
- errors 0(全セッション通算)。warning は S5 無関係の既存ノイズのみ(Permissions-Policy header 未対応 feature × 4 / Clerk dev key 警告)。

## 証拠
- s5-smoke-01-pinned-tags.png / -02-hscroll-pinned.png / -03-title-pinned-hscroll.png / -04-hover-color.png / -05-hover-row2.png / -06-vh-intersection.png(repo ルート)

## 片付け
- smoke で注入した V2 record / pinning 状態は clean baseline(`{version:3,view:table,hiddenColumns:[],pinnedBoundary:null}`)へ復元済。
