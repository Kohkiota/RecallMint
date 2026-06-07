# Tag-4c-1: card-tags popover 内 category/option 編集 (rename + color + 削除) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 各 task 完了条件は `pnpm test` + `pnpm build` 緑。 全 task 完了後に **単一 commit** (Task 5 末)。 push しない (OT が stg smoke)。

**Goal:** 試験詳細 (`/app/exams/[id]`) の card-tags popover 内で、 category / option の rename・color 変更・削除を Notion 方式の「...」kebab から行えるようにする。 タグ管理画面 (`/app/tags`) は据置。

**Architecture:** Tag-4b-fix の 2 stage popover (`CardTagAddPopover`) の stage 状態を `'category' | 'option' | 'editCategory' | 'editOption'` に拡張、 stage1/2 の各行末尾に kebab を追加。 バッジ click から開く `CardTagEditPopover` にも option 行 kebab + `editOption` stage を追加。 optimistic logic は `CardTagsSection` に集約維持、 popover は callback ベース presentation。 atomic 戦略は触る store 数で分岐 (rename/color = enqueue await + revert / delete = same-tx atomic、 commit 327a385 reference 実装)。

**Tech Stack:** Next.js 15 / shadcn Popover (既存) / lucide-react (既存、 `Ellipsis` 追加使用) / Dexie + dexie-react-hooks / 既存 `ColorPalettePopover` / 既存 `DeleteConfirmDialog` / Vitest + RTL。 **npm dep 追加なし**。

**前提:**
- Tag-4b-fix 着地済 (commit `327a385`)、 atomic tx + JWT 由来 user_id reference 実装
- 既存 server apply 経路 (`lib/tags/apply-tag-mutation.ts`) + pull 経路 (`lib/sync/pull.ts` tombstones 含む) は無改修
- 既存 tags/_components/* (manager) は本 sprint **据置** (旧 void enqueue / 空文字 user_id pattern コピー禁止、 Sync-fix-1 で一斉差し替え予定)
- 既存資産流用: `lib/tags/color-palette.ts` (`colorToClass`, `TAG_COLOR_NAMES`)、 `app/(app)/app/tags/_components/color-palette-popover.tsx` (`ColorPalettePopover`)、 `app/(app)/app/tags/_components/delete-confirm-dialog.tsx` (`DeleteConfirmDialog`、 props: `targetKind/targetName/cardCount`)
- toast 機構 project 未実装 (grep 確認済) → error 表示は popover 内 inline (rename input 直下に赤テキスト)
- category color は popover 編集 stage で出すが manager 側 (`category-row.tsx`) は据置 (一時的に非対称、 保存値は同じ `tag_categories.color` でデータ整合)

**維持する設計 (Tag-4b-fix 継承、 不変):**
- whole-set 不変条件 (他カテゴリ落とし回避)
- single 最大 1 個・0 個許容
- 案 a 取り直し (cards.updated_at bump → pull)
- parent `InlineCardList` 一括 subscribe + useMemo + 子 `React.memo`
- popover 2 stage 構造 (Notion 方式) + Esc 階層
- npm dep 追加ゼロ
- user_id は親 prop の auth() 由来値 (空文字禁止)

**全 task 共通ルール:**

- TypeScript strict、 既存 Client Component pattern 踏襲
- 削除 = same-tx atomic (`db.transaction('rw', store1, store2, ..., async () => { mirror ops + enqueue })`、 失敗時 Dexie auto-rollback)、 touch する全 store + `entity_mutations` を tx に寄せる
- rename / color 変更 = enqueue await + 失敗時 mirror revert (overspec の same-tx は使わない、 単一 store のため)
- 全 UI 文言は日本語、 Tailwind class は既存 slate 系で統一
- error 表示は popover 内 inline (`<p className="text-xs text-red-600 mt-1">{message}</p>` 等)
- 削除後・rename 後は popover open のまま (適切な stage に戻る or stay)
- 全 task 完了後に **単一 commit** (Task 5 末で):
  ```
  feat(tag): Tag-4c-1 popover 内 category/option 編集 (rename + color + 削除) [no-review]
  ```
- push しない (OT が stg smoke)

---

### Task 1: `CardTagsSection` に rename / color / delete handlers + 影響範囲 count helper

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx`

**目的:** popover から callback で呼び出す 6 handlers + 2 count helpers を section に集約。 popover は presentation only を維持。

**制約:**
- 追加 handlers:
  - `handleRenameCategory(categoryId, newName) → Promise<void>`、 `handleSetCategoryColor(categoryId, color | null) → Promise<void>`: 単一 store (`tag_categories`) + enqueue。 mirror.update を **await** → enqueueEntityMutation を await → flush は void fire-and-forget。 enqueue が throw したら mirror を更新前値に **revert** (try/catch で元値を保持)。
  - `handleRenameOption(optionId, newName)`、 `handleSetOptionColor(optionId, color | null)`: 単一 store (`tag_options`) で同上。
  - `handleDeleteCategory(categoryId) → Promise<void>`: **same-tx atomic** = `db.transaction('rw', db.card_tags, db.tag_options, db.tag_categories, db.entity_mutations, async () => { 配下 option 列挙 → card_tags anyOf delete → tag_options where category_id delete → tag_categories delete → enqueueEntityMutation({entity_type:'tag_category', op:'delete'}) })`。 Dexie auto-rollback。
  - `handleDeleteOption(optionId)`: **same-tx atomic** = `db.transaction('rw', db.card_tags, db.tag_options, db.entity_mutations, ...)`、 `card_tags.where('option_id').equals(optionId).delete() → tag_options.delete(optionId) → enqueueEntityMutation({entity_type:'tag_option', op:'delete'})`。
- 追加 count helpers (popover 側 ConfirmDialog 表示用に呼ばれる、 props.callback で section から popover に渡す):
  - `countCategoryImpact(categoryId) → Promise<{optionCount, cardCount}>`: 既存 `category-list.tsx:71-83` pattern を再現 (option 列挙 → 各 option の card_tags count 合算)。
  - `countOptionImpact(optionId) → Promise<{cardCount}>`: `db.card_tags.where('option_id').equals(optionId).count()`。
- user_id は既存 props.userId (Tag-4b-fix で配線済) を使用、 空文字禁止。
- 旧 tags/_components の `void` 並列発行 / 空文字 user_id パターンは **コピー禁止** (Tag-4b-fix reference 実装で書く)。
- popover 側に渡す callbacks は単一 props object `tagEditCallbacks` でまとめると prop 数膨張を抑制 (orchestrator → popover の interface を 1 つに固定)。

**完了条件:**
- 6 handlers + 2 count helpers の unit test 緑:
  - rename / color: mock spy の呼出順 (mirror.update await → enqueue await → flush) + enqueue throw 時 mirror が元値に revert + props.userId が put に乗る
  - **color null 往復 (反映3)**: 元値 null → 新値 null は no-op (mirror/enqueue 呼ばれない可) も含めて挙動を pin、 元値 null + 新値 red → enqueue throw → mirror が **null** に正しく revert される (空文字 `''` や `undefined` に化けない) を 1 ケース追加
  - delete: `db.transaction` が touch する全 store + `entity_mutations` を rw lock する (mock transaction の引数 verify)
  - count: 期待 count 値返却
- `pnpm test` 全件緑、 `pnpm build` 緑、 tsc strict 緑

---

### Task 2: `card-tag-edit-fields` 共通 sub-component (rename + color + delete + inline error)

**Files:**
- Create: `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx`
- Create: `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.test.tsx`

**目的:** 編集 stage (`editCategory` / `editOption`) の中身を 1 component に。 rename input + color picker trigger (既存 `ColorPalettePopover` 子) + 削除 button + inline error 表示 + `DeleteConfirmDialog` orchestration を集約。

**制約:**
- presentation only、 mutation logic は parent (CardTagAddPopover / CardTagEditPopover) から callback 経由で受領。
- props: `{kind: 'category' | 'option', name: string, color: string | null, onRename: (next: string) => Promise<void>, onColorChange: (next: TagColorName | null) => Promise<void>, onDelete: () => Promise<void>, countImpact: () => Promise<{optionCount?: number, cardCount: number}>, errorMessage: string | null}` (errorMessage は親が rename/color/delete の reject 時に注入)
- rename input: Enter / Blur で `onRename` (空 / 変更なし short-circuit、 既存 `category-row.tsx:112-121` pattern)、 Esc で input から focus blur (stage 自体は閉じない、 親 popover の onEscapeKeyDown で stage 遷移)
- color picker: `<ColorPalettePopover value={color} onChange={onColorChange}>` の trigger は色 pill button、 開閉は ColorPalettePopover 内部 state で自動管理 (auto-close 既存)
- 削除 button: 既存 `DeleteConfirmDialog` の props (`targetKind`, `targetName`, `childOptionCount?`, `cardCount`) は **無拡張で再利用** (grep 確認済、 manager 波及なし)。 `category` kind は `<DeleteConfirmDialog targetKind="category" targetName={name} childOptionCount={impact.optionCount} cardCount={impact.cardCount}>` を渡し、 既存 dialog 既出文言「配下の option N 件、 紐付き card M 件のタグも消えます」 を流用。 `option` kind は `<DeleteConfirmDialog targetKind="option" targetName={name} cardCount={impact.cardCount}>`。 onClick で countImpact を呼んで pending state → 確定で onDelete。
- **削除 reject 時 inline error (反映1)**: onDelete callback (= Task 3/4 で section の deleteCategory/deleteOption を await する path) が throw した場合、 DeleteConfirmDialog を閉じた後 編集 stage に留まり、 inline error として「削除に失敗しました」 を rename input 直下と同じ位置に赤テキスト + `role="alert"` で表示。 dialog 確定後の無反応は禁止。 親 (Task 3/4) が `errorMessage="削除に失敗しました"` を本 component に注入する形で達成。
- inline error: errorMessage が非 null なら rename input 直下に `<p className="text-xs text-red-600 mt-1" role="alert">{errorMessage}</p>`
- color picker open 中の Esc: shadcn `ColorPalettePopover` 内部で消費されて閉じる (z 順は radix が auto 管理)、 親 stage の Esc には propagate されない (Radix Popover の標準動作)。 test で「color picker open 中 Esc → picker のみ閉じ stage は editCategory のまま」 を verify。

**完了条件:** rename Enter / Blur で onRename 呼出 + space-only や同値で short-circuit、 color 選択で onColorChange 呼出、 delete button click → ConfirmDialog 表示 → 確定で onDelete (cancel で no-op)、 errorMessage 表示 + role="alert" 付与、 color picker open 中 Esc が parent に propagate しない、 各テスト緑

---

### Task 3: `CardTagAddPopover` stage 拡張 + stage1/2 kebab + 編集 stage 配置 + Esc 階層

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx`

**目的:** stage を 4 値 (`'category' | 'option' | 'editCategory' | 'editOption'`) に拡張、 stage1/2 各行末尾に kebab、 click で同一 popover の編集 stage に遷移、 Esc 階層を実装、 `CardTagEditFields` を編集 stage に配置。

**制約:**
- 追加 props: `tagEditCallbacks: {renameCategory, setCategoryColor, deleteCategory, renameOption, setOptionColor, deleteOption, countCategoryImpact, countOptionImpact}` (Task 1 で section から渡す)
- 内部 state 追加: `editTargetId: string | null` (現編集 target の category_id or option_id)、 `lastError: string | null` (rename/color/delete reject 時の inline error)
- stage1 (category list) 各 row: 既存 button + 「...」 kebab span を末尾に追加。 kebab は `<span role="button" aria-label={`カテゴリ操作: ${category.name}`} tabIndex={0} onClick={(e) => { e.stopPropagation(); setEditTargetId(category.id); setStage('editCategory'); setLastError(null) }} className="ml-auto inline-flex h-7 w-7 items-center justify-center cursor-pointer hover:bg-slate-100 rounded">` 内側に `<Ellipsis className="h-4 w-4 text-slate-500" aria-hidden="true" />`。 既存 row の `<ChevronRight />` は kebab の左に置く。 `cursor-pointer` 必須。
- stage2 (option list) 各 row: 同様に kebab span を末尾に追加。 ただし stage2 は `CardTagOptionList` (Task 2 / Tag-4b-fix 共通 sub) を使うため、 そこに新規 props `onRowAction?: (optionId: string) => void` を追加して各 option 行の右に kebab を render する形 (CardTagOptionList を最小改修)。 onRowAction は popover 側で `(optionId) => { setEditTargetId(optionId); setStage('editOption'); setLastError(null) }`。
- 編集 stage の中身: `<CardTagEditFields kind='category'|'option' name={...} color={...} onRename={async (n) => { try { await tagEditCallbacks.renameCategory(editTargetId, n); setLastError(null) } catch(e) { setLastError(String(e)) }} onColorChange={...} onDelete={async () => { try { await tagEditCallbacks.deleteCategory(editTargetId); /* 削除成功: stage='category' に戻す */ setEditTargetId(null); setStage('category'); setLastError(null) } catch(e) { /* 反映1: 削除 reject 時は編集 stage に留まり inline error */ setLastError('削除に失敗しました') } }} countImpact={() => tagEditCallbacks.countCategoryImpact(editTargetId)} errorMessage={lastError} />`
- editCategory stage の header: ← back button「カテゴリ選択へ戻る」 (既存 stage2 と同型)、 click で `setStage('category')`
- editOption stage の header: ← back button「option 一覧へ戻る」、 click で `setStage('option')` (editTargetId と stage='option' の selectedCategoryId は維持)
- footer link は editCategory / editOption stage でも footer に「タグ管理 →」 link を維持 (既存 stage と同型)
- **Esc 階層 (Notion 方式拡張)**:
  - `onEscapeKeyDown={(e) => { if (stage === 'editCategory') { e.preventDefault(); setStage('category') } else if (stage === 'editOption') { e.preventDefault(); setStage('option') } else if (stage === 'option') { e.preventDefault(); setStage('category') } }}`
  - stage 'category' の Esc は shadcn 標準 (popover 閉じる) で何もしない
  - 注意: color picker open 中の Esc は radix の Popover stack の上層で消費される (`ColorPalettePopover` が consume) ため、 親 `onEscapeKeyDown` には到達しない (Task 2 で test 済)
- popover close 時に state reset: 既存 `onOpenChange` で `setStage('category')`、 さらに `setEditTargetId(null)`、 `setLastError(null)` を追加
- 削除成功時の遷移ルール: category 削除 → 親 InlineCardList の useLiveQuery が再描画 → 当該 category 配下の cardTags も IDB cascade で消えるため、 該当 card のバッジも optimistic で消える (Tag-4b-fix 配線で達成済)。 popover は `stage='category'` に戻り、 editTargetId=null。 option 削除も同様 (option 単位の cascade)。
- rename / color 成功時: stage は editCategory / editOption に stay、 lastError=null

**完了条件:** stage 拡張 + kebab click 4 種 + 編集 stage 表示 + Esc 階層全パターン (editCategory→category, editOption→option, option→category, category→close) + rename / color / delete callback 呼出 + 削除成功で stage='category' or 'option' に戻る + lastError 表示 + popover close で state reset + 既存 add フロー (Tag-4b-fix) regression なし、 の各テスト緑

---

### Task 4: `CardTagEditPopover` にも option 行 kebab + `editOption` stage 追加

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx`
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.test.tsx`

**目的:** バッジ click で開く popover (該当カテゴリの options 単 stage) の各 option 行にも kebab を追加、 同一 popover 内で `editOption` stage に遷移できるようにする (UI 一貫性)。 category 編集はバッジ動線がないため scope 外。

**制約:**
- 追加 props: Task 3 と同じ `tagEditCallbacks` の subset (`renameOption`, `setOptionColor`, `deleteOption`, `countOptionImpact` のみ必要)
- 内部 state 追加: `stage: 'option' | 'editOption'`、 `editTargetId: string | null`、 `lastError: string | null`
- 既存 stage='option' (default) で option 一覧表示 (`CardTagOptionList` 流用、 Task 3 で追加した `onRowAction` props を使用)
- kebab click → setStage('editOption') + setEditTargetId
- editOption stage の中身: Task 3 と同じ `<CardTagEditFields kind='option' ... />`。 onDelete reject 時は Task 3 と同様に `setLastError('削除に失敗しました')` で stage に留まり inline error 表示 (反映1)
- editOption stage header: ← back button「タグ一覧へ戻る」、 click で setStage('option')
- Esc 階層: editOption → option (`onEscapeKeyDown`)、 option → close (shadcn 標準)
- popover open は `<PopoverTrigger asChild>{children}</PopoverTrigger>` (children = badge) で既存 maintained
- popover close 時に state reset (`setStage('option')`, `setEditTargetId(null)`, `setLastError(null)`)
- 削除成功時: 該当 option が消える → 親 useLiveQuery 再描画 → そのバッジ自体も消える (PopoverTrigger が unmount) → popover も結果的に閉じる (radix の standard)。 明示的な close は不要。
- rename / color 成功時: editOption stage に stay

**完了条件:** option 行 kebab + editOption stage + Esc editOption→option→close + rename / color / delete callback 呼出 + 削除成功で バッジ消滅 → popover unmount + 既存バッジ click → option 表示の regression なし、 の各テスト緑

---

### Task 5: badge × cursor-pointer + section から popover への callbacks 配線 + smoke checklist + 統合 commit

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-badge.tsx` (1 行: × span に `cursor-pointer` class 追加)
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-badge.test.tsx` (確認 1 行)
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (Task 3/4 popover に `tagEditCallbacks` props を渡す)
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx` (regression)
- Create: `docs/superpowers/plans/2026-06-08-tag-4c-1-smoke-checklist.md`

**目的:** badge × に cursor-pointer 付与、 section から CardTagAddPopover / CardTagEditPopover に Task 1 の handlers を props 経由で配線、 smoke checklist 作成、 全変更を 1 commit。

**制約:**
- badge × span: 現状 `className="ml-0.5 hover:text-slate-900"` (`card-tag-badge.tsx:73` 周辺) に `cursor-pointer` を追加。 tabIndex={0} と role="button" はそのまま。
- section から popover への配線: Task 1 で実装した 6 handlers + 2 count helpers を `tagEditCallbacks` object にまとめて `<CardTagAddPopover ... tagEditCallbacks={tagEditCallbacks} />`、 `<CardTagEditPopover ... tagEditCallbacks={tagEditCallbacks} />` で渡す。 useMemo で object identity を安定化 (子 React.memo で再描画 skip するため)。
- smoke checklist (~80 行、 plan 同梱):
  1. + タグ追加 popover stage1 各 category 行に kebab 表示
  2. kebab click → editCategory stage に遷移 (rename input + color pill + 削除 button)
  3. editCategory stage Esc → category list (stage1) に戻る
  4. rename input Enter → category 名が即変更 + 該当 card のバッジ表示も更新 (id 参照で全 card 即連動)
  5. color picker open 中 Esc → picker のみ閉じ editCategory stage は維持
  6. category 削除 button → DeleteConfirmDialog (配下 N option + M card)、 確定で popover が stage1 に戻り、 該当 card のバッジも消える
  7. + タグ追加 popover stage2 各 option 行に kebab 表示
  8. kebab click → editOption stage に遷移
  9. editOption stage Esc → option list (stage2) に戻る
  10. option rename / color 変更 / 削除 が atomic 反映 + reload 後維持
  11. バッジ click → CardTagEditPopover の option list に kebab 表示
  12. kebab click → editOption stage → rename / color / 削除 動作
  13. badge × に hover cursor-pointer
  14. 同名 rename 衝突 → inline error 赤テキスト (rename input 直下)
  15. console error 0、 regression なし (Tag-4b-fix 全 14 観点 + fix-3 観点維持)
- commit message: `feat(tag): Tag-4c-1 popover 内 category/option 編集 (rename + color + 削除) [no-review]`

**完了条件:**
- `pnpm test` 全件緑 (新規 + 改修分)
- `pnpm build` 緑
- TypeScript strict 緑
- 全変更 (Task 1-5) を **1 commit** で develop に積む

---

## Plan 完了後の OT smoke (push 前停止後)

OT 確認: 上記 15 観点を順次 PASS/FAIL で記録。 特に「kebab → 編集 stage → Esc 階層」 の 4 stage popover 操作感と、 category 削除時の影響範囲 dialog + 削除後バッジ optimistic 消失を実機確認。

行数: 約 220 行 (目安 150-250 内)。
