# Fix-1: bulk タグ付与で新規 option(タグ)作成→全選択 card 付与

- 作成: 2026-06-25
- 種別: bug fix spec(prod smoke で発見)。plan は本 spec review 後。
- 前提: Fix-1 fact-finding(原因特定済)を起点。本 spec は実装せず。

---

## 1. 目的 / 症状

試験詳細テーブルビューで複数 card をチェックボックス選択 → 一括タグ操作 popover で **「新規カテゴリ作成」はできるが「新規タグ(option)作成」ができない**。

確定した症状(fact-finding): 新規 option 作成の**導線は表示される**が、押しても**作成されない(silent no-op、エラーも非表示)**。UI 不在でも mutation エラーでもない。

**ゴール**: bulk 文脈で新規 option を作成し、選択中の全 card に付与できるようにする(カテゴリ作成と対称)。

---

## 2. 確定した設計判断(fact-finding + OT 承認)

### 2.1 根本原因
- `ExamCardTableActionBar`(bulk)は `CardTagAddPopover` に **table-level の `tagEditCallbacks` をそのまま**渡す(`action-bar.tsx:91,108`)。
- table-level の `tagEditCallbacks.createOptionAndAssign` は **no-op placeholder**(`exam-card-table.tsx:164-174`、`Promise.resolve()`)。
- 単票 `TagCell` だけがこれを cardId-bound の実 closure に **override** する(`exam-card-table-tag-cell.tsx:115-130`)。bulk は override しない → placeholder が呼ばれて無反応。
- 非対称の理由: `createCategory` は table-level の**実ハンドラ**(`handleCreateCategory`)で bulk でも動く / `createOptionAndAssign` は per-card 前提の placeholder。
- **selectOnly は無関係**(bulk action-bar は selectOnly 未指定=default false=導線は出ている)。

### 2.2 採用方針 = Approach A(OT 承認)
bulk 用の実 `createOptionAndAssign` を `ExamCardTableActionBar` で構築する(TagCell の per-card override と対になる bulk 版):
1. **option 新規作成のみ**を行う helper を抽出し、**新 optionId を返す**。
2. 返った新 optionId を **既存 bulk add 経路**で**全選択 card に付与**する。
3. single-select category の whole-set 意味論(各 card で同カテゴリ既存 option を除去)は**既存 bulk add が担保**(`use-bulk-card-tags`)。

### 2.3 設計判断(OT 確定)
- **(判断1)** bulk で「新規 option 作成 → 全選択 card 付与」を**許可する**(category 作成と対称、ユーザー期待に一致)= fix 本体。
- **(判断3)** 作成直後の付与は、**作成 helper が返す新 optionId を bulk add へ直接渡す**。`useLiveQuery`/`options` snapshot の再評価タイミングに**依存しない**(新 option が mirror snapshot に未反映でも付与が成立すること)を要件とする。

---

## 3. スコープ

### 3.1 IN
- option 作成のみを行う helper を `card-tags-section.tsx` から抽出(`handleCreateOptionAndAssign` の「option 作成」部分 = `tag_options` mirror put + option 作成 enqueue、entity_type/op は既存 handler の値をそのまま流用)。新 `optionId` を返す。既存 `handleCreateOptionAndAssign`(単票 create+assign)は**この helper を内部利用するよう refactor**(単票挙動は不変)。
- **付与/除去 popover は別インスタンス**(fact-finding 確定: `action-bar.tsx:86-100` 付与=`handleAddToggle` / `:103-117` 除去=`handleRemoveToggle`)。新規作成導線の出し分けは props で行う(本体無改造):
  - **「タグ付与」popover**: bulk-bound な `createOptionAndAssign` を持つ callbacks を渡す(`{ ...tagEditCallbacks, createOptionAndAssign: bulkCreateOptionAndAssign }`、TagCell と同 pattern)。selectOnly は付けない → 新規作成導線が出る。
    - `bulkCreateOptionAndAssign(categoryId, name) = createOption(...) → newOptionId → 全選択 card へ bulk add`。
    - bulk add は既存 `onBulkTag(categoryId, optionId, 'add')`(= `use-bulk-card-tags` の bulk add)を **新 optionId** で呼ぶ。作成は常に op='add'(付与文脈)。
  - **「タグ除去」popover**: **`selectOnly={true}` を渡す**(論点2 確定変更)。除去は既存タグを外す文脈で、新規作成→付与は操作方向と逆。selectOnly=true で option/category とも作成・編集導線を抑制し「既存タグの選択(=除去 toggle)」のみにする(filter-bar の「絞る場だから作成不要」と同論理)。除去 toggle(onToggle)は selectOnly でも生存するため除去機能は不変。
  - → **新規作成導線が出るのは「付与」popover のみ**。
- snapshot 非依存(判断3): bulk add の single-select 除去判定が**渡された categoryId/optionId を権威**として扱い、新 optionId が `options` mirror snapshot に無くても成立すること。`use-bulk-card-tags` が `options.find(id===optionId)` 不在で bail しないことを確認・必要なら是正。

### 3.2 OUT(今回触らない)
- **filter-bar の option-create no-op**(fact-finding 第2症状): `exam-card-table-filter-bar.tsx` も table-level callbacks を selectOnly なしで渡すため同じ no-op。ただし「フィルタのために新規 option を作る」のは無意味 = **別 sprint で selectOnly 抑制で対応**(carry-forward 確定 / OT 合意済、ledger 記録済、Grid-2 T3 filter popover quirk と同根)。Fix-1 では触らない。
- 単票 TagCell の挙動変更(既に正常)。
- カテゴリ作成経路(既に bulk で動作)。
- popover 本体(`CardTagAddPopover`)の改造(本体無改造の adapter 再利用 pattern を維持)。

---

## 4. アーキテクチャ / データフロー

```
[bulk] ExamCardTableActionBar
  selectedIds, onBulkTag(既存), tagEditCallbacks(table-level)
   └─ bulkBoundCallbacks = { ...tagEditCallbacks, createOptionAndAssign: bulkCreateOptionAndAssign }
        bulkCreateOptionAndAssign(categoryId, name):
          1. const newOptionId = await createOption(userId, categories, options, categoryId, name)   // 抽出 helper
          2. await onBulkTag(categoryId, newOptionId, 'add')                                          // 既存 bulk add
   └─ <CardTagAddPopover tagEditCallbacks={bulkBoundCallbacks} ... />  (付与/除去 両方)
        popover.onCreateNew(option) → tagEditCallbacks.createOptionAndAssign(categoryId, name)        // 既存配線
```

- `createOption`(新 helper): `tag_options` mirror put + `enqueueEntityMutation` を 1 rw tx に閉じ、`runGuardedEntityMutationFlush` を fire、**newOptionId を return**。失敗時 Dexie auto-rollback。userId 空は fail-fast(既存踏襲)。
- `handleCreateOptionAndAssign`(単票): 内部で `createOption` を呼び、続けて当該 card の whole-set 差分書込(現挙動不変)。
- bulk add(`use-bulk-card-tags`): 既存。new optionId + categoryId を権威に各選択 card へ whole-set 反映(single-select 除去含む)。

---

## 5. テスト方針

- **createOption helper**(unit, Vitest + fake-indexeddb): option mirror put + enqueue + newOptionId 返却 / userId 空 fail-fast / category 不在挙動。
- **handleCreateOptionAndAssign refactor**(unit): 単票 create+assign の挙動が refactor 前後で不変(回帰)。single/multi の whole-set 差分。
- **共有部品変更の consumer 回帰(横断規律・必須、論点1)**: `card-tags-section` の create helper 抽出は共有部品変更のため、**単票 consumer の test も実行・green を per-task gate に含める** — 少なくとも `exam-card-table-tag-cell` の TagCell が新規 option 作成(`createOptionAndAssign` 経路)を refactor 前後で挙動不変に保つこと(TagCell consumer test、無ければ追加)。`card-tags-section` 既存 consumer test(`card-tag-option-list` / `card-tag-add-popover` 等)も網羅実行(S2.3 の「shared-component 変更で関連 test 実行漏れ → 後続で発覚」教訓を踏襲)。
- **ExamCardTableActionBar**(component, RTL): (a) **「タグ付与」popover** の onCreateNew(option)が `createOption`→`onBulkTag(_, newOptionId, 'add')` を呼ぶ(新 optionId が bulk add に渡る = snapshot 非依存)を mock で assert。(b) **「タグ除去」popover は `selectOnly={true}`** で新規作成導線(option/category)が出ないことを assert。(c) category 作成導線が付与側で壊れていない回帰。
- **snapshot 非依存**: 新 optionId が options 配列に未反映でも bulk add が成立することを test で固定。
- AI/課金は非該当。

---

## 6. 完了条件

- 「タグ付与」popover で新規 option を作成 → 選択中の全 card に付与される(single-select は同カテゴリ既存を除去)。
- 「タグ除去」popover では新規作成導線(option/category)が出ない(`selectOnly={true}`)。除去 toggle は不変。
- 作成は新 optionId を bulk add へ直接渡し、useLiveQuery 再評価タイミングに依存しない。
- 単票 option 作成・カテゴリ作成(bulk/単票)に回帰なし(consumer 回帰 test green、§5)。`CardTagAddPopover` 本体無改造。
- 該当 unit/component test green。canonical review Critical 0、commit に [reviewed]。
- whole-repo `pnpm lint --max-warnings=0` exit 0。

---

## 7. 検証スコープ

- canonical code review(`superpowers:requesting-code-review` 経路)。
- stg smoke(push 後 OT 指示で DevTools MCP): 複数 card 選択 → 一括「タグ付与」popover → カテゴリ選択 → 新規 option 作成 → **全選択 card に付与**を実機確認(single-select 除去含む)。単票 option 作成の回帰確認。
- DB 変更なし(tag_options/card_tags は既存 schema、新 migration なし)= migration 不要。
- whole-repo lint exit 0 を完了報告に 1 行明記。
