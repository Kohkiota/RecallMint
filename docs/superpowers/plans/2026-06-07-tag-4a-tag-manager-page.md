# Tag-4a: タグ管理 page (`/app/tags`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 各 task の完了条件は `pnpm test` + `pnpm build` 緑。 全 task 完了後に **単一 commit** (Task 5 末尾)。 push しない (OT が stg smoke)。

**Goal:** 独立 page `/app/tags` で タグカテゴリと option の inline CRUD UI を提供する。 Tag-1 で着地済の `entity_type='tag_category'` / `'tag_option'` mutation 経路を **初めて UI から呼ぶ** sprint。

**Architecture:** Server Component shell + Client component (`'use client'`) で 2 column / mobile tab fallback。 `useLiveQuery` で IDB 直読 + `enqueueEntityMutation` で書込。 既存 `inline-text-field.tsx` pattern を踏襲。 D&D 並べ替えは Tag-4e 送りで未導入、 表示順は `created_at ASC` 固定。

**Tech Stack:** Next.js 15 App Router / shadcn/ui (`Popover` / `DropdownMenu` / `Tabs` を `npx shadcn@latest add` で追加、 file 追加のみで npm dep 追加なし。 `radix-ui` ^1.4.3 meta package は既存) / 既存 `components/ui/confirm-dialog.tsx` の `ConfirmDialog` 再利用 (AlertDialog は導入せず) / CSS grid `md:grid-cols-3` で 2 column (`react-resizable-panels` 導入なし) / `dexie-react-hooks` の `useLiveQuery` / Vitest + React Testing Library。

**前提:**
- 設計仕様: `docs/superpowers/specs/2026-06-07-tag-4a-tag-manager-design.md` (192 行、 brainstorming 完了)
- Tag-1 で `applyTagCategoryX` / `applyTagOptionX` (server side) 着地済、 server 改修 0 行
- Tag-2b で `tag_categories` / `tag_options` の Dexie mirror + pull stream 着地済
- 既存 `enqueueEntityMutation` (`lib/sync/entity-mutations.ts`) は entity_type / op を文字列で受ける汎用 helper、 改修不要
- design tokens: Geist + shadcn/ui + OKLCH モノクロ (CLAUDE.md「UI 一貫した世界観」 遵守)

**全 task 共通ルール:**

- TypeScript strict、 既存 `inline-text-field.tsx` / `inline-option-row.tsx` の Client Component pattern (`'use client'`、 `useLiveQuery`、 `enqueueEntityMutation`、 `runGuardedEntityMutationFlush` 起動 trigger) を踏襲
- 全 mutation は `entity_type='tag_category'` / `'tag_option'`、 patch shape は registry の zod schema (`entity-mutation-registry.ts:202-211, 249-258`) に従う
- 全 UI 文言は日本語 (既存 page と一致)、 Tailwind class は既存 (`text-2xl font-bold`、 `text-slate-600/500`、 `bg-{color}-100 text-{color}-800 border-{color}-200`) と一貫
- 全 task 完了条件: `pnpm test` 全件緑 / `pnpm build` 緑 / TypeScript strict 緑
- 全 task 完了後に **単一 commit** (Task 5 末で):
  ```
  feat(tag): Tag-4a タグ管理 page (/app/tags) [no-review]
  ```
- push しない (OT が stg smoke)

---

### Task 1: palette util + 共通 component (popover + dialog)

**Files:**
- Create: `lib/tags/color-palette.ts` (~30 行、 TAG_COLOR_NAMES + COLOR_TO_CLASS map + null fallback)
- Create: `lib/tags/color-palette.test.ts` (~30 行、 12 色全件の class 定義 + fallback test)
- Create: `app/(app)/app/tags/_components/color-palette-popover.tsx` (~60 行、 13 cell grid Popover、 onChange callback)
- Create: `app/(app)/app/tags/_components/color-palette-popover.test.tsx` (~40 行、 13 cell 表示 + click で onChange)
- Create: `app/(app)/app/tags/_components/delete-confirm-dialog.tsx` (~40 行、 既存 `ConfirmDialog` の薄いラッパー、 影響範囲表示 props を `description: React.ReactNode` に変換)
- Create: `app/(app)/app/tags/_components/delete-confirm-dialog.test.tsx` (~40 行、 影響範囲 count 表示 + confirm callback)
- shadcn 経由で **`@/components/ui/popover.tsx` を追加** (`npx shadcn@latest add popover`、 file 追加のみ、 npm dep 追加なし)

**目的:** Task 2/3 で使う共通 building block (palette / dialog) を独立に作る。 UI 単位で test 可能にして、 後続 component の責務を絞る。

**制約:**
- color-palette.ts の `TAG_COLOR_NAMES` は 12 色固定 (`red/orange/amber/yellow/lime/green/emerald/teal/cyan/blue/violet/pink`)、 `COLOR_TO_CLASS` は各 color → `bg-X-100 text-X-800 border-X-200` の 3-class 文字列、 不明色は `COLOR_NULL_CLASS` (`slate`) に fallback
- delete-confirm-dialog は **既存 `components/ui/confirm-dialog.tsx` の `ConfirmDialog` を再利用** する薄いラッパー (a11y / focus / Esc / backdrop close 担保済を継承)。 影響範囲を props (`childCount`, `cardCount` 等) で受けて `description: React.ReactNode` に変換し ConfirmDialog に渡す。 影響範囲 N >= 100 は `100+` に省略表示。 shadcn の AlertDialog は導入せず
- color-palette-popover.tsx は shadcn の `Popover` を利用 (Task 1 で CLI 追加した `@/components/ui/popover.tsx`)

**完了条件:** `pnpm test` で本 task の test 5 ファイル全件緑 / `pnpm build` 緑

---

### Task 2: カテゴリ系 component (list + row + create form)

**Files:**
- Create: `app/(app)/app/tags/_components/category-row.tsx` (~50 行、 inline rename + 「カテゴリ削除」 button + select_type バッジ)
- Create: `app/(app)/app/tags/_components/category-create-form.tsx` (~50 行、 name input + select_type radio + 追加 button)
- Create: `app/(app)/app/tags/_components/category-list.tsx` (~80 行、 `useLiveQuery` で `db.tag_categories.toArray()` + 作成順 sort + active 切替 + 削除 confirm)
- Create: `app/(app)/app/tags/_components/category-row.test.tsx` / `category-create-form.test.tsx` / `category-list.test.tsx` (~150 行 合計)

**目的:** 左 column のカテゴリ一覧 + CRUD UI。 削除時は AlertDialog で影響範囲 (配下 option 数 + 紐付き card 数) を表示。

**制約:**
- リネーム: 既存 `inline-text-field.tsx` の click→input→blur→enqueue pattern を踏襲 (component を再利用するか流儀をコピーするかは subagent 判断、 既存 component が generic なら再利用)
- 削除影響範囲 count: `db.tag_options.where('category_id').equals(catId).toArray()` で配下 option を取得、 さらに各 option に対し `db.card_tags.where('option_id').equals(optId).count()` を合算。 100 件超は `100+`
- 削除 mutation 発行順序: 配下 option を全件 delete (各 option 個別 `entity_type='tag_option'` op='delete'`)、 最後にカテゴリ delete (`entity_type='tag_category'` op='delete'`)。 server 側で配下 option も tombstone INSERT する (apply-tag-mutation.ts:109-159) ため client は category delete 1 件だけ送ればよい (二重削除回避)
- カテゴリ作成: name 必須 (空 → 追加 button disabled)、 select_type は default 'multi' + radio で切替、 作成後 form reset
- active カテゴリ state は React local state、 親 (Task 4 の shell) から制御可能な props 形 (`activeCategoryId` + `onSelect`)
- 表示順: `created_at ASC` 固定 (sort_key UI なし、 4e 送り)

**完了条件:** `pnpm test` 全件緑 / `pnpm build` 緑 / 各 component test がカバー (追加 / リネーム / 削除 confirm + 影響範囲表示 + active 切替)

---

### Task 3: option 系 component (list + row + create form + カテゴリ移動 dropdown)

**Files:**
- Create: `app/(app)/app/tags/_components/option-row.tsx` (~80 行、 inline rename + color pill (popover trigger) + カテゴリ変更 dropdown + 削除 button)
- shadcn 経由で **`@/components/ui/dropdown-menu.tsx` を追加** (`npx shadcn@latest add dropdown-menu`、 file 追加のみ、 npm dep 追加なし)
- Create: `app/(app)/app/tags/_components/option-create-form.tsx` (~60 行、 name + color picker + 追加 button + UNIQUE 事前チェック)
- Create: `app/(app)/app/tags/_components/option-list.tsx` (~80 行、 `useLiveQuery` で `db.tag_options.where('category_id').equals(activeCategoryId).toArray()` + 作成順 sort)
- Create: `app/(app)/app/tags/_components/option-row.test.tsx` / `option-create-form.test.tsx` / `option-list.test.tsx` (~200 行 合計)

**目的:** 右 column の option 一覧 + CRUD UI。 active カテゴリ未選択時は「カテゴリを選択してください」 placeholder。

**制約:**
- color pill: option の `color` 文字列を `COLOR_TO_CLASS[color]` で class に変換、 不明色は `COLOR_NULL_CLASS` fallback。 click で `ColorPalettePopover` (Task 1) を開く、 選択で `enqueueEntityMutation({entity_type:'tag_option', op:'update_field', patch:{field:'color', value: selectedColor}})` 発行
- カテゴリ変更 dropdown: shadcn `DropdownMenu` で `db.tag_categories.toArray()` から現カテゴリ以外を列挙、 選択で `update_field` patch field='category_id' 発行。 移動先で同名 option 存在チェック (IDB) → 衝突時は dropdown 内 inline error 表示で enqueue 抑止
- option 作成 UNIQUE 事前チェック: `db.tag_options.where({category_id, name}).count() > 0` で即「同名が既に存在します」 表示、 enqueue 抑止
- リネーム時の UNIQUE: 自分自身を除く同 category 内同名 → inline error 表示、 enqueue 抑止
- server failed (race) 受領時: `runGuardedEntityMutationFlush` の戻り値で failed mutation_id を取得、 該当 row に inline error 表示 + UI を元値に巻き戻し (`inline-text-field` の error state pattern を踏襲)
- 削除影響範囲: `db.card_tags.where('option_id').equals(optId).count()`、 100 件超 `100+`

**完了条件:** `pnpm test` 全件緑 / `pnpm build` 緑 / UNIQUE 違反 + server failed race + カテゴリ移動 + 色変更 + 削除 confirm の各シナリオ test 緑

---

### Task 4: shell + page + loading + nav 追加

**Files:**
- Create: `app/(app)/app/tags/_components/tag-manager-shell.tsx` (~80 行、 desktop は CSS grid `md:grid-cols-3` で `col-span-1 + col-span-2`、 mobile (< md) は shadcn Tabs で「カテゴリ」 「option」 切替、 `activeCategoryId` state)
- Create: `app/(app)/app/tags/_components/tag-manager-shell.test.tsx` (~80 行、 layout 切替 + props 整合)
- shadcn 経由で **`@/components/ui/tabs.tsx` を追加** (`npx shadcn@latest add tabs`、 file 追加のみ、 npm dep 追加なし)
- Create: `app/(app)/app/tags/page.tsx` (~30 行、 Server Component、 タイトル「タグ管理」、 `<TagManagerShell />` render)
- Create: `app/(app)/app/tags/loading.tsx` (~20 行、 skeleton 即時 fallback)
- Modify: `app/(app)/app/_components/app-header.tsx` (+5 行、 nav 5 番目に「タグ」 link 追加、 `prefetch={false}` 必須)
- Modify: `app/(app)/app/_components/app-header.test.tsx` (+15 行、 5 link 表示 + active 表示 test)

**目的:** Task 2/3 を統合した shell + page を組み、 nav からアクセス可能にする。 mobile では Tabs で カテゴリ / option を 1 active 切替。

**制約:**
- desktop (md 以上) の 2 column: CSS grid `md:grid-cols-3` で左 `col-span-1` + 右 `col-span-2` (1/3 + 2/3 固定幅、 境界線ドラッグなし、 react-resizable-panels 導入なし)
- mobile (< md) の Tabs: shadcn `Tabs` (Task 4 で CLI 追加した `@/components/ui/tabs.tsx`) の `value="categories" | "options"`、 カテゴリ選択時に options tab に自動切替
- `activeCategoryId` の lift: shell が state を持ち、 `<CategoryList activeCategoryId={...} onSelect={...} />` と `<OptionList activeCategoryId={...} />` 両方に伝播
- nav 追加: アップロード / 試験 / スマート復習 / **タグ** / 設定 の順、 5 番目挿入。 `prefetch={false}` を必ず付与 (T2.5 警告、 `app-header.tsx:10-13` のコメント参照)
- loading.tsx: 既存 `app/(app)/app/loading.tsx` と同レベルの skeleton (左 column / 右 column の rectangle 数個)

**完了条件:** `pnpm test` 全件緑 / `pnpm build` 緑 / `app-header.test.tsx` の 5 link 表示 test 緑

---

### Task 5: smoke checklist + 統合 commit

**Files:**
- Create: `docs/superpowers/plans/2026-06-07-tag-4a-smoke-checklist.md` (~80 行、 stg smoke 観点 + 手順)

**目的:** Tag-1〜Tag-2c は handler / pull 経路を smoke 済だが、 Tag-4a は **UI 経由で初めて entity_type='tag_category' / 'tag_option' を enqueue** する。 UI 操作 → enqueue → flush → server applied → pull → IDB 反映 → useLiveQuery 再描画 の 1 ループを観測する観点を整理。

**制約:**
- checklist 観点 (主要):
  1. nav 5 番目「タグ」 link で `/app/tags` に navigate (Server Component 描画 + Client hydration)
  2. カテゴリ作成 → 即 UI に表示 (`useLiveQuery` 再描画) + bulk endpoint applied:1 + IDB tag_categories に反映
  3. option 作成 (active カテゴリ配下) → 同上
  4. リネーム (カテゴリ / option) → in-place 編集 → blur → enqueue + IDB 反映 + useLiveQuery 再描画
  5. color 変更: pill click → popover → 12 色 + null から選択 → enqueue + Tailwind class 反映
  6. カテゴリ間移動: option 行の「カテゴリ変更」 dropdown → 別カテゴリ選択 → enqueue + 右 panel から消えて移動先カテゴリで表示
  7. UNIQUE 違反: 同 category 内同名 option 作成 → client 即弾き「同名が既に存在します」 表示
  8. 削除 confirm: カテゴリ削除 → AlertDialog で配下 option N 件 + card M 件表示 → 確定 → server cascade + client purge で IDB から消える
  9. mobile (DevTools mobile view) で Tabs 切替動作 + 操作可能
  10. console error 0、 全 API 200、 entity_mutations pending 残らず
- 観測手順は DevTools console + IDB evaluate (Tag-2 smoke の経験と同パターン)
- **commit はしない** (本 task の最後で controller がまとめて 1 commit)

**完了条件:**
- smoke checklist 作成済
- `pnpm test` 全件緑 (Task 1〜4 の合算、 確認のため最終 run)
- `pnpm build` 緑
- 全変更 (Task 1+2+3+4+5 の差分) を **1 commit** で develop に積む

---

## Plan 完了後の OT smoke (push 前停止後)

OT 確認: 上記 checklist の 10 観点を順次 PASS/FAIL で記録。 全 PASS 判定後、 Tag-4b plan (試験詳細 page の card にタグ列追加 + 単純付与/解除 UI) に着手。

行数: 約 195 行 (目安 150-200 内)。
