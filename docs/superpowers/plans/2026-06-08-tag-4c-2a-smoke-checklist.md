# Tag-4c-2a stg smoke checklist

OT が stg で実機確認する 20 観点。 plan: `docs/superpowers/plans/2026-06-08-tag-4c-2a-popover-inline-create.md`、 spec: `docs/superpowers/specs/2026-06-08-tag-4c-2a-popover-inline-create-design.md`、 commit: (Task 5 末で単一 commit)

## 前提

- stg URL: https://stg.recallmint.nekotest.net/app
- ログイン: stg test 用 (memory: `stg-smoke-login.md`)
- 対象 page: /app/exams/[id] (試験詳細)
- mobile 要否: 必要 (Chrome DevTools mobile view で combobox input タップ性 + popover サイズ + バッジ入れ替わり目視確認)
- 確認用 試験 ID: OT 記入 / 確認 card: OT 記入

## 観点

### 1. + タグ追加 popover stage1 末尾に「+ カテゴリを追加」 row 表示 (categories 0 件でも表示)

- 操作: 任意 card の「+ タグを追加」 click。 また categories が 0 件のテナント (or test data) でも確認
- 期待: stage1 (カテゴリ一覧) の末尾に Plus icon + 「+ カテゴリを追加」 row が常に表示される (kebab なし)。 categories 0 件のときも row は表示され、 placeholder「下の『+ カテゴリを追加』 から作成できます」 と並ぶ
- 結果: PASS / FAIL
- Notes:

### 2. 「+ カテゴリを追加」 click → createCategory stage 遷移

- 操作: stage1 で「+ カテゴリを追加」 click
- 期待: 同一 popover が createCategory stage に切り替わる。 back button「← カテゴリ選択へ戻る」 + 名前 input (auto-focus、 placeholder「カテゴリ名」、 aria-label「カテゴリ名」) + select_type セグメント (single / multi、 default multi の aria-pressed) + 作成 button (disabled) + inline error 領域
- 結果: PASS / FAIL
- Notes:

### 3. 名前空で 作成 button disabled、 入力で enable

- 操作: 名前 input に文字入力 / 削除 / space-only 入力で挙動確認
- 期待: 空 or space-only → disabled、 1 文字以上 (trim 後非空) で enable
- 結果: PASS / FAIL
- Notes:

### 4. selectType single / multi 切替 → aria-pressed 反映

- 操作: createCategory stage で single / multi button を交互に click
- 期待: 押した側に aria-pressed="true"、 もう一方は "false"。 視覚的にも active 表示が切り替わる
- 結果: PASS / FAIL
- Notes:

### 5. 作成 → category 即追加 + stage='option' 自動遷移 + option 0 件 placeholder 新文言

- 操作: 名前 入力 + selectType 選択 + 作成 click
- 期待: category 即追加 (DB + 全 card のカテゴリ一覧に出現)、 popover が新 category の stage='option' に自動遷移、 option 一覧空、 placeholder「上の入力欄に名前を入れて『新規作成』 で追加できます」 が表示される
- 結果: PASS / FAIL
- Notes:

### 6. createCategory stage で Esc → stage='category' に戻る (入力破棄)

- 操作: createCategory stage で名前 / selectType を一部入力後 Esc
- 期待: stage='category' に戻る、 popover は開いたまま、 再 createCategory に入ったとき名前空 + selectType=multi (default 再 reset)
- 結果: PASS / FAIL
- Notes:

### 7. stage2 (option 一覧) 上部に combobox input + Plus icon の新規作成行構造

- 操作: 任意 category 行 click → stage='option' に遷移
- 期待: stage2 上部に combobox input (placeholder「検索 or 新規作成」、 stage 遷移時 auto-focus、 aria-label「option を検索 / 新規作成」)。 入力に応じて新規作成行が末尾に出る (Plus icon + 「新規作成: {trim 後文字列}」)
- 結果: PASS / FAIL
- Notes:

### 8. input 空 → 既存 option 全表示 + 新規作成行非表示

- 操作: input を空にして観察
- 期待: 該当カテゴリの既存 option が全表示、 新規作成行は出ない。 既存 option 0 件 + 空入力なら placeholder のみ表示
- 結果: PASS / FAIL
- Notes:

### 9. input 部分一致 → 部分絞り込み + 「新規作成: {入力値}」 行表示

- 操作: 例: options=["循環器", "呼吸器"] に "循" を入力
- 期待: "循環器" のみ表示 + 末尾に「新規作成: 循」 行。 大小無視 (例「CIRCULATION」入力で "circulation_test" がヒット)
- 結果: PASS / FAIL
- Notes:

### 10. input 完全一致 (case/whitespace 無視) → 既存 ヒット + 新規作成行非表示 (同名作成防止)

- 操作: 既存 option 名 (例 "循環器") を完全入力 (大小 / 前後 space 含めて区別なし)
- 期待: 既存 "循環器" は表示される、 新規作成行は出ない (同名作成防止、 spec §設計判断 7)
- 結果: PASS / FAIL
- Notes:

### 11. 新規作成行 click → 新 option 即作成 + 該当 card に即付与 (multi / single ルール)

- 操作: input に新名入力 → 新規作成行 click。 multi カテゴリと single カテゴリの両方で確認
- 期待: 新 option が即作成 + 該当 card に即付与 + バッジ表示 (「{カテゴリ名}: {新 option}」)。 multi なら既存付与 option はそのまま、 single なら同カテゴリの既存付与 option が toRemove で消える (whole-set replace)
- 結果: PASS / FAIL
- Notes:

### 12. 【C-追加】 single カテゴリで新規作成 → 既存バッジが外れて新バッジに入れ替わるのが目視で分かる

- 操作: single カテゴリで既存 option を付与済の card で、 input に新名入力 → 新規作成行 click
- 期待: 既存付与の「{カテゴリ名}: {旧 option}」 バッジが消え、 同 card に「{カテゴリ名}: {新 option}」 バッジが入る (置換)。 「既存 option を選んでも同じく置換」 の既存挙動と一貫。 目視で入れ替わりが追える (フリッカーや 2 バッジ並走の中間 state がない)
- 結果: PASS / FAIL
- Notes:

### 13. 新規作成行 click 後 input が空に reset + 新 option が selected 表示

- 操作: 観点 11 / 12 直後の popover を観察
- 期待: input が空に戻る、 option 一覧で新 option が selected (Check icon) で表示される
- 結果: PASS / FAIL
- Notes:

### 14. option 作成失敗 → atomic auto-rollback + inline error + 入力保持 + 再 click 可

- 操作: 擬似的に失敗を発生させる (DevTools Application → IndexedDB → 一時 close、 もしくは オフライン環境で操作)。 input に新名入力 → 新規作成行 click
- 期待: tag_options / card_tags が両方共 mirror に追加されない (atomic auto-rollback、 spec §Architecture)、 inline error「作成に失敗しました」 が表示される (role="alert")、 input 内容は保持、 接続復旧後再 click で成功
- 結果: PASS / FAIL
- Notes:

### 15. category 作成失敗 → createCategory stage 保持 + inline error + input / selectType 保持

- 操作: 同じく擬似的に失敗を発生させ、 createCategory stage で 作成 click
- 期待: stage='createCategory' のまま、 inline error「作成に失敗しました」 (role="alert") 表示、 名前 input + selectType の値が保持、 作成 button は再 enable される
- 結果: PASS / FAIL
- Notes:

### 16. バッジ click (CardTagEditPopover) でも combobox + 新規作成行が機能、 category 作成 UI なし

- 操作: 任意バッジ click で開く edit-popover の option 一覧
- 期待: 上部に combobox input + 末尾 新規作成行が機能 (作成 + 即付与)。 失敗時 inline error 表示。 stage1「+ カテゴリを追加」 row は edit-popover には**出ない** (バッジ動線では category 作成 UI なし)。 editOption stage / Esc / kebab は Tag-4c-1 同様
- 結果: PASS / FAIL
- Notes:

### 17. popover 内「タグ管理 →」 link が全 popover の全 stage で見当たらない

- 操作: + タグ追加 popover の全 stage (category / option / createCategory / editCategory / editOption) と バッジ click の edit popover (option / editOption) を巡る
- 期待: 全 stage の footer / placeholder / どこにも「タグ管理 →」 link が**存在しない**。 textNode 検索でもヒットしない
- 結果: PASS / FAIL
- Notes:

### 18. nav の「タグ」 link は残っている + manager 画面 (`/app/tags`) 併存

- 操作: header / sidebar / nav から「タグ」 link を辿り manager 画面に遷移
- 期待: link は残っている、 `/app/tags` 画面に遷移できる、 manager 画面の機能 (category / option 作成 / 編集 / 削除) は据置 (本 sprint で改修なし)
- 結果: PASS / FAIL
- Notes:

### 19. sort_key 末尾採番 + reload 後維持

- 操作: 新規 category を 2-3 個続けて作成、 同様に新規 option を同一 category 内で 2-3 個続けて作成。 reload (page refresh)
- 期待: popover での表示順 (Tag-4c-1: sort_key ASC NULLS LAST, created_at ASC) が**末尾追加順**。 reload 後も同じ並び (server pull で sort_key が永続化されている)
- 結果: PASS / FAIL
- Notes:

### 20. console error 0 + Tag-4c-1 全 15 観点 regression なし

- 操作: 上記 1-19 を一巡しつつ DevTools Console を監視。 Tag-4c-1 smoke checklist の 15 観点も全て再確認
- 期待: console.error 0 件 (warn は LSP の `onToggle` Server Action 警告は build 警告のみで run-time には出ない)。 Tag-4c-1 編集系 (kebab / rename / color / 削除 / Esc 4 stage / バッジ × ) 全て regression なし
- 結果: PASS / FAIL
- Notes:
