# Tag-4b: 試験詳細 page card にタグ section 追加 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 各 task の完了条件は `pnpm test` + `pnpm build` 緑。 全 task 完了後に **単一 commit** (Task 4 末尾)。 push しない (OT が stg smoke)。

**Goal:** 試験詳細 page (`/app/exams/[id]`) の各 card listitem に **「タグ」 section** を追加。 既存 option (Tag-4a で `/app/tags` から作成) を **付与/解除** できる UI を提供し、 Tag-2c の handler (`field='tag_option_ids'` の whole-set replace) を初めて UI から呼ぶ。

**Architecture:** parent (`InlineCardList`) で `card_tags` / `tag_categories` / `tag_options` を一括 subscribe、 card_id でグループ化して子に props 渡し + `React.memo`。 各 card row に CardTagsSection を title 行の下に配置、 カテゴリ別 pill 群 + 「+ 追加」 DropdownMenu。 optimistic は `db.card_tags.put/delete` 即時 + 最新 whole-set を enqueue (Tag-4a-fix 型紙 + Tag-2c whole-set replace の統合)。

**Tech Stack:** Next.js 15 App Router / shadcn `DropdownMenu` (Tag-4a 導入済) / lucide-react (`Plus` / `CheckSquare` / `Circle` icon、 既存) / Dexie + `dexie-react-hooks` の `useLiveQuery` / Vitest + React Testing Library。 npm dep 追加なし。

**前提:**
- 設計仕様: `docs/superpowers/specs/2026-06-07-tag-4b-card-tags-section-design.md` (241 行、 commit `2d1bcc8`)
- Tag-2c handler 着地済 (`lib/cards/card-field-handlers.ts:CARD_FIELD_HANDLERS.tag_option_ids`)、 server 改修ゼロ
- Tag-2b card_tags 独立 pull stream + Dexie store 着地済 (`[card_id+option_id]` 複合 PK)
- Tag-4a-fix 型紙 (optimistic IDB put/delete + lucide icon + a11y) を踏襲
- color palette: `lib/tags/color-palette.ts` (`colorToClass`)、 shadcn DropdownMenu: `@/components/ui/dropdown-menu`

**全 task 共通ルール:**

- TypeScript strict、 既存 `inline-text-field.tsx` の Client Component pattern を踏襲
- optimistic: `getClientDb().card_tags.put/delete` を `enqueueEntityMutation` より先に発行
- 全 UI 文言は日本語、 Tailwind class は既存 slate 系で一貫
- 全 task 完了後に **単一 commit** (Task 4 末で):
  ```
  feat(tag): Tag-4b 試験詳細 page card にタグ section 追加 [no-review]
  ```
- push しない (OT が stg smoke)

---

### Task 1: 共通 building block (pill + dropdown)

**Files:**
- Create: `app/(app)/app/exams/[id]/_components/card-tag-pill.tsx` (~40 行: 1 pill = colorToClass + name + × button + aria-label)
- Create: `app/(app)/app/exams/[id]/_components/card-tag-pill.test.tsx` (~50 行)
- Create: `app/(app)/app/exams/[id]/_components/card-tag-add-dropdown.tsx` (~120 行: shadcn DropdownMenu + lucide Plus icon trigger + multi/single 切替 logic + 0 件 placeholder)
- Create: `app/(app)/app/exams/[id]/_components/card-tag-add-dropdown.test.tsx` (~120 行)

**目的:** 後続 task で使う UI building block を独立に作る。 1 pill の表示・削除 callback、 dropdown の付与・解除 callback (multi/single 切替) を完結。

**制約:**
- card-tag-pill props: `{option: ClientTagOption, onRemove: () => void}`。 `colorToClass(option.color)` で Tailwind class、 `aria-label={`タグ削除: ${option.name}`}`。 × button click で onRemove
- card-tag-add-dropdown props: `{categoryOptions: ClientTagOption[], selectedOptionIds: Set<string>, selectType: 'single' | 'multi', onToggle: (optionId: string) => void}`。 trigger は lucide `Plus` icon + 「追加」 text + `aria-label="タグ追加"`
- multi: menu item click で onToggle、 menu は閉じない (`onSelect={e => e.preventDefault()}` で阻止)
- single: menu item click で onToggle 後 menu を閉じる
- option 0 件時: 「このカテゴリには option がありません。 タグ管理ページで追加してください。」 placeholder + `/app/tags` link
- 各 menu item: option の color pill (`colorToClass` の小サイズ) + name + (selected なら checkmark)

**完了条件:** `pnpm test` 全件緑 / `pnpm build` 緑 / 各 component の test (multi toggle / single radio 的 / 0 件 placeholder / pill remove callback) が緑

---

### Task 2: カテゴリ row + section (orchestrator)

**Files:**
- Create: `app/(app)/app/exams/[id]/_components/card-tag-category-row.tsx` (~80 行: 1 カテゴリ見出し + 型アイコン + pill 群 + add dropdown 統合)
- Create: `app/(app)/app/exams/[id]/_components/card-tag-category-row.test.tsx` (~80 行)
- Create: `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (~80 行: タグ section orchestrator、 props で受けたデータを表示、 カテゴリ 0 件 placeholder + link)
- Create: `app/(app)/app/exams/[id]/_components/card-tags-section.test.tsx` (~80 行)

**目的:** Task 1 の component を組み立てて、 1 card 内のタグ section を完成させる。 optimistic 更新 logic も本 task で実装。

**制約:**
- card-tag-category-row props: `{cardId: string, category: ClientTagCategory, categoryOptions: ClientTagOption[], assignedOptionIds: string[]}`。 assignedOptionIds は該当 card × 該当 category のみ (parent でフィルタ済)
- 型アイコン: multi なら `lucide CheckSquare`、 single なら `lucide Circle`、 `w-4 h-4 text-slate-500`、 `aria-label={`タイプ: ${category.select_type}`}`
- pill 群: assignedOptionIds を pill として描画、 各 pill の onRemove で本 row が optimistic delete + whole-set 再構築 + enqueue
- dropdown の onToggle で multi/single の logic 実装:
  - multi: 該当 optionId が assigned なら delete、 未 assigned なら put
  - single: assigned なら delete (= 0 個に戻す)、 未 assigned なら同カテゴリ既存を全 delete + 新 put (radio 的)
- optimistic 更新の発行順序: `db.card_tags.put/delete` (transaction 内) → `enqueueEntityMutation({entity_type:'card', op:'update_field', patch:{field:'tag_option_ids', value: newWholeSet}})` → `runGuardedEntityMutationFlush('card_tag_option_ids_update')`
- **whole-set 構築の重要な不変条件**: 子は自カテゴリの変更のみ行うが、 enqueue する `tag_option_ids` は **card 全カテゴリ横断の全 option_ids 集合**。 自カテゴリだけ見て送ると他カテゴリのタグが消える事故になる。 props で `allAssignedOptionIds: string[]` (該当 card の全カテゴリ横断 option_ids、 parent で計算) を受け、 自カテゴリの差分のみ適用して新 whole-set を構築:
  ```ts
  // 例: multi の toggle
  const newWholeSet = new Set(allAssignedOptionIds)
  if (newWholeSet.has(clickedOptionId)) newWholeSet.delete(clickedOptionId)
  else newWholeSet.add(clickedOptionId)
  // single の radio 的: 同カテゴリ既存を除いて新 option を追加
  const newWholeSet = new Set([...allAssignedOptionIds].filter(id => !sameCategoryOptionIds.has(id)))
  if (clickedOptionId !== alreadyAssignedSameCategory) newWholeSet.add(clickedOptionId)
  ```
- card-tags-section props: `{cardId: string, categories: ClientTagCategory[], options: ClientTagOption[], cardTags: ClientCardTag[]}`。 categories を `created_at ASC` で iterate、 各 category について options を `category_id` filter + `created_at ASC` でソート、 該当 card × category の assignedOptionIds を抽出
- カテゴリ 0 件時 (`categories.length === 0`): 「タグ管理ページでカテゴリを作成すると、 ここでタグを付けられます。」 placeholder + `/app/tags` link、 カテゴリ row は render しない
- section 見出し: `<h3 className="text-xs font-medium text-slate-500">タグ</h3>` + 横に `<Link href="/app/tags" prefetch={false}>タグ管理 →</Link>` (常時表示)

**完了条件:** `pnpm test` 全件緑 / `pnpm build` 緑 / multi toggle (click で付与/解除)、 single radio 的 (click で旧 option 外す + 新 option 付与)、 同 single option 再 click で 0 個に戻る、 pill × click で削除 + 即 enqueue、 カテゴリ 0 件 placeholder の各シナリオ test 緑

---

### Task 3: parent 修正 (一括 subscribe + 子に props 渡し)

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` (+30 行: 4 store 一括 subscribe + card_id でグループ化 + 各 card の title 行下に `<CardTagsSection />` 配置)
- Modify: `app/(app)/app/exams/[id]/_components/inline-card-list.test.tsx` / `inline-card-list-live.test.tsx` (+50 行 合計: tag 関連 store mock + 各 card に CardTagsSection が render される確認)

**目的:** Task 2 で完成した CardTagsSection を試験詳細 page の card list に組み込む。 per-card useLiveQuery を回避するため parent で 4 store を一括 subscribe (cards × tag_categories × tag_options × card_tags)。

**制約:**
- 既存 `useLiveQuery` の戻り値 (cards) を `{cards, categories, options, tagsByCardId}` shape に拡張、 並列 `Promise.all` で 4 store 取得
- card_tags は `card_id` 別の `Map<string, ClientCardTag[]>` にグループ化 (parent 内 1 度の iteration)、 子に渡す時は `tagsByCardId.get(card.id) ?? []`
- 各 card listitem の **title 行 (sort_key + title + delete) の直下** に `<CardTagsSection cardId={card.id} categories={liveData.categories} options={liveData.options} cardTags={liveData.tagsByCardId.get(card.id) ?? []} />` を配置 (問題文 div の前)
- CardTagsSection は `React.memo` でラップ (props ベース比較、 categories/options は parent から同一 ref を渡せば再描画最小化)
- **useMemo 必須 (明らかな無駄再描画の防止)**: useLiveQuery 結果は **毎回新 ref** を生成するため、 memo だけでは効かず「タグ 1 個付けただけで全 card が再描画」 になる。 parent 側で:
  - `const categories = useMemo(() => liveData?.categories ?? [], [liveData?.categories])` (useLiveQuery 結果を hash 比較で安定化)
  - `const options = useMemo(() => liveData?.options ?? [], [liveData?.options])`
  - 各 card の `cardTags = useMemo(() => liveData?.tagsByCardId.get(card.id) ?? [], [liveData?.tagsByCardId, card.id])`
  - useLiveQuery が新 ref を返しても **内容が同じなら同 ref を保持する hash 比較** (deep equal は重いので、 `JSON.stringify` ハッシュ比較 or `useLiveQuery` の戻り値が既に内容ベース差分検知している前提に依存) で過剰最適化を避ける
  - **過度な追い込みは不要**: 「明らかな無駄再描画を防ぐ程度」 で十分、 card 数が多い試験での体感は smoke で確認、 必要なら追加最適化
- live query 未解決時の fallback: 既存 `cards = liveCards ?? initialCards` と整合、 tag 関連は `liveData?.categories ?? []` 等で空配列 fallback
- 既存 `inline-card-list.tsx` の他 logic (handleAddCard / sortLikeServer 等) は不変

**完了条件:** `pnpm test` 全件緑 / `pnpm build` 緑 / 既存 inline-card-list test (cards 一覧・追加・削除等) が緑のまま、 新規 test (各 card に tag section が render される / カテゴリ 0 件で placeholder / multi/single 経路の統合動作) が緑

---

### Task 4: smoke checklist + 統合 commit

**Files:**
- Create: `docs/superpowers/plans/2026-06-07-tag-4b-smoke-checklist.md` (~80 行、 stg smoke 観点 + 手順)

**目的:** OT が stg smoke する観点 list を整理。 Tag-2c handler が UI から呼ばれる初の sprint なので、 案 a の取り直し経路 (送信 → cards.updated_at bump → pull → 別端末 IDB 反映) を実観測で確認。

**制約:**
- checklist 観点 (主要):
  1. 試験詳細 page の各 card に「タグ」 section が表示、 カテゴリ別 pill 群 + 型アイコン + 「+ 追加」 button + 「タグ管理 →」 link
  2. **multi カテゴリで付与 → 即 pill 表示** (optimistic) + 裏で applied + IDB card_tags 反映
  3. **multi カテゴリで pill × click → 即解除** (optimistic) + 裏で applied
  4. **single カテゴリで付与 → 旧 option 即外れて新 pill 表示** (radio 的)
  5. **single カテゴリで同 option 再 click → 0 個に戻る** (最大 1 個、 0 個許容の確認)
  6. dropdown 内: 付与済は checked 表示、 multi は menu 開きっぱなし、 single は閉じる
  7. カテゴリ 0 件 user の場合: section に placeholder + タグ管理 link
  8. case a 経路: 付与 → cards.updated_at bump (DevTools で IDB cards 観測) → 別端末 simulation (DevTools で別 origin / 同一端末でリロード時) → IDB card_tags 取り直し
  9. 既存 card 編集 (title / options 等) regression なし
  10. console error 0 / 全 API 200 / entity_mutations pending 残らず
- 観測手順: 主に UI 直接操作 + DevTools IDB evaluate (Tag-4a smoke と同パターン)
- 行数目安: 100-150 行 (Tag-4a 本体 checklist の 266 行より絞る、 観点は核心に集中)
- **commit はしない** (本 task の最後で controller がまとめて 1 commit)

**完了条件:**
- smoke checklist 作成済
- `pnpm test` 全件緑 (Task 1-3 で確認済、 docs 追加で影響なし、 確認のため再 run)
- `pnpm build` 緑
- 全変更 (Task 1+2+3+4) を **1 commit** で develop に積む

---

## Plan 完了後の OT smoke (push 前停止後)

OT 確認:
- 上記 checklist の 10 観点を順次 PASS/FAIL で記録
- 案 a の取り直し経路が UI から正しく動作するかが核心 (これまで stg smoke で実観測してこなかった、 UI 経由で確認できる)
- 全 PASS 判定後、 Tag-3 (OCR 自動タグ) の brainstorming に着手 (OT 順序: 4a → 4b → Tag-3 → 4c → 4d)

行数: 約 175 行 (目安 150-200 内)。
