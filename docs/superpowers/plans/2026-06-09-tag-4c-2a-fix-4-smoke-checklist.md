# Tag-4c-2a-fix-4 stg smoke checklist

OT が stg で実機確認する 14 観点 (7 検証カテゴリ)。 plan: `docs/superpowers/plans/2026-06-09-tag-4c-2a-fix-4.md`、 spec: `docs/superpowers/specs/2026-06-09-tag-4c-2a-fix-4-design.md`、 commit: Tag-4c-2a (0be3064) に amend で畳む想定 (push は OT が `--force-with-lease` で実施)

## 前提

- stg URL: https://stg.recallmint.nekotest.net/app
- ログイン: stg test 用 (memory: `stg-smoke-login.md`)
- 対象 page: /app/exams/[id] (試験詳細)
- mobile 要否: 必要 (Chrome DevTools mobile view、 iPhone 12 Pro 等)
- 確認用 試験 ID: OT 記入 / 確認 card: OT 記入

## 観点

### 1. Fix-1 PopoverContent min-w-56 (両 popover)

- 操作: CardTagAddPopover (「+ タグを追加」) と CardTagEditPopover (バッジ click) を開いて DevTools Elements で `[data-slot="popover-content"]` の className を確認
- 期待:
  - 両 popover の class が `min-w-56 max-w-sm p-0`
  - `w-auto` が含まれない
- 結果: PASS / FAIL
- Notes:

### 2. Fix-1 stage A / C / D で popover 横幅が揃う (224px floor)

- 操作: stage A (category 一覧)、 stage C (型選択 createCategoryType)、 stage D (バッジ click の option 一覧) を順次表示し DevTools で実 px 確認
- 期待: 3 stage いずれも popover 横幅が **概ね 224px** (実機目視 ±4px 以内)。 stage 遷移時の体感的な「幅が変わる」 感覚が解消
- 結果: PASS / FAIL
- Notes:

### 3. Fix-4 + Fix-1 stage B (新規 category 作成直後) も他 stage と幅が揃う

- 操作: stage A で input に新名を入力 → 「+ 新規作成」 → 型選択 → 単一 or 複数 button click → stage B (新 category の option 0 件) に自動遷移、 popover 横幅を観察
- 期待:
  - Fix-4 で empty placeholder が「タグ名を入力し新規作成」 (12 文字) に短文化、 max-w-sm まで膨張しない
  - Fix-1 の min-w-56 floor で stage B も**約 224px** (stage A / C / D と揃う)
  - empty placeholder は 1 行で表示 (短文化により 224px 内収まる)
- 結果: PASS / FAIL
- Notes:

### 4. Fix-2 long Japanese name で popover が max-w-sm 超えない (color pill)

- 操作: 長 Japanese option / category 名 (例「肺気腫合併心房細動の急性増悪」 ≈ 14 文字) を持つ card で popover 表示
- 期待:
  - color pill 内で名前が `break-all` で**自動 wrap** (任意位置 break、 連続漢字でも break)
  - popover 横幅が `max-w-sm` (384px) を**超えない**
- 結果: PASS / FAIL
- Notes:

### 5. Fix-2 新規作成行で long Japanese 入力時に wrap

- 操作: stage='option' で input に長 Japanese 文字列 (例「肺気腫合併心房細動の急性増悪」) を入力 → 「新規作成: {入力}」 行を観察
- 期待:
  - 新規作成行の text が `break-all` で wrap
  - popover 横幅が max-w-sm を超えない
- 結果: PASS / FAIL
- Notes:

### 6. Fix-3 型選択 stage の 2 button content 左端が他 stage の row content と縦揃え一致 (8px)

- 操作: 型選択 stage (createCategoryType) と stage A の category 行 / stage D の option 行を DevTools Elements / Computed で比較
- 期待:
  - 型選択 stage の single / multi button の content (icon + text) 左端が popover-left + **8px**
  - stage A の category 行 button content 左端も popover-left + 8px
  - stage D の option 行 button content 左端も popover-left + 8px
  - 縦に並べると 3 stage で左端が揃う
- 結果: PASS / FAIL
- Notes:

### 7. Fix-4 empty placeholder 短文「タグ名を入力し新規作成」 表示

- 操作: 新規 category 作成直後の stage B、 既存 category の option 0 件 stage、 category 0 件 (空テナント) stage A を順次確認
- 期待: 3 箇所すべてで empty placeholder text が「タグ名を入力し新規作成」 (旧長文「上の入力欄に名前を入れて『新規作成』 で追加できます」 / 「下の入力欄に...『+ カテゴリを追加』...」 が DOM 不在)
- 結果: PASS / FAIL
- Notes:

### 8. Logic 完全不変: multi default focus + Enter 即決定 + 二重発火 guard

- 操作: 型選択 stage に遷移直後 Enter 押下、 multi button を連打試行
- 期待:
  - 遷移直後 Enter で multi 即発火 (Tag-4c-2a-fix-2 Fix-1 regression)
  - 連打で `createCategory` 1 回呼出 (Tag-4c-2a-fix Task 3 regression)
- 結果: PASS / FAIL
- Notes:

### 9. Logic 完全不変: Esc 階層 + popover close reset

- 操作: 型選択 stage で Esc 押下、 popover open/close を繰り返し
- 期待:
  - Esc → stage='category' に戻る + pendingCategoryName + createError reset (Tag-4c-2a-fix-2 Task 3 regression)
  - popover close → 全 state reset (regression)
- 結果: PASS / FAIL
- Notes:

### 10. Logic 完全不変: 同名抑制 + 編集 stage 全選択 focus

- 操作:
  - stage1 で既存 category 名 (完全一致) 入力 → 「+ 新規作成」 行が出ない
  - stage1 で任意 category 行 kebab → editCategory stage で rename input が focus + 全選択
- 期待:
  - Tag-4c-2a-fix-2 Fix-2 (同名抑制) regression なし
  - Tag-4c-2a-fix-2 Fix-3 (全選択 focus rAF) regression なし
- 結果: PASS / FAIL
- Notes:

### 11. Logic 完全不変: category 行 select_type icon (Tag-4c-2a-fix-3 Fix-4)

- 操作: stage A の category 一覧で各 row 左端の icon を観察
- 期待:
  - single category 行に CircleDot (⦿) icon、 multi に CheckSquare (☑) icon
  - option 行には icon なし
  - Tag-4c-2a-fix-3 Fix-4 の挙動 regression なし
- 結果: PASS / FAIL
- Notes:

### 12. Mobile (DevTools mobile view) で popover が card column 内に収まる

- 操作: Chrome DevTools で iPhone 12 Pro (390px 幅) 等の mobile view、 popover を開く
- 期待:
  - popover (min-w-56 = 224px) が card column (~370px) 内に収まる、 overflow なし
  - stage 遷移時の幅変動が体感的に小さい
- 結果: PASS / FAIL
- Notes:

### 13. console error 0

- 操作: 観点 1-12 を一巡しつつ DevTools Console を監視
- 期待: console.error 0 件
- 結果: PASS / FAIL
- Notes:

### 14. Tag-4c-1 / 4c-2a / 4c-2a-fix / 4c-2a-fix-2 / 4c-2a-fix-3 全 regression なし

- 操作: 既存 sprint の主要シナリオを再確認 (kebab / rename / color / 削除 / Esc / バッジ click / nav タグ link / manager 画面 / 型選択 stage コンパクト UI / category 行 icon)
- 期待: 全 regression なし、 体感問題なし
- 結果: PASS / FAIL
- Notes:
