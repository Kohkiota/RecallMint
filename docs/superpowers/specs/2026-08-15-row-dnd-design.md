# 行 DnD 設計: テーブルビュー行ドラッグ並べ替え(card_move 消費・1 枚ドラッグ・DragOverlay)

- 日付: 2026-08-15
- 対象 sprint: 行 DnD(Order-1 → Grid-3 → **行 DnD** の 3 sprint の第 3 段)
- 種別: feat(UI 機能追加のみ — **DB migration なし・wire 変更なし・server 変更なし**)
- 状態: **確定・凍結**(2026-08-15 OT 承認 — **§11 の 10 点すべて承認済**。承認時指示の修正 4 点を反映した上で凍結: ① §5.1 `dragCommitRef` は同期 guard + placement null 判定の**後**・最初の await 直前に立てる ② §8-4 に pin 3 ケース追加 ③ §3.2 ref マージは安定 callback ref と明記 ④ §9 全 smoke FAIL を prod blocker 化)。**以後、本 spec は実装フェーズで書き換えない** — 仕様判断が必要になった時点で停止し OT に相談する。
- 入力: OT kickoff(確定 11 項・2026-08-15)/ fact-finding(`docs/superpowers/sessions/2026-08-15-row-dnd-factfinding.md` — dnd-kit dist 実読の根拠 file:line は同 doc)/ Grid-3 spec(凍結・`2026-08-14-grid-3-card-move-design.md`、以下「Grid-3 §n」)/ Grid-3 session doc §7 行 DnD handoff 5 項
- 前提: Grid-3 クローズ済(prod 反映済・main ff-merge 済)。本 spec は Grid-3 §2 の card_move 契約と §5 の client 機構を**消費するだけ**で、順序契約(Order-1)・sync 契約は一切変更しない。変更が必要になった場合は停止して OT へ再昇格(kickoff 決定 11)。

## 0. 目的

テーブルビューの行を handle ドラッグで並べ替えられるようにする。drop 確定は既存 `useMoveCards`(= `card_move` op・exam_id = 現 exam の絶対値割当)を素通しし、新しい書込チャネル・順序ロジックは作らない(Grid-3 §2.4 D-3 の先取り確定を履行)。新規 pure ロジックは「dnd-kit の drop 結果 → `MovePlacement`」の変換 1 本のみ。

## 1. 決定事項

### 1.1 OT 確定(kickoff 11 項 — 本 spec の前提)

1. **テーブルビュー専用・1 枚ドラッグのみ**(複数選択ドラッグ・カードビューは scope 外)。
2. 書込 = 既存 `useMoveCards` / `card_move` op を素通し。新しい順序ロジックは `placementForRowDrop(baseOrderIds, activeId, overId): MovePlacement | null` の pure 関数 1 本。active を除いた最終列で、先頭 = `{kind:'start'}` / それ以外は直前の常駐 card を anchor。over=null・同位置・最終順不変は null(mutation / toast なし)。
3. **DragOverlay を使う**。DndContext / SortableContext の items は仮想表示中の行だけでなく**全基準順 card id**。`verticalListSortingStrategy` + `closestCenter`。DragOverlay は常時 mount(child のみ active 時描画)し document.body へ portal。overlay は table row ではなく**番号・タイトルを示す簡素な div preview**。
4. gating = `positionLocked` 流用・**drag 全体を無効化**・DnD 専用文言 1 本追加(「ソート/フィルタ適用中は並べ替えできません」系)。
5. `useTagSortableSensors` は `lib/dnd/use-sortable-sensors.ts` の `useSortableSensors` へ**移設・改名**し、既存 3 site・test の import / name を追随。Mouse 即時 / Touch delay 250 + tolerance 5 / Keyboard の既存契約は維持。
6. 成功時 toast「並び順を変更しました [元に戻す]」+ 既存 undo 機構(1 枚の card_move の逆発行)。
7. `@dnd-kit/modifiers` は**追加しない**(垂直制約は core の `Modifier` 型で自前 5 行)。
8. drag activator は行全体でなく **select セル内の専用 handle button**。`setNodeRef` / transform は `<tr>`、`attributes` / `listeners` / `setActivatorNodeRef` は handle のみ。handle click は選択 td へ伝播させない。**選択状態に関係なく動くのは常に当該 1 枚だけ**。
9. onDragEnd は**同期 ref guard を最初の await 前**に立て二重発行を防止(Grid-3 handoff 4)。movePending / positionLocked 中は drag 開始不可。失敗は無音にせず、undo action なしの「並べ替えに失敗しました」toast で表示。
10. auto-scroll は既定で開始。実測 3 点(sticky 同居 / auto-scroll 到達 / 1200 枚負荷 + touch 誤発火・resize 干渉)は **§9 smoke に検証項目として明記**。既定実装または仮想化前提が smoke で崩れた場合、custom scroll・virtualizer 変更・追加 package へ進まず**停止して OT へ実測報告**。
11. gate は既存どおり。順序契約・sync 契約の変更が必要になったら停止して再昇格。

### 1.2 spec が確定する設計判断(→ §11 に OT 確認点として集約)

- D-a **handle への listeners 配布 = per-row の `RowDndContext`**(React context)。column def に per-row hook 値を直接通せないため(§3.3)
- D-b **DndContext は常時 mount**。無効化は「handle 非表示/disabled + `useSortable` disabled + onDragEnd 再検査」の 3 層(conditional mount は tbody subtree remount tear-down を引き起こす — §4.1)
- D-c **handle 描画 gate に `rows >= 2` を含める**(tag 先例同型)。`positionLocked` は「描画 + disabled + 理由表示」(§4.2)
- D-d **確定処理は既存 `runMove` を使わず `moveCards` 直呼び + `showMoveToast`**(成功/失敗の文言・表示先が既存 3 入口と異なるため。既存入口の契約は不触 — §5.2)
- D-e **失敗の一様規則: dispatch 後の outcome ≠ ok は全て失敗 toast**(`no-cards` 含む — 「無音にしない」の具体化 — §5.3)
- D-f **`placementForRowDrop` は `lib/cards/domain/card-order.ts` 同居・dnd-kit 非依存**(`overId: string | null` を受ける total 関数 — §2)
- D-g **DnD 一式は新 file `exam-card-row-dnd.tsx` へ**(`exam-card-table.tsx` 1141 行の肥大回避 — §3.6)

## 2. 順序ロジック: `placementForRowDrop`(pure・唯一の新ロジック)

`lib/cards/domain/card-order.ts` に追加(`MovePlacement` 型・`planMoveAssignments` と同居。既存 PURE 制約に従い I/O なし・入力非破壊。**dnd-kit も import しない** — `arrayMove` 相当は自前数行)。

```ts
placementForRowDrop(
  baseOrderIds: string[],   // 基準順 (compareByBaseOrder 順) の当該 exam 全 card id 列
  activeId: string,          // ドラッグした card id
  overId: string | null,     // dnd-kit onDragEnd の over?.id ?? null
): MovePlacement | null
```

### 2.1 意味論

- dnd-kit sortable の `over.id` は「drop 時に active が占める位置の item」。**最終列 = `arrayMove(baseOrderIds, indexOf(activeId), indexOf(overId))`**(dnd-kit 自身の `defaultNewIndexGetter` と同一の解釈 — fact-finding §3.2 で上下両方向の成立を確認済)。
- 最終列における active の位置が index 0 → `{kind:'start'}`。それ以外 → `{kind:'after', anchorId: 最終列[activeIndex−1]}`。直前要素は active 自身ではありえないため **anchor ∈ 常駐列が構造的に保証**され、`resolveSplitIndex` の呼出側契約(anchor 不在 = throw)を満たす。`planMoveAssignments` の splitIndex と一致することは fact-finding §3.2 の等価性(移動元を抜いた列で数えるため `splitIndex === newIndex`)による。

### 2.2 null(= 無音 no-op)を返す条件

① `overId === null` ② `activeId === overId` ③ activeId / overId が `baseOrderIds` に不在(stale・防御)④ 最終列が入力列と一致(defensive invariant — ①〜③で実質尽きるが、関数を total に保つ)。null 時は呼出側が **mutation も toast も発行しない**。この明示 no-op が必須なのは、`planMoveAssignments` に同順 short-circuit が無く(`movedCards` 空の early return のみ)、同位置 drop でも新しい絶対値 + mutation 1 件が発行されてしまうため(fact-finding §3.3 — tag 系は `reindexSortKeys` の差分 0 件で自動成立していた規律を、card_move では UI 層で明示する)。

### 2.3 末尾 drop

最終列の末尾に落ちた場合も一様に `{kind:'after', 最終常駐}`(`{kind:'end'}` と等価だが分岐を増やさない)。

## 3. DnD 構造(dnd-kit × 仮想化)

前提事実(fact-finding §1.3 — dist 実読): SortableContext は未 mount 行の rect 欠落を sparse に許容 / `verticalListSortingStrategy` は rect 欠落で null 素通り / droppable 計測は transform-agnostic(displace 中の再計測で座標が汚れない)/ **droppable になれるのは mount 済み行のみ** / draggable は unmount で登録解除。最後の 2 点が DragOverlay 採用(kickoff 決定 3)の根拠 — overlay はリスト外描画のため元行 unmount に巻き込まれない。**repo 初の DragOverlay 導入**。

### 3.1 DndContext(常時 mount — D-b)

`ExamCardTable` 内、scroll container + table を包む位置に配置(context のみ・DOM 追加なし)。
props: `sensors = useSortableSensors()` / `collisionDetection = closestCenter` / `modifiers = [restrictToVerticalAxis]` / `onDragStart` / `onDragEnd` / `onDragCancel`。**`autoScroll` は指定しない**(既定挙動で開始 — kickoff 決定 10。調整は smoke 実測後、崩れたら停止 → OT 報告)。

### 3.2 SortableContext + SortableRow

- `items = data.map((r) => r.card.id)`(**基準順全件** — 仮想 unmount 行含む。kickoff 決定 3)。`useMemo` で ref 安定化。strategy = `verticalListSortingStrategy`。
- `SortableRow`(`<tr>` wrapper・local component、generic 化しない — tag 系 wrapper と同方針): `useSortable({ id: card.id, disabled: positionLocked || movePending })`。
  - `setNodeRef` は `<tr>` へ。既存 `measureElement` ref と**安定した callback ref でマージ**(useCallback 等で identity を固定。repo に merge helper なし → local 数行)。inline arrow の毎 render 新 ref は React の detach/attach(旧 ref へ null → 新 ref へ node)を毎 render 誘発し、`measureElement` の ResizeObserver が張り直されるため不可(2026-08-15 OT 承認時明記)。
  - style: `transform: CSS.Transform.toString(transform)` + `transition`。`isDragging` 中の元行は opacity 50%(本体は overlay)。
  - `attributes` / `listeners` / `setActivatorNodeRef` は `<tr>` に**乗せない**(handle のみ — kickoff 決定 8)。
- 仮想化整合: spacer `<tr aria-hidden>` は sortable 外のまま / overscan 5 不変 / drag 中に liveQuery が再発火して items が変わる稀ケースは dnd-kit 側の `itemsHaveChanged` 処理(transform 無効化 + 再計測)に委ねる。

### 3.3 handle への配布 = `RowDndContext`(D-a)

select 列の cell renderer(`exam-card-table-columns.tsx`・module スコープ column def)に per-row の `listeners` / `setActivatorNodeRef` を直接渡す経路が無い(meta は table レベル)。よって:

- `SortableRow` が per-row context(`RowDndContext`: `{ listeners, attributes, setActivatorNodeRef, dndEnabled }`)の provider になり、select セル内の新設 `RowDragHandle` component が consumer になる。
- **context 未提供(単体 harness 等)では handle を描画しない**(`meta.rowMenu` / `openCard` の optional 規約と同型)。

### 3.4 handle button(`RowDragHandle`)

- 位置: select セル内・行頭(checkbox の前)。`GripVertical` + `cursor-grab` + **`touch-none` は handle のみ**(tag 3 site の event 分離契約を継承 — test も同型で pin)。
- `onClick` で `stopPropagation`(select td 全域の行選択トグルへ伝播させない — checkbox / 行メニューと同理由・同 pattern)。
- `aria-label` =「行を並べ替え: {card.title}」。dnd-kit が activator に付ける `aria-roledescription="sortable"` は既定のまま。
- select 列 `size: 88 → 112`(grip 24px 分)。

### 3.5 DragOverlay(kickoff 決定 3)

- **常時 mount**: `<DragOverlay>{activeDragCard ? <preview/> : null}</DragOverlay>`。`createPortal(…, document.body)`(SSR は `typeof document` guard — `PullIntoDialog` と同型)。
- preview = **簡素な div**(grip icon + question_label / title の先頭部。`cardLabel` 相当の省略表示)。table row を再現しない = `<table><tbody>` の器問題を構造的に回避(fact-finding §1.3)。
- `activeDragCard` は `onDragStart` で `active.id` から data を引いて state 化、`onDragEnd` / `onDragCancel` で null。dropAnimation は既定のまま(smoke 観察 → 違和感あれば調整)。

### 3.6 垂直制約 modifier(kickoff 決定 7)+ file 配置(D-g)

- `lib/dnd/restrict-to-vertical-axis.ts`: `const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 })`(core export の `Modifier` 型。`@dnd-kit/modifiers` は導入しない)。
- DnD 一式(`SortableRow` / `RowDndContext` / `RowDragHandle` / overlay preview)は新 file **`exam-card-row-dnd.tsx`** に置く(`'use client'` directive なし — 親からのみ import される子、row-menu と同 pattern)。`exam-card-table.tsx`(1141 行)には配線 + handler のみ追加。

## 4. gating(kickoff 決定 4)

### 4.1 3 層無効化(D-b)

判定は既存 `positionLocked = sorting.length > 0 || columnFilters.length > 0`(`exam-card-table.tsx:514`)を**そのまま流用**(新判定を作らない)。gating が守られる限り「表示順 = data 順 = 基準順」が成立し、§2 の index 演算に補正が要らない(fact-finding §2.4 — DnD 有効条件と index 正当性条件が同値)。

DndContext の conditional mount は**しない**: provider の mount/unmount は table subtree の型変化 tear-down = 全行 remount を引き起こす(Fix-3 T1.1 で根治した階段リークと同 class)。代わりに:

1. **handle**: `positionLocked || movePending` で disabled(描画は維持 + 理由表示 — §4.2)。`rows < 2` では描画しない(D-c。tag 先例 `sortableEnabled = list.length >= 2` の同型。1 行では over 候補が自分のみ = 機能的にも無意味)。
2. **`useSortable` disabled**: 同条件で listeners を無効化(dnd-kit 標準経路)。
3. **onDragEnd 再検査**: 冒頭で `positionLocked` なら破棄。drag 中(特に keyboard grab 中)に sort 状態が変わる窓を pointer 操作の不能性だけで否定できない(検証できない分岐であり、起きえない分岐ではない)ため 1 行で塞ぐ。

### 4.2 DnD 専用文言(仮置き — §11-8)

```
ROW_DND_LOCKED_REASON = 'ソート/フィルタ適用中は並べ替えできません(解除すると並べ替えられます)'
```

既存 `POSITION_LOCKED_REASON` は流用しない(「末尾/先頭を使ってください」の代替案内が DnD には成立しない — fact-finding §2.2)。定数は `exam-card-row-dnd.tsx` に置く。表示: handle に `title` + `aria-disabled` + `aria-describedby` → table レベルに **1 個** の sr-only 要素(行ごとに N 個複製しない)。

## 5. drop 確定フロー

### 5.1 onDragEnd(`ExamCardTable` 内 handler)

1. 再入検査: `dragCommitRef.current` が立っていれば即 return(ここでは ref を**読むだけ**で立てない)。
2. `activeDragCard` クリア。
3. `positionLocked` / `movePending` 再検査 → 破棄(§4.1-3)。
4. `placementForRowDrop(data.map(r => r.card.id), active.id, over?.id ?? null)` → **null なら無音 no-op**(mutation / toast なし — §2.2)。
5. **ここで初めて `dragCommitRef.current = true`** + `setMovePending(true)` — **最初の await の直前**(2026-08-15 OT 承認時修正)。手順 1〜5 は全て同期のため、同一 tick の 2 発目は手順 1 で弾かれる(同期 guard の効力は不変・Grid-3 教訓 1 / `splitInFlightRef` と同型 — `exam-card-table.tsx:509,712-713`)。一方、手順 3〜4 の early return は ref に**触れない**ため、no-op 経路が ref=true を残して以後の drag を永久に塞ぐ実装を**構造的に禁止**する。
6. `moveCards({ cardIds: [active.id], targetExamId: examId, placement })` を **try に包み、finally で ref 解除 + `setMovePending(false)`**(reject でも必ず解除 = 再試行可能)。`movePending` は既存 flag 共有 = 一括バー / 切り出し / 取り込みと相互排他。**`useMoveCards` は無変更**(mirror 突合・重複正規化・owner 検証・1 mutation 発行・undo 素材の控えを既に内蔵 — fact-finding §3.1)。

mirror 書込は `useMoveCards` 内の `runOptimisticMutation`(既存)のみ。**DnD 側で local reorder state を持たない** — 表示順の真実は liveQuery pre-sort のままで、drop 後は mirror 書込 → liveQuery 再発火で並びが確定する。transform reset との間の 1 frame は dropAnimation が概ね覆う(§9-10 観察項目)。

### 5.2 toast / undo(kickoff 決定 6・D-d)

- 成功(`ok: true`)→ `showMoveToast('並び順を変更しました', result)`。**既存 toast slot / `ActionToast` / `onUndoMove` / undo 検証・文言をそのまま共用**(新設ゼロ)。undo = 1 枚の card_move 逆発行で、同一 exam 内移動の再採番常駐も `originals` に控え済み(`useMoveCards` の既存契約・Grid-3 smoke ⑥ で復元実証済)。
- 既存 `runMove`(`:525-557`)は**使わない**: 成功文言が「N 枚を移動しました」固定、失敗が呼出側 inline error 前提で、DnD の契約(専用文言 + 失敗も toast)と両方異なる。既存 3 入口の契約を触らず、`moveCards` + `showMoveToast` を直接使う専用 handler とする。

### 5.3 失敗(kickoff 決定 9・D-e)

dispatch 後の **outcome ≠ ok は全て**(reject / `no-cards` / `target-exam-missing`)→ `showMoveToast('並べ替えに失敗しました')`(undo action なし)。分岐しない理由: DnD では target = 表示中の現 exam で `target-exam-missing` は実質不能、`no-cards` = drag 中の並走削除の稀窓でどのみち行が消える。いずれも「行が動かなかった」以上の説明が不要で、無音は kickoff 決定 9 で禁止。placement null(§2.2)だけが dispatch 前の無音 no-op で、これは「失敗」ではない。

## 6. sensors 移設(kickoff 決定 5)

- `lib/tags/use-tag-sortable-sensors.ts` → **`lib/dnd/use-sortable-sensors.ts`**、`useTagSortableSensors` → **`useSortableSensors`**。test も `lib/dnd/use-sortable-sensors.test.ts` へ移動 + import / describe 名追随。
- 追随 site: `category-list.tsx:40` / `option-list.tsx:44` / `card-tag-add-popover.tsx:45` + hook 参照コメント 2 箇所。
- **sensor 契約は不変**(Mouse 即時 / Touch `{delay:250, tolerance:5}` / Keyboard `sortableKeyboardCoordinates` — 既存 test 4 assert がそのまま pin を続ける = 保証不変の移設)。`lib/dnd/` は新設 directory(`restrict-to-vertical-axis.ts` と同居)。
- 移設 commit の分類(挙動不変 refactor として独立 commit にするか)は plan で確定。

## 7. 触る箇所の全列挙

- **domain**: `lib/cards/domain/card-order.ts`(`placementForRowDrop` 追加のみ)
- **dnd 共有(新設 dir)**: `lib/dnd/use-sortable-sensors.ts`(移設・改名)/ `lib/dnd/restrict-to-vertical-axis.ts`(新設)
- **既存 3 site**: `category-list.tsx` / `option-list.tsx` / `card-tag-add-popover.tsx`(import 追随のみ)
- **UI**: `exam-card-row-dnd.tsx`(新設 — SortableRow / RowDndContext / RowDragHandle / overlay preview / 文言定数)/ `exam-card-table.tsx`(DndContext・SortableContext・DragOverlay 配線 + onDragStart/End/Cancel + `dragCommitRef` + `activeDragCard`)/ `exam-card-table-columns.tsx`(select セルに RowDragHandle + size 88→112)
- **DB / wire / server / sync**: **変更なし**(migration なし・schema 不変・registry 不変・`useMoveCards` 不変)
- **test**: §8(sensors test は移設追随)

## 8. テスト戦略

1. **`placementForRowDrop` unit**(`card-order.test.ts` 拡張・厚く): 下→上 / 上→下 / 先頭へ / 末尾へ / 隣接 swap / 2 件列 / over=null / active===over / 不在 id / 最終順不変 → null。**`planMoveAssignments` との合成 round-trip**(返した placement を食わせて throw しない = anchor 常駐保証、割当位置が最終列と一致)。
2. **event 分離契約**(component test — tag 先例 `category-list.test.tsx:590-` と同型): `aria-roledescription` / `touch-none` は handle のみ(checkbox / 開くボタン / 行メニューに付かない)/ handle click で行選択が変わらない(stopPropagation)。
3. **gating**: sorting 適用中 handle disabled + 理由 / rows 1 件で handle 非描画 / context 未提供で handle 非描画。
4. **onDragEnd 接続契約**: 実 pointer drag は jsdom 不可(既存前例)。DndContext を mock して onDragEnd を捕捉・手動発火する方式か handler 切出しかは plan で確定。必須ケース: **同一 tick 2 発 dispatch で `moveCards` 1 回**(同期 ref guard の再入 pin — Grid-3 教訓 1 の probe 形式)/ placement null で `moveCards` 未発行 / 成功で成功 toast / outcome ≠ ok で失敗 toast(undo なし)/ **同位置 no-op(placement null)の後の有効 drop が正常発行される**(no-op 経路が ref を残さない pin — §5.1 手順 5)/ **`moveCards` reject 後に再試行できる**(finally の ref・pending 解除 pin)/ **`moveCards` へ渡る cardIds は常に `[activeId]` のみ**(選択状態に依存しない — kickoff 決定 8 後段の pin)。(後段 3 ケースは 2026-08-15 OT 承認時追加)
5. **sensors 移設**: 既存 4 assert が新 path/name でそのまま green(= 保証不変)。
6. **gate**(既存どおり): whole-repo `pnpm lint --max-warnings=0` / `typecheck` / `build`(postbuild 込)/ `test` / `test:iso`(無条件)/ `pnpm run audit` 全 exit 0。依存・Next 設定 file 不触(`--frozen-lockfile` 系は対象外)。

## 9. stg smoke(push 後・OT 指示で実走)

実 drag は unit で再現しないため smoke が検証の本体。Playwright MCP `browser_drag` + DB readback。

| # | 項目 | 期待 |
|---|---|---|
| 1 | 基本 4 方向(上→下 / 下→上 / 先頭へ / 末尾へ) | DB base_order が Order-1 挿入式と一致・相対順保持 |
| 2 | 同位置 drop | outbox 不増・toast なし(無音 no-op) |
| 3 | undo | 絶対値で完全復元(DB readback) |
| 4 | gating | ソート/フィルタ中 handle disabled + 理由表示 / 解除で復活 / gating 中に既存入口(一括バー)は従来どおり |
| 5 | **[実測 1] sticky 同居** | pinned 列 + sticky thead が `<tr>` transform 中に破綻しない(transform の containing block 化 — fact-finding §1.1) |
| 6 | **[実測 2] auto-scroll 到達** | リスト端で**内部 scroll container** が追従する(既定 traversal は document 優先 — fact-finding §1.4) |
| 7 | **[実測 3] 1200 枚級** | seed-perf-exam 素材で drag 応答性(行 mount ごとの droppable 全件再計測)+ overscan 超えの長距離 drag(元行 unmount)で overlay 維持・auto-scroll 継続・drop 成立 |
| 8 | touch | 長押し 250ms 起動 / スクロール誤発火なし(DevTools emulation → 不足なら OT 実機) |
| 9 | 列 resize 干渉 | resize 中 drag 不発火 / drag 中 resize 不発火(MemoizedTableBody 凍結との同居) |
| 10 | drop 直後の表示 | transform reset ↔ liveQuery 再描画の揺れ・dropAnimation の見え方(元行 unmount 時の fallback 含む)が許容範囲 |
| 11 | keyboard 経路 | handle focus → Space grab → 矢印 → Space drop が動く(sensor 共有で付随する a11y。動作確認レベル) |
| 12 | 回帰 | console error 0 / 既存 4 入口の移動・タグ D&D 3 site が従来どおり |

**FAIL の扱い(2026-08-15 OT 承認時修正)**: #1〜#12 の**いずれの FAIL も prod blocker**(touch #8 / 列 resize #9 を含む — 実測 3 点に限らない)。FAIL の修正が本 spec の凍結契約(§1.1 確定 11 項・§11 裁定)の変更を要する場合は、修正に進まず**停止して OT 相談**。

**停止条件(kickoff 決定 10)**: 特に #5/#6/#7 で既定実装または仮想化前提が崩れた場合、custom scroll・virtualizer 変更・追加 package へ**進まず停止**し、実測(数値・スクリーンショット・reqid)を添えて OT へ報告する。

## 10. scope 外(明記)+ 残余リスク

**scope 外**:

- カードビュー DnD(fact-finding §4: 行高 738px で drop 候補がほぼ隣接のみ + toast/undo 基盤なし。必要が実証されたら別 sprint)。
- 複数選択ドラッグ(書込側コスト 0 だが UI +1 task 相当、一括バー「移動」と機能重複)。
- 試験間 DnD(drop 先は常に現 exam。試験間は既存 4 入口)。
- `@dnd-kit/modifiers` 導入 / custom auto-scroll / virtualizer 変更(smoke で崩れたら停止 → OT)。
- ソート/フィルタ適用中の DnD(解除誘導のみ。表示順ベースの並べ替えはしない)。

**残余リスク(受容・記録)**:

- Grid-3 §11 の 2 件(移動先 exam 並走削除の mirror 乖離 / patch 10,000 件超)は不変。本 sprint は悪化させない(1 枚 DnD の patch は通常 1 件、step=0 再採番時のみ常駐 +N 件 — Grid-3 で受容済の同一経路)。
- smoke 実測 3 点(§9 #5-7)が通るまで、本設計の「既定 autoScroll + 全 id items + DragOverlay」構成は仮説段階。崩れた場合の落とし先は spec 変更を伴うため停止 → OT(勝手に代替実装へ進まない)。

## 11. OT 確認点(spec が新たに確定した判断 — 承認時に併せて裁定)

1. **D-a**: handle への listeners 配布は per-row `RowDndContext`(column def の構造制約による。context 未提供では handle 非描画)— §3.3。
2. **D-b**: DndContext 常時 mount + 3 層無効化(conditional mount は全行 remount tear-down — Fix-3 T1.1 class)— §4.1。
3. **D-c**: handle 描画 gate に `rows >= 2` を追加(tag 先例同型)。positionLocked は「描画 + disabled + 理由」— §4.1/4.2。
4. **D-d**: 確定処理は `runMove` 不使用・`moveCards` 直呼び + `showMoveToast`(既存 3 入口の契約不触)— §5.2。
5. **D-e**: dispatch 後の outcome ≠ ok は一律「並べ替えに失敗しました」toast(`no-cards` 含む)— §5.3。
6. **D-f**: `placementForRowDrop` は card-order.ts 同居・dnd-kit 非依存・`overId: string | null` の total 関数。末尾 drop も `{kind:'after'}` に一様化 — §2。
7. **D-g**: DnD 一式は新 file `exam-card-row-dnd.tsx`(exam-card-table.tsx の肥大回避)— §3.6。
8. **文言仮置き**: 成功「並び順を変更しました」/ 失敗「並べ替えに失敗しました」/ `ROW_DND_LOCKED_REASON` — §4.2/§5。
9. **select 列幅 88 → 112**(grip 追加分)— §3.4。
10. **smoke 停止条件の運用**(§9 実測 3 点が崩れたら実装を進めず OT 報告)— kickoff 決定 10 の確認。
