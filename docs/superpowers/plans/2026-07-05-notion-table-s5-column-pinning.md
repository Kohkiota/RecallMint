# Notion 式テーブル S5 — 列固定(column pinning)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(RecallMint 規律に適応 = review-before-commit)。

**Goal:** ヘッダーメニューの「固定表示 / 固定を解除」で、押した列＋それより左の全列(+select 付随)を左 sticky 固定し、固定境界 1 本を examViewPrefs V3 に永続する。

**Architecture:** spec `docs/superpowers/specs/2026-07-05-notion-table-s5-column-pinning-design.md`(commit 6e5c2d0・凍結)§4 D-1〜D-8 が設計判断の正本。本 plan は task 分割と各段検証のみ。ロジック層(S5-1: helper + V3 schema)→ 状態配線層(S5-2: state 所有 + menu 項目 + 永続)→ 視覚層(S5-3: sticky/z/separator/hover)の 3 段直列で、各段が独立に test 可能な着地を持つ。

**Tech Stack:** Next.js 16 / TanStack Table 8.21.3(columnPinning)/ Tailwind v4 / zod / Vitest / DevTools MCP(stg smoke)。

## Global Constraints(全 task 共通・spec §6)

- 既存挙動不変: ソート群(S3)/ 全フィルタ(S4 以前)/ 列可視 + V1/V2 読み取り互換 / resize(CSS 変数 + memo 凍結)/ S2b collapse / 行仮想化 / 選択・bulk。**boundary null 時の DOM/挙動は現状と完全一致**(追加 class/style は pinned 列のみに付く)。
- pinning の left 配列は **computePinnedLeft 経由でのみ書く**(menu handler / load 復元。`column.pin()` 不使用)— getHeaderGroups が pinning 配列順に並べ替えるため、これが視覚列順不変の構造的保証(spec §2/D-2)。`right` は常に `[]`。
- 固定 px 禁止(left offset は列幅由来の計算値で可)。YAGNI・既存パターン踏襲・scope 外リファクタ禁止。
- 各 task 完了 = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]" "lib/sync"` 全 green + canonical review(`superpowers:requesting-code-review`・template 改変なし)+ Codex review(`scripts/ai/codex-review.sh`)両者 Critical/Important 0 → controller が `[reviewed]` commit(実装 subagent は commit しない)。review 観点に whole-repo lint 実行確認を含める。
- `git commit --no-verify` / `-n` 禁止。push は OT。

## File 構成(確定)

- Create: `app/(app)/app/exams/[id]/_lib/column-pinning.ts`(S5-1)+ `.test.ts`
- Modify: `lib/sync/sync-meta.ts`(S5-1: V3 schema + union + toV3)+ `.test.ts`
- Modify: `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx`(S5-2: state 所有/load/persist/wrap)+ `.test.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-header-menu.tsx`(S5-2: pinning 節)+ `.test.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(S5-2: state/props 配線 + pinning prop 組み立て。S5-3: columnSizeVars 拡張 + th/td sticky 分岐 + separator + tr group)+ `.test.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx`(S5-3: 冒頭コメント現状化のみ・ロジック不変)

## Task 間 interface(先に凍結)

- **S5-1 produces**:
  - `_lib/column-pinning.ts`:
    - `computePinnedLeft(boundaryId: string | null): string[]` — `examCardTableColumns` の module 定義順(import して `.map((c) => c.id).filter((id): id is string => Boolean(id))` で導出・重複定義を作らない)で先頭から boundaryId まで(select・boundaryId 含む)。null / 未知 id → `[]`。
    - `derivePinnedBoundary(state: ColumnPinningState): string | null` — `state.left` 末尾の id。空 / 末尾 'select' → null。
  - `lib/sync/sync-meta.ts`:
    - `examViewPrefsV3Schema` = `{ version: z.literal(3), view: z.enum(['card','table']), hiddenColumns: z.array(z.string()), pinnedBoundary: z.string().nullable() }`(`.strict()`)。
    - `examViewPrefsSchema`(読み取り union)に V3 追加。
    - `examViewPrefsToV3(prefs: ExamViewPrefs): { view: 'card' | 'table'; hiddenColumns: string[]; pinnedBoundary: string | null }` — V1 → `{[], null}` / V2 → `{hiddenColumns, null}` / V3 → そのまま。`examViewPrefsToV2` は本 task では残置(呼出は exam-detail-view が使用中・S5-2 で置換撤去)。
- **S5-2 produces**:
  - exam-detail-view: `const [columnPinning, setColumnPinning] = useState<ColumnPinningState>({ left: [], right: [] })` + `handleColumnPinningChange: OnChangeFn<ColumnPinningState>`(userInteracted wrap・handleColumnVisibilityChange と同型)。load = `pinnedBoundary` → `setColumnPinning({ left: computePinnedLeft(pinnedBoundary), right: [] })`。persist effect deps に columnPinning 追加・書込 = `{ version: 3, view, hiddenColumns, pinnedBoundary: derivePinnedBoundary(columnPinning) }`(examViewPrefsV3Schema)。`examViewPrefsToV2` + その test は撤去(呼出ゼロ化)。
  - ExamCardTable props 追加: `columnPinning: ColumnPinningState` / `onColumnPinningChange: OnChangeFn<ColumnPinningState>`。`useReactTable` の `state` に columnPinning、`onColumnPinningChange` 配線。
  - ColumnHeaderMenu props 追加: `pinning?: { isBoundary: boolean; onSelect: () => void }` — 渡された時のみ固定節(1 button)を render。label = `isBoundary ? '固定を解除' : '固定表示'`。配置 = 昇順/降順の下・filterEditor の上。click → `onSelect()` + `setOpen(false)`。
  - exam-card-table.tsx th render: `const pinnedBoundary = derivePinnedBoundary(columnPinning)` を render 冒頭で 1 回導出し、menu を出す全列に `pinning={{ isBoundary: colId === pinnedBoundary, onSelect: () => onColumnPinningChange({ left: computePinnedLeft(colId === pinnedBoundary ? null : colId), right: [] }) }}` を渡す。
- **S5-3 produces**(視覚のみ・API 変更なし): `columnSizeVars` に left-pinned 可視列の `--col-{id}-start`(`column.getStart('left')`)を追加 emit(deps に `table.getState().columnPinning` 追加)。th/td の pinned 分岐 class + `style.left = calc(var(--col-{id}-start) * 1px)`。separator = `getIsLastColumn('left')` の列の th/td に `border-r border-border`。tr に `group`。

---

### Task S5-1: computePinnedLeft / derivePinnedBoundary + examViewPrefs V3(ロジック層)

**目的**: 境界⇄pinning 配列の相互導出 helper(spec D-2)と V3 schema + toV3 正規化(spec D-4)を新設。この task 完了で「境界 1 本 → 順序保証された left 配列」の変換と V3 の読み書きが test 済みになる(UI 配線は S5-2)。
**制約**: Global。既存 V1/V2 schema・`examViewPrefsToV2`・exam-detail-view の挙動は本 task では一切変えない(V3 は追加のみ・書込層は未接続)。helper は純関数(React/Dexie 非依存)。列順の SSoT = `examCardTableColumns`(import 導出・literal 複製禁止)。
**完了条件**:
- (a) helper unit test(`column-pinning.test.ts` 新規): `computePinnedLeft('tags')` → `['select','title','sort_key','question','options','tags']` / `computePinnedLeft('title')` → `['select','title']` / `computePinnedLeft(null)` → `[]` / 未知 id(`'nonexistent'`)→ `[]` / 最終列 `'lastReview'` → 全 11 id。
- (b) `derivePinnedBoundary`: `{left: ['select','title'], right: []}` → `'title'` / `{left: [], right: []}` → null / `{left: ['select'], right: []}` → null / `left: undefined` → null。往復同一性: 全列 id について `derivePinnedBoundary({left: computePinnedLeft(id), right: []}) === id`。
- (c) sync-meta test 追記: V3 record の読み取り(union)+ `examViewPrefsToV3` の V1/V2/V3 正規化 + V3 書込(setJsonSyncMeta)+ 不正値 reject(`pinnedBoundary: 123` / version:3 で pinnedBoundary 欠落 / 余剰 key)。既存 V1/V2 読み取り test が不変で green。
- full-dir green + typecheck/lint exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。

### Task S5-2: 状態配線 + menu 項目 + V3 永続(機能層)

**目的**: columnPinning state を exam-detail-view 所有の controlled prop で追加(spec D-1)、ColumnHeaderMenu に固定節を追加(spec D-3)、load/persist を V3 化(spec D-4)。この task 完了で menu 操作 → state 変化 → reload 復元が機能する(視覚 sticky は S5-3)。
**制約**: Global。S2-5 の prefsLoaded / userInteracted guard 構造を変えない(columnPinning を既存 guard に乗せるだけ)。menu gate(`canSort || filterEditor`)不変 — pinning 節は menu が出る列全てに追加し、select/options は menu なしのまま。ColumnHeaderMenu は capability-driven 維持(pinning prop 未指定なら固定節なし = 既存単体 test 後方互換)。解除は boundary 列でのみ表示、固定済み非境界列は「固定表示」で境界縮小移動(spec D-3・Notion 準拠)。`examViewPrefsToV2` 撤去(呼出ゼロ化)。**V2→V3 の migration write はユーザー操作時のみ**(lazy migration — 無操作 mount では書かない = 既存 userInteracted guard の帰結を仕様として明示・Codex 論点反映)。card view 表示中も columnPinning state は exam-detail-view が保持するため persist で pinnedBoundary は落ちない(hiddenColumns と同構造)。handleColumnPinningChange は React setState 渡しのため OnChangeFn の updater/値の両形に自然対応(handleColumnVisibilityChange と同型)。
**完了条件**:
- (a) header-menu test 追記: pinning prop 渡し時に「固定表示」button render / `isBoundary: true` で「固定を解除」/ click で onSelect 呼出 + popover close / pinning 未指定で固定節なし(既存 test 不変)。
- (b) table harness test(`exam-card-table.test.tsx` 追記): menu を持つ 9 列(title/sort_key/question/tags/explanation_text/memo/lastCorrect/currentStreak/lastReview)全てに固定項目 / tags で「固定表示」click → `onColumnPinningChange` が `{left: ['select','title','sort_key','question','options','tags'], right: []}` を受ける / boundary=tags 状態で tags menu = 「固定を解除」→ click で `{left: [], right: []}` / boundary=tags 状態で title menu = 「固定表示」→ click で `{left: ['select','title'], right: []}`(境界縮小移動)。
- (c) exam-detail-view test 追記: V3 record(pinnedBoundary: 'title')load → ExamCardTable に `{left: ['select','title'], right: []}` が渡る / V2 record load → `{left: [], right: []}`(migration)/ pinning 変更 → persist effect が `version: 3` + `pinnedBoundary` を書く / 無操作 mount で書込なし(userInteracted guard 回帰)/ 未知 boundary id の V3 record → `{left: [], right: []}`(computePinnedLeft 無害化)。
- (d) boundary null 時に pinning 由来の差分(sticky/z/border-r class・left style・start CSS 変数)が th/td に一切出ないことを 1 case 固定(DOM 完全一致の snapshot にはしない — 実装詳細に脆いため・Codex 論点反映)。menu 内の固定項目自体は常時出る(これは新規 UI で回帰対象外)。
- full-dir green + typecheck/lint exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。

### Task S5-3: sticky 描画 + セパレータ + hover 不透過(視覚層)

**目的**: pinned 列を実際に左固定して見せる(spec D-5/D-6)。CSS 変数 `--col-{id}-start` を columnSizeVars に追加 emit し、th/td の pinned 分岐 + 最右 pinned 可視列の border-r + 行 hover の不透過合成色を実装。columns.tsx 冒頭コメント現状化(spec D-8)。
**制約**: Global。resize 中の offset 追従は CSS 変数経由で担保(memo 凍結 body に JS 再計算を入れない = Fix-3 T1 パターン延長・spec D-5)。z 階層: pinned th = `z-10`(thead 内)/ pinned td = `z-[1]` + 不透過 `bg-background`。hover 色 = `group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]`(spec D-5 確定・token 名照合済)。separator 判定は `column.getIsLastColumn('left')`(可視 leaf 基準 = hidden boundary で最右**可視** pinned 列に付く)。spacer `<tr>` は変更しない(spec D-7)。virtualizer・collapse・scroll 保持のコードに触らない。**pinned th は `relative` を `sticky` に置換**(position 二重指定不可。sticky も positioned 要素のため absolute の resize handle の anchor は不変 — Codex 論点反映)。
**完了条件**:
- (a) table harness test 追記: boundary=title 設定時 — select/title の th と td に `sticky` class + `left` style(CSS 変数参照)/ title(最右 pinned)の th/td に `border-r` / question(非 pinned)には無し / `<table>` style に `--col-select-start: 0` + `--col-title-start: 32`(select size=32)が emit / boundary null で start 変数・sticky class ゼロ(S5-2 (d) の回帰)。
- (b) 列可視との相互作用 test: boundary=sort_key で sort_key を hidden にすると separator(border-r)が title(最右可視 pinned)へ移る / start 変数から hidden 列が消える。
- (c) hover: pinned td に `bg-background` + group-hover class、tr に `group` が付く(class assert。実色は stg)。
- (d) columns.tsx:7 コメントが「決め打ち固定はしない(不変)。S5 でユーザー選択式 pinning を導入」相当へ更新(ロジック diff ゼロを review で確認)。
- full-dir green + typecheck/lint exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。

---

## S5 完了 gate(全 task commit 後・OT push 前)

- **whole-branch review**: cross-task 相互作用(pinning × 列可視 × resize CSS 変数 × S3 ソート × S4 フィルタ × S2b collapse × 行仮想化)+ S1-S4 からの回帰。Critical/Important 解消まで完了としない。carry Minor を triage。
- whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0(報告明記)。
- **stg smoke(OT push 後・stg URL・CC 裁量)**: spec §7 の ①〜⑨ — 固定・境界 border 視認 / 境界移動 / 解除 / reload 復元(V2→V3 migration 含む)/ hidden boundary→復帰 / resize 中 offset 追従 / hover 色一致 / 縦横 sticky 交差 / 300-card 体感。証拠添付。
- Sprint 境界 = OT 判断で停止。

## 実装順序 / 停止条件

- S5-1 → S5-2 → S5-3 直列(ロジック → 機能 → 視覚。S5-2 完了時点で永続と menu が機能し、sticky 無しでも state は正しい = 中間状態が test 可能)。
- 自走継続条件は S4 と同一: canonical/Codex の未解決 Critical のみ即上げ、Important 以下は CC 吸収。仕様解釈揺れ・外部設定変更要・sprint 完了で停止。
