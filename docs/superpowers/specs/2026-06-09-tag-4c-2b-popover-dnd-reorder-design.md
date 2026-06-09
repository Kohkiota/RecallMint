# Tag-4c-2b: タグ popover D&D 並べ替え + sort_key reindex — 設計

date: 2026-06-09 / topic: Tag-4c-2b popover D&D reorder / phase: design

## §1 目的 / scope

`CardTagAddPopover` の 2 つの選択 stage を D&D で並べ替え可能にし、`tag_categories.sort_key` /
`tag_options.sort_key` を書き換えて並び順を永続化する。現状の `sort_key` は作成時の末尾採番のみで、
ユーザーは手動順序を入れられない。

In scope:
- stage1 (category 一覧 = `CardTagOptionList kind='category'`) の手動並べ替え
- stage2 (選択 category 配下の option 一覧 = `CardTagOptionList kind='option'`) の手動並べ替え
- `tag_categories.sort_key` / `tag_options.sort_key` の sparse-aware reindex (整数文字列、0-based)
- 既存 popover 全挙動の維持 (combobox / 新規作成 / kebab / 編集 stage / Esc 階層 /
  single 最大 1 個 / 案 a 取り直し / whole-set / 幅 `min-w-56 max-w-sm` / `break-all`)

Out of scope:
- manager (/app/tags) の並び替え UI / 並び基準切替 (Tag-4e 責務、§7 D-5 で明示)
- card body 上のバッジ並び (Tag-4b-fix で `category.name ja-localeCompare → option.name ja-localeCompare` 固定)
- popover 編集 stage 内 (editCategory / editOption / createCategoryType) の D&D
- fractional indexing / collaborative reorder (タグ件数小、整数 reindex で十分)

## §2 確定済 前提 (relitigate しない)

- 採用 dep (de-risk gate 完了 / 2026-06-09 turn 2 で OT GO 済、3 packages):
  - `@dnd-kit/core@^6.3.1`
  - `@dnd-kit/sortable@^10.0.0`
  - `@dnd-kit/utilities@^3.2.2` (公式 idiom `CSS.Transform.toString()` 用、直接 dep として lock)
- dep 追加方式: 専用 `chore(deps)` commit 1 本を独立 land、以後 amend しない (初の npm dep、
  監査軸 1 commit に集約)。commit 順序 = `chore(deps)` → `docs(spec+plan)` → `feat`。
- `tsconfig.skipLibCheck: true` 維持 (gate で型 OK 確認、shim 不要)。
- 採番方式: **整数 reindex** (drag-end ごとに該当 list 全件を `'0','1',…,'N-1'` で振り直し)。
- ハンドル方式: 行頭の専用 button (lucide `GripVertical`) にのみ `useSortable` の
  `listeners`/`attributes` を spread。クリック付与・kebab・× と event 構造分離。
- タッチ: `PointerSensor` の `activationConstraint: { delay: 250, tolerance: 5 }` で
  scroll/click 誤発火を抑制。`KeyboardSensor` も既定で乗せ a11y を確保。
- optimistic: `mirror update + entity_mutations enqueue` を 1 Dexie rw tx に閉じ atomic 化、
  失敗時 Dexie auto-rollback、flush は tx 外 fire-and-forget。
  reference 実装 = `card-tags-section.tsx` (commit 327a385) の `handleToggle`。
- 並べ替え対象は popover 内のみ、manager 側は据置。
- npm dep は dnd-kit 3 packages 以外追加しない。

## §3 Step 0 調査結果サマリ (red flag なし)

| 観点 | 確認内容 | 結論 |
|---|---|---|
| schema | `tag_categories.sort_key text` / `tag_options.sort_key text` nullable、`updatedAt.$onUpdate` で auto-打刻 (`lib/db/schema.ts:678,711,685,718`) | sort_key 書込で `updated_at` 動く → pull 増分で別端末伝播 OK |
| server apply | `applyTagCategoryUpdate` / `applyTagOptionUpdate` の field allowlist に `sort_key` 既に入り (`lib/tags/apply-tag-mutation.ts:60,89-95,211,259-265`) | **新規 server work 不要** |
| registry zod | `tag_category` / `tag_option` の `update_field` patch zod = `z.enum([…,'sort_key',…])` (`lib/sync/server/entity-mutation-registry.ts:188,236`) | **新規 server work 不要** |
| pull | `getCategoriesDelta` / `getOptionsDelta` の `toClientTagX` が `sort_key` を含む全列を client へ流す (`lib/db/tag-categories-pull.ts:20-31`, `tag-options-pull.ts:19-30`) | sort_key 変更を 1 端末で反映 → 他端末 pull で受信 OK |
| client outbox | `enqueueEntityMutation` coalesce key = `entity_type:entity_id:update_field:field` (`lib/sync/entity-mutations.ts:48-56`) | reindex で N 件発火 → 別 entity_id ゆえ N 行独立、coalesce 影響なし |
| 既存 reference | `card-tags-section.tsx` の `handleToggle` (`db.transaction('rw', db.card_tags, db.entity_mutations, …)` 内で mirror put + `enqueueEntityMutation`、tx 外で `void runGuardedEntityMutationFlush()`) | そのまま流用、tx に `db.tag_categories` or `db.tag_options` を含めて N 件 update + N 件 enqueue |
| 既存値分布 | manager 経由 create = `sort_key: null` (`/app/tags/_components/category-create-form.tsx:61`, `option-create-form.tsx:70`)、popover Tag-4c-2a 経由 create = `nextCardSortKey()` で `'1','2',…` 採番 (`card-tags-section.tsx` の `handleCreateCategory`) | **混在 (null + 数字)** → reindex 初回挙動で全列を 0-based 整数文字列に正規化 |
| 行 layout | `<li flex items-center>` 子 = main `<button flex-1>` + 任意 kebab `<button ml-auto h-7 w-7>` (`card-tag-option-list.tsx:207-281`) | 行頭に handle button (~24px) 追加で破綻なし、`min-w-56 max-w-sm` (224〜384px) に収まる |
| manager 据置 | `/app/tags` は created_at ASC 固定、`sort_key UI は Tag-4e` (`category-list.tsx:42` / `category-create-form.tsx:15`) | 本 sprint で manager に触れない、Tag-4e で揃える前提 (§7 D-5) |
| dnd-kit feasibility | 2026-06-09 de-risk gate で install / tsc / hydration クリーン (`Cannot find namespace 'JSX'` / `cannot be used as a JSX component` 発生せず、warning 0 + errors 0) | 採用 GO 済 |
| 表示 comparator | popover 全 stage の最終ソートは `sortByKeyThenCreated` 1 関数 (`card-tag-add-popover.tsx:81-96`、stage1 :131 / stage2 :144 / 編集 popover `card-tag-edit-popover.tsx:86` の計 3 箇所が import)。比較は line 88 で `ak < bk ? -1 : 1` の**素の string `<` (lexicographic)** | **潜在バグ**: Tag-4c-2a の `nextCardSortKey()` は `'1','2',…,'10','11',…` 採番 ⇒ N≥10 で `'10' < '2'` (先頭文字比較) になり 1,10,11,…,19,2,20,… の誤順。本 sprint の reindex (`'0'..'N-1'`) は N≥10 で確実に露出させるため、本 spec 内で **数値比較化を確定**して同梱する (別 sprint に逃がさない、§4.6) |

## §4 設計

### §4.1 行 layout / handle 追加方式

`card-tag-option-list.tsx` の row JSX を以下に拡張する (kind=`category`/`option` 両方に乗る):

```
<li className="flex items-center">
  {/* NEW: handle button — listeners/attributes はここだけ */}
  <button
    type="button"
    ref={setActivatorNodeRef}
    {...listeners}
    {...attributes}
    aria-label={`${kind === 'category' ? 'カテゴリ' : 'option'}を並べ替え: ${option.name}`}
    className="inline-flex h-7 w-6 cursor-grab items-center justify-center touch-none text-slate-400 hover:text-slate-600"
    tabIndex={0}
  >
    <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
  </button>
  <button type="button" role={role} … onClick={handleClick} className="flex flex-1 …">
    … (現行 main button: select_type icon / color pill / Check icon)
  </button>
  {onRowAction && <button … kebab …>…</button>}
</li>
```

- `useSortable({ id })` から `{attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging}` を取得
- `setNodeRef` は **`<li>` 自身**に当て、行全体を sortable target にする (drag-over / collision detection 用)
- `setActivatorNodeRef` + `listeners` + `attributes` は **handle button のみ**に当て、main/kebab を drag から完全分離 (click 付与・kebab・既存挙動と event 構造分離)
- `touch-none` (Tailwind = `touch-action: none`) は handle button にのみ付与し、main は通常 touch (scroll / tap) のまま
- `<li>` の style = `{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }` (in-place transform、§7 D-2)
- handle 幅 24px (`w-6`) 増分で popover 幅は `224〜384px` に収まる (gate 検証済の `min-w-56 max-w-sm` 範囲)

`CardTagOptionList` に新 prop を追加して可否を切替:
```ts
type Props = {
  …既存…
  /** D&D 並べ替えを有効化。drag-end で sortable id 列を返す。 */
  onReorder?: (orderedIds: string[]) => Promise<void>
}
```
- `onReorder` が渡されると handle 表示 + `DndContext`+`SortableContext` で row を包む
- 渡されないと既存挙動 (handle 非表示、`DndContext` も mount しない、Tag-4c-2a-fix-4 までの動作)

### §4.2 reindex algorithm

drag-end で発火する純粋関数を新規 module で export (Vitest unit test 容易性):

`lib/tags/reindex-sort-keys.ts` (新規):
```ts
/**
 * sortable list を新順序で並べ替えた結果、sort_key を更新すべき entity の差分を返す。
 *
 * 全件を `'0','1',…,'N-1'` (0-based 整数文字列) で正規化する。
 * 既存 sort_key の値分布 (null + 旧数字混在) を一掃するため、現状値とは無関係に
 * 当該 list 全件を新キーで上書き候補とし、`previousKey !== nextKey` の entity のみ updates に
 * 含めて返す (no-op 抑止 = 不要な enqueue を避ける)。
 */
export function reindexSortKeys(
  orderedIds: string[],
  currentSortKeys: ReadonlyMap<string, string | null | undefined>,
): { id: string; sort_key: string }[] {
  const updates: { id: string; sort_key: string }[] = []
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i]!
    const next = String(i)
    const prev = currentSortKeys.get(id) ?? null
    if (prev !== next) updates.push({ id, sort_key: next })
  }
  return updates
}
```

性質:
- 初回 drag (全件 null/混在) → 全件が updates に乗り、当該 list の sort_key 列が正規化される
- 2 回目以降 (整数文字列化済) → drag した行とその間に居る行のみ updates に乗る (N=10 で 1 行移動なら通常 2–5 件)
- 同順 drag (同位置で離す) → updates 空 → 副作用ゼロ
- N が大きくても tag は user あたり数十が想定上限、Dexie tx 内で十分軽い

### §4.3 mirror 更新 + entity_mutations 経路

`card-tag-add-popover.tsx` の親 `CardTagsSection` に `handleReorderCategories` /
`handleReorderOptions` を追加し、`tagEditCallbacks` に乗せて popover へ渡す。実装は
`card-tags-section.tsx` の `handleToggle` と同じ atomic pattern:

```ts
async function handleReorderCategories(orderedIds: string[]) {
  const currentMap = new Map(categories.map((c) => [c.id, c.sort_key]))
  const updates = reindexSortKeys(orderedIds, currentMap)
  if (updates.length === 0) return
  const db = getClientDb()
  const nowIso = new Date().toISOString()
  try {
    await db.transaction('rw', db.tag_categories, db.entity_mutations, async () => {
      for (const { id, sort_key } of updates) {
        await db.tag_categories.update(id, { sort_key, updated_at: nowIso })
        await enqueueEntityMutation({
          entity_type: 'tag_category',
          entity_id: id,
          op: 'update_field',
          patch: { field: 'sort_key', value: sort_key },
        })
      }
    })
  } catch {
    // Dexie auto-rollback。 案 a 取り直し: 次回 pull が server 値で reconcile。
    return
  }
  void runGuardedEntityMutationFlush().catch(() => {})
}
```

`handleReorderOptions(categoryId, orderedIds)` も同形 (tx は `db.tag_options` + `db.entity_mutations`、
`entity_type: 'tag_option'`)。`userId` prop は category list には乗らない (sort_key 書込は user 列を
触らない) ので、`handleToggle` のような `user_id` 注入は不要 (mirror update は `sort_key`/`updated_at`
列のみ書く)。

### §4.4 sensors + a11y

`DndContext` の `sensors` 配列:
```ts
const sensors = useSensors(
  useSensor(PointerSensor, {
    activationConstraint: { delay: 250, tolerance: 5 },
  }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
)
```
- `PointerSensor` で mouse + touch を共通処理 (legacy 6.x の推奨パターン)
- `delay: 250` でモバイル long-press 起動、`tolerance: 5` で scroll/tap 誤発火抑制
- `KeyboardSensor` でキーボード並べ替え (Space で grab、矢印で移動、Space で confirm、Esc で cancel)

`closestCenter` を `collisionDetection` に使用 (vertical list の標準)。

### §4.5 DndContext / SortableContext 構造

stage1 / stage2 で **別 DndContext** を mount (§7 D-1 推奨案):

```
{stage === 'category' && (
  <DndContext sensors={…} collisionDetection={closestCenter}
    onDragEnd={(e) => handleStage1DragEnd(e, sortedCategories, handleReorderCategories)}>
    <SortableContext items={sortedCategories.map(c => c.id)} strategy={verticalListSortingStrategy}>
      <CardTagOptionList kind="category" options={sortedCategories} onReorder={handleReorderCategories} … />
    </SortableContext>
  </DndContext>
)}
{stage === 'option' && (
  <DndContext … onDragEnd={(e) => handleStage2DragEnd(e, categoryOptions, (ids) => handleReorderOptions(selectedCategory.id, ids))}>
    <SortableContext items={categoryOptions.map(o => o.id)} strategy={verticalListSortingStrategy}>
      <CardTagOptionList kind="option" options={categoryOptions} onReorder={(ids) => handleReorderOptions(selectedCategory.id, ids)} … />
    </SortableContext>
  </DndContext>
)}
```

`handleStage1DragEnd` / `handleStage2DragEnd` は `event.active.id`/`event.over.id` から `arrayMove`
で新順序を生成し `onReorder(orderedIds)` を await 発火。

### §4.6 `sortByKeyThenCreated` の数値比較化 (correctness fix、本 sprint 同梱)

#### 背景

`reindexSortKeys` は `String(i)` を書き、`sort_key` 列は TEXT のため値は `'0','1',…,'N-1'` の数字文字列。
読む側の現行 comparator は `card-tag-add-popover.tsx:88` で `ak < bk ? -1 : 1` の素の string `<` 比較で、
N≥10 のとき `'10' < '2'` (先頭文字比較) によって `0,1,10,11,…,19,2,20,…` の誤順になる。これは Tag-4c-2a
の `nextCardSortKey()` 採番 (`'1','2',…`) でも既に発生しうる潜在バグで、本 sprint で reindex を入れた
途端に確実に露出する (1 category に option 10+ は普通に起きる) ため、本 spec 内で同梱して塞ぐ。

#### 修正内容

`card-tag-add-popover.tsx:81-96` の `sortByKeyThenCreated` を以下の比較ロジックに置換:

```ts
// 数値比較版 sort_key comparator (Tag-4c-2b §4.6)
// 順序キー:
//   1. Number(sort_key) 数値昇順 (NaN/null/undefined は末尾扱い)
//   2. 同位は created_at ASC (string 比較で ISO 8601 lexicographic = 時系列順、現行踏襲)
export function sortByKeyThenCreated<T extends { sort_key?: string | null; created_at: string }>(
  a: T,
  b: T,
): number {
  const an = a.sort_key === null || a.sort_key === undefined ? NaN : Number(a.sort_key)
  const bn = b.sort_key === null || b.sort_key === undefined ? NaN : Number(b.sort_key)
  const aValid = !Number.isNaN(an)
  const bValid = !Number.isNaN(bn)
  if (aValid && bValid) {
    if (an !== bn) return an < bn ? -1 : 1
  } else if (aValid) {
    return -1 // a は数値、 b は NaN/null → a 先 (NaN/null 末尾)
  } else if (bValid) {
    return 1
  }
  // 両方 NaN/null/undefined or 同 sort_key: created_at ASC
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}
```

要点:
- `Number('')` は `0` ではなく `NaN`、`Number(' 1 ')` は `1` (trim 不要)、`Number('abc')` は `NaN` (`is_number?` 判定不要)。
- `null` / `undefined` は明示 NaN 化 (`Number(null) === 0` を踏まない)。
- NaN/null/undefined は**末尾**配置 (現行の "NULLS LAST" 意味論を保持)。
- 同位 tiebreak は `created_at` の string 比較 (現行と同じ、ISO 8601 lexicographic = 時系列)。
- ジェネリック型 / `T extends { sort_key?: string | null; created_at: string }` は現行のまま (`ClientTagCategory` / `ClientTagOption` 両対応)。

#### 影響範囲

`sortByKeyThenCreated` は popover 3 箇所 (`card-tag-add-popover.tsx:131,144` / `card-tag-edit-popover.tsx:86`)
が import している。**呼出 site は無変更**、関数本体差替えのみで全箇所が数値比較に切替わる。

#### useLiveQuery 順序 vs drag arrayMove 順序の一貫性 (flicker 防止)

drag drop 直後の流れ:
1. `arrayMove` で新順序を構築 → `handleReorderX` で `'0','1',…,'N-1'` を mirror 書込
2. useLiveQuery が Dexie subscribe 経由で再 emit → popover が re-render
3. re-render 時に `sortByKeyThenCreated` (数値比較) で再ソート → `'0','1',…,'N-1'` の数値順 = arrayMove と一致 → **flicker なし**

旧 string 比較のままだと、N≥10 で arrayMove 順と再ソート順が不一致 (例: arrayMove で 0..11 を作っても再ソートが `0,1,10,11,2,…` で並べる) になり、drop 直後に並びがガクっと入れ替わる flicker が起きる。本 §4.6 修正で防止する。

## §5 非目標 / 据置

- manager (`/app/tags`): 並び基準は created_at ASC のまま、UI 並べ替えは Tag-4e で実装。本 sprint 後
  「popover は sort_key ベース / manager は created_at ベース」 の乖離が発生するが、Tag-4e で manager 側を
  揃えて吸収する (§7 D-5 で明示許容)。
- card body バッジ並び: Tag-4b-fix の `category.name → option.name` ja-localeCompare 固定を維持。
- popover 編集 stage (editCategory / editOption / createCategoryType): 並べ替え対象外。
- entity_mutations の coalesce 拡張: 既存 `entity_type:entity_id:update_field:field` で十分。

## §6 テスト方針

- Unit (Vitest):
  - `reindex-sort-keys.test.ts`: 全 null 初回 / 整数化済 1 行 drag / 同順 drag (空 updates) / N=50 stress
  - `card-tag-add-popover.test.tsx` の `sortByKeyThenCreated` ブロック (既存 `describe('sortByKeyThenCreated', …)`) を拡張:
    - **新規必須テスト**: `sort_key` が `'0'..'12'` の 13 件入力で数値順 (0,1,2,…,12) に並ぶ
    - 既存ケース (sort_key 一方 null / 両 null tiebreak / 同 sort_key tiebreak) は引き続き pass
    - `'abc'` 等の非数値 sort_key (defensive) は NaN 末尾扱いで pass
    - drop 後の useLiveQuery 再ソート順が `arrayMove` 順と一致する不変条件はこの comparator に依存する旨を test コメントに明記
  - `card-tags-section.test.tsx`: `handleReorderCategories` / `handleReorderOptions` の tx atomic
    (mirror put + enqueue 同 tx、enqueue throw で mirror rollback、`updated_at` 打刻)
  - `card-tag-option-list.test.tsx`: `onReorder` prop 有 / 無で handle 表示切替、handle に
    `{...listeners}` のみ乗ること (main の onClick が drag で発火しない)、role / aria-label 既存維持
- E2E (Playwright MCP):
  - stg smoke で popover stage1 / stage2 の D&D + reload 後の並び維持
  - mobile viewport (DevTools mobile view) で touch drag の動作確認 (long-press 起動 / scroll 誤発火なし)
  - 本格的な動作確認は OT が stg で実行 (CLAUDE.md §Smoke 確認 担当境界)
- 実 API 禁止 / モック必須 (CLAUDE.md §AI §8)。

## §7 論点 (OT 確定済 / 2026-06-09)

各論点は OT 一括判断で確定 (全 5 件 CC 推奨どおり)。以下は確定内容の記録、本 spec 採用判断には再協議不要。

| ID | 確定 | 内容 |
|---|---|---|
| D-1 | **A** | stage1 / stage2 で別 `DndContext` を mount (条件 render で別 mount/dispose)。既存 `{stage === 'category' && …}` / `{stage === 'option' && …}` 構造に同居、stage 切替で context が dispose され active drag state の持ち越し問題なし |
| D-2 | **A** | in-place transform (`CSS.Transform.toString(transform)` を `<li>` style に当てる)。`DragOverlay` の portal 描画は Radix Popover の focus trap / scroll 容器 clip と干渉余地。問題発生時の fallback は §9-(b) に注記 |
| D-3 | **(a)+(b)+(c)** | (a) `items.length < 2` で handle 非表示 (`onReorder` を渡さない or 内部 early return)。(b) drag-end ごとに**当該 list 全件**を 0-based 整数で正規化 (§4.2 `reindexSortKeys`)、`updates.length === 0` で tx 自体 skip。(c) candidate は当該 list 全件、`previousKey !== nextKey` のみ updates に乗せ enqueue 不要発火を避ける |
| D-4 | **A** | drag-end 1 回ごとに同期発火 (`void runGuardedEntityMutationFlush().catch(() => {})`)。連続 drag は outbox coalesce key `entity_type:entity_id:update_field:sort_key` で同 entity の最新値のみ pending に残る → server に最新 1 件しか届かない、debounce 不要 |
| D-5 | **A** | popover (sort_key ベース) と manager (created_at ベース) の並び基準乖離を一時許容、Tag-4e で manager 側を sort_key ベースに揃えて吸収 (manager comment `sort_key UI は Tag-4e で導入` と整合) |

## §8 完了条件

- `chore(deps)` で dnd-kit 3 packages を develop に land 済
- `docs(spec)` で本 spec を land 済
- `feat(tag)` (= 別 plan で作る) を land 済、以下を満たす:
  - popover stage1 / stage2 で D&D 並べ替え動作 (mouse + keyboard + touch)
  - drag-end で `tag_categories.sort_key` / `tag_options.sort_key` が 0-based 整数で正規化
  - `sortByKeyThenCreated` が数値比較化され、N≥10 のとき表示が数値順 (§4.6)
  - 並べ替え後 reload して popover 再表示時に並び順保持
  - 別端末 (or pull 再取得) で同じ並び順を受信
  - 既存 popover 全挙動 (combobox / 新規作成 / kebab / 編集 stage / Esc / 幅 / break-all) リグレッションなし
  - manager (/app/tags) 触らず created_at ASC のまま
  - Vitest 全 pass / Playwright smoke 全 pass / code-reviewer Critical 0 件 / `[reviewed]` tag

## §9 Smoke 確認項目 (本 sprint 末、OT が stg で実行)

本 spec の実装後、stg 上で OT に以下を確認依頼する (Claude Code 側は DevTools MCP で再現困難 / 不可な項目を抜粋、CLAUDE.md §Smoke 確認 担当境界に準拠)。

- **(a) KeyboardSensor Esc と popover Esc 階層の衝突**: drag 中の Esc で dnd-kit 標準の drag cancel が走り、続けて popover の `onEscapeKeyDown` ハンドラ (`card-tag-add-popover.tsx:241-265` の stage 階層 Esc) が同 keydown で発火するか/しないか。期待: drag cancel は dnd-kit 内部で `event.preventDefault()` 相当が走り popover の Esc 階層は発火しない (= drag 中の Esc は「drag を取り消す」 のみ、stage 戻りは発火しない)。**もし衝突 (drag cancel 後に stage が 1 段戻る) が発生**したら、`DndContext` のラッパに `onKeyDown` で `event.stopPropagation()` を入れる修正を別 hotfix で land。

- **(b) in-place transform の scroll 容器 clip**: stage2 で option を 15–20 件作って drag、最終行を上方向に長距離 drag したとき、popover の `PopoverContent` (Radix の scroll 容器、`max-w-sm` 縦は内容次第) の端で行が clip / cut off するか。`overflow: hidden` 系の Radix default が in-place transform を切る挙動を持つ場合に発生。期待: clip しない (Radix popover の `data-side` 系 layout は通常 overflow visible)。**もし clip が確認された**ら、本 sprint の §4.5 構造は維持しつつ、§7 D-2 fallback として **`DragOverlay` を `PopoverContent` 内の portal target (`PopoverPortal` 子 or `document.body` 経由) に切替**える。fallback は別 hotfix scope (本 spec の §4.5 に inline 実装は混ぜない)。

- **(c) モバイル long-press 起動 + scroll 誤発火**: DevTools mobile view + 実機 (OT が任意で) で `activationConstraint: { delay: 250, tolerance: 5 }` の効きを確認。tap が drag に化けない / リスト全体の縦 scroll が drag に化けない / handle long-press で drag 起動。**問題発生時**は `delay` を 300–400 に上げる or `tolerance` を 8 に上げる調整を別 hotfix で land。

(a)/(b)/(c) いずれも fallback 実装を本 spec に inline せず、smoke で再現したら個別 hotfix sprint で対処する方針 (over-engineer 回避、本 sprint は in-place + delay=250/tol=5 で land)。
