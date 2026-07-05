# Notion 式テーブル S3 — 新規ソート3種 + 問題文ソート撤去 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(RecallMint 規律に適応 = review-before-commit)。

**Goal:** タイトル / ソートキー / タグ の3ソートを S1 capability-driven menu + registry に追加し、fact-finding で判明した問題文列の label/挙動不一致を解消するため問題文ソートを撤去(連番順役割は sort_key 列へ移管)。

**Architecture:** spec `docs/superpowers/specs/2026-07-05-notion-table-s3-sorts-design.md`(commit fbcc712)§4 D-1〜D-4 が設計判断の正本。本 plan は task 分割と各段検証のみ。title/sort_key/問題文撤去は sortingFn/enableSorting レベルの軽い変更(S3-1)、tags は代表値純関数 + header 改修(S3-2・論点重)で分離。

**Tech Stack:** Next.js 16 / TanStack Table / Tailwind v4 / Vitest / Playwright(stg smoke)。

## Global Constraints(全 task 共通・spec §6)

- **問題文ソート撤去 ≠ 初期連番順撤去**: データ pre-sort(`sortLikeServer` による liveData 整列)は不変。問題文列 sortingFn 撤去は「メニューから問題文ソートを選べなくする」だけ。混同禁止。
- predicate 層 filterFn 不変。S1 registry の generic 経路・S2b 条件バー2ゾーン・collapse・列可視・scroll 保持を壊さない。
- sort chip testid = `condition-chip-sort-{title,sort_key,tags}`(既存と衝突なし)。既存 sort/filter chip 挙動(flip/×/クリア)不変。
- tags header 改修は tags 列に閉じる。他列(canSort 分岐)の挙動を変えない。既存タグフィルタ(TagFilterValue/matchesTagFilter/undefined 解除/dot)を壊さない。
- 回帰範囲 = exam 詳細内。共通 layout / card-view / inline 編集 / side peek 非波及。固定 px 禁止・YAGNI・既存パターン踏襲・scope 外リファクタ禁止。
- 各 task 完了 = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical review(`superpowers:requesting-code-review`・template 改変なし)+ Codex review(`scripts/ai/codex-review.sh`)両者 Critical/Important 0 → controller が `[reviewed]` commit(実装 subagent は commit しない)。review 観点に whole-repo lint 実行確認を含める。
- `git commit --no-verify` / `-n` 禁止。push は OT。

## File 構成(確定)

- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx`(S3-1: title/sort_key の enableSorting+sortingFn、question の sort 撤去 / S3-2: tags の enableSorting+accessorFn+sortingFn+sortUndefined)
- Create: `app/(app)/app/exams/[id]/_lib/tag-sort-key.ts`(S3-2: `tagSortKey` 純関数)+ `.test.ts`
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(S3-2: tags header 改修 D-3b)
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-sorting.test.tsx`(S3-1: 問題文 getCanSort false 固定 / S3-2: tags getCanSort true へ反転)
- 参照: `lib/cards/sort-like-server.ts`(sortLikeServer)/ `lib/tags/sort-comparator.ts`(sortByKeyThenCreated)は import 共有(改変しない)。

## Task 間 interface(先に凍結)

- **S3-1 produces**: `title` 列 = `enableSorting:true` + `sortingFn:(a,b)=>a.original.card.title.localeCompare(b.original.card.title,'ja')`。`sort_key` 列 = `enableSorting:true` + `sortingFn:(a,b)=>sortLikeServer(a.original.card,b.original.card)`。`question` 列 = `enableSorting` 除去 + sortingFn 撤去(accessorFn は表示用に残置可 — 表示は変えない)。
- **S3-2 produces**: `tagSortKey(tags: Array<{category,option}>): string | undefined`(空→undefined / 先頭 = sortByKeyThenCreated 最小の `{category.name}: {option.name}`)。`tags` 列 = `enableSorting:true` + `accessorFn:(row)=>tagSortKey(row.tags)` + `sortingFn:(a,b)=>String(a.getValue('tags')).localeCompare(String(b.getValue('tags')),'ja')` + `sortUndefined:'last'`(filterFn は不変で併存)。tags header は ColumnHeaderMenu 経由(H-1)へ改修し filterEditor に既存タグフィルタを渡す。

---

### Task S3-1: タイトル / ソートキー ソート追加 + 問題文ソート撤去

**目的**: `title`・`sort_key` 列を sortable 化(D-1/D-2)し、`question` 列の sort を撤去(D-3 前段)。3 変更とも ColumnDef の enableSorting/sortingFn レベル。menu への出現は canSort 駆動ゆえ追加配線不要、条件バー chip も generic 経路で自動生成。
**制約**: Global。**問題文ソート撤去で初期連番順(pre-sort)を壊さない**(別レイヤー)。title は非 null ゆえ sortUndefined 不要。sort_key は sortLikeServer に NULLS LAST 内蔵。tags 列は本 task では触らない(S3-2)。question の cell/accessorFn(表示 question_text)は不変 — sort 設定のみ撤去。
**完了条件**:
- (a) title 昇順で localeCompare('ja') 順(かな/漢字混在サンプルで昇降両方向)を harness test で固定。
- (b) sort_key 昇順で連番順 + null 末尾(NULLS LAST)、降順で反転(sortLikeServer 挙動継承)。
- (c) `question` 列 `getCanSort() === false`(撤去固定)。既存 sorting test に question sort を前提とする case があれば反転/削除、無ければ新規に false 固定 test 追加。
- (d) 初期連番順(sorting=[] + pre-sort)が撤去後も保たれること + **sort を clear すると連番順(pre-sort)へ戻る**ことを別 assertion で固定(pre-sort レイヤー不変の回帰防止・Codex 12)。
- (e) sort_key 昇順で null 末尾 / **降順で null 先頭**(sortLikeServer + TanStack desc 反転の継承挙動・spec D-2)を明示 test で固定(意図挙動として pin、"バグ"と誤修正させない)。localeCompare test は**最小サンプル**(かな1・漢字1・英数1 程度)に絞る(環境差で脆くしない・Codex 9)。
- full-dir green + typecheck/lint exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。stg smoke ①②③⑥⑦ は S3 締め。

### Task S3-2: タグ ソート追加(代表値純関数 + header 改修)

**目的**: `tagSortKey` 純関数(D-3・代表値 = 先頭タグの `{カテゴリ名}: {option名}`)を新設し、tags 列を sortable 化。tags header を ColumnHeaderMenu 経由(D-3b 案 H-1)へ改修し「ソートメニュー + 既存タグフィルタ」を両立。
**制約**: Global。代表値の先頭タグ定義は `sortByKeyThenCreated`(既存 import 共有)= TagCell 表示順と同一 comparator を厳守(記憶で別実装しない)。タグ無しカードは `sortUndefined:'last'` で末尾。同値 tiebreak は明示コードを足さず stable sort + pre-sort(連番順)で満たす。header 改修は tags 列に閉じ、canSort 分岐順の副作用を他列へ出さない。既存タグフィルタ(CardTagAddPopover・TagFilterValue・dot・undefined 解除)を壊さない。
**完了条件**:
- (a) `tagSortKey` 純関数の node test: 空 tags → undefined / 先頭選択が sortByKeyThenCreated 最小(複数カテゴリ・複数 option で先頭が category sort_key→option sort_key→created_at の最小)/ 返り値 = `{category.name}: {option.name}`。
- (b) tags 列 `getCanSort() === true`(旧 false 固定 test を反転)。代表値 localeCompare('ja') 昇降 + タグ無し末尾 + 代表値同値 2 行が pre-sort(連番)相対順維持(tiebreak 安定)を harness test で固定。
- (c) tags header 改修後も既存タグフィルタが機能: `getIsFiltered()` / dot 点灯 / TagFilterValue 設定・undefined 解除 が不変。**accessorFn 追加後も filterFn が `row.original.tags` を読んで機能する**ことを test で固定(sort と filter の独立・Codex 5)。**sortUndefined:'last' が installed TanStack version で undefined 行を末尾固定し custom sortingFn へ渡さないこと**を test + 実装 verify(Codex 4）。
- (d) 他列(canSort menu を持つ lastCorrect/currentStreak/新 title/sort_key)の header/menu が改修で壊れないこと(回帰 test 既存 green 維持で担保)。
- full-dir green + typecheck/lint exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。
- **実装上のリスク(R1)**: H-1(ColumnHeaderMenu 内 CardTagAddPopover = nested popover)の実開閉/クリップ/フォーカスが jsdom で判定困難。構造 test は H-1 で組み、**nested popover の実挙動破綻が実装中に判明したら H-2(sort トグル + filter 直起動の横並び)へ切替、判定と切替時に選択肢+推奨を OT へ上げて停止**(§停止条件)。stg smoke ④⑤ が実挙動の最終判定。

---

## S3 完了 gate(全 task commit 後・OT push 前)

- **whole-branch review(opus)**: cross-task 相互作用(sort 追加 × 問題文撤去 × tags header 改修 × 条件バー2ゾーン × collapse × 初期連番順)+ S1/S2/S2b からの回帰。Critical/Important 解消まで完了としない。carry Minor を triage。
- whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0(報告明記)。
- **stg smoke(OT push 後・stg URL・CC 裁量)**: ① タイトル昇降 ② ソートキー昇降(連番順)③ **問題文列にソート昇順/降順が出ない**(撤去確認)④ タグ昇降(先頭チップ文字順・タグ無し末尾)⑤ タグ列でソート menu と既存タグフィルタ両立(H-1/H-2 いずれでも filter 動作維持・nested popover 非破綻)⑥ 既存ソート(直近正誤/連続正解/最終回答)と併用 ⑦ 条件バー chip 表示・flip・×・クリア。300-card 実挙動 + ソート体感。証拠添付。
- Sprint 境界 = OT 判断で停止。

## 実装順序 / 停止条件

- S3-1 → S3-2 直列。S3-1(軽い registry 追加 + 撤去)を先に固め、S3-2(header 改修の論点)を分離。
- 自走継続条件は S2b と同一(canonical/Codex の未解決 Critical のみ即上げ、Important 以下は CC 吸収)。**加えて S3-2 の H-1→H-2 切替判断が出たら停止して OT へ**(仕様分岐ゆえ CC 独断で確定しない)。仕様解釈揺れ・外部設定変更要・sprint 完了でも停止。

## Minor 記録(whole-branch triage 用)

- (現時点なし。per-task review 発生分を controller が記録し S3 締めで triage)
