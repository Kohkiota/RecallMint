# Edit-2 テーブル全項目 inline 編集 + 列表示/非表示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)で実装する。Steps は checkbox 追跡。

**Goal:** 試験詳細テーブルでカードビューの全編集項目(選択肢 inline 編集 + 問題文)を編集可能にし(編集パリティ)、列の表示/非表示を付ける。

**Architecture:** 選択肢編集器の working-set/commit を `useCardOptions` hook に抽出し(card view 挙動不変)、table cell 用の compact editable cell と card view が共有。問題文は `InlineTextField multiline` に差し替え。TanStack `columnVisibility` 導入 + `examViewPrefs` v2(`hiddenColumns`)で永続化。選択肢 commit は既存 `runOptimisticUpdate`(single cards 行・atomic)流用 = 新規 write-path/atomicity なし。

**Tech Stack:** Next.js App Router / TS strict / TanStack Table 8.21.3 / Dexie(mirror + outbox)/ zod / Vitest + RTL。

**Spec(唯一の起点):** `docs/superpowers/specs/2026-06-26-edit-2-table-inline-edit-column-visibility-design.md`

## Global Constraints

- 起点は spec のみ。spec 凍結。仕様変更が要るなら停止して OT 相談。
- 各 task 完了条件 = ① 該当 unit/component test green ② review Critical 0 ③ `[reviewed]`(feat は canonical `superpowers:requesting-code-review` 経路必須・template 改変なし)。
- **カードビュー(`InlineOptionList` / `InlineCardList`)挙動不変**。回帰させない。
- **書込経路を新設しない**: 選択肢 commit = 既存 `runOptimisticUpdate`(`cards.update(cardId, {options, correct_answer_ids})` + enqueue `update_field/options`、single-store、atomic は helper 内蔵)。問題文/text 系も `InlineTextField` 内部の `runOptimisticUpdate` 流用。working-set は **UI state**(write-path ではない)。
- **追加 join 禁止**: `row.original.card` から(options/question_text は ClientCard に有り)。全 read は `user_id` scope 維持。
- **共有部品(`inline-option-row.tsx` の `InlineOptionList`)変更 → consumer test 網羅必須**: `inline-option-row.test.tsx`(703)+ `inline-option-row.debounce.test.tsx`(248)+ `inline-card-list.test.tsx` を per-task gate 実行(横断規律)。
- **`InlineOptionCell` は原則 export のみ**(中身/props/挙動 不変=card-view 影響ゼロ)。props 追加/挙動分岐を入れる場合は card-view 回帰 gate 対象。
- **title は唯一の pin 列**(`meta.sticky`)。可視性で pin を別列へ昇格させない(title hidden=単に pin 無し)。`select` 列は表示/非表示の対象外(常時表示)。
- **examViewPrefs v2**: `{ version:2, view, hiddenColumns: string[] }`。保存に無い列 id は既定表示(新列前方互換)。zod は version 分岐で旧 `{version:1, view}` も読む。
- Test: Vitest + RTL。AI/課金は非該当。`--no-verify` 全面禁止。

## Sprint 完了 gate

- whole-repo `pnpm lint --max-warnings=0` exit 0(報告に1行明記)。
- schema/型を触るため `pnpm typecheck` exit 0。
- review dispatch の観点 list に whole-repo lint 実行確認を含める。
- **T1 中間 stg smoke(例外)**: T1 push 後、カードビュー選択肢編集の挙動不変を DevTools MCP で実走(編集パリティの土台確定。push は OT 手動)。
- **sprint 末 stg smoke**(T2–T4): table 選択肢 inline 編集 / 問題文編集 / 列表示非表示 + リロード永続 / 重い card(20択+explanation)行高観測 → carry-forward 追記 / カードビュー無改変。

---

### Task 1: useCardOptions 抽出 + InlineOptionList consumer 化(card-view 挙動不変)

**目的:** 選択肢編集の working-set/commit/handlers を `useCardOptions` hook に抽出し、`InlineOptionList` を hook consumer 化(挙動不変)。`InlineOptionCell` を export。

**Files:** Modify `app/(app)/app/exams/[id]/_components/inline-option-row.tsx`。Create `app/(app)/app/exams/[id]/_hooks/use-card-options.ts`(+ `.test.tsx`)。

**Interfaces(Produces):**
- `export function useCardOptions(cardId: string, serverOptions: CardOption[]): { options: CardOption[]; autoEditOptionId: string | null; canDelete: boolean; correctIds: string[]; handleCellSave: (idx: number, next: CardOption) => void; handleCheckboxToggle: (idx: number, checked: boolean) => void; handleAddOption: () => void; handleDeleteOption: (idx: number) => void }`(現 `InlineOptionList` の state/refs/merge useEffect/commit/scheduleDrain/handlers をそのまま移送)。
- `export function InlineOptionCell(...)`(現状 un-export → export 追加、**中身/props 不変**)。

**制約:** hook 抽出は state(options/autoEditOptionId)/ refs(serverCommittedRef/debounceTimerRef/optionsRef)/ merge useEffect / commit(`runOptimisticUpdate` + sanitize)/ scheduleDrain / 4 handler を**意味等価に移送**(ghost 保持・500ms debounce・dirty-guard merge・autoEdit・correct_answer_ids derive を変えない)。`InlineOptionList` は hook を呼ぶ薄い consumer(`InlineOptionRow` render は不変)。`InlineOptionCell` は export のみ。

**完了条件:**
- `use-card-options.test.tsx`: hook の最小 unit(handlers が working-set を更新 / commit が runOptimisticUpdate を呼ぶ)green。
- **card-view 回帰 hard gate(必須)**: `inline-option-row.test.tsx`(703)+ `inline-option-row.debounce.test.tsx`(248)+ `inline-card-list.test.tsx` 全 green(ghost row / 連続追加 race / serverOptions merge / 500ms drain / autoEdit / checkbox 即時 / 正解サマリ が抽出前後不変)。
- typecheck 0。canonical review Critical 0 + `[reviewed]`。
- **per-task stop + 中間 smoke**: commit 後停止 → OT push → カードビュー選択肢編集の挙動不変を stg smoke 実走 pass 後に T2 着手。

---

### Task 2: CompactOptionsCell(table cell 用 compact editable 選択肢)

**目的:** table cell 用に選択肢を縦積みで inline 編集する新規 component。`useCardOptions` + `InlineOptionCell` で構成。

**Files:** Create `app/(app)/app/exams/[id]/_components/exam-card-table-options-edit-cell.tsx`(+ `.test.tsx`)。

**Interfaces(Consumes):** `useCardOptions`(T1)/ `InlineOptionCell`(T1 export)/ `ClientCardOption`(`@/lib/client-db`)。**Produces:** `export function CompactOptionsCell({ cardId, options }: { cardId: string; options: ClientCardOption[] }): React.JSX.Element`。

**実装:** `const { options, autoEditOptionId, canDelete, handleCellSave, handleCheckboxToggle, handleAddOption, handleDeleteOption } = useCardOptions(cardId, options)`。各選択肢を**縦積み**の行で render: 行 = `is_correct` checkbox(`handleCheckboxToggle`)+ text(`InlineOptionCell kind="text"` click-to-edit, autoEditOnMount=autoEditOptionId 一致)+ **explanation(`InlineOptionCell kind="explanation"` 常時表示・text 下)**+ 削除 button(`handleDeleteOption`, canDelete で disabled)+ 末尾「+ 選択肢を追加」(`handleAddOption`)。`InlineOptionRow` の grid は使わず 240px 列内に収まる compact stack(縦)。

**制約:** working-set は cell ローカル(card 単位)= `useCardOptions(cardId, options)` を cell が呼ぶ。`InlineOptionCell` を props 追加せず使えるか確認 — 追加が要るなら制約どおり card-view 回帰 gate(951 行)に含める(T2 report に export-only か props 追加かを明示)。mobile は 240px 固定列 + 横スクロール(card-view の responsive grid 分岐は不要)。

**完了条件:** `exam-card-table-options-edit-cell.test.tsx` green(縦積み描画 / checkbox toggle / text・explanation click-to-edit / 追加・削除 / options.length===1 で削除 disabled / 空 options)。typecheck 0。canonical review Critical 0 + `[reviewed]`。

---

### Task 3: columns 差し替え(options → CompactOptionsCell)+ 問題文 editable 化

**目的:** options 列を editable cell に、問題文列を `InlineTextField multiline` に。

**Files:** Modify `app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx`(+ `.test.tsx` / `exam-card-table.test.tsx` 追記)。

**Interfaces(Consumes):** `CompactOptionsCell`(T2)/ `InlineTextField`(既存)。

**実装:**
- options 列: `cell: ({ row }) => <CompactOptionsCell cardId={row.original.card.id} options={row.original.card.options} />`(`OptionsReadonlyCell` import/使用を削除)。`enableSorting: false` 維持。
- question 列: `cell` を `<div className="line-clamp-2">{question_text}</div>` → `<InlineTextField cardId={row.original.card.id} field="question_text" initialValue={row.original.card.question_text} ariaLabel="問題文 編集" multiline />` に差し替え。**`sortingFn: sortLikeServer` / `accessorFn` / `enableSorting: true` / `size` / `header` は維持**(header 連番ソートと cell 編集は非干渉)。`line-clamp-2` は撤去(全文表示・行高可変=他 editable text 列と一貫)。

**制約:** 他列(title/sort_key/tags/解説/メモ/指標)定義は不変。`OptionsReadonlyCell`(`exam-card-table-options-cell.tsx`)は使用箇所が消えるので import 除去(file 自体の削除可否は plan 外、未使用 export を残さない方針なら削除、ただし他 import 無き確認後)。

**完了条件:** columns test(options 列が CompactOptionsCell / question 列が InlineTextField multiline・clamp 無し・sortingFn 維持・aria-label「問題文 編集」)green。`exam-card-table.test.tsx` で問題文 cell 編集化 + 既存 green。typecheck 0。canonical review Critical 0 + `[reviewed]`。

---

### Task 4: columnVisibility 導入 + 列表示/非表示 UI + examViewPrefs v2 永続化

**目的:** 列の表示/非表示を切替・永続化。

**Files:** Modify `lib/sync/sync-meta.ts`(schema v2 + union)/ `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(columnVisibility state + 永続化 + UI)/ `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx`(view load/save を v2 対応へ)。Create `app/(app)/app/exams/[id]/_components/exam-card-table-column-toggle.tsx`(+ tests、sync-meta.test.ts 追記)。

**Interfaces(Produces):**
- `sync-meta.ts`: `export const examViewPrefsV2Schema = z.object({ version: z.literal(2), view: z.enum(['card','table']), hiddenColumns: z.array(z.string()) }).strict()`。読み取りは `z.discriminatedUnion('version', [examViewPrefsV1Schema, examViewPrefsV2Schema])` + normalizer `toV2(prefs) => { view, hiddenColumns: prefs.version===2 ? prefs.hiddenColumns : [] }`。書込は v2。
- `ColumnVisibilityToggle`: 列ごと表示/非表示チェックの popover/dropdown(select 列を除く)。

**実装:**
- `exam-card-table.tsx`: `const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})` + `state.columnVisibility` + `onColumnVisibilityChange`。mount で `getJsonSyncMeta(examViewPrefs, union)` → `toV2` → `hiddenColumns` を `{[id]: false}` map に変換し setColumnVisibility。変更時 fire-and-forget で `setJsonSyncMeta(v2)`(view は現値保持)。`ColumnVisibilityToggle` を filter-bar 付近に render。`select` 列は toggle 対象外。title は toggle 可(hidden 時も `meta.sticky` は title 固定のまま=pin 昇格しない)。
- `exam-detail-view.tsx`: view の load/save を union schema + `toV2` 経由に更新(view 読みは v1/v2 両対応、書込は既存 view 切替時に v2 で `{version:2, view, hiddenColumns: 既存維持}`)。**view 切替で hiddenColumns を消さない**(read-modify-write)。

**制約:** view と hiddenColumns は同一 examViewPrefs key の 1 レコード。view 切替(exam-detail-view)と列 toggle(exam-card-table)が**互いの値を消さない**(read-merge-write)。columnFilters/columnSizing は従来どおり非永続。

**完了条件:** `sync-meta.test.ts`: v1 読み(hiddenColumns=[] に normalize)/ v2 読み書き / 不正値 fallback。`exam-card-table-column-toggle` + table test: toggle で `getIsVisible()` 反映・hidden 列が描画されない / select 列は toggle に出ない / 永続化(setJsonSyncMeta v2 呼び)/ リロード復元。view ↔ hiddenColumns 相互非破壊(view 切替後も hiddenColumns 保持、列 toggle 後も view 保持)。typecheck 0。canonical review Critical 0 + `[reviewed]`。sprint 末 smoke 対象。

---

## Self-Review

- **Spec coverage:** §4 T1→Task1 / T2→Task2 / T3(options差替+問題文)→Task3 / T4(columnVisibility+schema)→Task4。§7-1 schema v2→Task4 / §7-2 title 非表示可・pin 昇格なし→Global+Task4 / §7-3 仮想化なし→Sprint gate smoke。§3.1.1 T1 隔離+中間 smoke→Task1 完了条件 + gate。✓
- **Placeholder scan:** なし(schema 形・cell 構成・interface 明記)。OptionsReadonlyCell file 削除可否のみ条件付き(未使用確認後)= 判断条件明示済、TBD ではない。✓
- **Type consistency:** `useCardOptions` 戻り型 T1(Produces)↔ T2(Consumes)一致。`CompactOptionsCell({cardId, options})` T2↔T3。`examViewPrefsV2Schema` / `toV2` T4 内整合。`InlineOptionCell` export T1↔T2。✓
