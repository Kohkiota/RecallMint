# Codex plan cross-check — d-header-menu-migration (2026-07-02)

- **作成日**: 2026-07-02
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

既存の中核 state は [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:199) の `ExamCardTable` が持っています。`sorting` 初期値は `[{ id: 'question', desc: false }]`、`columnFilters` は非永続です [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:201)。TanStack には `getSortedRowModel` / `getFilteredRowModel` と controlled state が渡されています [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:351)。

既存フィルタ UI は上部バーの [exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:60) に集約されています。ここで `table.getColumn('tags'|'lastCorrect'|'currentStreak')` を取得し、`getFilterValue` / `setFilterValue` で直接 columnFilters を read/write しています [exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:66)。したがって設計上は「状態・比較ロジックは維持し、UI の設置場所だけ header menu に移す」が本筋です。

フィルタ評価ロジックは純関数化済みです。タグはカテゴリ内 OR / カテゴリ間 AND [card-filter-predicates.ts](/workspaces/RecallMint/app/(app)/app/exams/[id]/_lib/card-filter-predicates.ts:25)、回答状態は `all | unanswered | correct | incorrect` [card-filter-predicates.ts](/workspaces/RecallMint/app/(app)/app/exams/[id]/_lib/card-filter-predicates.ts:43)、連続正解数は `lte | gte | eq` [card-filter-predicates.ts](/workspaces/RecallMint/app/(app)/app/exams/[id]/_lib/card-filter-predicates.ts:73)。D ではここを触らないことが「移植のみ」の主要ゲートです。

対応マッピング:

| 対象列 | 既存 column id | ソート | フィルタ | 論点 |
|---|---:|---|---|---|
| 問題文 | `question` | 初期ソート、`sortLikeServer` 比較 [columns](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:112) | なし | 表示名は問題文だが、実質「連番順」ソート。メニュー文言に注意 |
| タグ | `tags` | なし | `TagFilterValue` [columns](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:144) | `CardTagAddPopover` 再利用時の selectOnly 指定が重要 |
| 直近正誤 | `lastCorrect` | boolean + null last [columns](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:198) | 回答状態 | 1列にソート + フィルタが同居 |
| 連続正解数 | `currentStreak` | 数値ソート [columns](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:223) | 数値比較 | 1列にソート + フィルタが同居 |
| 最終回答日時 | `lastReview` | ISO text + null last [columns](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:236) | なし | sortUndefined 維持が必須 |
| タイトル/ソートキー/選択肢/解説/メモ | 各 id | なし | なし | D では列メニューを出すか、無操作列は出さないかを決める必要 |
| select | `select` | なし | なし | ヘッダー checkbox なのでメニュー化対象外が妥当 |

ヘッダーメニューの器は既存プリミティブがあります。フォーム要素やタグ選択 popover を内包するなら `Popover` が自然です [popover.tsx](/workspaces/RecallMint/components/ui/popover.tsx:8)。`DropdownMenu` もありますが [dropdown-menu.tsx](/workspaces/RecallMint/components/ui/dropdown-menu.tsx:9)、select/input/ネスト popover を入れる場合は focus 管理と自動 close がリスクになりやすいです。

既存タグ絞り込みは `CardTagAddPopover` を adapter として再利用しています [exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:207)。この component には任意 trigger と `selectOnly` が既にあります [card-tag-add-popover.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:91)、[card-tag-add-popover.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:96)。header menu 内でさらに Popover をネストするなら、外側メニューが閉じる/内側が操作不能になるリスクを設計で潰す必要があります。

適用中インジケータは TanStack column API だけで読めます。ソートは既に `h.column.getIsSorted()` で矢印表示されています [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:562)。フィルタは各 header の `h.column.getFilterValue()` または `h.column.getIsFiltered()` 相当で読み、`tags` / `lastCorrect` / `currentStreak` のみ dot/icon を出せば新規ロジック不要です。注意点は `answerState='all'` や空 tag map を filter として残さない既存規約を維持することです [exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:86)、[exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:123)。

上部バー削除で失われる既存機能は明確です。全フィルタクリア [exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:154)、タグ選択中 chip と個別解除 [exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:134)、回答状態 select、連続正解数 op/input がバーにあります。代替として各列メニュー内に「この列のフィルタ解除」は必要で、全体の「全フィルタ解除」をどこに置くかは要件上未確定です。

非回帰観点では、header は仮想化 body の外です。行仮想化は `useWindowVirtualizer` + spacer tbody で実装されています [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:92)。ただし現在は filter bar wrapper の高さを `ResizeObserver` で監視し list offset を再計測しています [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:506)。上部バーを消すなら、この wrapper と listOffset 計測の前提を再確認する必要があります。

受入基準としては、既存テストで担保されているフィルタ挙動 [filter-bar.test.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.test.tsx:71)、ソート挙動 [sorting.test.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-sorting.test.tsx:89)、列表示/非表示 [column-toggle.test.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-column-toggle.test.tsx:85) を、新 UI 操作に置き換えて同等に通すこと。実装分割は、1. header menu shell、2. sort controls 移植、3. 3種 filter UI 移植、4. indicator、5. 上部バー撤去と offset/selection 回帰確認、が妥当です。

## plan ドラフトへの抜け・未考慮指摘

このメッセージ内に plan ドラフト本文が含まれていないため、特定行に対する照合はできません。以下は、ドラフトに入っていなければ抜けとして扱うべき点です。

- `th onClick = sort` を単純に Popover trigger に置き換えると、既存のヘッダークリックソート挙動と衝突します [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:578)。ソートはメニュー項目化するのか、クリックでメニューを開きつつ別操作でソートするのかを明記すべきです。
- resize handle は `stopPropagation` で sort 発火を防いでいます [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:595)。header trigger 化後も resize drag が menu open/close を誘発しない設計が必要です。
- `select` header は checkbox 実体です [exam-card-table-columns.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:62)。全列一律メニュー化すると全選択操作を壊すため、除外条件が必要です。
- タグ列で `CardTagAddPopover` を外側メニュー内に入れるなら nested Popover になります。`DropdownMenu` を外側にすると focus/close の問題が出やすいため、器の選定理由が必要です。
- `CardTagAddPopover` は filter 用に `selectOnly` を持つのに、現行 filter bar 呼び出しでは渡していません [exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:208)。D で「新規開発なし」を守るなら、タグ編集/作成導線を header filter 内で出すか消すかを明示すべきです。
- 上部バー削除により `フィルタをクリア` と chip 個別解除が消えます。列別解除だけで足りるのか、全解除をどこに置くのかが未決だと UX 退行になります。
- `filterBarWrapperRef` は現在 offset 再計測の監視対象です [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:538)。バー削除後の計測対象をどうするか、また Popover 開閉で listOffset を変えないことを明記すべきです。
- columnVisibility は将来同メニュー予定でも D 範囲外です。既存の独立 `ColumnVisibilityToggle` を残すこと [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:545) と、D で混ぜない境界を明確化すべきです。
- 「移植のみ」担保として、`card-filter-predicates.ts` と column の `filterFn` / `sortingFn` を変更禁止対象に置くべきです。

## リスク / 対立しうる設計判断

最大の設計対立は、Notion 風の「ヘッダークリックでメニュー」と、既存の「ヘッダークリックで即ソート」です。要件は前者なので、即ソートをやめるなら既存操作の変更としてテスト更新が必要です。維持するならクリック領域を分ける必要があり、UI が複雑になります。

`Popover` と `DropdownMenu` の選定も対立点です。ソートだけなら DropdownMenu が軽いですが、回答状態 select、数値 input、タグ popover を入れるなら Popover のほうが安全です。特にタグ filter は既に Popover component なので、外側 menu とのネストを避ける設計が重要です。

フィルタ中インジケータは「state 読取のみ」で実現できますが、空値を filter state に残す実装に変えると dot が誤点灯します。既存の `undefined` で解除する規約を守ることが必須です。

上部バー撤去は見た目以上に影響があります。selection prune は `columnFilters` 変化に依存しているため [exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:424)、フィルタ write 先を変えなければ保てますが、UI の局所 state、特に連続正解数 input の local state を header menu の mount/unmount とどう同期するかは要検討です。