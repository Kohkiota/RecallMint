# Tag-4b-fix: タグ section UI を Notion 方式 (popover) に再設計

## Goal

Tag-4b (commit `c2336be`) で着地した「全カテゴリ常時縦展開 + 各行に + 追加」 UI を、 **Notion 方式コンパクト + popover 編集** に作り直す。 付いてるタグだけバッジ表示 + 「+ タグを追加」 1 つ、 バッジ click でそのカテゴリの option を popover で編集、 新規追加は「カテゴリ選択 → option 選択」 の 2 stage popover。

## 背景・問題

現状 Tag-4b の問題:
- 全カテゴリ (実環境で 13 個) が常に縦展開、 付いてないカテゴリも「+ 追加」 行を占有
- card が縦長・空欄だらけ、 MVP として厳しい
- 縦リスト UI (table grid ではない) でカテゴリ全部展開は構造的破綻

## Scope

### In scope (Tag-4b-fix)
- バッジ表示形式: 「カテゴリ名: option名」 形式 (例「分野: 循環器」)
- バッジに × button (1 click で解除)、 バッジ本体 click でそのカテゴリの option popover
- 「+ タグを追加」 button 1 つ → 2 stage popover (カテゴリ選択 → option 選択)
- カテゴリ 0 件は「+ タグを追加」 button のみ表示、 click で popover に placeholder + tag manager link
- option 0 件カテゴリは stage 2 で placeholder + tag manager link
- shadcn Popover (既存 Tag-4a 導入済) を再利用、 DropdownMenu は使わない
- option list 共通 sub-component (`card-tag-option-list`) で「新規追加 stage 2」 と「バッジ編集 popover」 を統一
- Esc キー挙動: 「+ タグを追加」 popover の stage 2 で Esc → stage 1 に戻る、 再 Esc or 外 click で閉じる (Notion 方式)
- popover sizing: shadcn 既定 + max-w-sm
- a11y: バッジ本体 button + × 独立 button + popover focus trap、 keyboard Enter / Esc 対応
- npm dep 追加なし (lucide-react + shadcn Popover + 既存)

### 維持する設計 (Tag-4b で確立済、 不変)
- optimistic 即反映: `db.card_tags.put/delete` + 最新 whole-set 構築 → `enqueueEntityMutation`
- **whole-set 不変条件** (他カテゴリ落とし回避): 全カテゴリ横断 `allAssignedOptionIds` から自カテゴリ差分のみ適用
- single = 最大 1 個・0 個許容、 同 option 再 click で 0 個に戻る
- parent `InlineCardList` 一括 subscribe + useMemo + 子 `React.memo`
- 案 a 取り直し (cards.updated_at bump → pull)
- color 表示: 既存 `colorToClass` palette を継続使用 (バッジ背景色)
- npm dep 追加ゼロ

### Out of scope (別 sprint)
- 文字入力検索 (combobox) + 新規 option 作成 → **Tag-4c** (popover 構造は input を追加できる separation を残す)
- フィルタ + bulk edit → Tag-4d
- card grid 化 (Notion 風 table) → 将来 todo

## Architecture

### file 構成

**新規作成:**
- `app/(app)/app/exams/[id]/_components/card-tag-badge.tsx` (~60 行、 「カテゴリ名: option名」 + × + 本体 click で popover trigger)
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (~90 行、 2 stage popover: stage 1 = カテゴリ選択、 stage 2 = option 選択 + 戻る)
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` (~50 行、 バッジ click 単 stage popover、 該当カテゴリの option のみ)
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (~80 行、 option list 共通 sub-component、 multi/single 切替、 popover content 内に使う)
- 各 test 4 件 (~400 行 合計)

**大幅改修:**
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (~120 行、 orchestrator + optimistic logic 集約 + 付与済バッジ群 + 「+ タグを追加」 button)
- `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx` (~150 行、 test 書き直し)

**削除:**
- `app/(app)/app/exams/[id]/_components/card-tag-pill.tsx` + test (置換: card-tag-badge)
- `app/(app)/app/exams/[id]/_components/card-tag-add-dropdown.tsx` + test (置換: card-tag-add-popover)
- `app/(app)/app/exams/[id]/_components/card-tag-category-row.tsx` + test (構造変更で不要)

**不変:**
- `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` (parent 一括 subscribe は維持、 子 component の渡し方が変わるので props を `tagsByCardId.get(card.id)` のまま)

### Data flow

```
[InlineCardList (parent、 不変)]
  ├─ useLiveQuery 一括 subscribe (cards × tag_categories × tag_options × card_tags)
  ├─ useMemo で categories / options 安定化
  └─ 各 card に props (categories, options, cardTags) 渡し
       │
       ▼
[CardTagsSection (orchestrator、 改修、 optimistic logic 集約)]
  ├─ 付与済バッジ群 + 「+ タグを追加」 button
  ├─ optimistic 更新 logic: onToggle(categoryId, optionId) callback
  │   - allAssignedOptionIds を維持しつつ自カテゴリ差分のみ適用 (whole-set 不変条件)
  │   - db.card_tags.put/delete → enqueue → flush
  └─ popover に props (categories, options, allAssignedOptionIds, onToggle) 渡し
       │
       ├─ <CardTagBadge /> × N (付与済タグ分)
       │   - 「カテゴリ名: option名」 表示
       │   - × button: stopPropagation で onToggle(catId, optId) (削除)
       │   - 本体 click: <CardTagEditPopover /> 開く
       │       └─ <CardTagOptionList /> (該当カテゴリの option、 multi/single)
       │
       └─ <CardTagAddPopover />
           - 「+ タグを追加」 button trigger
           - stage 1: カテゴリ選択 (全カテゴリ + 型アイコン)
           - stage 2: <CardTagOptionList /> (選択カテゴリの option、 multi/single)
           - footer: tag manager link
```

### 重要な設計判断

#### 1. optimistic logic を CardTagsSection に集約

現状 Tag-4b では `card-tag-category-row` が optimistic logic を保持していた。 構造変更後は **section が唯一の logic 持ち**、 popover/badge は callback ベースの presentation only:

```ts
// CardTagsSection 内
const handleToggle = async (categoryId: string, optionId: string) => {
  const category = categories.find(c => c.id === categoryId)
  if (!category) return
  const sameCategoryOptionIds = new Set(options.filter(o => o.category_id === categoryId).map(o => o.id))
  const oldSet = new Set(allAssignedOptionIds)
  const newSet = new Set(allAssignedOptionIds)
  
  if (category.select_type === 'multi') {
    if (newSet.has(optionId)) newSet.delete(optionId)
    else newSet.add(optionId)
  } else {
    // single: 同カテゴリ既存 clear → 再 click なら 0 個に戻る、 別 option なら add
    for (const id of allAssignedOptionIds) {
      if (sameCategoryOptionIds.has(id)) newSet.delete(id)
    }
    if (!oldSet.has(optionId)) newSet.add(optionId)
  }
  
  const toAdd = [...newSet].filter(id => !oldSet.has(id))
  const toRemove = [...oldSet].filter(id => !newSet.has(id))
  
  // optimistic IDB
  const db = getClientDb()
  await db.transaction('rw', db.card_tags, async () => {
    for (const id of toRemove) await db.card_tags.delete([cardId, id])
    for (const id of toAdd) {
      await db.card_tags.put({card_id: cardId, option_id: id, user_id: '', created_at: new Date().toISOString()})
    }
  })
  
  // enqueue (whole-set 送信)
  void enqueueEntityMutation({
    entity_type: 'card', entity_id: cardId, op: 'update_field',
    patch: {field: 'tag_option_ids', value: [...newSet]},
  })
  void runGuardedEntityMutationFlush().catch(() => {})
}
```

#### 2. 2 stage popover (CardTagAddPopover) の挙動

```ts
type Stage = 'category' | 'option'

const [stage, setStage] = useState<Stage>('category')
const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)

// stage 1: カテゴリ一覧
//   - 各カテゴリ: name + 型アイコン (CheckSquare/Circle) + 右 ChevronRight
//   - click → setStage('option'), setSelectedCategoryId(catId)
//   - footer: tag manager link
//   - カテゴリ 0 件: placeholder + tag manager link

// stage 2: option 一覧 (選択カテゴリ配下)
//   - header: ← 「カテゴリ選択へ戻る」 button (click で setStage('category'))
//   - <CardTagOptionList categoryId={selectedCategoryId} ...>
//   - footer: tag manager link
//   - option 0 件: placeholder + tag manager link
//   - Esc: stage 'option' なら stage 1 に戻る、 'category' なら popover 閉じる
```

Esc キー処理: shadcn Popover の standard behavior は Esc で popover 閉じる。 Notion 方式 (stage 2 で Esc → stage 1) には **カスタム handler** が必要 (`onEscapeKeyDown={e => { if (stage === 'option') { e.preventDefault(); setStage('category'); } }}`)

#### 3. バッジ click 編集 (CardTagEditPopover)

stage なし、 直接 option 選択:

```tsx
<CardTagEditPopover
  category={category}                       // バッジが属するカテゴリ
  categoryOptions={categoryOptions}          // そのカテゴリ配下の全 option
  selectedOptionIds={selectedInCategory}     // バッジが属するカテゴリで付与済の option_id
  onToggle={(optionId) => onToggle(category.id, optionId)}
>
  <CardTagBadge ... />     // popover trigger
</CardTagEditPopover>
```

popover content:
- header: 「{カテゴリ名} を編集」
- `<CardTagOptionList />` (該当カテゴリ option、 multi/single 切替)
- footer: tag manager link

#### 4. CardTagOptionList (共通 sub-component)

新規追加 stage 2 と編集 popover の両方で使う。 multi/single 切替で挙動分岐:

```ts
type Props = {
  options: ClientTagOption[]               // 該当カテゴリの全 option、 created_at ASC
  selectedOptionIds: Set<string>            // 該当カテゴリで付与済
  selectType: 'single' | 'multi'
  onToggle: (optionId: string) => void
  showTagManagerLink: boolean               // 0 件時 placeholder の link 表示
}
```

- option 0 件: placeholder「このカテゴリには option がありません」 + tag manager link
- 各 option: color pill (`colorToClass` の小サイズ) + name + (selected なら lucide `Check`)
- multi: click で onToggle、 popover 開いたまま
- single: click で onToggle、 popover 閉じる (shadcn Popover の close API 経由)
- 構造 separation で **Tag-4c の combobox 化に input を上部に追加できる余地** を残す:
  ```tsx
  <div>
    {/* 将来: <input> 検索 field (Tag-4c) */}
    <ul>{options.map(...)}</ul>
  </div>
  ```

#### 5. バッジ表示

「{カテゴリ名}: {option名}」 形式:

```tsx
<button
  type="button"
  aria-label={`タグ: ${category.name}: ${option.name}`}
  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${colorToClass(option.color)}`}
  onClick={() => setEditOpen(true)}    // popover trigger
>
  <span>{category.name}: {option.name}</span>
  <span
    role="button"
    aria-label={`タグ削除: ${category.name}: ${option.name}`}
    onClick={(e) => { e.stopPropagation(); onRemove(); }}
    className="ml-0.5 hover:text-slate-900"
    tabIndex={0}
  >
    ×
  </span>
</button>
```

注: バッジ本体は `<button>`、 × は内側に `<span role="button">` (button 入れ子は a11y NG)。 keyboard: バッジ Tab focus → Enter で popover open、 × Tab focus → Enter で削除。

#### 6. tag manager link の配置 (現状から変更)

**現状 (Tag-4b)**: タグ section 見出し横 + カテゴリ 0 件 placeholder 内
**新規 (Tag-4b-fix)**: **popover footer のみ** (見出し横 link は削除)

理由 (OT 補足):
- 見出し横の常時リンクは card ごとに繰り返されて冗長 (card 10 枚で 10 個出る)
- tag manager に行きたい瞬間 = 「欲しい option がない」 = popover を開いた時
- 動線は popover footer + nav の「タグ」 link で十分

footer は全 popover (新規追加 stage 1/stage 2、 編集 popover) 共通で配置。

#### 7. parent subscribe + memo は不変

`InlineCardList` の useLiveQuery + useMemo + 子 React.memo の構造は維持。 `CardTagsSection` の props shape も同 (categories, options, cardTags)。 内部 logic 集約のみ。

### Error handling

- IDB transaction 失敗: `console.error` + 操作 rollback (元の状態に戻す)、 toast 表示は最小 (Tag-4b と同方針)
- server failed[]: `entity-mutation-flush.ts` の既存 retry / pull 経路で reconcile
- popover が開いたまま delete 操作した場合: useLiveQuery が再描画されて popover content も自動更新

### Tests strategy

- card-tag-badge.test.tsx: 「カテゴリ名: option名」 表示、 × button click で onRemove、 本体 click で popover open
- card-tag-option-list.test.tsx: multi toggle、 single radio 的 + 0 個許容、 0 件 placeholder + link
- card-tag-add-popover.test.tsx: stage 1 (カテゴリ選択) + stage 2 (option 選択) + Esc 挙動 + tag manager link
- card-tag-edit-popover.test.tsx: 該当カテゴリ option 表示、 onToggle 経由で section の logic 呼出
- card-tags-section.test.tsx: 付与済バッジ群 render + 「+ タグを追加」 button + optimistic logic (whole-set 不変条件、 single 0 個許容、 他カテゴリ落とし回避)

## 規模見積もり

- 新規 4 components + section 改修 + test: 純増 ~700 行
- 旧 3 components + 各 test 削除: 純減 ~400 行
- ネット **+300 行** 程度
- plan は ~180 行で 300 cap 内

## 参照

- 改修対象: `app/(app)/app/exams/[id]/_components/card-tag*.tsx`、 `card-tags-section.tsx`
- 既存 shadcn Popover: `components/ui/popover.tsx`
- Tag-2c handler (server、 改修不要): `lib/cards/card-field-handlers.ts:CARD_FIELD_HANDLERS.tag_option_ids`
- 案 a 取り直し設計: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` §4
- Tag-4b smoke (型紙の妥当性確認): `docs/superpowers/sessions/2026-06-07-tag-4b-stg-smoke.md`
- Tag-4a-fix 型紙 (optimistic + pen icon + a11y): `docs/superpowers/sessions/2026-06-07-tag-4a-fix-stg-smoke.md`
- color palette: `lib/tags/color-palette.ts` (`colorToClass`)
