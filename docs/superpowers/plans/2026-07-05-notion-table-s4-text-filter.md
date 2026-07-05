# Notion 式テーブル S4 — テキストフィルタ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(RecallMint 規律に適応 = review-before-commit)。

**Goal:** 問題文 / タイトル / ソートキー / 解説 / メモ の 5 列に Notion 全 8 演算子のテキストフィルタを追加し、既存 4 層(predicate / filterFn / editor registry / 条件バー chip)へ streak 同型で登録する。

**Architecture:** spec `docs/superpowers/specs/2026-07-05-notion-table-s4-text-filter-design.md`(commit 2f26ac2)§4 D-1〜D-5 が設計判断の正本。本 plan は task 分割と各段検証のみ。ロジック層(S4-1)→ 条件バー表示層(S4-2)→ editor + menu 配線(S4-3)の 3 段直列で、各段が独立に test 可能な着地を持つ。

**Tech Stack:** Next.js 16 / TanStack Table / Tailwind v4 / Vitest / Playwright(stg smoke)。

## Global Constraints(全 task 共通・spec §6)

- 既存 3 フィルタ(タグ / 回答状態 / streak)の predicate・値形・editor・chip 挙動を変えない(getFilterSummary の引数変更のみ・出力文言不変を test で固定)。
- columnFilters 非永続(useState)不変。IDB クエリ・useLiveQuery・join・pre-sort 不変。`enableSorting` は全列不変(問題文/解説/メモは false のまま)。
- S2b 条件バー 2 ゾーン・collapse・列可視・scroll 保持・S3 ソート群を壊さない。menu gate 変更が既存 canSort 列(title/sort_key/tags/lastCorrect/currentStreak/lastReview)の挙動を変えないこと。
- 大文字小文字非区別 = 両辺 `toLowerCase()`(既存タグ popover 踏襲)。「未入力」= null / undefined / 空文字 / 空白のみ → 空文字正規化 → 演算子適用(否定演算子は空セルを通す・特別分岐なし)。
- 回帰範囲 = exam 詳細内。固定 px 禁止・YAGNI・既存パターン踏襲・scope 外リファクタ禁止。
- 各 task 完了 = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical review(`superpowers:requesting-code-review`・template 改変なし)+ Codex review(`scripts/ai/codex-review.sh`)両者 Critical/Important 0 → controller が `[reviewed]` commit(実装 subagent は commit しない)。review 観点に whole-repo lint 実行確認を含める。
- `git commit --no-verify` / `-n` 禁止。push は OT。

## File 構成(確定)

- Modify: `app/(app)/app/exams/[id]/_lib/card-filter-predicates.ts`(S4-1: TextFilterOp / TextFilterValue / isValuelessTextOp / matchesTextFilter)+ `.test.ts`
- Modify: `app/(app)/app/exams/[id]/_lib/card-filter-labels.ts`(S4-1: TEXT_OP_LABELS / TEXT_FILTER_COLUMN_IDS)
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx`(S4-1: makeTextFilterFn + 5 列 filterFn)+ `.test.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-condition-bar.tsx`(S4-2: getFilterSummary columnId dispatch + テキスト chip)+ `.test.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-filter-editors.tsx`(S4-3: TextColumnEditor + registry 5 key)+ `.test.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(S4-3: menu gate + registry lookup)/ `exam-card-table-header-menu.test.tsx`(配線 test)

## Task 間 interface(先に凍結)

- **S4-1 produces**(`card-filter-predicates.ts`):
  - `type TextFilterOp = 'eq' | 'neq' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'empty' | 'notEmpty'`
  - `type TextFilterValue = { op: TextFilterOp; value: string }`
  - `isValuelessTextOp(op: TextFilterOp): boolean`(empty / notEmpty のみ true)
  - `matchesTextFilter(raw: string | null | undefined, filter: TextFilterValue | null | undefined): boolean` — !filter → true / セル正規化(空白のみ→''、他は原文)/ empty・notEmpty は値不使用 / 値必須 op で `filter.value.trim()===''` → true / 比較は両辺 toLowerCase。
  - `card-filter-labels.ts`: `TEXT_OP_LABELS: Record<TextFilterOp, string>` = { eq: 'と一致', neq: 'と一致しない', contains: 'を含む', notContains: 'を含まない', startsWith: 'で始まる', endsWith: 'で終わる', empty: '未入力', notEmpty: '未入力ではない' } / `TEXT_FILTER_COLUMN_IDS = ['title', 'sort_key', 'question', 'explanation_text', 'memo'] as const`。
  - columns: `makeTextFilterFn(read: (card: ClientCard) => string | null | undefined): FilterFn<ExamCardRow>` module スコープ factory + 5 列へ `filterFn` attach(title→card.title / sort_key→card.sort_key / question→card.question_text / explanation_text→card.explanation_text / memo→card.memo。row.original 直読み・sort と独立)。
- **S4-2 produces**(condition-bar):`getFilterSummary(columnId: string, displayName: string, value: unknown): string` — 'lastCorrect' → `回答状態: ${label}`(文言不変)/ 'currentStreak' → `連続正解数: ${op} ${value}`(文言不変)/ TEXT_FILTER_COLUMN_IDS 所属 → `${displayName}: ${TEXT_OP_LABELS[op]}`(値なし op)or `${displayName}: ${TEXT_OP_LABELS[op]} ${value省略形}`(24 code point 超は `Array.from` で切って `…`)/ fallback `String(value)`。呼出側は既存 `getDisplayName(columnId)` を渡す。
- **S4-3 produces**(editors + table):registry `cardTableFilterEditors` の key union を `'lastCorrect' | 'currentStreak' | 'tags' | 'title' | 'sort_key' | 'question' | 'explanation_text' | 'memo'` に拡張し、新 5 key は共有 `TextColumnEditor` を登録。exam-card-table.tsx の header 描画は「`colId in cardTableFilterEditors` なら registry lookup で filterEditor を構築(if/else chain 撤去)+ menu 表示条件 = `canSort || filterEditor 有り`」。

---

### Task S4-1: predicate 層 + ラベル + 5 列 filterFn(ロジック層)

**目的**: `matchesTextFilter` 純関数(spec D-1)と演算子ラベル・列 id 定数を新設し、5 列の ColumnDef に filterFn を attach(spec D-2)。この task 完了で filter 値を programmatic に set すれば絞り込みが機能する(UI は S4-3)。
**制約**: Global。既存 predicate(matchesTagFilter / matchesAnswerState / matchesStreakFilter / matchesExamFilter)不変。正規化は「空白のみ → ''、それ以外は原文維持(前後空白を削らない)」— trim を比較にまで波及させない。**検索値側も同じ**: 空判定(`filter.value.trim()===''`)のみ trim、比較は入力原文(前後空白込み)の toLowerCase(Codex 論点反映・明示)。**正規化は大文字小文字のみ**: 全角/半角・かな/カナ・濁点合成・アクセント差は吸収しない(仕様として明記・Codex 論点反映)。streak の `'eq'` と op 語彙が重複するが型が別なので判別は不要(summary 判別は S4-2 の columnId dispatch が担う)。filterFn は streak 流儀の module スコープ・`row.original.card` 直読み(accessorFn/getValue 非依存 = S3 sort と独立)。
**完了条件**:
- (a) predicate unit test(`card-filter-predicates.test.ts` 追記): 8 演算子それぞれ × {通常一致/不一致・大文字小文字差(例 'ABC' vs 'abc')・空セル・空白のみセル・null・undefined} を網羅。特に **否定演算子(neq / notContains)が空セルを通す**(Notion 準拠)/ empty が空白のみセルで true / notEmpty が空白のみセルで false / 値必須 op の `value` 空・空白のみ → 全行通過 / `!filter` → true。
- (b) `isValuelessTextOp` = empty/notEmpty のみ true。
- (c) columns harness test(`exam-card-table-columns.test.tsx` 追記): 5 列それぞれ `setFilterValue({op:'contains', value:…})` で行が絞れる + nullable 3 列(sort_key/explanation_text/memo)で `{op:'empty'}` が null セル行を返す。sort(title/sort_key の S3 sortingFn)と filter の独立(併用で両方効く)を 1 case 固定。
- (d) 全列の `enableSorting` 値が S3 時点と不変(問題文/解説/メモ = sortable でないまま)を assert。
- full-dir green + typecheck/lint exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。

### Task S4-2: 条件バー chip(getFilterSummary の columnId dispatch 化)

**目的**: `getFilterSummary` を値形 duck-typing から columnId dispatch へ変更(spec D-3)し、テキスト chip 文言(`列名: 演算子 値`・値なし op は値部なし・24 code point 省略)を実装。registry 追加前でも「editor なし列」fallback 経路(condition-bar.tsx:281-298 summary span + ×)で chip 表示・× 除去・クリアが成立する(chip 再編集 popover は S4-3 の registry 追加で自動有効化。Codex がここを「generic 経路は registry 前提」と指摘したが fallback 経路の実在は実コード確認済 — 指摘は不成立)。**空値 filter(値必須 op + value 空)中も chip と dot は表示される** — 仕様として許容(spec R3。絞れていないことは chip に値が出ないことで視認可能)。
**制約**: Global。streak の値形は変更しない(spec D-3 で不採用確定)。既存 chip 文言(回答状態・連続正解数)は 1 文字も変えない。呼出は condition-bar 内 1 箇所 — `getDisplayName` の結果を渡す形にし、ラベル map の重複定義を作らない。省略は summary 純関数内で行う(CSS truncate に逃げない = test 可能)。tags 特例分岐(columnId==='tags')は不変。
**完了条件**:
- (a) condition-bar test 追記: テキスト chip 文言 — 例 question + `{op:'contains', value:'富士山'}` → `問題文: を含む 富士山` / memo + `{op:'empty', value:''}` → `メモ: 未入力` / 25 code point 値 → 24 + `…`(サロゲートペア含む値で `Array.from` 切断を固定)。
- (b) 既存 chip 文言固定(回帰): lastCorrect → `回答状態: 未回答` 等 / currentStreak → `連続正解数: ≤ 3` 等が dispatch 化後も不変。
- (c) テキスト chip の × 個別除去(`setFilterValue(undefined)`)+「クリア」全消しが既存 handler で機能(新規 handler を書かない)。
- full-dir green + typecheck/lint exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。

### Task S4-3: TextColumnEditor + registry 拡張 + header menu 配線

**目的**: 共有 `TextColumnEditor`(CurrentStreakEditor の文字列版・spec D-5)を実装して registry に 5 key 登録し、header menu の filterEditor 解決を registry lookup 化 + 表示 gate を `canSort || filterEditor` に変更(spec D-4)。この task 完了で全機能が UI から使える。
**制約**: Global。editor は 1 component 共有(列別 component を作らない)、列名は `column.columnDef.header`(5 列全て string。非 string は column.id fallback = getDisplayName と同ロジック)から導出。aria-label = `${列名} フィルタ演算子` / `${列名} フィルタ値`。**書込規約(spec D-5・streak と意図的に別)**: op 変更・値入力の操作時に常に `setFilterValue({op, value})`(値なし op は `{op, value:''}`)— 空値で undefined に落とさない(無効化は predicate 側)。除去経路は chip × とクリアのみ。**入力値の保持(Codex 論点反映)**: editor local state の値は mount 中保持 — 値なし op へ切替(`{op, value:''}` 書込)後に値必須 op へ戻すと local 値を復元して書き込む。popover close 後は filter 値から復元(= 値なし op のまま閉じたら破棄)。ColumnHeaderMenu 本体は改変しない(capability-driven で filter 節のみの menu が既に成立)。menu gate 変更で select/options 列は plain render のまま。
**完了条件**:
- (a) editor test(`filter-editors.test.tsx` 追記): default op 'contains' / op 変更で `{op, value}` 書込 / 値入力で書込 / **値なし op 選択で値 input が非 render + `{op, value:''}` 書込** / 値必須 op へ戻すと input 再表示 + **mount 中の local 値が復元されて書き込まれる** / 既存 filter 値からの mount 復元 / 値を全消ししても filter が `{op, value:''}` で残る(undefined に落ちない)。
- (a2) 整合 test(二重管理ガード・Codex 論点反映): `TEXT_FILTER_COLUMN_IDS` の全 id が `cardTableFilterEditors` の key に存在することを assert(片側更新漏れで chip summary / editor / dot / menu がズレる事故の固定)。
- (b) 配線 test(header-menu / table harness): question・explanation_text・memo 列に menu が出て filter 節のみ(昇順/降順ボタンなし・sort glyph なし)/ title・sort_key 列は sort 節 + filter 節の両方 / lastCorrect・currentStreak・tags・lastReview の menu 構成が不変 / select・options 列に menu なし / dot が 5 列で filter 適用時に点灯(registry gate 自動追随)。
- (c) chip 再編集: テキスト chip click で editor popover が開き値変更が反映(S4-2 の generic 経路 + registry 追加の統合確認)。
- (d) if/else chain 撤去後も tags の filterEditor(TagsEditor)が従来どおり render される(S3-2 H-1 経路の回帰)。
- full-dir green + typecheck/lint exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。

---

## S4 完了 gate(全 task commit 後・OT push 前)

- **whole-branch review(opus)**: cross-task 相互作用(predicate × filterFn × summary dispatch × menu gate × 既存 3 フィルタ × S3 ソート群)+ S1-S3 からの回帰。Critical/Important 解消まで完了としない。carry Minor を triage。
- whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0(報告明記)。
- **stg smoke(OT push 後・stg URL・CC 裁量)**: ① 5 列それぞれ header menu からフィルタ追加(filter-only menu の開閉・Esc・focus が非 sortable 列でも自然か含む・Codex 論点反映)② 8 演算子の絞り込み結果(特に 未入力/未入力ではない を nullable 列 = ソートキー/解説/メモ で)③ 大文字小文字非区別(英字データ)④ chip 再編集・値なし演算子切替で入力欄消滅 ⑤ chip ×・クリア ⑥ S3 ソート・タグフィルタとの併用 ⑦ 300-card で keystroke 毎の再評価体感。証拠添付。
- Sprint 境界 = OT 判断で停止。

## 実装順序 / 停止条件

- S4-1 → S4-2 → S4-3 直列(ロジック → 表示 → 配線。各段の中間状態が test 可能で、S4-2 まで進めば registry 未登録でも chip は正しく表示される)。
- 自走継続条件は S3 と同一: canonical/Codex の未解決 Critical のみ即上げ、Important 以下は CC 吸収。仕様解釈揺れ・外部設定変更要・sprint 完了で停止。

## Minor 記録(whole-branch triage 用)

- S3 持ち越し: filter-editors の file 冒頭コメント「3 entries」が S4-3 で 8 entries になる — S4-3 で改修時にコメントも現状化(記録済 Minor の自然解消)。
