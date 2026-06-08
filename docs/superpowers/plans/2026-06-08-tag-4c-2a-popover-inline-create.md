# Tag-4c-2a: card-tags popover 内 category / option 作成 (Notion 方式 combobox) + popover 内タグ管理 link 全削除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 各 task 完了条件は `pnpm test` + `pnpm build` 緑。 全 task 完了後に **単一 commit** (Task 5 末)。 push しない (OT が stg smoke)。

**Goal:** 試験詳細 (`/app/exams/[id]`) の card-tags popover 内で、 category / option の **新規作成** を Notion 方式の combobox で行えるようにする。 同時に popover 内の「タグ管理 →」 link を全箇所削除し、 popover 内導線で完結させる。 D&D 並べ替えは別 sprint (Tag-4c-2b) で扱うため本 sprint 対象外。

**Architecture:** Tag-4c-1 の 4 stage popover (`'category' | 'option' | 'editCategory' | 'editOption'`) を **5 stage** に拡張 (`'createCategory'` 追加)、 stage1 末尾に「+ カテゴリを追加」 行、 stage2 に combobox input + 末尾「新規作成」 行を統合。 作成 mutation logic は `CardTagsSection` に集約 (Tag-4c-1 と同方針)、 popover は callback ベース presentation only。 atomic 戦略は **全作成系で same-tx atomic** = `db.transaction('rw', store(s), entity_mutations, ...)` (option 作成+即付与は tag_options + card_tags + entity_mutations の 3 store rw lock、 Tag-4c-1 削除系 pattern を流用)。

**Tech Stack:** Next.js 15 / shadcn Popover (既存) / lucide-react (既存、 `Plus` 追加使用) / Dexie + dexie-react-hooks / 既存 `nextCardSortKey` (helper 中立、 リネームなし) / Vitest + RTL。 **npm dep 追加なし**。

**前提:**
- Tag-4c-1 着地済 (commit `51768db`)、 atomic tx + JWT 由来 user_id + popover 5 stage 化 reference 実装あり
- 既存 server apply 経路 (`lib/tags/apply-tag-mutation.ts` の `applyTagCategoryCreate` / `applyTagOptionCreate`) + pull 経路は無改修
- 既存 tags/_components/* (manager) は本 sprint **据置** (旧 void enqueue / 空文字 user_id pattern コピー禁止、 Sync-fix-1 で一斉差し替え予定)
- 既存資産流用: `lib/cards/next-card-sort-key.ts` (`nextCardSortKey`、 generic helper として再利用)、 `lib/tags/color-palette.ts` (新規作成 option の color は **`null`** で作成、 既存 manager と同方針)
- toast 機構 project 未実装 → error 表示は popover 内 inline (Tag-4c-1 と同方針)
- spec: `docs/superpowers/specs/2026-06-08-tag-4c-2a-popover-inline-create-design.md`

**維持する設計 (Tag-4b-fix / 4c-1 継承、 不変):**
- whole-set 不変条件 (他カテゴリ落とし回避)
- single 最大 1 個・0 個許容
- 案 a 取り直し (cards.updated_at bump → pull)
- parent `InlineCardList` 一括 subscribe + useMemo + 子 `React.memo`
- popover stage 構造 + Esc 階層 (Notion 方式、 本 sprint で 5 stage 化)
- npm dep 追加ゼロ
- user_id は親 prop の auth() 由来値 (空文字禁止)

**全 task 共通ルール:**

- TypeScript strict、 既存 Client Component pattern 踏襲
- **作成系 atomic tx** = `db.transaction('rw', store(s), db.entity_mutations, async () => { mirror put(s) + enqueueEntityMutation(s) })`、 失敗時 Dexie auto-rollback (Tag-4c-1 削除系 pattern を流用)
- 全 UI 文言は日本語、 Tailwind class は既存 slate 系で統一
- error 表示は popover 内 inline (`<p className="text-xs text-red-600 mt-1" role="alert">{message}</p>` 等)
- 作成成功時の遷移は spec §Architecture / §設計判断 を遵守 (category 作成成功 → stage='option' + selectedCategoryId=新 id、 option 作成成功 → stage='option' に stay + filter input 空に reset + 新 option が selected 状態で表示)
- 全 task 完了後に **単一 commit** (Task 5 末で):
  ```
  feat(tag): Tag-4c-2a popover 内 category/option 作成 + タグ管理 link 全削除 [no-review]
  ```
- push しない (OT が stg smoke)

---

### Task 1: schema 確認 (sort_key 型) + `CardTagsSection` に `handleCreateCategory` / `handleCreateOptionAndAssign` + sort_key 採番

**Files:**
- Verify (read only): `lib/db/schema/tag.ts` 等 (実 path は grep で特定)、 `tag_categories.sort_key` / `tag_options.sort_key` の Drizzle カラム型
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx`

**Step 0: schema 確認 (spec §リスク 1)**
- `tag_categories.sort_key` / `tag_options.sort_key` が text 型 (`nextCardSortKey` 戻り値 string と整合) か確認
- 不一致 (例: integer / numeric 型) を発見したら **task 中断 + OT 相談**。 spec 修正後に再開
- 一致を確認したら以下に進む

**目的:** popover から callback で呼び出す 2 つの作成 handler を section に集約。 popover は presentation only を維持。 sort_key は同 scope max+1 で末尾採番。

**制約:**

- 追加 handlers:
  - `handleCreateCategory(name: string, selectType: 'single' | 'multi') → Promise<{ id: string }>`:
    - `crypto.randomUUID()` で id 生成、 `nextCardSortKey(categories.map(c => c.sort_key))` で sort_key 採番
    - `db.transaction('rw', db.tag_categories, db.entity_mutations, async () => { db.tag_categories.put({ id, name, select_type: selectType, color: null, sort_key, user_id: props.userId, created_at: now }) → await enqueueEntityMutation({ entity_type: 'tag_category', entity_id: id, op: 'create', patch: { name, select_type: selectType } }) })`
    - 失敗時 Dexie auto-rollback、 throw を再 throw して popover 側で catch / inline error
    - 成功時 `{ id }` を返す → popover 側で `setSelectedCategoryId(id)` + `setStage('option')`
    - flush は tx 外 `void runGuardedEntityMutationFlush().catch(() => {})`
  - `handleCreateOptionAndAssign(categoryId: string, name: string) → Promise<void>`:
    - `crypto.randomUUID()` で 新 option id 生成、 `nextCardSortKey(options.filter(o => o.category_id === categoryId).map(o => o.sort_key))` で sort_key 採番
    - 既存 `buildNextTagSet`-相当の logic で whole-set を構築:
      - category.select_type='single' → 新 option を toAdd、 同カテゴリ既存付与 option を toRemove に積む
      - category.select_type='multi' → 新 option を toAdd のみ
    - `db.transaction('rw', db.tag_options, db.card_tags, db.entity_mutations, async () => { db.tag_options.put({ id: newOptionId, category_id: categoryId, name, color: null, sort_key, user_id: props.userId, created_at: now }) → for(id of toRemove) db.card_tags.delete([cardId, id]) → for(id of toAdd) db.card_tags.put({ card_id: cardId, option_id: id, user_id: props.userId, created_at: now, sort_key: null }) → await enqueueEntityMutation({ entity_type: 'tag_option', entity_id: newOptionId, op: 'create', patch: { category_id, name, color: null } }) → await enqueueEntityMutation({ entity_type: 'card', entity_id: cardId, op: 'update_field', patch: { field: 'tag_option_ids', value: nextWholeSet } }) })`
    - flush は tx 外 fire-and-forget
- user_id は既存 props.userId (Tag-4b-fix 配線済) を使用、 **空文字なら handler 自体を early return + console.error** (defensive、 Tag-4b-fix `handleToggle` と同型)
- 旧 tags/_components (manager) の `void` 非 await + `user_id=''` パターンは **コピー禁止**
- popover に渡す callbacks は **既存 `tagEditCallbacks` を拡張** して `createCategory`, `createOptionAndAssign` を追加 (新 prop 増設より既存 interface 拡張、 子 React.memo の identity は useMemo で安定化済)
- 新規作成 option / category の **color は `null`** 固定 (既存 manager 既定、 Tag-4c-1 で popover から色変更可能なので作成時の color UI は不要)
- `nextCardSortKey` は既存 helper をそのまま import、 リネーム / 移動はしない (spec §設計判断 3)

**完了条件:**
- 新規 handler 2 つの unit test 緑:
  - `handleCreateCategory`: `db.transaction` の引数 stores 検証 (`tag_categories` + `entity_mutations`)、 mirror.put の引数 (id / name / select_type / **color: null** / sort_key / user_id / created_at)、 enqueue の op 引数、 enqueue throw 時の auto-rollback (mirror 元状態 = 該当 id 存在しない)
  - `handleCreateOptionAndAssign`: `db.transaction` の引数 stores 検証 (`tag_options` + `card_tags` + `entity_mutations` の 3 store rw lock)、 single ルール (同カテゴリ既存付与の toRemove)、 multi ルール (toAdd のみ)、 enqueue 2 連発の op 引数、 enqueue throw 時の auto-rollback、 props.userId が tag_options / card_tags 両方の put 引数に乗る
  - 両方とも props.userId='' で early return + console.error 呼出
- sort_key 採番:
  - 既存 sort_key 全 null → 戻り値 `"1"` (`nextCardSortKey` の既存仕様)
  - 既存 sort_key `["1", "2"]` → 戻り値 `"3"`
  - 既存 sort_key `["1", null, "5"]` → 戻り値 `"6"`
- `pnpm test` 全件緑、 `pnpm build` 緑、 tsc strict 緑

---

### Task 2: `CardTagOptionList` に combobox input + filter + 「新規作成: {入力値}」 row + `showTagManagerLink` 撤去

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-option-list.test.tsx`

**目的:** stage2 option 一覧の上部に combobox input を常設、 filter で部分一致絞り込み + 末尾「新規作成」 行で新規 option 作成 + 即付与の導線を提供。 同時に `showTagManagerLink` props を撤去 (B-2)。

**制約:**

- 追加 props:
  - `onCreateNew?: (name: string) => Promise<void>` (popover から渡される、 新規作成行 click で呼ばれる)
  - `createError?: string | null` (popover から渡される、 inline error 表示)
- 削除 props: `showTagManagerLink` (本 sprint で全削除、 該当箇所も削除)
- 内部 state: `const [filterText, setFilterText] = useState('')`
- `selectedCategoryId` (= 親が render する category id、 props で受領済) の変化を `useEffect` で監視し、 変化時 `setFilterText('')` で reset (stage 遷移時の filter cleanup)
- input 要素 (Tag-4b-fix line 77 予約コメント位置に挿入):
  - `<input type="text" value={filterText} onChange={e => setFilterText(e.target.value)} placeholder="検索 or 新規作成" autoFocus className="..." aria-label="option を検索 / 新規作成" />`
  - autoFocus は stage2 表示時に効くよう、 mount 時 ref.current?.focus() を `useEffect(() => { inputRef.current?.focus() }, [])` で
- filter logic (spec §設計判断 7):
  - `const trimmed = filterText.trim()`
  - `const lower = trimmed.toLowerCase()`
  - `const filteredOptions = options.filter(o => o.name.toLowerCase().includes(lower))`
  - `const exactMatchExists = options.some(o => o.name.trim().toLowerCase() === lower)`
  - `const showCreateRow = trimmed.length > 0 && !exactMatchExists`
- 既存 option 行: `filteredOptions` を render (既存 row 構造維持、 kebab も維持)。 0 件かつ `showCreateRow=false` の時のみ placeholder 文言「上の入力欄に名前を入れて『新規作成』 で追加できます」 を出す
- 新規作成行 (`showCreateRow` のとき末尾に append):
  - `<li><button type="button" onClick={() => onCreateNew?.(trimmed)} className="..."><Plus className="h-4 w-4" aria-hidden="true" /><span>新規作成: {trimmed}</span></button></li>`
  - aria-label: `新規作成: ${trimmed}`、 keyboard Enter 動作
- inline error: `createError` が非 null なら option list の下に `<p role="alert" className="text-xs text-red-600 mt-1">{createError}</p>`
- 既存の `onToggle` (= 既存 option click 付与) と `onRowAction` (= kebab click 編集遷移) は無改修、 `onCreateNew` は **第 3 の独立 callback** (event 分離、 spec §設計判断 2)
- **新規作成行 click → onCreateNew 成功時の filter reset は本 component で実施**: 新規作成行 button onClick を `async () => { try { await onCreateNew?.(trimmed); setFilterText('') } catch { /* error は popover 側で createError 経由表示、 filter は保持しない */ setFilterText('') } }` (失敗時も filter は空に戻す方が再試行で別名入力しやすい)。 onCreateNew が undefined ならクリック自体 no-op
- `showTagManagerLink` props 削除に伴い、 内部の「タグ管理 →」 link JSX + import を全削除

**完了条件:**

- filter test:
  - 入力空 → 全 option 表示 + 新規作成行非表示
  - "循" 入力 + options=["循環器", "呼吸器"] → "循環器" のみ表示 + 新規作成行「新規作成: 循」 表示
  - 大小無視: "CIRCULATION" 入力 + options=["circulation_test"] → ヒット表示 (case-insensitive)
  - 完全一致 (case/whitespace 無視): "循環器" 入力 + options に "循環器" 既存 → ヒット表示 + 新規作成行非表示
  - 入力あり + filter ヒット 0 件 + 完全一致なし → option list 空 + 新規作成行のみ表示 (placeholder 出さない)
- 新規作成行 click → `onCreateNew(trimmed)` 1 回呼出、 引数は trim 後文字列
- 新規作成行 click 成功 / 失敗とも filterText が "" に reset (再試行 / 別 option 探索の UX)
- 既存 row click (= `onToggle`) と新規作成行 click (= `onCreateNew`) と kebab click (= `onRowAction`) の event 分離 (1 click = 1 callback、 stopPropagation 効いている)
- `selectedCategoryId` 変化で filterText が "" に reset
- `createError` 非 null で inline error 表示 + `role="alert"`
- `showTagManagerLink` props を持つ呼出が全 component から消えている (型 error 出ない = 既存呼出側を Task 3/4 で更新済 or 撤去済) — Task 2 単独では呼出側更新前の中間状態を許容 (Task 3/4 完了時点で総合的に整合)
- `pnpm test` 全件緑、 `pnpm build` 緑

---

### Task 3: `CardTagAddPopover` に `createCategory` stage + 「+ カテゴリを追加」 row + Esc 階層拡張 + 配線

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx`

**目的:** stage を **5 値** (`'category' | 'option' | 'editCategory' | 'editOption' | 'createCategory'`) に拡張、 stage1 末尾「+ カテゴリを追加」 row、 createCategory stage の中身、 Esc 階層 5 stage 化、 `CardTagOptionList` に combobox 配線、 Task 1 で追加した callbacks を呼出。

**制約:**

- stage 型を 5 値に拡張、 内部 state 追加: `createForm: { name: string; selectType: 'single'|'multi' }` (default `{ name: '', selectType: 'multi' }`)、 `createError: string | null`
- **stage1** (category list) 末尾に 1 行追加:
  - `<button type="button" onClick={() => { setStage('createCategory'); setCreateError(null) }} className="..."><Plus className="h-4 w-4" aria-hidden="true" /><span>+ カテゴリを追加</span></button>`
  - kebab なし (作成ボタンなので操作対象なし)
- **createCategory stage** の中身 (inline JSX、 spec §設計判断 4):
  - back button: `← カテゴリ選択へ戻る` → click で `setStage('category')`、 createForm / createError を reset
  - 名前 input: `<input value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value })); setCreateError(null)} placeholder="カテゴリ名" autoFocus />` (mount 時 focus)
  - select_type セグメント: 2 button (`single` / `multi`)、 `aria-pressed` で active 表示、 default multi
  - 作成 button: `disabled={createForm.name.trim().length === 0}`、 click で:
    ```ts
    try {
      const { id } = await tagEditCallbacks.createCategory(createForm.name.trim(), createForm.selectType)
      setSelectedCategoryId(id); setStage('option'); setCreateForm({ name: '', selectType: 'multi' }); setCreateError(null)
    } catch (e) {
      setCreateError('作成に失敗しました')
    }
    ```
  - inline error: createError 非 null なら作成 button 下に `<p role="alert" className="text-xs text-red-600 mt-1">{createError}</p>`
- **stage2** で `CardTagOptionList` に新 props を配線:
  - `onCreateNew={async (name) => { try { await tagEditCallbacks.createOptionAndAssign(selectedCategoryId!, name); /* 成功時は CardTagOptionList の useEffect (selectedCategoryId 変化) では reset されないが、 useLiveQuery で新 option が並ぶ + selected 表示。 filter input を空に戻すため popover 側で何か flag を渡す or CardTagOptionList 側で onCreateNew 成功時に filter reset */ setCreateError(null) } catch (e) { setCreateError('作成に失敗しました') } }}`
  - filter reset の責務分担: `CardTagOptionList` 内部で onCreateNew が resolve した直後に `setFilterText('')` する (Task 2 のスコープに含める。 ただし呼出 side が catch する流れでは popover から知らせる方が確実 → **popover 側で `setFilterText` を直接触らず、 CardTagOptionList が自前で `onCreateNew(name).then(() => setFilterText(''))` する pattern を採用**、 Task 2 で対応済とする)
  - `createError={createError}` を渡し、 stage='option' 時の inline error 表示
- **Esc 階層** (5 stage、 spec §設計判断 6):
  ```ts
  onEscapeKeyDown={(e) => {
    if (stage === 'editCategory')      { e.preventDefault(); setStage('category') }
    else if (stage === 'editOption')    { e.preventDefault(); setStage('option') }
    else if (stage === 'createCategory'){ e.preventDefault(); setStage('category'); setCreateForm({ name: '', selectType: 'multi' }); setCreateError(null) }
    else if (stage === 'option')        { e.preventDefault(); setStage('category') }
    // stage 'category' は shadcn 標準 (popover 閉じる)
  }}
  ```
- popover close 時 (`onOpenChange` 既存ロジック) に state reset 追加: `setStage('category')` + `setCreateForm({ name: '', selectType: 'multi' })` + `setCreateError(null)` + `setSelectedCategoryId(null)`
- カテゴリ 0 件 placeholder (stage1 の categories.length===0 時) の文言を「下の『+ カテゴリを追加』 から作成できます」 に差し替え、 「タグ管理 →」 link を削除 (B-2 と統合)。 「+ カテゴリを追加」 button は categories.length===0 でも表示 (むしろ唯一の動線)
- カテゴリ作成 stage で `createCategory` callback が resolve しないまま新 useLiveQuery で再描画されても stage は固定 (`setStage('option')` は callback の resolve 内でのみ呼ばれる、 race なし)

**完了条件:**
- 「+ カテゴリを追加」 row 表示 + click → createCategory stage
- createCategory stage:
  - 名前空 → 作成 button disabled
  - 名前入力 + 作成 → `tagEditCallbacks.createCategory(name, selectType)` 呼出、 default selectType='multi'
  - select_type ボタン切替 → `aria-pressed` 反映
  - 成功時 stage='option' + selectedCategoryId=新 id + createForm reset
  - 失敗時 stage='createCategory' のまま + inline error + input/selectType 保持 + button 再 enable で再試行可
  - Esc → stage='category' + createForm reset
- stage2 (`option` stage):
  - `CardTagOptionList` に `onCreateNew` + `createError` が配線されている
  - 新規作成行 click → `tagEditCallbacks.createOptionAndAssign(selectedCategoryId, name)` 呼出
  - 失敗時 inline error 表示 (createError 経由)
  - Esc → stage='category' (既存維持)
- Esc 階層 5 stage 全パターン:
  - createCategory → category
  - editCategory → category
  - editOption → option
  - option → category
  - category は shadcn 標準 (popover 閉じる)
- popover close → 全 state reset (stage='category'、 createForm、 createError、 selectedCategoryId)
- カテゴリ 0 件 placeholder の文言が新文言、 link が消えている
- 既存 add フロー / Tag-4c-1 編集フロー regression なし
- `pnpm test` 全件緑、 `pnpm build` 緑

---

### Task 4: popover 内タグ管理 link 全削除 + placeholder 文言差し替え + `card-tag-edit-popover` 確認 + section から callbacks 配線

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (Task 3 で大半完了、 ここでは footer link 残存 / option 0 件 placeholder 残存があれば最終削除 + 文言差し替え)
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` (footer / placeholder 内に「タグ管理 →」 link が残っていれば削除)
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.test.tsx` (regression、 link 非表示確認)
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (Task 1 で追加した `createCategory` / `createOptionAndAssign` を `tagEditCallbacks` の useMemo に追加して 2 popover に props 配線、 既存 callbacks 維持)
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx` (regression)

**目的:** popover 内「タグ管理 →」 link の最終掃除、 placeholder 文言を popover 内導線に揃え、 section → popover の callback 配線を完成させ、 2 popover (add / edit) が同じ拡張 `tagEditCallbacks` を受け取って presentation に徹する状態にする。

**制約:**

- spec §Scope B-2 削除対象を全て削除:
  1. `card-tag-add-popover` footer の「タグ管理 →」 link (Task 3 で実施済の確認)
  2. `card-tag-add-popover` stage2 option 0 件 placeholder 内 link
  3. `card-tag-add-popover` カテゴリ 0 件 placeholder 内 link (Task 3 で実施済の確認)
  4. `card-tag-edit-popover` footer / placeholder 内 link
  5. `card-tag-option-list` 内 `showTagManagerLink` 起点の link (Task 2 で実施済の確認)
- placeholder 文言:
  - カテゴリ 0 件 (stage1): 「下の『+ カテゴリを追加』 から作成できます」 (Task 3 で実施済の確認)
  - option 0 件 (stage2): 「上の入力欄に名前を入れて『新規作成』 で追加できます」 (Task 2 で `CardTagOptionList` に実装済の確認)
- section の `tagEditCallbacks` useMemo に Task 1 の 2 handlers を追加。 既存 6 handlers + 2 count helpers と合わせて 10 fields の object になる (= Tag-4c-1 callbacks shape を最小拡張、 別 object 化はしない)
- `card-tag-edit-popover` には `createOptionAndAssign` のみ流すかどうか: バッジ click は既存単一カテゴリ option list 経路 → option 新規作成も使える方が UX 一貫 (Notion 同等)。 **Task 4 で `card-tag-edit-popover` にも combobox 配線 + `createOptionAndAssign` 配線を追加**:
  - `card-tag-edit-popover` の中身も `CardTagOptionList` を使用しているため、 同じ `onCreateNew={async name => { try { await tagEditCallbacks.createOptionAndAssign(category.id, name); setLocalCreateError(null) } catch(e) { setLocalCreateError('作成に失敗しました') } }}` を配線、 `createError={localCreateError}` を渡す
  - state: `const [localCreateError, setLocalCreateError] = useState<string|null>(null)`、 popover close で reset
  - **category 新規作成はバッジ click 経路では不要** (バッジは既存 category 配下の編集動線、 新 category 作成は + タグ追加 動線): `card-tag-edit-popover` には createCategory を渡さない、 「+ カテゴリを追加」 row 表示もしない
- `card-tag-edit-popover` の `editOption` stage + Esc 階層は Tag-4c-1 で実装済、 本 task で触らない

**完了条件:**
- 全 popover の全 stage で「タグ管理 →」 link が DOM に存在しない (test で `queryByText('タグ管理')` が null)
- 各 placeholder 文言が新文言に差し替わっている
- `card-tag-add-popover` と `card-tag-edit-popover` の両方が同一 `tagEditCallbacks` を受け取る (useMemo identity 安定、 子 React.memo の不要再描画なし、 test で section→popover の props 受け渡し verify)
- `card-tag-edit-popover` の stage='option' で combobox input + 新規作成行 + `createOptionAndAssign` 動線が機能、 失敗時 inline error 表示
- `card-tag-edit-popover` には category 作成 UI なし (regression / scope check)
- 既存 edit フロー (rename / color / delete、 Tag-4c-1 15 観点) regression なし
- `pnpm test` 全件緑、 `pnpm build` 緑

---

### Task 5: smoke checklist + 統合 commit

**Files:**
- Create: `docs/superpowers/plans/2026-06-08-tag-4c-2a-smoke-checklist.md`
- (Task 1-4 の全変更を 1 commit にまとめる)

**目的:** stg 実機 smoke 観点を網羅した checklist を作り、 全変更を単一 commit で develop に積む。

**制約:**

- smoke checklist file (別 file 化、 ~60 行): 検証カテゴリ単位で 20 観点を列挙。 検証カテゴリ:
  1. createCategory stage 遷移 + 入力 + selectType (default multi) + 作成 → option stage 自動遷移 (観点 1-6)
  2. stage2 combobox: 空入力 / 部分一致 / 完全一致 / ヒット 0 件 + 新規作成行表示条件 (観点 7-10、 spec §設計判断 7)
  3. 新規作成行 click → 即付与 (single/multi ルール) + input reset + selected 表示 (観点 11-12)
  4. 作成失敗 inline error (option / category 両方、 atomic rollback) (観点 13-14)
  5. CardTagEditPopover の combobox 配線 + category 作成 UI 非表示 (観点 15)
  6. popover 内「タグ管理 →」 link 全 stage 不在 + nav link 残存 + manager 併存 (観点 16-17)
  7. sort_key 末尾採番 + reload 後維持 (観点 18-19)
  8. console error 0 + Tag-4c-1 全 15 観点 regression (観点 20)
- commit message: `feat(tag): Tag-4c-2a popover 内 category/option 作成 + タグ管理 link 全削除 [no-review]`
- 単一 commit (Task 1-5 の全変更 + smoke checklist file 含む)

**完了条件:**
- `pnpm test` 全件緑 (新規 + 改修分)
- `pnpm build` 緑
- TypeScript strict 緑
- 全変更 (Task 1-5) を **1 commit** で develop に積む
- push しない (OT が stg smoke)

---

## Plan 完了後の OT smoke (push 前停止後)

OT 確認: 上記 20 観点を順次 PASS / FAIL で記録。 特に:
- Notion 方式 combobox の input → 新規作成行 → 即付与の操作感
- single カテゴリでの「新規作成 + 即付与」 で既存付与 option が落ちる挙動 (spec §リスク 4、 OT 確定済挙動)
- category 作成直後 stage='option' で option 0 件 placeholder が新文言で出る
- atomic 失敗 (本番では発生しづらいので、 必要なら DevTools の Application > IndexedDB を一時 close する等で擬似的に tx を壊す)

行数: ~296 行 (300 cap 内、 目安 150-250 を超過。 spec §設計判断詳細 + atomic tx 設計を plan に流し込み、 各 task 30-50 行になっている。 削るとコード片不在で実装者が迷う部分のため維持。 smoke checklist は別 file 化で本体を圧縮した)。
