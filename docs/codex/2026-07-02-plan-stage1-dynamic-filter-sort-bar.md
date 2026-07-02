# Codex plan cross-check — stage1-dynamic-filter-sort-bar (2026-07-02)

- **作成日**: 2026-07-02
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- 現状の中核 state は `ExamCardTable` 内の controlled TanStack state。`sorting` は初期 `[{ id: 'question', desc: false }]`、`columnFilters` は非永続で保持されています。[exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:199)
- `useReactTable` には `getSortedRowModel` / `getFilteredRowModel`、`onSortingChange` / `onColumnFiltersChange` が接続済みなので、既存 predicate は不変のまま UI だけ動的化できます。[exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:351)
- 既存フィルタ UI は固定上部バーに集約され、`table.getColumn(...).getFilterValue()` / `setFilterValue()` で直接 `columnFilters` を操作しています。[exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:60)
- 既存 predicate は純関数。タグはカテゴリ内 OR / カテゴリ間 AND、回答状態は `all | unanswered | correct | incorrect`、連続正解数は `lte | gte | eq` です。[card-filter-predicates.ts](/workspaces/RecallMint/app/(app)/app/exams/[id]/_lib/card-filter-predicates.ts:15)
- TanStack の `ColumnFiltersState` は配列ですが、実質「column id ごとに 1 filter value」です。複数列フィルタは自然に対応しますが、同一列に複数条件を積む設計には向きません。段階1の既存3フィルタなら問題なし。
- `SortingState` は配列なので複数ソートを保持できます。ただし既存ヘッダークリックは `getToggleSortingHandler()` で、通常クリックでは単一ソート寄りの挙動になります。[exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:578) Notion 風に「追加条件」とするなら `column.toggleSorting(desc, true)` または `setSorting` で明示的に append/update/remove する設計が必要です。
- 初期ソート `question asc` の扱いが重要です。これを「暗黙の既定順」とするなら動的バーには出さないが、ユーザーが全ソート削除した時に初期順へ戻すのか `sorting=[]` にするのかを決める必要があります。
- ソート対象は `question`, `lastCorrect`, `currentStreak`, `lastReview`。`question` は表示名「問題文」ですが comparator は `sortLikeServer` で実質「連番順」です。[exam-card-table-columns.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:112)
- フィルタ対象は `tags`, `lastCorrect`, `currentStreak`。`lastCorrect` と `currentStreak` はソートとフィルタが同居する列です。[exam-card-table-columns.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:198)
- ヘッダーメニュー化では `select` 列を除外すべきです。現状 `select` ヘッダーは全選択 checkbox そのものです。[exam-card-table-columns.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:62)
- resize handle は `stopPropagation()` で既存ソート発火を防いでいます。[exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:595) ヘッダー全体を Popover trigger にすると resize drag と menu open が衝突しやすいです。
- 器は `DropdownMenu` と `Popover` の両方がありますが、段階1は sort item だけでなく select/input/tag popover を含むため、外側は `Popover` の方が設計しやすいです。[popover.tsx](/workspaces/RecallMint/components/ui/popover.tsx:8)
- タグ filter には `CardTagAddPopover` 再利用余地があります。任意 trigger と `selectOnly` が既にあります。[card-tag-add-popover.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:91) ただし現行 filter bar では `selectOnly` 未指定なので、作成・編集導線が出ます。[exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:208)
- 動的バーは「上部固定バーの削除」ではなく、active `sorting` と `columnFilters` の投影 UI として必要です。削除・編集・全解除・ゼロ時シュリンクをこのバーで持つべきです。
- 現在の filter bar は `フィルタをクリア`、タグ chip、回答状態 select、連続正解数 input を提供しています。[exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:151) 動的バー移行でこれらの代替が必要です。
- 連続正解数の input local state は現行固定バー内にあります。[exam-card-table-filter-bar.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.tsx:77) メニュー/バーが mount/unmount する設計では、表示値を `columnFilters` から復元できる形に寄せる必要があります。
- 適用中インジケータは state read のみで足ります。ソート矢印は既に `getIsSorted()` で描画済みです。[exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:562) フィルタ dot は `getFilterValue()` / `getIsFiltered()` 相当で実装できます。
- hidden column に active filter/sort が残る可能性があります。`columnVisibility` は既に別 UI で永続化されます。[exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:377) 隠れた列の条件はヘッダー indicator では見えないため、動的バーに表示する意義が大きいです。
- 仮想化は `useWindowVirtualizer` と `scrollMargin` に依存します。[exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:92) 現在は filter bar wrapper の高さ変化を `ResizeObserver` で測っています。[exam-card-table.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:506) 動的バーの高さ変化も同じ測定対象に入れる必要があります。

## plan ドラフトへの抜け・未考慮指摘

- draft 自体が「plan 本文が含まれていない」としているため、実質的な plan 照合になっていません。[2026-07-02-plan-d-header-menu-migration.md](/workspaces/RecallMint/docs/codex/2026-07-02-plan-d-header-menu-migration.md:43)
- 段階1要件の中心である「動的フィルタ/ソートバー」が弱いです。draft は上部バー削除や列メニュー移植に寄っていますが、active sort/filter 条件を並べるバー、ゼロ時シュリンク、個別編集/削除、全解除の設計を明示すべきです。
- `sorting` の複数条件設計が不足しています。既存 header click の `getToggleSortingHandler()` では Notion 的な「条件追加」になりにくいため、append/update/remove の reducer 方針が必要です。
- 初期 `question asc` を active 条件として扱うか、暗黙の既定順として扱うかが未決です。ここを決めないと「ゼロでバーがシュリンク」と初期ソートが矛盾します。
- `ColumnFiltersState` が同一列複数 filter に向かない点の明記が必要です。段階1では問題ないが、段階3-4で同一列テキスト filter などを足す場合に state schema を再検討する可能性があります。
- タグ filter で `selectOnly` を使うかが未確定です。段階1が既存 filter の動的化だけなら、タグ作成/編集導線を filter メニュー内に出すのは過剰です。
- `CardTagAddPopover` を header popover 内に入れると Popover のネストになります。外側をどう閉じるか、タグ複数選択時に内側が即 close してよいか、focus/Escape の責務分担が必要です。
- hidden column に active 条件がある場合の表示が不足しています。列が非表示でも filter/sort は効くため、動的バー側で条件を見える化しないと解除不能に近くなります。
- `filterBarWrapperRef` の扱いは「消す」では足りません。動的バー + column visibility toggle の高さを測る wrapper として再定義する必要があります。
- 既存テストの移行方針がまだ粗いです。`filter-bar.test.tsx` の固定ラベル操作は、新 UI の「ヘッダーメニューで追加 → バーで編集/削除」に置き換える受入テストが必要です。[exam-card-table-filter-bar.test.tsx](/workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-filter-bar.test.tsx:71)
- header の click 領域設計が不足しています。全体クリックで menu、resize handle で resize、select column は checkbox、という分離を DOM 構造レベルで決める必要があります。

## リスク / 対立しうる設計判断

- 最大の対立は「ヘッダークリックで即ソート」から「ヘッダークリックでメニュー」への操作変更です。要件は後者なので既存挙動変更は妥当ですが、テストと受入基準で明示すべきです。
- `Popover` は入力 UI に強く、`DropdownMenu` は項目選択に強いです。段階1だけでも数値 input とタグ選択があるため、外側を `Popover` に寄せる判断が堅いです。
- 動的バーの state を TanStack state から直接投影するか、独自 condition list を primary state にするかは設計判断です。段階1は TanStack state primary が低リスクですが、後段で同一列複数条件を許すなら独自 condition list が必要になる可能性があります。
- 初期ソートを「条件」と見なすか「既定順」と見なすかで UX が変わります。Notion 風のゼロ条件を優先するなら、初期順はバーに出さない暗黙 default とし、全 sort 削除時の復元規則を決めるのが自然です。
- active 条件のある hidden column は UX リスクです。ヘッダー indicator だけでは不十分なので、動的バーを唯一の全体可視化面にする必要があります。
- 既存 predicate 不変を守ればデータ結果の回帰リスクは低いですが、UI local state、Popover focus、仮想化 offset、resize との衝突が主な破損点です。