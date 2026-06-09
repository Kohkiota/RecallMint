# Tag-4c-2a-fix: stage1 を category combobox に統一 (option と同型) + 型選択 stage 導入

## Goal

Tag-4c-2a で着地した「stage1 末尾『+ カテゴリを追加』 button + 独立 `createCategory` stage (名前 input + 型 segment 同居)」 を、 **stage2 (option) と同型の combobox** に作り直す。 stage1 上部に combobox input、 末尾に「+ 新規作成: {入力値}」 行を出し、 click で同一 popover 内の**型選択 stage** に遷移 → single / multi を選んだ時点で category 作成 + その category の stage='option' に自動遷移する。

## 背景・問題

Tag-4c-2a の現状 (commit `b1fbe89`):
- stage2 (option 選択) は Notion 方式 combobox に統一済み (上部 input + 末尾「新規作成: {入力値}」 + 即作成 + 即付与)
- stage1 (category 選択) は **button → 独立 stage 方式** が残存 (末尾「+ カテゴリを追加」 row → `createCategory` stage = 名前 input + select_type segment を 1 画面に詰め込む UI)

この不統一により:
- option 作成は「検索しながら作成」 が自然 (一覧 filter + 同 input で作成名指定)、 category 作成は別画面遷移で「検索 → 失敗 → 戻る → 追加 button → 名前入力」 の冗長動線
- 「既存 category を探したが見つからず、 新規作成したい」 という典型シナリオが option と category で異なる手数になる

修正方針 (本 sprint):
- stage1 を combobox 化 (option stage2 と同 UX)
- category は **select_type が作成後 immutable** のため、 名前入力時点ではまだ作成せず、 「型選択 stage」 を 1 段挟んで single / multi を選んだ時点で確定。 OT 確定方針

## Scope

### In scope (Tag-4c-2a-fix)

**S-1. stage1 を combobox に統一**
- stage1 上部に input を常設 (placeholder「検索 or 新規作成」、 stage 表示時 auto-focus、 aria-label「category を検索 / 新規作成」)
- input で category 一覧を**部分一致 (大小無視) で絞り込み**
- 末尾に「+ 新規作成: {入力値}」 行を表示
- 既存 category 行 click = stage='option' に遷移 (既存挙動、 selectedCategoryId 設定)
- 「新規作成」 行 click = 型選択 stage に遷移 (`'createCategoryType'`、 後述 S-2)
- 「新規作成」 行を**出さない**条件: 入力が空のみ。**完全一致する既存 category 名があっても「新規作成」 行は出す** (category は同名許容、 §設計判断 3 参照)
- 既存 category の kebab (= editCategory 遷移、 Tag-4c-1) は維持。 combobox input は category 行 `<ul>` の外 (上) に置く → kebab event との分離は既存 stopPropagation で確保
- stage1 上部 0 件 placeholder「下の入力欄に名前を入れて『新規作成』 で追加できます」 を、 categories.length === 0 のときに表示 (現 placeholder「下の『+ カテゴリを追加』 から作成できます」 を差し替え)

**S-2. 型選択 stage `'createCategoryType'` 導入**
- stage 列挙は **5 値のまま** (旧 `'createCategory'` を新 `'createCategoryType'` に置換): `'category' | 'option' | 'editCategory' | 'editOption' | 'createCategoryType'`
- (旧 `'createCategory'` stage の中身は **撤廃** = 名前 input + 型 segment 同居 UI が消える、 §S-3)
- 内部 state 追加: `pendingCategoryName: string | null` (型選択 stage への遷移時に combobox 入力値の trim 後文字列を保持)
- 中身 (popover 内 inline JSX、 ~40 行):
  - 見出し「『{pendingCategoryName}』 の種別を選択」
  - 2 button (single / multi) を縦並びで配置、 それぞれに簡潔な説明:
    - 「単一 (single)」: 「1 つの card にこのカテゴリの option は最大 1 つ」
    - 「複数 (multi)」: 「1 つの card にこのカテゴリの option を複数付与できる」
  - 各 button click → 該当 select_type で `tagEditCallbacks.createCategory(pendingCategoryName, selectType)` を await → 成功時 `setSelectedCategoryId(id) + setStage('option') + setPendingCategoryName(null) + setCreateError(null)`、 失敗時 inline error 表示 + 型選択 stage に留まる
  - back button「← カテゴリ選択へ戻る」 → setStage('category') + setPendingCategoryName(null) + setCreateError(null)
  - 二重発火ガード: 既存 `isSubmittingCreate` (Tag-4c-2a Task 3 で導入済) を流用、 両 button onClick で同一 guard

**S-3. 旧 `'createCategory'` stage 撤廃**
- stage 列挙から `'createCategory'` を削除
- `createCategory` stage の JSX (Tag-4c-2a で `card-tag-add-popover.tsx:504-593` に追加した約 90 行) を削除
- 関連 state `createForm: { name: string; selectType: 'single'|'multi' }` を削除 (代わりに `pendingCategoryName: string | null` で `name` のみ保持。 selectType は型選択 stage の click 時に直接渡す)
- `createNameInputRef` を削除 (combobox input は `CardTagOptionList` 側の ref を流用、 もしくは generalize 後の component が持つ)
- 既存「+ カテゴリを追加」 row JSX を削除
- `handleCreateCategorySubmit` (Tag-4c-2a で popover 内に置いた submit handler) を削除、 型選択 stage の各 button onClick が新たな submit pattern を担う
- caller grep で残存箇所を verify、 dead code を残さない

**S-4. Esc 階層更新 (旧 `createCategory` 分岐を `createCategoryType` 分岐に差し替え)**
```ts
onEscapeKeyDown={(e) => {
  if (stage === 'editCategory')         { e.preventDefault(); setStage('category') }
  else if (stage === 'editOption')        { e.preventDefault(); setStage('option') }
  else if (stage === 'createCategoryType'){ e.preventDefault(); setStage('category'); setPendingCategoryName(null); setCreateError(null) }
  else if (stage === 'option')            { e.preventDefault(); setStage('category'); setCreateError(null) }
  // stage 'category' は shadcn 標準 (popover 閉じる)
}}
```
- 旧 `'createCategory'` Esc 分岐は削除
- popover close (`onOpenChange`) reset: `pendingCategoryName=null` を追加、 旧 `createForm` reset を削除、 既存 reset は維持

**S-5. `CardTagOptionList` を `kind` discriminator で generalize**
- Step 0 Q1 で確認: 現 `CardTagOptionList` は item から `id / name / color` のみ参照、 generalize 可能
- 新 props:
  - `kind: 'option' | 'category'` (default 'option' で既存呼出と後方互換、 ただし stage='option' / stage='category' 両方で明示指定する方針)
  - `items: TagComboboxItem[]` (内部型 `{id: string; name: string; color: string | null; sort_key: string | null}` を export — 既存 `ClientTagOption` / `ClientTagCategory` の共通 subset)
  - `selectedIds?: Set<string>` (option only、 Check icon 表示用、 kind='category' では undefined / 無視)
  - `selectType?: 'single' | 'multi'` (option only、 single なら click 時に popover close、 kind='category' では undefined / 無視)
  - `onItemClick: (id: string) => void` (kind に応じて意味が変わる; option → onToggle 相当、 category → stage='option' 遷移相当)
  - `onRowAction?: (id: string) => void` (kebab、 両 kind 共通)
  - `onCreateNew?: (name: string) => Promise<void>` (両 kind 共通)
  - `createError?: string | null`
  - `suppressCreateOnExactMatch?: boolean` (default `true` = option 既存挙動、 kind='category' では `false` を渡して同名許容、 §設計判断 3)
  - `selectedCategoryId?: string | null` (既存 props 名そのまま流用。 kind='option' で filter reset trigger (現状通り)、 kind='category' では undefined を渡す = stage1 は popover open 中 1 度しか見ないため reset trigger 不要)
  - `searchPlaceholder?: string` (input placeholder、 default「検索 or 新規作成」)
  - `searchAriaLabel?: string` (default「item を検索 / 新規作成」、 kind 別に上書き可)
  - `emptyPlaceholderText?: string` (items 0 件 + 新規作成行も出ない時の文言、 default option 文言、 kind='category' で stage1 用文言に差し替え)
- 内部分岐:
  - `kind === 'option'`: 既存挙動 (Check icon、 onToggle = onItemClick、 selectType='single' で close)
  - `kind === 'category'`: Check icon 非表示、 onItemClick = stage='option' 遷移 (popover 側で渡す)、 close 動作なし
- リネームは行わない (`CardTagOptionList` のまま、 ただし JSDoc に「option / category の combobox 共通 component」 と明記)。 リネーム別 chore で Sync-fix-1 等で扱う、 本 sprint scope 外

**S-6. section 側の callback 配線確認**
- `tagEditCallbacks.createCategory` (Tag-4c-2a Task 1 で実装) は無改修。 signature `(name, selectType) => Promise<{id}>` のまま
- popover 側の呼出パターンが変わる (旧: 名前 input + segment 1 click / 新: 名前は combobox、 selectType は型選択 stage の button)。 callback 自体に変更不要
- section の `tagEditCallbacks` useMemo / 配線 (両 popover に同一 props) も無改修

### 維持する不変条件 (Tag-4b-fix / 4c-1 / 4c-2a から継承)

- optimistic 即反映: 親 `InlineCardList` 一括 subscribe + useMemo + 子 `React.memo`
- whole-set 不変条件 (他カテゴリ落とし回避)
- single = 最大 1 個・0 個許容
- 案 a 取り直し (cards.updated_at bump → pull)
- popover stage 構造 + Esc 階層 (Notion 方式、 本 sprint で `createCategory` → `createCategoryType` 置換)
- npm dep 追加ゼロ
- user_id は親 prop の auth() 由来値 (空文字禁止)
- atomic 戦略 (作成系) = `db.transaction('rw', tag_categories, db.entity_mutations, async () => { mirror put + enqueueEntityMutation })` の same-tx atomic + Dexie auto-rollback (Tag-4c-2a Task 1 の `handleCreateCategory` をそのまま再利用、 改修なし)
- 既存 `tags/_components/*` (manager) は据置 (旧 void 非 await / 空文字 user_id pattern コピー禁止、 Sync-fix-1 で一斉差し替え予定)

### Out of scope (別 sprint / 別 task)

- **option 作成 UI / 挙動の変更** → 不変。 stage2 combobox + 即作成 + 即付与は Tag-4c-2a のまま
- **CardTagEditPopover (バッジ click 経路) の combobox / 新規作成行** → 不変 (Tag-4c-2a Task 4 で実装済)
- **D&D 並べ替え** → Tag-4c-2b (dnd-kit)
- **タグ管理画面 (`/app/tags`) の撤去** → 据置
- **select_type 後付け変更 UI** → 引き続き immutable
- **既存 `handleRenameCategory` の trim / normalize 不整合** (Step 0 red flag #3) → 本 sprint で揃えない、 別 chore で対応
- **`CardTagOptionList` のリネーム** → 別 chore で対応 (本 sprint は generalize のみ、 命名は据置)
- **manager 画面 (旧 void / 空文字 user_id pattern) の差し替え** → Sync-fix-1
- **category 名同名作成時の UI 警告 / 確認 dialog** → 入れない (OT 確定方針)

## Architecture

### file 構成

**改修:**
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (+~50 行)
  - `kind` discriminator + 各 kind 用 props を追加
  - 内部分岐: Check icon 表示制御、 click semantics、 suppressCreateOnExactMatch 制御、 placeholder 文言可変化
  - リネームしない
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (~ ±50〜80 行 net: 旧 createCategory stage 削除 ~90 行 - 新 combobox 配線 + 型選択 stage 追加 ~ +130 行 → 微増)
  - stage 列挙を 6 値 (新 `'createCategoryType'`、 旧 `'createCategory'` 撤廃)
  - stage1 を `<CardTagOptionList kind="category" ... />` で render (旧 `<ul>` + 末尾「+ カテゴリを追加」 button は削除)
  - 型選択 stage の中身 (inline JSX、 ~40 行)
  - Esc 階層 6 stage 化
  - state: `pendingCategoryName: string | null` 追加、 `createForm` / `createNameInputRef` 削除、 `createError` / `isSubmittingCreate` は流用
  - popover close reset 更新
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` (~ ±0 行 net)
  - `CardTagOptionList` 呼出に `kind="option"` を明示 (default 動作と同じだが explicit)
  - 他の挙動不変

**新規作成:** なし

**不変:**
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (Task 1 の `handleCreateCategory` 流用)
- `app/(app)/app/exams/[id]/_components/inline-card-list.tsx`
- `card-tag-badge.tsx` / `card-tag-edit-fields.tsx`
- `lib/cards/next-card-sort-key.ts` (Tag-4c-2a で generic 流用済、 そのまま使う)
- 既存 server apply 経路 (`applyTagCategoryCreate` / `applyTagOptionCreate`) は無改修

### Data flow (category 作成)

```
[ユーザー: stage1 input に「皮膚」入力 + 「+ 新規作成: 皮膚」行 click]
   │
   ▼
[CardTagOptionList (kind='category')]
   │  内部 filter / showCreateRow / onCreateNew
   │
   ├─ onCreateNew('皮膚') 発火
   ▼
[CardTagAddPopover (presentation)]
   │  pendingCategoryName='皮膚' を state にセット
   │  setStage('createCategoryType')
   │  (この段階では category はまだ作成されない)
   │
   ▼
[stage='createCategoryType' (型選択 stage)]
   │  ユーザー: 「複数 (multi)」 button click
   │
   ├─ isSubmittingCreate gate (二重発火防止)
   ├─ await tagEditCallbacks.createCategory('皮膚', 'multi')
   │     │
   │     ▼
   │   [CardTagsSection.handleCreateCategory(name, selectType)]
   │     │  Tag-4c-2a Task 1 で実装済、 改修なし
   │     │  sort_key 採番 + uuid + atomic tx
   │     ▼
   │   db.transaction('rw', tag_categories, entity_mutations, async () => {
   │     db.tag_categories.put({ id, name: '皮膚', select_type: 'multi', color: null, sort_key, user_id, created_at })
   │     await enqueueEntityMutation({ entity_type: 'tag_category', entity_id: id, op: 'create', patch: { name: '皮膚', select_type: 'multi' } })
   │   })  // 失敗時 Dexie auto-rollback
   │
   ├─ 成功時: setSelectedCategoryId(id) + setStage('option') + setPendingCategoryName(null) + setCreateError(null) + setIsSubmittingCreate(false)
   ├─ 失敗時: setCreateError('作成に失敗しました') + setIsSubmittingCreate(false) (stage は createCategoryType のまま、 入力 / 既選択 button 状態は保持されない単純化、 §設計判断 4)
   ▼
[useLiveQuery 再描画 → popover content も自動更新、 stage='option' で新 category の空 option list を表示 (option 0 件 placeholder)]
```

filter / combobox / 新規作成行のロジックは Tag-4c-2a の stage2 と同型 (CardTagOptionList の generalize 後の挙動)。

### 重要な設計判断

#### 1. `CardTagOptionList` を generalize (リネームせず、 `kind` discriminator 追加)

OT brief 「できれば同共通 component を流用」 を尊重。 Step 0 Q1 で「item から `id / name / color` のみ参照」 = generalize 可能を確認済。

代替案 (採用せず):
- (a) 新規 `<TagComboboxShell>` を抽出、 `CardTagOptionList` も内部で使う形に refactor → 抽象化レイヤーが増える + 既存 test を 2 component に分割する作業が plan を肥大化
- (b) 別 component `<CardTagCategoryList>` を新規作成 → DRY 違反、 combobox logic が 2 箇所に重複

採用 (a' = generalize):
- `CardTagOptionList` 内部に `kind` 分岐を入れ、 props を kind 別に optional 化
- リネームは Sync-fix-1 等で別途 (本 sprint で「Option-only」 という名前にしない、 ただし internal な使い回しは category も含む)
- backward compat: 既存 stage='option' 呼出 (`card-tag-edit-popover.tsx` の単一 stage 呼出 含む) は `kind='option'` を明示渡ししなくても default で動く

#### 2. 型選択 stage = 「新規作成」 click 直後の 1 段挟み

OT brief 確定方針。 reason:
- `select_type` は作成後 immutable のため、 作成時に **必ず** 単一 / 複数を選ばせる必要がある
- combobox input に「皮膚 single」 のような構文を強制するのは UX 悪
- 「新規作成: {名前}」 click → 直後の小さい stage で 2 択を見せるのが Notion 同等の挙動

採用しなかった案:
- (b) 型選択を combobox 行内で expand inline (「新規作成: 皮膚 → [single] [multi]」 を同 row に) → 行の hit area が肥大 + a11y (Tab order) 悪化
- (c) 「新規作成」 click で即 multi で作成 + その後 stage='option' に「単一に変更」 button を出す → select_type 後付け変更 UI を導入する話になり scope 拡大

採用案: 別 stage `'createCategoryType'` で明示的に選ばせる。 stage 数は 5 → 6 に増えるが、 既存 Tag-4c-1 / 4c-2a の stage パターンと完全整合。

#### 3. 完全一致時の「新規作成」 行表示 (option と挙動が異なる)

Step 0 Q3 確認結果:
- `tag_categories` schema に UNIQUE(user_id, name) **なし** (`lib/db/schema.ts:664` コメント明示 「name は同 user 内で重複可」)
- `applyTagCategoryCreate` は PK のみ `onConflictDoNothing`、 同名チェックなし
- 既存 `handleCreateCategory` も client 側で同名チェックなし

→ category combobox の `suppressCreateOnExactMatch` props は `false` を渡す:
- 完全一致する既存 category 名があっても「+ 新規作成: {入力値}」 行を出す
- ユーザーが「同名で別 category を作りたい」 という明示的意思を尊重 (同名作成防止より同名許容仕様を優先)
- 誤操作リスクは「既存 category 行 click vs 新規作成行 click」 の選択肢が並ぶことで自己防衛 (既存に乗りたいなら既存行をクリック、 新規が欲しいなら新規作成行をクリック)

option の場合 (`suppressCreateOnExactMatch` default `true`):
- UNIQUE(category_id, name) で DB レベル弾く + `applyTagOptionCreate` で pre-SELECT 失敗扱い
- client 側で「新規作成」 行を出さない = UX で誤操作防止

両者の挙動差は schema + 既存 server logic の差を直接反映する。 spec で明示する。

#### 4. 型選択 stage 失敗時の振る舞い (簡素化)

失敗時 (`createCategory` reject) の振る舞い:
- stage='createCategoryType' に留まる
- inline error「作成に失敗しました」 を 2 button の下に role="alert" で表示
- pendingCategoryName と single/multi 選択途中の state は**保持しない** (button click が submit を兼ねるため「選択途中」 という state がそもそも存在しない)
- 再試行 = 同じ button を再 click すれば良い
- 連打防止は既存 `isSubmittingCreate` で対応

採用しなかった案: 失敗時に「最後にクリックした selectType を highlight する」 → 不要な複雑さ。 button 2 個並びなので「どっちで失敗したか」 をユーザーは記憶している前提で十分。

#### 5. atomic / user_id / sort_key — Tag-4c-2a Task 1 の `handleCreateCategory` をそのまま再利用

`tagEditCallbacks.createCategory` の実装は無改修。 popover 側の呼出経路が変わるだけ。

- atomic: `db.transaction('rw', tag_categories, entity_mutations, ...)` 2 store rw lock + Dexie auto-rollback
- user_id: `props.userId` (auth() 由来)、 空文字なら early return + console.error (Tag-4c-2a Task 1 で実装済)
- sort_key: `nextCardSortKey(categories.map(c => c.sort_key))` で同 scope max+1 (Tag-4c-2a Task 1 で実装済)

#### 6. 型選択 stage の auto-focus

stage 表示時、 「複数 (multi)」 button にデフォルト focus (default selectType = multi の踏襲)。 ユーザーが Enter キーで「複数」 を即決定できる。 single を選ぶには Tab + Enter or click。

- `useEffect(() => { if (stage === 'createCategoryType') multiButtonRef.current?.focus() }, [stage])` で実装

### Error handling

- atomic tx 失敗 → Dexie auto-rollback + inline error 表示 (§設計判断 4)
- enqueue 失敗もまとめて tx auto-rollback (Tag-4c-2a Task 1 と同型)
- server apply 失敗は既存 `entity_mutation_flush` の retry + `failed[]` reconcile (本 sprint 無改修)
- 同名 category: 抑制せず作成許容 (§設計判断 3、 schema + 既存挙動と整合)

### Tests strategy (test 観点のみ、 詳細 case は plan 側で task 単位で割る)

- **card-tag-option-list.test.tsx**: `kind='category'` 動作 = Check icon 非表示、 onItemClick が assign ではなく stage 遷移用 callback で発火、 suppressCreateOnExactMatch=false で完全一致時に新規作成行が出る、 既存 `kind='option'` (default) の挙動は regression なし
- **card-tag-add-popover.test.tsx**: stage1 が combobox 化、 input + filter + 「+ 新規作成」 行、 完全一致 category でも新規作成行が出る (regression: option では出ない)、 新規作成行 click → stage='createCategoryType' に遷移 (pendingCategoryName セット)、 createCategoryType stage の見出し / 2 button / back button / inline error / multi button default focus、 各 button click → `createCategory(name, selectType)` 呼出 + 成功 stage='option' / 失敗 inline error、 Esc 5 stage 全パターン (createCategoryType → category 含む)、 popover close reset (`pendingCategoryName` 含む)、 旧 `createCategory` stage の JSX / state / handler が**全削除** (dead code 残存なし)
- **card-tag-edit-popover.test.tsx**: `kind='option'` 明示渡し (or default で動く) regression、 Tag-4c-2a Task 4 の挙動 (combobox + 新規作成 + 即付与) 不変
- **smoke**: stg 実機で 16 観点 (plan 同梱 checklist)

## 規模見積もり

- 改修 3 file + test 改修 + 新規 test: 純増 ~350-450 行 (旧 createCategory stage 90 行削除 + 新 combobox 配線 + 型選択 stage + generalize 分岐)
- plan は ~250-280 行 (300 cap 内、 Task 数 5 程度)、 Tag-4c-2a-fix は Tag-4c-2a の bb1fbe89 に **amend で畳む**ため commit 数は増えない

## 受入基準 (Acceptance criteria)

- stage1 上部に input、 末尾に「+ 新規作成: {入力値}」 行が常設 (option stage2 と同 UX)
- input で category 一覧が部分一致絞り込み (case-insensitive)
- 既存 category 行 click → stage='option' 遷移 (regression、 Tag-4c-1/4c-2a 挙動維持)
- 完全一致 category 名があっても新規作成行が**出る** (option との差、 schema 仕様反映)
- 「+ 新規作成」 行 click → 型選択 stage に遷移、 まだ category は作成されない (DB / mirror 変化なし)
- 型選択 stage = 見出し + 2 button (multi default focus) + back + inline error 領域
- single / multi 各 button click → `createCategory(name, selectType)` 呼出 + 成功で stage='option' + 新 id に遷移 + form / state reset
- 失敗時 stage='createCategoryType' のまま + inline error + 再試行可
- 旧「+ カテゴリを追加」 button + 旧 `createCategory` stage が DOM / source code から**完全消滅** (dead code 残存なし)
- Esc 5 stage 全パターンが正しく動く (createCategoryType → category への置換が反映)
- popover close で全 state reset (`pendingCategoryName` 含む)
- option 作成 / edit 経路 (Tag-4c-2a / 4c-1) 全 regression なし
- npm dep 追加ゼロ、 manager 画面据置

## リスク / オープン論点

1. **CardTagOptionList の props 膨張**: `kind` 分岐で props が 10+ になり、 component contract がやや煩雑。 plan の Task 1 で型を整理 (`type CardTagOptionListProps = OptionProps | CategoryProps` の discriminated union or 共通 base + 各 kind 用 optional)。 discriminated union が a11y / strict 検査で扱いやすい。
2. **既存 test の regression coverage**: `CardTagOptionList` の既存 test は option-only 前提。 generalize 後の default (kind='option' 未指定) で挙動不変を test で固定 + kind='category' の new test を追加。
3. **stage 置換後の操作感**: `createCategory` (旧) と `createCategoryType` (新) では stage 名前は似ているが中身が大きく異なる (前者は名前 + 型 1 画面、 後者は型のみ)。 Tab focus 順 / Esc 階層 / state reset の網羅性は plan の各 Task で test 網羅 (Tag-4c-2a と同方針)。
4. **category 同名許容 UX の確認**: smoke checklist で「完全一致でも新規作成行が出る → 別 id の category が作成される」 ことを OT が実機確認。 違和感あれば後追いで同名警告 dialog 等の議論。
5. **`handleRenameCategory` の trim / normalize 不整合** (Step 0 red flag #3): 本 sprint scope 外、 別 chore で対応 (spec § Out of scope に明記済)。
6. **`isSubmittingCreate` 単一 flag の流用**: 旧 createCategory 用 + 型選択 stage 用で同一 flag。 user が stage='createCategoryType' のとき stage='option' 経路で同時 submit する経路は存在しないため安全 (1 popover 内 1 操作前提)。
7. **commit message の取り扱い**: `git commit --amend` で b1fbe89 に畳む際、 commit message は既存 (Tag-4c-2a) のまま or 「+ stage1 combobox 化 (4c-2a-fix)」 を追記するか OT 判断 (plan に明記)。

## Commit / Push 方針 (OT 指示反映)

- 本 sprint の全変更を、 Tag-4c-2a の commit `b1fbe89` に `git commit --amend` で**畳む** (別 commit を積まない)
- amend 後の commit message は OT が必要に応じて差分追記 (例: bullet「+ stage1 を category combobox に統一 (Tag-4c-2a-fix)」)
- `b1fbe89` は (OT 認識として) push 済 → push は `git push --force-with-lease origin develop` で OT が実行 (Claude Code は push しない)
- もし amend 時点で `b1fbe89` が未 push (origin/develop に未存在) なら、 OT 判断で通常の `git push` で済む。 plan 末で「実 push 前に `git status` で origin との関係を確認 → force-with-lease / 通常 push を OT が選択」 と明記
- `[no-review]` tag は OT brief で前 commit 継承 (本 sprint 単独で formal review を回さない方針も継承)

## 参照

- 実装対象: `app/(app)/app/exams/[id]/_components/card-tag-{option-list,add-popover,edit-popover}.tsx`
- Tag-4c-2a spec (前提): `docs/superpowers/specs/2026-06-08-tag-4c-2a-popover-inline-create-design.md`
- Tag-4c-2a plan: `docs/superpowers/plans/2026-06-08-tag-4c-2a-popover-inline-create.md`
- Tag-4c-1 plan (popover stage / Esc 階層 / atomic tx pattern 確立): `docs/superpowers/plans/2026-06-08-tag-4c-1-popover-inline-edit.md`
- schema: `lib/db/schema.ts:664-691` (tag_categories、 UNIQUE なし)、 `:699-725` (tag_options、 UNIQUE(category_id, name))
- 既存 server apply (改修不要): `lib/tags/apply-tag-mutation.ts:37-57` (category create)、 `:172-203` (option create)
- 既存 `handleCreateCategory` (Tag-4c-2a Task 1、 無改修): `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (handleCreateCategory module-scope fn 周辺)
- 旧 `createCategory` stage の現位置 (Tag-4c-2a Task 3、 削除対象): `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:504-593`
- Step 0 調査結果: 本 spec §Architecture / §設計判断 / §リスク に反映済 (別 file 化なし)
