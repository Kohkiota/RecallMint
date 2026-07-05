# Notion 式テーブル S3 — 新規ソート3種 + 問題文ソート撤去 design(spec / 凍結対象)

- 作成: 2026-07-05 / branch: develop / 起点 HEAD: 8976b61(S2b + scrollbar-offset fix 後)
- fact-finding は完了済(本 spec §2 に反映)。行番号は 2026-07-05 時点の実コード照合。
- タグ代表値の設計論点は OT 判断済(§4 D-3 = 案 c 確定)。

## 1. 目的 / 背景

S1 で capability-driven ヘッダーメニュー + generic 条件バー + registry を確立し、S2/S2b で app-shell・collapse・条件バー2ゾーンを載せた。S3 は **ソート種類を registry に3つ追加登録**(タイトル / ソートキー / タグ)する。新 UI 基盤は作らない = 既存 menu / condition-bar / sorting state への追加。あわせて fact-finding で判明した **問題文列の label/挙動不一致**(表示 question_text・ソート sort_key)を解消するため、問題文ソートを撤去し「連番順」の役割を新設ソートキー列へ正式移管する。

## 2. 現状の実コード事実(fact-finding・現 HEAD 照合済)

- ソート定義 = `exam-card-table-columns.tsx` の各 ColumnDef の `enableSorting` + `sortingFn`/`accessorFn`/`sortUndefined`。
  - `question`(:112-130): `accessorFn = card.question_text`・`enableSorting: true`・`sortingFn = (a,b)=>sortLikeServer(a.card,b.card)` = **表示は問題文だがソートは sort_key 連番順**(Grid-2 T2: # 列削除の代替)。← 撤去対象。
  - `title`(:83-96): `enableSorting: false`・accessorFn なし(cell = InlineTextField)。
  - `sort_key`(:97-110): `enableSorting: false`・accessorFn なし。
  - `tags`(:143-165): `enableSorting: false`・`filterFn = tagsFilterFn`。header は専用分岐(下記)。
  - 既存 sortable: `lastCorrect`(sortUndefined:'last')/`currentStreak`(数値 auto)/`lastReview`(sortingFn:'text' + sortUndefined:'last')。
- menu 出し分け(`exam-card-table.tsx` header 描画): `if (canSort)` → `ColumnHeaderMenu`(昇順/降順 + filterEditor)を **最初に**評価。その後 `if (h.column.id === 'tags')` → `cardTableFilterEditors.tags`(CardTagAddPopover 直起動 = タグフィルタ trigger、nested popover 回避で ColumnHeaderMenu を通さない)。→ **tags を canSort 化すると canSort 分岐が先に当たり、タグフィルタ trigger が消える競合**。
- `ColumnHeaderMenu`(header-menu.tsx): `canSort && 昇順/降順` を出し、`filterEditor` prop が渡れば sort 節の下に render(lastCorrect/currentStreak で使用実績あり)。tags フィルタ(CardTagAddPopover)を filterEditor として載せられるかは §4 D-3b で確定。
- 初期連番順 = `exam-card-table.tsx` の `sorting` 初期 `[]` + `liveData` が `sortLikeServer` で **pre-sort**(:234-237 相当)。**これがデータレイヤーの初期連番順**であり、問題文列の sortingFn とは別物。
- 条件バー sort chip = `condition-chip-sort-{columnId}`・label は `columnDef.header`(string)由来(S2b でプレフィックス無し `{列名} ↑/↓`)。新 3 列 header は `'タイトル'/'ソートキー'/'タグ'`(全 string)→ chip label OK、testid `sort-title / sort-sort_key / sort-tags` は既存(question/lastCorrect/currentStreak/lastReview)と衝突なし。
- タグ join = `CardWithTags.tags: Array<{category, option}>`(join 順・未ソート)。表示順は TagCell が `sortByKeyThenCreated`(category sort_key ASC NULLS LAST → option sort_key ASC NULLS LAST → created_at ASC)で並べ替え。各ラベル = `{category.name}: {option.name}`。card/category/option の `sort_key` は数値文字列(順序 index・NULLS LAST)。
- 既存 test: `exam-card-table-sorting.test.tsx` に「tags/select は getCanSort()===false」を固定する case(:167-199)。S3-2 で tags sortable 化ゆえ更新対象。問題文ソートの専用 test は未確認(harness ベース)→ 実装時に grep で確認し撤去に追随。

## 3. スコープ(確定)

### (S3-1)タイトル / ソートキー ソート追加 + 問題文ソート撤去
- **タイトル**: `card.title`(非 null string)を `localeCompare('ja')` 昇降。
- **ソートキー**: `card.sort_key`(数値文字列・NULLS LAST)= 連番順。既存 `sortLikeServer` 相当の順序を sort_key 列 sortingFn で担う。
- **問題文ソート撤去**: `question` 列の `enableSorting` を外す(sortLikeServer sortingFn 経路も撤去)。menu の sort 経路から外れ、ユーザーは問題文ソートを選べなくなる。**初期連番順(データ pre-sort)は不変**(別レイヤー・§6 で厳守明記)。問題文の絞り込みは S4 担当ゆえ S3 では触らない。

### (S3-2)タグ ソート追加(header 改修込み)
- **代表値 = 先頭タグの「カテゴリ名: option名」フルラベル**を `localeCompare('ja')` 比較。
- tags 列 header を「ソートメニュー + 既存タグフィルタ trigger」両立へ改修。

### スコープ外(S4)
- 問題文/タイトル/ソートキー/解説/メモ の**テキストフィルタ** = S4。S3 は sort のみ。

## 4. 設計判断(確定)

### D-1. title ソート
`title` 列に `enableSorting: true` + `sortingFn: (a,b) => a.original.card.title.localeCompare(b.original.card.title, 'ja')`。title は非 null ゆえ sortUndefined 不要。accessorFn は追加しない(sortingFn が row.original から直接読む。既存 lastReview 等の sortingFn 参照と同流儀)。

### D-2. sort_key ソート
`sort_key` 列に `enableSorting: true` + `sortingFn: (a,b) => sortLikeServer(a.original.card, b.original.card)`。sortLikeServer が sort_key 辞書順 ASC NULLS LAST + created_at tiebreak を担う(問題文列が現在使っている関数を sort_key 列へ移す形)。NULLS LAST は sortLikeServer 内蔵ゆえ sortUndefined 指定は不要(direction 反転時の挙動は sortLikeServer の定義に従う = 既存問題文ソートと同一挙動を継承)。

### D-3. tags ソート(代表値 = 案 c 確定)
- **代表値導出**(純関数・新規 `_lib` へ切り出し = unit test 容易): card の tags を `sortByKeyThenCreated`(category→option)で並べ、**先頭要素**の `{category.name}: {option.name}` を返す。tags 空 → 代表値なし(末尾扱い)。
  ```
  tagSortKey(tags): string | undefined
    if tags.length === 0 return undefined
    first = [...tags].sort((a,b)=> sortByKeyThenCreated(a.category,b.category) || sortByKeyThenCreated(a.option,b.option))[0]
    return `${first.category.name}: ${first.option.name}`
  ```
- **sortingFn**: `tagSortKey` で両 row の代表値を出し、両 undefined→0、片側 undefined は `sortUndefined: 'last'` に委譲(sortingFn は string 同士のみ localeCompare し、undefined は sortingFn へ来る前に TanStack が末尾へ寄せる)。実装は accessorFn で代表値(string|undefined)を返し `sortingFn` は文字列 localeCompare + `sortUndefined: 'last'`、が最も既存流儀(lastReview/ lastCorrect)に近い。**採用: accessorFn = tagSortKey、sortingFn = (a,b)=>String(a).localeCompare(String(b),'ja')、sortUndefined: 'last'**。
  - accessorFn が undefined を返す行を TanStack が sortUndefined:'last' で末尾固定(既存 lastCorrect/lastReview と同一機構)= **タグ無しカード末尾**。
  - 同値 tiebreak: TanStack sort は stable。代表値同値の 2 行は pre-sort(sortLikeServer 連番順)の相対順が保たれる = **連番順フォールバックで安定**(明示 tiebreak コードは足さない — stable sort + pre-sort で満たす。§7 test で固定)。
  - `localeCompare('ja')` でかな/漢字混在の照合。
- **先頭タグの定義を spec 明示**(ブレ防止): 「表示順 = `sortByKeyThenCreated` の最小 = セルで最初に見えるチップ」。TagCell の表示順と同一 comparator を使う(import 共有)。

### D-3b. tags header 改修(competency 競合の解消)
現 header 描画の分岐順(`canSort` が先)により、tags を canSort 化すると tags 専用フィルタ trigger が消える。解消方針(**推奨: 案 H-1**):
- **案 H-1(推奨)**: tags 列を `ColumnHeaderMenu` 経由にし、`filterEditor` prop に既存タグフィルタ(`cardTableFilterEditors.tags` = CardTagAddPopover ベース editor)を渡す。header 描画の tags 専用分岐を撤去し canSort 分岐へ合流。ColumnHeaderMenu は lastCorrect/currentStreak で既に「sort + filterEditor(Popover 内 Popover)」の実績があるため、tags フィルタも同枠に載る想定。**リスク**: tags フィルタは CardTagAddPopover(それ自体 Popover)ゆえ ColumnHeaderMenu(Popover)内に nested popover になる(S1-3 が「nested popover 回避」で直起動にした経緯)。nested popover が破綻する場合は案 H-2 へ。
- **案 H-2(fallback)**: tags header を「ソート glyph/menu と フィルタ trigger を横並び」に自前構成(ColumnHeaderMenu を使わず、sort は小さな昇順/降順トグル、filter は現行 CardTagAddPopover 直起動を維持)。競合を構造的に回避するが独自 UI が増える。
- **実装 task(S3-2)で H-1 を試作し、nested popover の実挙動(開閉・クリップ・フォーカス)が破綻するなら H-2 へ切替**。破綻の判定と切替が出たら OT へ選択肢 + 推奨を上げる(§停止条件)。canSort 分岐順の副作用(他列への影響)を出さないこと。

### D-4. capability 追加の載り方
title/sort_key は `enableSorting: true` で ColumnHeaderMenu に自動的に昇順/降順が出る(canSort 駆動)。追加配線不要。tags のみ D-3b の header 改修が要る。条件バー chip は generic 経路が sorting state から自動生成(追加不要)。

## 5. アーキテクチャ(確定)

- 変更 file: `exam-card-table-columns.tsx`(title/sort_key/tags の enableSorting/sortingFn/accessorFn、question の sort 撤去)+ tags 代表値純関数(新規 `_lib/tag-sort-key.ts` 想定)+ `exam-card-table.tsx`(tags header 改修 D-3b)+ 対応 test。
- 純関数分離: `tagSortKey(tags)` を `_lib` に置き node test(fake-indexeddb 不要)。`sortByKeyThenCreated`(既存 `lib/tags/sort-comparator`)を import 共有(表示順と同一保証)。
- predicate 層(card-filter-predicates)・条件バー・collapse・列可視は不変。

## 6. Global Constraints(実装厳守)

- **問題文ソート撤去 ≠ 初期連番順撤去**: データ pre-sort(`sortLikeServer` による liveData 整列)は不変。問題文列 sortingFn 撤去は「メニューから問題文ソートを選べなくする」だけ。両者を混同しない。
- predicate 層 filterFn 不変。S1 registry の generic 経路・S2b 条件バー2ゾーン・collapse・列可視・scroll 保持を壊さない。
- sort chip testid = `condition-chip-sort-{title,sort_key,tags}`(衝突なし)。既存 sort/filter chip 挙動(flip/×/クリア)不変。
- tags header 改修は tags 列に閉じる。他列(canSort 分岐)の挙動を変えない。既存タグフィルタ(TagFilterValue・matchesTagFilter・undefined 解除)を壊さない。
- 回帰範囲 = exam 詳細内。共通 layout / card-view / inline 編集 / side peek 非波及。
- 固定 px 禁止・YAGNI・既存パターン踏襲・scope 外リファクタ禁止。`--no-verify` 禁止・push は OT。

## 7. 検証方針(概要・詳細は plan)

- 各 task = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical + Codex 両者 Crit/Imp 0 → controller `[reviewed]` commit。
- S3-1 unit: title 昇降(localeCompare・かな/漢字)/ sort_key 昇降(連番・NULLS LAST)/ **問題文列 getCanSort()===false**(撤去固定・既存 sorting test を反転更新)/ 初期連番順(pre-sort)が撤去後も保たれることを別 assertion で固定。
- S3-2 unit: `tagSortKey` 純関数(空→undefined / 先頭チップ選択が sortByKeyThenCreated 最小 / 複数カテゴリ)/ tags 列 getCanSort()===true(旧 false test 反転)/ 代表値 localeCompare 昇降 / タグ無し末尾 / 同値 tiebreak = 連番順 / tags フィルタが header 改修後も機能(getIsFiltered・dot・TagFilterValue 操作不変)。
- jsdom 不能領域(header popover 実開閉・nested popover クリップ・ソート体感)は stg smoke。
- 完了 gate: 全 task commit 後 whole-branch review(opus)+ whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` exit 0。
- **stg smoke(OT push 後・CC 裁量)**: ① タイトル昇降 ② ソートキー昇降(連番順)③ **問題文列にソートメニューの昇順/降順が出ない**(撤去確認)④ タグ昇降(先頭チップ文字順・タグ無し末尾)⑤ タグ列でソート menu と既存タグフィルタが両立(H-1/H-2 どちらでも filter 動作維持)⑥ 既存ソート(直近正誤/連続正解/最終回答)と併用 ⑦ 条件バー chip 表示・flip・×・クリア。300-card 実挙動。証拠添付。

## 8. リスク

- **R1(主)**: tags header 改修(D-3b)の nested popover(ColumnHeaderMenu 内 CardTagAddPopover)が開閉/クリップ/フォーカスで破綻。→ S3-2 で H-1 試作 → 破綻なら H-2 へ、判定と切替時に OT へ上げる。
- **R2**: 問題文ソート撤去で初期連番順を巻き込み破壊(混同)。→ pre-sort 不変を test で固定(§7)。
- **R3**: 代表値の先頭タグ定義が TagCell 表示順とズレる。→ `sortByKeyThenCreated` を import 共有し同一 comparator を保証。
- **R4**: localeCompare のコスト(300-card × ソート毎)。→ 代表値は accessorFn で導出(TanStack がキャッシュ)、localeCompare は比較時のみ。Grid-1 で join O(K*(N+M)) が 300 件で非支配項と確認済ゆえ懸念小。stg 実挙動で締める。

## 9. スコープ外の記録(S4 論点)

- テキストフィルタ(問題文/タイトル/ソートキー/解説/メモ)= S4。「含む」のみ(完全一致トグルなし)を S1 記録どおり S4 で。問題文の絞り込みは S4 で問題文列に filterFn を追加する形。
