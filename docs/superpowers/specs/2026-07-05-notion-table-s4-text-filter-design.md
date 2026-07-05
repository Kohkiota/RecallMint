# Notion 式テーブル S4 — テキストフィルタ design(spec / 凍結対象)

- 作成: 2026-07-05 / branch: develop / 起点 HEAD: 28cff70(S3 完了・stg smoke pass 後)
- fact-finding は完了済(2026-07-05 チャット報告・本 spec §2 に反映)。設計判断は OT brief で確定済。
- S3 spec §9 の「S4 は『含む』のみ」記録は本 brief(全8演算子)で上書き確定。

## 1. 目的 / 背景

S1-S3 で capability-driven ヘッダーメニュー + editor registry + generic 条件バー + ソート群を確立した。S4 は**テキストフィルタを 5 列に追加登録**する: 問題文 / タイトル / ソートキー / 解説 / メモ。演算子は Notion テキストフィルタ全 8 種。新 UI 基盤は作らない = 既存の predicate 層 / filterFn / editor registry / 条件バー chip への追加。

## 2. 現状の実コード事実(fact-finding・現 HEAD 照合済)

- フィルタ 4 層: ① 純関数 predicate(`_lib/card-filter-predicates.ts`)② 列 `filterFn`(`exam-card-table-columns.tsx:48-55` module スコープ wrapper)③ editor registry(`exam-card-table-filter-editors.tsx:215` `cardTableFilterEditors: Record<columnId, FC<{column, ctx}>>`)④ 条件バー chip(`exam-card-table-condition-bar.tsx` generic 経路 :249-278 = registry に editor がある列は chip body が PopoverTrigger で再編集、× = `setFilterValue(undefined)`)。
- 演算子付きモデルの前例 = streak: `StreakFilterOp = 'lte'|'gte'|'eq'`・値形 `{op, value: number}`・editor = `CurrentStreakEditor`(op select + input、popover open 時 fresh mount で `column.getFilterValue()` から初期値復元)。
- `getFilterSummary(value)`(condition-bar.tsx:65-77)は**値形 duck-typing**(`typeof value === 'string'` → 回答状態 / `'op' in value` → streak)。テキスト値形 `{op, value: string}` は streak 分岐と衝突 → 解消要(§4 D-3)。
- header menu 配線(exam-card-table.tsx:652-696): `if (canSort)` のみ `ColumnHeaderMenu` を出し、filterEditor は colId の if/else chain で 3 列(lastCorrect/currentStreak/tags)に手配線。**問題文/解説/メモは `enableSorting: false` で menu 自体が出ない** → 配線変更要(§4 D-4)。dot 表示 gate = `colId in cardTableFilterEditors && getIsFiltered()`(:634)= registry 追加で自動追随。
- `ColumnHeaderMenu`(header-menu.tsx)は capability-driven: `canSort && 昇順/降順`(:63)+ `filterEditor` render(:81)。**canSort=false + filterEditor のみでも構造上成立**(sort 節が消えるだけ)。
- 対象 5 列は全て `ClientCard` 直下(`lib/client-db.ts:70-99`): `title: string` / `sort_key?: string|null` / `question_text: string` / `explanation_text?: string|null` / `memo?: string|null`。別 store なし・join 不要。**3 列 nullable**。
- 評価は IDB(Dexie useLiveQuery)→ join → TanStack `getFilteredRowModel()` の**クライアント評価**(既存 3 フィルタと同一)。columnFilters は**非永続**(useState・reload 初期化)。
- 大文字小文字非区別の既存前例 = タグ popover 検索の `toLowerCase().includes()`(card-tag-option-list.tsx:172-178)。

## 3. スコープ(確定)

- 5 列(question / title / sort_key / explanation_text / memo)にテキストフィルタを追加。演算子 8 種: と一致 / と一致しない / を含む / を含まない / で始まる / で終わる / 未入力 / 未入力ではない。デフォルト = を含む。
- header menu からの追加・条件バー chip での再編集/個別除去・「クリア」全消し統合(既存機構)。
- **スコープ外**: columnFilters の永続化 / 全列横断検索(global search)/ IDB クエリ側 filter / 正規表現・完全一致トグル等の追加演算子 / 既存 3 フィルタ(タグ・回答状態・streak)の挙動変更(D-3 の summary 引数変更を除く)。

## 4. 設計判断(確定)

### D-1. 値形・predicate(streak 同型)

- `TextFilterOp = 'eq' | 'neq' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'empty' | 'notEmpty'`(8 種)。`TextFilterValue = { op: TextFilterOp; value: string }`。streak の `'eq'` と語彙重複するが判別は columnId で行う(D-3)ため衝突しない。値なし演算子判定 helper `isValuelessTextOp(op)`(= empty / notEmpty)を predicate と同居 export(editor / summary が共有)。
- `matchesTextFilter(raw: string | null | undefined, filter: TextFilterValue | null | undefined): boolean` を `card-filter-predicates.ts` に追加:
  1. `!filter` → true(絞り込みなし)。
  2. **セル正規化**: `raw ?? ''` が空白のみ(`trim() === ''`)なら `''` に正規化。それ以外は原文維持(前後空白は削らない — 内容比較は原文どおり)。
  3. `empty` → 正規化セル === '' / `notEmpty` → !== ''(値不使用)。
  4. 値必須 6 演算子: `filter.value.trim() === ''` → true(**値が空の間はフィルタ無効 = 全行通過**)。
  5. 比較は両辺 `toLowerCase()`(既存タグ popover 踏襲・大文字小文字非区別): eq === / neq !== / contains includes / notContains !includes / startsWith / endsWith。
- **否定演算子は空セルを通す**(Notion 準拠): 正規化セル `''` は neq / notContains / (値付き)で自然に true になる — 正規化 → 演算子適用の順序で担保、特別分岐は書かない。
- ラベル `TEXT_OP_LABELS: Record<TextFilterOp, string>` を `card-filter-labels.ts` に追加(と一致 / と一致しない / を含む / を含まない / で始まる / で終わる / 未入力 / 未入力ではない)。

### D-2. 列 filterFn(5 本)

`exam-card-table-columns.tsx` の module スコープに streak 流儀で追加。5 列で読む field だけが違うため小 factory 1 つ + 5 適用(rule of three 充足・既存 wrapper 群と同居):

```ts
const makeTextFilterFn = (read: (card: ClientCard) => string | null | undefined): FilterFn<ExamCardRow> =>
  (row, _columnId, filterValue) => matchesTextFilter(read(row.original.card), filterValue as TextFilterValue)
```

適用: title→`card.title` / sort_key→`card.sort_key` / question→`card.question_text` / explanation_text→`card.explanation_text` / memo→`card.memo`。**filterFn は row.original 直読み**(sort の accessorFn/getValue と独立 — 既存 tags と同じ分離)。`enableSorting` は全列不変(問題文/解説/メモは false のまま)。

### D-3. 条件バー chip / getFilterSummary の衝突解消

- `getFilterSummary` を **columnId dispatch に変更**: `getFilterSummary(columnId: string, displayName: string, value: unknown): string`。値形 duck-typing を廃止し、`'lastCorrect'` → 回答状態(文言不変)/ `'currentStreak'` → streak(文言不変)/ テキスト 5 列 → テキスト / fallback `String(value)`。呼び出し側(condition-bar 内 1 箇所)は既存 `getDisplayName` の結果を渡す。**streak の値形は変更しない**(columnId 判別で不要になったため — brief の「変更も可」は行使せず最小差分)。
- テキスト chip 文言 = `${displayName}: ${TEXT_OP_LABELS[op]} ${value}`、値なし演算子は value 部を出さない(例: 「問題文: を含む 富士山」「メモ: 未入力」)。**value は 24 code point 超で `…` 省略**(`Array.from` ベース・chip 幅暴発防止。純関数内で切るため test 可能)。
- chip の再編集 popover・× 個別除去・「クリア」統合は registry 追加(D-5)で generic 経路に自動で乗る(新規コードなし)。

### D-4. header menu 配線(menu なし列への展開)

`exam-card-table.tsx` の header 描画を変更:

- filterEditor の解決を if/else chain から **registry lookup に置換**: `colId in cardTableFilterEditors` なら `cardTableFilterEditors[colId]` を render(8 列に増える chain の除去 = 既存 registry パターンへの合流。dot gate と同一の判定式)。
- menu 表示条件を `canSort` から **`canSort || filterEditor 有り`** に変更。question/explanation_text/memo は sort 節なし・filter 節のみの menu になる(ColumnHeaderMenu は capability-driven ゆえ改変不要)。sort glyph(▾/▲/▼)は canSort 列のみ(不変)。dot は registry gate で 5 列に自動追随。
- select / options 列は accessor も editor もなく plain render のまま(不変)。

### D-5. editor(CurrentStreakEditor の文字列版・共有 1 component)

- `TextColumnEditor({ column, ctx })` を `exam-card-table-filter-editors.tsx` に 1 つ実装し、**registry に 5 key で登録**(registry 型の key union を 8 列に拡張)。列ごとの表示名は `column.columnDef.header`(5 列全て string)から導出 — 列ごとの個別 component は作らない。
- UI = 演算子 select(8 option・default 'contains')+ テキスト input。**値なし演算子選択中は input を非 render**(条件 render のみ・構造変更不要)。aria-label = `${列名} フィルタ演算子` / `${列名} フィルタ値`(streak の命名流儀踏襲・InlineTextField の `${列名} 編集` と非衝突)。
- 書込規約(brief 確定): **op 変更または値入力の操作時に常に `setFilterValue({op, value})` を書く**(値なし演算子は `{op, value: ''}`)。値必須演算子で値が空でも filter は残し、無効化(全行通過)は predicate 側(D-1 手順4)が担う — 空入力で `undefined` に落とす streak 流儀とは**意図的に別**(chip 編集中に値を消すと popover ごと消滅する UX を避ける。Notion のルール永続挙動準拠)。filter の除去経路は chip × と「クリア」のみ。
- popover open 時 fresh mount → `column.getFilterValue()` から op/value 復元(streak と同規約)。

## 5. アーキテクチャ(変更 file 一覧)

- `_lib/card-filter-predicates.ts`: TextFilterOp / TextFilterValue / isValuelessTextOp / matchesTextFilter 追加。
- `_lib/card-filter-labels.ts`: TEXT_OP_LABELS 追加。
- `exam-card-table-columns.tsx`: makeTextFilterFn + 5 列 filterFn 追加。
- `exam-card-table-filter-editors.tsx`: TextColumnEditor + registry 5 key 追加(型拡張)。
- `exam-card-table-condition-bar.tsx`: getFilterSummary の columnId dispatch 化 + テキスト分岐 + 省略。
- `exam-card-table.tsx`: header menu gate 変更 + filterEditor registry lookup 化。
- 対応 test(predicate / editors / condition-bar / header 配線)。

## 6. Global Constraints(実装厳守)

- 既存 3 フィルタ(タグ / 回答状態 / streak)の predicate・値形・editor・chip 挙動を変えない(getFilterSummary の引数変更のみ・出力文言不変を test で固定)。
- columnFilters 非永続(useState)不変。IDB クエリ・useLiveQuery・join・pre-sort 不変。
- S2b 条件バー 2 ゾーン・collapse・列可視・scroll 保持・S3 ソート群を壊さない。header menu gate 変更が canSort 既存列(title/sort_key/tags/lastCorrect/currentStreak/lastReview)の挙動を変えないこと。
- 固定 px 禁止・YAGNI・既存パターン踏襲・scope 外リファクタ禁止。`--no-verify` 禁止・push は OT。

## 7. 検証方針(概要・詳細は plan)

- 各 task = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical + Codex 両者 Crit/Imp 0 → `[reviewed]` commit。
- predicate unit: 8 演算子 × (通常 / 大文字小文字差 / 空セル / 空白のみセル / null / undefined)+ 空 query 全通過 + !filter 全通過 + 否定演算子の空セル通過(Notion 準拠)を網羅。
- editor unit(jsdom): default 'contains' / op 変更で setFilterValue / 値入力で setFilterValue / 値なし演算子で input 非表示 + `{op, value:''}` 書込 / 既存 filter 値からの mount 復元。
- 配線 unit: 5 列 filterFn が実際に行を絞る(table harness)/ question・explanation_text・memo に menu(filter 節のみ・sort 節なし)が出る / 既存 chip 文言(回答状態・streak)不変 / テキスト chip 文言・省略・×・クリア。
- jsdom 不能領域(popover 実開閉・IME 入力体感)は stg smoke。
- 完了 gate: whole-repo `pnpm lint --max-warnings=0` exit 0(+ 変更範囲 typecheck)。
- **stg smoke(OT push 後・CC 裁量)**: ① 5 列それぞれ header menu からフィルタ追加 ② 8 演算子の絞り込み結果(特に 未入力/未入力ではない を nullable 列で)③ 大文字小文字非区別 ④ chip 再編集・値なし演算子切替で入力欄消滅 ⑤ chip ×・クリア ⑥ ソート・タグフィルタとの併用 ⑦ 300-card 体感。証拠添付。

## 8. リスク

- **R1**: getFilterSummary 引数変更による既存 chip 回帰。→ 既存文言を test で固定(§7)。
- **R2**: menu gate 変更(canSort → canSort || filterEditor)が既存列 header の DOM/挙動を変える。→ 既存 header test + sorting test green で固定。
- **R3**: 空値 filter 残置(D-5 の常時書込)による「chip はあるが絞れていない」状態への違和感。→ 仕様(Notion 準拠・brief 確定)。chip 文言に値が出ない(演算子のみ)ことで視認可能。
- **R4**: 300-card × 毎 keystroke の filter 再評価コスト。→ 既存 streak filter と同一経路(TanStack getFilteredRowModel・クライアント評価)で新規リスクなし。stg ⑦ で体感確認。
