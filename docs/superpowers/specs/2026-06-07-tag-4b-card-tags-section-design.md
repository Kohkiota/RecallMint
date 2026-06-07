# Tag-4b: 試験詳細 page の card にタグ section 追加 設計仕様

## Goal

試験詳細 page (`/app/exams/[id]`) の各 card listitem に **「タグ」 section** を追加し、 既存 option (Tag-4a で `/app/tags` から作成) を **付与/解除** できる UI を提供する。 Tag-2c の handler (`entity_type='card'` / `op='update_field'` / `field='tag_option_ids'` の whole-set replace) を **初めて UI から呼ぶ** sprint。

Tag-4a-fix で確立した型紙 (**optimistic IDB put/delete + enqueue 並列**、 **lucide icon button**、 **a11y `role="button"` + `tabIndex`**) を踏襲する。

## Scope

### In scope (Tag-4b)
- 各 card に「タグ」 section 追加 (title 行の下、 問題文の前)
- カテゴリ別の pill 群表示 + 「+ 追加」 dropdown
- single / multi の区別: カテゴリ見出し横に型アイコン (lucide `CheckSquare` / `Circle` 等)
- **single は「最大 1 個」**: 0 個 (未選択) 許容、 再 click で解除可、 別 option click で置換
- pill click (×) で解除、 dropdown menu item click で付与/解除
- optimistic 更新: `db.card_tags.put/delete` 即時 + 最新 whole-set を構築して `enqueueEntityMutation`
- parent (`InlineCardList`) で `card_tags` / `tag_categories` / `tag_options` を一括 subscribe、 子に props 渡し + `React.memo` で再描画最適化
- タグ section 見出し横に「タグ管理 →」 link (`/app/tags`)
- カテゴリ 0 件時の placeholder (「タグ管理ページでカテゴリを作成すると、 ここでタグを付けられます」 + link)
- a11y: pill / dropdown trigger / item の aria-label、 keyboard 操作

### Out of scope (別 sprint)
- 文字入力 + 既存候補検索 + 「+ 新規作成」 (option をその場で作成) → **Tag-4c**
- 試験横断 / 試験内タグフィルタ + bulk edit (複数 card 選択 → まとめて付与/解除) → **Tag-4d**
- OCR からの自動タグ付与 → **Tag-3**
- 試験詳細 page の card grid 化 (Notion 風 table) → 将来 todo (確定設計の項目 5)

## Architecture

### file 構成

- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (~80 行、 タグ section orchestrator、 props で受けたデータを表示)
- `app/(app)/app/exams/[id]/_components/card-tag-category-row.tsx` (~80 行、 1 カテゴリの見出し + 型アイコン + pill 群 + 「+ 追加」 dropdown)
- `app/(app)/app/exams/[id]/_components/card-tag-pill.tsx` (~40 行、 1 pill: option name + 色 + × button)
- `app/(app)/app/exams/[id]/_components/card-tag-add-dropdown.tsx` (~80 行、 dropdown menu、 single/multi で挙動切替)
- `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx` / `card-tag-category-row.test.tsx` / `card-tag-pill.test.tsx` / `card-tag-add-dropdown.test.tsx` (合計 ~300 行)
- 修正: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` (+30 行: 一括 subscribe + card-id でグループ化 + 各 card に props 渡し、 title 行の下に `<CardTagsSection />` 配置)

### Data flow

```
[InlineCardList (parent)]
  ├─ useLiveQuery: cards × tag_categories × tag_options × card_tags の 4 store 一括 subscribe
  ├─ card_id 別に card_tags を Map にグループ化
  └─ 各 card row に props で渡す
       │
       ▼
[CardTagsSection (per card、 React.memo)]
  ├─ tag_categories を created_at ASC で iterate
  ├─ 0 件なら placeholder + link
  └─ カテゴリごとに <CardTagCategoryRow />
       │
       ▼
[CardTagCategoryRow (per category × per card)]
  ├─ カテゴリ見出し + 型アイコン (multi/single)
  ├─ 該当 card × 該当 category の付与済 option を pill 表示
  └─ 「+ 追加」 button → <CardTagAddDropdown />
       │
       ▼
[CardTagAddDropdown (DropdownMenu)]
  ├─ 該当 category の全 option を menu item として表示
  ├─ 付与済 option は checked 表示
  ├─ multi: click で toggle (付与/解除)
  ├─ single: click で radio 的挙動 (既存解除 + 新付与、 同 option 再 click で 0 個に戻す)
  └─ 各 click で:
        1. db.card_tags.put / delete (optimistic、 即 UI 反映)
        2. 最新の whole-set (card 全 option_id) を構築
        3. enqueueEntityMutation({entity_type:'card', op:'update_field', patch:{field:'tag_option_ids', value: newSet}})
        4. runGuardedEntityMutationFlush()
```

### 重要な設計判断

#### 1. parent 一括 subscribe (per-card useLiveQuery 回避)

per-card で useLiveQuery を持つと N card 分の subscription となりオーバーヘッド大。 parent (`InlineCardList`) で 4 store を 1 度に subscribe し、 結果を card_id でグループ化して子に props 渡す。 子は `React.memo` で必要な card のみ再描画。

```ts
// InlineCardList 内
const liveData = useLiveQuery(async () => {
  const db = getClientDb()
  const [categories, options, cardTags] = await Promise.all([
    db.tag_categories.toArray(),
    db.tag_options.toArray(),
    db.card_tags.toArray(),
  ])
  // card_id 別にグループ化
  const tagsByCardId = new Map<string, ClientCardTag[]>()
  for (const t of cardTags) {
    const arr = tagsByCardId.get(t.card_id) ?? []
    arr.push(t)
    tagsByCardId.set(t.card_id, arr)
  }
  return { categories, options, tagsByCardId }
}, [])
```

#### 2. single = 最大 1 個、 0 個許容、 再 click で解除

UI 仕様:
- カテゴリ select_type='single' の場合、 同一カテゴリで **最大 1 個** の option しか付けられない
- 0 個 (未選択) も許容: 「タグなし」 状態を意味する
- 既に option-A が付いた状態で:
  - dropdown で option-A を再 click → option-A を解除 (= 0 個になる)
  - dropdown で option-B を click → option-A を解除 + option-B を付与 (= 1 個入れ替え)
- pill の × click でも同様に解除 (= 0 個になる)

server (Tag-2c handler) の whole-set replace と整合: client UI で whole-set を構築する際、 same-category-single の制約を満たした集合を送る。

#### 3. optimistic 更新の whole-set 構築 logic

各 click で:
```ts
// 現状の card_tags from card_id を取得 (props)
const currentOptionIds = new Set(tagsByCardId.get(cardId)?.map(t => t.option_id) ?? [])
const sameCategoryOptionIds = new Set(
  allOptions.filter(o => o.category_id === categoryId).map(o => o.id)
)

let newSet: Set<string>
if (clickedAction === 'add') {
  if (selectType === 'single') {
    // 同カテゴリの他 option を除く + 新 option を追加
    newSet = new Set([...currentOptionIds].filter(id => !sameCategoryOptionIds.has(id) || id === clickedOptionId))
    newSet.add(clickedOptionId)
  } else {
    newSet = new Set([...currentOptionIds, clickedOptionId])
  }
} else { // remove
  newSet = new Set([...currentOptionIds].filter(id => id !== clickedOptionId))
}

// IDB optimistic update
// 1. 旧 set との差分で put / delete
const oldIds = currentOptionIds
const newIds = newSet
const toAdd = [...newIds].filter(id => !oldIds.has(id))
const toRemove = [...oldIds].filter(id => !newIds.has(id))
const db = getClientDb()
await db.transaction('rw', db.card_tags, async () => {
  for (const id of toRemove) await db.card_tags.delete([cardId, id])
  for (const id of toAdd) await db.card_tags.put({card_id: cardId, option_id: id, user_id: '', created_at: new Date().toISOString()})
})

// 2. enqueue (whole-set 送信)
void enqueueEntityMutation({
  entity_type: 'card', entity_id: cardId, op: 'update_field',
  patch: {field: 'tag_option_ids', value: [...newIds]}
})
void runGuardedEntityMutationFlush()
```

#### 4. UI レイアウト (1 card listitem 内)

```
┌─ Card ─────────────────────────────────────────┐
│ [sort_key] [title]                  [削除 ×]   │
│                                                │
│ タグ                              [タグ管理 →] │   ← Tag-4b で追加
│   分野 [☐]:    [循環器 ×] [腎 ×]   [+ 追加]    │
│   難易度 [○]:  [高 ×]              [+ 追加]    │
│                                                │
│ 問題文                                         │
│   ...                                          │
│ 選択肢 (8 件)                                  │
│   ...                                          │
│ 解説                                           │
│ メモ                                           │
└────────────────────────────────────────────────┘
```

カテゴリ 0 件時:
```
タグ                                  [タグ管理 →]
  タグ管理ページでカテゴリを作成すると、
  ここでタグを付けられます。
```

#### 5. 型アイコン (single / multi)

- multi: lucide `CheckSquare` icon (複数選択可を表す)
- single: lucide `Circle` icon (単一選択を表す)
- size: `w-4 h-4`、 `text-slate-500`

#### 6. tag manager link

タグ section 見出し横:
```tsx
<Link href="/app/tags" prefetch={false} className="text-xs text-slate-500 hover:text-slate-900">
  タグ管理 →
</Link>
```

カテゴリ 0 件 placeholder 内にも同 link 配置 (動線を 2 箇所に)。

#### 7. dropdown UI

shadcn DropdownMenu (Tag-4a Task 3 導入済) を再利用:
- trigger: lucide `Plus` icon + 「追加」 text、 `aria-label="タグ追加"`
- content: カテゴリ配下の option を `created_at ASC` で iterate
- 各 menu item: option color pill + name + (付与済なら checkmark)
- multi: click で toggle、 menu は開いたまま
- single: click で radio 的、 menu を閉じる
- menu 内に「該当 category の option が 0 件」 の場合: 「このカテゴリには option がありません。 タグ管理 → で追加してください」 placeholder

### Error handling

- IDB transaction 失敗: `console.error` + 操作を rollback (元の状態に戻す)、 toast 表示は最小 (既存 inline-text-field と同方針)
- server failed[]: `entity-mutation-flush.ts` の既存 retry / pull 経路で reconcile
- option owner check (server) は理論的失敗、 client UI は自分の option のみ表示する設計で予防

### Tests strategy

- card-tag-pill.test.tsx: name + 色 class + × button click で onRemove 呼出
- card-tag-add-dropdown.test.tsx: option 一覧表示、 multi の toggle、 single の radio 的挙動、 0 件 placeholder
- card-tag-category-row.test.tsx: カテゴリ見出し + 型アイコン + pill 群表示 + dropdown 連携
- card-tags-section.test.tsx: カテゴリ 0 件の placeholder、 複数カテゴリの順序 (created_at ASC)、 tag 管理 link
- inline-card-list の修正部分: useLiveQuery mock で card_tags / categories / options 経路の正常動作

## 規模見積もり

- 新規 component 4 個 + test 4 個 + parent 修正 = **~700-800 行**
- plan は ~200 行で 300 cap 内余裕

## Out of scope (明示)

- inline select UX (文字入力 + 候補 + 新規作成) → Tag-4c
- フィルタ + bulk edit → Tag-4d
- OCR 自動タグ → Tag-3
- card grid 化 (Notion 風 table) → 将来 todo

## 参照

- Tag-2c handler (whole-set replace): `lib/cards/card-field-handlers.ts:CARD_FIELD_HANDLERS.tag_option_ids`
- Tag-2b card_tags pull stream: `lib/db/card-tags-pull.ts` / `lib/sync/pull.ts` の取り直し経路
- Tag-4a-fix 型紙 (optimistic + pen icon + a11y): `app/(app)/app/tags/_components/category-row.tsx` 等
- 既存試験詳細 page: `app/(app)/app/exams/[id]/page.tsx` + `_components/inline-card-list.tsx`
- color palette: `lib/tags/color-palette.ts` (`COLOR_TO_CLASS`)
- 設計判断 (案 a): `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` §4
- Tag-4a smoke 確認 (型紙の妥当性): `docs/superpowers/sessions/2026-06-07-tag-4a-fix-stg-smoke.md`
