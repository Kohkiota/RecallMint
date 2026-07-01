# Codex independent design — Fix-3 T2 行仮想化 (2026-07-01)

- **作成日**: 2026-07-01
- **種別**: 独立実装設計(read-only / CC 仮説を渡さず現象+現構造+設計問だけ入力 = anchor 防止)
- **起動**: `codex exec`(read-only、書込フラグなし)。prompt = `.superpowers/sdd/fix3-t2-codex-prompt.txt`、raw = `.superpowers/sdd/fix3-t2-codex-out.txt`

---

## Codex 推奨(要点、file:line は Codex 提示)

- **レイアウト = native table + top/bottom spacer `<tr>`(絶対配置しない)**。理由: 既存 `<table>→<thead>→<tbody>→<tr>→<td>` flow / CSS 変数幅 / sticky cell を**そのまま維持**でき、公式 display:grid+absolute より低リスク。各行を transformed stacking context にしない。
  - spacer: `{top>0 && <tr aria-hidden><td colSpan={n} style={{height:top,padding:0,border:0}}/></tr>}` … 描画窓 … `{bottom>0 && <tr .../>}`。
- **container = Option B `useWindowVirtualizer`(page 縦スクロール維持 + 既存 overflow-x-auto を残す)**。理由: sticky-left は同じ overflow-x 祖先に対して効き続ける(MDN: sticky は overflow ある最近接祖先基準)。mobile の page スクロール UX 維持・nested scrollbar 回避。Option A(内側 overflow:auto div 両軸)も sticky-left は効き将来 sticky header に有利だが、nested scroll UX + 高さ測定が固定高依存になる。
- **可変高さ**: measureElement 必須(options cell は option 数分 + add、TagCell は最大6 popover で行高可変)。300行の逐次測定は全 cell 一括 mount より遥かに軽い(mount 窓 + overscan のみ測定)。
- **非回帰**: rowSelection / sorting / columnFilters / columnVisibility / select-all(getIsAllRowsSelected 等)は全て **table state ベース(DOM 非依存)** ゆえ仮想化窓外でも正しい。body は既に `row.getVisibleCells()`。**off-screen row DOM を読むコードだけ壊れる = 現状は test の data-testid のみ**(test は scroll or 仮想化前提に要改修)。
- **resize memo 共存 OK**: 単一 `MemoizedTableBody` の `next.isResizing` 凍結はそのまま仮想化窓に効く。resize commit 時に `rowVirtualizer.measure()` で再測定。
- **churn**: scroll での行 mount/unmount は仮想化の設計通り(bounded)。**病的 churn 回避 = 型 swap を再導入しない**(前回 bug の教訓、コメント :526 明示)+ `getItemKey = rows[index].id`(getRowId 既に card.id)で sort/filter 並び替え時の index-key churn を防ぐ。
- **CPU**: 300→20-30 行で mount/render を行数比例で削減(virtualizer overhead 小)。
- **React 19**: `useFlushSync: false` を compat/perf option として明示。
- **task 順**: ①react-virtual v3 追加 ②TableBody を rows 計算 + virtualizer + spacer 化 ③`<table>` CSS 変数/thead/sticky/MemoizedTableBody identity は不変 ④まず useWindowVirtualizer、sticky header 優先化まで内側 container は保留 ⑤仮想化前提の test ⑥列表示切替/resize commit の before-after profile。

## CC が留意すべき対立点
- **CC/context7(公式 docs)は逆**を推す: 「native table layout does not work well with dynamic-height virtual rows positioned independently」→ `<table display:grid>` + `<tr position:absolute translateY>` + flex `<td>` が公式パターン、sticky header は bounded container で `thead position:sticky top:0` 無償。
- Codex の spacer 案は「絶対配置しない」ので上記公式警告の直接対象外(行は通常 flow のまま)。= 公式警告 vs 低リスク維持のトレードオフ。
