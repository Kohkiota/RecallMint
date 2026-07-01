# Edit-3 Fix-3 fact-finding — 300件テーブル resize/列表示切替フリーズ

- **日付**: 2026-07-01
- **種別**: fact-finding のみ(実装/commit/push なし)。原因特定 + 修正案 + task 分割案の提示で stop。
- **一次証拠**: OT の stg DevTools 実測(heap 57.8→111MB / listeners 9,183→36,122 かつ録画間で 9,183→15,917 に residual 上昇 / DOM nodes 35,138→35,156 ほぼ不変 / CPU bottom-up querySelector self ~3,681ms)。
- **裏取り**: 現物コード(下記 file:line)。300件 DevTools 再計測は未実施(OT 実測が一次、コードで原因は確定可能なため)。

---

## 確定原因

### 共通根本原因(resize と列表示切替の両方に効く)= 非仮想化 × 非 memo の全行 body 再レンダー

`ExamCardTable` は 300 行 × 11 列を**全 DOM 描画**し、**行・cell とも React.memo なし**。table state(columnSizing / columnVisibility / rowSelection …)が変わるたびに `table.getRowModel().rows.map(...)` 以下の全 cell が再レンダーされる。

- 仮想化なし: `exam-card-table.tsx:438` `table.getRowModel().rows.map(...)` が全 300 行を出力。`grep virtual` はテーブル系に該当なし(card-view に「将来」コメントのみ)。→ OT 実測 DOM ~35,000 nodes と整合。
- 行/cell の memo 化なし: `exam-card-table.tsx:438-470` は inline map、cell は `flexRender` 直呼び。`React.memo` は card-view / card-tags-section にはあるが **table cell 経路(exam-card-table.tsx / -columns.tsx / -tag-cell.tsx / -options-edit-cell.tsx / inline-text-field.tsx)には一切なし**。
- 1 回の全再レンダーで走る重い cell(`exam-card-table-columns.tsx`):
  - `InlineTextField` × 5 列(title/sort_key/question/explanation/memo)× 300 = **1,500 インスタンス**(`inline-text-field.tsx`、useState×3 + useEffect×2 + useLayoutEffect を持つ)
  - `CompactOptionsCell` × 300
  - `TagCell` × 300(各 cell が最大 6 個の `CardTagAddPopover` = Radix Popover を内包、`exam-card-table-tag-cell.tsx:142-199`)
- **これは TanStack Table v8 が公式に「最大の性能落とし穴」と警告する構成**(非 memo body + column sizing)。

### resize 側の増幅要因(確定)= `columnResizeMode: 'onChange'`

`exam-card-table.tsx:229` `columnResizeMode: 'onChange'`。ドラッグ中の pointermove ごとに TanStack が columnSizing state を更新 → **1 move = 全 body 1 再レンダー**。60fps 相当の move 連打 × 2,100 重 cell = 操作不能。これが resize が特にひどい理由。

### 列表示切替側(確定)= 同じ全 body 再レンダーを 1 回

`onColumnVisibilityChange: setColumnVisibility`(`:235`)→ columnVisibility state 変化 → ExamCardTable 全体 1 再レンダー → getRowModel/getVisibleCells 再計算で全行再構築。**1 回きりだが、2,100 重 cell + Radix reconciliation の 1 再レンダーが単体で秒オーダー**なので体感フリーズになる。列非表示は cell の増減を伴うため memo だけでは救えず、根治は描画量そのものを減らす方向。

### CPU: querySelector self ~3,681ms の出所

prod component 群に querySelector / getBoundingClientRect / offsetWidth 等の**手動 DOM 測定は 0 件**(grep でヒットするのは全て `.test.tsx`)。よって querySelector は **Radix Popover 内部**(Popper collection / dismissable-layer / focus-scope 等)が、全再レンダーの嵐の中で TagCell 配下 popover subtree を横断実行しているものと解釈するのが自然。= 我々のコードの layout thrashing ではなく、重 cell の大量再レンダーの二次症状。

---

## 状況証拠だが未確定(要 runtime 再計測)

### listener 増殖 9,183→36,122(+ residual 9,183→15,917)= メカニズム未特定

- prod component に手動 `addEventListener` は **0 件**(grep 確認)。React は root delegation ゆえ props 由来の合成イベントは実 listener をほぼ増やさない。→ 実 listener の出所は **Radix primitives / ref 合成等の第三者**。
- Radix Popover は `open` 制御で **閉時に PopoverContent を mount しない**(`card-tag-add-popover.tsx:327-341`、forceMount なし)。よって「1,800 個の閉じた popover が各々 listener を貼る」説は**否定的**。閉時のベースライン listener は別要因。
- **録画間で base が 9,183→15,917 に残留上昇**している点は「操作中の一時増加」でなく**真の leak**を示唆するが、静的読解だけでは発生 API を断定できない。**getEventListeners / heap retainer の before-after 実測が必要**(OT 実測は総数のみで retainer 未取得)。
- ただし **root-cause fix はこの特定に依存しない**: 描画量削減(仮想化)で mount 中の interactive cell 数が ~15× 減り、listener 総数・base も比例して縮む。leak が仮想化後も残れば別 investigation を切る。

---

## 修正案(TanStack v8.21.3 公式パターン準拠)

### 案 A — resize 根治: CSS 変数で列幅配布 + resize 中は body を memo 凍結(推奨)

- 列幅を `columnSizingInfo`/`columnSizing` から `useMemo` で CSS 変数化し `<table>` の style に一括付与(`--col-{id}-size`)。th/td は `getSize()` 直読みをやめ `width: var(--col-{id}-size)` を読む。
- `<tbody>` を `TableBody` に切り出して `React.memo`。TanStack 公式トリック: `columnSizingInfo.isResizingColumn ? <MemoizedTableBody/> : <TableBody/>`。ドラッグ中は memo 版(凍結)を出し、pointermove は `<table>` の CSS 変数だけ更新 → **2,100 cell を再レンダーしない**。離すと通常 body に戻る。
- 利点: onChange のライブ幅追従 UX を保ったまま resize フリーズ解消。新規依存なし。
- **代替(1行)**: `columnResizeMode: 'onEnd'` に変更。実装最小だがドラッグ中の幅プレビューが消え離した瞬間に確定(UX 劣化)。A が重ければ fallback。

### 案 B — 列表示切替 + baseline + listener 規模: 行仮想化(`@tanstack/react-virtual`)

- 表示窓(~20-30 行)だけ描画。DOM nodes 35k→~3k、mount 中 interactive cell 数が比例減 → listener 総数/base も縮小、全再レンダーが恒常的に軽くなる(列表示切替の 1 再レンダーも軽い)。
- **新規ライブラリ導入 = CLAUDE.md「新ライブラリ導入は事前相談」に該当 → OT 承認ゲート必須。**
- 注意点: sticky 列(横方向)は仮想化(縦方向)と直交で両立可だが、既存 `overflow-x-auto` を高さ固定 + `overflow-y` のスクロール container に変える必要。selection / filter / sort / sticky offset の非回帰を再検証。

### 案 C — per-cell React.memo(補完・任意)

- `InlineTextField` / `TagCell` / `CompactOptionsCell` を安定 props で memo 化し、無関係な state 変化で保持 cell が bail out できるように。A/B を入れれば多くは B に吸収されるため、A+B で不足時のみ。

---

## task 分割案

- **T1(resize 根治 / 新規依存なし / 低リスク)** = 案 A(CSS 変数 + resize 中 memo body)。まず単独投入し before-after Performance trace で効果測定。
- **T2(列表示切替 + baseline + listener 規模)** = 案 B(行仮想化)。**OT の依存導入承認が前提**。T1 実測後に要否判断(T1 だけで列表示切替も許容内に収まる可能性あり)。
- **T3(任意)** = 案 C。T1+T2 で不足時のみ。
- **listener leak 確認**は T1/T2 の受け入れに `getEventListeners` before-after を組み込み、仮想化後も base 上昇が残れば別 investigation を起票。

順序: T1 → 実測 → (承認前提で)T2。T1 と T2 は独立で、T1 だけでも resize は解消見込み。

---

## 受け入れ基準(案)

- 300 件で列幅 resize / 列表示切替が操作不能にならない(体感即応)。
- 操作後の Event listener 数が継続的に増えない(before-after `getEventListeners`)。
- querySelector / layout recalculation が大幅減(before-after Performance trace)。
- 既存機能非回帰: sticky 2列 offset / selection / filter / sort / card-view 無影響 / 既存 test green。
- before-after の Performance 計測を doc に残す(300件 seed = `seed-perf-exam.ts --with-answers`、prod guard 3層)。

---

## 根拠コード index

| 論点 | file:line |
|---|---|
| 全行描画(仮想化なし) | `exam-card-table.tsx:438` `getRowModel().rows.map` |
| 行/cell memo なし | `exam-card-table.tsx:438-470`(inline map + flexRender) |
| resize 増幅 | `exam-card-table.tsx:229` `columnResizeMode: 'onChange'` |
| 列表示切替 | `exam-card-table.tsx:235,269-284` |
| 重 cell 実体 | `exam-card-table-columns.tsx`(InlineTextField×5列 / CompactOptionsCell / TagCell) |
| TagCell の popover 多重 | `exam-card-table-tag-cell.tsx:142-199`(最大 6 popover/cell) |
| Radix 閉時 content 非 mount | `card-tag-add-popover.tsx:327-341`(forceMount なし) |
| 手動 DOM 測定 0 件(prod) | grep: querySelector 等は `.test.tsx` のみ |
| 手動 addEventListener 0 件(prod) | grep: 該当なし |

---

# Fix-3 T1 実装 + after 計測(2026-07-01)

- **commit**: `965ec68` `fix(edit-3): Fix-3 T1 列幅 CSS変数配布 + resize中 tbody memo凍結 [reviewed]`(BASE dd3b093)。
- **実装**: 案A(TanStack v8.21.3 公式パターン)。列幅を `--header-{id}-size` / `--col-{id}-size` の CSS 変数で `<table>` に配布(th/td は `calc(var(...)*1px)` を読む)。`<tbody>` を module スコープ `TableBody` / `MemoizedTableBody`(`React.memo`、comparator = `prev.table.options.data === next.table.options.data`)に分離し、`columnSizingInfo.isResizingColumn` 中は memo 版を描画して凍結。`columnResizeMode:'onChange'` 維持・sticky left(0/44)不変・per-cell memo/仮想化なし。触れた file = `exam-card-table.tsx` + `.test.tsx` のみ(共有部品/card-view 不変)。
- **review**: canonical(general-purpose + `code-reviewer.md` 改変なし)初回 Critical0/**Important1**/Minor3 → I-1(`columnSizeVars` の deps に `columnVisibility` 欠落 → hidden の sort_key をトグル表示で width auto 落ち = 列表示切替 regression)を fix wave 1 で解消(dep 追加 + 非 vacuous 回帰 test)→ 再 review Crit0/Imp0/Min0。Codex 独立(`docs/codex/2026-07-01-edit-3-fix3-t1.md`)Crit0/Imp0/Min0。gate: whole-repo lint --max-warnings=0 exit0 / typecheck exit0 / 該当 test 26/26 green。

## after 計測(決定的 = component render-count、jsdom + InlineTextField を render カウンタに mock、N=30 行)

| 指標 | 値 | 意味 |
|---|---|---|
| afterMount(cell render 総数) | 240 | 30行 × 可視4列 × 2(mount 二重評価) |
| **sustainedDrag 20 mousemove の cell 再レンダー増分** | **0** | **memo 凍結成立 = ドラッグ中の pointermove で 2,100 重 cell を再レンダーしない(T1 の核心)** |
| firstMove 遷移コスト | 120(=30×4) | ドラッグ開始時 TableBody→Memoized 遷移で 1 回のみ再構築(離す時も同程度 1 回。許容) |
| 列表示切替の cell 再レンダー増分 | 150 | 列表示切替は **通常再レンダーのまま**(memo が永久凍結でない証拠、かつ **T1 は列表示切替を軽くしない**) |

- **memo 凍結の runtime 検証**: 上記の `sustainedDrag=0` が決定的証拠(React DevTools Profiler の代替。20 連続 mousemove で cell render 0)。非 memo なら 1 move = 120 render(N=30)→ 20 move = 2,400。実機 N=300 では 1 move ≈ 2,100 重 cell、数百 move のドラッグ = 数十万 render が 0 になる。
- **計測方法**: throwaway 計測 test(`exam-card-table.perf-measure.test.tsx`、InlineTextField を counter に mock し resize ドラッグ模擬)で取得後に削除(commit しない)。

## 体感改善見込み(計測ベース)

- **列幅 resize = 根治見込み**: フリーズ主因はドラッグ中の per-move 全 body 再レンダーの嵐。T1 で **sustained drag の再レンダー = 0** ゆえ、この経路のフリーズは解消見込み。resize 由来の listener 増殖(全再レンダーごとの Radix popover subtree reconciliation)も、再レンダーが起きない以上止まる見込み。
- **列表示切替 = T1 では実質改善しない見込み**: 列表示切替は元々「1 回の全 body 再レンダー(2,100 重 cell + Radix)」で、これは単発ゆえ memo 凍結(resize 専用)では軽くならない。計測でも列表示切替は cell を通常再レンダー(delta 150)。OT 実測の列非表示ピーク(DOM 116,889 / heap 216MB / listeners 35,408)は「全行を捨てて再生成する 1 コミット」の重さで、**根治は T2(行仮想化 = mount cell 数削減)** が要る。per-cell memo も列表示切替では効果限定(列増減で保持 cell も再 mount 側に寄る)。

## runtime browser 計測(listeners/DOM/heap/querySelector)の扱い

- **CC 側で T1 の browser before/after は取得不可**: stg は未 push の旧コード(規律: 旧コード smoke は無意味)、CC 環境に 300 seed + Clerk 認証済の実ブラウザ harness なし。→ **OT が push 後に stg 実機で before/after(特に resize 中の listener 継続増加が止まるか / 列非表示は残るか)を確認**。
- T1 の主目的 = **resize 描画の根治**。listener leak の根治は保証しない(fact-finding 通り発生 API 未特定。leak が resize 経路のものなら再レンダー停止で連動して止まる可能性が高いが、baseline leak / 列表示切替経路は T2 待ち)。

## 次アクション(OT)

1. push(965ec68)。
2. stg 実機 smoke: ① 列幅 resize が 300件で操作可能になったか(フリーズ解消)+ resize 中の listener 継続増加が止まったか ② 列表示切替は依然重いか(= T2 要否の判断材料)③ sticky 2列 offset / selection / filter / sort / card-view 非回帰。
3. ②の結果で **T2(行仮想化 `@tanstack/react-virtual`、新規依存 = 事前相談ゲート)** の要否を判断。
