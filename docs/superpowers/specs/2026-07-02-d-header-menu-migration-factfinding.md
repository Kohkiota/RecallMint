# D: ヘッダーメニュー移植 — fact-finding + 設計案(DRAFT・未 commit / OT 承認前)

- 種別: fact-finding + 設計。実装・commit・push なし。OT 承認で確定 → 実装 task 化。
- 手法: CC(現物 read)+ Codex 独立(`docs/codex/2026-07-02-plan-d-header-menu-migration.md`)→ CC 統合。
- 大原則: **移植のみ**(フィルタ絞り込みロジック・ソート比較・新フィルタ種類を新規開発しない)。唯一の新規 = 適用中インジケータ(state 読取 + 表示のみ)。

## 0. CC / Codex の一致・独自・対立

- **一致**(両者独立に同結論): ①state 中核は `ExamCardTable`(sorting/columnFilters は controlled・columnFilters 非永続)②フィルタ UI は filter-bar が `table.getColumn(id).getFilterValue/setFilterValue` で columnFilters を read/write ③predicates は純関数化済で D では不変が「移植のみ」の要 ④器は Popover 推奨(select/input/nested tag を入れるため DropdownMenu は focus/auto-close が不利)⑤インジケータは column API 読取のみで可、ただし `undefined で解除` 規約維持が必須(空値を残すと dot 誤点灯)⑥header は仮想化 body 外で基本非干渉。
- **CC 独自**: nested popover を「tags 列はソート無し → 列メニュー=タグ popover 直結」で構造的に回避できる点(下記 3)。filterBarWrapperRef の中身が [FilterBar, ColumnVisibilityToggle] で、bar 削除後も toggle が残り wrapper/listOffset は維持される点。
- **Codex 独自**: 連続正解数 input の local state と header menu の mount/unmount 同期の要検討。selection prune が columnFilters 依存(write 先を変えなければ維持)。`th onClick=sort` を単純に trigger 置換すると衝突 → sort のメニュー項目化とテスト更新が必要。`selectOnly` 未指定で現状タグ filter に編集導線が出ている点。
- **対立**: なし(設計判断の分岐はあるが事実認識の対立なし)。

## 1. 既存フィルタ/ソートの実装配線(file:line)

- state 所有 = `exam-card-table.tsx`: `sorting` useState 初期 `[{id:'question',desc:false}]`(:200)/ `columnFilters` 非永続(:202)/ `useReactTable`(:349, getSortedRowModel + getFilteredRowModel + onSortingChange/onColumnFiltersChange)。
- filterFn 紐付け = `exam-card-table-columns.tsx`: tags→`tagsFilterFn`(:162)/ lastCorrect→`answerStateFilterFn`(:218)/ currentStreak→`streakFilterFn`(:231)。
- sortingFn: question→`sortLikeServer`(:127, 連番順)/ lastCorrect→default basic(boolean)/ currentStreak→default auto(数値)/ lastReview→`'text'`(:259)+ `sortUndefined:'last'`。
- 純関数(**D で不変**) = `_lib/card-filter-predicates.ts`: `matchesTagFilter`(:25)/ `matchesAnswerState`(:53)/ `matchesStreakFilter`(:84)。型 `TagFilterValue`/`AnswerStateFilter`/`StreakFilterValue`。
- フィルタ UI(**移設対象**) = `exam-card-table-filter-bar.tsx`(:60): `table.getColumn('tags'|'lastCorrect'|'currentStreak')`(:66-68)。回答状態 select(:166)/ 連続正解数 op+input(:183, local state streakOp/streakInput :78-81)/ タグ = `CardTagAddPopover`(:208, `tagEditCallbacks` 渡し・`selectOnly` 未指定=編集導線 ON)/ 選択中 chip(:225)/ 全クリア clearAll(:154)。
- ヘッダー描画 = `exam-card-table.tsx` thead(:557-611): th onClick=`getToggleSortingHandler`(:578, canSort 時)/ 矢印 `getIsSorted`(:582-588)/ resize handle(:593-606, stopPropagation・select 除外)。
- 併存 = `ColumnVisibilityToggle`(:543, **D では現状維持**)。listOffset/scrollMargin 再計測の `filterBarWrapperRef` ResizeObserver(:504-527)。

## 2. フィルタ/ソート ↔ 列 対応マッピング表

| 列 id | header | ソート | フィルタ | 列メニュー項目(D) |
|---|---|---|---|---|
| select | (全選択) | ✗ | ✗ | **メニューなし(除外・checkbox)** |
| title | タイトル | ✗ | ✗ | なし(D 範囲外) |
| sort_key | ソートキー | ✗ | ✗ | なし |
| question | 問題文 | ✓ 連番順(sortLikeServer) | ✗ | 並び替え(昇/降/解除) |
| options | 選択肢 | ✗ | ✗ | なし |
| **tags** | タグ | ✗ | ✓ タグ絞り込み | **フィルタのみ**(タグ選択) |
| explanation_text | 解説 | ✗ | ✗ | なし |
| memo | メモ | ✗ | ✗ | なし |
| **lastCorrect** | 直近正誤 | ✓ | ✓ 回答状態 | **並び替え + フィルタ** |
| **currentStreak** | 連続正解数 | ✓ | ✓ 数値比較 | **並び替え + フィルタ** |
| lastReview | 最終回答日時 | ✓ ISO順 | ✗ | 並び替え |

- 全 3 フィルタ + 全 4 ソートがいずれかの列に収まる(**宙に浮くもの無し**)。1 列複数 = lastCorrect / currentStreak(ソート+フィルタ同居)。

## 3. ヘッダーメニュー UI 設計案

- **器 = `@/components/ui/popover`**(ColumnVisibilityToggle と同一プリミティブ)。DropdownMenu は不採用(select/number-input/tag popover を内包するため focus・auto-close が不利。Codex 同意)。
- **trigger** = th の header 内容を PopoverTrigger 化。メニューを持つ列(ソート or フィルタあり)のみ trigger、無操作列(title/sort_key/options/explanation/memo)は素の header、select は除外。
- **メニュー内容(列タイプ別)**:
  - sort-only(question, lastReview): 並び替え 昇順/降順/解除(`column.toggleSorting(desc)` / `column.clearSorting()`)。
  - filter-only(tags): タグ選択 = `CardTagAddPopover` を再利用。
  - both(lastCorrect, currentStreak): 1 Popover 内に「並び替え」節 + 「フィルタ」節(回答状態 select / 連続正解数 op+input)。
- **nested popover 回避(CC 独自の肝)**: popover を要するフィルタは tags のみ。tags 列はソート無し → **tags のヘッダー trigger が `CardTagAddPopover` を直接開く**(外側メニューでラップしない)。both 列のフィルタは select/input(非 popover)なので header Popover 内に直置きで nesting 不要。→ Codex の nested-popover リスクは設計で構造的に消える。
- **最大の相互作用変更**: 現状 th click=即ソート。新方式は th click=メニュー開、ソートはメニュー項目。→ **既存 UX 変更 + `sorting.test.tsx`(10件, header click でソート)を「メニュー経由ソート」に更新必要**。OT 方針「Notion 通り」に合致。

## 4. 適用中インジケータ(新規=表示のみ)

- ソート中 = 既存の矢印(`getIsSorted()`→▲/▼)維持。sortable 未ソート時の `⇅` は menu affordance(chevron 等)に置換検討。
- フィルタ中 = tags/lastCorrect/currentStreak のヘッダーに dot/アイコン。読取 = `column.getIsFiltered()`(または `getFilterValue() !== undefined`)。新規ロジックなし。
- **前提**: `undefined で解除` 規約維持(answerState 'all'→undefined / 空 streak→undefined / 空 tag map→undefined)。空値を filter に残すと dot 誤点灯(CC+Codex 一致)。

## 5. 上部バー削除で失われる/変わる機能

| 機能(filter-bar) | 移植後 | 判断 |
|---|---|---|
| 回答状態 select / 連続正解数 op+input / タグ選択 | 各対応列メニューへ移設 | 移植 |
| 選択中 tag chip + 個別 × 解除(:225) | **消失** → インジケータ dot + メニュー内 Check(`allAssignedOptionIds`)で代替 | 一覧性は低下(要 OT 可否) |
| 全フィルタクリア(clearAll, :154) | **消失** → 各列メニュー「この列のフィルタ解除」+ 全体クリアの置き場は未決 | **OT 判断** |
| 連続正解数 local state(op/input) | currentStreak メニュー component へ。開くたび filter 値から再導出(空文字保持は menu 内 local) | 移植(挙動微差) |

## 6. 非回帰(T2/既存機能)

- 仮想化: header は thead(MemoizedTableBody/virtualizer の外)→ 非干渉。getItemKey/spacer/CSS変数幅 不変。
- selection: 行レベル・独立。selection prune は columnFilters 依存(:424)だが filter write 先(setFilterValue)不変ゆえ維持。
- resize: handle 維持(stopPropagation)。menu trigger は header 内容領域、handle は右端 1px → 分離。click(menu開)と drag(resize)の非干渉を smoke 確認。
- listOffset/scrollMargin: `filterBarWrapperRef` は bar 削除後 ColumnVisibilityToggle を含んで残存 → wrapper/ResizeObserver 維持。Popover 開閉は portal → toolbar 高不変 → listOffset 安定。smoke で再確認。
- columnVisibility toggle: D では別 component のまま維持。card-view: 無改変。

## 7. task 分割案(推奨)

- **D1: ヘッダーメニュー shell + sort 移植** — `ColumnHeaderMenu`(Popover)新設、th を trigger 化(メニュー持つ列のみ・select 除外)、sort を menu 項目化(昇/降/解除)。矢印インジケータ維持。`sorting.test.tsx` を menu 経由に更新。
- **D2: 3 フィルタ移植** — 回答状態(lastCorrect)/ 連続正解数(currentStreak)を header menu 内へ、タグ(tags)は header trigger→CardTagAddPopover 直結。`exam-card-table-filter-bar.test.tsx`(3 describe)を新 UI へ port。predicates/filterFn 不変。
- **D3: 適用中インジケータ** — tags/lastCorrect/currentStreak に filter dot(getIsFiltered 読取)。sort 矢印は D1 で維持済。
- **D4: 上部バー撤去 + 回帰** — `ExamCardTableFilterBar` 削除、全体クリアの置き場決定(OT)、listOffset/selection/仮想化 非回帰の test + smoke。
- 併合案: D1+D2 を一括も可だが、sort と filter で test 差が大きいので分離推奨。全 4 task。

## 8. 受け入れ基準

- 各対象列のヘッダークリックでメニューが開く(無操作列・select は開かない)。
- 既存フィルタ(回答状態/連続正解数/タグ)・ソート(4 列)が対応列メニューで**同一結果**で動く(filter-bar.test / sorting.test を新 UI へ port し同等 pass)。
- 適用中インジケータ: ソート=矢印 / フィルタ=dot が該当列に出る。
- 上部フィルタバー削除・失われる機能は代替 or OT 合意済。
- 仮想化(T2)/ selection / 列トグル / resize / card-view 非回帰(既存 test green + smoke)。
- whole-repo lint --max-warnings=0 / typecheck exit0。

## 9. 「移植のみ」担保(具体観点)

- **変更禁止**: `card-filter-predicates.ts`(3 predicate)/ columns.tsx の filterFn・sortingFn 定義 / columnFilters・sorting の state 形 / TagFilterValue・AnswerStateFilter・StreakFilterValue 型。
- 移設は「getFilterValue/setFilterValue/getToggleSortingHandler を呼ぶ UI」を filter-bar・thead から header-menu component へ**移すだけ**。インジケータのみ read-only 新規描画。
- guard: filter-bar.test の絞り込み結果 / sorting.test の並び順が新 UI 操作で byte 等価に再現(port 後 non-vacuous)。

## 10. OT 判断が必要な論点

1. **ヘッダー click = メニュー開(sort は項目化・Notion 通り、sorting.test 更新要)** で確定して良いか。代替 = click-sort 維持 + 別トリガー(kebab)で menu(複雑)。→ 推奨: メニュー方式。
2. **全フィルタクリアの置き場**(bar 削除後): 各列メニュー内解除のみで足りるか / 全体クリアをどこかに残すか。
3. **タグ filter の編集導線**: 現状 `selectOnly` 未指定で作成/編集導線が出る。D は現状維持(純移植)で良いか / filter 文脈では `selectOnly=true` にするか(挙動変更)。→ 推奨: 現状維持。
4. **選択中 tag chip 消失**の許容(dot + メニュー内 Check で代替)。→ 推奨: 許容。
