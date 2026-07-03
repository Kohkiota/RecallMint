# Notion 式テーブル操作 S1: ヘッダーメニュー + 動的条件バー(既存機能の動的化)

- 作成: 2026-07-03
- シリーズ: Notion 式テーブル操作 段階1(S1)。器を作り、既存フィルタ/ソートを動的化する。
- 種別: spec(design record)。plan は本 spec を起点。本 spec は実装せず。
- 前提: fact-finding 済(`docs/superpowers/specs/2026-07-02-notion-table-stage1-factfinding.md` / 旧 D `2026-07-02-d-header-menu-migration-factfinding.md`)+ Codex 独立論点(`docs/codex/2026-07-02-plan-stage1-dynamic-filter-sort-bar.md`)。fact-finding §7 の OT 判断論点は kickoff で全て確定済(§3)。
- Step 0 照合(2026-07-03): 7/2 以降の当該 dir 変更は `inline-text-field` のみ(20c1b2c)。table 配線は fact-finding どおり(行番号 +2 シフト: sorting :202 / columnFilters :204 / pre-sort :232 / useReactTable :351 / filterBarWrapperRef :506 / th onClick :578 / resize stopPropagation :599)。**訂正 1 点**: fact-finding の「sorting.test.tsx 10 件 = header click でソート」は不正確。実態は sorting **state を直接渡す harness**(`getSortedIds(data, sorting)`・UI 非依存・sortingFn/sortUndefined 検証)→ S1 で無改変のまま green 維持できる(§7)。
- スコープは OT 凍結済(kickoff)。spec はこれを動かさない。仕様変更が要るなら停止して OT 相談。

---

## 1. 目的 / ゴール

試験詳細テーブルの固定フィルタバー + ヘッダー即ソートを、Notion 式の**ヘッダーメニュー + 動的条件バー**に置き換える。

- ヘッダークリック → その列のメニュー(ソート/フィルタ項目を capability で出し分け)。
- 追加された条件が動的バーに chip で並ぶ(編集 / 個別 × / すべてクリア / 条件ゼロでシュリンク)。
- 既存 3 フィルタ(直近正誤 / 連続正解 / タグ)+ 既存 4 ソート(問題文 / 直近正誤 / 連続正解 / 最終回答日時)をこの器に載せ替える。**新規の種類は作らない**。
- active 状態インジケータ(ソート矢印 + フィルタ dot)。

### スコープ外(別段階)

新規ソート種類(タイトル/ソートキー/タグ)= S3 / 新規テキストフィルタ = S4 / sticky(バー・ヘッダー固定)= S2 / 列固定 = S5。ただし器が壊れず後段が additive に載ること(§6)は本 spec で担保する。

---

## 2. 全体ルール / 制約

- 起点は本 spec のみ。spec 凍結。
- 各 task 完了条件 = ① 該当 unit/component test green ② canonical(`superpowers:requesting-code-review`・template 改変なし)+ Codex 独立レビュー両者 Critical/Important 0 ③ `[reviewed]`。
- **predicate 不変(最重要ゲート)**: `_lib/card-filter-predicates.ts`(3 predicate)/ `exam-card-table-columns.tsx` の filterFn・sortingFn 定義 / 型 `TagFilterValue`・`AnswerStateFilter`・`StreakFilterValue` を変更しない。動的化 = TanStack state の持ち方 + UI の問題として閉じる。predicate に渡る value 形も不変。
- **簡潔性規律(横断)厳守**: capability「登録」は plain object map 1 箇所(plugin 基盤・factory を作らない)。`Condition[]` は描画用の派生値(独自 primary state を作らない)。防御コード・汎用引数を足さない。タスク範囲外(card-view / inline 編集 / 列トグル内部)を触らない。
- `undefined` で解除規約維持(answerState 'all'→undefined / 空 streak→undefined / 空 tag map→undefined。空値を残すと dot 誤点灯)。
- Test: Vitest + RTL。AI/課金は非該当。`git commit --no-verify` / `-n` 全面禁止。

---

## 3. 確定した設計判断(OT 凍結・kickoff 2026-07-03)

1. **state = TanStack `sorting` / `columnFilters` が primary**。動的 add/remove は配列運用(`setSorting` / `column.toggleSorting(desc, /*isMulti*/ true)` / `setFilterValue`)。独自 condition-list state は作らない。
2. **初期ソート = 空(`sorting: []`)**。データは `sortLikeServer` で pre-sort 済(exam-card-table.tsx:232)ゆえ行順は連番順を保つ。バー空 = シュリンクと整合。全ソート削除時も自然に連番順へ戻る。
3. **ヘッダー click = メニュー開**(即ソート廃止)。sorting 系 test を menu 経由に更新。
4. **タグフィルタ = `selectOnly={true}`**(選択のみ。option 作成/編集導線なし)。
5. **メニュー = capability-driven な Popover**(`getCanSort()` / 登録された filter editor で項目を出し分け)。
6. **動的バー = generic な `Condition[]` 投影**(sort/filter 条件を同一の器で描画。個別 chip × + すべてクリア)。
7. **hidden 列の active 条件は動的バーが唯一の可視化面**(列を隠しても効いている条件が見え、解除できる)。

---

## 4. 設計

### 4.1 state(`ExamCardTable` 内・変更最小)

**現状**: `sorting` 初期 `[{id:'question',desc:false}]`(:202)/ `columnFilters: []`(:204、非永続)。controlled で `useReactTable`(:351)に接続済。
**S1**: 初期 `sorting: []` に変更(§3-2)。それ以外の state 形・接続は不変。sorting 配列の順序 = 優先順位 = バーの chip 並び順。columnFilters は列ごと 1 value(既存 3 フィルタは別列ゆえ完全適合)。両 state とも非永続のまま。

### 4.2 ColumnHeaderMenu(新規 component・Popover)

th の header 内容を PopoverTrigger 化(即ソート `onClick` は撤去)。器は `components/ui/popover`(D fact-finding の選定理由踏襲: select/input/tag popover を内包するため DropdownMenu 不採用)。

- **capability で出し分け**: 並び替え節 = `column.getCanSort()`。フィルタ節 = filter editor registry(§4.3)に登録がある列のみ。両方なし(title / sort_key / options / explanation_text / memo)= 素の header(trigger 化しない)。`select` 列 = 除外(checkbox 実体)。
- **列タイプ別内容**: sort-only(question, lastReview)= 昇順/降順の 2 項目。both(lastCorrect, currentStreak)= 並び替え節 + フィルタ editor 直置き。filter-only(tags)= header trigger が `CardTagAddPopover` を**直接開く**(`selectOnly` 指定・外側メニューでラップしない = nested popover を構造的に回避)。
- **sort 項目の挙動** = add-or-update(`toggleSorting(desc, true)`: 未追加なら末尾に追加、追加済なら方向更新)。**解除はメニューに置かずバー chip × に集約**(最小)。
- **click 領域分離**: header 内容 = menu trigger / 右端 handle = resize(既存 stopPropagation :599 維持)/ select = checkbox。DOM 構造で明示。

### 4.3 filter editor registry(capability の「登録」)

`columnId → editor component` の plain object map 1 箇所(列表示名・値の chip 要約はバー側の純関数が持つ。§4.4)。S1 の登録は既存 3 フィルタのみ:

- `lastCorrect`: 回答状態 select(既存 filter-bar :166 相当を移設)。
- `currentStreak`: op + 数値 input(既存 :183 相当を移設。**op/input の local state は editor component 内へ移し、開くたび `getFilterValue()` から復元**)。
- `tags`: `CardTagAddPopover`(`selectOnly` / `tagEditCallbacks` 省略)。

editor は「値を作って `column.setFilterValue(value)` を呼ぶ / 解除は `undefined`」のみ(既存経路と同一)。ヘッダーメニューのフィルタ節とバー chip の編集(§4.4)が同じ editor を共有する。新列のフィルタは map に 1 entry 足すだけで menu / バー / dot に載る(S3-4 の載せ口)。

### 4.4 動的条件バー(新規 component)

`sorting` + `columnFilters` から描画用 `Condition[]` を導出して chip 列挙(**派生値であり state ではない**):

- sort chip: 「並び替え: 連続正解数 ↓」。方向 flip(click)+ × 削除(`setSorting(prev => prev.filter(...))`)。並び順 = sorting 配列順。
- filter chip: 「回答状態: 未回答」「連続正解数 ≤ 2」「タグ: N 件」等の要約 label。click で該当 editor(§4.3)を chip anchor の Popover で再オープン(編集)。× = `setFilterValue(undefined)`。
- 「すべてクリア」= `sorting: []` + `columnFilters: []`(条件が 1 件以上ある時のみ表示)。
- **条件ゼロ → バーは render しない(シュリンク)**。
- **hidden 列の条件も必ず表示**(§3-7)。chip label の列表示名は registry / 列定義由来の静的 map から引く(hidden でも `table.getColumn(id)` は取得可)。
- 既存固定 `ExamCardTableFilterBar` はこのバーで置換(S1-5 で撤去)。

### 4.5 インジケータ(read-only)

- ソート中 = 既存矢印(`getIsSorted()` :563-588)維持。sortable 未ソート時の `⇅` は menu affordance(chevron)に置換。
- フィルタ中 = registry 登録列のヘッダーに dot(`getIsFiltered()` 読取のみ)。
- hidden 列はヘッダー不可視 → §4.4 のバーが担保。

### 4.6 ResizeObserver / listOffset(非回帰の要)

`filterBarWrapperRef`(:506-538)は「消す」でなく**動的バー + ColumnVisibilityToggle の wrapper として再定義**。条件追加/削除/シュリンクでバー高さが変わるたび ResizeObserver → listOffset 再計測が走ること(T2 仮想化の scrollMargin 前提)。Popover 開閉は portal ゆえ toolbar 高さ不変。

---

## 5. 非回帰

- 仮想化(T2): header は thead = MemoizedTableBody / virtualizer の外 → 非干渉。listOffset は §4.6 で担保。
- selection: prune は columnFilters 依存(:426-430)だが write 経路(`setFilterValue`)不変 → 維持。
- resize: handle 分離維持(:599)。menu open と resize drag の非干渉を smoke。
- 列トグル(`ColumnVisibilityToggle` :545)/ card-view(`InlineCardList`)/ inline 編集: 無改変。
- フィルタ/ソートの**結果同一性**: filter-bar.test / sorting.test の期待結果を新 UI 操作で等価再現(port 後 non-vacuous)。

---

## 6. 後段拡張性(S1 で守る 3 点・器の保証)

1. **capability-driven メニュー**: 新ソート = 列定義で `enableSorting`+`sortingFn` 追加、新フィルタ = registry 1 entry 追加で、メニュー項目が自動で増える(S3-4)。
2. **generic `Condition[]` バー**: 条件の種類に依存しない投影ゆえ新条件も自動で chip 化。同一列複数条件(S4)は該当列の filter value を条件配列にして predicate 側 AND 評価する逃げ道(TanStack primary 維持・Codex 論点ⓐ)。
3. **TanStack primary state**: sticky(S2)は通常要素への `position:sticky` 付与、列固定(S5)は `columnPinning` state + メニュー項目の additive 追加。器は阻害しない。

---

## 7. テスト方針

- `exam-card-table-sorting.test.tsx`(10 件): sorting state 直渡しの harness(UI 非依存)で sortingFn 不変ゆえ**無改変 green 維持**。メニュー経由の sort add-or-update / 複数ソート(配列 append・方向更新・chip × 削除)/ 初期 `sorting=[]`(連番順維持)は**新規 UI test**(header-menu / condition-bar test)で担保。
- `exam-card-table-filter-bar.test.tsx`(3 describe): 「ヘッダーメニューで追加 → バーで編集/削除」へ port(絞り込み結果の期待値は不変)。
- 動的バー: chip 表示 / 個別 × / すべてクリア / ゼロ時非 render / hidden 列条件の表示 を component test で担保。
- インジケータ: dot の点灯/消灯(`undefined` 解除で消える)を test。
- 非回帰: 既存 column-toggle / bulk / remount 系 test green 維持。listOffset・resize・menu 開閉は stg smoke(DevTools MCP)。

---

## 8. 受け入れ基準

- 対象列ヘッダークリックでメニュー(無操作列・select は非)。並び替え・フィルタ追加ができる。
- 追加条件が動的バーに chip 表示され、編集・個別削除・すべてクリア・ゼロ時シュリンクが動く。hidden 列の条件もバーに出る。
- 既存 3 フィルタ・4 ソートが同一結果(port 後 test 同等 pass)。
- インジケータ: ソート矢印 / フィルタ dot。
- 仮想化 / selection / 列トグル / resize / card-view 非回帰(既存 test green + stg smoke、特に listOffset)。
- whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` exit 0。

---

## 9. task 分割(S1-1〜S1-5・詳細は plan)

- **S1-1**: ヘッダーメニュー shell + sort 動的化(初期 `sorting=[]` 化 / 既存 sorting harness test 無改変 green + menu UI test 新規)
- **S1-2**: 動的バー shell(Condition[] 投影 / 個別 × / すべてクリア / シュリンク / hidden 条件表示。固定バーと一時共存)
- **S1-3**: 既存 3 フィルタの動的化(registry + editor 移設 / filter-bar test port)
- **S1-4**: インジケータ(filter dot + `⇅`→chevron)
- **S1-5**: 固定バー撤去 + `filterBarWrapperRef` 再定義 + 非回帰確認

各段が単独で smoke できる粒度を保つ(一気に作らない = Fix-3 T1.1 型 swap の教訓)。
