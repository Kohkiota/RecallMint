# Tag-4a: タグ管理 page (`/app/tags`) 設計仕様

## Goal

独立 page `/app/tags` を新設し、 タグカテゴリと option を作成 / リネーム / 削除 / カラー変更 / カテゴリ間移動できる UI を提供する。 Tag-1 で着地済の `entity_type='tag_category'` / `'tag_option'` mutation 経路を **初めて UI から呼ぶ** sprint。

Tag-4 を 4a/4b/4c/4d に分割した最初の sprint で、 ライト案を採用 (D&D 並べ替えは Tag-4e に逃がして 4a を最小化、 Tag-4b → Tag-3 → 4c → 4d に早く進む)。

## Scope

### In scope (Tag-4a)
- 独立 page `/app/tags` + nav 5 番目に「タグ」 link 追加 (`prefetch={false}`)
- 左 1/3 カテゴリリスト + 右 2/3 option リスト の 2 column (CSS grid `md:grid-cols-3` の `col-span-1` + `col-span-2`)、 mobile (< md) は `shadcn Tabs` 切替に fallback。 `react-resizable-panels` は導入せず (依存追加ゼロ方針)
- カテゴリ: 追加 / リネーム (in-place) / 削除 (AlertDialog で影響範囲表示)、 `select_type` は作成時のみ選択 (immutable)
- option: 追加 / リネーム (in-place) / 削除 (AlertDialog で影響範囲表示) / カラー変更 (pill クリック → palette popover) / カテゴリ間移動 (option の「カテゴリ変更」 ボタン → dropdown)
- 固定 12 色 palette + 「色なし」 (= 13 selectable)
- UNIQUE(category_id, name) 違反: client 側で IDB 事前チェック + server failed 受領時 fallback の二段防御
- `/app/tags/loading.tsx` で即時 fallback 表示

### Out of scope (別 sprint)
- ドラッグ並べ替え (`@dnd-kit` 導入含む) → Tag-4e
- 試験詳細 page からの「タグ管理 →」 link → Tag-4b
- card のタグ付与 / 解除 UI → Tag-4b
- inline select UX (combobox + 新規 option その場作成) → Tag-4c
- フィルタ / bulk edit → Tag-4d
- OCR からの自動タグ → Tag-3

## Architecture

### file 構成

- `app/(app)/app/tags/page.tsx` (Server Component、 静的シェル、 nav active 表示)
- `app/(app)/app/tags/loading.tsx` (即時 fallback)
- `app/(app)/app/tags/_components/tag-manager-shell.tsx` (Client、 2 column / tab fallback の layout)
- `app/(app)/app/tags/_components/category-list.tsx` (左 column、 カテゴリ一覧 + 追加 / リネーム / 削除)
- `app/(app)/app/tags/_components/category-create-form.tsx` (新規カテゴリ作成、 name + select_type)
- `app/(app)/app/tags/_components/category-row.tsx` (カテゴリ 1 行、 inline rename + 削除 button)
- `app/(app)/app/tags/_components/option-list.tsx` (右 column、 active カテゴリ配下の option 一覧)
- `app/(app)/app/tags/_components/option-row.tsx` (option 1 行、 inline rename + color pill + カテゴリ変更 + 削除)
- `app/(app)/app/tags/_components/option-create-form.tsx` (新規 option 作成、 name + color)
- `app/(app)/app/tags/_components/color-palette-popover.tsx` (12 色 + 色なしの popover)
- `app/(app)/app/tags/_components/delete-confirm-dialog.tsx` (影響範囲表示の AlertDialog 共通 component)
- `lib/tags/color-palette.ts` (固定 palette 定義 + 色名 → Tailwind class mapping)
- `app/(app)/app/_components/app-header.tsx` (nav に「タグ」 link 追加、 `prefetch={false}`)

### Data flow

```
[UI 操作]
  └─ enqueueEntityMutation({entity_type: 'tag_category' or 'tag_option', op, patch})
       │
       ▼
[Dexie entity_mutations outbox]
  └─ 既存の coalesce / debounce / flush 経路
       │
       ▼
[server bulk endpoint + registry dispatch]
  └─ applyTagCategoryX / applyTagOptionX (Tag-1 着地済、 無修正)
       │
       ▼
[pull で IDB tag_categories / tag_options に反映]
  └─ useLiveQuery で全画面が自動再描画
```

- **読み出し**: 全 component が `useLiveQuery(() => db.tag_categories.toArray() / db.tag_options.where('category_id').equals(activeCategoryId).toArray())` で IDB 直読
- **書き込み**: `enqueueEntityMutation` で outbox → debounce → flush。 既存 6 field handler (Tag-2a/2c) と同じ経路
- **影響範囲 count** (削除 confirm 用): `db.card_tags.where('option_id').equals(...).count()` / カテゴリ削除時は配下 option を取得して全 option の card_tags count を集計、 すべて IDB ローカル query (server roundtrip ゼロ)

### Color palette

固定 12 色 + 色なし (`lib/tags/color-palette.ts`):

```ts
export const TAG_COLOR_NAMES = ['red','orange','amber','yellow','lime','green','emerald','teal','cyan','blue','violet','pink'] as const
export type TagColorName = typeof TAG_COLOR_NAMES[number]

// pill 表示用 Tailwind class mapping
export const COLOR_TO_CLASS: Record<TagColorName, string> = {
  red:     'bg-red-100 text-red-800 border-red-200',
  orange:  'bg-orange-100 text-orange-800 border-orange-200',
  // ... 12 色分
}

export const COLOR_NULL_CLASS = 'bg-slate-100 text-slate-700 border-slate-200'
```

- `tag_options.color` の保存形式は **色名の短い文字列** (`'red'` / `'blue'` / `null`)
- DB に hex / OKLCH 保存ではなく色名: palette 拡張 / Tailwind class 変更時に DB 移行が要らない
- 未知の色名 (将来 palette 削除した場合) は `COLOR_NULL_CLASS` に fallback

## UI 仕様 (確定事項)

### 1. page レイアウト (1=A)
- 左 1/3 カテゴリリスト + 右 2/3 option リスト (CSS grid `md:grid-cols-3` の `col-span-1` + `col-span-2`)。 境界線ドラッグなし (固定幅、 MVP として十分)
- mobile (< md breakpoint) は `shadcn Tabs` で「カテゴリ」 「option」 の 1 active 切替
- カテゴリ row クリックで「active」 状態 → 右 panel に該当カテゴリ配下の option リスト切替 (mobile では options tab に自動切替)
- `react-resizable-panels` は導入せず (npm dependency 追加ゼロ方針)

### 2. in-place 編集 (2=A)
- name: 既存 `inline-text-field` 流儀 (click → input 化 → blur で確定 + enqueue)
- color: pill click → popover で 12 色 + 「色なし」 から選択、 選択で即 enqueue
- 削除: 行末「× ボタン」 → AlertDialog (影響範囲表示)
- カテゴリ間移動: option 行内「カテゴリ変更」 button (4=B) → dropdown で別カテゴリ選択

### 3. ドラッグ並べ替え なし (3=C、 Tag-4e 送り)
- **sort_key 入力 UI は持たない** (4a スコープ外、 Tag-4e で D&D + sort_key UI を一括で入れる)
- 表示順は `created_at ASC` で固定 (新規 option は末尾に追加表示)
- `tag_options.created_at` は既存 schema にあり、 pull payload に含まれている (Tag-2b で確認済)
- カテゴリの表示順も同方針 (`tag_categories.created_at ASC`)

### 4. カテゴリ間 option 移動 (4=B)
- option 行に「カテゴリ変更」 button (kebab menu の中 or 専用 icon button)
- click → dropdown で別カテゴリ選択 (現カテゴリ以外)
- 確定 → `enqueueEntityMutation({entity_type:'tag_option', op:'update_field', patch:{field:'category_id', value: targetCategoryId}})`
- 移動先カテゴリで同名 option 存在 → server `failed` → UI で「移動先に同名 option が存在します」 表示 (client 側 IDB 事前チェックも可、 二段防御)

### 5. color palette (5=A)
- 上記 `TAG_COLOR_NAMES` 12 色 + null
- popover で 13 cell の grid 表示、 1 click で確定

### 6. nav 追加
- `app-header.tsx` に「タグ」 link を 5 番目に追加 (アップロード / 試験 / スマート復習 / タグ / 設定 の順)
- `prefetch={false}` 必須 (T2.5 警告対応)
- active 表示 (現在 path が `/app/tags*` の時)

### 7. 削除 confirm dialog (`delete-confirm-dialog.tsx`)
- カテゴリ削除:
  - title: 「カテゴリ『{name}』 を削除しますか?」
  - 影響範囲: 「配下の option {N} 件、 紐付き card {M} 件のタグも消えます」 ({N}, {M} は IDB count)
  - destructive button + cancel
- option 削除:
  - title: 「option『{name}』 を削除しますか?」
  - 影響範囲: 「{M} 件の card に紐付いています」 ({M} は IDB count)
  - destructive button + cancel
- **既存 `components/ui/confirm-dialog.tsx` の `ConfirmDialog` を再利用** (a11y / focus / Esc / backdrop close 担保済の自前 portal-based component)。 影響範囲表示は `description: React.ReactNode` prop に JSX (count を含む文言) を渡す形で実現。 `delete-confirm-dialog.tsx` は ConfirmDialog の薄いラッパー (カテゴリ用 / option 用の文言差を吸収)。 shadcn の AlertDialog は導入せず

### 8. UNIQUE 違反のローカル + server 二段防御
- option 作成 / リネーム / カテゴリ移動時:
  - client: IDB `tag_options.where({category_id, name}).count() > 0` (自分自身除く) → 即「同名が既に存在します」 表示、 enqueue 抑止
  - server (race 対応): `failed[]` に含まれて返ってきた場合、 client UI で同 message 表示 + 操作を巻き戻し (in-place input を元の値に戻す)
- カテゴリは name 重複 OK (UNIQUE なし、 spec §1.2) なので、 カテゴリ作成 / リネーム時はチェックなし

### 9. 4a の入口
- グローバル nav (header) からの「タグ」 link のみ
- 試験詳細 page からの「タグ管理 →」 link は Tag-4b

## Error handling

- enqueue 失敗 (Dexie 書込失敗): `lib/sync/entity-mutations.ts` の既存エラー path で `console.error` + toast、 UI は元値表示
- flush 失敗 (network / 500): 既存 retry 経路、 UI には pending 表示なし (Tag-2a smoke で確認済の挙動)
- per-mutation `failed[]` 受領: 各 mutation_id を UI で照合し、 該当 row に inline error 表示 (red 枠 + message)
- 影響範囲 count が大きい (e.g. > 100 card) 場合: AlertDialog の表示を `100+` に省略 (UI が長くならない、 IDB count は O(index lookup))

## Tests strategy

- `tag-manager-shell.test.tsx`: layout 切替 (desktop 2 column / mobile tab) のレンダリング test
- `category-list.test.tsx`: useLiveQuery mock で カテゴリ 0 件 / 複数件、 追加 / リネーム / 削除 → enqueue 呼出確認
- `category-create-form.test.tsx`: name 空 → submit 不可、 submit → enqueue + form reset
- `option-list.test.tsx`: activeCategoryId 切替で表示が変わる、 リネーム / 色変更 / カテゴリ移動 / 削除 → enqueue 呼出確認
- `option-create-form.test.tsx`: UNIQUE 違反 client 事前チェック、 enqueue 呼出確認
- `color-palette-popover.test.tsx`: 13 cell 表示 + click で onChange 呼出
- `delete-confirm-dialog.test.tsx`: 影響範囲 count 表示 (mock IDB)、 確定 → onConfirm 呼出
- `color-palette.test.ts`: COLOR_TO_CLASS の各 color が定義されている、 不明 color の fallback
- E2E (Playwright) は 4b smoke で一括 (4a だけだと「タグ作って終わり」 で意味薄い)

## 規模見積もり

- Server / domain: 0 行 (Tag-1 で全完了)
- Client UI: ~300-350 行 (10 components + palette util)
- Tests: ~150-200 行 (Vitest + React Testing Library 主体、 既存 inline-text-field.test.tsx と同パターン)
- nav 追加: ~10 行
- **合計 350-450 行**、 plan 行数 ~150 行で 300 cap 内余裕

## Out of scope (明示)

- D&D 並べ替え + `@dnd-kit` 導入 → Tag-4e
- 試験詳細 page からの「タグ管理 →」 link → Tag-4b
- card のタグ付与 / 解除 UI → Tag-4b
- inline select combobox (option その場作成) → Tag-4c
- フィルタ + bulk edit → Tag-4d
- OCR 自動タグ → Tag-3

## 参照

- 設計判断: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` (案 a 確定)
- Tag-2b + 2c plan: `docs/superpowers/plans/2026-06-06-tag-2b-2c-card-tags-sync.md`
- 既存 inline-text-field pattern: `app/(app)/app/exams/[id]/_components/inline-text-field.tsx`
- 既存 enqueue helper: `lib/sync/entity-mutations.ts`
- design tokens: `app/globals.css` (Geist + shadcn + OKLCH モノクロ)
- nav 警告: `app/(app)/app/_components/app-header.tsx:10-13` (T2.5 計測)
- registry: `lib/sync/server/entity-mutation-registry.ts:321-351` (tag_category / tag_option entry)
- card 経路と同 outbox 共有確認: `lib/client-db.ts:215` (`entity_mutations` 1 store)
- option rename 即連動 (id 参照、 scan ゼロ): `lib/db/schema.ts:734-755` (card_tags は (card_id, option_id))
