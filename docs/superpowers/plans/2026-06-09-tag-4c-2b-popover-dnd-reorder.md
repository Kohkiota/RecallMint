# Tag-4c-2b Implementation Plan (Rev1.1 = spec 006b3f0 反映)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 task 単位で fresh subagent + task 間 review。 inline 一括実行 (`executing-plans`) は OT 明示選択時のみ。
> spec: `docs/superpowers/specs/2026-06-09-tag-4c-2b-popover-dnd-reorder-design.md` (Rev1 commit 006b3f0)
> 旧 plan (Rev0 commit 3b0d8a2) は本 file で完全置換。 task 数 6 → 8 (T1.5 改変 / T2.7 / T7 追加)。

**Goal:** popover stage1/stage2 D&D 並べ替え + `sort_key` reindex + `sortByKeyThenCreated` 数値比較化 + `nextSortKey` 共有化を相 1 で投入、 T3 で dep land、 相 2 で popover UI 配線、 T7 で manager 表示 sort_key 化 + 作成末尾採番化までを 1 sprint で land。 manager D&D 操作のみ Tag-4c-2c に分離。

**Architecture:** 相 1 (T1.5/T2/T2.7) は dnd-kit 非依存の純ロジックを共有 module で land → T3 chore(deps) → 相 2 (T4/T5/T6) で popover に dnd-kit 配線 → T7 で manager に共有 module/helper を適用 (T7 自体は dnd-kit 非依存だが共有 module/helper 依存とレビュー集中のため相 2 末尾)。

**Tech Stack:** Next 15 / React 19 / Tailwind v4 / Dexie + entity_mutations / @dnd-kit (legacy: core 6.3.1 + sortable 10.0.0 + utilities 3.2.2)

---

## 全体ルール (各 task 共通、relitigate 不要)

- spec §2 確定済前提を準拠。 `CLAUDE.md` ルール (Stripe / Clerk / AI / commit / review / `[reviewed]` tag) を遵守。
- 各 task の commit message tag は task ごとに指定。 feat / fix 系は `superpowers:requesting-code-review` skill 経由で review → `[reviewed]` 必須。 chore(deps) / docs は `[no-review]` 可。
- npm dep 追加は **T3 のみ**。 他 task で `pnpm add` 禁止。
- 各 task「完了条件」を満たさない commit 禁止。 Critical 0 件 + `pnpm test` 全 pass + `pnpm exec tsc --noEmit` エラー 0 が共通最低ライン。
- push しない。 plan を land 後、subagent dispatch は OT 起動。

## File Structure (touch する file)

新規:
- `lib/tags/sort-comparator.ts` (T1.5 = 共有 `sortByKeyThenCreated` 数値比較版)
- `lib/tags/sort-comparator.test.ts` (T1.5)
- `lib/tags/reindex-sort-keys.ts` (T2)
- `lib/tags/reindex-sort-keys.test.ts` (T2)
- `lib/tags/next-sort-key.ts` (T2.7 = 共有 `nextSortKey` 末尾採番 helper)
- `lib/tags/next-sort-key.test.ts` (T2.7)

変更:
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (T1.5 = local `sortByKeyThenCreated` 削除 + 新 import / T5 = `DndContext`+`SortableContext` 配線)
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx` (T1.5 = 既存 `describe('sortByKeyThenCreated', …)` ブロックを `sort-comparator.test.ts` へ移転。 popover 側は import path のみ更新)
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` (T1.5 = import path 切替のみ)
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (T4 = handle button + `useSortable` 配線 + `onReorder` prop)
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.test.tsx` (T4)
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (T6 = `handleReorderX` + `tagEditCallbacks` 拡張 + `nextCardSortKey` 利用箇所を `nextSortKey` に置換 = T2.7 で確定)
- `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx` (T6)
- `app/(app)/app/tags/_components/category-list.tsx` (T7 = `sortByCreatedAt` ローカル削除、 共有 `sortByKeyThenCreated` import)
- `app/(app)/app/tags/_components/category-list.test.tsx` (T7 = 並び順 test 更新)
- `app/(app)/app/tags/_components/option-list.tsx` (T7 = 同様、 :43-50 ローカル削除)
- `app/(app)/app/tags/_components/option-list.test.tsx` (T7)
- `app/(app)/app/tags/_components/category-create-form.tsx` (T7 = `sort_key: null` を `nextSortKey(existingSortKeys)` に置換、 親から `existingSortKeys` を受け取る props 拡張)
- `app/(app)/app/tags/_components/category-create-form.test.tsx` (T7)
- `app/(app)/app/tags/_components/option-create-form.tsx` (T7 = `sort_key: null` を置換、 `existingSortKeys` props 拡張、 enqueue patch にも sort_key を含める)
- `app/(app)/app/tags/_components/option-create-form.test.tsx` (T7)
- `package.json` / `pnpm-lock.yaml` (T3 のみ)

無変更 (touch しない):
- `lib/tags/apply-tag-mutation.ts` / `lib/sync/server/entity-mutation-registry.ts` (server 側 sort_key allowlist 完成済、 spec §3)
- `lib/db/schema.ts` / `lib/db/tag-{categories,options}-pull.ts` (sort_key 列既存 + pull 流す、 spec §3)
- `lib/cards/next-card-sort-key.ts` (card 用、 tag 用 `nextSortKey` とは別 helper、 spec §4.7)

---

## 相 1 (dnd-kit 非依存 / dep 追加前)

### T1.5: `sortByKeyThenCreated` を共有 module として新規作成 + 数値比較化 + popover 3 site の import 切替

**目的:** spec §4.6 (含む Rev1 共有抽出) を実装。 旧 plan の「popover ローカルで数値比較化 → 後で抽出」 2 手をやめ、 最初から `lib/tags/sort-comparator.ts` に共有 module を作り popover (`card-tag-add-popover.tsx` + 呼出 site) を import に差替える 1 手で完了させる (drift 窓を作らない)。

**制約:**
- 新規関数本体は spec §4.6 のロジック (Number 変換 + NaN/null 末尾 + tie-break created_at ASC) を 1 箇所のみで定義。
- `card-tag-add-popover.tsx:81-96` のローカル `sortByKeyThenCreated` (export を含む) を削除し、`card-tag-add-popover.tsx:131,144` + `card-tag-edit-popover.tsx:86` + `card-tag-add-popover.test.tsx:13,1114` の 4 import を新 path `@/lib/tags/sort-comparator` に切替。
- 関数 signature (`T extends { sort_key?: string | null; created_at: string }`) は変えない。
- `null` / `undefined` / 非数値文字列はすべて末尾扱い (明示 NaN 化、 `Number(null) === 0` を踏まない)。

**完了条件:**
- 新規 `sort-comparator.test.ts`: spec §4.6 + §6 必須 test (`'0'..'12'` 13 件数値順 / 一方 null / 両 null tiebreak / 同 sort_key tiebreak / 非数値 NaN 末尾 / flicker 防止依存コメント 1 行)。 旧 `card-tag-add-popover.test.tsx` の comparator ブロックは新 file へ完全移転、 重複削除。
- `pnpm test` 全 pass / `pnpm exec tsc --noEmit` エラー 0。 既存 popover 挙動 regression なし。
- commit: `fix(tag): Tag-4c-2b T1.5 sort-comparator 共有 module 抽出 + 数値比較化 [reviewed]`。 review 経由 + `[reviewed]`。 §8 完了条件「comparator 数値順 + 共有 module 抽出」 を満たす。

### T2: `reindexSortKeys` 純関数 + 単体 test 新規

**目的:** spec §4.2 を実装。 `lib/tags/reindex-sort-keys.ts` に純関数を新規追加。 全件 candidate のうち `previousKey !== nextKey` のみ updates に乗せる差分抽出。

**制約:**
- dnd-kit を import しない (相 1 内 = dep ゼロで成立)。
- 引数 = `orderedIds: string[]` + `currentSortKeys: ReadonlyMap<string, string | null | undefined>`、 戻り値 = `{ id: string; sort_key: string }[]`。 同順 drag は空配列。 既存値 (null / 数字 / 混在) に関わらず 0-based 整数で正規化。
- `lib/tags/` 配下 (既存 `apply-tag-mutation.ts` / `color-palette.ts` と同位置)。

**完了条件:**
- 新規 `reindex-sort-keys.test.ts`: 全 null 初回 / 整数化済 1 行 drag (mid-list) / 同順 drag (空 updates) / 既存値混在 (null + 数字) / N=50 stress (`previousKey===nextKey` は updates 除外)。
- `pnpm test` 全 pass / `pnpm exec tsc --noEmit` エラー 0。
- commit: `feat(tag): Tag-4c-2b T2 reindexSortKeys 純関数 [reviewed]`。 review + `[reviewed]`。 §8 完了条件「drag-end で 0-based 整数で正規化」 の基盤。

### T2.7: `nextSortKey` 共有 helper 新規 + card-tags-section の `nextCardSortKey` 置換

**目的:** spec §4.7 を実装。 `lib/tags/next-sort-key.ts` に共有 `nextSortKey(existing: (string | null | undefined)[]): string` を新規追加 (tag 専用、 末尾採番)。 popover の Tag-4c-2a 作成経路 (`card-tags-section.tsx` の `handleCreateCategory` + `handleCreateOptionAndAssign`) が `nextCardSortKey` を呼ぶ 2 箇所を `nextSortKey` に置換し、 tag 用採番 helper を 1 本化。

**制約:**
- spec §4.7 semantics 厳守: 全て数字 → max(Number(v)) + 1 / 全て null/非数値 → `'0'` / 数値 + 非数値混在 → 数値のみで max + 1。 戻り値は常に整数文字列。
- dnd-kit 非依存。 `nextCardSortKey` (card 用) は触らない (別命名 `lib/cards/next-card-sort-key.ts`、 card sort_key 経路は自由度許容のため意味論異なる)。
- `card-tags-section.tsx` の 2 呼出 (`handleCreateCategory` :355 / `handleCreateOptionAndAssign` :416-419) のみ import 差替、 ロジックは変えない。 manager 2 form (`category-create-form.tsx` / `option-create-form.tsx`) は T7 で扱う (本 task では触らない)。

**完了条件:**
- 新規 `next-sort-key.test.ts`: 空集合 (→ `'0'`) / null + undefined のみ (→ `'0'`) / 既存数値列 (例 `['0','1','2']` → `'3'`) / 非数値混在 (例 `['1','abc','3']` → `'4'`、 abc 無視) / 全非数値 (→ `'0'`) / 大値 (例 `['10','2']` → `'11'`、 文字列比較ではなく数値比較で max)。
- `pnpm test card-tags-section` 全 pass (`nextCardSortKey` → `nextSortKey` 置換で既存テスト regression なし)。
- commit: `feat(tag): Tag-4c-2b T2.7 nextSortKey 共有 helper + popover 作成経路置換 [reviewed]`。 review + `[reviewed]`。 §8 完了条件「next-sort-key helper 共有抽出 + popover 作成経路 1 経路」 を満たす。

**相 1 完了 gate:** T1.5 + T2 + T2.7 land 後、 `comparator 数値順 + reindex 差分のみ + nextSortKey 末尾採番` が単独 green。 dep 未追加、 develop は 3 commits ahead で pristine。 OT GO 後に T3 へ進む。

---

## dep 境界

### T3: `chore(deps)` dnd-kit 3 packages 追加

**目的:** spec §2 確定 dep を専用 commit 1 本で land。 以後 amend しない。

**制約:**
- 追加: `@dnd-kit/core@^6.3.1` + `@dnd-kit/sortable@^10.0.0` + `@dnd-kit/utilities@^3.2.2` の 3 packages のみ。 1 回の `pnpm add` で同時追加。
- 2026-06-09 de-risk gate と同じ transitive (`@dnd-kit/accessibility` 1 件) 以内を許容、 増えたら STOP + OT 相談。
- `tsconfig.skipLibCheck: true` 維持。 `.env.example` 変更なし。
- 検証 step: `pnpm install` 再実行で lockfile drift ゼロ確認 + `pnpm exec tsc --noEmit` + `pnpm test` 既存全 pass。

**完了条件:**
- `package.json` に 3 entry / `pnpm-lock.yaml` の dnd-kit 関連 +1 推移以内。 全 test + tsc pass。
- commit: `chore(deps): Tag-4c-2b dnd-kit legacy 3 packages 追加 [no-review]`。 chore(deps) で実装ロジック変更なし → `[no-review]` 可。

---

## 相 2 (dnd-kit 依存 / T3 後 / popover D&D)

### T4: `card-tag-option-list.tsx` 行に handle + `useSortable` 配線

**目的:** spec §4.1 を実装。 各 row に handle button (lucide `GripVertical`) を行頭追加し、 `useSortable({ id })` の `listeners`/`attributes` を **handle button のみ** に spread。 `onReorder` prop が渡された時のみ handle 表示 (`items.length < 2` で非表示)。

**制約:**
- 新 prop: `onReorder?: (orderedIds: string[]) => Promise<void>`。 未指定なら handle 非表示 + 既存挙動。
- 行構造 (spec §4.1 詳細): `<li ref={setNodeRef} style={transform/transition/opacity}>` + handle (`setActivatorNodeRef`+`{...listeners}`+`{...attributes}`、 `touch-none`、 `w-6 h-7`) + 既存 main `<button flex-1 onClick=handleClick>` + 既存任意 kebab。
- handle aria-label = `${kind === 'category' ? 'カテゴリ' : 'option'}を並べ替え: ${option.name}`。
- main button / kebab に `listeners`/`attributes` を spread しない (event 構造分離契約)。
- `touch-none` は handle のみ。 既存 role / aria-checked / Check icon / color pill / break-all は無変更。

**完了条件:**
- 新規必須 test: `onReorder` 有無で handle 切替 / `items.length<2` で非表示 / handle に `listeners` のみ乗り main の onClick が pointerdown で発火しない / 既存 role / aria-label テスト pass。
- `pnpm test card-tag-option-list` 全 pass / tsc pass。
- commit: `feat(tag): Tag-4c-2b T4 option-list 行 handle 配線 [reviewed]`。 review + `[reviewed]`。 §8「popover で D&D 動作 (mouse + keyboard + touch)」 の row 側担当。

### T5: stage1 / stage2 別 `DndContext` + sensors + DragEnd ハンドラ

**目的:** spec §4.4 + §4.5 を実装。 `card-tag-add-popover.tsx` の stage1 / stage2 内側にそれぞれ別 `DndContext` を mount + sensors + `arrayMove` → `onReorder` を配線。

**制約:**
- sensors: `useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 5 } })` + `useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })`。 spec §4.4 厳守 (値変更は §9 smoke の hotfix scope)。
- `collisionDetection: closestCenter` / `strategy: verticalListSortingStrategy`。
- `onDragEnd`: `event.active.id` / `event.over.id` から `arrayMove` で新順序生成、 `onReorder(orderedIds)` を await。 `active.id === over.id` or `over === null` は no-op 早期 return。
- 編集 stage (editCategory / editOption / createCategoryType) には `DndContext` を mount しない (spec §1 out of scope)。 popover 他挙動無変更。

**完了条件:**
- 既存 `card-tag-add-popover.test.tsx` の Esc / stage 遷移 / combobox / 新規作成 / kebab test 群が全 pass。
- T4 と組み合わせ stage1 / stage2 で `arrayMove → onReorder` が動く (統合実機確認は §9 smoke で OT)。
- `pnpm test card-tag-add-popover` 全 pass / tsc pass。
- commit: `feat(tag): Tag-4c-2b T5 popover stage 別 DndContext + sensors [reviewed]`。 review + `[reviewed]`。

### T6: `CardTagsSection` に reorder handlers + `tagEditCallbacks` 拡張

**目的:** spec §4.3 を実装。 `card-tags-section.tsx` に `handleReorderCategories(orderedIds)` / `handleReorderOptions(categoryId, orderedIds)` を `handleToggle` と同じ same-tx atomic で配線。 `tagEditCallbacks` 型に `reorderCategories` / `reorderOptions` を追加し popover に渡す。

**制約:**
- tx 構造: `db.transaction('rw', db.tag_categories | db.tag_options, db.entity_mutations, async () => { ... })`。 内側で `reindexSortKeys` (T2) を呼んで差分のみ抽出 → 差分件数分 mirror update + 差分件数分 `enqueueEntityMutation({ entity_type, op: 'update_field', patch: { field: 'sort_key', value } })`。
- `updates.length === 0` で tx 自体 skip (no-op)。 mirror update は partial (`{ sort_key, updated_at: nowIso }` のみ、 他列触らない)。
- 失敗時 Dexie auto-rollback、 catch silent return (案 a 取り直し、 reference = `handleToggle:628-632`)。 flush は tx 外 fire-and-forget (reference = `handleToggle:635`)。
- `tagEditCallbacks` 型 (`card-tags-section.tsx:494-513`) に `reorderCategories: (orderedIds: string[]) => Promise<void>` + `reorderOptions: (categoryId: string, orderedIds: string[]) => Promise<void>` を追加。 T5 の popover はこれらを `onReorder` prop 経由で呼ぶ。

**完了条件:**
- 新規必須 test (P-2 A 案: `card-tags-section.test.tsx:1325` `:1647` パターン踏襲):
  - (a) mirror update + enqueue が `mockTransaction` 内で順序通り実行 / 差分件数だけ呼ばれる
  - (b) `enqueueEntityMutation.mockRejectedValueOnce(new Error('boom'))` で tx throw 伝播 → handler catch で silent return → `mockRunGuardedEntityMutationFlush` not called
  - (c) `updates.length === 0` (= 同順 drag) で `mockTransaction` 自体が呼ばれない
  - (d) mirror update 引数に `updated_at: <ISO>` が含まれる
- 既存 `handleToggle` / `handleCreate*` / `handleRename*` / `handleSetXColor` / `handleDelete*` test 群が全 pass。
- `pnpm test card-tags-section` 全 pass / tsc pass。
- commit: `feat(tag): Tag-4c-2b T6 reorder handlers + tagEditCallbacks 拡張 [reviewed]`。 review + `[reviewed]`。

---

## manager 適用 (相 2 末尾 / dnd-kit 非依存だが共有 module/helper 依存ゆえこの順序)

### T7: manager (/app/tags) の sort_key 化 + 末尾採番化 (D&D 操作は載せない = Tag-4c-2c 送り)

**目的:** spec §4.7 (manager 側) + §4.8 を実装。 manager category 一覧 / option 一覧の comparator を共有 `sortByKeyThenCreated` (T1.5) に差替 + 2 create form を共有 `nextSortKey` (T2.7) で末尾採番化。 manager に D&D 入力は載せない (Tag-4c-2c 範疇)。

**注記:** T7 自体は dnd-kit を import しない。 相 2 末尾に置くのは T1.5/T2.7 の共有 module/helper への依存とレビュー集中のためで、 dnd-kit 利用が理由ではない。

**制約:**
- 一覧 (`category-list.tsx:42-50` ローカル `sortByCreatedAt` / `option-list.tsx:43-50` 同型) を削除し、 `useLiveQuery` の `.sort(...)` を共有 `sortByKeyThenCreated` (T1.5 import) に差替。 in-memory sort 構造は維持。
- create form (`category-create-form.tsx:61` `sort_key: null` / `option-create-form.tsx:70` 同型) を `nextSortKey(existingSortKeys)` (T2.7 import) に置換。 親 (`category-list.tsx` / `option-list.tsx`) で `useLiveQuery` から `existingSortKeys: (string | null | undefined)[]` を props に渡す。
- `option-create-form.tsx:82-93` の `enqueueEntityMutation` の `patch` に `sort_key: <採番値>` を追加 (現状 patch に sort_key を含めず server で null になっている経路を、 client 採番値で揃える)。 `category-create-form.tsx` の `enqueue` でも同様 (mirror put と patch の両方に値を入れる、 spec §4.7「null 混在を新規に作らない」)。
- manager に **D&D 入力なし** (Tag-4c-2c 範疇)。 既存の create / delete / rename / color 等の挙動 regression なし。
- Tag-4e 参照 comment (`category-list.tsx:42` / `category-create-form.tsx:15-16` / `option-list.tsx:43` / `option-create-form.tsx`) を **Tag-4c-2c 参照に書換** (spec §5 Rev1 で Tag-4e 消滅明記)。

**完了条件:**
- 新規必須 test:
  - (a) `category-list.test.tsx` / `option-list.test.tsx`: 共有 `sortByKeyThenCreated` で並び順が数値順 (例 `'0','1','10','12'` を `0,1,10,12` 順、 旧 string 比較なら `0,1,10,12` 偶然成立だが `'0','1','2','10'` で差が出るケースを test)。
  - (b) `category-create-form.test.tsx` / `option-create-form.test.tsx`: 末尾採番が `nextSortKey(existingSortKeys)` の値で mirror put + enqueue patch に書き込まれる。
  - (c) 既存 manager test 群全体が pass (削除 / rename / color / delete confirm 等)。
- `pnpm test` 全 pass / tsc pass。
- commit: `feat(tag): Tag-4c-2b T7 manager sort_key 化 + 末尾採番化 (D&D は Tag-4c-2c) [reviewed]`。 review + `[reviewed]`。 §8「manager 表示 sort_key / 末尾採番 / D&D は持たない」 完了。

---

## 論点 (OT 確定済、 relitigate しない)

| ID | 確定 | 内容 |
|---|---|---|
| P-1 | **A** | task = subagent 粒度 (T1.5 / T2 / T2.7 / T3 / T4 / T5 / T6 / T7 = 計 8 subagent + task 間 review)。 既存 Tag-4c-2a plan の task=subagent 粒度実績と整合 |
| P-2 | **A** | rollback test 方式 = 既存 `card-tags-section.test.tsx:1325` `:1647` の `handleCreate*` rollback test ブロック (mockTransaction + `enqueueEntityMutation.mockRejectedValueOnce` で tx throw 伝播、 `flush not called` + `handler silent return` の 2 軸で契約表現) を T6 で踏襲。 fake-indexeddb / 別 fixture は採用しない |
| D-6 (spec) | **A** | transport = 許容案。 op='reindex' 新設はしない。 spec §4.9 + §7 D-6 確定済、 本 plan は実装層なので transport 変更 task は含めない |

---

## Smoke (本 plan には実行手順記載のみ、 CC 機械 smoke 省略)

spec §9 (a) KeyboardSensor Esc 衝突 / (b) in-place transform scroll 容器 clip / (c) モバイル long-press は popover 固有で OT が stg 手動 UX smoke 実行。 fallback (DragOverlay portal / delay-tolerance 調整) は別 hotfix scope で本 plan に inline しない。

**追加 (Rev1)**: manager 観点 = OT 画面遷移で目視確認 1 項目を smoke checklist に追加:
- popover で並べ替え → manager (/app/tags) 表示が同順に即反映 (IDB useLiveQuery 経由) + manager で新規作成した category/option が一覧末尾に出る (`nextSortKey` 末尾採番) + manager に D&D ハンドル / drag-cursor が出ていない (Tag-4c-2c 範疇、 本 sprint では UI なし)。

smoke checklist は本 plan 完了後に別 file (`docs/superpowers/plans/2026-06-09-tag-4c-2b-smoke-checklist.md`) を OT 依頼時に起こす想定 (既存 `*-smoke-checklist.md` パターン踏襲)。

---

## 完了条件 (spec §8 Rev1 から再掲)

- `chore(deps)` (T3) で dnd-kit 3 packages を develop に land 済
- `docs(tag)` (spec Rev1 006b3f0 + 本 plan + 旧 plan 3b0d8a2 の置換 = 計 3 docs commits) を develop に land 済
- `fix(tag)` T1.5 + `feat(tag)` T2 / T2.7 / T4 / T5 / T6 / T7 を develop に land、 全て `[reviewed]` tag + Critical 0
- comparator + next-sort-key helper が共有 module `@/lib/tags/sort-comparator` / `@/lib/tags/next-sort-key` に抽出され、 popover / manager / card-tags-section の全 import が 1 経路に集約 (T1.5 / T2.7 / T7)
- popover stage1 / stage2 で D&D 並べ替え動作 (mouse + keyboard + touch)
- drag-end で `tag_categories.sort_key` / `tag_options.sort_key` が 0-based 整数で正規化
- `sortByKeyThenCreated` が数値比較化され、 N≥10 で表示が数値順
- manager (/app/tags) の category 一覧 + option 一覧が共有 comparator で表示、 popover と同じ並びを共有 (IDB 経由で楽観 mirror update が即反映)
- manager 作成フォーム 2 本が共有 `nextSortKey` で末尾採番、 新規作成での null 混在を作らない
- 並べ替え後 reload で popover/manager 再表示時に並び順保持
- 別端末 (or pull 再取得) で同じ並び順を受信
- 既存 popover / manager 全挙動 (combobox / 新規作成 / kebab / 編集 stage / Esc / 幅 / break-all / delete confirm / color) リグレッションなし
- manager は D&D 操作を持たない (Tag-4c-2c 範疇)
- Vitest 全 pass / Playwright smoke 全 pass (smoke 項目は §9 + 上記 Rev1 追加で OT 実行)
