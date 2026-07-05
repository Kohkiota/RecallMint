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

---

## stg smoke 結果(OT push 後・deploy f5c1a46 反映確認済・全7項目 PASS)

環境: stg.recallmint.nekotest.net / PERF-SEED 300-card exam / Playwright MCP / desktop 1280×900。証拠 = `docs/superpowers/sessions/assets/s3-*.png`。
deploy 反映確認: 問題文にソートメニュー無し + タイトル/タグにメニュー有り(sortable)= S3 live 確定。

### ① タイトル昇降 = PASS
昇順 → PERF-SEED カード 0001,0002,0003…(localeCompare 順)。降順 flip → 0300,0299… 反転。sort chip「タイトル ↑/↓×」。

### ② ソートキー昇降(連番順)= PASS
sort_key 列は既定非表示 → 列トグルで表示。昇順 → 0001,0002,0003… 連番。降順 → 0300,0299,0298… 反転。sort chip「ソートキー ↑/↓×」。
※ null 位置(昇順末尾/降順先頭)は seed 全 300 件が sort_key 保有ゆえ実機観測不可 — unit test(sorting case6/e)で pin 済。

### ③ 問題文ソート撤去 = PASS
問題文列ヘッダに「の列メニュー」ボタン無し = ソート(昇順/降順)が出ない。撤去確認。初期連番順は pre-sort レイヤーで不変(clear で連番復帰)。

### ④ タグ昇降(先頭チップ代表値)= PASS
昇順 → 先頭 8 行すべて先頭チップ「難易度: 易」でグルーピング(代表値 = セル先頭チップの カテゴリ名: option名)。最下部 idx 294–299 は全てタグ無し(「+」)= タグ無しカード末尾(sortUndefined:'last')。同値は連番順維持(tiebreak 安定)。sort chip「タグ ↑/↓×」。

### ⑤ タグ列 H-1(最重点・nested popover)= PASS(破綻なし・H-2 不要)
- メニュー内に 昇順/降順(ソート)+「タグで絞り込み」(フィルタ trigger)両立。
- フィルタ trigger click → 内側 CardTagAddPopover が開く(dialog 2 個 = nested 成立・クリップなし)。難易度→易 選択で **値反映**(先頭行すべて 難易度: 易 に絞込 + dot 点灯・メニューは開いたまま=複数選択可)。
- **Esc = 段階閉鎖**(1回目は内側 cmdk が消費、2回目で内側 popover 閉+フォーカスが「タグで絞り込み」trigger へ復帰、3回目で外側 menu 閉)。破綻(両方同時閉/親だけ残る)なし。
- **外クリック(選択肢ヘッダ)= 両 popover クリーン閉鎖**。
- メニュー閉じてもフィルタ dot 保持(フィルタ値継続)。
- dot: メニュー開放中は trigger + TagsEditor 内の2箇所(CC 既知)、閉時は trigger の1つのみ = 意図どおり cosmetic。TagsEditor 幅は portal ゆえ非制約・崩れなし。

### ⑥ 既存ソートと併用(multi-sort)= PASS
タイトル昇順 + 連続正解数 降順 + 既存タグフィルタ(難易度:易)を同時適用 → sort chip 2 個(配列順: タイトル→連続正解数)+ filter chip。連続正解数 chip の × で除去 → タイトルのみ残存(flip/× 動作)。

### ⑦ 条件バー2ゾーン(S2b 回帰)= PASS
[タイトル↑× 連続正解数↓×](左ソートゾーン)｜ zone-separator ｜[難易度: 易×](右フィルタゾーン・個別色付き chip)+ クリア。2 ゾーン分離・区切り・クリア・タグ個別 chip 色付き すべて維持。

### console
S3 関連エラー 0(唯一の /sign-out 404 は前セッション残留・S3 無関係)。

### 総括
全 7 項目 PASS。Critical/Important な回帰・破壊なし。最重点の H-1 nested popover は開閉(Esc 段階/外クリック)・値反映・フォーカス復帰・クリップなし・フィルタ保持すべて健全で、**実機でも破綻せず H-2 切替不要**を確認。テスト状態は復元(条件クリア + sort_key 列を既定非表示へ戻す)。
