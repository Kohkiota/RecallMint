# S3(新規ソート3種 + 問題文ソート撤去)実装セッション記録

- 日付: 2026-07-05 / branch: develop / 実行方式: `superpowers:subagent-driven-development`(RecallMint 規律 = review-before-commit)
- spec: `docs/superpowers/specs/2026-07-05-notion-table-s3-sorts-design.md`
- plan: `docs/superpowers/plans/2026-07-05-notion-table-s3-sorts.md`
- 起点 HEAD: 2737323 / 完了 HEAD: dc8e4f1(S3-2 docs commit)

## 実装結果(全 task Critical 0 / Important 0 で [reviewed])

| task | 内容 | feat commit | canonical | Codex |
| --- | --- | --- | --- | --- |
| S3-1 | タイトル / ソートキー ソート追加 + 問題文ソート撤去 | 6da14d1 | Approved(Crit0/Imp0/Min3) | clean |
| S3-2 | タグソート(先頭チップ代表値)+ tags header 改修(H-1) | f343f4b | Approved(Crit0/Imp0/Min1) | clean |

- docs(codex): `docs/codex/2026-07-05-s3-1-sorts.md` / `-s3-2-tag-sort.md`(+ plan cross-check `2026-07-05-plan-s3-sorts.md`)
- 実コード訂正(S3-1): TanStack v8.21.3 `getCanSort()` は `!!accessorFn` を要求(spec D-1「accessorFn 不要」前提が誤り)→ title/sort_key/tags に accessorFn 追加。sort 比較は sortingFn が row.original を読むため accessor 値は sort に不使用・副作用なし(global filter 未設定・S4 filterFn 素地として inert 正)。

## 設計判断の着地

- **問題文ソート撤去**: question 列 enableSorting 除去 + sortingFn 撤去。**初期連番順(liveData の sortLikeServer pre-sort + 初期 sorting=[])は別レイヤーで不変**(whole-branch で :280 pre-sort 未変更を確認、clear-sort→連番順 復帰を test 固定)。
- **sort_key ソート**: sortLikeServer(文字列 lexicographic = server ORDER BY 準拠・数値比較にしない)。NULLS は昇順末尾 / 降順先頭(TanStack desc 反転による継承挙動・意図として test 固定)。
- **タグ代表値**: 先頭タグ(`sortByKeyThenCreated` = category sort_key→option sort_key→created_at の最小 = TagCell と同 comparator を import 共有)の `{カテゴリ名}: {option名}` を localeCompare('ja')。タグ無し末尾(sortUndefined:'last')、同値 tiebreak = stable sort + pre-sort 連番順。
- **tags header 改修 = H-1 で着地**: tags 専用 header 分岐を撤去し canSort/ColumnHeaderMenu へ統合、既存タグフィルタを filterEditor に(nested Radix Popover = DismissableLayerBranch)。jsdom で破綻せず H-2 escalation 不要。sort(getValue 代表値)と filter(row.original.tags)は機構的に独立。

## whole-branch review(opus・2737323..HEAD)

✅ ready to merge / Critical 0 / Important 0 / Minor(コメント/test hygiene のみ・全 defer)。cross-task 7 点(問題文撤去×初期連番順 / H-1×他 canSort 列 / H-1 nested popover×collapse / accessorFn×filter・visibility / tag sort×filter 共存 / chip 生成 / S1/S2/S2b 回帰)全 OK。

## Minor 記録(全 defer・コメント/test hygiene)

- exam-card-table.tsx:608 stale 列挙コメント(canSort 列の列挙が S3 後の実態とズレ・logic は正)
- filter-editors.tsx:191 stale「tags は sort 不可ゆえ glyph なし」(sortable 化で第一節が偽・glyph は outer ColumnHeaderMenu 所有ゆえ挙動は正)
- columns.tsx:157「S3-1 D-3 前段」コメントの D-3 参照が tags 節を指し紛らわしい
- exam-card-table.test の sort_key ヘッダ assertion が exact→substring(glyph 付与に伴う適正緩和・非 vacuous)
- sorting case8(d) が getSortedRowModel invariant レベル(UI clear は condition-bar test が別途 e2e 補完)

## gate

- whole-repo `pnpm typecheck` exit 0 / `pnpm lint --max-warnings=0` exit 0。
- full-dir vitest: S3-2 時点で 2674 pass。

## 残(OT / 次アクション)

- push は OT。push 後、stg smoke(① タイトル昇降 ② ソートキー昇降=連番 ③ 問題文にソート出ない ④ タグ昇降=先頭チップ文字順・タグ無し末尾 ⑤ タグ列で sort menu + 既存フィルタ両立=**H-1 nested popover の外クリック/Esc/フォーカス・dot 2 箇所・TagsEditor 幅を重点確認** ⑥ 既存ソート併用 ⑦ 条件バー chip)を OT 指示で別 kickoff。
- follow-up 候補(別 task 起票): 上記コメント Minor 4 件の一括 cleanup(comment-only = [no-review] chore 可)。
