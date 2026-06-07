# Tag-4b-fix: タグ section UI を Notion 方式 (popover) に再設計 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 各 task の完了条件は `pnpm test` + `pnpm build` 緑。 全 task 完了後に **単一 commit** (Task 5 末尾)。 push しない (OT が stg smoke)。

**Goal:** Tag-4b (commit `c2336be`) の「全カテゴリ常時縦展開」 UI を、 **Notion 方式コンパクト + popover 編集** に作り直す。 付いてるタグだけバッジ「カテゴリ名: option名」 + 「+ タグを追加」 1 つ、 バッジ click でそのカテゴリの option popover、 新規追加は 2 stage popover (カテゴリ → option)。

**Architecture:** optimistic logic を `CardTagsSection` に集約し、 popover/badge は callback ベースの presentation。 shadcn Popover (Tag-4a 導入済) 再利用、 DropdownMenu は使わない。 共通 sub-component `card-tag-option-list` で新規追加 stage 2 と編集 popover を統一。 parent 一括 subscribe + useMemo + 子 React.memo は不変、 whole-set 不変条件 (他カテゴリ落とし回避) + single 最大 1 個 0 個許容 + 案 a 取り直しを維持。

**Tech Stack:** Next.js 15 / shadcn Popover (`@/components/ui/popover`) / lucide-react (`Plus` / `CheckSquare` / `Circle` / `ChevronLeft` / `ChevronRight` / `Check`、 既存 deps) / Dexie + `dexie-react-hooks` / Vitest + RTL。 npm dep 追加なし。

**前提:**
- 設計仕様: `docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md` (283 行、 commit `2d8a4c0`)
- Tag-2c handler 着地済 (server 改修ゼロ)
- Tag-4b の inline-card-list (parent 一括 subscribe) は不変、 子 props 形 (`categories`, `options`, `cardTags`) も同じ
- Tag-4a-fix 型紙 (optimistic + popover 流儀 + a11y) を踏襲
- color palette: `lib/tags/color-palette.ts` (`colorToClass`) 継続使用

**全 task 共通ルール:**

- TypeScript strict、 既存 Client Component pattern 踏襲
- IDB → enqueue 並列発行 (Tag-4a-fix 型紙)
- 全 UI 文言は日本語、 Tailwind class は既存 slate 系で一貫
- 全 task 完了後に **単一 commit** (Task 5 末で):
  ```
  feat(tag): Tag-4b-fix Notion 方式 (popover) UI に再設計 [no-review]
  ```
- push しない (OT が stg smoke)

---

### Task 1: 旧 components 削除 + grep 確認

**Files:**
- Delete: `app/(app)/app/exams/[id]/_components/card-tag-pill.tsx` + `.test.tsx`
- Delete: `app/(app)/app/exams/[id]/_components/card-tag-add-dropdown.tsx` + `.test.tsx`
- Delete: `app/(app)/app/exams/[id]/_components/card-tag-category-row.tsx` + `.test.tsx`

**目的:** 構造変更で不要になる旧 3 components を caller 確認後に削除。 後続 task の混乱を避ける。

**制約:**
- 削除前に `grep -rn "card-tag-pill\|card-tag-add-dropdown\|card-tag-category-row" app/ components/ lib/` で caller 確認
- **想定ヒット先** (確認の目安、 これ以外があれば停止して controller 報告):
  - `card-tags-section.tsx`: 旧 3 components を import (orchestrator として組み立てている)、 Task 5 で大幅改修対象
  - `card-tag-category-row.tsx`: `card-tag-pill` と `card-tag-add-dropdown` を import (同時削除されるので問題なし)
  - `inline-card-list.tsx`: **旧 3 components を直接 import していない** はず (子は `card-tags-section` のみ)、 確認のため grep に含める
- caller が上記想定範囲内であることを verify、 想定外があれば停止して controller 報告
- 削除後 `pnpm test` は **card-tags-section.test.tsx の旧 test が失敗** するため、 Task 5 で書き直す前提で一時 fail を許容 (本 task の完了条件には含めない)
- TypeScript エラーも同様に Task 5 まで一時許容

**完了条件:**
- 旧 3 components + 各 test の 6 ファイルが削除されている
- grep verify レポート (caller が card-tags-section のみだった旨)

---

### Task 2: 新規共通 sub-component `card-tag-option-list`

**Files:**
- Create: `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (~80 行)
- Create: `app/(app)/app/exams/[id]/_components/card-tag-option-list.test.tsx` (~120 行)

**目的:** 新規追加 popover の stage 2 と編集 popover の両方で使う option list 共通 sub-component。 multi/single 切替 + 0 件 placeholder + tag manager link + 将来 combobox 化の余地を残す separation 構造。

**制約:**
- props: `{options: ClientTagOption[], selectedOptionIds: Set<string>, selectType: 'single' | 'multi', onToggle: (optionId: string) => void, onClose?: () => void}`
- `onClose` は single で option click 時に popover を閉じるための callback (親 popover から渡す)
- option 0 件: placeholder「このカテゴリには option がありません」 + `<Link href="/app/tags" prefetch={false}>タグ管理 →</Link>`
- 各 option: color pill (`colorToClass` 小サイズ) + name + (selected なら lucide `Check`)
- multi: click で onToggle (popover 開いたまま)
- single: click で onToggle + onClose() (popover 閉じる)
- 構造 separation: `<div><ul>{options.map(...)}</ul></div>` で将来 input 検索を上部に追加できる余地 (Tag-4c 想定)
- a11y: 各 option は `<button role="menuitemcheckbox">` 等 (radix Popover 内なので shadcn 標準に従う)
- color name 不明時は `COLOR_NULL_CLASS` fallback

**完了条件:** `pnpm test` 全件緑 (新規 test)、 `pnpm build` 緑、 multi toggle / single radio (onClose 呼出) / 0 件 placeholder の各シナリオ test 緑

---

### Task 3: `card-tag-badge` + `card-tag-edit-popover` (バッジ + 単 stage 編集)

**Files:**
- Create: `app/(app)/app/exams/[id]/_components/card-tag-badge.tsx` (~60 行)
- Create: `app/(app)/app/exams/[id]/_components/card-tag-badge.test.tsx` (~80 行)
- Create: `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` (~60 行)
- Create: `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.test.tsx` (~80 行)

**目的:** バッジ表示 (「カテゴリ名: option名」 + ×) と、 バッジ click で開く単 stage popover (該当カテゴリの option のみ) を実装。

**制約:**
- **CardTagBadge** props: `{category: ClientTagCategory, option: ClientTagOption, onRemove: () => void, onOpenEdit: () => void}`
- バッジ本体は `<button onClick={onOpenEdit}>`、 内側に「{category.name}: {option.name}」 + × (内側 `<span role="button" onClick={stopPropagation; onRemove}>`)
- バッジ a11y: `aria-label={`タグ: ${category.name}: ${option.name}`}`、 × は `aria-label={`タグ削除: ${category.name}: ${option.name}`}`、 keyboard Enter で onOpenEdit、 × Tab focus → Enter で onRemove
- color: `colorToClass(option.color)` で背景・文字・枠
- **CardTagEditPopover** props: `{category, categoryOptions, selectedOptionIds, onToggle, children}` (children = trigger = `<CardTagBadge />`)
- shadcn Popover 利用、 content max-w-sm、 内部に header「{category.name} を編集」 + `<CardTagOptionList />` + footer「タグ管理 →」 link
- 同 category の option_id の selected を Set で渡す (= `allAssignedOptionIds` のうち該当カテゴリのみ)
- onToggle は parent (Task 5 の section) で実装、 ここは callback の伝播のみ
- Popover 開閉は内部 state (open / setOpen)、 single onClose で setOpen(false)

**完了条件:** バッジ表示 + × 動作 + popover open/close + 該当カテゴリ option 表示 + tag manager link の各シナリオ test 緑、 `pnpm build` 緑

---

### Task 4: `card-tag-add-popover` (2 stage popover)

**Files:**
- Create: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (~100 行)
- Create: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx` (~150 行)

**目的:** 「+ タグを追加」 button trigger の 2 stage popover (カテゴリ選択 → option 選択 + 戻る + Esc 挙動 + tag manager link)。

**制約:**
- props: `{categories: ClientTagCategory[], options: ClientTagOption[], allAssignedOptionIds: string[], onToggle: (categoryId, optionId) => void}`
- trigger: lucide `Plus` icon + 「タグを追加」 text、 `aria-label="タグを追加"`
- stage state: `'category' | 'option'`、 selectedCategoryId state
- **stage 1 (カテゴリ選択):**
  - カテゴリリスト (created_at ASC sort)、 各行: name + 型アイコン (CheckSquare/Circle) + 右 ChevronRight
  - click → setStage('option'), setSelectedCategoryId(catId)
  - カテゴリ 0 件: placeholder「カテゴリがありません。 タグ管理 → でカテゴリを作成してください」 + link
  - footer: 「タグ管理 →」 link
- **stage 2 (option 選択):**
  - header: ← `<ChevronLeft />` + 「カテゴリ選択へ戻る」 button (click で setStage('category'))
  - `<CardTagOptionList categoryId={selectedCategoryId} categoryOptions={フィルタ済} selectedOptionIds={該当 category 分} selectType={category.select_type} onToggle={(optId) => onToggle(selectedCategoryId, optId)} onClose={() => setOpen(false)} />`
  - footer: 「タグ管理 →」 link
- **Esc 挙動 (Notion 方式)**:
  - Popover の `onEscapeKeyDown={e => { if (stage === 'option') { e.preventDefault(); setStage('category'); } }}`
  - stage 'category' での Esc は shadcn 標準 (popover 閉じる)
  - 再開時は stage 'category' から始まる (setStage('category') を popover close 時に発火)
- a11y: keyboard Enter で stage 切替、 Tab navigation で カテゴリ/option list を移動

**完了条件:** stage 1 → stage 2 切替 + 戻る button + Esc 戻り + 0 件 placeholder + multi/single via OptionList + tag manager link の各シナリオ test 緑

---

### Task 5: `card-tags-section` 大幅改修 (orchestrator + optimistic logic 集約) + smoke checklist + 統合 commit

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (~120 行、 大幅書き直し: orchestrator + optimistic logic + 付与済バッジ群 + 「+ タグを追加」 button)
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx` (~150 行、 書き直し)
- Create: `docs/superpowers/plans/2026-06-07-tag-4b-fix-smoke-checklist.md` (~80 行)

**目的:** orchestrator として optimistic logic を集約 (whole-set 不変条件 + single 0 個許容 + 他カテゴリ落とし回避)。 付与済バッジ群 + 「+ タグを追加」 button + 各種 popover を組み立て。 smoke checklist 作成 + 統合 commit。

**制約:**
- props 不変 (parent 一括 subscribe との接続): `{cardId, categories, options, cardTags}`
- 内部:
  - `allAssignedOptionIds = cardTags.map(t => t.option_id)` (parent から渡された該当 card 分のみ)
  - `handleToggle(categoryId, optionId)` で whole-set 構築 (spec の logic 通り) + IDB put/delete + enqueue + flush
  - 付与済バッジ: cardTags を iterate、 各 `card_tag` について該当 option + category を解決 → `<CardTagEditPopover><CardTagBadge ... /></CardTagEditPopover>` 描画
- `<CardTagAddPopover categories={categories} options={options} allAssignedOptionIds={allAssignedOptionIds} onToggle={handleToggle} />` を末尾に配置
- **見出し横の「タグ管理 →」 link は削除** (popover footer のみ)、 ただし `<h3>タグ</h3>` の見出し自体は維持 (空状態でも識別可能、 ただし「+ タグを追加」 button のみで見出し冗長なら省略も可。 plan: 見出し維持)
- `React.memo` ラップは Task 3 (Tag-4b) で導入済の export pattern を維持
- カテゴリ 0 件: 「+ タグを追加」 button のみ render、 click で popover に placeholder
- smoke checklist 観点 (~80 行):
  1. バッジ「カテゴリ名: option名」 表示
  2. バッジ × で即解除 (optimistic)
  3. バッジ本体 click で edit popover open (該当カテゴリ option のみ)
  4. edit popover で multi toggle / single radio / 0 個許容
  5. 「+ タグを追加」 button 1 つだけ、 click で 2 stage popover
  6. stage 1 カテゴリ選択 → stage 2 option 選択
  7. stage 2 で Esc → stage 1 に戻る (Notion 方式)
  8. stage 1 で Esc → popover 閉じる
  9. tag manager link は popover footer のみ (見出し横にない)
  10. カテゴリ 0 件 placeholder + link (popover 内)
  11. option 0 件カテゴリで placeholder + link
  12. whole-set 不変条件 (他カテゴリ落とし回避) 維持
  13. 案 a 取り直し (reload pull で IDB 反映)
  14. 既存 regression (試験詳細 card 編集、 タグ管理 page) 動作

**完了条件:**
- `pnpm test` 全件緑 (新規 + 改修分)
- `pnpm build` 緑
- TypeScript strict 緑
- 全変更 (Task 1-5) を **1 commit** で develop に積む

---

## Plan 完了後の OT smoke (push 前停止後)

OT 確認: 上記 14 観点を順次 PASS/FAIL で記録。 特に Notion 方式の 2 stage popover 操作感 (Esc 戻り) と「+ タグを追加」 button が card 内に 1 つだけになって縦長が解消されたか実機確認。

行数: 約 175 行 (目安 150-200 内)。
