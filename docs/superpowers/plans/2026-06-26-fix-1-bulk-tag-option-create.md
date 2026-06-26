# Fix-1 bulk タグ新規 option 作成→全選択付与 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)で実装する。Steps は checkbox 追跡。

**Goal:** bulk タグ付与 popover で新規 option(タグ)を作成し選択中の全 card に付与できるようにする(prod bug fix)。

**Architecture:** option 作成 payload を pure builder `buildNewOption` に抽出し、bulk 用 `createOption`(自前 tx・新 optionId 返却)と単票 `handleCreateOptionAndAssign`(現状の単一 atomic tx 維持)が共有。`ExamCardTableActionBar` 専用に bulk-bound `createOptionAndAssign`(`createOption`→既存 `onBulkTag(add)`)を配線。除去 popover は `selectOnly` で作成導線を抑制。

**Tech Stack:** Next.js App Router / TS strict / Dexie(client mirror + entity_mutations outbox)/ TanStack Table / Vitest + fake-indexeddb + RTL。

**Spec(唯一の起点):** `docs/superpowers/specs/2026-06-25-fix-1-bulk-tag-option-create-design.md`

## Global Constraints

- 起点は spec のみ。spec 凍結。仕様変更が要るなら停止して OT 相談。
- 各 task 完了条件 = ① 該当 unit/component test green ② review Critical 0 ③ `[reviewed]`(feat は canonical `superpowers:requesting-code-review` 経路必須・template 改変なし)。
- **tx は各文脈が持つ**: bulk=`createOption` 自前 tx / 単票=現状の単一 atomic tx。`buildNewOption` は **pure(tx・副作用なし)**。entity_type/op/patch は既存 handler の値をそのまま流用。
- **単票 `handleCreateOptionAndAssign` の挙動・atomicity は不変**(builder 抽出のみ、tx 境界を変えない)。
- **bulk add(`use-bulk-card-tags`)は無改修**(Step 0 確定: 新 optionId を権威扱い、`options.find(optionId)` で bail しない = snapshot 非依存が既存成立)。
- 新規作成導線が出るのは **「タグ付与」popover のみ**。「タグ除去」popover は `selectOnly={true}`(option/category 作成導線抑制、除去 toggle は不変)。
- **`CardTagAddPopover` 本体は無改造**(adapter 再利用 pattern 維持)。
- bulk-bound `createOptionAndAssign` は **action-bar のみ**に渡す。filter-bar・meta(TagCell)へ渡す `tagEditCallbacks` は不変(filter-bar の option-create no-op は別 sprint の carry-forward / TagCell は自前で override)。
- **共有部品(`card-tags-section`)変更のため consumer test を網羅実行**(`exam-card-table-tag-cell` / `card-tag-add-popover` / `card-tag-option-list`)。S2.3 の「shared-component 変更で関連 test 実行漏れ」教訓を踏襲。
- Test: Vitest + fake-indexeddb(Dexie)/ RTL。AI/課金は非該当。`--no-verify` 全面禁止。

## Sprint 完了 gate

- whole-repo `pnpm lint --max-warnings=0` exit 0(報告に1行明記)。
- helper signature 変更のため `pnpm typecheck` exit 0。
- review dispatch の観点 list に whole-repo lint 実行確認を含める(CC + reviewer 2 経路)。
- stg smoke(push 後 OT 指示で DevTools MCP): 複数 card 選択 →「タグ付与」popover → カテゴリ選択 → 新規 option 作成 → 全選択 card に付与(single-select 除去含む)/「タグ除去」popover に作成導線が出ない / 単票 option 作成の回帰なし。

---

### Task 1: buildNewOption 抽出 + createOption 新設 + handleCreateOptionAndAssign refactor

**目的:** option 作成 payload を pure builder に抽出し、bulk 用 `createOption`(自前 tx)を新設。単票 `handleCreateOptionAndAssign` を builder 利用に refactor(単一 atomic tx・挙動不変)。

**Files:** Modify `app/(app)/app/exams/[id]/_components/card-tags-section.tsx`。Test `card-tags-section.test.tsx`(追記)。

**Interfaces(Produces):**
- `export function buildNewOption(userId: string, existingOptions: ClientTagOption[], categoryId: string, name: string): { newOptionId: string; optionRow: ClientTagOption; enqueueInput: EnqueueEntityMutationInput }`(`EnqueueEntityMutationInput` from `@/lib/sync/entity-mutations`)。id 採番(`crypto.randomUUID`)/ sortKey(`nextSortKey(同カテゴリ既存の sort_key)`)/ created_at,updated_at / `optionRow`(`tag_options` put 値)/ `enqueueInput`(`{ entity_type:'tag_option', entity_id:newOptionId, op:'create', patch:{ category_id, name, color:null, sort_key } }`)。**副作用なし**。
- `export async function createOption(userId: string, existingOptions: ClientTagOption[], categoryId: string, name: string): Promise<string>`。userId 空は fail-fast(`console.error` + throw、`handleCreateCategory` 踏襲)。`buildNewOption` → `rw(tag_options, entity_mutations)` tx で `optionRow` put + `enqueueInput` enqueue → `runGuardedEntityMutationFlush()` fire → `newOptionId` を return。

**制約:** `handleCreateOptionAndAssign` は `buildNewOption` で payload を作るが、**現状の単一 atomic tx(`tag_options`+`card_tags`+`entity_mutations`)を維持**(option put + card_tags 差分 + enqueue 2 連発 を 1 tx)。single-select の同カテゴリ既存除去ロジック・signature は不変。`createOption` を内部 call しない(tx 分裂禁止)。

**完了条件:**
- `buildNewOption` unit green(id 採番 / sortKey が同カテゴリ既存の次 / payload 形 / 副作用なし)。
- `createOption` unit green(fake-indexeddb: option mirror put + enqueue 1 件 + newOptionId 返却 / userId 空 fail-fast)。
- `handleCreateOptionAndAssign` 回帰 green(single/multi の whole-set 差分が refactor 前後不変)。
- **単票 atomicity rollback(必須)**: `handleCreateOptionAndAssign` で **enqueue を意図的に throw** させ tx を失敗させると、`tag_options`(新 option)/`card_tags`(付与・除去)/`entity_mutations` が**全戻し**(部分書込ゼロ)を assert。
- **consumer 網羅**: `exam-card-table-tag-cell` / `card-tag-add-popover` / `card-tag-option-list` の test を実行し green。
- canonical review Critical 0 + `[reviewed]`。

---

### Task 2: bulk-bound createOptionAndAssign 配線 + 除去 popover selectOnly

**目的:** `ExamCardTableActionBar` 専用に bulk-bound `createOptionAndAssign` を配線し、「タグ付与」popover で新規 option 作成→全選択付与を成立させる。「タグ除去」popover は `selectOnly` で作成導線を抑制。

**Files:** Modify `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(bulk callbacks 構築 + action-bar へ渡す prop 差し替え)/ `app/(app)/app/exams/[id]/_components/exam-card-table-action-bar.tsx`(除去 popover に `selectOnly`)。Test `exam-card-table.test.tsx` / `exam-card-table-action-bar.test.tsx`(追記)。

**Interfaces(Consumes):** `createOption`(Task 1)/ 既存 `onBulkTag(categoryId, optionId, op)` / 既存 `tagEditCallbacks`。

**実装(exam-card-table.tsx):**
- `const bulkCreateOptionAndAssign = useCallback(async (categoryId: string, name: string): Promise<void> => { const newId = await createOption(userId, liveData?.options ?? [], categoryId, name); await onBulkTag(categoryId, newId, 'add') }, [userId, liveData?.options, onBulkTag])`。
- `const bulkTagEditCallbacks = useMemo(() => ({ ...tagEditCallbacks, createOptionAndAssign: bulkCreateOptionAndAssign }), [tagEditCallbacks, bulkCreateOptionAndAssign])`。
- `<ExamCardTableActionBar>` に渡す `tagEditCallbacks` を `bulkTagEditCallbacks` に差し替え(**action-bar のみ**)。filter-bar・`meta`(TagCell 経由)へ渡す `tagEditCallbacks` は**元のまま不変**。

**実装(action-bar.tsx):** 「タグ除去」`<CardTagAddPopover>`(`handleRemoveToggle` 側)に `selectOnly` を付与。「タグ付与」側は無改変(selectOnly 付けない)。

**制約:** `CardTagAddPopover` 本体無改造。bulk callbacks の影響範囲は action-bar に限定(filter-bar の no-op・TagCell の override は不変)。除去 toggle(`onToggle`/`handleRemoveToggle`)は `selectOnly` でも生存。

**完了条件:**
- `exam-card-table-action-bar.test.tsx` green: (a)「タグ付与」popover の option `onCreateNew` が `createOption`→`onBulkTag(categoryId, newId, 'add')` を呼ぶ(新 optionId が bulk add へ渡る)を mock で assert / (b)「タグ除去」popover に `selectOnly` が当たり新規作成導線が出ない / (c) カテゴリ作成導線が付与側で健在。
- `exam-card-table.test.tsx` 回帰 green: filter-bar・TagCell へ渡る `tagEditCallbacks` が不変(bulk callbacks は action-bar のみ)。
- canonical review Critical 0 + `[reviewed]`。stg smoke 対象(bulk 作成→付与 / 除去 導線なし / 単票 回帰)。

---

## Self-Review

- **Spec coverage:** §3.1/§4 helper→Task1 / bulk 配線・除去 selectOnly→Task2 / 判断3(bulk hook 無改修)→Global Constraints + Task2 で確認 / consumer 回帰→Task1 完了条件 / 単票 atomicity→Task1 完了条件。OUT(filter-bar carry-forward)はどの task でも触れない。✓
- **Placeholder scan:** なし(具体 signature・payload・test 観点を明記)。✓
- **Type consistency:** `buildNewOption`/`createOption` の signature が Task1(Produces)↔Task2(Consumes)一致。`EnqueueEntityMutationInput` import 元明記。`onBulkTag(categoryId, optionId, op)` は既存。✓
