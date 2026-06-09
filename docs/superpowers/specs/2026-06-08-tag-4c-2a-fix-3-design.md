# Tag-4c-2a-fix-3: 幅揃え + 見出し削除 + multi icon CheckSquare + category 行 select_type icon

## Goal

Tag-4c-2a-fix-2 着地後の OT 実機確認で見つかった 4 つの見た目修正を当てる:

1. **Fix-1**: stage1 (category combobox) box と型選択 stage (`createCategoryType`) box の**幅を揃える**
2. **Fix-2**: 型選択 stage の見出し行 `「{pendingCategoryName}」 の種別を選択` を**削除** (stage は維持、 中身は 2 button のみ)
3. **Fix-3**: 型選択 stage の multi button icon を `ListChecks` → `CheckSquare` に変更 (☑ 視覚と一致)
4. **Fix-4**: stage1 の category 一覧各行の左端に select_type icon (single = `CircleDot` ⦿ / multi = `CheckSquare` ☑) を表示。 category と option の見分けを視覚的にする (option 行はアイコン無し維持)

## 背景・問題

Tag-4c-2a-fix-2 (amend 後 commit `4ac85b5`) で型選択 stage が Notion 風 2 行 button + 見出しに整理されたが、 OT 実機検証で以下が判明:

- **指摘 1**: stage1 (category 一覧 combobox) と型選択 stage の box 幅が**揃っていない** — popover の最大幅は `max-w-sm` だが内側 wrapper の構造が異なり、 体感で幅がズレている
- **指摘 2**: 型選択 stage の見出し行は冗長 — 直前に「+ 新規作成: {名前}」 を click した文脈で十分、 見出しがあると 2 button のコンパクト性が損なわれる
- **指摘 3**: `ListChecks` icon は OT 指定 (☑) と異なる — multi の意味を直感的に伝える ☑ 系として `CheckSquare` に揃える
- **指摘 4**: category 一覧と option 一覧が見た目で区別つかない — 両方とも色付き名前のみで、 ユーザーが「今どっちの一覧を見ているか」 即判別できない。 category 行に「型を持つ = カテゴリ」 を示すアイコンを添えて視覚区別する

修正方針 (本 sprint):
- **全て見た目のみの修正、 挙動変更なし** (型選択 stage 方式維持 / multi default focus / Esc 階層 / 二重発火ガード / Fix-2 同名抑制 / Fix-3 全選択 focus 全て不変)
- インライン展開 (combobox 内に折り込む) は採用せず、 stage 方式維持

## Scope

### In scope (Tag-4c-2a-fix-3)

**Fix-1. 幅揃え (stage1 combobox ↔ 型選択 stage)**
- Step 0 Q1 で確認: 両 stage とも outer は `<div className="py-1">`、 popover content は `w-auto max-w-sm p-0`
- 幅差の根本原因: stage1 の `CardTagOptionList` 内側 input 容器 (`<div className="px-2 pb-1">`) と、 型選択 stage の `<div className="py-1">` 内 button (`flex w-full ... px-2 py-1.5`) で**入れ子の padding 構造が異なる**
- 採用方針: 型選択 stage の outer 構造を `CardTagOptionList` と**同等の入れ子 padding** に揃える:
  - 型選択 stage は現状 `<div className="py-1"> + 見出し + button × 2 + error`、 ここに `CardTagOptionList` と一致させる shape を導入
  - **具体的には**: 型選択 stage の outer を `<div className="py-1">` のまま、 button block を `<div className="px-2 pb-1"> ... </div>` 等で wrap し input 列と padding を揃える。 ただし button 自体の class はそのまま (Fix-2 で見出し削除と同時に整える)
- 期待挙動: stage1 input の左右余白と 型選択 stage button の左右余白が **px 単位で一致** (実機目視 + DevTools 確認)

**Fix-2. 型選択 stage の見出し削除**
- 現状 (`card-tag-add-popover.tsx:505-507` 周辺): `<div className="px-2 py-1 text-xs text-slate-500">「{pendingCategoryName ?? ''}」 の種別を選択</div>`
- これを**完全削除** (a11y 影響なし: Step 0 Q4 で `aria-labelledby` 参照ゼロ確認)
- 削除後の stage 内容: back button + 2 button (single / multi) + inline error 領域
- `pendingCategoryName` state は維持 (handleConfirmType の引数で必要)、 ただし表示には使わない
- 後で見出しが必要になった場合は別 sprint で再導入 (本 sprint で削除確定)

**Fix-3. multi icon を `ListChecks` → `CheckSquare`**
- 型選択 stage の multi button の icon を `<CheckSquare className="h-4 w-4 text-slate-500" aria-hidden="true" />` に変更
- `import { CircleDot, ListChecks }` から `import { CircleDot, CheckSquare }` に変更 (`ListChecks` を削除)
- `CheckSquare` は lucide-react 標準 export + codebase で未使用 (Step 0 Q5 確認)、 npm dep 追加なし
- 同じ `CheckSquare` を Fix-4 の category 行 (multi) にも流用 → icon 統一

**Fix-4. category 一覧行に select_type icon を表示 (kind='category' のみ)**
- `CardTagOptionList` の row JSX に、 **kind='category' かつ item.select_type が定義されている時のみ** 行頭に小 icon を render
- icon: `select_type === 'single'` → `<CircleDot className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />`、 `'multi'` → `<CheckSquare className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />`
- 配置: button 内の最初の child (color pill の前)、 既存 `gap-2` で自然に間隔がつく
- option 行 (kind='option') は icon を**出さない** (Fix-4 の目的 = category と option の視覚区別)
- icon size は `h-3.5 w-3.5` (kebab `h-4 w-4` より小、 行頭で控えめ)、 色 `text-slate-400` (淡め、 名前を主、 icon を副に)
- `TagComboboxItem` 型に `select_type?: 'single' | 'multi'` を追加 (approach A、 Step 0 Q2 確認)
  - `ClientTagCategory[]` (現 stage1 で渡している) が structural compat (`select_type` を既に持つ)、 popover 側 0 改修
  - `ClientTagOption[]` は `select_type` を持たないので undefined になる、 defensive 動作

### 維持する不変条件 (Tag-4b-fix / 4c-1 / 4c-2a / 4c-2a-fix / 4c-2a-fix-2 継承)

- whole-set 不変条件 (他カテゴリ落とし回避)
- single 最大 1 個・0 個許容
- 案 a 取り直し (cards.updated_at bump → pull)
- parent `InlineCardList` 一括 subscribe + useMemo + 子 `React.memo`
- popover stage 構造 + Esc 階層 (5 stage、 createCategoryType 含む)
- npm dep 追加ゼロ
- user_id は親 prop の auth() 由来値 (空文字禁止)
- atomic 戦略 (作成系) = same-tx atomic + Dexie auto-rollback (本 sprint touch なし)
- 既存 `tags/_components/*` (manager) は据置
- option 作成挙動は完全不変 (Tag-4c-2a / 4c-2a-fix Task 4 の挙動)
- Tag-4c-1 (rename / color / 削除 / kebab) 挙動不変
- multi default focus + Enter 即決定 (Tag-4c-2a-fix-2 Fix-1)
- 二重発火ガード (`isSubmittingCreate`、 Tag-4c-2a-fix Task 3)
- category 同名抑制 UI (Tag-4c-2a-fix-2 Fix-2)
- 編集 stage 全選択 focus (Tag-4c-2a-fix-2 Fix-3、 rAF fallback)

### Out of scope (別 sprint / 別 chore)

- **DB UNIQUE / 名前マージ** → Tag-3
- **`handleRenameCategory` trim/normalize 不整合** → 別 chore
- **D&D (C-2)** → Tag-4c-2b
- **タグ管理画面 (`/app/tags`) 撤去** → 据置
- **manager 画面 (旧 void / 空文字 user_id pattern) 差し替え** → Sync-fix-1
- **option 一覧の視覚 redesign** (本 sprint は category 行 icon 追加のみ、 option 行は不変)
- **見出し復活 / 別文言での説明テキスト追加** (Fix-2 で削除確定、 再導入は別 sprint)

## Architecture

### file 構成

**改修:**
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (+~10 行)
  - `TagComboboxItem` 型に `select_type?: 'single' | 'multi'` を追加
  - row JSX の button 内、 color pill の前に conditional icon render を追加 (`kind === 'category' && item.select_type && (...)`)
  - `import { CheckSquare, CircleDot } from 'lucide-react'` を追加 (既存 import に merge)
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (~ ±0 行 / +5 -5)
  - 型選択 stage の outer 構造を CardTagOptionList と同等の入れ子 padding に揃える (Fix-1)
  - 見出し `<div ...>「{pendingCategoryName ?? ''}」 の種別を選択</div>` を**完全削除** (Fix-2)
  - multi button icon の `ListChecks` を `CheckSquare` に変更 (Fix-3)
  - `import { CircleDot, ListChecks }` から `ListChecks` を削除 + `CheckSquare` を追加
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.test.tsx` (+~30 行)
  - category 行 select_type icon の test (single / multi / undefined の 3 case)
  - option 行 で icon が出ない regression test
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx` (~ +5 / -10 行)
  - 見出し削除 regression: 「『...』 の種別を選択」 が DOM に存在しない assert
  - multi icon test: `lucide-list-checks` → `lucide-check-square` に書き換え (Tag-4c-2a-fix-2 Task 1 の 2 test を更新)
  - 既存 ListChecks 関連 test を CheckSquare に置換 (3 件想定)

**新規作成:** なし

**不変:**
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` / `.test.tsx`
- `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx` / `.test.tsx`
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` / `.test.tsx`
- `lib/db/schema.ts` / `lib/client-db.ts` / `lib/tags/apply-tag-mutation.ts`

### 重要な設計判断

#### 1. 幅揃えは「型選択 stage を combobox の入れ子に合わせる」 (Fix-1)

Step 0 Q1 確認: stage1 の `CardTagOptionList` は内側 `<div className="px-2 pb-1">` で input を wrap、 各 row は `<button className="flex flex-1 ... px-2 py-1.5">` で flex-1 が容器幅まで広がる。 型選択 stage は `<div className="py-1">` 内に button が直接置かれている。

採用案: 型選択 stage の outer を以下構造に変更:
```tsx
<div className="py-1">
  {/* back button (既存) */}
  <div className="px-2 pt-2">{/* ChevronLeft + back text */}</div>
  {/* 2 button block (CardTagOptionList と同 padding に揃える) */}
  <div className="px-2 pb-1">
    <button className="flex w-full items-center gap-2 px-2 py-1.5 ..." onClick={() => handleConfirmType('single')}>
      <CircleDot ... /><span>シングルセレクト</span>
    </button>
    <button ref={multiButtonRef} className="..." onClick={() => handleConfirmType('multi')}>
      <CheckSquare ... /><span>マルチセレクト</span>
    </button>
  </div>
  {createError && <p role="alert" className="px-2 text-xs text-red-600">{createError}</p>}
</div>
```

**確定方針**: 上記コード例 (型選択 stage の outer を `<div className="py-1"> + <div className="px-2 pb-1">{2 buttons}</div>` に揃える) を採用。 button 自体の class は維持。 実機で px 完全一致しない場合は plan 実装中に DevTools で確認し、 `px-2 pb-1` の値を微調整 (`px-2` 固定、 `pb-1` のみ ±1-2px 範囲調整可)。

代替案 (採用せず):
- (b) `CardTagOptionList` を Wrapper として型選択 stage を子 component 化 → 過剰設計、 stage 構造を壊す
- (c) 全 stage を共通の shared shell component に抽出 → 今 sprint の scope を超える refactor

#### 2. 見出し削除は a11y 影響なし (Fix-2)

Step 0 Q4 確認:
- 見出し `<div className="px-2 py-1 text-xs text-slate-500">` には `role` / `aria-level` なし
- `aria-labelledby` で参照する要素なし (`grep aria-labelledby` で 0 件)
- 削除しても popover 全体の accessible name は変わらない (popover content の role="dialog" は shadcn 既定で content 全体を読む、 見出しテキストは見出しとして扱われていない)

採用案: 見出し JSX を**完全削除**。 `pendingCategoryName` state は内部 logic で参照 (handleConfirmType の引数に使う) のみ、 表示には不要。

#### 3. icon 統一: CircleDot (single) + CheckSquare (multi) を 2 箇所で同じ icon (Fix-3 + Fix-4)

- 型選択 stage の 2 button: `CircleDot` + `CheckSquare`
- stage1 の category 行 (multi): `CheckSquare`
- stage1 の category 行 (single): `CircleDot`
- option 行: icon なし

→ 「同じ意味 (select_type) = 同じ icon」 で視覚一貫性を担保。 ユーザーは型選択 stage で見た icon と category 行で見る icon を脳内 mapping できる。

`ListChecks` は本 sprint で**完全削除**、 codebase 内 0 件。

#### 4. category 行 icon の data path (approach A: `TagComboboxItem` に `select_type?` 追加)

Step 0 Q2 確認:
- 現状 `TagComboboxItem = { id, name, color? }` (Tag-4c-2a-fix Task 1)
- `ClientTagCategory` には `select_type: 'single' | 'multi'` が**ある**
- `ClientTagOption` には `select_type` が**ない**
- `card-tag-add-popover.tsx` stage1 で `options={sortedCategories}` (型 `ClientTagCategory[]`) を渡している

採用案 (approach A):
- `TagComboboxItem` 型に `select_type?: 'single' | 'multi'` を**optional で追加**
- `ClientTagCategory[]` は structural compat (`select_type` を持つ)
- `ClientTagOption[]` も structural compat (`select_type` を持たない → undefined)
- popover 側で渡し方を変える必要なし (`options={sortedCategories}` のまま) → 0 改修
- row render では `kind === 'category' && item.select_type` で conditional render

代替案 (採用せず):
- (b) `getSelectTypeForItem?: (id) => 'single' | 'multi' | undefined` callback prop → 親側に lookup logic を要求、 useMemo 等で stable identity 保つ必要、 過剰
- (c) 別 `categoriesMap` prop → kind discriminator の意義が薄れる + 2 つの data source 管理

採用案は最小改修・最大整合。

#### 5. icon 配置: button 内の最初の child (color pill の前) (Fix-4)

Step 0 Q3 確認: 現 row JSX は `<button className="flex flex-1 items-center gap-2 px-2 py-1.5"><span color-pill>{name}</span>{kind==='option' && selected && <Check/>}</button>` (+ 右側に kebab span)。

採用配置:
```tsx
<button>
  {kind === 'category' && item.select_type && (
    item.select_type === 'single'
      ? <CircleDot className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
      : <CheckSquare className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
  )}
  <span className={`... ${colorToClass(item.color)}`}>{item.name}</span>
  {kind === 'option' && selected && <Check ... />}
</button>
```

icon size `h-3.5 w-3.5` (= 14px) は kebab `h-4 w-4` (= 16px) より小、 color pill より小、 「行頭の小さい印」 として控えめ。 color `text-slate-400` は名前を主、 icon を副の階層に。

#### 6. すべて見た目のみ、 logic 不変 (本 sprint の核)

- handleConfirmType / multiButtonRef / default focus useEffect / 二重発火 guard / Esc 階層 / popover close reset / stage 状態 mgmt / pendingCategoryName state / Tag-4c-2a-fix-2 Fix-2 抑制 / Fix-3 rAF 全選択 focus 全て**完全不変**
- Test 更新は icon class / 見出しテキスト不在 assert / 新規 category 行 icon assert に限る

### Tests strategy (test 観点のみ、 詳細 case は plan 側で task ごとに割る)

- **card-tag-option-list.test.tsx**:
  - kind='category' + select_type='single' で `lucide-circle-dot` SVG が行頭に出る
  - kind='category' + select_type='multi' で `lucide-check-square` SVG が行頭に出る
  - kind='category' + select_type=undefined で icon が出ない (defensive)
  - kind='option' で icon が出ない (regression)
  - 既存 kind='category' kebab / role="menuitem" / color pill 表示 全 regression なし
- **card-tag-add-popover.test.tsx**:
  - 「『...』 の種別を選択」 が `queryByText` で null (見出し削除 regression)
  - multi button の icon が `lucide-check-square` (旧 `lucide-list-checks` から書き換え)、 single は `lucide-circle-dot` のまま
  - 既存 multi default focus / 二重発火 guard / 成功 path / 失敗 path / Esc / 同名抑制 regression 全て regression なし
  - 型選択 stage の左右余白 (px 単位) は test では確認しない (実機 smoke で目視確認)
- **smoke**: stg 実機で 8-10 観点 (plan 同梱 checklist)

## 規模見積もり

- 改修 2 source file + 2 test file: 純増 ~60 行 (見出し削除 -3、 multi icon swap ±0、 category 行 icon +10、 type 拡張 +2、 width 整形 +5、 test +30-40)
- plan は ~180 行 (300 cap 内、 Task 数 3 程度)、 Tag-4c-2a 系の amend に**重ねる** (4ac85b5 を amend)

## 受入基準 (Acceptance criteria)

- stage1 (combobox) と 型選択 stage の box 左右余白が**揃う** (実機目視 + DevTools 実 px 確認、 ±2px 以内)
- 型選択 stage の見出し「『...』 の種別を選択」 が DOM から完全消滅
- 型選択 stage の multi button icon が `CheckSquare` (☑、 旧 `ListChecks` 完全削除)
- stage1 の category 一覧各行の左端に小 icon が表示される (single = `CircleDot`、 multi = `CheckSquare`)、 size `h-3.5 w-3.5`、 色 `text-slate-400`
- option 行 (kind='option') には icon が**出ない** (Fix-4 目的: 視覚区別維持)
- 型選択 stage の挙動 (multi default focus / Enter 即決定 / 二重発火 guard / 失敗 inline error / Esc 階層) **完全不変**
- category 同名抑制 (Tag-4c-2a-fix-2 Fix-2) + 編集 stage 全選択 focus (Fix-3) **完全不変**
- Tag-4c-1 / Tag-4c-2a / Tag-4c-2a-fix / Tag-4c-2a-fix-2 の全 regression なし
- npm dep 追加なし、 schema 不変、 server logic 不変

## リスク / オープン論点

1. **幅揃えの実装時 px 微調整**: spec で「型選択 stage outer を CardTagOptionList と同等の入れ子 padding に揃える」 と方針確定、 具体 class は plan 実装中に DevTools 確認しながら最終決定。 ±2-4px 程度の微調整があり得る。 smoke checklist で「両 stage の左右余白が体感で揃っているか」 を明示観点として残す。
2. **icon size `h-3.5 w-3.5` の視認性**: 小サイズなので mobile (DevTools mobile view) で見えにくい可能性。 smoke checklist で「mobile でも category 行 icon が視認できるか」 を確認。 必要なら `h-4 w-4` に拡大 (plan 実装中に OT 相談、 spec での確定値は `h-3.5 w-3.5`)。
3. **`TagComboboxItem` 型拡張による既存 test 影響**: `select_type?: 'single' | 'multi'` を optional で追加するため既存 `ClientTagOption[]` 呼出も型 OK、 ただし test fixture で item を inline 生成しているケースで type 補完が変わる可能性。 plan の Task 1 で `pnpm exec tsc --noEmit` で全 file 確認、 不整合あれば fixture を最小修正。
4. **見出し削除後の文脈不在**: 直前に「+ 新規作成: {名前}」 click した文脈はあるが、 型選択 stage に入った瞬間「何の選択か」 がやや不明瞭になる可能性。 OT 確定方針なので変更しないが、 smoke で OT 体感確認。

## Commit / Push 方針 (OT 指示反映)

- 本 sprint の全変更を Tag-4c-2a 系の feat commit `4ac85b5` (= 現在の HEAD~2) に **`git commit --amend`** で畳む (別 commit を積まない)
- amend 手順は Tag-4c-2a-fix-2 Task 4 と同 pattern (`git reset --soft HEAD~2` で 直近 2 docs commit を pop → 本 sprint 変更を add → `git commit --amend --no-edit` で 4ac85b5 を amend → docs 2 個 (Tag-4c-2a-fix + Tag-4c-2a-fix-2) を再 commit → 本 sprint の docs を新規 commit として追加 = 計 3 docs commit を再積み)
- amend 後の commit message は OT 判断 (既存維持 `--no-edit` を default)
- `4ac85b5` は origin/develop に push 済 (Tag-4c-2a-fix-2 amend を OT が force-with-lease push 済の想定) → push は `git push --force-with-lease origin develop` で OT が実施 (Claude Code は push しない)
- docs (spec + plan) は別 `docs(tag): Tag-4c-2a-fix-3 spec + plan ... [no-review]` commit で積む

## 参照

- 実装対象: `app/(app)/app/exams/[id]/_components/card-tag-{add-popover,option-list}.tsx`
- Tag-4c-2a-fix-2 spec (前提): `docs/superpowers/specs/2026-06-08-tag-4c-2a-fix-2-design.md`
- Tag-4c-2a-fix-2 plan: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-2.md`
- Tag-4c-2a-fix-2 smoke: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-2-smoke-checklist.md`
- 型選択 stage 現実装: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:498-532` 周辺 (Tag-4c-2a-fix-2 Task 1 で実装)
- `TagComboboxItem` 型 (現在の定義): `card-tag-option-list.tsx:44-48`
- row JSX (現在): `card-tag-option-list.tsx:199-261`
- stage1 / 型選択 stage の outer 構造: `card-tag-add-popover.tsx:240, 273, 498` 周辺
- `ClientTagCategory` 型 (select_type 持ち): `lib/client-db.ts`
- lucide-react icon: `CircleDot` (既使用)、 `CheckSquare` (新規)、 `ListChecks` (削除対象)
- Step 0 調査結果: 本 spec §Architecture と §設計判断 と §リスク に反映済 (別 file 化なし)
