# Tag-4c-2c: タグ管理画面 (/app/tags) の D&D 並べ替え — 設計

date: 2026-06-09 / topic: Tag-4c-2c manager D&D / phase: design

## §1 目的 / scope

タグ管理画面 (`/app/tags`) の category 一覧 + option 一覧を D&D で並べ替え可能にする。
Tag-4c-2b で manager の表示順 sort_key 化 + 作成末尾採番 + 共有 module / helper / reorder
handler / defensive filter / reindex / same-tx atomic 経路が完了済。 本 sprint は**manager に
D&D 入力手段を載せるだけ**で「逆向き = manager で並べ替え → popover に反映」 が成立する
(両画面が同一 IDB の同一 `sort_key` を共有 `sortByKeyThenCreated` で読む)。

In scope:
- manager `category-list.tsx` の各 row に行頭 drag handle (lucide `GripVertical`) を追加 + `useSortable` 配線
- manager `option-list.tsx` の各 row も同様
- 各一覧の内側に **別 `DndContext` + `SortableContext`** を mount + sensors 配線 + `arrayMove` → 共有 reorder handler dispatch
- Tag-4c-2b で `card-tags-section.tsx` に置いた `handleReorderCategories` / `handleReorderOptions` を**共有 module `lib/tags/reorder-handlers.ts` に移転**し、 popover (`card-tags-section.tsx`) と manager (`category-list.tsx` / `option-list.tsx`) の両方が同じ 1 関数を import (二重定義 drift 回避)

Out of scope:
- 表示順 sort_key 化 (Tag-4c-2b T7 で manager 一覧 comparator を共有 `sortByKeyThenCreated` に差替済)
- 作成末尾採番 (Tag-4c-2b T7 で manager 2 create form を共有 `nextSortKey` 化、 enqueue patch shape も popover と統一済)
- `reindexSortKeys` 純関数 / defensive filter / same-tx atomic / `logger.warn` (4c-2b T2 + T6 + T7 fix で完了)
- popover D&D 配線 / `card-tag-option-list.tsx` の `sortable` prop / popover の `DndContext` 配線 (4c-2b T4/T5/T5 fix/T6 で完了)
- card body 上のバッジ並び (Tag-4b-fix 固定)
- fractional indexing / collaborative reorder (タグ件数小、 整数 reindex で十分)
- manager の編集モード中 (rename input 表示中 / カテゴリ移動 dropdown 開中) の D&D 無効化 (考慮不要、 dnd handle と編集 UI は構造分離されているため衝突しない)

## §2 確定済 前提 (relitigate しない)

- 採用 dep: dnd-kit 3 packages (4c-2b T3 で land 済)、 **新 dep なし**
- 共有 module 既設 (4c-2b 完了): `@/lib/tags/sort-comparator` / `@/lib/tags/next-sort-key` / `lib/tags/reindex-sort-keys.ts`
- reorder handler は既存 same-tx atomic + defensive filter 設計を**そのまま流用** (signature / 実装本体無変更で移転)
- 「filter 中 D&D 無効」 は popover 専用の不変条件 (spec 4c-2b §4.5 Rev1.3)、 manager は filter を持たないため踏襲不要 (`dndEnabled` gate 概念は manager に持ち込まない)
- 母数: manager 一覧と popover 一覧は同一 user scope の同一 IDB read、 reindex 全件前提も両画面で成立
- ハンドル方式: 行頭の専用 button (lucide `GripVertical`) にのみ `useSortable` の
  `listeners`/`attributes` を spread、 既存 row 操作 (active 切替 click / pen icon rename / 削除 ×
  / OptionRow の color pill / カテゴリ移動 dropdown) と event 構造分離 (popover SortableRow パターン踏襲)
- タッチ: `PointerSensor` の `activationConstraint: { delay: 250, tolerance: 5 }` (popover と同値)、
  `KeyboardSensor` + `sortableKeyboardCoordinates` も同値
- mobile / desktop 2 mount (`tag-manager-shell.tsx:11-13`): desktop grid + mobile Tabs で同
  `CategoryList` / `OptionList` を 2 度 mount → 各 `DndContext` 独立、 IDB subscription で同期

## §3 Step 0 調査結果サマリ (red flag なし)

| 観点 | 確認内容 | 結論 |
|---|---|---|
| `CategoryRow` 行 DOM | `category-row.tsx:162-220` で row 全体が `<div role="button" tabIndex={0} onClick onKeyDown>` + 内側に pen icon (stopPropagation) + select_type badge + 削除 button (stopPropagation) | dnd-kit を `<div role="button">` に直接当てると aria-roledescription 等の衝突余地 ⇒ **外側 `<li>` ラッパを噛ませて dnd-kit を `<li>` に当てる** (popover SortableRow パターン踏襲)。 内側 `<div role="button">` の active 切替は維持 |
| `OptionRow` 行 DOM | `option-row.tsx:229-383` で row 自身は click handler なし (`:7` コメント `右 panel に表示中の option は全 active 扱い`)、 内側に color pill / pen icon rename / カテゴリ移動 dropdown / 削除 ×、 すべて stopPropagation 既存実装 | row 自体に role/click なし → `<li>` ラッパ + dnd-kit を `<li>` に当てる形が clean。 既存 4 button との event 競合なし |
| reorder handler 依存構造 | `card-tags-section.tsx:510-597` の `handleReorderCategories(existingCategories, orderedIds)` / `handleReorderOptions(existingOptions, categoryId, orderedIds)` の依存 = 引数注入 + external module (`getClientDb` / `reindexSortKeys` / `enqueueEntityMutation` / `runGuardedEntityMutationFlush` / `logger`) のみ | **popover 固有結合ゼロ** (tagEditCallbacks 等の参照なし)、 そのまま共有 module 移転可能。 既存 cross-route import (`app/(app)/app/exams/[id]/_components/card-tags-section.tsx` を `/app/tags` から import) という構造異常も解消 |
| manager filter 有無 | `category-list.tsx:59-62` + `option-list.tsx:57-64` ともに `useLiveQuery + .sort(sortByKeyThenCreated)` で全件表示、 filter input なし | 「filter 中 D&D 無効」 gate 不要、 manager は常時 D&D 有効。 `items.length < 2` の handle 非表示は popover と同様適用 |
| manager 一覧母数 | manager: `db.tag_categories.toArray()` で user 全 scope。 popover stage1: `card-tags-section.tsx` に渡される `categories` props = `inline-card-list.tsx` の `useLiveQuery` 経由 → 同じ user 全 scope category 集合 | **母数同一**、 reindex 0-based 正規化が両画面で整合 |
| defensive filter | 4c-2b T7 で `handleReorderX` 内に `orderedIds.filter(id => currentMap.has(id))` 先回り実装済 (`card-tags-section.tsx:518` / `:570`) | manager 経由の less-trusted caller (例: 別 category の id が race で混入) も自動で守られる |
| mobile vs desktop 2 mount | `tag-manager-shell.tsx:11-13` コメント「子 component は desktop / mobile で 2 度 mount される」 | 各 mount で `DndContext` 独立、 IDB `useLiveQuery` subscription で並べ替え結果が同期。 popover stage1/stage2 別 mount と同型構造、 spec §4.5 で扱い明示 |
| 編集モード中の D&D | CategoryRow / OptionRow の編集 input 表示中は handle button が依然行頭に存在、 ただし input 内部の onClick stopPropagation で row click と分離、 handle は別 button | 編集モード中も D&D は機能する (row 全体を grab したら handle 起動)。 input focus 中の意図しない drag 防止は `delay: 250` PointerSensor で十分。 編集中 handle 無効化は spec §1 out of scope |

## §4 設計

### §4.1 reorder handler を共有 module へ移転

新規 file `lib/tags/reorder-handlers.ts` を作成し、 `card-tags-section.tsx:486-597` の以下を**そのまま移転**:
- module 先頭 docstring (`handleReorderCategories` / `handleReorderOptions` の atomic 規約 + defensive filter + logger 経緯)
- `export async function handleReorderCategories(existingCategories, orderedIds)`
- `export async function handleReorderOptions(existingOptions, categoryId, orderedIds)`

`card-tags-section.tsx` は新 module から re-import:
```ts
import {
  handleReorderCategories,
  handleReorderOptions,
} from '@/lib/tags/reorder-handlers'
```
section 内の `useCallback` で props bind した closure (`reorderCategories` / `reorderOptions`) は無変更、 popover への配線 (`<CardTagAddPopover onReorderCategories={...} onReorderOptions={...} />`) も無変更。 manager (§4.3) は同じ新 module から直接 import する。

既存 test 群 (`card-tags-section.test.tsx` の `handleReorderX` テスト = M-A contamination test 含む) は新 file `lib/tags/reorder-handlers.test.ts` へ**移転**し、 section の test 責務は「create / rename / color / delete / toggle」 に縮退 (= popover 結合経路の test に絞る)。

### §4.2 manager 行への handle 移植 (popover SortableRow パターン踏襲)

各 row の外側に `<li>` ラッパ + dnd-kit `useSortable` 配線を持つ **sortable wrapper component** を新規追加し、 既存 `CategoryRow` / `OptionRow` 本体は**完全無変更**で内側に noticed:

`category-list.tsx` 内に追加 (`<li>` ラッパ component):
```jsx
function SortableCategoryRowWrapper({ category, ...rest }: Props) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: category.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-2">
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...listeners}
        {...attributes}
        aria-label={`カテゴリを並べ替え: ${category.name}`}
        className="inline-flex h-7 w-6 cursor-grab items-center justify-center touch-none text-slate-400 hover:text-slate-600"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <div className="flex-1 min-w-0">
        <CategoryRow category={category} {...rest} />
      </div>
    </li>
  )
}
```

`option-list.tsx` 内にも `SortableOptionRowWrapper` を同型で追加。

**重要**: `CategoryRow` / `OptionRow` 自身は**無変更** (popover の `CardTagOptionList` のように内部分割 (`SortableRow`/`StaticRow`/`RowInner`) する必要はない、 manager 行は wrapper 外置でシンプル)。 ただし `items.length < 2` のとき `<li>` ラッパを使わず素の `<li><CategoryRow .../></li>` 形 (handle 非表示) で render する分岐は親 list で行う。

### §4.3 manager `DndContext` / `SortableContext` / sensors 配置

`category-list.tsx` の現状 `<ul className="space-y-1">{list.map(...)}</ul>` (推定構造、 実装時 verify) を以下で囲む:

```jsx
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
)

const sortableEnabled = list.length >= 2

return (
  <div className="space-y-3">
    <CategoryCreateForm onCreated={handleCreated} existingSortKeys={list.map(c => c.sort_key)} />
    {sortableEnabled ? (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => handleManagerDragEnd(event, list)}
      >
        <SortableContext items={list.map(c => c.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1">
            {list.map((category) => <SortableCategoryRowWrapper key={category.id} ... />)}
          </ul>
        </SortableContext>
      </DndContext>
    ) : (
      <ul className="space-y-1">
        {list.map((category) => <li key={category.id}><CategoryRow ... /></li>)}
      </ul>
    )}
    <DeleteConfirmDialog ... />
  </div>
)
```

`handleManagerDragEnd`:
```ts
const handleManagerDragEnd = (event: DragEndEvent, items: ClientTagCategory[]) => {
  const { active, over } = event
  if (!over || active.id === over.id) return
  const oldIndex = items.findIndex((c) => c.id === active.id)
  const newIndex = items.findIndex((c) => c.id === over.id)
  if (oldIndex === -1 || newIndex === -1) return
  const next = arrayMove(items, oldIndex, newIndex)
  void handleReorderCategories(items, next.map((c) => c.id))
}
```

`option-list.tsx` も同型 (`handleReorderOptions(items, activeCategoryId, ...)` に置換、 `activeCategoryId` は `OptionList` props から渡される)。

### §4.4 既存 row 操作との event 分離

`SortableCategoryRowWrapper` / `SortableOptionRowWrapper` の構造で:
- `useSortable` の `listeners` / `attributes` は **handle button のみ** に spread (popover 同パターン)
- `<li>` 自身 (`setNodeRef`) には listeners なし → row 全体 click (CategoryRow の row click による active 切替) は drag を起動しない
- 内側 `CategoryRow` / `OptionRow` の既存 button (pen icon / 削除 × / color pill / カテゴリ移動 dropdown) は無変更で stopPropagation 既存実装に依存
- `touch-none` は handle button のみ (row 全体 touch スクロール / tap active 切替を殺さない)

### §4.5 mobile vs desktop 2 mount の取り扱い

`tag-manager-shell.tsx:11-13` のコメントどおり、 同 `CategoryList` / `OptionList` が desktop grid と mobile Tabs で 2 度 mount される。 本 spec では:
- 各 mount に独立 `DndContext` + `SortableContext` を立てる (mount 単位で配線)
- IDB `useLiveQuery` subscription で並べ替え結果は両 mount に即反映 (片方で drag → 当該 mount の `arrayMove` → mirror update → useLiveQuery 経由でもう片方の list が再 emit)
- drag 中の `transform` は active な mount の DOM だけ動く (desktop / mobile breakpoint は CSS で 1 つだけ表示、 不可視 mount の drag transform は問題にならない)
- 結果 = popover stage1/stage2 別 mount と同型構造、 余計な対処不要

## §5 非目標 / 据置

- 表示順 sort_key 化 / 末尾採番 / `reindexSortKeys` / defensive filter / same-tx atomic / `logger.warn` (Tag-4c-2b 完了)
- popover D&D 配線 (Tag-4c-2b 完了)
- 編集モード中 D&D 無効化 (現状 PointerSensor `delay: 250` で十分、 input focus 中の意図せぬ drag は実用上発生しない)
- mobile 実機ジェスチャ最適化 (本 sprint は popover と同値 `delay: 250 / tolerance: 5`、 mobile-only 調整は spec §9 smoke で発見されたら別 hotfix scope)
- card body バッジ並び (Tag-4b-fix 固定)
- transport 強化 (spec 4c-2b §4.9 D-6 = A 許容案を維持、 番兵注記どおり要件が来たら別 sprint)

## §6 テスト方針

- Unit (Vitest):
  - **既存 `card-tags-section.test.tsx` の handleReorderX テストを `lib/tags/reorder-handlers.test.ts` へ移転** (§4.1 抽出に伴う file 移動、 ロジック / assertion 無変更)。 section の test 責務は create / rename / color / delete / toggle に縮退
  - 新 `category-list.test.tsx` 拡張:
    - handle 表示条件 (`items.length >= 2` で表示 / 1 件以下で非表示)
    - drag-end で `handleReorderCategories` mock が呼ばれ、 引数が `(items, newOrderedIds)` 形式 (jsdom 制約で実 pointer drag pin 困難 → DndContext mount + handle presence + handler dispatch contract に分解)
    - 既存挙動 (row click による active 切替 / pen icon rename / 削除 confirm dialog) regression なし
  - 新 `option-list.test.tsx` 拡張: 同型 (`handleReorderOptions(items, activeCategoryId, newOrderedIds)` 引数)
  - `category-row.test.tsx` / `option-row.test.tsx`: **無変更** (行本体に touch しないため)
  - `lib/tags/reorder-handlers.test.ts`: 4c-2b の M-A contamination test (cat-2 id 混入、 未登録 id 混入) を移転、 同 assertion で pass

- E2E (Playwright MCP):
  - stg smoke で manager category 一覧 / option 一覧の D&D + reload 後の並び維持
  - mobile viewport で touch drag 動作 (long-press 起動 / scroll 誤発火なし)
  - **popover で並べ替え → manager に即反映** (4c-2b で確定済の不変条件を smoke で確認) と **manager で並べ替え → popover に即反映** (本 sprint の主目的を smoke で確認) の双方向同期
  - 本格的な動作確認は OT が stg で実行 (CLAUDE.md §Smoke 確認 担当境界)

- 実 API 禁止 / モック必須 (CLAUDE.md §AI §8)

## §7 論点 (OT 確定済 / 2026-06-09)

各論点は OT 一括判断で確定 (全 4 件 CC 推奨どおり A)。以下は確定内容の記録、本 spec 採用判断には再協議不要。

| ID | 確定 | 内容 |
|---|---|---|
| E-1 | **A** | reorder handler を `lib/tags/reorder-handlers.ts` に純粋 helper として移転、 既存 signature `(existingCategories \| existingOptions, orderedIds [, categoryId])` 維持、 引数注入、 hook 化しない。 popover (`card-tags-section.tsx`) / manager (`category-list.tsx` / `option-list.tsx`) が同 1 関数を import。 既存 test は `reorder-handlers.test.ts` に file 移動。 cross-route import 構造異常も解消 |
| E-2 | **A** | 専用 `SortableCategoryRowWrapper` / `SortableOptionRowWrapper` を `category-list.tsx` / `option-list.tsx` 内に追加、 既存 `CategoryRow` / `OptionRow` 本体は**無変更**で外側 `<li>` ラッパに wrap。 popover の `SortableRow`/`StaticRow` 内部分割は manager に移植せず (manager 独自 UI = color picker / カテゴリ移動 dropdown / pen rename / 削除 を Row component に保持) |
| E-3 | **A** | category 一覧 / option 一覧それぞれの内側に**別 `DndContext` + `SortableContext`**。 sensors = popover と同値 (`PointerSensor delay: 250 / tolerance: 5` + `KeyboardSensor` + `sortableKeyboardCoordinates`)、 `closestCenter` / `verticalListSortingStrategy`。 manager に filter なしゆえ `dndEnabled` gate は持ち込まず、 handle 表示条件は `items.length < 2` で非表示のみ。 `<DndContext>` mount/dispose は `sortableEnabled` 条件 render |
| E-4 | **A** | mobile/desktop の 2 mount (`tag-manager-shell.tsx`) に**各々独立 `DndContext` + `SortableContext`**。 IDB `useLiveQuery` subscription で並べ替え結果は両 mount に即反映。 `DndContext` の共有上げはしない (breakpoint 切替時の sortable state 持ち越し回避、 popover stage 別 mount と同型構造) |

## §8 完了条件

- `lib/tags/reorder-handlers.ts` 新規 + 既存 `handleReorderCategories` / `handleReorderOptions` を移転 (card-tags-section.tsx は新 module を re-import)
- `lib/tags/reorder-handlers.test.ts` 新規 (4c-2b T6/T7 の rollback / contamination test を移転、 assertion 無変更で pass)
- `card-tags-section.test.tsx` から reorder ブロックを取り除き、 残テスト全 pass (regression なし)
- manager `category-list.tsx` / `option-list.tsx` に `SortableCategoryRowWrapper` / `SortableOptionRowWrapper` 追加 + `DndContext` + sensors + `arrayMove` → `handleReorderX` dispatch
- `category-row.tsx` / `option-row.tsx` 本体は**無変更** (行責務分離)
- `items.length < 2` で handle 非表示 (並べ替え不能で grip を出さない)
- manager で D&D 並べ替え動作 (mouse + keyboard + touch)、 drag-end で `tag_categories.sort_key` / `tag_options.sort_key` が 0-based 整数で正規化、 reload で並び維持、 popover に即反映 (同 IDB)
- 既存 manager 挙動 (active 切替 / rename / 削除 confirm / color picker / カテゴリ移動 dropdown / 末尾採番) リグレッションなし
- 既存 popover D&D 配線 (4c-2b 完了分) も regression なし (`handleReorderX` 抽出後も popover 経路で正しく動作)
- mobile/desktop 2 mount で並べ替え結果が同期表示
- Vitest 全 pass / Playwright smoke 全 pass / code-reviewer Critical 0 件 / `[reviewed]` tag
- npm dep 追加なし (dnd-kit 3 packages は 4c-2b T3 land 済を流用)

## §9 Smoke 確認項目 (本 sprint 末、 OT が stg で実行)

- (a) manager category 一覧 / option 一覧の D&D + reload で並び維持
- (b) **双方向同期**: popover で並べ替え → manager に即反映 / manager で並べ替え → popover に即反映 (両画面同時表示で確認)
- (c) mobile viewport (DevTools mobile view) で touch drag 動作 (long-press 起動 / scroll 誤発火なし)
- (d) `items.length < 2` (空 + 1 件) で handle 非表示
- (e) `CategoryRow` の row click による active 切替 / pen icon rename / 削除 button が D&D 配線後も regression なし
- (f) `OptionRow` の color pill / カテゴリ移動 dropdown / pen icon rename / 削除 button が regression なし
- (g) mobile breakpoint 下の Tabs 切替 (categories ↔ options) 中の drag state 持ち越し問題なし
- (h) Tag-4c-2b §9 で確認済の popover 固有 smoke (Esc 衝突 / scroll clip / mobile long-press) も regression なしを確認

(a)〜(g) は本 sprint 主目的、 (h) は 4c-2b 完了状態の維持確認。 fallback (`DragOverlay` portal / sensor 値調整) は別 hotfix scope で本 spec に inline しない (本 sprint は in-place + popover と同値 sensor で land)。
