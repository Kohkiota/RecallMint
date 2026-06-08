# Tag-4c-2a-fix stg smoke checklist

OT が stg で実機確認する 16 観点。 plan: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-category-combobox.md`、 spec: `docs/superpowers/specs/2026-06-08-tag-4c-2a-fix-category-combobox-design.md`、 commit: Tag-4c-2a (b1fbe89) に amend で畳む想定 (push は OT が `--force-with-lease` で実施)

## 前提

- stg URL: https://stg.recallmint.nekotest.net/app
- ログイン: stg test 用 (memory: `stg-smoke-login.md`)
- 対象 page: /app/exams/[id] (試験詳細)
- mobile 要否: 必要 (Chrome DevTools mobile view で combobox input + 型選択 stage の操作感確認)
- 確認用 試験 ID: OT 記入 / 確認 card: OT 記入

## 観点

### 1. stage1 上部に combobox input + Plus icon の新規作成行構造

- 操作: 任意 card の「+ タグを追加」 click
- 期待: stage1 上部に input (placeholder「検索 or 新規作成」、 stage 表示時 auto-focus、 aria-label「category を検索 / 新規作成」)。 入力に応じて末尾に「+ 新規作成: {trim 後文字列}」 行 (Plus icon 付き)
- 結果: PASS / FAIL
- Notes:

### 2. stage1 input 空 → 既存 category 全表示 + 新規作成行非表示

- 操作: input を空にして観察
- 期待: 該当 user の既存 category が全表示、 新規作成行は出ない。 categories 0 件 + 空入力なら新文言 placeholder「下の入力欄に名前を入れて『新規作成』 で追加できます」 のみ表示
- 結果: PASS / FAIL
- Notes:

### 3. stage1 input 部分一致 → 部分絞り込み + 「+ 新規作成: {入力値}」 行表示

- 操作: 例: categories=["分野", "難易度"] に "分" を入力
- 期待: "分野" のみ表示 + 末尾に「+ 新規作成: 分」 行。 大小無視も同様 (例「BUNYA」入力で "bunya_test" 等がヒット)
- 結果: PASS / FAIL
- Notes:

### 4. stage1 input 完全一致 (case/whitespace 無視) → **既存 category 表示 + 「+ 新規作成」 行も出る** (option との挙動差)

- 操作: 既存 category 名 (例「分野」) を完全入力 (大小 / 前後 space 含めて区別なし)
- 期待: 既存「分野」 は表示される、 **新規作成行も出る** (category は同名許容、 schema UNIQUE なし + spec §設計判断 3)。 option と挙動が異なる点が確認できる
- 結果: PASS / FAIL
- Notes:

### 5. 既存 category 行 click → stage='option' 遷移 (regression)

- 操作: stage1 で任意の既存 category 行 click
- 期待: stage='option' に遷移、 該当 category 配下の option 一覧 (Tag-4c-2a の combobox 機構) が表示される。 Tag-4c-1 / 4c-2a 既存挙動と完全整合
- 結果: PASS / FAIL
- Notes:

### 6. 既存 category 行 kebab click → editCategory stage 遷移 (regression)

- 操作: stage1 で任意 category 行末尾の「...」 kebab click
- 期待: editCategory stage に遷移 (rename input + color pill + 削除 button、 Tag-4c-1 既存挙動)。 row click (stage='option' 遷移) は発火しない (stopPropagation 既存)
- 結果: PASS / FAIL
- Notes:

### 7. 旧「+ カテゴリを追加」 button が DOM に存在しない (regression)

- 操作: stage1 を一巡しながら DOM 検索 (DevTools Elements で `+ カテゴリを追加` を検索)
- 期待: 該当文字列の button / row が**全く存在しない**。 categories 0 件のときも、 多数のときも同様
- 結果: PASS / FAIL
- Notes:

### 8. 「+ 新規作成」 click → 型選択 stage 遷移 (まだ作成されない)

- 操作: input に新名 (例「皮膚」) 入力 + 「+ 新規作成: 皮膚」 行 click
- 期待: stage='createCategoryType' に遷移。 まだ tag_categories には書込まれていない (DevTools Application → IndexedDB → tag_categories で確認、 新 category が**まだ無い**)
- 結果: PASS / FAIL
- Notes:

### 9. 型選択 stage の構造 (back / 見出し / 2 button / inline error 領域 / multi default focus)

- 操作: stage='createCategoryType' で UI を観察
- 期待:
  - back button「← カテゴリ選択へ戻る」
  - 見出し: 「『皮膚』 の種別を選択」 (pendingCategoryName を埋め込み)
  - 2 button (縦): 「単一 (single)」 + 説明「1 つの card にこのカテゴリの option は最大 1 つ」、 「複数 (multi)」 + 説明「1 つの card にこのカテゴリの option を複数付与できる」
  - 「複数 (multi)」 button に default focus (Enter 即決定が効く)
  - inline error 領域 (まだ何も出ていない)
- 結果: PASS / FAIL
- Notes:

### 10. 単一 (single) button click → category 即作成 (select_type=single) + stage='option' 自動遷移

- 操作: 型選択 stage で「単一 (single)」 button click (or Tab + Enter で focus 移動して Enter)
- 期待: 新 category が即作成 (DB / mirror) + popover が stage='option' に自動遷移 + option 0 件 placeholder「上の入力欄に名前を入れて『新規作成』 で追加できます」 表示。 IndexedDB で `tag_categories.select_type === 'single'` を確認
- 結果: PASS / FAIL
- Notes:

### 11. 複数 (multi) button click → category 即作成 (select_type=multi) + stage='option' 自動遷移

- 操作: 別カテゴリ名で型選択 stage に入り、 「複数 (multi)」 button click (or Enter で default focus button 即決定)
- 期待: 新 category 即作成 (select_type=multi) + stage='option' 自動遷移。 同上の placeholder
- 結果: PASS / FAIL
- Notes:

### 12. 作成失敗時 → 型選択 stage 保持 + inline error + 連打防止

- 操作: 擬似的に失敗を発生させる (DevTools オフライン、 もしくは Application → IndexedDB → tag_categories を一時的に close)。 型選択 stage で 作成 button click
- 期待: stage='createCategoryType' のまま、 inline error「作成に失敗しました」 (role="alert") 表示、 pendingCategoryName + 型選択 stage 維持、 button は再 enable される、 連打 (rapid click) しても createCategory は 1 回しか呼ばれない (isSubmittingCreate guard)
- 結果: PASS / FAIL
- Notes:

### 13. Esc / back button on createCategoryType → stage='category' に戻る (pendingCategoryName / createError reset)

- 操作: 型選択 stage で Esc 押下、 別途 back button click も確認
- 期待: stage='category' (stage1) に戻る。 popover は開いたまま (Esc で popover 自体は閉じない)。 再度「+ 新規作成」 click したら新しい pendingCategoryName で型選択 stage に入る (旧 pendingCategoryName が leak しない)
- 結果: PASS / FAIL
- Notes:

### 14. 旧 createCategory stage の DOM / 名前 input + 型 segment 同居 UI が**完全消滅**

- 操作: 全 popover 経路を一巡 (+ タグ追加 / バッジ click) しながら DOM 検索 (旧 placeholder「カテゴリ名」 input が出る画面が**ない**こと、 旧 segment ボタンも消滅)
- 期待: 旧 createCategory stage の JSX は全く reachable でない。 type icon (CheckSquare / Circle) も stage1 から消えている (色 pill + 名前のみ)
- 結果: PASS / FAIL
- Notes:

### 15. popover close → 全 state reset (pendingCategoryName / createError / isSubmittingCreate 含む) + Tag-4c-2a Task 4 regression

- 操作: 型選択 stage で 作成 失敗 → 別タブ click 等で popover を閉じる → 再度 popover を開く
- 期待: stage='category' (stage1) から開始、 createError は表示されていない、 pendingCategoryName は null、 isSubmittingCreate は false。 また CardTagEditPopover (バッジ click 経路) の Tag-4c-2a Task 4 挙動 (combobox + 新規作成 + 即付与 + double-fire guard + category-create UI 非表示) も regression なし
- 結果: PASS / FAIL
- Notes:

### 16. console error 0 + Tag-4c-2a 全 20 観点 + Tag-4c-1 全 15 観点 regression なし

- 操作: 上記 1-15 を一巡しつつ DevTools Console を監視。 Tag-4c-2a smoke checklist の 20 観点 + Tag-4c-1 smoke checklist の 15 観点も全て再確認 (主要シナリオのみで OK)
- 期待: console.error 0 件 (LSP の `onToggle` Server Action 警告は build 警告のみで run-time には出ない)。 既存 add / edit / delete / Esc / kebab / バッジ × / nav タグ link 等 全て regression なし
- 結果: PASS / FAIL
- Notes:
