# Notion 式テーブル操作 S1 実装 plan(ヘッダーメニュー + 動的条件バー)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(既定)。task 単位 fresh subagent + task 間 review。

- 作成: 2026-07-03 / 起点 spec: `docs/superpowers/specs/2026-07-03-notion-table-s1-design.md`(凍結・仕様変更は停止して OT)
- **Goal**: 固定フィルタバー + ヘッダー即ソートを、capability-driven ヘッダーメニュー + generic Condition[] 動的バーへ置換(既存 3 フィルタ / 4 ソートの動的化。新種類なし)。
- **Architecture**: TanStack `sorting`/`columnFilters`(`ExamCardTable` 内 controlled)を primary のまま配列運用に変更。新規 UI 3 unit(header-menu / condition-bar / filter-editors)+ `exam-card-table.tsx` 統合。predicate 層は無変更。
- **Tech**: TanStack Table v8(`toggleSorting(desc, /*isMulti*/true)` / `setSorting` / `setFilterValue(undefined=解除)` / `getIsSorted` / `getIsFiltered`)、`components/ui/popover`、Vitest + RTL + fake-indexeddb(既存 filter-bar.test と同じ構え)。

## Global Constraints(全 task 共通・spec §2)

- **predicate 層変更禁止**: `_lib/card-filter-predicates.ts` / `exam-card-table-columns.tsx` の filterFn・sortingFn / 型 `TagFilterValue`・`AnswerStateFilter`・`StreakFilterValue`。predicate に渡る value 形も不変。
- `undefined` で解除規約(answerState 'all'→undefined / 空 streak→undefined / 空 tag map→undefined)。
- 簡潔性: registry は plain object map 1 箇所 / `Condition[]` は useMemo 派生値(独自 state 化しない)/ 範囲外(card-view・inline 編集・列トグル内部・仮想化 body・resize handle 実装)を触らない。
- 各 task 完了 = TDD(test 先行)+ 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical review(`superpowers:requesting-code-review`・template 改変なし)+ Codex review(`scripts/ai/codex-review.sh`)両者 Critical/Important 0 + `[reviewed]` commit。
- S1 完了 gate: whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0(報告に明記)。stg smoke は OT push 後に DevTools MCP(§S1-5)。
- `git commit --no-verify` / `-n` 全面禁止。

## File 構成(確定)

- Create: `app/(app)/app/exams/[id]/_components/exam-card-table-header-menu.tsx`(S1-1)+ `.test.tsx`
- Create: `app/(app)/app/exams/[id]/_components/exam-card-table-condition-bar.tsx`(S1-2)+ `.test.tsx`
- Create: `app/(app)/app/exams/[id]/_lib/card-filter-labels.ts`(S1-2・label 定数の移設先)
- Create: `app/(app)/app/exams/[id]/_components/exam-card-table-filter-editors.tsx`(S1-3)+ `.test.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(S1-1 thead+初期 sorting / S1-2 バー mount / S1-3 tags header / S1-4 dot / S1-5 wrapper)
- Delete(S1-5): `exam-card-table-filter-bar.tsx` + `.test.tsx`(port 完了確認後)

## Task 間 interface(先に凍結。実装者は自 task 以外を見ない前提)

- `ColumnHeaderMenu({ column, label, filterEditor }: { column: Column<ExamCardRow, unknown>; label: string; filterEditor?: React.ReactNode })` — trigger = header label(`aria-label="${label} の列メニュー"`)。並び替え節 = `column.getCanSort()` 時のみ(「昇順」「降順」= `column.toggleSorting(false|true, true)` 後 close)。フィルタ節 = `filterEditor` 渡し時のみ render。
- `type TableCondition = { kind: 'sort'; columnId: string; desc: boolean } | { kind: 'filter'; columnId: string; value: unknown }` / `deriveConditions(sorting: SortingState, columnFilters: ColumnFiltersState): TableCondition[]`(sort が先・各配列順。condition-bar.tsx から export)
- `ConditionBar({ table, editorContext }: { table: Table<ExamCardRow>; editorContext: FilterEditorContext })` — 条件ゼロなら `null` を返す。
- `FilterEditorContext = { categories: ClientTagCategory[]; options: ClientTagOption[] }`(既存 filter-bar props から `tagEditCallbacks` を落とした形。selectOnly 化で不要)
- registry(filter-editors.tsx): `cardTableFilterEditors: Record<'lastCorrect' | 'currentStreak' | 'tags', React.FC<{ column: Column<ExamCardRow, unknown>; ctx: FilterEditorContext }>>`
- label 定数 `ANSWER_STATE_LABELS` / `STREAK_OP_LABELS` は S1-2 で **`_lib/card-filter-labels.ts`(新設・pure)へ移設** export(filter-bar は import に切替、S1-3 editors も import。condition-bar 所有にしない = bar が domain label の所有者になる依存方向を避ける。Codex 指摘反映)。
- chip の列表示名は **`table.getColumn(id)?.columnDef.header` から導出**(条件を持ちうる 5 列は全て string header = columns.tsx :114/:146/:201/:225/:238。hidden でも取得可)。独自 display-name map を作らない(registry との二重管理回避)。
- testid: sort chip = `condition-chip-sort-<columnId>` / filter chip = `condition-chip-filter-<columnId>` / すべてクリア = button text「すべてクリア」。(columnId 一意キーは S1 前提。S4 同一列複数条件で拡張再訪 = 記録のみ)
- menu 項目 click 後は Popover を閉じる(Radix `PopoverClose` or open state 制御)。filter editor 操作では閉じない(連続編集を許す = 現行固定バーと同じ感覚)。
- 列分類(sort-only / both / filter-only)は**説明であり実装ソースにしない**。実装は常に `getCanSort()` + registry lookup から導出(二重管理回避)。

## 移設元 / 変更点の現物参照(全て `_components/`・行番号は HEAD = 20c1b2c 時点)

- `exam-card-table.tsx`: 初期 sorting `[{id:'question',desc:false}]` とコメント(:201-202)/ columnFilters(:204)/ データ pre-sort `.sort(sortLikeServer)`(:232)/ `useReactTable`(:351, state 接続 :362)/ selection prune の columnFilters 依存(:426-430)/ filterBarWrapperRef + ResizeObserver → listOffset(:506-535)/ wrapper div = [FilterBar, ColumnVisibilityToggle](:538-545)/ thead: th onClick=`getToggleSortingHandler()`(:578)・矢印 `getIsSorted()`(:563, 描画 :582-590)・resize handle stopPropagation(:591-608)。
- `exam-card-table-filter-bar.tsx`(S1-3 の移設元・S1-5 で削除): `ANSWER_STATE_LABELS`/`STREAK_OP_LABELS`(:43-54)/ 回答状態 select(aria-label「回答状態フィルタ」)/ 連続正解数 op select + 数値 input(aria-label「連続正解数 しきい値」・local state `streakOp`/`streakInput`・NaN は書かず undefined 解除)/ tags = `CardTagAddPopover`(categories/options/allAssignedOptionIds/onToggle 配線・現状 `selectOnly` 未指定)。aria-label は port 先でも維持(test 資産流用)。
- `card-tag-add-popover.tsx`: `selectOnly?: boolean`(:99)で作成/編集導線を抑止、`trigger` prop で任意 trigger(:91 付近)。本体無改造。

---

### S1-1: ヘッダーメニュー shell + sort 動的化

**目的**: `ColumnHeaderMenu` 新設(Popover・sort 節のみ)。th の即ソート `onClick` を撤去し、canSort 列の header 内容を menu trigger 化。初期 `sorting` を `[]` に変更(データ pre-sort :232 が連番順を担保)。sort 項目 = add-or-update(`toggleSorting(desc, true)`)。
**制約**: Global。resize handle(:591-608)・sort 矢印表示(`getIsSorted` :563)は無改変維持。`⇅` は S1-4 まで現状のまま。filterEditor prop は受けるが S1-1 では未使用(tags 配線は S1-3)。`exam-card-table.tsx:201-202` のコメント(spec §6 参照)を新仕様(初期 sorting=[]・順序はデータ pre-sort 担保)に更新。th の `cursor-pointer select-none`(canSort 条件)は trigger 化後も維持。multi-sort は TanStack 既定で有効(`enableMultiSort` を明示追加しない)。`toggleSorting(desc, true)` の add-or-update 挙動は test ②③ で固定し、想定外(removal cycle 等)が出たら `setSorting(prev => ...)` reducer へ切替(interface 影響なし。Codex 対立論点の引当)。
**完了条件**:
- header-menu.test(新規): ① canSort 列 header click で menu 開・「昇順」「降順」項目表示 ② 「降順」click → `sorting` に `{id, desc:true}` が append(他列 sort 維持 = multi)③ 追加済列の「昇順」click → 方向更新(重複 entry なし)④ 非 canSort 列(title 等)は trigger 化されない ⑤ select 列除外。
- 既存 `exam-card-table-sorting.test.tsx`(state harness・10 件)無改変 green。
- 初期表示が連番順(既存 exam-card-table.test green で担保)+ `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green。
- canonical + Codex review Crit/Imp 0 → `[reviewed]` commit。

### S1-2: 動的条件バー shell

**目的**: `ConditionBar` 新設。`deriveConditions` で sorting+columnFilters を chip 列挙(sort chip: 「並び替え: <列名> ↑/↓」・click で方向 flip・×= `setSorting` filter 除去 / filter chip: 値要約 label・×= `setFilterValue(undefined)`。編集オープンは S1-3)。「すべてクリア」= 両 state 空化。条件ゼロ → `null`(シュリンク)。hidden 列の条件も表示(列名は凍結 interface どおり `table.getColumn(id)?.columnDef.header` から導出 — `typeof header === 'string'` guard + 非 string 時は `columnId` fallback。guard + fallback があるため非 string header でも壊れない。`table.getColumn(id)` は visibility 非依存ゆえ hidden でも取得可)。独自 display-name map は作らない。`filterBarWrapperRef` 内(既存固定バーと一時共存)に mount。
**制約**: Global。`Condition[]` は useMemo 派生。`ANSWER_STATE_LABELS`/`STREAK_OP_LABELS` を condition-bar へ移設 export し filter-bar は import に切替(表示文言・挙動不変)。filter chip の値要約は既存 3 型(AnswerStateFilter / StreakFilterValue / TagFilterValue=「タグ: N 件」)のみ対応。
**完了条件**:
- condition-bar.test(新規): ① sort 2 件 + filter 1 件で chip 3 個・配列順 ② sort chip × → 当該のみ削除 ③ sort chip click → desc flip ④ filter chip × → `setFilterValue(undefined)` 経路で行復元 ⑤ すべてクリア → 全行復帰 + バー消滅 ⑥ 条件ゼロ時 render なし ⑦ hidden 列の条件可視 = **sort / filter 両 kind** で「列 hide → header 消滅 + chip 残存 → chip × → 全行復元」の一連 UX を test(columnVisibility 初期値だけの vacuous test にしない。Codex 指摘反映)。
- 既存 filter-bar.test 無改変 green(共存中・移設 import 含む)+ suite 全 green → review → `[reviewed]` commit。

### S1-3: 既存 3 フィルタの動的化

**目的**: `filter-editors.tsx` 新設(registry 3 entry)。lastCorrect = 回答状態 select / currentStreak = op+数値 input(local state を editor 内へ・開くたび `getFilterValue()` から復元・NaN は書き込まず undefined 解除)/ tags = `CardTagAddPopover`(`selectOnly` 指定・`tagEditCallbacks` 省略)。header 配線: lastCorrect/currentStreak は menu の `filterEditor` に登録 editor を渡す。tags 列 header = `CardTagAddPopover` 直 trigger 化(menu でラップしない・spec §4.2)。ConditionBar の filter chip click → 同 editor を chip anchor Popover で再オープン(編集)。
**制約**: Global(特に predicate 不変・value 形不変)。editor の値構築ロジックは既存 filter-bar からの移設(挙動同一・aria-label 維持)であり新規判定を書かない。`FilterEditorContext`(categories/options)は `ExamCardTable` が既に持つ `liveData` 由来 props をそのまま流す。固定バーはまだ削除しない。tags の `allAssignedOptionIds`/`onToggle` 配線は filter-bar の adapter 実装を editor へ移設(`tagEditCallbacks` 省略可は `card-tag-add-popover.tsx:67` で裏取り済)。**共存期間の aria-label 重複**(旧バーと新 editor で同名 select/input が並ぶ)→ 新 test は `within`(popover container)で対象限定(Codex 指摘反映)。
**完了条件**:
- filter-editors.test(新規)= 既存 `exam-card-table-filter-bar.test.tsx`(3 describe)の **port**: 回答状態(header menu 経由で絞り込み・'all' で解除)/ 連続正解数(≤ 入力で絞り込み・空で解除)/ タグ(popover 選択で絞り込み・chip × で解除)— 絞り込み結果の期待値は旧 test と同値(non-vacuous)。+ chip click 編集で値変更が反映される 1 件。+ selectOnly で作成/編集導線が出ない 1 件。+ **タグ全解除で filter value が `undefined` になり chip/dot が消える 1 件**(空 `{}` 残置 = dot 誤点灯の主要リスク。Codex 指摘反映)。
- 既存 filter-bar.test はこの時点も green(共存)+ suite 全 green → review → `[reviewed]` commit。

### S1-4: 適用中インジケータ

**目的**: registry 登録列 header に filter dot(`column.getIsFiltered()` 読取のみ・aria-label「フィルタ適用中」)。dot の対象列判定は `cardTableFilterEditors` の key 参照(capability source を registry に一元化 = menu と dot がズレない)。**描画は th レベル**(既存矢印と同じ span 内)= trigger 種別(menu / tags 直 popover)に依存せず tags 列にも同経路で出す。sortable 未ソート時の `⇅` を menu affordance(chevron)に置換(ソート中 ▲/▼ は不変)。
**制約**: Global。read-only(state を書かない)。dot は undefined 解除で消える(規約の可視化)。
**完了条件**: header-menu.test に追加: ① filter 設定で dot 出現・解除で消滅 ② 未ソート列 = chevron・ソート中 = ▲/▼。suite 全 green → review → `[reviewed]` commit。

### S1-5: 固定バー撤去 + wrapper 再定義 + 非回帰

**目的**: `ExamCardTableFilterBar` 本体 + test を削除(port 済は S1-3 で担保済)。`filterBarWrapperRef` を「ConditionBar + ColumnVisibilityToggle の wrapper」として再定義(ref 名/コメント更新・ResizeObserver 経路 :506-538 は維持)。非回帰総点検。
**制約**: Global。ResizeObserver / listOffset 算出ロジック自体は無改変(監視対象の意味づけ更新のみ)。selection prune(:426-430)・仮想化・列トグル・card-view に触らない。
**完了条件**:
- 旧 filter-bar への参照ゼロ(import/grep)。条件追加→削除→ゼロ化でバー高さ変化が ResizeObserver に載る(wrapper 内に ConditionBar がある構造を test で確認)。
- suite 全 green + whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0 → review → `[reviewed]` commit。
- push 前に local dev(`pnpm dev` + DevTools MCP)で下記 smoke ①〜③⑤ を事前確認(④ の実データ量のみ stg。Codex 指摘の前倒し反映。stg を push 前に叩かない規律は不変)。
- **stg smoke 計画(OT push 後・DevTools MCP)**: ① menu 開閉と resize drag の非干渉 ② 複数 sort + filter の chip 操作(flip/×/すべてクリア/シュリンク)③ 列 hidden 状態の条件可視・解除 ④ 5,000 行相当で条件変更時の listOffset 崩れなし(スクロール位置・行描画)⑤ mobile viewport で menu/バー操作。証拠(snapshot / console / IDB)を report に添付。

---

## 実装順序 / リスク / 停止条件

- S1-1 → S1-5 直列(各段が単独 smoke できる粒度 = Fix-3 T1.1 型 swap の教訓)。併合しない。
- commit 規約: `feat(notion-table): S1-N <要約> [reviewed]`(S1-5 のみ撤去を含むが実装ロジック変更ありのため feat + canonical/Codex 必須)。
- 自走: plan 確定後は S1-5 まで一気通貫(CLAUDE.md 自走継続条件)。停止 = 未解決 Critical / 仕様解釈揺れ / Sprint 完了。
- 既知リスクと引当:
  - listOffset 崩れ(バー高さ動的化)→ S1-5 完了条件 + stg smoke ④。
  - menu trigger と resize drag の干渉 → 既存 stopPropagation 維持(S1-1 制約)+ stg smoke ①。
  - jsdom での Radix Popover 開閉 test → 前例あり(`exam-card-table-column-toggle.test.tsx:78-98` が同プリミティブを fireEvent.click で開閉)。同パターンを踏襲。
  - 初期 `sorting=[]` の順序回帰 → データ pre-sort(:232)が担保、既存 exam-card-table.test で検出可(S1-1 完了条件)。全ソート削除後に連番順へ戻る挙動も S1-2 test ⑤ で固定。
- Codex 論点のうち **S1 では対応しない(記録のみ)**: ① `TableCondition`/testid の columnId 一意キー前提(S4 同一列複数条件で再訪。value-as-array 逃げ道は spec §6)② ResizeObserver の実効 callback 検証(jsdom 限界。構造 test + smoke ④ の分担で担保)③ tags 直 popover の UX 例外は spec §8 に明記済(一貫 menu 化は nested popover コスト超過で不採用)。

## 検証まとめ(各段の検証方針)

| task | unit/component test | 追加の検証 |
|---|---|---|
| S1-1 | menu 新規 5 件 + sorting harness 10 件無改変 | 初期連番順(既存 test) |
| S1-2 | bar 新規 7 件 | filter-bar.test 共存 green |
| S1-3 | filter-bar.test port(3 describe 同値)+ 編集 1 + selectOnly 1 | 旧 test 共存 green |
| S1-4 | dot / chevron 2 件 | — |
| S1-5 | 参照ゼロ + wrapper 構造 | whole-repo lint/typecheck + stg smoke 5 項目 |

- 各 task で `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green を必須(局所 green で済まさない)。
- review dispatch の観点 list に whole-repo lint 実行確認を含める(CLAUDE.md 完了 gate)。
