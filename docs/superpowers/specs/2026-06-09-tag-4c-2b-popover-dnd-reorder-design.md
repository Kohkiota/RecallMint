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
- **manager (/app/tags) 表示順を sort_key ベースに変更** (Rev1: 旧 D-5 反転、§4.8)。 popover と同じ
  IDB の同じ `sort_key` を共有 `sortByKeyThenCreated` で読む。
- **manager 作成フォームの末尾採番化** (Rev1: §4.7)。 `category-create-form.tsx` /
  `option-create-form.tsx` の現行 `sort_key: null` を共有 next-sort-key helper で末尾採番に統一、
  popover 作成と同じ規約に。 null 混在を新規作成では作らない (既存 null は §4.2 reindex で順次正規化)。
- comparator (sortByKeyThenCreated) と next-sort-key helper を **共有 module 化**し popover/manager
  両方が import (§4.6, §4.7)。

Out of scope:
- **manager 側の D&D 並べ替え操作 UI** (Rev1: 後続 sprint **Tag-4c-2c** に切り出し、§5)。
  本 sprint 完了時点で「popover で並べ替え → manager に反映」「どこで作っても末尾」 は完成、
  逆向き「manager で並べ替え操作 → popover に反映」 は Tag-4c-2c で manager に D&D 入力を足せば
  同 sort_key 共有で自動成立する。
- card body 上のバッジ並び (Tag-4b-fix で `category.name ja-localeCompare → option.name ja-localeCompare` 固定)
- popover 編集 stage 内 (editCategory / editOption / createCategoryType) の D&D
- fractional indexing / collaborative reorder (タグ件数小、整数 reindex で十分)
- **Tag-4e は本 Rev1 で実質消滅** (manager sort_key 化が前倒しされ、残るのは manager D&D = Tag-4c-2c のみ)

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
| manager 据置 ~~(旧)~~ → **Rev1**: manager 表示 sort_key 化 + 作成末尾採番 を **本 sprint in scope**。 manager D&D 操作のみ Tag-4c-2c に切り出し | `/app/tags` の現状は created_at ASC 固定 (`category-list.tsx:42` のローカル `sortByCreatedAt` / `category-create-form.tsx:15-16,51,61` で `sort_key: null` 採番)、 OT 確定で本 sprint に取り込み (§4.7/§4.8、 旧 §7 D-5 反転) |
| dnd-kit feasibility | 2026-06-09 de-risk gate で install / tsc / hydration クリーン (`Cannot find namespace 'JSX'` / `cannot be used as a JSX component` 発生せず、warning 0 + errors 0) | 採用 GO 済 |
| 表示 comparator | popover 全 stage の最終ソートは `sortByKeyThenCreated` 1 関数 (`card-tag-add-popover.tsx:81-96`、stage1 :131 / stage2 :144 / 編集 popover `card-tag-edit-popover.tsx:86` の計 3 箇所が import)。比較は line 88 で `ak < bk ? -1 : 1` の**素の string `<` (lexicographic)** | **潜在バグ**: Tag-4c-2a の `nextCardSortKey()` は `'1','2',…,'10','11',…` 採番 ⇒ N≥10 で `'10' < '2'` (先頭文字比較) になり 1,10,11,…,19,2,20,… の誤順。本 sprint の reindex (`'0'..'N-1'`) は N≥10 で確実に露出させるため、本 spec 内で **数値比較化を確定**して同梱する (別 sprint に逃がさない、§4.6)。 Rev1 で **共有 module 化** (§4.6 拡張) し popover / manager 両方が 1 関数を import |
| V-1 transport 束ね方 | `flushAllPendingEntityMutations` (`lib/sync/entity-mutations.ts:243-322` 「全 pending entity mutations を 1 回の bulk POST で送信する」) + bulk endpoint の `payloadSchema.mutations: z.array(...).max(1000)` (`app/api/entity-mutations/bulk/route.ts:57-60`) | reindex N 件は **1 POST で 1 往復**、上限 1000 件 (N≦数十なら余裕)。 batch サイズ上限による分割は本 sprint 想定範囲内では発生せず |
| V-2 server tx 構造 | `bulk/route.ts:184-205` で `for (const mutation of mutations) { processMutation(...) }` の **逐次 for loop**、`processMutation` 内の `db.transaction(async (tx) => {...})` (`:74`) は mutation ごとに張る → **N 個の独立 per-mutation tx** | **bulk 全体 1 tx ではない**。 reindex N 件は同 bulk POST で送られるが server は per-mutation で apply、 結果は `applied++` / `failed[]` (`:181-205`) で個別集計され `200 { ok:true, applied, failed }` で返す |
| V-3 部分適用窓 | V-2 から導出: k+1 件目で failed (orphan / owner mismatch / patch zod NG) が起きた場合、 server には 0..k 件が新値、 k+1.. は旧値で残る。 client outbox は failed 分が pending 残置 → 次 flush で再送 → 最終整合する。 但し中間状態で別端末 pull が走ると一時的に不完全並びを受信し得る | `applyTagCategoryUpdate` / `applyTagOptionUpdate` (`lib/tags/apply-tag-mutation.ts:67,218`) の `sort_key` 経路は `typeof value !== 'string' \|\| value === null` 以外の failed 条件を持たず、 reindex で生成する `String(i)` は常に valid。 ⇒ 実運用での per-mutation failed 確率は極小、 但しゼロではない (例: 並走で category 自体が削除された race)。 詳細は §4.9 transport analysis |
| V-4 client atomic | `handleReorderX` の Dexie `db.transaction('rw', db.tag_X, db.entity_mutations, …)` は all-or-nothing で IDB は壊れない (前 §4.3) | OT 理解どおり: 問題は server 部分適用窓のみ、 client (IDB) は同 tx atomic で保護 |
| V-5 manager read 経路 | `app/(app)/app/tags/page.tsx:1-12` は server shell (auth は `(app)/layout.tsx` で済)、 `tag-manager-shell.tsx:1` `'use client'` + `category-list.tsx:59-62` の `useLiveQuery(async () => db.tag_categories.toArray(), [])` で **IDB から read** | popover の楽観 mirror update (T6 `handleReorderX` の Dexie tx) は **manager に即反映** (同 IDB を subscribe、 別 URL でも 0 ラグ)。 flush 前の他端末は別 pull cycle まで旧値を見るが、 これは spec §4.3 既存挙動 (entity-mutations 経路全般) と同じ |

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

> **全件前提 (Rev1.3 confirmed、 T5 実装で確認)**: `reindexSortKeys` は呼出側から
> **常に当該 list 全件** (filtered subset ではない) を受け取る前提で動作する。
> filtered subset を渡すと隠れた行の sort_key と新値が衝突して全体順序が壊れるため、
> §4.5 の「filter 中は D&D 無効」 とペアで成立する不変条件。 Tag-4c-2c で manager
> 経路から呼ぶ場合の踏襲方針は §4.5 末尾の Rev1.3 不変条件記述を参照
> (filter / SortableContext.items の扱いと一括で記述)。

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

> **不変条件 (Rev1.3、 T5 実装で confirmed)**: combobox filter non-empty 中は D&D を
> 無効化する (handle 非表示)。 SortableContext.items は **filter 状態に関わらず full
> sorted list の id 列** を渡し、 filtered subset を渡さない。 実装は `CardTagOptionList`
> に `dndEnabled?: boolean` prop を新設し、 popover 親が `dndEnabled={filterText 空}`
> を渡して handle 表示の最終 gate を `isSortable && dndEnabled` の AND で取る。
> DndContext / SortableContext は親 stage の中で常時 mount し (filter 中も維持)、
> input の filterText / focus が remount で吹き飛ぶ UX 退行を避ける構造で「filter 中は
> drag 起動しない」 を保証する。 後続 Tag-4c-2c で manager に D&D を載せる際も、 manager
> に filter があれば同じ判断 (filter 中は handle 非表示 / SortableContext.items は全件)
> を踏襲する。

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
// 数値比較版 sort_key comparator (Tag-4c-2b §4.6、 Rev1.2 で空文字明示 case 追加)
// 順序キー:
//   1. Number(sort_key) 数値昇順 (NaN/null/undefined/空文字は末尾扱い)
//   2. 同位は created_at ASC (string 比較で ISO 8601 lexicographic = 時系列順、現行踏襲)
export function sortByKeyThenCreated<T extends { sort_key?: string | null; created_at: string }>(
  a: T,
  b: T,
): number {
  // Number(null) === 0 を踏まない明示 NaN 化。 Number('') も 0 ではなく NaN にしたいが
  // JS は Number('') === 0 のため、 空文字列は別途末尾扱いにする (Rev1.2)。
  const an =
    a.sort_key === null || a.sort_key === undefined || a.sort_key === ''
      ? NaN
      : Number(a.sort_key)
  const bn =
    b.sort_key === null || b.sort_key === undefined || b.sort_key === ''
      ? NaN
      : Number(b.sort_key)
  const aValid = !Number.isNaN(an)
  const bValid = !Number.isNaN(bn)
  if (aValid && bValid) {
    if (an !== bn) return an < bn ? -1 : 1
  } else if (aValid) {
    return -1 // a は数値、 b は NaN/null/空文字 → a 先 (NULLS LAST)
  } else if (bValid) {
    return 1
  }
  // 両方 NaN/null/undefined/空文字 or 同 sort_key: created_at ASC
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}
```

要点 (Rev1.2 修正):
- `Number(' 1 ')` は `1` (trim 不要)、`Number('abc')` は `NaN` (`is_number?` 判定不要)。
- **`Number('')` は `0`** (`NaN` ではない、 旧版誤記述)。 空文字も末尾化したいので **明示 case 分岐** で NaN に倒す (Rev1.2 で実装も spec も一致させた)。
- `null` / `undefined` も明示 NaN 化 (`Number(null) === 0` を踏まない)。
- 空文字 `''` / `null` / `undefined` / 非数値文字列はすべて NaN 化して**末尾**配置 (現行の "NULLS LAST" 意味論を保持)。
- 同位 tiebreak は `created_at` の string 比較 (現行と同じ、ISO 8601 lexicographic = 時系列)。
- ジェネリック型 / `T extends { sort_key?: string | null; created_at: string }` は現行のまま (`ClientTagCategory` / `ClientTagOption` 両対応)。

#### 影響範囲

`sortByKeyThenCreated` は popover 3 箇所 (`card-tag-add-popover.tsx:131,144` / `card-tag-edit-popover.tsx:86`)
が import している。**呼出 site は無変更**、関数本体差替えのみで全箇所が数値比較に切替わる。

#### Rev1: 共有 module 化 (manager との 1 関数共有)

manager 表示順を sort_key 化する Rev1 (§4.8) で **同一 comparator を popover/manager 両方が import**
する必要がある。 二重定義による drift を避けるため、 `sortByKeyThenCreated` を新規 module
`lib/tags/sort-comparator.ts` に**抽出**し、 関数本体は §4.6 上記の数値比較版 1 つに統一する。

抽出後の import path:
- `card-tag-add-popover.tsx:131,144` → 旧 `from './card-tag-add-popover'` を **新 `from '@/lib/tags/sort-comparator'`** に変更 (関数を popover ファイル内から削除)
- `card-tag-edit-popover.tsx:86` → 同じく新 import path
- `card-tag-add-popover.test.tsx:13,1114` の既存 import / describe ブロックも新 path へ移動 (test 内容は§6 拡張に集約)
- 新規 manager 側 (§4.8) も同じ `@/lib/tags/sort-comparator` を import

`card-tag-add-popover.tsx` 内の export `sortByKeyThenCreated` は削除して新 module 経由のみとする
(import 経路 1 本に絞り drift gate を強める)。

#### useLiveQuery 順序 vs drag arrayMove 順序の一貫性 (flicker 防止)

drag drop 直後の流れ:
1. `arrayMove` で新順序を構築 → `handleReorderX` で `'0','1',…,'N-1'` を mirror 書込
2. useLiveQuery が Dexie subscribe 経由で再 emit → popover が re-render
3. re-render 時に `sortByKeyThenCreated` (数値比較) で再ソート → `'0','1',…,'N-1'` の数値順 = arrayMove と一致 → **flicker なし**

旧 string 比較のままだと、N≥10 で arrayMove 順と再ソート順が不一致 (例: arrayMove で 0..11 を作っても再ソートが `0,1,10,11,2,…` で並べる) になり、drop 直後に並びがガクっと入れ替わる flicker が起きる。本 §4.6 修正で防止する。

### §4.7 next-sort-key helper の共有化 + manager 作成フォーム末尾採番化 (Rev1)

#### 背景

現状 manager の `category-create-form.tsx:61` / `option-create-form.tsx:70` は `sort_key: null` で作成、
popover Tag-4c-2a は `nextCardSortKey()` で `'1','2',…` を採番 (`card-tags-section.tsx` の
`handleCreateCategory` / `handleCreateOptionAndAssign`)。 経路により null と数字が混在する。

Rev1 で manager 表示順を sort_key ベースに揃えるなら、 **どこで作っても新規 sort_key を一律
末尾採番** にし null 混在を新規に作らない方が semantics が綺麗 (既存 null は §4.2 reindex で
順次 0-based 整数に正規化される)。

#### 修正内容

新規 module `lib/tags/next-sort-key.ts` を作成し、 共有 `nextSortKey(existing: (string | null | undefined)[]): string` を export:

```ts
// 既存 sort_key 群から末尾採番した整数文字列を返す。
// - 全て数字 (NaN 化されない) → max(Number(v)) + 1 を返す (整数文字列、 0 起点でなく既存 +1)
// - 全て null/undefined/非数値 → '0' を返す (0-based の起点)
// - 数字 + 非数値混在 → 数値のみで max + 1
// reindexSortKeys (§4.2) と semantic が一貫: 末尾追加 → 並び末尾、 reindex 後の値域とも整合
export function nextSortKey(existing: (string | null | undefined)[]): string
```

`nextCardSortKey` (`lib/cards/next-card-sort-key.ts:13`) との関係:
- 既存 `nextCardSortKey` は card 用 (string 採番、 自由度を許容する fallback あり)。 tag 用 sort_key
  は本 sprint 以降 0-based 整数文字列で運用するため意味論が異なる ⇒ tag 専用に別 helper を切る。
- card の sort_key は別命名 (`next-card-sort-key.ts`)、 触らない。

#### 影響範囲

- `app/(app)/app/tags/_components/category-create-form.tsx:61` の `sort_key: null` を
  `sort_key: nextSortKey(existingCategories.map(c => c.sort_key))` に置換。
- `app/(app)/app/tags/_components/option-create-form.tsx:70` の `sort_key: null` を同様に置換
  (`existingOptions` は当該 category 内のみ filter)。
- `card-tags-section.tsx` の `handleCreateCategory` / `handleCreateOptionAndAssign` は現状
  `nextCardSortKey()` 利用 → 新 `nextSortKey` に置換 (tag 用採番 helper を 1 本化)。
- `.env.example` 変更なし。

### §4.8 manager 一覧の共有 comparator 適用 (Rev1)

#### 背景 + 修正内容

manager 一覧 `category-list.tsx:42-50` `sortByCreatedAt` ローカル関数 / `option-list.tsx:43`
同型 (推定) を、共有 `sortByKeyThenCreated` (§4.6 抽出版) に差し替える。 IDB read (`useLiveQuery`)
の結果に対し in-memory sort を適用する構造は維持、 comparator のみ差替。

```ts
// category-list.tsx の現状 (推定):
//   const categories = useLiveQuery(async () => {
//     const all = await getClientDb().tag_categories.toArray()
//     return all.slice().sort(sortByCreatedAt)  // ← これを sortByKeyThenCreated に置換
//   }, [])
```

option-list.tsx も同じ in-memory sort を持つ前提 (Step 0 で同 file の `sortByCreatedAt` 行を確認、
構造は category-list と同型)。 両ファイルでローカル `sortByCreatedAt` 関数自体を削除し、
共有 `sortByKeyThenCreated` import に置換する。

#### 結果

- 同 user の同 IDB を popover と manager が同 comparator で読む → 「どちらで並べ替えても両画面が
  同じ並びを共有」 が成立 (V-5 IDB 即反映 + V-4 client atomic と組合せ)。
- manager 側に D&D 入力はまだ持たない (Tag-4c-2c)、 read だけ揃える。

### §4.9 transport analysis (V-1〜V-4 結果に基づく)

#### 構造

V-1〜V-4 結果 (§3 表):
- client outbox: 1 POST に全 pending を束ねる (`flushAllPendingEntityMutations`)
- payload 上限: 1000 件 (`payloadSchema.mutations.max(1000)`)
- server: **per-mutation tx** (`for (const mutation of mutations) { db.transaction(...) }`)
- 結果集計: `applied` count + `failed[]` を `200 { ok, applied, failed }` で返却
- client: `failed[]` は pending 残置、 次 flush で再送
- reindex N 件は 1 往復で送れるが、 server で k+1 件目で何か failed すると **0..k のみ反映 + k+1.. 旧値** の部分適用窓が一時的に生じる

#### 失敗確率の実評価

`applyTagCategoryUpdate` (`apply-tag-mutation.ts:67,89-95`) / `applyTagOptionUpdate` (`:218,259-265`)
の `sort_key` 経路:
- patch.value が `null` or `string` 以外 → `failed` (reindex は常に `String(i)` を送るため hit せず)
- owner-scope SELECT 失敗 → `failed` (orphan = category/option が並走で削除された場合のみ)

⇒ **実運用での per-mutation failed 確率は極小**。 並走削除 race のみで、 1 端末ユーザでの自発的
reindex 中は発生し得ない。

#### CC 推奨 = 許容案 (詳細は §7 D-6)

per-mutation 失敗確率の極小性 + reindex の冪等性 (次 drag で `reindexSortKeys` が全件 candidate
にして残り差分が必ず再送される) + comparator が NULLS LAST + 数値順で「server に届いた分は新値、
旧値は末尾」 の表示 fallback が成立する性質から、 **本 sprint では transport 補強なしで許容**。

代替案 (op='reindex' 専用 op を server registry に追加 / 1 bulk tx で全件 apply / 順序 token 化) は
いずれも server work 大 + 既存 entity_mutations 意味論変更 + 監査 log 構造変更が伴い ROI が低い。
判断は §7 D-6 で論点化。

> **番兵注記** (Rev1.1 OT 確定): 本 §4.9 の許容は「順序は一時不整合でも収束すればよい」 性質に
> 依存する。 将来 sort_key 群に原子性が要る要件 (厳密連番制約 / 順序の即時一貫性 SLA / collaborative
> reorder 等) が出たら D-6 を再評価する。 本 sprint の実装は増やさず、 要件が来た時点で別 sprint
> として op='reindex' or 順序 token 等の transport 強化案を起こす。

## §5 非目標 / 据置

- ~~manager (`/app/tags`) の並び基準は created_at ASC のまま~~ → **Rev1 で取り消し**:
  manager の表示順は §4.8 で共有 `sortByKeyThenCreated` (数値比較) に切替、 作成末尾採番は §4.7
  で共有 helper に統一する。 本 sprint 後 popover/manager の並びは IDB 経由で完全に揃う。
- **manager 側の D&D 並べ替え操作 UI** = 後続 sprint **Tag-4c-2c** に切り出し (別 spec)。
  本 sprint では manager は「sort_key を読んで表示 + 末尾採番で作成」 までで、 D&D 入力は持たない。
  Tag-4c-2c で manager に D&D を足せば同 sort_key を共有するため「manager で並べ替え → popover に
  反映」 も自動成立する。
- **Tag-4e は本 Rev1 で実質消滅** (manager sort_key 化が前倒しされ、 残るのは manager D&D = Tag-4c-2c
  のみ)。 Tag-4e と参照する既存 comment (`category-list.tsx:42` / `category-create-form.tsx:15` /
  `option-list.tsx:43` / `option-create-form.tsx`) は §4.7/§4.8 編集と同時に Tag-4c-2c へ参照書換。
- card body バッジ並び: Tag-4b-fix の `category.name → option.name` ja-localeCompare 固定を維持。
- popover 編集 stage (editCategory / editOption / createCategoryType): 並べ替え対象外。
- entity_mutations の coalesce 拡張: 既存 `entity_type:entity_id:update_field:field` で十分。
- transport 補強 (op='reindex' / 1 bulk tx / 順序 token 化): §4.9 + §7 D-6 で許容案 (現状維持) を推奨。
  許容判断のため新 op / schema 変更は本 sprint scope 外 (将来必要時に別 sprint)。

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
| D-5 | ~~A~~ → **Rev1 反転** | OT 判断で**反転**: manager 表示順を sort_key ベースに揃え、 作成も末尾採番に統一 (§4.7/§4.8)。 旧 D-5 A 「乖離を許容 + Tag-4e で吸収」 は破棄。 Tag-4e は本 Rev1 で消滅 (残るのは manager D&D = Tag-4c-2c)。 本 sprint で manager は read + 作成のみ揃え、 D&D 操作は Tag-4c-2c |
| D-6 (Rev1) | **A 推奨 / OT 判断要** | **transport: 部分適用許容 vs 強化**。 (A) 現状の per-mutation tx を維持し reindex の部分適用窓 (server 0..k 反映 + k+1.. 旧値) を許容。 根拠 = §4.9: per-mutation failed 確率極小 (sort_key apply は値型検査のみ、 並走削除 race のみ hit) + reindex 冪等性 (次 drag で全件再 candidate) + comparator 数値順 + NULLS LAST で部分適用中の表示も致命破綻しない。 (B) `op='reindex'` 等の新 op を registry に追加し N 件の sort_key を 1 server tx で apply。 server work 大 + 既存 entity_mutations 監査 log 意味論変更 + patch zod / apply 関数の signature 拡張、 ROI 低い → **A を推奨** |

## §8 完了条件

- `chore(deps)` で dnd-kit 3 packages を develop に land 済
- `docs(spec)` で本 spec を land 済
- `feat(tag)` (= 別 plan で作る) を land 済、以下を満たす:
  - popover stage1 / stage2 で D&D 並べ替え動作 (mouse + keyboard + touch)
  - drag-end で `tag_categories.sort_key` / `tag_options.sort_key` が 0-based 整数で正規化
  - `sortByKeyThenCreated` が数値比較化され、N≥10 のとき表示が数値順 (§4.6)
  - comparator + next-sort-key helper が共有 module `@/lib/tags/sort-comparator` / `@/lib/tags/next-sort-key` に抽出され、 popover / manager / card-tags-section の全 import が 1 経路に集約 (§4.6/§4.7)
  - manager (/app/tags) の category 一覧 + option 一覧が **共有 `sortByKeyThenCreated` で表示** (§4.8)、 popover と同じ並びを共有 (IDB 経由で楽観 mirror update が即反映)
  - manager 作成フォーム (`category-create-form.tsx` / `option-create-form.tsx`) が **共有 `nextSortKey` で末尾採番**、 新規作成での null 混在を作らない (§4.7)
  - 並べ替え後 reload して popover/manager 再表示時に並び順保持
  - 別端末 (or pull 再取得) で同じ並び順を受信
  - 既存 popover 全挙動 (combobox / 新規作成 / kebab / 編集 stage / Esc / 幅 / break-all) リグレッションなし
  - manager は **D&D 操作を持たない** (Tag-4c-2c 範疇、 read + 作成のみ揃える)
  - Vitest 全 pass / Playwright smoke 全 pass / code-reviewer Critical 0 件 / `[reviewed]` tag

## §9 Smoke 確認項目 (本 sprint 末、OT が stg で実行)

本 spec の実装後、stg 上で OT に以下を確認依頼する (Claude Code 側は DevTools MCP で再現困難 / 不可な項目を抜粋、CLAUDE.md §Smoke 確認 担当境界に準拠)。

- **(a) KeyboardSensor Esc と popover Esc 階層の衝突**: drag 中の Esc で dnd-kit 標準の drag cancel が走り、続けて popover の `onEscapeKeyDown` ハンドラ (`card-tag-add-popover.tsx:241-265` の stage 階層 Esc) が同 keydown で発火するか/しないか。期待: drag cancel は dnd-kit 内部で `event.preventDefault()` 相当が走り popover の Esc 階層は発火しない (= drag 中の Esc は「drag を取り消す」 のみ、stage 戻りは発火しない)。**もし衝突 (drag cancel 後に stage が 1 段戻る) が発生**したら、`DndContext` のラッパに `onKeyDown` で `event.stopPropagation()` を入れる修正を別 hotfix で land。

- **(b) in-place transform の scroll 容器 clip**: stage2 で option を 15–20 件作って drag、最終行を上方向に長距離 drag したとき、popover の `PopoverContent` (Radix の scroll 容器、`max-w-sm` 縦は内容次第) の端で行が clip / cut off するか。`overflow: hidden` 系の Radix default が in-place transform を切る挙動を持つ場合に発生。期待: clip しない (Radix popover の `data-side` 系 layout は通常 overflow visible)。**もし clip が確認された**ら、本 sprint の §4.5 構造は維持しつつ、§7 D-2 fallback として **`DragOverlay` を `PopoverContent` 内の portal target (`PopoverPortal` 子 or `document.body` 経由) に切替**える。fallback は別 hotfix scope (本 spec の §4.5 に inline 実装は混ぜない)。

- **(c) モバイル long-press 起動 + scroll 誤発火**: DevTools mobile view + 実機 (OT が任意で) で `activationConstraint: { delay: 250, tolerance: 5 }` の効きを確認。tap が drag に化けない / リスト全体の縦 scroll が drag に化けない / handle long-press で drag 起動。**問題発生時**は `delay` を 300–400 に上げる or `tolerance` を 8 に上げる調整を別 hotfix で land。

(a)/(b)/(c) いずれも fallback 実装を本 spec に inline せず、smoke で再現したら個別 hotfix sprint で対処する方針 (over-engineer 回避、本 sprint は in-place + delay=250/tol=5 で land)。
