# 行 DnD — spec 前 前提確認レポート(2026-08-15 / 調査のみ・実装なし)

対象: Grid-3 session doc §7「行 DnD への handoff」を前提に、テーブルビュー/カードビューへの
ドラッグ並べ替え導入の**現物確認**。書込は `card_move` op を消費(新チャネルなし)前提。

確認した現物: `@dnd-kit/*` の実 dist(node_modules)/ 既存 3 DnD site / 既存 2 virtualizer /
`useMoveCards` / `planMoveAssignments` / gating 経路。**推測でなく file:line を残す。**

---

## 0. 結論(先出し)

1. **書込側は素通し**。`useMoveCards` + `planMoveAssignments` は DnD の drop 位置を
   そのまま表現でき、変更不要。必要なのは「表示 index → `MovePlacement`」の**変換 1 本**だけ。
2. **仮想化との同居は構造的には成立する**(dnd-kit が sparse rect を許容し、droppable 計測が
   transform-agnostic)。ただし **DragOverlay 不使用だと、ドラッグ中に元行が仮想化 unmount した
   瞬間に visual と scroll ancestor を失う**。これが最大の設計論点。
3. **`@dnd-kit/modifiers` は未導入**。`restrictToVerticalAxis` 等は使えない(新規依存 = 事前相談)。
   `Modifier` 型は core が export しているので自前 1 関数で代替可能。
4. **gating は流用できる**が、DnD は「位置指定だけ無効」ではなく **drag 自体を無効化**が正。
   既存 `positionLocked` と `POSITION_LOCKED_REASON` はそのまま使える。
5. **カードビューは費用対効果が低い**。行高 738px 推定 = 画面に 1〜2 枚しか出ず、
   加えてカードビューには toast/undo/error/pending の UI 基盤が**一切ない**。

---

## 1. 仮想化の実測構造

### 1.1 テーブル(`useVirtualizer` = element virtualizer)

`app/(app)/app/exams/[id]/_components/exam-card-table.tsx`

| 項目 | 実測値 | 位置 |
|---|---|---|
| virtualizer | `useVirtualizer`(element) | `:138-145` |
| overscan | **5** | `:143` |
| estimateSize | `ESTIMATED_ROW_HEIGHT = 120` | `:123`, `:141` |
| getItemKey | `rows[index].id`(= `card.id`。`getRowId` と一致) | `:142`, `:604` |
| useFlushSync | `false` | `:144` |
| scroll container | `tableContainerRef` の `div.flex-1.min-h-0.overflow-auto` | `:824`, `:901-905` |
| scrollMargin | 既定 0(container 先頭が原点) | `:132-133` コメント |
| measureElement | 各実行 `<tr>` の `ref` に直付け | `:195` |
| 行 DOM | `<tbody>` > `<tr data-index ref=measureElement>` > `<td>` × 列 | `:190-233` |
| spacer | **padding 用の `<tr aria-hidden><td height/></tr>` を上下に挿入**(absolute 配置ではない) | `:177-184`, `:236-243` |
| 再計測 | `columnSizing` 変化時に `rowVirtualizer.measure()` | `:152-154` |
| body の memo | `MemoizedTableBody`(comparator = `next.isResizing` 単独。resize 中は tbody 凍結) | `:253-256` |

**DnD にとって有利な事実**: 行は **normal flow の `<tr>`**(spacer で位置合わせ)であり、
virtualizer が transform で行を絶対配置していない。つまり useSortable の transform と
virtualizer の配置機構が競合しない。

**注意点**:
- `<tr>` に `ref={rowVirtualizer.measureElement}` が既に付いている。`useSortable().setNodeRef` を
  同じ `<tr>` に付けるには **ref のマージが要る**(repo に `mergeRefs`/`composeRefs` は
  **存在しない** — grep 済)。3 行のコールバック ref で足りる。
- pinned セル(`sticky z-[1]` + `left: calc(var(--col-x-start)*1px)`, `:212-227`)と
  sticky thead(`:920`)がある。**`<tr>` に transform が乗ると transform は containing block を
  作るため、行内の `position: sticky` セルの挙動が変わりうる**。これはコード読解では確定できない
  = **実ブラウザ smoke 必須項目**。
- select `<td>` は**セル全域 onClick で行選択トグル**(`:218-220`)。handle を置くなら
  checkbox / 行メニューと同様に `stopPropagation` が要る(既存 pattern: `exam-card-table-columns.tsx:104,124,133`,
  `exam-card-row-menu.tsx:106`)。
- select 列は `size: 88`(`exam-card-table-columns.tsx:93`)。grip(24px)を足すなら幅の再計算が要る。

### 1.2 カードビュー(`useWindowVirtualizer`)

`app/(app)/app/exams/[id]/_components/inline-card-list.tsx`

| 項目 | 実測値 | 位置 |
|---|---|---|
| virtualizer | `useWindowVirtualizer` | `:304-312` |
| overscan | **3** | `:307` |
| estimateSize | `ESTIMATED_CARD_HEIGHT = 738`(stg 300-card 実測 median) | `:75`, `:306` |
| getItemKey | `cards[index].id` | `:310` |
| scroll container | **window / document**(内部 scroll container なし) | `:289` |
| scrollMargin | `listRef.current.offsetTop` を毎 render 実測 + guard 付き state | `:295-302`, `:311` |
| measureElement | 各 `<li>` の `ref` に直付け | `:456` |
| 行 DOM | `<ul ref=listRef>` > `<li data-index ref=measureElement>` > `<Card>` | `:448-474` |
| spacer | `<li aria-hidden style={{height}}>` 上下 | `:449`, `:473` |

**注意点**:
- 行高 738px 想定 = 一般的な viewport で**同時に 1〜2 枚**しか mount されない。
  overscan 3 を足しても droppable は最大 7〜8 枚。**ドラッグで到達できる範囲がほぼ隣接のみ**。
- カード内は `InlineTextField` / `CardImageGallery`(PhotoSwipe)/ タグ popover が密集。
  行全体を draggable にすると編集操作と全面衝突する → **handle 必須**(tag 系と同じ結論)。

### 1.3 dnd-kit の版と、仮想化リストに載せる場合の既知制約

**導入済み(package.json)**: `@dnd-kit/core 6.3.1` / `@dnd-kit/sortable 10.0.0` / `@dnd-kit/utilities 3.2.2`。
**`@dnd-kit/modifiers` は未導入**(`ls node_modules/@dnd-kit/` = core, sortable, utilities のみ)。

→ `restrictToVerticalAxis` / `restrictToParentElement` / `restrictToWindowEdges` は**使えない**。
新規ライブラリ導入は CLAUDE.md で事前相談。ただし `Modifier` 型と `applyModifiers` は core が
export しており(`node_modules/@dnd-kit/core/dist/index.d.ts`)、`modifiers` prop も
`DndContext.d.ts` にあるので、**Y 軸固定は自前 5 行の Modifier で代替可能**。

以下、dist を読んで**確認した**制約(推測ではない):

| # | 事実 | 根拠 |
|---|---|---|
| a | `SortableContext.items` に**全 id**(未 mount 含む)を渡してよい。rect は `Map.get` で引くだけで、未 mount の index は **穴のある sparse array** になる | `sortable.esm.js:24-33` (`getSortedRects`) |
| b | `verticalListSortingStrategy` は rect 欠落時に `null` を返して**素通り**(crash しない) | `sortable.esm.js:215-219` |
| c | 隣接 gap 計算 `getItemGap` も rect 欠落を `0` で吸収 | `sortable.esm.js:263-277` |
| d | **droppable になれるのは mount 済み行だけ**。仮想化で外れた行は drop 対象にならない | `useDroppable` は mount 時に register(`core.esm.js:3463-`) |
| e | droppable rect の既定計測は **`getTransformAgnosticClientRect`**(transform を逆算して除去)。よって「ドラッグ中に行が displace した状態で再計測 → 座標がずれて発振」という典型的な懸念は**設計上回避されている** | `core.esm.js:2478-2489`, `getClientRect` の `ignoreTransform` 経路 `:602-618` |
| f | 既定 strategy は `MeasuringStrategy.WhileDragging`。ただし **droppable の登録集合(`enabledDroppableContainers`)が変わると全件再計測**される。仮想化で行が mount/unmount するたびにこれが走る | `core.esm.js:2904`, `1992-2024` |
| g | **draggable は unmount で登録解除される**。ドラッグ中の元行が仮想化で外れると `draggableNodes.delete(id)` が走る | `core.esm.js:3415-3431` |
| h | auto-scroll の対象 `scrollableAncestors` は **`overNode ?? activeNode`** から導出。両方失うと auto-scroll が止まる | `core.esm.js:2956` |

**→ (d)(g)(h) の合成が、仮想化 × dnd-kit の唯一の実質的な制約**:
overscan 分を超えてドラッグすると元行が unmount し、ドラッグの見た目と auto-scroll の足場を失う。
**これが `DragOverlay` を使う理由**(overlay はリスト外に描画されるので unmount に巻き込まれない)。
既存 tag 3 site は短いリスト(非仮想化)なので `DragOverlay` を使っていない
(`grep -rn "DragOverlay" --include=*.tsx .` = 0 件)。**行 DnD で初導入になる。**

`<tr>` を `DragOverlay` に出す場合は overlay 内に `<table><tbody>` の器が要る(HTML の構造制約)。

### 1.4 ドラッグ中のスクロール(auto-scroll)の担当

**dnd-kit 側が担う**(virtualizer は「scroll された結果」に反応するだけ)。既定で有効。

- `DndContext` の `autoScroll` prop は既定 true(`DndContext.d.ts` に `autoScroll?: boolean | AutoScrollOptions`)。
- 既定値: `activator = AutoScrollActivator.Pointer` / `interval = 5ms` / `acceleration = 10` /
  `order = TraversalOrder.TreeOrder`(`core.esm.js:1765-1780`, `831-845`)。
- `getScrollableAncestors` は element から上へ辿り、`overflow` が scrollable な要素を積み、
  最後に **`document.scrollingElement` を無条件で積む**(`core.esm.js:686-724`, 特に `:698-701`)。
- `TraversalOrder.TreeOrder` は配列を **reverse** して使う = **外側(document)から先に試す**。
  その方向にもう scroll できない場合だけ内側(テーブルの overflow-auto container)へ落ちる
  (`core.esm.js:1819`, `1836-1858`)。

**既存設定で動くか**:
- テーブル: scroll container は `overflow-auto` な div(`exam-card-table.tsx:901-905`)なので
  ancestor として**検出される**。ただし table view の shell は `height: calc(100dvh - shellTop)`
  (`exam-detail-view.tsx:248-252`)で、**document 側にも僅かな scroll 余地が残りうる**。
  外側優先の traversal のため「まず document が少し動いてから table が動く」挙動になりうる。
  → **コード読解では確定できない。実機/stg smoke 項目。**
- カードビュー: ancestor = `document.scrollingElement` 1 本。素直に動くはず。

**追加設定なしで足りない可能性がある点**(いずれも実測が要る):
`autoScroll={{ threshold, acceleration }}` の調整、`canScroll` で document を除外する、
`MeasuringStrategy.Always` にするか — **どれも「まず既定で smoke → 必要なら足す」順が正**
(簡潔性規律: 先回りで設定を足さない)。

---

## 2. 既存 gating との接続

### 2.1 接続点

```
exam-card-table.tsx:514
  const positionLocked = sorting.length > 0 || columnFilters.length > 0
```
これがそのまま 2 経路へ配られている:
- 一括バー: `:1094` → `exam-card-table-action-bar.tsx:155` → `exam-card-move-popover.tsx:135`
- 行メニュー: `:626`(meta.rowMenu)→ `exam-card-table-columns.tsx:149` → `exam-card-row-menu.tsx:116-119`

**DnD も同じ 1 変数を読むだけで接続できる**(新しい判定を作らない)。`sorting` / `columnFilters` は
`ExamCardTable` の state(`:323`, `:325`)で、DndContext を置く場所からそのまま見える。

### 2.2 理由表示の再利用可否 = **可**

`POSITION_LOCKED_REASON`(`exam-card-move-popover.tsx:45-46`)は既に**別 file から import されて
再利用されている**実績がある(`exam-card-row-menu.tsx:32`)。文言:

> ソート/フィルタ適用中は位置指定できません(解除するか、末尾/先頭を使ってください)

**ただし DnD では文言が半分ずれる**。「末尾/先頭を使ってください」は popover の代替手段の案内で、
DnD には代替がない。DnD 用は「ソート/フィルタを解除すると並べ替えできます」系が要る
= **定数を 1 本増やすか、文言を分岐する**(spec で決める論点)。

表示の付け方は既存 pattern がそのまま使える:
- `disabled` + `aria-disabled` + `title` + `aria-describedby` + 説明 `<p id>`(`exam-card-row-menu.tsx:116-138`)
- disabled 理由を必ず要素に紐付ける(`exam-card-move-popover.tsx:204-215`)

### 2.3 「無効化」の粒度が Grid-3 と違う(重要)

Grid-3 の gating は「**位置指定(直後)だけ**無効、末尾/先頭は許可」。
DnD は位置指定そのものなので、**drag 機能全体を無効化**するのが正。具体的には:

- handle を出さない(tag 系の `sortableEnabled` / `dndEnabled` gate と同型 —
  `category-list.tsx:199-201`「1 件以下は DndContext を mount せず素の `<li>`」、
  および popover の「filter 中は handle 非表示」不変条件 `card-tag-add-popover.tsx:153,403-411`)。
- **先例あり**: tag popover は既に「**filter が効いている間は D&D を無効**」を実装済み
  (spec §4.5)。行 DnD の gating はこの先例の同型適用であり、新発明ではない。

### 2.4 gating が index 演算の正しさも担保している(構造的に嬉しい点)

`table.getRowModel().rows` は sort/filter 適用後の行列。
`positionLocked === false`(= sort 0 件 かつ filter 0 件)のときに限り、
表示順 = `data` 順 = `compareByBaseOrder` 順 になる
(`exam-card-table.tsx:360-362` で pre-sort、`join-card-tags.ts:34-37` が順序保持)。

→ **DnD を有効にする条件と、index 演算が基準順と一致する条件が完全に同じ**。
gating を守る限り「表示 index → 常駐列 index」の変換に補正が要らない。

---

## 3. drop 確定 → `card_move` 発行の経路

### 3.1 `useMoveCards` はそのまま呼べるか → **呼べる。変更不要。**

`app/(app)/app/exams/_hooks/use-move-cards.ts:89-190`

```ts
moveCards({ cardIds: string[], targetExamId: string, placement: MovePlacement }): Promise<MoveResult>
```
- 同一 exam 内移動は `targetExamId = examId` を渡すだけ(Grid-3 smoke ① で実証済)。
- mirror 不在 id の除外・重複 id の正規化・単一 source exam の runtime assert・
  移動先 exam の mirror 事前検査 — **すべて hook 内で済んでいる**(`:100-128`)。
- 楽観書込 + outbox enqueue 1 件は `runOptimisticMutation` に閉じており、flush も内蔵
  (`optimistic-mutation.ts:134-135`)。**DnD 側で flush を書く必要はない**
  (tag 系の `void runGuardedEntityMutationFlush(...)` は流用不要)。

### 3.2 `MovePlacement` で表現できるか → **できる**

`lib/cards/domain/card-order.ts:94-97`
```ts
type MovePlacement = { kind:'end' } | { kind:'start' } | { kind:'after'; anchorId }
```
`resolveSplitIndex`(`:225-238`):
- `'start'` → splitIndex 0
- `'end'` → splitIndex = residents.length
- `'after'` → **常駐列**(= targetCards ∖ movedCards)における anchor の index + 1。
  **anchor が常駐列に居ないと throw**(`:232-237`)。

→ **先頭 drop は `{kind:'start'}` で正しい。**
→ それ以外は `{kind:'after', anchorId: residents[splitIndex-1].id}`。
→ 末尾は `{kind:'end'}` でも `{kind:'after', 最終常駐}` でも等価(前者が素直)。

**変換の中身(単一枚ドラッグ)**: `arrayMove` 相当の newIndex がそのまま常駐列の splitIndex になる。
- 例: `[A,B,C,D]`、A を index 2 へ → 常駐列 `[B,C,D]`、splitIndex=2 → anchor = C。
- 例: `[A,B,C,D]`、D を index 1 へ → 常駐列 `[A,B,C]`、splitIndex=1 → anchor = A。
上下どちらでも `splitIndex === newIndex` が成立する(移動元を抜いた列で数えるため)。

**推奨**: この変換は **pure 関数に切り出す**。既存 DnD test の流儀が
「実 pointer drag は jsdom で再現しない / drag-end handler の引数 contract を pin する」
(`category-list.test.tsx:29-54`, `card-tag-add-popover.test.tsx:2010`)なので、
pure 関数化しないと red 検証の的が作れない。

### 3.3 no-op(同順 drop)の扱い — **tag 系のような自動 no-op はない**

tag 側は `reindexSortKeys` が差分 0 件を返し `updates.length === 0` で tx も flush も張らない
(`reindex-sort-keys.ts:35-42`, `reorder-handlers.ts:64`)。
**`planMoveAssignments` にこの短絡はない** — `movedCards.length === 0` の早期 return しかない
(`card-order.ts:126-128`)。同じ位置へ落としても新しい絶対値が割り当てられ、
**mutation が 1 件発行される**。

→ **DnD 側で `!over || active.id === over.id` の early return を必ず置く**
(先例: `category-list.tsx:208-209`)。単一枚ドラッグならこれで同順 drop は完全に潰れる
(over が自分以外なら必ず index が変わるため)。複数枚ドラッグでは追加判定が要る。

### 3.4 toast / undo / pending

`ExamCardTable` 側に**既に全部ある**。DnD からも同じものを使える:
- `runMove`(`:525-557`)= 移動実行 + 成功 toast + 失敗 3 分岐 → 文言。**再利用の第一候補**。
- `moveToast` / `onUndoMove` / `ActionToast`(`:498`, `:761-775`, `:1104-1113`)。
- `movePending`(`:503`)で二重発行を塞ぐ。
- **同期 ref ガード**は Grid-3 教訓 1 / handoff 4 のとおり必須。
  既存の `splitInFlightRef`(`:509`, `:712-713`)が「最初の `await` より前に ref を立てる」形の見本。
  **drag end は click より二重発火しやすい**と handoff に明記されている。

### 3.5 ドラッグは 1 枚か、複数選択ドラッグまで見るか

**書込側の追加コストはゼロ**:
- `moveCards` は `cardIds: string[]` を取る。
- `planMoveAssignments` は `movedCards` を**基準順に並べ替えてから**連続した値を割り当てる
  (`card-order.ts:132`, `:145-168`)。相対順は保持される(Grid-3 smoke ① で実証)。
- 常駐列は `targetCards ∖ movedCards` なので、選択行が飛び地でも anchor 計算は破綻しない。

**UI 側の追加コスト**(ここが本体):
1. dnd-kit に multi-drag は無い。「選択行を掴んだら選択全体が動く」は自前実装:
   `onDragStart` で `active.id ∈ rowSelection` を判定 → 移動対象を選択集合に切替、
   そうでなければ単票(= 一般的な Notion/Airtable 挙動)。**この分岐仕様の決定が要る**。
2. ドラッグ中の視覚: 選択された他行を隠す/薄くする + DragOverlay に「N 枚」を出す。
   **DragOverlay 前提が実質必須になる**(§1.3)。
3. 落とす位置の解決: **選択行の上には落とせない**(anchor が常駐列に無いと domain が throw
   `card-order.ts:232-237`)。over が選択行だった場合の解決規則が要る
   (直近の非選択行に丸める / drop を拒否する のどちらか)。
4. 変換 pure 関数が「複数抜き取り後の splitIndex」を扱う必要がある(単票版より分岐が増える)。
5. `positionLocked === false` = filter 0 件なので、「選択が画面外にある」ケースは
   **仮想化で unmount しているだけ**。`rowSelection` は data 全件基準なので id は取れる(問題なし)。

**評価**: 書込は無料、UI は +1 タスク相当。**単票を先に閉じ、複数枚は別タスクに切る**のが
簡潔性規律(YAGNI / 最小実装)と整合。ただし「選択して一括移動」は**一括バーの「移動」で既に
できる**(Grid-3 UI 入口 a)ので、複数枚ドラッグは**機能の重複**でもある。

---

## 4. カードビュー側

### 4.1 前提の再確認

- カードビューに選択機構は**無い**(`inline-card-list.tsx` に rowSelection 相当なし。Grid-3 で対象外)。
- カードビューに **toast / undo / inline error / pending flag も無い**。
  現状ある state は `newCardIds` と `error`(追加失敗用、`:268-269`)だけ。
- カードビューは**既定 view**(`exam-detail-view.tsx:55` = `useState<View>('card')`)。
- sort/filter が無い = **gating は常に false**(カードビューでは無条件に DnD 可)。

### 4.2 テーブル専用にする場合 vs 両ビュー対応の差分規模

**テーブル専用**(触る file):
1. `exam-card-table.tsx` — DndContext / SortableContext / sensors / onDragEnd / gating 接続
2. `exam-card-table-columns.tsx` — select 列に grip 追加(+ `size` 88 → 112 程度)
3. sortable `<tr>` wrapper(新規 or 同 file 内 local component。**ref マージ**が要る)
4. 新規 pure module — 表示 index → `MovePlacement` 変換(+ unit test)
5. `use-tag-sortable-sensors` の cards 版 or 共有化(§5)
6. DragOverlay 用の `<table><tbody>` 器
→ **既存の toast/undo/error/pending をそのまま使える**ので、UI 基盤の新設はゼロ。

**両ビュー対応 = 上記 + 以下**:
7. `inline-card-list.tsx` — DndContext / SortableContext / sortable `<li>` / grip をカード header へ
   (`:125-150` の question_label・title・削除ボタン行が置き場)
8. **`useMoveCards` の 2 個目の呼出元**を新設 + **toast / undo / error / pending を新規実装**。
   これが最大コスト。テーブル側と同一ロジックになるが、
   現時点で実在する重複は 2 箇所 = **rule of three 未満なので共通化は不可**(簡潔性規律)。
   → 「同じものを 2 回書く」か「3 回目を待たずに抽象化する」かの判断が要る = **OT 論点**。
9. カードビュー独自の衝突検証: `InlineTextField` の blur-commit、`CardImageGallery`/PhotoSwipe、
   タグ popover、`scrollToIndex` による自動スクロール(`:318-327`)との干渉。

**規模比**: ざっくり **テーブル専用 : 両ビュー ≒ 1 : 2**。しかも 8 の重複が構造的に汚い。

### 4.3 カードビューで DnD が実用になるかの疑義(重要)

- 行高 **738px 推定**。1042×575 の実測 median 由来(`:75`)。
  一般的な viewport で同時 mount は 1〜2 枚 + overscan 3。
- つまり **drop 候補がほぼ「1 つ上/1 つ下」しかない**。長距離移動は auto-scroll 頼みで、
  §1.3(g)(h) の「元行 unmount」に最も早く突き当たるのがカードビュー。
- 一方 **並べ替えの主戦場はテーブルビュー**(行が 120px 推定 = 一度に数十行見える)。

**推奨(spec への提案)**: 行 DnD は**テーブルビュー専用**で切る。
カードビューは「並べ替えたいならテーブルビューへ」で足りる(view 切替は 1 クリック、
`exam-detail-view.tsx:177-195`)。カードビュー対応は必要が実証されてから別 sprint。

---

## 5. tag 系 DnD の再利用可能資産

### 5.1 `useTagSortableSensors` — **ほぼそのまま使えるが、名前と前提を確認すべき**

`lib/tags/use-tag-sortable-sensors.ts:26-34`
```ts
useSensors(
  useSensor(MouseSensor),                                            // PC = 即ドラッグ
  useSensor(TouchSensor, { activationConstraint: { delay:250, tolerance:5 } }), // 長押し
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),  // a11y
)
```
- 構成自体は cards でも妥当(PC 即 / touch 長押し / keyboard)。
- **ただし置き場が `lib/tags/`**。cards から import すると文脈が合わない。
  選択肢: (i) そのまま import(最小・命名が嘘になる)/ (ii) `lib/dnd/` 等へ移設して 3+1 site が共有
  / (iii) cards 用に別 hook。
  **実重複は現在 3 site が既に共有中**(popover / category-list / option-list)。
  4 site 目が来る = rule of three は充足済みなので、**(ii) 移設が規律的に正**。ただし
  「タスク範囲外のコードを触らない」とのトレードオフ → **spec で 1 行決める論点**。
- **cards 固有の追加検討**:
  - テーブルは横 scroll もある container(`overflow-auto`)。Mouse 即ドラッグだと
    横スクロール操作と競合しないか(handle 上でしか起動しないので実害は小さいはず)。
  - `MouseSensor` に `activationConstraint: { distance: N }` を足すかは実測後の判断。
    先回りで足さない。
- **`touch-none` を handle にだけ付ける「event 分離契約」**は tag 3 site で test まで含めて
  確立済み(`category-list.tsx:105`, `option-list.tsx:100`, `card-tag-option-list.tsx:462`、
  test は `category-list.test.tsx:590-640` 等)。**行 DnD もこの契約に従うべき**
  (select セル全域 onClick / checkbox / 行メニュー / side-peek ボタンと衝突しないため)。

### 5.2 `reindex-sort-keys` の差分計算 — **前提どおり不要。だが「no-op 短絡」だけは移植が要る**

- `reindexSortKeys` は `'0'..'N-1'` の**相対 index 正規化**。
  `card_move` は `planMoveAssignments` が**絶対値**を返すので、**計算としては完全に不要**。
- **移植すべきは計算ではなく規律 3 点**:
  1. **no-op で mutation を発行しない** — tag 側は差分 0 件で自動的に成立(`reorder-handlers.ts:64`)。
     card_move には無い(§3.3)ので **UI 層で `!over || active.id === over.id` を明示的に書く**。
  2. **defensive filter**(`reorder-handlers.ts:62`「現在の id 集合に無い id を捨てる」)
     — `useMoveCards` が mirror 突合で同等のことを既にしている(`use-move-cards.ts:112-118`)ので
     **重複実装しない**。
  3. **`findIndex === -1` 防御**(`category-list.tsx:210-212`)— 表示 index 解決で同型が要る。
- **`arrayMove`**(`@dnd-kit/sortable` export)は使ってもよいが、必要なのは splitIndex だけなので
  配列を作る意味は薄い。`category-list.tsx:213` は配列が要る設計だったための使用。

### 5.3 その他、流用できる形

| 資産 | 位置 | 行 DnD での使い方 |
|---|---|---|
| DndContext を条件 mount する gate | `category-list.tsx:199-201, 229-271` | `positionLocked` / 件数 < 2 で素の tbody に落とす |
| handle wrapper を local 定義(generic 化しない) | `category-list.tsx:64-120` のコメント | `<tr>` 用 wrapper も同方針で local 定義 |
| handle の見た目 | `GripVertical` + `cursor-grab` + `touch-none` | そのまま |
| `isDragging ? 0.5 : 1` の opacity | `category-list.tsx:96` | DragOverlay 併用時は「元行を隠す」に変わる |
| test 戦略 | `category-list.test.tsx:29-54`(共有 handler を mock、引数 contract を pin) | 実 drag は smoke。変換は pure 関数の unit |
| 実 drag の検証 | — | Playwright MCP `browser_drag` が使える(stg smoke) |

---

## 6. spec で決める必要がある論点(このレポートでは決めない)

1. **対象ビュー**: テーブル専用か両ビューか(§4 は「テーブル専用」を推奨)。
2. **DragOverlay を使うか**(§1.3)。使わない場合、overscan を超える距離のドラッグ中に
   元行が unmount する挙動を受容するか。repo 初導入になる。
3. **複数選択ドラッグを含めるか**(§3.5)。書込は無料 / UI は +1 タスク / 一括バーと機能重複。
4. **gating の文言**: `POSITION_LOCKED_REASON` を流用するか、DnD 用を 1 本足すか(§2.2)。
5. **`useTagSortableSensors` の置き場**: そのまま import / `lib/dnd/` へ移設 / cards 用に別立て(§5.1)。
6. **DnD 成功時に toast + undo を出すか**(既存 `runMove` は必ず toast を出す `:534`。
   ドラッグは操作の即時性が高いので、毎回 toast はうるさい可能性)。
7. **auto-scroll の既定で足りるか**(§1.4)。document 優先 traversal の挙動は smoke で確定。

## 7. コード読解では確定できず、実機/stg smoke が要る項目

- `<tr>` への transform と **pinned セル(`position: sticky`)** の同居挙動(§1.1)。
- **auto-scroll がテーブル内部 container に届くか**(document 優先 traversal、§1.4)。
- 1200 枚級での drag 中の再計測負荷(§1.3 f: 行 mount のたび droppable 全件再計測)。
- touch(実機 mobile)での長押し起動 vs スクロールの誤発火。
- `MemoizedTableBody` の resize 凍結と drag の干渉。
