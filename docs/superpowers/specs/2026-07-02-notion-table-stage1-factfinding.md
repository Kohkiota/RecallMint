# Notion 式テーブル操作 段階1 — fact-finding + 設計案(DRAFT・未 commit / OT 承認前)

- 種別: fact-finding + 設計。実装・commit・push なし。OT 承認で確定 → 段階ごと実装 task 化。
- 手法: CC(現物 read + Context7 で TanStack API 裏取り)+ Codex 独立(`docs/codex/2026-07-02-plan-stage1-dynamic-filter-sort-bar.md`)→ CC 統合。
- 土台: 前回 D fact-finding(`docs/superpowers/specs/2026-07-02-d-header-menu-migration-factfinding.md`)の配線確認を再利用。
- 段階1 scope: 器(ヘッダーメニュー + 動的バー)+ 既存 3 フィルタ/4 ソートの**動的化** + 適用中インジケータ。**新規種類=段階3-4 / sticky=段階2 / 列固定=段階5**(段階1 では実装しない。器が後段を載せられるかのみ確認)。
- 大原則: 段階1 は**既存 predicate ロジックを新規開発しない**(動的化 = state の持ち方 + UI の問題)。

## 0. CC / Codex の一致・独自・対立

- **一致**: ①state 中核=`ExamCardTable` の controlled `sorting`/`columnFilters`、predicate 不変で UI だけ動的化可 ②器は `Popover` 推奨(select/input/tag を内包、DropdownMenu は不利)③インジケータは `getIsSorted`/`getIsFiltered` の read-only ④`undefined で解除`規約維持(空値残すと dot 誤点灯)⑤header は仮想化 body 外で基本非干渉、ただし resize handle と click 領域の分離必須。
- **Codex 独自(重要)**: ⓐ`ColumnFiltersState` は配列だが**実質 column id ごと 1 filter value** = 同一列複数条件には不向き(段階1 は問題なし、段階3-4 で再検討)ⓑ**hidden column に active 条件が残ると header indicator では見えず解除不能に近い → 動的バーが唯一の全体可視化面**ⓒ`filterBarWrapperRef` は「消す」でなく**動的バー+列トグルの高さ測定 wrapper として再定義**(scrollMargin/listOffset)ⓓ初期 `question asc` を「条件」とみなすか「既定順」とみなすか未決 → ゼロ時シュリンクと矛盾するので決める必要。
- **CC 独自(Context7 裏取り)**: sort 動的追加/削除の具体 API = `column.toggleSorting(desc, isMulti=true)`(add/replace/flip/remove)/ `table.setSorting(updater)`(配列 reducer)。初期順は**データ側 pre-sort で保証されるため `sorting=[]` を既定にできる**(下記 2)。器を capability-driven にすれば段階3-5 が config 追加で載る(下記 6)。
- **対立**: なし。設計判断の分岐(state primary の取り方・初期ソート扱い)は OT 判断事項として明示(§7)。

## 1. 既存配線(D で確認済 / 要点再掲・file:line)

- state = `exam-card-table.tsx`: `sorting` 初期 `[{id:'question',desc:false}]`(:200)/ `columnFilters` 非永続(:202)/ `useReactTable`(:349, getSortedRowModel + getFilteredRowModel + onSortingChange/onColumnFiltersChange)。
- filterFn = columns.tsx: tags(:162)/ lastCorrect(:218)/ currentStreak(:231)。sortingFn: question=sortLikeServer(:127)/ lastReview='text'(:259)。**純関数 = `_lib/card-filter-predicates.ts`(:25/:53/:84)= 段階1 不変**。
- 固定フィルタ UI = `exam-card-table-filter-bar.tsx`(:60, getColumn().getFilterValue/setFilterValue :66-68 / 回答状態 select / 連続正解数 op+input local state :77-81 / タグ=CardTagAddPopover :208 / chip :225 / clearAll :154)。
- header 描画 = table.tsx thead(:557-611, th onClick=getToggleSortingHandler :578 / 矢印 getIsSorted :582 / resize handle stopPropagation :593-606)。
- データ pre-sort = table.tsx useLiveQuery `filteredCards ... .sort(sortLikeServer)`(:228-231)。ColumnVisibilityToggle(:543)/ filterBarWrapperRef ResizeObserver→listOffset(:504-527)。

## 2. 動的フィルタ/ソート state 設計(既存 predicate 不変)

**採用: TanStack `sorting`/`columnFilters` を primary source of truth のまま「動的に add/update/remove」する**(独自 condition-list state は段階1 では作らない = 最小・最低リスク)。

- **ソート(SortingState = 順序付き配列, Context7 確認)**:
  - 追加/更新 = `column.toggleSorting(desc, /*isMulti*/ true)`(直接呼びは multi を明示要・Context7)。または `table.setSorting(prev => append/update/remove)` の reducer。
  - 削除 = `setSorting(prev => prev.filter(s => s.id !== id))`。
  - 複数ソート = 配列がネイティブ対応。順序 = 配列順(バーの並び順 = 優先順位)。
- **フィルタ(ColumnFiltersState = `{id, value}[]`, 実質 column id ごと 1 value)**:
  - 追加/編集 = `column.setFilterValue(value)`(既存 filter-bar と同一経路)。削除 = `setFilterValue(undefined)`。
  - 段階1 の 3 フィルタは**別々の列**(tags/lastCorrect/currentStreak)= 1列1条件 = この形に完全適合。
  - **拡張の注意(Codex)**: 段階3-4 の「同一列に複数テキスト条件」は 1列1value に不向き。前倒し実装はしないが、**将来は該当列の filter value を「条件配列」にして predicate 側で AND 評価**する逃げ道を想定(TanStack primary を維持できる)。段階1 のバーは後述の generic `Condition[]` 投影にしておけば state 表現変更に耐える。
- **初期ソート `question asc` の扱い(OT 判断・§7-1)**: データが `sortLikeServer` で pre-sort 済(:228)ゆえ `sorting=[]` でも行順は連番順を保つ。→ **初期 `sorting=[]`(バー空・ゼロ時シュリンクと整合)、既定順はデータ pre-sort で担保**を推奨。全ソート削除時も自然に連番順へ戻る。

## 3. ヘッダーメニュー UI

- 器 = 既存 `components/ui/popover`(D と同一・DropdownMenu 不採用理由も同じ)。
- th の header 内容を PopoverTrigger 化。**capability-driven**: `column.getCanSort()` なら「並び替え(昇順/降順)」項目、その列に filter editor が登録されていれば「フィルタを追加」項目。両無しの列(title/sort_key/options/解説/メモ)は素の header、select 除外。
- click 領域分離(Codex 指摘): header 内容=menu trigger / 右端 1px=resize handle(stopPropagation 既存)/ select=checkbox。DOM 構造で明示。
- sort 項目は `toggleSorting(desc, true)` or `setSorting` reducer で add-or-update(即ソートでなくメニュー経由=Notion)。

## 4. 動的バー UI

- **sorting + columnFilters を generic `Condition[]` に投影**して chip 列挙:
  - sort chip: 「並び替え: 連続正解数 ↓」+ 方向 flip / × 削除。順序 = sorting 配列順。
  - filter chip: 「連続正解数 ≤ 2」「回答状態: 未回答」「タグ: X」+ 編集(editor 再オープン)/ × 削除。
- 条件ゼロ → バー**シュリンク**(非表示/畳む)。条件あり → 「すべてクリア」。
- **hidden column の active 条件もバーに必ず出す**(Codex ⓑ: 唯一の全体可視化面。indicator は可視列のみ)。
- 現行固定 filter-bar を本バーに置換。連続正解数の op/input local state は編集 editor(popover)へ移し、開くたび columnFilters から復元。
- **バー高さ変化 → ResizeObserver 測定対象に含める**(Codex ⓒ: filterBarWrapperRef を「動的バー+列トグル」wrapper として再定義)。T2 の scrollMargin/listOffset 非回帰の要。

## 5. 適用中インジケータ

- 可視列ヘッダー: ソート中=矢印(`getIsSorted` 既存維持)/ フィルタ中=dot(`getIsFiltered` 読取・新規は表示のみ)。
- hidden 列: ヘッダー不可視 → §4 の動的バーが担保。
- `undefined で解除`規約維持(誤点灯防止)。

## 6. 非回帰 + 後段拡張性

**非回帰**: 仮想化(thead 外)/ selection(prune は columnFilters 依存 :424 だが setFilterValue 経路不変で維持)/ 列トグル(別 component 維持)/ resize(handle 分離)/ card-view 不変。**要注意 = 動的バー高さの ResizeObserver 再定義**(listOffset)。
**後段拡張性(器が阻害しないか)**:
- 段階2 sticky: 動的バー・thead は通常要素 → 後で `position:sticky` を additive に付与可。ただし `useWindowVirtualizer`(document 座標 + scrollMargin)と sticky header の相互作用は段階2 で要検証(器は阻害しない)。
- 段階3-4 新規ソート/フィルタ: メニューが capability-driven(getCanSort / 登録 filter editor)なら新列は config 追加で自動的にメニュー項目化。バーは generic `Condition[]` 投影ゆえ新条件も自動表示。同一列複数条件は §2 の value-as-array 逃げ道。
- 段階5 列固定: TanStack `columnPinning` state 追加 + メニューに「固定」項目 additive。バー非依存。
→ **capability-driven メニュー + generic Condition[] バー + TanStack primary state** の 3 点を段階1 で守れば後段は載る。

## 7. OT 判断が必要な論点

1. **初期ソート**: `sorting=[]`(既定順はデータ pre-sort で担保・バー空)で良いか(推奨)。代替 = `question asc` を暗黙 default として保持しバー非表示。
2. **state model**: TanStack `sorting`/`columnFilters` primary の投影バー(段階1 推奨・低リスク)で確定して良いか。独自 condition-list primary は段階3-4 の同一列複数条件が現実になった時点で再検討。
3. **ヘッダー click = メニュー**(sort 項目化・即ソート廃止・sorting.test 更新)で確定(D から継続論点)。
4. **タグ filter の編集導線**: 現行 `selectOnly` 未指定=作成/編集導線あり。段階1 は「既存フィルタの動的化」ゆえ filter 文脈では `selectOnly=true`(選択のみ)にするのが自然(Codex も過剰と指摘)。純移植優先で現状維持か / `selectOnly=true` か。
5. **全クリア/個別解除の所在**: 動的バーに「すべてクリア」+ 各 chip の × で確定して良いか。

## 8. task 分割案(段階1 内)

- **S1-1: ヘッダーメニュー shell + sort 動的化** — `ColumnHeaderMenu`(Popover, capability-driven)+ th trigger 化(select 除外)。sort を `setSorting`/`toggleSorting(desc,true)` の add-or-update に。矢印維持。`sorting.test.tsx`(10件)を menu 経由へ更新。初期 `sorting=[]` 化(§7-1 承認後)。
- **S1-2: 動的バー shell** — sorting+columnFilters → `Condition[]` 投影 chip、個別 ×、すべてクリア、ゼロ時シュリンク、hidden 列条件も表示。固定 filter-bar と一時共存。
- **S1-3: フィルタ動的化** — 回答状態/連続正解数/タグ を「header メニューのフィルタ追加」+「バーの編集/削除」に接続(既存 `setFilterValue` 経路・predicate 不変)。`exam-card-table-filter-bar.test.tsx`(3 describe)を新 UI へ port。
- **S1-4: 適用中インジケータ** — filter dot(`getIsFiltered`)追加、sort 矢印維持。
- **S1-5: 固定 filter-bar 撤去 + 非回帰** — `ExamCardTableFilterBar` 削除、`filterBarWrapperRef` を動的バー wrapper に再定義、listOffset/selection/仮想化 の test + smoke。
- 併合可否: S1-2+S1-3(バーとフィルタ接続)、S1-4+S1-5(仕上げ)を各1本に統合も可 = 最小 3 本。分離 5 本推奨(sort と filter で test 差大)。

## 9. 受け入れ基準

- 各対象列ヘッダークリックでメニュー(無操作列・select は非)。並び替え・フィルタ追加ができる。
- 追加条件が動的バーに chip 表示、編集・個別削除・全クリア・ゼロ時シュリンクが動く。hidden 列条件もバーに出る。
- 既存 3 フィルタ・4 ソートが**同一結果**(filter-bar.test / sorting.test を新 UI へ port し同等 pass)。
- 適用中インジケータ(可視列: 矢印/dot)。
- 仮想化(T2)/ selection / 列トグル / resize / card-view 非回帰(既存 test green + smoke、特に listOffset)。
- whole-repo lint --max-warnings=0 / typecheck exit0。

## 10. 「移植/動的化のみ」担保

- **変更禁止**: `card-filter-predicates.ts`(3 predicate)/ columns.tsx の filterFn・sortingFn 定義 / 型 TagFilterValue・AnswerStateFilter・StreakFilterValue。
- 動的化 = state を「固定 UI 紐付け」から「add/remove する配列運用」に変える + UI を header メニュー & 動的バーに移すのみ。predicate に渡る value 形は不変。
- guard: filter-bar.test の絞り込み結果 / sorting.test の並び順が新 UI 操作で等価再現(port 後 non-vacuous)。
