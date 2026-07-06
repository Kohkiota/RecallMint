# Exam 詳細テーブル B+C fix — fact-finding(2026-07-06)

対象: ExamCardTable(`app/(app)/app/exams/[id]/_components/`)
指摘 B = checkbox セル全体クリック可能化 / 指摘 C = セル縦位置を上揃え(top)に。

## B: checkbox セルの現状

### レンダリング構造(2 レイヤー)

1. **cell content**(`exam-card-table-columns.tsx:91-98`): 素の `<input type="checkbox">` のみ。
   `checked={row.getIsSelected()}` / `onChange={row.getToggleSelectedHandler()}` / `aria-label="行選択: {title}"`。
   当たり判定 = checkbox 固有サイズ(~16px 四方)のみ。
2. **td**(`exam-card-table.tsx:197-219`): 全列共通の単一 render 経路。select 列は既に条件分岐あり
   (`cell.column.id === 'select' && 'text-center'`、:205)。padding `px-1 py-1`、列幅 size:32(columns.tsx:79)。

行高は可変(multiline 長文セルで数百 px になり得る)→ checkbox 周囲の縦デッドゾーンが特に大きい。

### 衝突面の確認(結論: セル内衝突なし)

- select td 内の interactive 要素は checkbox のみ。inline 編集(InlineTextField)は
  title / sort_key / question / explanation_text / memo 列、hover peek button は title 列のみ
  (columns.tsx:116-139)— select 列とは別セル。
- `<tr>` に onClick なし(`hover:bg-muted/50` の視覚のみ、exam-card-table.tsx:189)。行 click での
  selection / peek 起動は存在しない。
- resize handle は select 列 skip 済(exam-card-table.tsx:792 `canResize && h.column.id !== 'select'`)。
- select 列が pinned の場合 td は `sticky z-[1]` になるが position 系のみで click 挙動と直交。

**唯一の注意点**: td に onClick を足すと、checkbox 直 click 時に checkbox の onChange(toggle)+
bubbling した td onClick(toggle)が二重発火し net no-op になる。checkbox 側
`onClick={(e) => e.stopPropagation()}` で遮断するのが定石(onChange は温存 = キーボード Space も不変)。

### 実装余地(2 案)

- **案 td-onClick(推奨)**: TableBody の td render に select 列分岐が既にあるので、同分岐で
  `onClick={() => row.toggleSelected()}` + `cursor-pointer` を追加。td 全域(padding + 可変行高の
  全高)が当たり判定になる。columns.tsx 側は checkbox に stopPropagation を 1 行追加。
  ※ `getToggleSelectedHandler()` を td onClick に流用しない — 実装が `e.target.checked` を読む前提で
  td では undefined になるため、引数なし `row.toggleSelected()`(= 反転)を直接呼ぶのが明確。
- **案 label ラップ**: cell content を `<label>` で包む案は不利 — table cell 内で子要素の
  height:100% 伸長が不安定で、可変行高 + td padding 領域をカバーできない。却下。

header の全選択 checkbox(th、columns.tsx:80-90)は同構造の狭い当たり判定だが、指摘 B の文言は
行セル。th は 1 行高で padding 領域も小さく、対象に含めるかは OT 判断(含める場合も同型の追加)。

### 既存テスト

- toggle: `exam-card-table.test.tsx:106`(checkbox click で checked 追従)、
  `exam-card-table-bulk.test.tsx:110`(role=checkbox click)— checkbox の onChange 温存なら生存。
- td class: `exam-card-table.test.tsx:828`(select td が text-center を持つ)— class 追加は非破壊。
- 追加余地: 「td(checkbox 外)click で選択トグル」「checkbox 直 click で二重発火しない(1 回で
  checked)」の 2 assert。

## C: セル縦揃えの現状

### 現在指定

- **body td**: vertical-align 指定なし(exam-card-table.tsx:203-208 の className に align 系なし、
  globals.css にも td 規則なし)→ UA default の `vertical-align: middle` が効いている(指摘どおり)。
- **thead th**: select 列のみ `align-middle` 明示(exam-card-table.tsx:699)、他列は指定なし。
  test `exam-card-table.test.tsx:803-815` が th select の align-middle を assert 済。

### 変更方法(全列一律で 1 箇所)

body td の render は単一経路(全列共通 className、:203)のため、`'px-1 py-1 border-b border-border'`
に `align-top` を足すだけで**全列一律**に効く。列ごと個別指定は不要。
リポジトリ既存パターンあり: `custom-session-preview.tsx:106` 等が td `align-top` を使用(前例準拠)。

### 波及確認(すべて影響なし)

| 対象 | 結論 |
|---|---|
| sticky thead th | 対象外(td のみ変更)。header は 1 行高で視覚差なし。align-middle test は th 側で不変 |
| pinned td(sticky + left) | position 系プロパティで vertical-align と直交。影響なし |
| virtualizer spacer 行 | 空 td(height style のみ)。影響なし |
| 選択肢セル(CompactOptionsCell)/ タグセル(TagCell)内の縦積み | cell content block が上に寄るだけ。内部レイアウトは block flow で不変 |
| title 列 hover peek button | wrapper div(relative)基準の absolute → wrapper ごと上へ移動するだけ |
| 行高可変 / virtualizer measureElement | 行高 = 最大 cell 高で決まり vertical-align は行高を変えない。再測定・estimate 影響なし |

### 論点

- select 列 checkbox も top に寄る。B の全セルクリック化で操作性は担保されるため一律 top で
  問題ない見立てだが、checkbox のみ middle 維持(select 列だけ例外)も 1 分岐で可能。
- 短値列(直近正誤 / 連続正解数 / 最終回答日時)も top に寄る — 長文セルと行内で頭が揃うのが
  指摘の意図どおりのはず。

## 想定変更ファイル(実装フェーズ)

- `exam-card-table.tsx`: td className に `align-top` + select 列分岐に onClick/cursor(B+C とも同 file)
- `exam-card-table-columns.tsx`: checkbox に stopPropagation(B)
- `exam-card-table.test.tsx`: B の toggle assert 追加 + 必要なら td class assert 更新
