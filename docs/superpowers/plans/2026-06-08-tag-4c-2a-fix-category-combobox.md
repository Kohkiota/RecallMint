# Tag-4c-2a-fix: stage1 を category combobox に統一 + 型選択 stage 導入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 各 task 完了条件は `pnpm test` + `pnpm build` 緑。 全 task 完了後に Tag-4c-2a の commit `b1fbe89` に **`git commit --amend` で畳む** (別 commit を積まない、 Task 5 で実行)。 push は OT が `--force-with-lease` で実施 (Claude Code は push しない)。

**Goal:** Tag-4c-2a の card-tags popover stage1 (category 一覧) を、 option stage2 と同型の Notion 方式 combobox に統一する (上部 input + 末尾「+ 新規作成: {入力値}」 行)。 旧「+ カテゴリを追加」 button + 旧 `'createCategory'` stage を撤廃、 「新規作成」 click で「型選択 stage」 (`'createCategoryType'`、 single / multi 2 button) に遷移して single / multi 確定時に category 作成 + その category の stage='option' へ自動遷移。

**Architecture:** `CardTagOptionList` を `kind: 'option' | 'category'` discriminator で generalize (リネームせず、 props 拡張のみ)、 stage1 を `<CardTagOptionList kind="category" ... />` で render。 stage 列挙は 5 値のまま (`'createCategory'` → `'createCategoryType'` に置換)、 Esc 階層は対応する分岐を差し替え。 category 作成 atomic tx は Tag-4c-2a Task 1 の `handleCreateCategory` をそのまま再利用 (改修なし)、 popover 側の呼出経路だけが変わる。

**Tech Stack:** Next.js 15 / shadcn Popover (既存) / lucide-react (既存、 `Plus` 既使用) / Dexie + dexie-react-hooks / 既存 `nextCardSortKey` / Vitest + RTL。 **npm dep 追加なし**。

**前提:**
- Tag-4c-2a 着地済 (commit `b1fbe89`、 5 stage popover + option combobox + atomic create handlers + popover タグ管理 link 全削除 reference 実装あり)
- 既存 server apply 経路 (`applyTagCategoryCreate` / `applyTagOptionCreate`) + pull 経路は無改修
- 既存 `tags/_components/*` (manager) は据置 (Sync-fix-1 で一斉差し替え予定)
- 既存資産流用: `tagEditCallbacks.createCategory` (Tag-4c-2a Task 1)、 `CardTagOptionList` の combobox / filter / 新規作成行 / inline error 機構 (Tag-4c-2a Task 2)、 `isSubmittingCreate` flag (Tag-4c-2a Task 3)
- spec: `docs/superpowers/specs/2026-06-08-tag-4c-2a-fix-category-combobox-design.md`
- schema 事実 (Step 0 で確認): `tag_categories` に UNIQUE(user_id, name) **なし**、 `tag_options` に UNIQUE(tag_category_id, name) **あり** → category は同名作成許容、 option は同名抑制

**維持する設計 (Tag-4b-fix / 4c-1 / 4c-2a 継承、 不変):**
- whole-set 不変条件 (他カテゴリ落とし回避)
- single 最大 1 個・0 個許容
- 案 a 取り直し (cards.updated_at bump → pull)
- parent `InlineCardList` 一括 subscribe + useMemo + 子 `React.memo`
- popover stage 構造 + Esc 階層 (Notion 方式、 本 sprint で `createCategory` → `createCategoryType` 置換)
- npm dep 追加ゼロ
- user_id は親 prop の auth() 由来値 (空文字禁止)
- atomic 戦略 (作成系) = `db.transaction('rw', tag_categories, db.entity_mutations, ...)` の same-tx atomic + Dexie auto-rollback (Tag-4c-2a Task 1 `handleCreateCategory` の挙動)

**全 task 共通ルール:**

- TypeScript strict、 既存 Client Component pattern 踏襲
- 全 UI 文言は日本語、 Tailwind class は既存 slate 系で統一
- error 表示は popover 内 inline (`<p role="alert" className="text-xs text-red-600 mt-1">{message}</p>`)
- 二重発火ガード `isSubmittingCreate` (Tag-4c-2a Task 3 で導入済) を流用
- 各 task は **未 commit** のまま review、 Task 5 末で全変更を `b1fbe89` に amend で畳む
- amend 後の commit message は OT 判断 (既存維持 or 「+ stage1 を category combobox に統一 (Tag-4c-2a-fix)」 を bullet 追記)
- push しない (Claude Code が `git push` を実行しない、 OT が `git push --force-with-lease origin develop` で実施)

---

### Task 1: `CardTagOptionList` を `kind` discriminator で generalize

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-option-list.test.tsx`

**目的:** option / category 両用の combobox sub-component にする。 props 拡張のみで内部分岐を持たせ、 既存 stage='option' 呼出 (default = kind='option') の挙動は完全に regression なし。

**制約:**

- 新規 props (全て optional、 既存 stage='option' 呼出は `kind='option'` 未指定でも default で動く):
  - `kind?: 'option' | 'category'` (default `'option'`)
  - `suppressCreateOnExactMatch?: boolean` (default `true` = option 既存挙動、 category 呼出では `false` を渡して同名許容)
  - `searchPlaceholder?: string` (input placeholder、 default「検索 or 新規作成」、 category 呼出では 同文言でも OK だが上書き可)
  - `searchAriaLabel?: string` (default「option を検索 / 新規作成」、 kind='category' 呼出側で「category を検索 / 新規作成」 等に上書き)
  - `emptyPlaceholderText?: string` (items 0 件 + 新規作成行も出ない時の文言、 kind='category' で「下の入力欄に名前を入れて『新規作成』 で追加できます」 を渡す)
- 内部分岐 (TypeScript discriminated union ではなく、 props 全 optional + render 内 `if (kind === 'category')` 程度の単純分岐で十分):
  - **Check icon (selected 表示)**: `kind === 'option'` のときのみ render (現状維持)。 `kind === 'category'` では非表示
  - **click semantics**: 既存 `onToggle(id)` の呼出は `kind` 非依存 (callback 名は変えない、 popover 側で意味を解釈)。 spec §S-5 で「onItemClick」 と書いたが実装では既存 `onToggle` をそのまま再利用、 spec 内 alias とみなす (props 名変更による調整コストを避ける)
  - **suppress 制御**: 既存 `showCreateRow = trimmed.length > 0 && !exactMatchExists` を `showCreateRow = trimmed.length > 0 && (!suppressCreateOnExactMatch || !exactMatchExists)` に修正 (default `true` で既存挙動)
- `selectedOptionIds` (option only) は kind='category' では `undefined` or 空 Set を受け取り、 Check icon が non-render になるだけ (defensive: undefined access しない)
- `selectType` も kind='category' では undefined。 single 自動 close を含む既存ロジックは kind='option' のときのみ走る
- 既存 `selectedCategoryId` (filter reset trigger) は kind='option' のとき意味あり、 kind='category' では undefined で reset 不要 (stage1 は popover open 中 1 度しか render されない、 §spec 設計判断 5 周辺)
- リネームしない (`CardTagOptionList` のまま、 JSDoc に「option / category の combobox 共通」 と 1 行追記)
- `kind='category'` での aria-label / placeholder default 値は **popover 側から明示渡し**、 component 内 default は option 既存挙動を変えない

**完了条件:**

- 既存 `kind='option'` (default) 呼出の test は全件 regression なし
- 新規 test (`kind='category'`):
  - kind='category' で Check icon が render されない (DOM に `Check` icon なし)
  - kind='category' + `suppressCreateOnExactMatch=false` で、 完全一致名入力時も「新規作成」 行が**出る**
  - kind='option' + default で、 完全一致名入力時に「新規作成」 行が**出ない** (regression 維持)
  - 既存 row click → onToggle 呼出 (kind 非依存、 既存維持)
  - kebab → onRowAction (kind 非依存、 既存維持)
  - input filter (部分一致 + 大小無視) は kind 非依存で動く
  - `searchPlaceholder` / `searchAriaLabel` / `emptyPlaceholderText` の上書きが反映される
- `pnpm test` 全件緑、 `pnpm build` 緑、 tsc strict 緑

---

### Task 2: `CardTagAddPopover` stage1 を `<CardTagOptionList kind="category" ... />` で render に置換 + 旧「+ カテゴリを追加」 row 削除

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx`

**目的:** stage1 (category 一覧) を combobox 化。 既存 `<ul>` + 末尾「+ カテゴリを追加」 button JSX を削除、 `<CardTagOptionList kind="category" ... />` で代替。 既存 category 行 click / kebab click 挙動は `onToggle` / `onRowAction` callback 経由で維持。

**制約:**

- stage='category' の JSX をまるごと `<CardTagOptionList>` 呼出に置き換える。 ただし以下は維持:
  - 「カテゴリ 0 件 placeholder」 は `CardTagOptionList` の `emptyPlaceholderText` に文言を渡して内部 render に統合 (popover 側の独自 placeholder JSX は削除)
  - 既存 category 行 click → setSelectedCategoryId + setStage('option') + setCreateError(null) の 3 連 setter は `onToggle` callback に集約
  - 既存 category 行 kebab → setEditTargetId + setStage('editCategory') + setLastError(null) は `onRowAction` callback に集約
- 渡す props:
  - `kind="category"`
  - `items={sortedCategories}` (既存 `sortedCategories` を流用、 既存 popover 内で sort_key ASC + created_at ASC で sort 済)
  - `selectedOptionIds={undefined}` (kind='category' なら無視される、 明示渡しは不要だが TypeScript 型上 optional)
  - `selectType={undefined}`
  - `onToggle={(categoryId) => { setSelectedCategoryId(categoryId); setStage('option'); setCreateError(null) }}`
  - `onRowAction={(categoryId) => { setEditTargetId(categoryId); setStage('editCategory'); setLastError(null) }}`
  - `onCreateNew={async (name) => { setPendingCategoryName(name); setStage('createCategoryType'); setCreateError(null) }}`
  - `createError={null}` (stage='category' では createError は表示しない、 失敗 inline error は型選択 stage に出す。 stage 遷移で createError が leak しないよう Task 4 で reset 配線を確認)
  - `selectedCategoryId={undefined}`
  - `suppressCreateOnExactMatch={false}` (category 同名許容、 §spec 設計判断 3)
  - `searchPlaceholder="検索 or 新規作成"`
  - `searchAriaLabel="category を検索 / 新規作成"`
  - `emptyPlaceholderText="下の入力欄に名前を入れて『新規作成』 で追加できます"`
- 旧「+ カテゴリを追加」 row JSX (Tag-4c-2a Task 3 で `card-tag-add-popover.tsx:317-329` に追加) を**削除**
- stage='category' の `categories.length === 0` placeholder JSX (Tag-4c-2a Task 3 で `:267-272`) を**削除** (`CardTagOptionList` 側の `emptyPlaceholderText` に統合)
- 内部 state 追加: `pendingCategoryName: string | null` (default null)。 popover close + stage 遷移で reset
- 旧 createCategory 関連 state (`createForm`, `createNameInputRef`) は Task 3 で削除、 本 Task では `pendingCategoryName` 追加と既存 state は残す

**完了条件:**

- stage='category' の JSX が `<CardTagOptionList kind="category" ... />` 1 行 (+ 渡す props block) に置き換わっている
- 既存 category 行 click → stage='option' 遷移 regression なし (test で確認)
- 既存 category 行 kebab → editCategory 遷移 regression なし (test で確認)
- combobox input + filter (部分一致 / 大小無視) が stage1 で動く
- 完全一致 category 名でも「+ 新規作成: {入力値}」 行が出る (option stage2 では出ない、 regression)
- 「新規作成」 click → `setPendingCategoryName(name)` + `setStage('createCategoryType')` + `setCreateError(null)`
- 「+ カテゴリを追加」 row が DOM に存在しない (`queryByText('+ カテゴリを追加')` が null)
- カテゴリ 0 件で新文言 placeholder が表示される
- 旧 createCategory stage は Task 3 まで残るため本 Task では削除しない (Task 3 まで動作可能な中間状態を許容)
- `pnpm test` 全件緑、 `pnpm build` 緑

---

### Task 3: 旧 `'createCategory'` stage 撤廃 + 新 `'createCategoryType'` stage 追加 + Esc 階層差し替え + popover close reset 更新

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx`

**目的:** stage 列挙を `'createCategory'` → `'createCategoryType'` に置換、 旧 createCategory stage の JSX + state + handler を削除、 新 createCategoryType stage を inline JSX で追加、 Esc 階層と popover close reset を更新。

**制約:**

- stage 型を `'category' | 'option' | 'editCategory' | 'editOption' | 'createCategoryType'` に変更 (5 値、 旧 createCategory は撤廃)
- 削除対象 (Tag-4c-2a Task 3 由来):
  - state: `createForm: { name; selectType }`、 `createNameInputRef`
  - handler: `handleCreateCategorySubmit`
  - JSX: createCategory stage の中身全体 (`card-tag-add-popover.tsx:504-593` 周辺)
  - useEffect: createCategory stage の mount focus effect (`createNameInputRef` 用)
- 残置:
  - `pendingCategoryName: string | null` (Task 2 で導入)
  - `createError: string | null` (createCategoryType stage の inline error 用に流用)
  - `isSubmittingCreate: boolean` (二重発火ガード用、 流用)
- 新 createCategoryType stage の中身 (inline JSX、 ~40 行、 `<Popover` の `<PopoverContent>` 内に stage 条件分岐で追加):
  - back button「← カテゴリ選択へ戻る」、 click で `setStage('category'); setPendingCategoryName(null); setCreateError(null)`
  - 見出し: `「{pendingCategoryName ?? ''}」 の種別を選択` (h2 相当の `<div className="px-3 py-2 text-sm font-medium">`)
  - 2 button (縦並び):
    - 「単一 (single)」 button + 説明「1 つの card にこのカテゴリの option は最大 1 つ」 (`<p className="text-xs text-slate-500">`)
    - 「複数 (multi)」 button + 説明「1 つの card にこのカテゴリの option を複数付与できる」
    - 両 button onClick (共通 handler、 selectType を引数で受ける):
      ```ts
      const handleConfirmType = async (selectType: 'single' | 'multi') => {
        if (isSubmittingCreate || !pendingCategoryName) return
        setIsSubmittingCreate(true)
        try {
          const { id } = await tagEditCallbacks.createCategory(pendingCategoryName, selectType)
          setSelectedCategoryId(id); setStage('option'); setPendingCategoryName(null); setCreateError(null)
        } catch {
          setCreateError('作成に失敗しました')
        } finally {
          setIsSubmittingCreate(false)
        }
      }
      // single button: onClick={() => handleConfirmType('single')}
      // multi button:  onClick={() => handleConfirmType('multi')}
      ```
    - `disabled={isSubmittingCreate}` を両 button に付与
  - 「複数 (multi)」 button に default focus: `useEffect(() => { if (stage === 'createCategoryType') multiButtonRef.current?.focus() }, [stage])`、 ref は `useRef<HTMLButtonElement>(null)`
  - inline error: createError 非 null なら 2 button の下に `<p role="alert" className="text-xs text-red-600 mt-1">{createError}</p>`
- **Esc 階層** (5 stage、 旧 createCategory 分岐を createCategoryType 分岐に差し替え):
  ```ts
  onEscapeKeyDown={(e) => {
    if (stage === 'editCategory')         { e.preventDefault(); setStage('category') }
    else if (stage === 'editOption')        { e.preventDefault(); setStage('option') }
    else if (stage === 'createCategoryType'){ e.preventDefault(); setStage('category'); setPendingCategoryName(null); setCreateError(null) }
    else if (stage === 'option')            { e.preventDefault(); setStage('category'); setCreateError(null) }
    // stage 'category' は shadcn 標準
  }}
  ```
- popover close (`onOpenChange`) reset 更新: `setPendingCategoryName(null)` を追加、 旧 `setCreateForm(...)` を削除、 既存 reset (stage / selectedCategoryId / editTargetId / lastError / createError / isSubmittingCreate) は維持
- `grep` で caller / dead reference を verify (`createForm`、 `handleCreateCategorySubmit`、 `createNameInputRef`、 旧 stage 文字列 `'createCategory'` 全て 0 件)

**完了条件:**

- stage 型 5 値で `'createCategory'` が存在しない、 `'createCategoryType'` が存在する
- 旧 createCategory stage の JSX / state / handler / ref / useEffect が全て削除 (`grep -n` で 0 件確認)
- 新 createCategoryType stage の見出し / 2 button / back / inline error / multi default focus が render される
- single button click → `createCategory(name, 'single')` 呼出、 成功 stage='option' + selectedCategoryId=新 id + pendingCategoryName=null + createError=null、 失敗時 stage 留まり + inline error
- multi button click → 同様、 `createCategory(name, 'multi')`
- 両 button とも `isSubmittingCreate` true 時は no-op (連打防止)
- Esc on createCategoryType → category + pendingCategoryName=null + createError=null
- Esc on 他 stage は regression なし (4 stage の遷移)
- popover close → 全 state reset (pendingCategoryName 含む、 旧 createForm reset は **コード上から消えている**)
- 既存 add フロー / Tag-4c-1 編集フロー / Tag-4c-2a Task 3 の double-fire guard regression なし
- `pnpm test` 全件緑、 `pnpm build` 緑、 tsc strict 緑

---

### Task 4: `CardTagEditPopover` の `kind="option"` 明示渡し + createError leak 確認 + 全体 regression

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.test.tsx`

**目的:** バッジ click 経路 (`CardTagEditPopover`) で `<CardTagOptionList>` に `kind="option"` を **明示指定** (default 動作と同じだが explicit、 将来 default が変わったときの regression を防ぐ)。 同時に createError leak / Tag-4c-2a Task 4 で実装した挙動が変わらないことを確認。

**制約:**

- `card-tag-edit-popover.tsx` の `<CardTagOptionList>` 呼出に `kind="option"` を 1 行追加 (他の props は無改修)
- 既存 `selectedCategoryId={category.id}`、 `onCreateNew={...}`、 `createError={createError}`、 `onToggle`、 `onClose`、 `onRowAction`、 `options`、 `selectedOptionIds`、 `selectType` の渡し方は維持
- 新 props は明示渡し不要 (default で OK):
  - `suppressCreateOnExactMatch` は default `true` (option 既存挙動)
  - `searchPlaceholder` / `searchAriaLabel` / `emptyPlaceholderText` は default
- 既存 popover state (`createError`、 `isSubmittingCreate`、 `stage`、 `lastError`、 `editTargetId`) は無改修
- regression scope:
  - Tag-4c-2a Task 4 全観点 (combobox + 新規作成 + 即付与 + double-fire guard + popover close reset + category-create UI 非表示) 維持
  - Tag-4c-1 編集系 (rename / color / delete / Esc / kebab) 維持

**完了条件:**

- `kind="option"` が JSX に明示渡しされている (test で props 確認 or DOM 経由の Check icon 表示確認)
- Tag-4c-2a Task 4 全 test 緑 (regression 完全維持)
- Tag-4c-1 edit-popover 全 test 緑
- combobox 完全一致時に新規作成行が出ない (suppress default 維持 = option 挙動)
- `pnpm test` 全件緑、 `pnpm build` 緑

---

### Task 5: smoke checklist + amend commit + (push なし)

**Files:**
- Create: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-smoke-checklist.md`
- (Task 1-4 の全変更を `b1fbe89` に `git commit --amend` で畳む)

**目的:** stg 実機 smoke 観点 16 個を網羅した checklist を作り、 全変更を **`b1fbe89` に amend** で畳む (別 commit を積まない、 OT が `--force-with-lease` で push)。

**制約:**

- smoke checklist file (~50-60 行) 検証カテゴリ:
  1. stage1 combobox: 上部 input + filter (部分一致 / 大小無視) + 末尾「+ 新規作成」 行 (観点 1-4)
  2. 完全一致 category 名でも新規作成行が出る (option との挙動差、 観点 5)
  3. 既存 category 行 click / kebab → 既存遷移 (regression、 観点 6-7)
  4. 「+ 新規作成」 click → 型選択 stage 遷移 (まだ作成されない、 観点 8)
  5. 型選択 stage の見出し / 2 button (multi default focus) / back / inline error 領域 (観点 9-11)
  6. single / multi 各 button click → category 即作成 + stage='option' 自動遷移 (観点 12-13)
  7. 作成失敗時 stage 保持 + inline error + 連打防止 (観点 14)
  8. Esc 5 stage (createCategoryType → category 含む) regression なし、 popover close reset 観測 (観点 15)
  9. console error 0 + Tag-4c-2a 全 20 観点 + Tag-4c-1 全 15 観点 regression なし (観点 16)
- amend 手順 (Claude Code が実行、 push しない):
  1. Task 1-4 の変更が working tree にあることを確認 (`git status`)
  2. smoke checklist file 追加 (`git add docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-smoke-checklist.md`)
  3. Task 1-4 の source / test 変更を add (`git add 'app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx' 'app/(app)/app/exams/[id]/_components/card-tag-option-list.test.tsx' 'app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx' 'app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx' 'app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx' 'app/(app)/app/exams/[id]/_components/card-tag-edit-popover.test.tsx'`)
  4. `git commit --amend --no-edit` で b1fbe89 message そのまま amend (or OT が message 差分追記したい場合は `git commit --amend` でエディタを開く形)。 **default は `--no-edit`** (Claude Code が勝手に message を変えない)
  5. `git status` で working tree clean + `git log -1 --stat` で amend 反映確認 (commit hash は変わる、 元 b1fbe89 → 新 hash)
- push 手順 (Claude Code は実行しない、 OT が後続で実行):
  - 事前確認: `git log --oneline origin/develop..HEAD` で origin との差分確認
  - origin に b1fbe89 が push 済の場合: `git push --force-with-lease origin develop` (OT が実行)
  - origin に b1fbe89 が未 push の場合: 通常の `git push origin develop` (OT が実行) → ただし本 sprint kickoff 時点で OT 認識として「b1fbe89 は push 済」 と明示があるため、 force-with-lease を default 想定

**完了条件:**

- smoke checklist file 作成、 16 観点列挙
- `pnpm test` 全件緑
- `pnpm build` 緑
- TypeScript strict 緑
- `git commit --amend --no-edit` 実行後、 working tree clean + Task 1-5 の全変更が単一 commit (新 hash) に統合済
- push は **実行しない** (停止、 OT smoke 後に OT が force-with-lease push)

---

## Plan 完了後の OT smoke (push 前停止後)

OT 確認: smoke checklist の 16 観点を順次 PASS / FAIL で記録。 特に:
- stage1 combobox UX (option stage2 と同 UX、 category 行に kebab + 検索 + 新規作成行が共存)
- 完全一致でも「+ 新規作成」 行が出る (同名作成許容、 schema 仕様反映)
- 「+ 新規作成」 click → 型選択 stage の流れ (新規作成が即実行されず、 型選択を 1 段挟むこと)
- multi default focus (Enter 即決定が効くこと)
- 旧「+ カテゴリを追加」 button + 旧 createCategory stage の DOM 完全消滅

smoke 確認 OK の後、 OT が `git push --force-with-lease origin develop` を実行 (Claude Code は push しない)。

行数: ~288 行 (300 cap 内、 目安 150-250 超過。 旧 stage 撤廃 + 新 stage 追加 + generalize の 3 軸を 5 task に詰め込んだため。 smoke checklist は別 file 化で本体圧縮済)。
