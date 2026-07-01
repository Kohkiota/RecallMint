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

---

# Fix-3 リーク源特定(T2 前段、CC + Codex 独立調査 → CC 統合)(2026-07-01)

- **種別**: fact-finding のみ(実装/commit/push なし)。
- **一次証拠**: OT の T1 適用後 stg 実機(Performance Monitor)= 300件で列幅 resize を繰り返すと **階段状に増え GC でも戻らない明確なリーク**: JS listeners ~9,000→66,275 / DOM nodes ~35,000→174,472 / heap ~230MB。resize 再レンダーは T1 で停止済にもかかわらず増える = 再レンダー経路とは別。
- **調査体制**: CC 独立コード調査 + mount/unmount 実計測、Codex 独立コード調査(anchor 防止、CC 仮説を渡さず現象+file 場所のみ入力)。Codex raw = `docs/codex/2026-07-01-leak-fix3.md`。

## 確定根本原因(CC・Codex 一致)= T1 の「別コンポーネント型 swap」による tbody 全 remount

`exam-card-table.tsx:524` の `isResizingColumn ? <MemoizedTableBody/> : <TableBody/>` は **別の React element 型**(`TableBody` `:73` vs `memo(TableBody)` `:120`)を同位置で出し分ける。React は型が変わると subtree を tear down + rebuild するため、**resize ドラッグ開始(TableBody→Memoized)と終了(Memoized→TableBody)で 300行×cell×Radix popover の tbody 全体が毎回 unmount+remount** する。DOM 増加と listener 増加は**同一 trigger(1 root)**。

### CC 決定的裏取り(mount/unmount 実計測、jsdom + InlineTextField を mount カウンタに mock、N=20)

| 指標 | 値 | 意味 |
|---|---|---|
| base mount / unmount | 80 / 0 | 20行×可視4列、mount のみ |
| **1 resize サイクルの unmount / mount 増分** | **160 / 160**(=80×2)| ドラッグ開始で全 cell unmount+mount、終了でもう一度 = 操作ごとに全 remount |
| mountPerCycle(4 サイクル平均)| 160 | 階段 churn 確定(操作ごとに一定量積む) |

→ 実機 N=300 では 1 resize = 300×4 InlineTextField ×2 遷移 = 2,400 mount + 2,400 unmount、加えて TagCell の Radix popover(最大 300×6)も同様に remount。OT 実測の DOM 174k / listener 66k の階段はこの remount churn。

### T1 は中立でなく「悪化」

- **pre-T1**(OT 初回計測)= listener は増えるが **DOM はほぼ不変**(35,138→35,156)。pre-T1 resize は re-render(remount でない)ゆえ DOM churn なし = リークは listener のみの軽度。
- **post-T1** = DOM も 174k へ階段(remount churn 追加)+ listener も 66k へ悪化。→ **T1 の型 swap が DOM リークを新規導入し listener リークを増幅**(resize 再レンダーフリーズは直したが、副作用として remount churn を生んだ)。pre-T1 の軽度 listener リークの機序は別で未確定(今回の支配的リーク = post-T1 remount で確定)。

## cleanup 漏れは app 側になし(CC・Codex 一致)

InlineTextField(debounce timer を unmount で clear `:142`)/ InlineOptionCell / CardTagEditFields(rAF cancel)/ CardTagOptionList に global listener・timer 漏れなし。Radix/Floating UI も cleanup path を持つ(DismissableLayer removeEventListener、Presence、Floating UI autoUpdate の ResizeObserver disconnect)。閉じた popover content は Presence で未 mount。→ **リークは「個別 cleanup バグ」でなく「巨大 Radix subtree を操作ごとに remount する構造」**。detach 後 GC されない厳密機序(Radix/React どの参照が保持するか)は未証明だが、trigger は remount で確定ゆえ fix には不要。

## CC / Codex の一致・独自・対立

- **一致(両者独立で同一結論)**: 根本原因 = 型 swap remount / DOM+listener は 1 root / app cleanup 漏れなし / 修正 = 単一 body 型 + freeze / 仮想化は rate 低減で root 非解決。
- **CC 独自**: mount/unmount 実計測で churn を数値確定(160/160→修正で 0)。修正の comparator 落とし穴を発見(下記)。
- **Codex 独自**: Floating UI autoUpdate の ResizeObserver/scroll listener 経路(開時のみ・cleanup 有)を特定。TagCell の popover 数削減(6→1/行)案。上流 leak issue は Dialog/Tabs で Popover 直接証拠は未確定と明示。
- **対立**: なし。

## 修正案(CC が prototype で裏取り済)

**核心 = 同位置の body component 型を 1 つに固定し、型 swap をやめる。**

- 常に `<MemoizedTableBody table={table} isResizing={Boolean(columnSizingInfo.isResizingColumn)} />` を render(TableBody との出し分け撤廃)。
- comparator = **`(_prev, next) => next.isResizing` 単独**。resize 中 = true → 凍結、非 resize = false → 通常再レンダー(反応性維持)。単一型ゆえ **remount が一切起きない**。
- **落とし穴(CC 発見)**: comparator に `prev.table.options.data === next.table.options.data` を混ぜると、useReactTable は同一 mutated instance を返すため `data===data` が常に true → 非 resize 時も永久 skip → **data が反映されず行が描画されない**(prototype で実際に 26/26 fail)。よって data 比較は入れず `next.isResizing` 単独が正。

### CC prototype 計測(修正の効果裏取り、実装後 revert 済)

| | 型 swap(現状 T1)| 単一型 + `next.isResizing`(修正案)|
|---|---|---|
| 1 resize サイクルの mount/unmount | 160 / 160 | **0 / 0** |
| 既存 T1 test | 26/26 pass | **26/26 pass**(凍結・反応性維持)|

→ remount churn が 0 になり、memo 凍結(resize 再レンダー抑止)も反応性も維持。**この修正で resize リークの支配要因が消える見込み**。

## T2(仮想化)との関係・task 分割案

- **リーク root fix は T2 と独立、かつ T2 より先**: 仮想化は mounted 数を 15×↓ = leak **rate** を比例低減するが、型 swap を残すと縮小した窓(~20行)でも resize 毎に remount して低速リークが残る。**root は型 swap 撤廃でしか直らない**。
- **task 分割案**:
  - **T1.1(リーク root fix / 最優先 / 小 / 新規依存なし)** = 型 swap 撤廃(単一 MemoizedTableBody + `isResizing` prop + `next.isResizing` comparator)。`exam-card-table.tsx` のみ。CC 計測で churn 0 裏取り済。**T2 の前に単独で入れる**(T1 が導入した regression の是正)。
  - **T2(行仮想化 `@tanstack/react-virtual`)** = baseline DOM/listener 規模(35k)+ 列表示切替の重さの根治。新規依存 = 事前相談ゲート。T1.1 後に要否判断。
  - **(任意)TagCell popover 数削減 6→1/行** = baseline mounted popover を ~6×↓。UX(単一 popover に initialStage を動的化)に触るため別 task・OT 判断。leak rate と baseline を下げるが root(remount)とは独立。

## 受け入れ基準(T1.1)

- 300件で列幅 resize を繰り返しても listener / DOM nodes / heap が階段状に増えない(GC で戻る)。
- resize 中の memo 凍結(sustainedDrag 再レンダー 0)は維持。
- 反応性(data / sort / filter / 列表示切替 / selection 追従)非回帰・既存 test green。
- before-after を OT 実機 Performance Monitor で確認(CC 計測は mount churn 0 で方向確認済)。

---

# Fix-3 T2 前段: 行仮想化 導入 fact-finding + 実装設計(CC + Codex 独立 → CC 統合)(2026-07-01)

- **種別**: fact-finding + 設計のみ(実装/commit/push なし)。
- **背景(T1/T1.1 適用後 OT stg 実機で確定)**: resize 継続フリーズ解消・リーク解消(操作やめると listener ~9,300 / DOM ~35,000 / heap ~60MB に復帰)。**残: 1 操作の瞬間に CPU 100% で数秒フリーズ**(resize > 列非表示、短くなったが継続)。= 単発の全 cell 描画コスト(mount cell 数比例)。memo(T1)は継続再レンダー、型 swap 撤廃(T1.1)は積み上がりを止めたが、**1 回あたりの全 mount コストは残る → 根治は描画量削減(行仮想化)のみ**。
- **調査**: CC(現物 + context7 で TanStack Table/Virtual 公式 docs)+ Codex 独立(anchor 防止)。Codex raw = `docs/codex/2026-07-01-t2-virtualization-codex.md`。

## ライブラリ / 依存是非
- `@tanstack/react-virtual@3.14.5`(registry 直叩き確定)。peer = React `^16||^17||^18||^19`(現 19.2.7 OK)、unpackedSize ~52KB、TanStack Table v8 と同組織の公式姉妹(v8 Table + Virtual は公式 compose パターンあり)。メンテ活発。
- de-risk gate: install → `pnpm typecheck` → `pnpm build` → 専用 `chore` commit(依存導入と実装を分離、lockfile 変更 sprint の完了 gate 準拠: install --frozen-lockfile + typecheck + build 全 exit 0)。
- **是非判断材料**: 公式姉妹・小サイズ・React19 対応・v8 と公式 compose = 導入妥当。ただし新規依存ゆえ **OT 承認ゲート**必須(CLAUDE.md「新ライブラリ導入は事前相談」)。

## CC / Codex の一致・独自・対立

### 一致(両者独立で同結論)
- 行仮想化が唯一の根治(1 操作 CPU コスト = mount cell 数比例、300→~20-30 行で ~10-15× 削減)。
- **非回帰は安全**: rowSelection / sorting / columnFilters / columnVisibility / select-all(indeterminate)は全て **table state ベース(DOM 非依存)**。`getRowModel()` が全行を返し、virtualizer は「どれを描くか」だけを決める。body は既に `row.getVisibleCells()`。
- **病的 churn 回避**: 単一 `MemoizedTableBody` 型を維持(型 swap 再導入禁止 = T1.1 教訓)+ `getItemKey = row.id`(getRowId 既に card.id)で並び替え時の index-key churn を防ぐ。scroll での mount/unmount は仮想化の設計通り(bounded)。
- 可変高さ = measureElement 必須。resize memo 凍結は仮想化窓にそのまま共存(resize commit で `rowVirtualizer.measure()`)。columnResizeMode:'onChange' 維持。CSS 変数幅(T1)は cell `width` としてそのまま流用。

### 対立(今回の核心論点 = レイアウト手法)
| | **CC / context7(TanStack 公式)** | **Codex** |
|---|---|---|
| 行配置 | `<table display:grid>` + `<tr position:absolute translateY>` + flex `<td>`。公式 docs 明記「native table layout は dynamic-height の独立配置行と相性が悪い」 | **native table 維持 + top/bottom spacer `<tr>`**(絶対配置しない)。既存 flow/CSS変数/sticky を無改造で維持 |
| container | 内側 bounded `overflow:auto` div(getScrollElement)。sticky header 無償 | **`useWindowVirtualizer`**(page 縦スクロール維持 + 既存 overflow-x-auto)。sticky-left は同祖先で不変 |
| sticky-left への影響 | flex 上で sticky 再構築 = **要再検証(リスク高)** | sticky 機構**無改造 = 最低リスク** |
| 動的高さの実績 | 公式に blessed | native+spacer は非公式(測定 jitter の可能性) |

### CC 独自
- 公式 docs(context7)の table+virtual 例 = display:grid/flex + absolute が「公式」で、native table + dynamic は非推奨と明記(この一次証拠が対立の根拠)。
- 既存 test への影響を特定: `getAllByTestId(/^row-/).toHaveLength(N)` 系(既存 26+ 件の多く)は jsdom に layout がなく virtualizer が全/0 行になり **要改修**(container 高さ mock or virtualizer stub)。

### Codex 独自
- spacer は「絶対配置しない」ので公式警告(独立配置行)の直接対象外 = 公式警告 vs 低リスク維持のトレードオフを明確化。
- `useFlushSync:false`(React19 compat/perf)、resize commit 時 `measure()` 明示。

### 対立なし(手法以外は全一致)

## 設計(CC 推奨 = 対立の裁定)

**#1 リスク = sticky-left 保全。この観点で Codex の native+spacer+windowVirtualizer を第一候補**とする(sticky 機構を一切触らない = 破壊リスク最小、T1.1 の「fix が別問題を生む」教訓に最も忠実)。公式 display:grid 案は sticky を flex 上に作り替えるため、まさに #1 リスクを自ら増やす。

- **container**: `useWindowVirtualizer`(page スクロール維持、既存 `overflow-x-auto` 温存)。sticky-left は同 overflow-x 祖先基準で不変。
- **body**: 単一 `MemoizedTableBody` 内で `useWindowVirtualizer({ count: rows.length, estimateSize, getItemKey: i=>rows[i].id, measureElement, overscan:5, useFlushSync:false })`。`<tbody>` に top/bottom spacer `<tr aria-hidden>`(height のみ)+ 窓内行に `ref={measureElement} data-index`。
- **T1/T1.1 共存**: CSS 変数幅・sticky・memo 凍結・単一型は不変。resize commit で `measure()`。
- **sticky-left 裏取り(最重要・実装時 gate)**: spacer 案は sticky 構造を触らないため理論上不変だが、**実装 T2 の受入に「300件で横スクロール中に select/title が固定され続ける」実機 smoke を必須化**(DevTools/Playwright)。理論だけで pass しない。
- **フォールバック**: native+spacer で dynamic 測定に jitter/破綻が出たら、公式 display:grid+absolute 案へ切替(sticky-left を flex 上で再構築 → 再 smoke)。設計 doc に両案を残す。

## Edit-5(sticky header)を T2 と統合するか
- **分離を推奨**。理由: 第一候補が `useWindowVirtualizer`(内側 container を作らない)ゆえ、T2 は sticky header の構造前提(bounded container)を要求しない → 両者は**独立**。Edit-5 は spec 未策定(凍結原則上、未 spec 機能を T2 に混ぜると spec リスク + scope 膨張)。
- ただし **将来 Edit-5 を内側 container 方式(Option A)でやるなら virtualizer を window→element に再配線**する手戻りが出る。**OT が「sticky header を近く必ずやる」なら、T2 を Option A(内側 container + element virtualizer)で組み Edit-5 と一体化する選択も合理**(1 回の構造変更で済むが scope 大 + sticky-left を flex/container 上で要再検証 + Edit-5 spec 先行が必要)。→ **この分岐は OT 判断**。

## task 分割案(第一候補 = window + spacer 前提)
- **T2-a(依存導入 / chore)**: `@tanstack/react-virtual@3` 追加 + de-risk gate(typecheck/build/frozen-lockfile 全 exit0)。lockfile sprint gate 準拠。
- **T2-b(仮想化本体)**: `MemoizedTableBody` を windowVirtualizer + spacer 行に改修。CSS変数/sticky/memo/単一型 不変。getItemKey=card.id。
- **T2-c(test 改修 + 非回帰)**: 既存 row-count 系 test を仮想化前提に改修(container/measure stub)、selection/filter/sort/visibility の state 非回帰 test、mount 数削減の裏取り(可能なら)。
- **T2-d(smoke gate)**: OT 実機で ①1 操作 CPU スパイク解消 ②baseline DOM ~3k ③**sticky-left 横スクロール保全**(最重要)④selection/filter/sort/card-view 非回帰。
- 順序: T2-a → T2-b → T2-c →(push)→ T2-d。sticky-left が smoke で崩れたらフォールバック(display:grid 案)へ。

## 受け入れ基準
- 300件で 1 操作(resize commit / 列表示切替)の CPU スパイク解消(数秒フリーズ → 即応)。
- baseline mounted DOM が ~35k → ~3k 規模(~10-15× 減)。
- **sticky 2列(select/title)が横スクロールで固定され続ける**(実機 smoke 必須・#1 リスク)。
- selection(select-all/indeterminate)/ filter(行数変化)/ sort / columnVisibility / resize / card-view 非回帰。
- 既存 test(仮想化前提に改修後)green。before-after profile(DOM/scripting time)を doc に残す。

## 今日の教訓の反映(fix が別問題を生むパターンの事前封じ)
- T1(型 swap→remount churn)の轍を踏まないため、T2 は **単一 MemoizedTableBody 型を維持**(型 swap 厳禁)+ **getItemKey=card.id**(index-key churn 防止)+ **container 変更を最小化**(window virtualizer で sticky/overflow 祖先を温存)。
- sticky-left は理論 pass で終わらせず**実機 smoke を受入 gate に必須化**(構造変更が sticky を壊す典型を計測で潰す)。
