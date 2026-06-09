# Tag-4c-2b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 task 単位で fresh subagent + task 間 review。 inline 一括実行 (`executing-plans`) は OT 明示選択時のみ。
> spec: `docs/superpowers/specs/2026-06-09-tag-4c-2b-popover-dnd-reorder-design.md` (commit d15191b)

**Goal:** popover stage1/stage2 を D&D 並べ替え可能化 + `sort_key` reindex + `sortByKeyThenCreated` 数値比較化を、dep 追加なしの相 1 と dep 追加後の相 2 に分けて投入する。

**Architecture:** 相 1 (T1/T2) は dnd-kit import ゼロの純ロジック → T3 で `chore(deps)` dep land → 相 2 (T4/T5/T6) で UI 配線。reindex (T2 純関数) が露出させる comparator バグを相 1 内 (T1) で先に塞ぐ並び順。

**Tech Stack:** Next 15 / React 19 / Tailwind v4 / Dexie + entity_mutations / @dnd-kit (legacy: core 6.3.1 + sortable 10.0.0 + utilities 3.2.2)

---

## 全体ルール (各 task 共通、relitigate 不要)

- spec §2 確定済前提を準拠 (整数 reindex / handle 専用 button / `PointerSensor` delay 250/tol 5 / atomic same-tx)。`CLAUDE.md` ルール (Stripe / Clerk / AI / commit / review / `[reviewed]` tag) を遵守。
- 各 task の commit message tag は task ごとに指定。 feat / fix 系は `superpowers:requesting-code-review` skill 経由で review → `[reviewed]` 必須。 chore(deps) / docs は `[no-review]` 可。
- npm dep 追加は **T3 のみ**。 他 task で `pnpm add` 禁止。
- 各 task 末尾「完了条件」を満たさない commit 禁止。 Critical 0 件 + `pnpm test` 全 pass + `pnpm exec tsc --noEmit` エラー 0 が共通最低ライン。
- push しない。 plan を land 後、subagent dispatch は OT 起動。

## File Structure (touch する file)

新規:
- `lib/tags/reindex-sort-keys.ts` (T2)
- `lib/tags/reindex-sort-keys.test.ts` (T2)

変更:
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (T1 = comparator 本体 / T5 = `DndContext`+`SortableContext` 配線)
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx` (T1 = comparator test 拡張)
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (T4 = handle button + `useSortable` 配線 + `onReorder` prop)
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.test.tsx` (T4 = handle 表示切替 / listeners only / role 維持)
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (T6 = `handleReorderCategories` / `handleReorderOptions` + `tagEditCallbacks` 拡張)
- `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx` (T6 = reorder handler atomic tx test)
- `package.json` / `pnpm-lock.yaml` (T3 のみ)

無変更 (touch しない):
- `lib/tags/apply-tag-mutation.ts` / `lib/sync/server/entity-mutation-registry.ts` (server 側 sort_key allowlist 完成済、§3 確認済)
- `lib/db/schema.ts` / `lib/db/tag-{categories,options}-pull.ts` (sort_key 列既存 + pull 既に流す、§3 確認済)
- `app/(app)/app/tags/**` (manager 据置、§5)
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` (`sortByKeyThenCreated` を import するだけ、T1 関数差替で挙動切替済)

---

## 相 1 (dnd-kit 非依存 / dep 追加前)

### T1: `sortByKeyThenCreated` 数値比較化 (correctness fix、本 sprint 同梱)

**目的:** spec §4.6 を実装。 `card-tag-add-popover.tsx:81-96` の comparator を `Number(sort_key)` 数値比較へ本体差替する。 reindex (T2) が `'0'..'N-1'` を書く前に、N≥10 で `'10'<'2'` になる潜在バグを塞ぐ。

**制約:**
- 関数 signature は変えない (`T extends { sort_key?: string | null; created_at: string }` のまま)。 呼出 3 site (`card-tag-add-popover.tsx:131,144` / `card-tag-edit-popover.tsx:86`) は無変更。
- `null` / `undefined` / 非数値文字列 (例 `'abc'`) はすべて末尾扱い (NaN化)。 `Number(null) === 0` を踏まない明示 NaN 化。
- tie-break = `created_at` ASC (現行踏襲、ISO 8601 lexicographic = 時系列)。
- 既存 `sortByKeyThenCreated` テスト (sort_key 一方 null / 両 null tiebreak / 同 sort_key tiebreak) は引き続き pass。

**完了条件:**
- 新規必須 test: `'0'..'12'` 13 件入力で数値順 (0,1,2,…,12) に並ぶ。 非数値 (`'abc'`) は NaN 末尾扱い。 flicker 防止依存コメントを test ブロックに 1 行記載。
- `pnpm test card-tag-add-popover` 全 pass / `pnpm exec tsc --noEmit` エラー 0。
- commit message: `fix(tag): Tag-4c-2b T1 sortByKeyThenCreated 数値比較化 [reviewed]`。 fix(*) → `superpowers:requesting-code-review` 経由 review → Critical 0 + `[reviewed]`。

### T2: `reindexSortKeys` 純関数 + 単体 test 新規

**目的:** spec §4.2 を実装。 `lib/tags/reindex-sort-keys.ts` に純関数 `reindexSortKeys(orderedIds, currentSortKeys) → { id, sort_key }[]` を新規追加。 全件を `'0','1',…,'N-1'` で正規化候補とし、 `previousKey !== nextKey` のみ updates に乗せる。

**制約:**
- 関数本体は dnd-kit を import しない (相 1 内 = dep ゼロで成立)。
- 引数: `orderedIds: string[]` + `currentSortKeys: ReadonlyMap<string, string | null | undefined>`。 戻り値: `{ id: string; sort_key: string }[]`。
- 同順 drag (no-op) のとき空配列返却。 既存値 (null / 数字 / 混在) に関わらず 0-based 整数で正規化する設計。
- `lib/tags/` 配下に置く (既存 `apply-tag-mutation.ts` / `color-palette.ts` と同位置、命名規則踏襲)。

**完了条件:**
- 新規 test (`reindex-sort-keys.test.ts`): 全 null 初回 / 整数化済 1 行 drag (mid-list) / 同順 drag (空 updates) / 既存値混在 (null + 数字) / N=50 stress (全件 candidate のうち previousKey===nextKey は updates 除外)。
- `pnpm test reindex-sort-keys` 全 pass / `pnpm exec tsc --noEmit` エラー 0。
- commit message: `feat(tag): Tag-4c-2b T2 reindexSortKeys 純関数 [reviewed]`。 review 経由 + `[reviewed]`。

**相 1 完了 gate:** T1 + T2 land 後、`comparator 数値順 + reindex 差分のみ` が単独 green。 dep 未追加で develop は pristine + 2 commits 追加状態。 OT が GO したら T3 へ進む。

---

## dep 境界

### T3: `chore(deps)` dnd-kit 3 packages 追加

**目的:** spec §2 確定 dep を専用 commit 1 本で land。 以後 amend しない (初の npm dep ゆえ監査軸 1 commit に集約)。

**制約:**
- 追加: `@dnd-kit/core@^6.3.1` + `@dnd-kit/sortable@^10.0.0` + `@dnd-kit/utilities@^3.2.2` の **3 packages のみ**。 他 dep 追加禁止。
- `pnpm add` 1 回で 3 package 同時追加 (`pnpm add @dnd-kit/core@^6.3.1 @dnd-kit/sortable@^10.0.0 @dnd-kit/utilities@^3.2.2`)。
- 2026-06-09 de-risk gate で確認済の transitive 追加のみを許容 (`@dnd-kit/accessibility` の 1 件、`@dnd-kit/utilities` は今回直接化、合計 +3 直接 / +1 推移 = +4 packages)。 transitive が増えた場合は STOP + OT 相談。
- `tsconfig.skipLibCheck: true` 維持 (gate で型 OK 確認、shim 不要)。
- `.env.example` 変更なし (env 追加なし)。
- 検証 step として `pnpm install` 再実行で lockfile drift ゼロ確認 + `pnpm exec tsc --noEmit` + `pnpm test` 既存全 pass を実施。

**完了条件:**
- `package.json` に 3 entry、 `pnpm-lock.yaml` 差分は dnd-kit 関連 +1 推移以内。
- `pnpm test` + `pnpm exec tsc --noEmit` 全 pass (既存挙動回帰なし)。
- commit message: `chore(deps): Tag-4c-2b dnd-kit legacy 3 packages 追加 [no-review]`。 chore(deps) で実装ロジック変更なしのため `[no-review]` 可。

---

## 相 2 (dnd-kit 依存 / T3 後)

### T4: `card-tag-option-list.tsx` 行に handle + `useSortable` 配線

**目的:** spec §4.1 を実装。 各 row に handle button (lucide `GripVertical`) を行頭追加し、 `useSortable({ id })` の `listeners`/`attributes` を **handle button のみ** に spread。 main / kebab は drag 非関与。 `onReorder` prop が渡された時のみ handle 表示 (`items.length < 2` で非表示)。

**制約:**
- 新 prop: `onReorder?: (orderedIds: string[]) => Promise<void>`。 未指定なら handle 非表示 + 既存挙動 (`DndContext` も mount しない)。
- 行構造 (spec §4.1 詳細): `<li ref={setNodeRef} style={transform/transition/opacity}>` + handle button (`setActivatorNodeRef`+`{...listeners}`+`{...attributes}`、`touch-none`、`w-6 h-7`) + 既存 main `<button flex-1 onClick=handleClick>` + 既存任意 kebab。
- handle aria-label = `${kind === 'category' ? 'カテゴリ' : 'option'}を並べ替え: ${option.name}`。
- main button / kebab に `listeners` / `attributes` を spread しないこと (event 構造分離契約)。
- `touch-none` (Tailwind = `touch-action: none`) は **handle button にのみ**付与 (main は通常 touch でスクロール / tap 可)。
- 既存 role (`menuitem` / `menuitemcheckbox` / `menuitemradio`) / aria-checked / Check icon / color pill / break-all は無変更。

**完了条件:**
- 新規必須 test: `onReorder` 有のとき handle 表示 / 無のとき非表示 / `items.length<2` で非表示。 handle に `listeners` のみ乗り、main button の onClick が pointerdown で発火しない (drag と click の分離契約)。 既存 role / aria-label テストは引き続き pass。
- `pnpm test card-tag-option-list` 全 pass / `pnpm exec tsc --noEmit` エラー 0。
- commit message: `feat(tag): Tag-4c-2b T4 option-list 行 handle 配線 [reviewed]`。 review 経由 + `[reviewed]`。

### T5: stage1 / stage2 別 `DndContext` + sensors + DragEnd ハンドラ

**目的:** spec §4.4 + §4.5 を実装。 `card-tag-add-popover.tsx` の stage1 (`{stage === 'category' && …}`) と stage2 (`{stage === 'option' && …}`) それぞれの内側に **別 `DndContext`** を mount。 `PointerSensor` + `KeyboardSensor` を `useSensors` で組み、 `verticalListSortingStrategy` + `closestCenter` を配線。

**制約:**
- sensors: `useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 5 } })` + `useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })`。 spec §4.4 厳守 (値変更は §9 smoke の hotfix scope)。
- collision detection: `closestCenter` (vertical list 標準)。
- `SortableContext.items` = stage1 では `sortedCategories.map(c => c.id)`、 stage2 では `categoryOptions.map(o => o.id)`。 strategy = `verticalListSortingStrategy`。
- `onDragEnd`: `event.active.id` / `event.over.id` から `arrayMove(items, oldIndex, newIndex)` で新順序を生成、 `onReorder(orderedIds)` を await。 `active.id === over.id` or `over === null` は no-op (早期 return)。
- popover の他挙動 (combobox / 新規作成 / kebab / 編集 stage / Esc / 幅 / break-all) は無変更。 編集 stage (editCategory / editOption / createCategoryType) には `DndContext` を mount しない (spec §1 out of scope)。

**完了条件:**
- 既存 `card-tag-add-popover.test.tsx` の Esc / stage 遷移 / combobox / 新規作成 / kebab テスト群が全 pass (regression なし)。
- T4 の handle + T5 の context 配線で stage1 / stage2 ともに `arrayMove → onReorder` が動くこと (T6 と合わせ統合実機確認は §9 smoke で OT)。
- `pnpm test card-tag-add-popover` 全 pass / `pnpm exec tsc --noEmit` エラー 0。
- commit message: `feat(tag): Tag-4c-2b T5 popover stage 別 DndContext + sensors [reviewed]`。 review 経由 + `[reviewed]`。

### T6: `CardTagsSection` に reorder handlers + `tagEditCallbacks` 拡張

**目的:** spec §4.3 を実装。 `card-tags-section.tsx` に `handleReorderCategories(orderedIds)` / `handleReorderOptions(categoryId, orderedIds)` を、 `handleToggle` と同じ same-tx atomic で配線。 `tagEditCallbacks` 型に 2 callback を追加し popover に渡す。

**制約:**
- tx 構造: `db.transaction('rw', db.tag_categories | db.tag_options, db.entity_mutations, async () => { ... })`。 N 件 mirror update + N 件 `enqueueEntityMutation` ({ entity_type: 'tag_category'|'tag_option', op: 'update_field', patch: { field: 'sort_key', value: nextKey } }) を同 tx に閉じる。 失敗時 Dexie auto-rollback。
- mirror update は `db.tag_X.update(id, { sort_key, updated_at: nowIso })` の partial update (他列触らない、`user_id` 注入不要)。
- `updates.length === 0` のとき tx 自体 skip (no-op)。 `reindexSortKeys` (T2) を呼んで差分のみ抽出。
- flush は tx 外 fire-and-forget `void runGuardedEntityMutationFlush().catch(() => {})`、 reference = `handleToggle` 末尾 (`card-tags-section.tsx:635`)。
- catch 経路は silent return (案 a 取り直し、次回 pull で reconcile)。 reference = `handleToggle:628-632`。
- `tagEditCallbacks` 型 (`card-tags-section.tsx:494-513`) に `reorderCategories: (orderedIds: string[]) => Promise<void>` + `reorderOptions: (categoryId: string, orderedIds: string[]) => Promise<void>` を追加。 popover (T5 で接続済) は `onReorder` prop からこれらを呼ぶ。

**完了条件:**
- 新規必須 test (`card-tags-section.test.tsx`): (a) mirror put + enqueue が同 tx で 1 commit (mockTransaction の callback 内で順序通り実行)、 (b) enqueue throw → tx 全体が throw 伝播 → handler catch で silent return、 `mockRunGuardedEntityMutationFlush` が呼ばれない (= P-2 A 案: 既存 `handleCreate*` rollback test ブロック `:1325` / `:1647` パターン踏襲)、 (c) `updates.length === 0` で `mockTransaction` 自体が呼ばれない (no-op)、 (d) `updated_at` が tx 内 update 引数に含まれる。
- 既存 `handleToggle` / `handleCreate*` / `handleRename*` / `handleSetXColor` / `handleDelete*` test 群は全 pass (regression なし)。
- `pnpm test card-tags-section` 全 pass / `pnpm exec tsc --noEmit` エラー 0。
- commit message: `feat(tag): Tag-4c-2b T6 reorder handlers + tagEditCallbacks 拡張 [reviewed]`。 review 経由 + `[reviewed]`。

---

## 論点 (OT 一括判断)

### P-1. subagent 分割粒度

- **(A) 推奨**: 6 task = 6 subagent。 dispatch 単位は task ごと (相 1 / dep / 相 2 で固定済) で task 間 review。 既存 Tag-4c-2a plan (`2026-06-08-tag-4c-2a-popover-inline-create.md`、5 task / 296 行) の task = subagent 粒度実績と整合 (1 task = 1 subagent + task 末尾 review)。
- (B): 相 1 (T1+T2) を 1 subagent にまとめ、 dep T3 を OT 手動、 相 2 を機能単位 (T4 / T5 / T6) で 3 subagent。 T1/T2 はファイルも独立で並列性が出るが、 順序契約 (T1 が先に Land して T2 reindex が露出させる comparator バグを塞ぐ) を 1 subagent 内で守らせる必要が出て review 観点も束ねづらい。
- (C): 相 2 を stage 別 (stage1 全部 / stage2 全部) で縦に切る。 spec §4.5 の構造は stage 別 `DndContext` ゆえ stage1 だけ / stage2 だけで一通り動くが、 T4 (`card-tag-option-list.tsx`) は両 stage 共有コンポーネントなので 2 subagent から同 file を触ることになり conflict リスク + review 重複。 機能縦切り (A) より粒度悪化。

→ **A を推奨** (T1〜T6 各 1 subagent、 task 間 review)。

### P-2. `card-tags-section.test.tsx` の tx atomic rollback テスト方式

- **(A) 推奨**: 既存 `handleCreate*` rollback test ブロック (`card-tags-section.test.tsx:1325` `it('enqueue が throw した場合 → tx が throw を伝播 (Dexie auto-rollback)、 flush は呼ばれない')` / `:1647` 同パターン) を踏襲。 `mockTransaction` (variadic で末尾 cb 実行、 `:25-30`) + `vi.mock('@/lib/sync/entity-mutations', () => ({ enqueueEntityMutation: vi.fn() }))` で `enqueueEntityMutation.mockRejectedValueOnce(new Error('boom'))`。 handler は catch 経路で silent return → `mockRunGuardedEntityMutationFlush` が `not.toHaveBeenCalled()` を assert。 mirror 個別 mock (`mockTagCategoriesUpdate`) は forward 呼出までは入る (tx 仮想実行のため) が、 「実際の rollback」 は Dexie 内部挙動なので test ではアサート対象外 (= flush 非呼出 + handler silent return の 2 軸で契約を表現)。
- (B): `fake-indexeddb` (既存 devDep) で実 Dexie tx を走らせ、 enqueue 内で throw して mirror が「実際に元値のまま」 を直接観測。 完全な挙動確認になるが、 既存 test 群 (`card-tags-section.test.tsx` 全体) は module mock 統一方式で 1700 行構築済。 fake-indexeddb 方式を 1 セクションだけ混ぜると mock state 干渉 + describe スコープ汚染リスクが大きい (個別 `beforeEach` 設計から作り直しが必要)。
- (C): 別 fixture ファイルで rollback 専用 test を切り出し fake-indexeddb で実行。 (B) のリスクを物理分離で回避できるが、 reference (`handleCreate*` のテスト構造) と乖離する手法を Tag-4c-2b だけ採用するのは整合性悪い。

→ **A を推奨** (既存 reference 踏襲、 同じ assert 軸 `flush not called` + `handler silent return` で契約を表現)。

---

## Smoke (本 plan には実行手順記載のみ、CC 機械 smoke は省略)

spec §9 の (a) KeyboardSensor Esc 衝突 / (b) in-place transform scroll 容器 clip / (c) モバイル long-press + scroll 誤発火 の 3 項目は OT が stg 手動 UX smoke で確認。 fallback (`DragOverlay` portal / `delay`/`tolerance` 調整) はいずれも別 hotfix scope で本 plan に inline しない (本 plan は in-place + `delay=250` / `tolerance=5` で land)。 smoke checklist は本 plan 完了後に別 file (`docs/superpowers/plans/2026-06-09-tag-4c-2b-smoke-checklist.md`) を OT 依頼時に起こす想定 (既存 `*-smoke-checklist.md` パターン踏襲)。

---

## 完了条件 (spec §8 から再掲、 本 plan 全 task land 後)

- `chore(deps)` (T3) で dnd-kit 3 packages を develop に land 済
- `docs(tag)` (本 plan 含む spec+plan 2 commit) を develop に land 済
- `fix(tag)` T1 + `feat(tag)` T2/T4/T5/T6 を develop に land、全て `[reviewed]` tag + Critical 0
- popover stage1 / stage2 で D&D 並べ替え動作 (mouse + keyboard + touch)
- drag-end で `tag_categories.sort_key` / `tag_options.sort_key` が 0-based 整数で正規化
- `sortByKeyThenCreated` が数値比較化され、N≥10 で表示が数値順 (§4.6)
- 並べ替え後 reload で popover 再表示時に並び順保持
- 別端末 (or pull 再取得) で同じ並び順を受信
- 既存 popover 全挙動 (combobox / 新規作成 / kebab / 編集 stage / Esc / 幅 / break-all) リグレッションなし
- manager (/app/tags) 触らず created_at ASC のまま
- Vitest 全 pass / Playwright smoke 全 pass (smoke 項目は §9 で OT 実行)
