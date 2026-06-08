# Tag-4c-2a: card-tags popover 内 category / option 作成 (Notion 方式 combobox) + popover 内タグ管理 link 全削除

## Goal

試験詳細 (`/app/exams/[id]`) の card-tags popover 内で、 category / option の **新規作成** を Notion 方式の combobox で行えるようにする。 同時に popover 内に残っていた「タグ管理 →」 link を全箇所削除し、 popover 内導線のみで完結させる。 D&D 並べ替えは別 sprint (Tag-4c-2b、 dnd-kit) で扱うため本 sprint スコープ外。

## 背景・問題

Tag-4c-1 着地後、 popover で rename / color / 削除 はできるが、 新規 category / option を作るには popover を閉じ tag manager 画面 (`/app/tags`) に行く必要がある。 学習中の card 入力フローは「タグを付けようとした瞬間、 欲しい option が無い」 が典型シナリオで、 動線分断は致命的。 Notion 方式 (option 一覧上部の combobox input + 末尾「新規作成」 行 + category 末尾「+ カテゴリを追加」) で popover 内完結させる。

併せて、 popover 内の「タグ管理 →」 link は冗長になった (作成は popover 内で完結、 並べ替えは Tag-4c-2b で完結予定) ため全削除する。 nav の「タグ」 link は残す (manager 画面は据置)。

## Scope

### In scope (Tag-4c-2a)

**C-1a option 作成 (combobox を stage2 に統合)**
- stage2 (option 選択画面) 一覧上部に input を常設、 入力で一覧を**部分一致 (大小文字無視) で絞り込み**
- 一覧末尾に「新規作成: {入力値}」 行を表示
- 既存行 click = 付与 (既存挙動、 Tag-4b-fix `handleToggle` を呼ぶ)
- 「新規作成」 行 click = 新規 option 作成 + 即その card に付与 (atomic、 §Architecture 参照)
- 「新規作成」 行を**出さない**条件: 入力が空、 または完全一致 (case-insensitive trim 後比較) する既存 option が同カテゴリ内にある (同名作成防止、 manager `option-create-form` の A-2 同名弾きと一貫)
- input は stage2 表示時に**自動 focus**、 Esc は既存 stage 階層に従う (Esc → stage1 'category')

**C-1b category 作成 (stage 拡張)**
- stage1 (category list) 末尾に「+ カテゴリを追加」 行を追加 (kebab なし、 single button)
- click で新 stage `'createCategory'` に遷移
- createCategory stage の中身:
  - 名前 input (placeholder「カテゴリ名」、 stage 表示時 auto-focus)
  - select_type セグメント (single / multi)、 **デフォルト multi**
  - 「作成」 button (input 空 / space-only は disabled)
  - back button「← カテゴリ選択へ戻る」
- 確定 → category 作成 (atomic) → 成功時、 作成した category の stage2 (`option` stage、 option 一覧空) に**自動遷移**、 input は空、 「新規作成: {空}」 行は非表示なので option 0 件 placeholder に落ちる
- category 名の**同名は許容** (チェックしない、 OT 確定)。 select_type は作成後 immutable のため作成時に必ず選ばせる (型変更 UI なし、 本 sprint で導入もしない)
- Esc: createCategory → category (stage1)

**B-2 popover 内タグ管理 link 全削除**
- 削除対象:
  1. `card-tag-add-popover` footer の「タグ管理 →」 link
  2. `card-tag-add-popover` stage2 option 0 件 placeholder 内の link
  3. `card-tag-add-popover` カテゴリ 0 件 placeholder 内の link
  4. `card-tag-edit-popover` footer / placeholder 内の link (もしあれば全部)
  5. `card-tag-option-list` 0 件 placeholder 内の link (`showTagManagerLink` props 自体を撤去)
- placeholder 文言の差し替え:
  - カテゴリ 0 件 (stage1): 「下の『+ カテゴリを追加』 から作成できます」
  - option 0 件 (stage2): 「上の入力欄に名前を入れて『新規作成』 で追加できます」
- nav の「タグ」 link (= manager 画面動線) は**残す**。 manager 画面自体も本 sprint で撤去しない (併存)

**C-3 sort_key 末尾採番**
- 新規作成 option / category の `sort_key` を**整数で末尾採番**: 同 scope の既存 `sort_key` のうち**数値** (整数 string + 整数) のみ抽出 → max + 1
- 同 scope の定義:
  - category 作成時: `user_id` で絞った tag_categories の sort_key 集合
  - option 作成時: `tag_category_id` で絞った tag_options の sort_key 集合 (= 該当 category 配下のみ)
- 既存値が全 `null` の現状はまず `1` から始まる (helper `nextCardSortKey` の既存仕様、 §Architecture 参照)
- Tag-4c-1 popover の sort 順は `sort_key ASC NULLS LAST, created_at ASC` (commit `51768db`) → 末尾採番値はソートで末尾に並ぶ
- D&D による reindex 本体は **Tag-4c-2b**、 本 sprint は**作成時採番のみ**

### 維持する設計 (Tag-4b-fix / 4c-1 から継承、 不変)

- optimistic 即反映: 親 `InlineCardList` 一括 subscribe + useMemo + 子 `React.memo`
- **whole-set 不変条件** (他カテゴリ落とし回避): card_tags は whole-set replace、 全カテゴリ横断 `allAssignedOptionIds` から自カテゴリ差分のみ適用
- single = 最大 1 個・0 個許容、 同 option 再 click で 0 個
- 案 a 取り直し (cards.updated_at bump → pull)
- popover stage 構造 + Esc 階層 (Notion 方式)
- npm dep 追加ゼロ (combobox は input + 既存 shadcn Popover で組む)
- `user_id` は親 prop の `auth()` 由来値 (空文字禁止)
- **atomic 戦略 (作成系)** = `db.transaction('rw', store1, store2, ..., db.entity_mutations, async () => { mirror put(s) + enqueueEntityMutation(s) })`、 失敗時 Dexie auto-rollback (Tag-4c-1 削除系で確立済の pattern)

### Out of scope (別 sprint / 別 task)

- **C-2 D&D 並べ替え** (category / option 並べ替え) → Tag-4c-2b、 dnd-kit 導入。 本 sprint は採番 logic のみで D&D UI / reindex 経路は触らない
- **タグ管理画面 (`/app/tags`) の撤去** → 据置。 manager 併存、 並べ替えは現状 manager 側でも未実装のため Tag-4c-2b 後に再評価
- **既存 tags/_components (manager) の void enqueue / 空文字 user_id pattern 一斉差し替え** → **Sync-fix-1** (別 sprint)。 本 sprint では manager 側は触らない (popover 側の作成だけ atomic + JWT user_id で書く)
- **option / category 編集** (rename / color / delete) は Tag-4c-1 で着地済、 本 sprint で触らない
- **同名 category チェック** (許容、 UI 警告も出さない)
- **select_type 後付け変更 UI** (immutable 前提を維持)
- **option 作成「のみ」 (付与しない)** flow → combobox 新規作成行 click は**即付与一択**。 付与せず新規作成だけしたい場合は manager 画面で行う (動線 OT 確定)

## Architecture

### file 構成

**改修:**
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (+~70 行)
  - 上部に combobox input 追加 (Tag-4b-fix の line 77 予約コメント位置)
  - 内部 state で filterText 管理 → 部分一致絞り込み (§設計判断 2 参照)
  - 末尾「新規作成: {入力値}」 row (条件付き)
  - `showTagManagerLink` props 削除 (B-2)
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (+~120 行)
  - stage 状態を `'category' | 'option' | 'editCategory' | 'editOption' | 'createCategory'` に拡張
  - stage1 末尾「+ カテゴリを追加」 row 追加
  - createCategory stage の中身 (inline JSX、 別 component 化はしない、 §設計判断 4 参照)
  - Esc 階層拡張 (createCategory → category)
  - footer タグ管理 link 削除 (B-2)
  - placeholder 文言差し替え (B-2)
  - stage2 で `CardTagOptionList` に渡す callbacks に「新規作成」 を追加
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` (~±0 行)
  - タグ管理 link が残っていれば削除 (Tag-4c-1 既存実装の確認後)
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (+~100 行)
  - `handleCreateCategory(name, selectType) → Promise<{ id: string }>` (atomic tx)
  - `handleCreateOptionAndAssign(categoryId, name) → Promise<void>` (atomic tx、 作成 + 即付与)
  - sort_key 採番 logic (in-memory categories / options から max+1)
  - popover に渡す callbacks object (`tagCreateCallbacks` or `tagEditCallbacks` 拡張) に追加

**新規作成:** なし (作成系 stage は popover 内 inline で十分、 sub-component 化は YAGNI)

**不変:**
- `inline-card-list.tsx` (parent 一括 subscribe そのまま)
- `card-tag-badge.tsx`
- `lib/cards/next-card-sort-key.ts` (generic helper としてそのまま再利用、 §設計判断 3 参照)
- 既存 server apply 経路 (`lib/tags/apply-tag-mutation.ts` の `applyTagCategoryCreate` / `applyTagOptionCreate`) + pull 経路は無改修

### Data flow (作成系)

```
[ユーザー操作: stage2 input に "循環器" 入力 + 「新規作成: 循環器」 行 click]
   │
   ▼
[CardTagAddPopover (popover、 presentation)]
   │
   ├─ filterText state (input value) → CardTagOptionList の filter
   ├─ 「新規作成」 行 click → onCreateNewOption(categoryId, filterText) callback 発火
   │
   ▼
[CardTagsSection.handleCreateOptionAndAssign(categoryId, name)]
   │
   ├─ 1. sort_key 採番: options.filter(o => o.category_id === categoryId).map(o => o.sort_key) → nextCardSortKey(arr)
   ├─ 2. uuid v4 で新 option id 生成 (既存 manager と同 pattern)
   ├─ 3. 新 option を含めた whole-set 構築: const next = [...allAssignedOptionIds] にて single/multi ルール適用
   │     - single: 同カテゴリ既存 option を toRemove に積む + 新 option を toAdd
   │     - multi: 新 option を toAdd のみ
   ├─ 4. db.transaction('rw', db.tag_options, db.card_tags, db.entity_mutations, async () => {
   │       a. db.tag_options.put({ id, category_id, name, color: null, sort_key, user_id: props.userId, created_at })
   │       b. for (id of toRemove) db.card_tags.delete([cardId, id])
   │       c. for (id of toAdd)    db.card_tags.put({ card_id, option_id: id, user_id: props.userId, ... })
   │       d. enqueueEntityMutation({ entity_type: 'tag_option', entity_id, op: 'create', patch: { category_id, name, color: null } })
   │       e. enqueueEntityMutation({ entity_type: 'card', entity_id: cardId, op: 'update_field', patch: { field: 'tag_option_ids', value: next } })
   │     })
   │     失敗時 Dexie auto-rollback → 全 store 元に戻る + entity_mutations enqueue も巻き戻る
   ▼
[useLiveQuery 再描画 → popover content も自動更新、 input は空に戻す、 新 option は付与済として表示]
   │
   ▼
[void runGuardedEntityMutationFlush().catch(() => {}) (tx 外、 fire-and-forget)]
```

category 作成も同型 (`db.transaction('rw', db.tag_categories, db.entity_mutations, ...)`、 store 1 + entity_mutations、 失敗時 mirror + enqueue 同時 rollback)。

### 重要な設計判断

#### 1. option 作成 + 即付与の atomic 範囲

OT brief 明示: 「分離すると "option はできたがタグが付かない / 逆" が起きる」 → tag_options put + card_tags put + entity_mutation enqueue ×2 を**同一 Dexie tx**。 これにより:
- 成功時: 4 op 全て mirror 反映 + enqueue 完了
- 失敗時: Dexie auto-rollback で 4 op 全て巻き戻り、 ユーザーには「作成も付与も起きなかった」 状態。 入力欄に再入力可能

flush は tx 外 fire-and-forget で OK (Tag-4b-fix `handleToggle` と同じ)。 server apply は既存 `applyTagOptionCreate` + card の `tag_option_ids` 更新で reconcile される。 entity_mutation の発行順は (a) tag_option create → (b) card update_field で、 server 側 apply 順も同順を維持するため、 server で先に card update が来て存在しない option_id を参照する事故は起きない (同一 client から enqueue した順番が pull 経路の保存順を保つため。 厳密保証は既存 `entity_mutation_flush` の serialized drain に依存する)。

#### 2. combobox の責務分離 (Tag-4c-1 と非干渉)

`CardTagOptionList` (Tag-4b-fix で導入、 Tag-4c-1 で kebab 追加) は以下 3 経路を**共存**で持つ:
- a. **既存 option click → onToggle(optionId)** (= 付与 / 解除、 Tag-4b-fix から)
- b. **kebab click → onRowAction(optionId)** (= editOption stage 遷移、 Tag-4c-1 から)
- c. **新規作成行 click → onCreateNew(filterText)** (= 本 sprint で新規追加)

各 row の event handler は明確に分離 (a は row button onClick、 b は kebab span onClick + stopPropagation 既存、 c は新規作成 row 専用 button)。 row 構造は既存維持 + 新規作成行は別 `<li>` を末尾に append。 **component 分割は不要** (Step 0 Q3 で「同 component 拡張で済む」 確認済、 line 77 予約コメント位置に input 挿入)。

filter logic は **CardTagOptionList 内部 state** で持つ (`useState<string>`)。 stage2 表示中の input value は popover に保持しない (stage 遷移で reset)。 stage を `'option'` から離脱 → 再 `'option'` 入りで filter は空にリセット (`useEffect` で `selectedCategoryId` 変化時 reset)。

#### 3. sort_key 採番は `nextCardSortKey` を generic として再利用

Step 0 Q2 で確認: `lib/cards/next-card-sort-key.ts:13-33` の `nextCardSortKey(existing: (string | null)[]): string` は in-memory array → max int + 1 を返す**中立な helper**。 「card」 命名だが logic は中立。 リネームせず再利用する (リネームは Sync-fix-1 or 別 chore で別途、 本 sprint scope 外)。

呼出側 (`CardTagsSection`):
- category 作成: `nextCardSortKey(categories.map(c => c.sort_key))` (categories は user_id 絞り込み済の prop)
- option 作成: `nextCardSortKey(options.filter(o => o.category_id === categoryId).map(o => o.sort_key))`

戻り値は string (`"1"`, `"2"`, ...)。 既存 schema (`tag_options.sort_key`, `tag_categories.sort_key`) は text 型と仮定 (§リスク 1 で再確認 task として明示)。

#### 4. category 作成 stage は popover 内 inline (別 component 化しない)

stage の中身は input 1 + radio/segment 1 + button 2 (作成 / back) で ~30 行。 別 component に分けると props 受け渡しが冗長 + Tag-4c-1 `card-tag-edit-fields` のような共有需要もない (使い回されない)。 popover 内 conditional render で inline 配置。

#### 5. user_id は親 prop の auth() 由来値 (空文字禁止)

Tag-4b-fix で確立済の `props.userId` (auth() 由来) を `CardTagsSection` から使用。 manager の `void` 非 await + `user_id=''` pattern は**コピー禁止** (Tag-4c-1 plan 前提と一致)。 mirror put 時に `user_id: props.userId` を必ず渡す。 props.userId が空文字なら作成 handler 自体を early return + console.error (Tag-4b-fix の defensive と同型)。

#### 6. Esc 階層 (5 stage 化)

```ts
onEscapeKeyDown={(e) => {
  if (stage === 'editCategory')   { e.preventDefault(); setStage('category') }
  else if (stage === 'editOption')  { e.preventDefault(); setStage('option') }
  else if (stage === 'createCategory') { e.preventDefault(); setStage('category') }
  else if (stage === 'option')      { e.preventDefault(); setStage('category') }
  // stage 'category' は shadcn 標準 (popover 閉じる)
}}
```

`createCategory` 中の入力途中で Esc → 入力は破棄、 stage1 に戻る (確認 dialog なし、 Notion 同等)。 popover close 時の state reset は既存 `onOpenChange` で `setStage('category')` + 本 sprint で `setFilterText('')` + `setCreateForm({ name: '', selectType: 'multi' })` を追加。

#### 7. 「新規作成」 行の非表示条件 (詳細)

```ts
const trimmed = filterText.trim()
const filteredOptions = options.filter(o => o.name.toLowerCase().includes(trimmed.toLowerCase()))
const exactMatchExists = options.some(o => o.name.trim().toLowerCase() === trimmed.toLowerCase())
const showCreateRow = trimmed.length > 0 && !exactMatchExists
```

- **空入力 + options ≥1**: 全 option 表示 + 新規作成行非表示
- **空入力 + options 0 件** (= 新規 category 作成直後など): option list 空 + 新規作成行非表示 → **option 0 件 placeholder「上の入力欄に名前を入れて『新規作成』 で追加できます」 を表示** (§Scope B-2 と整合)
- **部分一致のみ** (入力あり + 完全一致なし + filter ヒット ≥1): filter 後の option + 新規作成行表示
- **完全一致既存** (case/whitespace 無視): filter 後 (= その option 含む) + 新規作成行非表示
- **入力あり + filter ヒット 0 件 + 完全一致なし**: option list 空 + 新規作成行のみ表示 (この場合 placeholder は出さない、 新規作成行で導線提供)

新規作成行の表示文言: `「新規作成: ${trimmed}」` (lucide `Plus` icon 付き)。

#### 8. 作成失敗時の inline error

- option 作成失敗 (atomic tx throw): popover stage は `'option'` のまま、 input value も保持、 filter 配下に `<p role="alert" className="text-xs text-red-600 mt-1">作成に失敗しました</p>` を表示。 再 click で再試行可
- category 作成失敗: stage は `'createCategory'` のまま、 input + selectType 値も保持、 同様に inline error 表示
- error state は popover ローカル state (`createError: string | null`) で保持、 input 変更で auto-clear

### Error handling

- atomic tx 失敗 → Dexie auto-rollback + inline error 表示 (上記 §8)
- enqueue 内部失敗もまとめて tx auto-rollback (`enqueueEntityMutation` を tx 内で await する仕様)
- server apply 失敗は既存 `entity_mutation_flush` の retry + `failed[]` reconcile (本 sprint 無改修)
- 同名衝突 (option): mirror 段階で `exactMatchExists` チェックにより新規作成行が出ないため UI 上発生しない。 server 側で onConflictDoNothing (既存 `applyTagOptionCreate`) のため race でも DB 二重作成は起きない
- 同名衝突 (category): 許容 (UI 警告なし)

### Tests strategy (test 観点のみ。 詳細 case は plan 側で task ごとに割る)

- **card-tag-option-list.test.tsx**: input filter (部分一致 / 大小無視)、 新規作成行表示条件 (空 / 完全一致 / 部分一致のみ)、 新規作成行 click で `onCreateNew(filterText)` 呼出、 既存 row click と新規作成行 click の event 分離
- **card-tag-add-popover.test.tsx**: 「+ カテゴリを追加」 row 表示 + click → createCategory stage、 createCategory input + selectType (default multi)、 確定 → `tagCreateCallbacks.createCategory` 呼出 + 成功時 stage='option' + selectedCategoryId=新 id、 失敗時 inline error、 Esc 階層 5 stage、 popover 内タグ管理 link 全消滅 (regression)、 stage2 input + 新規作成行 click → `tagCreateCallbacks.createOptionAndAssign` 呼出
- **card-tags-section.test.tsx**: `handleCreateCategory` の atomic tx mock (touch する stores + entity_mutations rw lock + sort_key 採番)、 `handleCreateOptionAndAssign` の atomic tx mock (4 store 同 tx + whole-set 構築 + single/multi ルール + props.userId 必須)、 enqueue throw 時の auto-rollback verify、 user_id 空文字で early return
- **smoke (Task 5)**: stg 実機で 12 観点 (新規 + regression、 plan 同梱 checklist で詳細化)

## 規模見積もり

- 改修 4 file + test 改修 + 新規 test: 純増 ~500 行
- plan は ~200 行 (300 cap 内)、 Task 数 5 程度
- Tag-4c-1 と同型の subagent-driven-development、 全 task 完了後**単一 commit** + push しない (OT stg smoke)

## 受入基準 (Acceptance criteria)

- option 作成: stage2 input に名前 + 「新規作成: {名前}」 row click → 新 option 作成 + 該当 card に即付与 + バッジ表示更新 (同 tx atomic)
- category 作成: stage1「+ カテゴリを追加」 → createCategory stage → 名前 + multi/single → 作成 → option stage (空 option list) に自動遷移
- 完全一致既存 option がある時は「新規作成」 行非表示 (同名作成防止)
- popover 内「タグ管理 →」 link が**全 popover の全 stage** で見えない (footer / placeholder 全箇所)
- placeholder 文言が popover 内導線に変更 (カテゴリ 0 件 / option 0 件)
- 作成された option / category の sort_key が同 scope の既存 max+1 (整数末尾採番)
- atomic 失敗時 mirror auto-rollback + inline error 表示 + 再試行可
- 既存 add / edit / delete / Esc 階層 / Tag-4c-1 全 15 観点 regression なし
- npm dep 追加ゼロ、 dnd-kit 未導入、 manager 画面据置

## リスク / オープン論点

1. **sort_key カラム型確認**: Task 1 投入時に Drizzle schema (`db/schema/tag.ts` 等) で `tag_options.sort_key` / `tag_categories.sort_key` の型を確認。 既存仕様 (manager forms が `null` を put) と `nextCardSortKey` 戻り値 string が整合するか。 不一致なら spec 更新 + OT 相談 (停止)。
2. **entity_mutation 順序保証**: 同一 tx 内で `enqueueEntityMutation` を 2 回呼んだ時、 既存 `entity_mutation_flush` の drain 順が enqueue 順を保つかは既存実装に依存。 Step 0 Q1 で apply 経路の serialization は確認済だが、 同一 tx 内多重 enqueue は Tag-4c-1 削除 tx で既に実施済 (commit `51768db` の `handleDeleteCategory` で複数 enqueue) のため pattern 流用で問題なしと判断。 Task 1 test で順序 verify。
3. **stage 増加による popover 操作感**: stage が 5 値に増えるため Tab focus 順 / Esc 階層 / state reset の網羅性が落ちないか。 各 stage 遷移を test で個別に pin (Tag-4c-1 と同方針)。
4. **option 作成 → 即付与の single ルール**: 新規作成 option を single カテゴリで即付与すると、 同カテゴリ既存付与 option を toRemove で落とす。 「ユーザーは作成しただけのつもりが既存付与が消えた」 と感じる可能性があるが、 OT brief で「即付与一択」 確定済 + Notion も同挙動。 smoke checklist で明示確認。

## 参照

- 実装対象: `app/(app)/app/exams/[id]/_components/card-tag-{option-list,add-popover,edit-popover}.tsx`、 `card-tags-section.tsx`
- Tag-4c-1 plan (popover stage / Esc 階層 / atomic tx pattern 確立): `docs/superpowers/plans/2026-06-08-tag-4c-1-popover-inline-edit.md`
- Tag-4b-fix spec (popover 再設計の前提): `docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md`
- sort_key helper: `lib/cards/next-card-sort-key.ts:13-33`
- 既存 server apply (create op、 改修不要): `lib/tags/apply-tag-mutation.ts:37-57` (category), `:172-207` (option)
- 既存 manager forms (本 sprint で**触らない**、 reference のみ): `app/(app)/app/tags/_components/{category,option}-create-form.tsx`
- Step 0 調査結果: 本 spec §Architecture と §リスク に反映済 (別 file 化なし)
