# Tag-4c-2a-fix-2 stg smoke checklist

OT が stg で実機確認する 15 観点 (6 検証カテゴリ)。 plan: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-2.md`、 spec: `docs/superpowers/specs/2026-06-08-tag-4c-2a-fix-2-design.md`、 commit: Tag-4c-2a (072779d) に amend で畳む想定 (push は OT が `--force-with-lease` で実施)

## 前提

- stg URL: https://stg.recallmint.nekotest.net/app
- ログイン: stg test 用 (memory: `stg-smoke-login.md`)
- 対象 page: /app/exams/[id] (試験詳細)
- mobile 要否: 必要 (Chrome DevTools mobile view で 寸法目視 + 編集 stage focus 体感)
- 確認用 試験 ID: OT 記入 / 確認 card: OT 記入

## 観点

### 1. 型選択 stage の中身が新 UI (Fix-1: コンパクト化)

- 操作: stage1 で input に新名入力 → 「+ 新規作成: {名前}」 行 click → 型選択 stage 遷移後の UI を観察
- 期待:
  - back button「← カテゴリ選択へ戻る」 (既存)
  - 見出し「『{入力名}』 の種別を選択」 が `text-xs text-slate-500` (前 sprint より小さい)
  - 2 行 button (縦): 「(CircleDot icon) シングルセレクト」 + 「(ListChecks icon) マルチセレクト」
  - 説明文 (旧「1 つの card にこのカテゴリの option は最大 1 つ」 等) が**全部消えている**
  - inline error 領域 (初期は空)
- 結果: PASS / FAIL
- Notes:

### 2. 型選択 stage が combobox より縦も横も大きくない (Fix-1: 寸法制約)

- 操作: stage1 (combobox + input + リスト + 新規作成行) と 型選択 stage を行き来して目視比較。 DevTools Elements で実 px も確認推奨
- 期待: 型選択 stage の縦・横が stage1 combobox 以下 (popover は `max-w-sm`、 縦は ~112-128px 想定 / combobox は ~172px 想定 / `combobox > 型選択 stage`)
- 結果: PASS / FAIL
- Notes:

### 3. icon (CircleDot / ListChecks) の視認性 (Fix-1)

- 操作: 型選択 stage で 2 button の icon を観察 (DevTools Elements で SVG class が `lucide-circle-dot` / `lucide-list-checks` を確認)
- 期待: icon が単一/複数の意味を直感的に伝える視認性 (single = 1 個 dot、 multi = 複数 list check)。 違和感あれば代替 icon 検討 (OT 判断)
- 結果: PASS / FAIL
- Notes:

### 4. multi default focus + Enter 即決定 (Fix-1)

- 操作: 型選択 stage に遷移直後、 何も触らず Enter 押下
- 期待: `tagEditCallbacks.createCategory(name, 'multi')` 即発火 (= マルチセレクト button が default focus、 Enter で multi 決定)
- 結果: PASS / FAIL
- Notes:

### 5. single / multi button click → category 即作成 + stage='option' 遷移 (Fix-1 regression)

- 操作: 別名で型選択 stage 入り直し、 「シングルセレクト」 click。 別名で再度 入り直し 「マルチセレクト」 click
- 期待: 各 button click で category 即作成 + stage='option' 自動遷移 + 空 option list の placeholder 表示 + IndexedDB の `tag_categories.select_type` が `'single'` / `'multi'` 正しく保存
- 結果: PASS / FAIL
- Notes:

### 6. 作成失敗時 inline error + 連打防止 (Fix-1 regression)

- 操作: DevTools で擬似的に失敗発生 (オフライン or IndexedDB tag_categories close)。 型選択 stage で button click + 連打試行
- 期待: stage 留まり、 inline error「作成に失敗しました」 (role="alert") 表示、 連打しても createCategory 1 回呼出 (isSubmittingCreate ガード)、 button 再 enable
- 結果: PASS / FAIL
- Notes:

### 7. 完全一致 category 名で新規作成行が**出ない** (Fix-2: 同名抑制)

- 操作: stage1 で input に既存 category 名 (例「分野」) を case/whitespace 完全一致で入力
- 期待: 既存「分野」 行は表示される、 「+ 新規作成: 分野」 行が**出ない** (option との挙動統一)
- 結果: PASS / FAIL
- Notes:

### 8. 部分一致 / 空入力時の挙動は既存維持 (Fix-2 regression)

- 操作: input に「分」 (部分一致) 入力、 input 空にする
- 期待:
  - 部分一致: 「分野」 visible + 「+ 新規作成: 分」 行 visible (regression OK)
  - 空入力: 既存 category 全表示 + 新規作成行非表示 (regression OK)
- 結果: PASS / FAIL
- Notes:

### 9. DB schema 不変確認 (Fix-2 制約)

- 操作: 既存重複 category データ (過去に作成した同名) があれば popover 上で確認 (両方表示されること) + IndexedDB `tag_categories` の schema 確認 (UNIQUE インデックスが**追加されていない**こと)
- 期待: schema は本 sprint 前と同じ、 既存重複データは残存 (Tag-3 で名前マージ予定)
- 結果: PASS / FAIL
- Notes:

### 10. kebab (category) → editCategory stage 入った瞬間 rename input が focus + 全選択 (Fix-3)

- 操作: stage1 で任意 category 行末尾の「...」 kebab click → editCategory stage 遷移直後、 input 状態を観察
- 期待: rename input が focus 済 + テキスト全選択済 (`document.activeElement` = input、 selection が全文字)。 すぐタイプ開始で旧名が消えて新名で打ち変え可能
- 結果: PASS / FAIL
- Notes:

### 11. kebab (option) → editOption stage 入った瞬間 rename input が focus + 全選択 (Fix-3)

- 操作: stage2 (option 一覧) で任意 option 行末尾の「...」 kebab click → editOption stage 遷移直後を観察
- 期待: 観点 10 と同様、 全選択 focus + 即打ち変え可能
- 結果: PASS / FAIL
- Notes:

### 12. バッジ click 経路 (CardTagEditPopover) でも同様 (Fix-3)

- 操作: 試験詳細の任意バッジ click で開く popover の option 一覧で kebab click → editOption stage を観察
- 期待: rename input が focus + 全選択
- 結果: PASS / FAIL
- Notes:

### 13. editOption stage 中に別 option の kebab → editTargetId 変化 → 全選択 focus 再発火 (Fix-3 key 制御)

- 操作: editOption stage で「← option 一覧に戻る」 click → 別 option の kebab click → 再度 editOption stage 入り
- 期待: 別 option の rename input が focus + 全選択 (key={editTargetId} で再 mount された結果、 useEffect 再発火)
- 結果: PASS / FAIL
- Notes:

### 14. Tag-4c-2a-fix の全 regression なし

- 操作: Tag-4c-2a-fix smoke-checklist の 16 観点を主要シナリオ確認 (stage1 combobox / 「+ 新規作成」 click / 型選択 stage 遷移 / option 作成挙動 / Esc 階層 / popover close reset)
- 期待: 全て regression なし (本 sprint で挙動が変わったのは Fix-1 / Fix-2 / Fix-3 の 3 観点のみ、 他は不変)
- 結果: PASS / FAIL
- Notes:

### 15. console error 0 + Tag-4c-1 / 4c-2a 全 regression なし

- 操作: 観点 1-14 を一巡しつつ DevTools Console を監視。 Tag-4c-1 (kebab / rename / color / 削除 / Esc) と Tag-4c-2a (combobox / 新規作成 + 即付与 / バッジ click / nav タグ link / manager 画面) も主要シナリオ確認
- 期待: console.error 0 件、 全 regression なし
- 結果: PASS / FAIL
- Notes:
