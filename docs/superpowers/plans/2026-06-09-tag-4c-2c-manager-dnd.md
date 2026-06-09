# Tag-4c-2c Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 task 単位で fresh subagent + task 間 review。 inline 一括実行 (`executing-plans`) は OT 明示選択時のみ。
> spec: `docs/superpowers/specs/2026-06-09-tag-4c-2c-manager-dnd-design.md`

**Goal:** タグ管理画面 (/app/tags) の category 一覧 + option 一覧を D&D で並べ替え可能化、 4c-2b で完成済の sort_key 経路 (表示揃え / 末尾採番 / atomic / defensive filter / reindex / comparator) を流用、 純粋に「manager に D&D 入力手段を追加 + reorder handler を共有 module 化」 のみ。

**Architecture:** T1 で reorder handler を `lib/tags/reorder-handlers.ts` に抽出し popover (`card-tags-section.tsx`) を新 helper 呼出に切替 → T2 で manager `category-list.tsx` に `SortableCategoryRowWrapper` + `DndContext` 配線 → T3 で `option-list.tsx` も同様。 T1 を先に land する根拠 = 「抽出しても popover が回帰しない」 を固めてから manager (T2/T3) を新 helper に乗せる、 抽出のリグレッションと新規配線を分離 (T1 後に popover D&D が壊れたら manager 着手前に切り分け可能)。

**Tech Stack:** Next 15 / React 19 / Tailwind v4 / Dexie + entity_mutations / @dnd-kit (legacy: core 6.3.1 + sortable 10.0.0 + utilities 3.2.2、 4c-2b T3 で land 済を流用)

---

## 全体ルール (各 task 共通、relitigate 不要)

- spec §2 確定済前提を準拠 (4c-2b 完了分の sort_key 経路 / sensors / 母数 / defensive filter の流用)。 `CLAUDE.md` ルール (Stripe / Clerk / AI / commit / review / `[reviewed]` tag) を遵守。
- 各 task の commit tag は task ごとに指定。 feat / fix / refactor 系は `superpowers:requesting-code-review` skill 経由で review → `[reviewed]` 必須。
- **npm dep 追加禁止** (dnd-kit 3 packages は 4c-2b T3 land 済を流用、 新規追加なし)。
- 各 task「完了条件」 を満たさない commit 禁止。 Critical 0 件 + `pnpm test` 全 pass + `pnpm exec tsc --noEmit` エラー 0 が共通最低ライン。
- push しない。 plan を land 後、 subagent dispatch は OT 起動。

## File Structure (touch する file)

新規:
- `lib/tags/reorder-handlers.ts` (T1 = `handleReorderCategories` / `handleReorderOptions` 抽出先)
- `lib/tags/reorder-handlers.test.ts` (T1 = 既存 reorder test 群を移転)

変更:
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (T1 = `handleReorderCategories` / `handleReorderOptions` 削除 + 新 module から re-import、 既存 `useCallback` closure は無変更)
- `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx` (T1 = reorder test ブロックを `reorder-handlers.test.ts` に移転、 残る create / rename / color / delete / toggle test は無変更)
- `app/(app)/app/tags/_components/category-list.tsx` (T2 = `SortableCategoryRowWrapper` + `DndContext` / `SortableContext` / sensors + `handleManagerDragEnd` + `sortableEnabled` 条件 render)
- `app/(app)/app/tags/_components/category-list.test.tsx` (T2 = handle 表示条件 + 既存挙動 regression なし + drag-end dispatch)
- `app/(app)/app/tags/_components/option-list.tsx` (T3 = `SortableOptionRowWrapper` + 同様配線)
- `app/(app)/app/tags/_components/option-list.test.tsx` (T3)

無変更 (touch しない):
- `app/(app)/app/tags/_components/category-row.tsx` / `option-row.tsx` (行 component 本体、 spec §4.2 = 完全無変更で wrapper 外置)
- `app/(app)/app/tags/_components/tag-manager-shell.tsx` (2 mount は既存構造維持、 spec §4.5 = 各 mount に独立 `DndContext`、 shell 自体は touch なし)
- 共有 module 本体 (`lib/tags/sort-comparator.ts` / `next-sort-key.ts` / `reindex-sort-keys.ts`) は 4c-2b land 分のまま流用
- popover 系 file (`card-tag-add-popover.tsx` / `card-tag-option-list.tsx` / `card-tag-edit-popover.tsx`) は 4c-2b 配線分のまま無変更
- server / schema / pull / `lib/cards/` に touch なし (sort_key 経路は 4c-2b で完成済)

---

## Task

### T1: reorder handler を共有 module へ抽出 + popover を新 helper 呼出に切替

**目的:** spec §4.1 を実装。 `card-tags-section.tsx:486-597` の `handleReorderCategories` / `handleReorderOptions` を**そのまま** `lib/tags/reorder-handlers.ts` に移転 (signature / 実装本体 / コメント無変更)、 既存 test を `reorder-handlers.test.ts` に move + popover 側 (`card-tags-section.tsx`) を新 module からの re-import に切替。 抽出のリグレッションを manager 着手前に固める。

**制約:**
- 移転先 `lib/tags/reorder-handlers.ts` の signature は `(existingCategories \| existingOptions, orderedIds [, categoryId]): Promise<void>` を完全維持、 ロジック本体 (defensive filter + `reindexSortKeys` + same-tx atomic + catch silent return + `logger.warn` + tx 外 fire-and-forget flush) も byte-equivalent
- `card-tags-section.tsx` は新 module を `import { handleReorderCategories, handleReorderOptions } from '@/lib/tags/reorder-handlers'` で受け、 既存 `useCallback` で props bind した closure (`reorderCategories` / `reorderOptions`) と popover 配線 (`<CardTagAddPopover onReorderCategories={...} onReorderOptions={...} />`) は**無変更**
- 既存 test の移転は file 物理移動 + import path 書換のみ、 assertion 無変更 (M-A contamination / M-B logger / rollback 3 軸 / no-op / updated_at ISO すべて移転)
- `card-tags-section.test.tsx` の rename / color / delete / create / toggle test 群は**無変更**

**完了条件:**
- 新規 `lib/tags/reorder-handlers.ts` + `lib/tags/reorder-handlers.test.ts` 作成、 `card-tags-section.tsx` から該当関数削除 + import 切替、 `card-tags-section.test.tsx` から reorder ブロック削除
- **popover の既存 D&D 並べ替え動作・test が回帰しない** (抽出のリグレッション無確認)
- `pnpm test lib/tags/reorder-handlers card-tags-section card-tag-add-popover` 全 pass / `pnpm exec tsc --noEmit` エラー 0
- commit message: `refactor(tag): Tag-4c-2c T1 reorder handler を共有 module へ抽出 + popover 切替 [reviewed]`。 refactor (実装ロジック byte-equivalent な file 移動)、 review 経由 + `[reviewed]`。

### T2: `category-list.tsx` に `SortableCategoryRowWrapper` + `DndContext` 配線

**目的:** spec §4.2 + §4.3 + §4.4 を実装。 `category-list.tsx` 内に `SortableCategoryRowWrapper` を追加、 既存 `CategoryRow` 本体は無変更で内側 wrap。 `DndContext` + `SortableContext` + sensors + `handleManagerDragEnd` で T1 抽出済 `handleReorderCategories` を dispatch。 `items.length < 2` で handle 非表示 (素の `<li><CategoryRow .../></li>` で render)。

**制約:**
- 行構造 (spec §4.2): `<li ref={setNodeRef} style={transform/transition/opacity}>` + handle button (`setActivatorNodeRef` + `{...listeners}` + `{...attributes}`、 `touch-none`、 `w-6 h-7`、 lucide `GripVertical`、 aria-label `カテゴリを並べ替え: ${name}`) + 内側 `<CategoryRow {...} />`
- `useSortable` は `SortableCategoryRowWrapper` 内で常に呼ぶ (popover SortableRow と同型)
- sensors (spec §4.3): `useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))`
- `collisionDetection: closestCenter` / `SortableContext.strategy: verticalListSortingStrategy` / `SortableContext.items = list.map(c => c.id)` (full sorted list)
- `sortableEnabled = list.length >= 2` で `<DndContext>...<SortableContext>...wrap render...</SortableContext></DndContext>` ↔ 素の `<ul>` 条件 render を切替
- `handleManagerDragEnd(event, list)`: `active.id === over.id` or `over === null` で no-op 早期 return、 `oldIndex`/`newIndex === -1` の防御 return、 `arrayMove(list, oldIndex, newIndex).map(c => c.id)` を T1 抽出済 `handleReorderCategories(list, orderedIds)` に渡す (void fire-and-forget、 handler 内 catch silent return + logger.warn の挙動を spec §4.1 で固定済)
- `CategoryRow` 本体 (`category-row.tsx`) は**完全無変更**、 既存挙動 (row click による active 切替 / pen icon rename / select_type badge / 削除 button) は wrapper 外置で全て維持

**完了条件:**
- 新規必須 test:
  - (a) `list.length >= 2` で handle button が各 row に表示 (`aria-label = カテゴリを並べ替え:${name}` で count)
  - (b) `list.length < 2` (1 件 / 0 件) で handle 非表示 + `DndContext` mount せず
  - (c) `useSortable` の `listeners` が handle button のみに spread、 内側 `CategoryRow` の row click / pen icon / 削除 button は drag 起動しない (既存挙動 regression なし)
  - (d) drag-end で `handleReorderCategories` mock が `(items, orderedIds)` 引数で 1 回呼ばれる (jsdom 制約で実 pointer drag pin 困難 → handler dispatch contract に分解、 spec §6 方針どおり)
- 既存 `category-list.test.tsx` の delete confirm / create / row click active 切替 test 群が全 pass (regression なし)
- `pnpm test category-list` 全 pass / tsc pass
- commit message: `feat(tag): Tag-4c-2c T2 category-list に SortableCategoryRowWrapper + DndContext 配線 [reviewed]`。 review 経由 + `[reviewed]`。

### T3: `option-list.tsx` に `SortableOptionRowWrapper` + `DndContext` 配線

**目的:** spec §4.2 + §4.3 + §4.4 を `option-list.tsx` に同型で実装。 `SortableOptionRowWrapper` を追加、 既存 `OptionRow` 本体は無変更で内側 wrap。 `handleReorderOptions(items, activeCategoryId, orderedIds)` を dispatch。

**制約:**
- T2 と同型 (`SortableOptionRowWrapper` の中身、 sensors、 collision、 strategy、 `sortableEnabled` 条件 render)
- handle aria-label: `option を並べ替え: ${name}` (spec §4.2 の wrapper aria-label テンプレ、 kind 別)
- `handleManagerDragEnd(event, items)` の中で `handleReorderOptions(items, activeCategoryId, orderedIds)` に渡す (`activeCategoryId` は `OptionList` props 経由)
- `OptionRow` 本体 (`option-row.tsx`) は**完全無変更**、 既存挙動 (color pill / pen icon rename / カテゴリ移動 dropdown / 削除 button) は wrapper 外置で全て維持

**完了条件:**
- 新規必須 test: T2 と同型 (a)/(b)/(c)/(d)
  - (c) で `OptionRow` 独自 UI (color picker popover trigger / カテゴリ移動 dropdown / pen icon / 削除) が drag 起動しないことを pin
  - (d) で `handleReorderOptions` mock が `(items, activeCategoryId, orderedIds)` 3 引数で呼ばれる
- 既存 `option-list.test.tsx` の delete confirm / カテゴリ移動 / 検索 (なし) / 行 button test 群が全 pass
- `pnpm test option-list` 全 pass / tsc pass
- commit message: `feat(tag): Tag-4c-2c T3 option-list に SortableOptionRowWrapper + DndContext 配線 [reviewed]`。 review 経由 + `[reviewed]`。

---

## 論点 (CC が案 + 理由を出して提示)

### F-1. wrapper component 共通化度合い (`SortableCategoryRowWrapper` vs `SortableOptionRowWrapper`)

T2/T3 の wrapper は構造的にほぼ同型 (`<li>` + handle button + 内側 child)。 共通化案を提示:

- **(A) 推奨**: T2/T3 で個別に `SortableCategoryRowWrapper` / `SortableOptionRowWrapper` を各 list file 内に local 定義 (現 spec §4.2 案どおり)。 aria-label の generator (`カテゴリを並べ替え:` vs `option を並べ替え:`) と children の component (`CategoryRow` vs `OptionRow`) が異なるため、 generic 化のメリット薄。 manager 行は category と option で UI 構造が異なる (CategoryRow は select_type badge + 削除 / OptionRow は color pill + カテゴリ移動 + 削除)、 wrapper も別ファイル局所に置くほうが読みやすい。
- (B): generic `SortableManagerRowWrapper<T>` を `lib/tags/sortable-manager-row.tsx` (or `app/(app)/app/tags/_components/`) に共有 component として切り出す。 prop で `id` / `ariaLabel` / `children` を受ける。 重複コードを 1 箇所に集約できるが、 wrapper 本体は 10〜15 行程度の small component で、 generic 化に伴う abstraction cost と manager 専用ゆえ汎用性低、 ROI 弱い。

→ **A 推奨** (個別 local 定義、 同型コード ~15 行の二重定義は許容、 generic 化は YAGNI)

判断: OT 一括判断要 (本 sprint scope では (A) 推奨を採用し、 必要なら land 後に refactor で (B) 化する余地を残す)。

### F-2. T2/T3 の dispatch 順序 (依存なし、 並列か順次か)

T2 / T3 は同型 file の同型編集で、 互いに直接の依存なし。 ただし subagent-driven-development の規律 (1 task = 1 subagent + task 末尾 review、 review pass で次 task dispatch) に従い、 OT 起動で逐次 dispatch する。 並列 dispatch は subagent-driven-development skill が conflicts を避けるため非推奨。

→ T1 → review → T2 → review → T3 → review の逐次フロー (4c-2b と同パターン)。 論点なし、 規律踏襲。

---

## Smoke (本 plan には実行手順記載のみ、 CC 機械 smoke 省略)

4c-2c land 後、 4c-2b 分と合わせて「タグ並べ替えが popover / manager 両画面揃った状態」 で **OT が一括 stg smoke (B 方針)** を実行。 smoke checklist は 一括 smoke 直前に別 file (`docs/superpowers/plans/2026-06-09-tag-4c-smoke-checklist.md` 等) として起こす想定 (4c-2b spec §9 + 本 spec §9 の項目を統合)。

統合 smoke 項目 (spec 4c-2c §9 + 4c-2b §9):
- (a) popover で並べ替え → manager に即反映 / manager で並べ替え → popover に即反映 (双方向同期、 spec 4c-2c §9 (b))
- (b) manager category / option 一覧の D&D + reload 後の並び維持 (spec 4c-2c §9 (a))
- (c) mobile viewport で touch drag 動作 (long-press 起動 / scroll 誤発火なし、 spec 4c-2c §9 (c))
- (d) `items.length < 2` で handle 非表示 (spec 4c-2c §9 (d))
- (e) `CategoryRow` / `OptionRow` 既存挙動 regression なし (active 切替 / rename / 削除 / color / カテゴリ移動 dropdown、 spec 4c-2c §9 (e)/(f))
- (f) mobile breakpoint 下 Tabs 切替中の drag state 持ち越し問題なし (spec 4c-2c §9 (g))
- (g) 4c-2b §9 の popover 固有項目 (Esc 衝突 / scroll clip / mobile long-press) も regression なし (spec 4c-2c §9 (h))

fallback (DragOverlay portal / sensor 値調整) は別 hotfix scope で本 plan に inline しない。

---

## 完了条件 (spec §8 から再掲、 本 plan 全 task land 後)

- `refactor(tag)` (T1) で `lib/tags/reorder-handlers.ts` + `lib/tags/reorder-handlers.test.ts` 新規 + popover 切替を develop に land
- `feat(tag)` (T2, T3) で manager 2 list に `SortableXRowWrapper` + `DndContext` 配線を develop に land、 全 `[reviewed]` tag + Critical 0
- `CategoryRow` / `OptionRow` 本体は無変更
- manager で D&D 並べ替え動作 (mouse + keyboard + touch)、 drag-end で `tag_categories.sort_key` / `tag_options.sort_key` が 0-based 整数で正規化
- popover と manager の並びが双方向で即同期 (同 IDB + `useLiveQuery` subscription)
- `items.length < 2` で handle 非表示
- 既存 manager 挙動 (active 切替 / rename / 削除 confirm / color picker / カテゴリ移動 dropdown / 末尾採番) リグレッションなし
- 既存 popover D&D 配線 (4c-2b 完了分) も regression なし (T1 抽出経路で動作)
- mobile / desktop 2 mount で並べ替え結果が同期表示
- Vitest 全 pass / Playwright smoke 全 pass (一括 smoke は 4c-2b + 4c-2c 統合で OT 実行) / code-reviewer Critical 0 件 / `[reviewed]` tag
- npm dep 追加なし (dnd-kit 既 land 流用)
