# Tag-4c-2a-fix-2: 型選択 stage コンパクト化 + category 同名抑制 (UI) + 編集 stage rename input 全選択 focus

## Goal

Tag-4c-2a-fix で着地した card-tags popover に対し、 OT 実機指摘の 3 点 UX 修正を当てる。

1. **Fix-1**: 型選択 stage (`'createCategoryType'`) の中身をコンパクト化 (Notion 風 2 行 + icon、 combobox より縦も横も大きくしない)
2. **Fix-2**: category combobox で完全一致名がある時「+ 新規作成」 行を UI で抑制 (option と同じ挙動に統一、 DB schema は変更しない)
3. **Fix-3**: kebab → 編集 stage (`'editCategory'` / `'editOption'`) 遷移時、 rename input を **focus 済 + テキスト全選択済** にして即打ち変え可能にする

## 背景・問題

Tag-4c-2a-fix (commit `072779d`) で stage1 を combobox に統一 + 型選択 stage を導入したが、 OT 実機検証で以下が判明:

- **指摘 1**: 型選択 stage の中身が冗長 — 「単一 (single) / 1 つの card にこのカテゴリの option は最大 1 つ」 + 「複数 (multi) / 複数付与できる」 が大ブロック 2 個 + 重複説明、 combobox より縦に大きくなり違和感
- **指摘 2**: category 同名作成可能 — Tag-4c-2a-fix §設計判断 3 で schema UNIQUE なし + 既存挙動 (同名許容) に従い「完全一致でも新規作成行を出す」 としたが、 実機で「意味なく同名 category が量産される」 ことが判明、 option と挙動を揃える方が UX 上望ましい
- **指摘 3**: kebab → 編集 stage に遷移してもすぐ打ち変えられない — rename input が focus 済でなく、 まず click → 全選択 → 打ち変えの 3 step、 編集動線が冗長

修正方針 (本 sprint):
- Fix-1: 中身だけコンパクト化 (stage 方式は維持、 combobox 内に折り込まない、 確立済の Esc 機構に乗せる)
- Fix-2: UI 抑制のみ (`CardTagOptionList.suppressCreateOnExactMatch` を category 呼出で `true` に戻す)、 DB schema 変更なし
- Fix-3: 編集 stage に入った瞬間 `inputRef.focus() + inputRef.select()` で全選択 focus を確保

## Scope

### In scope (Tag-4c-2a-fix-2)

**Fix-1. 型選択 stage の中身コンパクト化**
- stage 方式は維持 (`'createCategoryType'`、 Esc 階層、 multi default focus、 二重発火ガード)
- 中身を Notion 風 2 行リスト + icon に詰める:
  - 「シングルセレクト」 + icon (lucide `CircleDot`)
  - 「マルチセレクト」 + icon (lucide `ListChecks`)
  - icon は spec で確定。 plan 実装中に視認性で別 lucide icon に変更したい場合は OT 相談 (停止)
- 長い説明文 (旧「1 つの card にこのカテゴリの option は最大 1 つ」 等) は**全削除** (説明文を出さない方針で確定)。 icon + 短文 (「シングルセレクト」 / 「マルチセレクト」) のみで意味は十分伝わる
- 制約 (厳守): 型選択 UI は **stage1 / stage2 の combobox (input + リスト) より縦も横も大きくしない**
  - 寸法目安: 入力 1 行 (`px-2 py-1 text-sm`) + リスト行 (`px-2 py-1.5 text-sm`) × 数行が combobox の最大想定占有領域
  - 型選択 stage はこの「combobox 最大想定」 を超えないように 2 行 (single / multi) + back + 見出し + 余白で収める。 button 1 個あたり list 行 1 個分相当 (約 32px) を狙う
  - 見出し「『{pendingCategoryName}』 の種別を選択」 は最小限の高さ (`text-xs text-slate-500 px-2 py-1` 程度) に絞る、 旧 `text-sm font-medium` から縮小
- 構造:
  - back button: 既存 (`ChevronLeft` + 「カテゴリ選択へ戻る」、 px-2 pt-2)
  - 見出し: コンパクト化 (`text-xs` 1 行)
  - 2 button: 縦並び、 各 button は `flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-slate-100 rounded`、 中身 = icon (h-4 w-4 text-slate-500) + text + (optional 極小説明)
  - inline error: 既存 (`text-xs text-red-600` + `role="alert"`)
- multi button に default focus (既存 `multiButtonRef` + useEffect 流用)、 Enter 即決定
- 二重発火ガード (`isSubmittingCreate`) 維持
- icon 追加に伴い `import { CircleDot, ListChecks } from 'lucide-react'` を追加 (lucide-react は既存 dep、 npm dep 追加なし)

**Fix-2. category 同名抑制 (UI only、 DB 不変)**
- `card-tag-add-popover.tsx` の stage1 `<CardTagOptionList kind="category" ... />` 呼出で `suppressCreateOnExactMatch={false}` を **削除** (or `true` に変更) → default `true` で option と同じ挙動
- これにより完全一致 (case/whitespace 無視) する既存 category 名がある時、 「+ 新規作成: {入力値}」 行が表示されない
- Tag-4c-2a-fix §設計判断 3 「category は完全一致でも新規作成行を出す」 を**取り消し**、 option と同じ UI 挙動に統一
- `lib/db/schema.ts` の `tag_categories` には UNIQUE 制約を**追加しない** (Out of scope、 §後述)
- `applyTagCategoryCreate` (`lib/tags/apply-tag-mutation.ts`) も**改修しない** (本 sprint は UI 抑制のみ)
- placeholder 文言 / 空入力時 / 部分一致時の挙動は不変 (combobox の filter は維持、 完全一致時にだけ「+ 新規作成」 行が消える)

**Fix-3. 編集 stage rename input 全選択 focus**
- `card-tag-edit-fields.tsx` (kind='category' / kind='option' 共通 sub-component) に `useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])` を追加 (mount 時のみ実行)
- popover 側 (`card-tag-add-popover.tsx` の editCategory / editOption stage、 `card-tag-edit-popover.tsx` の editOption stage) で `<CardTagEditFields key={editTargetId ?? 'none'} ... />` のように `key` を付与
  - これにより「同 stage 内で別 target に kebab した」 case (例: editOption stage で別 option 行の kebab → editTargetId 変化 → 同 stage 内で render 継続) でも、 key 変化で component が再 mount され useEffect が再発火 → 全選択 focus が再度効く
  - 「Radix Popover の stage 遷移時に autofocus 再発火しない」 問題 (Step 0 Q3) を回避する確実な手段
- 既存 `category-row.tsx` / `option-row.tsx` の `useEffect(..., [editing])` パターンと整合 (それぞれは row 内 inline 編集の focus + select、 reference 実装として参考)
- Radix Popover の `onOpenAutoFocus` は触らない (本 sprint で必要ない、 既存挙動維持)

### 維持する不変条件 (Tag-4b-fix / 4c-1 / 4c-2a / 4c-2a-fix から継承、 不変)

- optimistic 即反映: 親 `InlineCardList` 一括 subscribe + useMemo + 子 `React.memo`
- whole-set 不変条件 (他カテゴリ落とし回避)
- single 最大 1 個・0 個許容
- 案 a 取り直し (cards.updated_at bump → pull)
- popover stage 構造 + Esc 階層 (型選択 stage Esc → category も維持)
- npm dep 追加ゼロ (lucide-react 内 icon 追加のみ、 これは既存 dep)
- user_id は親 prop の auth() 由来値 (空文字禁止)
- atomic 戦略 (作成系) = same-tx atomic + Dexie auto-rollback
- 既存 `tags/_components/*` (manager) は据置
- **option 作成挙動は完全不変** (Tag-4c-2a Task 4 / Tag-4c-2a-fix Task 4 の挙動を一切触らない)
- Tag-4c-1 (rename / color / 削除 / kebab) も挙動不変

### Out of scope (別 sprint / 別 chore)

- **`tag_categories` への UNIQUE(user_id, name) 追加 + migration + 既存重複の名前マージ** → **Tag-3** (名前マージ実装時に対応)。 本 sprint は UI 抑制のみで、 server 側 race / 既存データの重複は手付かず
- **`applyTagCategoryCreate` の同名 pre-check** → Tag-3 で対応 (本 sprint で server 側に重複防御を入れると Tag-3 の name merge logic と衝突する可能性)
- **`handleRenameCategory` の trim / normalize 不整合** → 別 chore (Sync-fix-1 等)
- **option 作成挙動 / Tag-4c-2a / 4c-2a-fix の他観点** → 全て不変
- **D&D (C-2)** → Tag-4c-2b
- **タグ管理画面 (`/app/tags`) の撤去** → 据置
- **manager 画面 (旧 void / 空文字 user_id pattern) の差し替え** → Sync-fix-1

## Architecture

### file 構成

**改修:**
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (+~ -30 行 / +50 行)
  - 型選択 stage の中身 JSX をコンパクト版に置換 (旧 ~50 行 → 新 ~30 行)
  - stage1 `<CardTagOptionList kind="category" ... />` 呼出から `suppressCreateOnExactMatch={false}` を削除 (= default true)
  - editCategory stage の `<CardTagEditFields ... />` に `key={editTargetId ?? 'none'}` を付与
  - editOption stage の `<CardTagEditFields ... />` にも `key={editTargetId ?? 'none'}` を付与
  - `import { CircleDot, ListChecks } from 'lucide-react'` 追加
- `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx` (+~10 行)
  - `useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])` を mount 時実行で追加
  - JSDoc に「Tag-4c-2a-fix-2 Fix-3: mount 時 全選択 focus」 を 1 行記載
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` (+~5 行)
  - editOption stage の `<CardTagEditFields ... />` に `key={editTargetId ?? 'none'}` を付与
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx` (~50 行更新 / 追加)
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.test.tsx` (~10 行更新): category 同名抑制 default 復帰を反映
- `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.test.tsx` (~30 行追加): mount 時 focus + select の test
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.test.tsx` (~10 行更新): editTargetId 切替で全選択 focus 再発火を確認

**新規作成:** なし

**不変:**
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (Task 1-2 で generalize 済、 本 sprint で touch しない)
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx`
- `app/(app)/app/exams/[id]/_components/card-tag-badge.tsx`
- `lib/db/schema.ts` (UNIQUE 追加なし)
- `lib/tags/apply-tag-mutation.ts` (server pre-check 追加なし)

### Data flow (本 sprint で変わる挙動)

1. **stage='category' で完全一致名入力**:
   - 旧: 「+ 新規作成: {入力値}」 行が出る → click で stage='createCategoryType' に遷移
   - 新: 「+ 新規作成」 行が**出ない** → ユーザーは既存 category を選ぶか入力を変える必要あり
2. **stage='createCategoryType'**:
   - 旧: 大 button 2 個 + 各説明、 縦に大きい
   - 新: 小 button 2 個 (icon + 短文)、 combobox と同 dimension に収まる
3. **kebab → 編集 stage**:
   - 旧: 編集 stage に入っても rename input は focus されず、 ユーザーは click → 選択 → 打ち変えの 3 step
   - 新: 編集 stage 入った瞬間 rename input が focus 済 + 全選択済、 ユーザーはすぐ打ち変え可能

### 重要な設計判断

#### 1. 型選択 stage は方式維持、 中身だけコンパクト化

OT brief 明示: 「combobox 内に行展開で 2 択を持たせる方式は採らない。 combobox の責務を増やすと壊れやすいため、 確立済の stage + Esc 機構に乗せる」 → そのとおり実装。

採用しなかった案:
- (a) combobox の「新規作成」 行を click した瞬間に 2 つの subrow (single / multi) を展開 → combobox に分岐ロジックが増え、 行 click semantics の解釈が壊れやすい
- (b) 「新規作成」 行 click 直後に inline 小 dialog or tooltip で 2 択 → Radix Popover 上に dialog を重ねると focus 管理が破綻

採用案: 既存 stage を維持し中身だけコンパクト化 → 既存 Esc 階層 / Tab focus 順 / multi default focus / 二重発火ガードを全部流用、 変更影響範囲が JSX のみで小さい。

#### 2. 寸法制約「combobox より大きくしない」 の担保方法

OT brief 厳守事項。 担保のために spec で:

- 見出し: `text-xs text-slate-500 px-2 py-1` (旧 `text-sm font-medium px-3 py-2` から縮小)
- 各 button: `flex items-center gap-2 px-2 py-1.5 text-sm` (≒ option list 行と同高 ~32px)
- 説明文は**出さない** (削除、 §Scope Fix-1 で確定済)
- 全体 wrapper の余白を最小に (`<div className="py-1">` 程度、 旧の `px-3 py-2` 内包 div は使わない)

寸法目安:
- stage1 combobox 最大想定: input 1 行 (~28px) + リスト ~4 行 (~32px × 4 = 128px) + 余白 (~16px) = 約 172px
- 型選択 stage: back (~24px) + 見出し (~24px) + 2 button (~32px × 2 = 64px) + 余白 (~16px) = 約 128px (combobox より小さい)

#### 3. icon の選定 (lucide-react、 npm dep 追加なし)

- 「シングルセレクト」: `CircleDot` (中央 dot で「1 個だけ選ばれる」 を視覚化、 ラジオボタン的)
- 「マルチセレクト」: `ListChecks` (リストにチェックが複数 = 複数選択を視覚化)
- 両者とも lucide-react 標準 export、 既存 codebase に未使用だが既存 dep 範囲内 (`pnpm add` 不要)
- 視認性に問題があれば plan 実装中に OT 相談 (停止)、 spec での確定値はこの 2 つ

#### 4. category 同名抑制を UI のみで対処、 DB 不変

OT brief 明示: 「DB schema は変更しない (tag_categories に UNIQUE 制約を今足さない)」 + 「既存重複の解消 + migration + 名前マージを巻き込むため、 それは Tag-3 の名前マージ実装時に対応」。

採用判断:
- `suppressCreateOnExactMatch={false}` を削除 (default `true` で option と同じ挙動) する 1 行変更
- `CardTagOptionList` 内 `exactMatchExists = options.some(o => o.name.trim().toLowerCase() === lower)` は trim + lowercase で正規化済、 category items にも同じく適用される (`TagComboboxItem` の `name` field は category にも存在)
- これで race condition (client 同時操作で 2 つ作成) は防がないが、 OT brief で許容 (Tag-3 で対応)

Tag-4c-2a-fix §設計判断 3 (本 sprint で取り消し) の挙動変更は spec で明示し、 smoke checklist にも「完全一致時に新規作成行が**出ない**」 を新観点として追加。

#### 5. 編集 stage 全選択 focus の Radix 競合対策

Step 0 Q3 確認結果: Radix Popover は popover open 時のみ autofocus、 内部 stage 遷移では autofocus 再発火しない。

採用案:
- `CardTagEditFields` 内に `useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])` (mount 時のみ)
- popover 側 (3 箇所: `card-tag-add-popover.tsx` editCategory / editOption stage、 `card-tag-edit-popover.tsx` editOption stage) で `<CardTagEditFields key={editTargetId ?? 'none'} ... />` を付与
- `key` 変化で React は component を強制的に**再 mount** → useEffect が再発火 → focus + select が確実に効く
- `editTargetId` は kebab click ごとに新しい id を持つため、 stage 切替・同 stage 内 target 切替・別 popover 経路の全 case で動く

採用しなかった案:
- (b) Radix `onOpenAutoFocus` を override して内部に拡張 → Radix の自動 focus 管理に介入する追加複雑度
- (c) input に `autoFocus` HTML 属性 → 一度しか効かない、 stage 遷移には対応しない
- (d) `useEffect(() => { ... }, [editTargetId])` を popover 側に置く → CardTagEditFields の責務分散、 ref 管理が popover に漏れる

採用案は React の標準 idiom (key で再 mount 強制) + 既存 `category-row.tsx` / `option-row.tsx` の reference 実装と整合。

#### 6. 既存 `category-row.tsx` / `option-row.tsx` の pattern 流用

manager 側 (`tags/_components`) の inline 編集 row には `useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select() } }, [editing])` が既存 (Step 0 Q3 で確認)。

本 sprint の `CardTagEditFields` の useEffect は `[]` deps (mount 時のみ) で、 manager 側の `[editing]` deps とは異なるが、 logic 本体 (`.focus()` + `.select()`) は同一。 これは:
- popover 側は `key={editTargetId}` で mount 制御するため、 deps は `[]` で十分
- manager 側は inline 編集なので `editing` 切替で mount/unmount せず、 deps が必要

整合性のため `CardTagEditFields` の JSDoc に「mount 時 全選択 focus、 stage 遷移 / target 切替時の再発火は親側 `key={editTargetId}` で担保」 と明示。

### Error handling

- 同名抑制で 「+ 新規作成」 行が出ない場合、 ユーザーは入力を変えるか既存 category 行 click。 inline error / placeholder の追加は**しない** (Notion 同等、 既存挙動と整合)
- 編集 stage の focus + select は最初の mount 時のみ意図的に発火、 ユーザーが input から離れた後 (focus 失う) は再発火させない (UX 上自然)

### Tests strategy (詳細 case は plan 側で task ごとに割る)

- **card-tag-add-popover.test.tsx**:
  - 型選択 stage で 2 button が短文 + icon 構造、 旧大 button JSX が DOM に存在しない
  - 寸法視認の機械テストは行わない (snapshot diff だと脆い)、 構造変化を assertion で固定 (`getByRole('button', { name: 'シングルセレクト' })` 等)
  - category combobox で完全一致名入力時に「+ 新規作成」 行が**出ない** (option との挙動統一の regression test)
  - 部分一致 / 空入力時の挙動は既存維持 (regression)
  - editCategory / editOption stage 遷移時に rename input が focus + select される (assert via `document.activeElement === input` + `input.selectionStart === 0 && input.selectionEnd === input.value.length`)
  - editOption stage 内で別 option の kebab click → editTargetId 変化 → 再 mount → 全選択 focus 再発火 (`key` 経由)
- **card-tag-edit-fields.test.tsx**:
  - mount 時 inputRef.focus() + inputRef.select() が呼ばれる
  - selectionStart / selectionEnd が全選択状態 (`0 === input.selectionStart` && `input.value.length === input.selectionEnd`)
- **card-tag-edit-popover.test.tsx**:
  - editOption stage 入った瞬間 rename input 全選択 focus
  - 別 option の kebab → editTargetId 変化 → 全選択 focus 再発火
- **card-tag-option-list.test.tsx**:
  - `suppressCreateOnExactMatch` default `true` で 完全一致時 新規作成行非表示 (既存 regression、 追加 test 不要)
  - kind='category' で同 default 挙動が効く (新規 1 test 程度)
- **smoke**: stg 実機で 6 観点 (plan 同梱 checklist)

## 規模見積もり

- 改修 3 source file + 4 test file: 純増 ~150 行 (旧 JSX 削除 ~30 + コンパクト JSX 追加 ~30 + 1 line 削除 + useEffect 追加 + key 付与 + test ~100)
- plan は ~200 行 (300 cap 内、 Task 数 4 程度)
- Tag-4c-2a-fix の amend に**重ねる** (072779d を amend、 別 commit 積まない)

## 受入基準 (Acceptance criteria)

- 型選択 stage が縦も横も combobox より大きくない (実機 / DevTools で目視確認)
- 型選択 stage の中身: back + コンパクト見出し + 2 行 (icon + 「シングルセレクト」 / 「マルチセレクト」) + inline error 領域、 旧大 button + description 完全消滅
- multi に default focus が効く (Enter 即決定可)
- category combobox で完全一致名入力時に「+ 新規作成」 行が**出ない** (option との挙動統一)
- 完全一致でない / 空入力時の combobox 挙動は既存維持 (regression なし)
- DB schema (`tag_categories`) は変更されていない (UNIQUE 追加なし、 既存重複データに影響なし)
- kebab → editCategory / editOption stage 遷移時、 rename input が focus 済 + 全選択済 (テキストを即打ち変え可能)
- editOption stage 内で別 option kebab → 別 target に切替時も再度全選択 focus (key 経由)
- Tag-4c-1 / 4c-2a / 4c-2a-fix の全 regression なし (option 作成挙動 / バッジ click 経路 / Tag-4c-1 編集系 / Esc 階層 / popover close reset 全て不変)
- npm dep 追加なし、 manager 画面据置、 server apply 経路無改修

## リスク / オープン論点

1. **寸法制約の客観的担保**: 「combobox より大きくしない」 は実機目視で確認するが、 plan 実装中に Tailwind class の組合せが想定より大きくなるリスク。 plan の Task 1 (型選択 stage 改修) 完了時に実機 (DevTools or chrome-devtools MCP) で寸法を確認する手順を smoke checklist に明記。
2. **icon の視認性**: `CircleDot` / `ListChecks` は未使用 icon、 実機で「直感的か」 は OT 判断必要。 smoke 観点に明示。
3. **`key={editTargetId}` の identity 安定性**: `editTargetId` は kebab click ごとに正しく更新される (Tag-4c-1 で確立済)、 race condition なし。 ただし `key` を null / undefined のままにすると React が warning 出す可能性 → `editTargetId ?? 'none'` で fallback、 spec で明示 (上述)。
4. **同名抑制の挙動切替が user の戸惑いを生むか**: Tag-4c-2a-fix で「category も同名作成可」 が直近の挙動。 本 sprint で「同名抑制」 に戻る。 OT brief 確定方針なので変更するが、 smoke checklist で「完全一致時の挙動」 を明示観点として残す。
5. **既存重複 category への影響**: 過去に作成した同名 category データは残る (DB 不変)。 ユーザーには「2 つの「分野」 category が popover に並ぶ」 ような状態が継続。 これは Tag-3 で名前マージ実装まで解決しない、 spec § Out of scope で明示。

## Commit / Push 方針 (OT 指示反映)

- 本 sprint の全変更を、 Tag-4c-2a 系の feat commit `072779d` (現在の HEAD~1) に **`git commit --amend`** で畳む (別 commit を積まない)
- amend 手順は Tag-4c-2a-fix Task 5 と同様 (`git reset --soft HEAD~1` で Tag-4c-2a-fix docs commit `60d759a` を pop → 本 sprint 変更を add → `git commit --amend --no-edit` で 072779d を amend → docs を新規 docs commit として再積み)
- amend 後の commit message は OT 判断 (既存維持 `--no-edit` を default、 OT が必要なら `git commit --amend` で差分追記)
- `072779d` は origin/develop に push 済 (Tag-4c-2a-fix kickoff 時点で OT 主張 + git status 確認済) → push は `git push --force-with-lease origin develop` で OT が実施 (Claude Code は push しない)
- docs (spec + plan) は既存 pattern どおり別 `docs(tag): Tag-4c-2a-fix-2 spec + plan ... [no-review]` commit で積む

## 参照

- 実装対象: `app/(app)/app/exams/[id]/_components/card-tag-{add-popover,edit-popover,edit-fields}.tsx`
- Tag-4c-2a-fix spec (前提): `docs/superpowers/specs/2026-06-08-tag-4c-2a-fix-category-combobox-design.md`
- Tag-4c-2a-fix plan: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-category-combobox.md`
- Tag-4c-2a-fix smoke: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-smoke-checklist.md`
- Tag-4c-2a-fix Task 5 amend pattern (本 sprint も同 pattern を踏襲): 上記 plan Task 5
- 型選択 stage 現実装: `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:479-532` 周辺
- `suppressCreateOnExactMatch` 現位置: `card-tag-add-popover.tsx:302` (stage1 呼出で `false` 渡し)
- combobox 寸法 reference: `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (input + list 行の class)
- `CardTagEditFields`: `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx:162-171` 周辺 (rename input)
- 既存 focus + select pattern: `app/(app)/app/tags/_components/category-row.tsx` (Tag-4a manager)、 `app/(app)/app/tags/_components/option-row.tsx`
- schema (UNIQUE 確認、 本 sprint で変更なし): `lib/db/schema.ts:664-691` (tag_categories)
- Step 0 調査結果: 本 spec §Architecture と §設計判断 と §リスク に反映済 (別 file 化なし)
