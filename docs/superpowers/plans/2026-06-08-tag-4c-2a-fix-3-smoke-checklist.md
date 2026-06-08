# Tag-4c-2a-fix-3 stg smoke checklist

OT が stg で実機確認する 12 観点 (6 検証カテゴリ)。 plan: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-3.md`、 spec: `docs/superpowers/specs/2026-06-08-tag-4c-2a-fix-3-design.md`、 commit: Tag-4c-2a (4ac85b5) に amend で畳む想定 (push は OT が `--force-with-lease` で実施)

## 前提

- stg URL: https://stg.recallmint.nekotest.net/app
- ログイン: stg test 用 (memory: `stg-smoke-login.md`)
- 対象 page: /app/exams/[id] (試験詳細)
- mobile 要否: 必要 (Chrome DevTools mobile view で 寸法目視 + category 行 icon 視認性)
- 確認用 試験 ID: OT 記入 / 確認 card: OT 記入

## 観点

### 1. Fix-1 幅揃え: stage1 combobox と型選択 stage の box 左右余白が一致

- 操作: stage1 (category 一覧 combobox) と 型選択 stage (createCategoryType) を行き来して目視比較。 DevTools Elements で stage1 input outer (`px-2 pb-1`) と 型選択 stage 2-button block outer (`px-2 pb-1`) の実 px を確認
- 期待: 左右余白 (px-2 = 8px 想定) が両 stage で**揃う** (±2px 以内)、 体感で「同じ popover の同じ box 系列」 と認識できる
- 結果: PASS / FAIL
- Notes:

### 2. Fix-2 見出し削除: 「『...』 の種別を選択」 が DOM に存在しない

- 操作: stage1 で「+ 新規作成: {名前}」 → 型選択 stage に遷移し UI を観察
- 期待: 見出し行が**消えている**。 stage 内容は back button + 2 button (single / multi) + (失敗時) inline error のみ。 「種別を選択」 文字列は DOM 検索でヒットしない
- 結果: PASS / FAIL
- Notes:

### 3. Fix-2 見出し削除後の文脈不在チェック (UX 確認)

- 操作: 型選択 stage に遷移して「何の操作か」 が文脈的に理解できるか自己確認
- 期待: 直前に「+ 新規作成: {名前}」 を click した文脈で 2 button (single / multi) の意味が分かる、 違和感がない (OT 直感で判断)
- 結果: PASS / FAIL
- Notes:

### 4. Fix-3 multi icon: ☑ (CheckSquare) が表示される

- 操作: 型選択 stage で multi button の icon を観察 (DevTools Elements で SVG class を確認)
- 期待:
  - multi button の icon が `svg.lucide-square-check-big` (lucide-react@1.14.0 で `CheckSquare` = `SquareCheckBig` alias による emit class)
  - 旧 `svg.lucide-list-checks` は DOM 不在
  - single button の icon は `svg.lucide-circle-dot` (regression)
- 結果: PASS / FAIL
- Notes:

### 5. Fix-3 multi icon の視認性

- 操作: 型選択 stage の 2 button を見て、 ☑ icon が「複数選択」 を直感的に伝えるか確認
- 期待: 違和感なく「単一 (⦿) / 複数 (☑)」 と認識できる。 もし違和感あれば代替 icon (例: `ListChecks` 戻し or `SquareCheck` 等) を OT 判断
- 結果: PASS / FAIL
- Notes:

### 6. Fix-4 category 行 icon: stage1 各 category 行の左端に icon

- 操作: stage1 (category 一覧) で各 category 行を観察
- 期待:
  - select_type='single' の category 行 → 行頭に `svg.lucide-circle-dot` (⦿) が表示
  - select_type='multi' の category 行 → 行頭に `svg.lucide-square-check-big` (☑) が表示
  - icon size `h-3.5 w-3.5` (= 14px) / 色 `text-slate-400` (淡め、 名前を主、 icon を副)
- 結果: PASS / FAIL
- Notes:

### 7. Fix-4 option 行 (stage2) には icon が**出ない** (視覚区別)

- 操作: 任意 category 行 click → stage2 (option 一覧) を観察
- 期待: option 行 (kind='option') には select_type icon が出ない (Fix-4 目的: category と option の視覚区別)。 既存 color pill + 名前 + selected 時 Check icon は維持
- 結果: PASS / FAIL
- Notes:

### 8. Fix-4 mobile での category 行 icon 視認性

- 操作: Chrome DevTools mobile view (iPhone 12 Pro 等) で stage1 を表示
- 期待: `h-3.5 w-3.5` の小 icon が mobile でも視認できる (タップ操作には関与しない、 視覚情報のみ)
- 結果: PASS / FAIL
- Notes:

### 9. Logic 完全不変: multi default focus + Enter 即決定 + 二重発火 guard

- 操作: 型選択 stage に遷移直後 Enter 押下、 multi button を連打試行
- 期待:
  - 遷移直後 Enter で multi 即発火 (= multi default focus 維持、 Tag-4c-2a-fix-2 Fix-1 regression)
  - 連打で `createCategory` は 1 回しか呼ばれない (二重発火 guard 維持、 Tag-4c-2a-fix Task 3 regression)
- 結果: PASS / FAIL
- Notes:

### 10. Logic 完全不変: Esc 階層 + popover close reset

- 操作: 型選択 stage で Esc 押下、 popover open/close を繰り返し
- 期待:
  - Esc → stage='category' に戻る + pendingCategoryName + createError reset (Tag-4c-2a-fix-2 Task 3 regression)
  - popover close → 全 state reset、 再 open で stage='category' から開始 (regression)
- 結果: PASS / FAIL
- Notes:

### 11. Logic 完全不変: category 同名抑制 + 編集 stage 全選択 focus

- 操作:
  - stage1 で既存 category 名 (完全一致) 入力 → 「+ 新規作成」 行が出ないこと
  - stage1 で任意 category 行の kebab click → editCategory stage で rename input が focus + 全選択
- 期待:
  - Tag-4c-2a-fix-2 Fix-2 (同名抑制) regression なし
  - Tag-4c-2a-fix-2 Fix-3 (全選択 focus rAF) regression なし
- 結果: PASS / FAIL
- Notes:

### 12. console error 0 + Tag-4c-1 / 4c-2a / 4c-2a-fix / 4c-2a-fix-2 全 regression なし

- 操作: 上記 1-11 を一巡しつつ DevTools Console を監視。 既存 sprint の主要シナリオも再確認 (kebab / rename / color / 削除 / Esc / バッジ click / nav タグ link / manager 画面)
- 期待: console.error 0 件、 全 regression なし
- 結果: PASS / FAIL
- Notes:
