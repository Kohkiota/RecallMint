# Tag-4c-1 stg smoke checklist

OT が stg で実機確認する 15 観点。 plan: `docs/superpowers/plans/2026-06-08-tag-4c-1-popover-inline-edit.md`、 commit: (Task 5 末)

## 前提

- stg URL: https://stg.recallmint.nekotest.net/app
- ログイン: stg test 用 (memory: `stg-smoke-login.md`)
- 対象 page: /app/exams/[id] (試験詳細)
- mobile 要否: 必要 (Chrome DevTools mobile view で popover サイズ + kebab タップ性確認)
- 確認用 試験 ID: OT 記入 / 確認 card: OT 記入

## 観点

### 1. + タグ追加 popover stage1 各 category 行に kebab 表示

- 操作: 任意 card の「+ タグを追加」 click
- 期待: stage1 (カテゴリ一覧) で各 category 行末尾に「...」 (Ellipsis icon) が表示される、 既存 ChevronRight の左
- 結果: PASS / FAIL
- Notes:

### 2. category kebab click → editCategory stage に遷移

- 操作: stage1 で任意 category の「...」 click
- 期待: 同一 popover が editCategory stage に切り替わり、 rename input + color pill (現在色) + 削除 button が表示される。 row click (=stage2 遷移) は発火しない (stopPropagation)
- 結果: PASS / FAIL
- Notes:

### 3. editCategory stage Esc → category list (stage1) に戻る

- 操作: editCategory stage で Esc 押下
- 期待: stage1 (カテゴリ一覧) に戻る、 popover は開いたまま
- 結果: PASS / FAIL
- Notes:

### 4. rename input Enter → category 名が即変更 + 全 card のバッジ表示も更新

- 操作: editCategory stage で rename input にカテゴリ新名入力 + Enter
- 期待: input 確定 → 該当 card のバッジ「{新名}: {option}」 + 他の card でも同 category のバッジが全て新名に更新 (id 参照で全 card 即連動)
- 結果: PASS / FAIL
- Notes:

### 5. color picker open 中 Esc → picker のみ閉じ editCategory stage は維持

- 操作: editCategory stage で color pill click → ColorPalettePopover 開く → 開いたまま Esc
- 期待: color picker のみ閉じる、 editCategory stage は維持 (back button + rename input + delete button 表示継続)
- 結果: PASS / FAIL
- Notes:

### 6. category 削除 button → DeleteConfirmDialog (配下 N option + M card) → 確定で stage1 戻り + バッジ消滅

- 操作: editCategory stage で「削除」 button click
- 期待: DeleteConfirmDialog 表示 「カテゴリ『{name}』 を削除しますか? 配下の option N 件、 紐付き card M 件のタグも消えます。 この操作は取り消せません。」 (N/M は実 IDB count) → 「削除する」 click → popover が stage1 に戻る + その category が一覧から消える + 該当 card のバッジも optimistic で消える (cascade)
- 結果: PASS / FAIL
- Notes (N/M 値):

### 7. + タグ追加 popover stage2 各 option 行に kebab 表示

- 操作: stage1 で適当な category click → stage2 (option 一覧) で各 option 行末尾に「...」 表示
- 期待: 各 option 行の右端に kebab、 既存 Check icon (selected) と並ぶ
- 結果: PASS / FAIL
- Notes:

### 8. option kebab click → editOption stage に遷移

- 操作: stage2 で任意 option の「...」 click
- 期待: 同一 popover が editOption stage に切り替わり、 rename input + color pill + 削除 button + back button「option 一覧へ戻る」 が表示される。 option click (=toggle) は発火しない (stopPropagation)
- 結果: PASS / FAIL
- Notes:

### 9. editOption stage Esc → option list (stage2) に戻る

- 操作: editOption stage で Esc 押下
- 期待: stage2 (option 一覧) に戻る、 selectedCategoryId は維持
- 結果: PASS / FAIL
- Notes:

### 10. option rename / color 変更 / 削除 が atomic 反映 + reload 後維持

- 操作: editOption stage で rename → reload、 color 変更 → reload、 削除 → reload を順に実行
- 期待: 各操作後 popover にとどまり (削除は除き)、 reload しても最終状態維持 (atomic enqueue → server 永続化済)
- 結果: PASS / FAIL
- Notes:

### 11. バッジ click → CardTagEditPopover の option list に kebab 表示

- 操作: 付与済みバッジ本体を click (× 部分ではない)
- 期待: CardTagEditPopover が開き、 header「{category} を編集」 + 該当 category の options 一覧、 各 option 行末尾に kebab 表示
- 結果: PASS / FAIL
- Notes:

### 12. (CardTagEditPopover) kebab click → editOption stage → rename / color / 削除 動作

- 操作: バッジ click → 開いた popover の option kebab click → editOption stage で rename / color / 削除 を順次試行
- 期待: 編集 stage で各操作が機能、 削除は親 useLiveQuery 再描画でバッジ自体が消え popover も unmount される
- 結果: PASS / FAIL
- Notes:

### 13. badge × に hover cursor-pointer

- 操作: 付与済みバッジの「×」 部分に mouse hover
- 期待: cursor が pointer (手) に切り替わる (cursor: auto / text ではない)
- 結果: PASS / FAIL
- Notes:

### 14. 同名 rename 衝突 → inline error 赤テキスト (rename input 直下)

- 操作: 既に同名 category / option がある状態で、 別の category / option を同名に rename → Enter
- 期待: server から per-mutation failed 応答 → popover 内 rename input 直下に赤テキスト「(error message)」 が role="alert" で表示される。 元値に戻る (rename は弾かれる、 マージはしない)
- 結果: PASS / FAIL
- Notes:

### 15. console error 0、 regression なし (Tag-4b-fix 全 14 観点 + fix-3 観点維持)

- 操作: 全観点完了後、 Tag-4b-fix smoke checklist (`2026-06-07-tag-4b-fix-smoke-checklist.md`) の 14 観点 + fix-3 観点を再走、 console を通読
- 期待: error 0、 Tag-4b-fix の全観点が同じく PASS (badge × 即解除、 + タグを追加 button、 single 置換、 whole-set 不変条件、 案 a 取り直し 等)
- 結果: PASS / FAIL
- Notes:

## 総合判定

- 全観点 PASS / 観点 _ FAIL
- 残課題:

## 参照

- plan: `docs/superpowers/plans/2026-06-08-tag-4c-1-popover-inline-edit.md`
- Tag-4b-fix smoke: `docs/superpowers/plans/2026-06-07-tag-4b-fix-smoke-checklist.md`
- 着地 commit: (Task 5 末で記録)
