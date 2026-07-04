# Notion 式テーブル S2 追補(S2b)— 戻るリンク撤去 + scroll-top / 中間帯 collapse / 条件バー 2 ゾーン design(spec / 凍結対象)

- 作成: 2026-07-04 / branch: develop / 起点 HEAD: 2c60289(S2 完了 + app-header 高さ調整後)
- 仕様は OT brief で確定済。本 spec は brief 確定仕様 + fact-finding(§2、現 HEAD 実コード裏取り)+ 設計判断の記録。§8 の論点のみ OT 承認対象(推奨添付)。
- **前回仕様の撤回**: S2 の「タイトル最小 chrome・常時表示」(S2 spec §5 タイトル/日付 chrome)は **B で撤回**する。スクロール中はタイトル含む中間帯を全部畳み、ヘッダー(app-header 44px)+ thead の 2 段のみ固定(Notion 準拠)。

## 1. スコープ(確定)

- **A**: exam 詳細の「← 試験一覧」リンク削除(導線はナビ「試験」で代替)+ 画面右下固定の scroll-top ボタン(chevron-up・shadcn Button 控えめ・36px 前後・table container を先頭へスクロール)。
- **B**: table container の下スクロールで中間帯(タイトル/日付 + view 切替/列ボタン + 条件バー)を collapse。先頭付近(scrollTop≈0)で復帰。
- **C**: 条件バーを [並び替えゾーン | 区切り | フィルタゾーン + クリア] に 2 ゾーン化。sort chip の「並び替え:」プレフィックス削除。タグフィルタを選択 option 単位の個別 chip(タグ本来の色付き・個別 × で option 単位解除)へ展開。「すべてクリア」→「クリア」。
- スコープ外: 共通 app-header(別 sprint 完了済・非変更)・card view・inline 編集・side peek。

## 2. 現状の実コード事実(fact-finding・現 HEAD)

1. **app-shell 構造**: `page.tsx:38-53` = AppContainer(py-2)内に「← 試験一覧」Link(:41-48)+ `ExamDetailPullGate`(:51、`return null` = UI なし)。その下 `exam-detail-view.tsx:208-243` = table view branch: `div[data-testid=table-app-shell]`(`height: calc(100dvh - shellTop)` 実測 + `flex flex-col min-h-0`)→ [`table-chrome` flex-none(:215-231): タイトル/日付 + ColumnVisibilityToggle + viewToggle] → [flex-1 min-h-0 wrapper(:234)→ ExamCardTable]。ExamCardTable 内(`exam-card-table.tsx:472-657`)= `h-full flex flex-col min-h-0` → [ConditionBar wrapper flex-none(:476-485)] → [`tableContainerRef` container `flex-1 min-h-0 overflow-auto`(:490-493、選択時 pb-32)]。中間帯 = **table-chrome(exam-detail-view 側)+ ConditionBar wrapper(ExamCardTable 側)の 2 コンポーネント跨ぎ**。
2. **scroll 監視**: container への React `onScroll` は現状なし。virtualizer は `useVirtualizer({ getScrollElement: () => tableContainerRef.current })`(:101-108)で内部 listener を張る(passive)。React onScroll の追加は virtualizer と独立で干渉しない。**scroll 保持**(S2 spec D-2)= filter/sort/view/列変更で container scrollTop を先頭リセットしない、の意。collapse は scrollTop を書き換えない(container 高だけが変わる)ため保持と両立。shellTop 実測(exam-detail-view.tsx:135-145)は resize 時のみ再計測 = collapse は shell 高に影響しない(shell 内の配分変化のみ)。
3. **既存 fixed 要素**: 選択時 action bar = `fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4`(action-bar.tsx:76-79、**全幅・pointer-events 制御なし** = 下端帯のクリックを遮る)。billing-banner = `fixed top-4 z-50`(上端・非干渉)。右下 fixed ボタンは選択時に action bar と z/クリック競合する(§8 論点2)。
4. **ConditionBar 実装**: `deriveConditions`(condition-bar.tsx:34-49)= sorting→columnFilters を 1 条件 1 chip で連結(generic Condition[])。sort chip label「並び替え: {列名} ↑/↓」= :162。tags chip = 1 個の summary chip「タグ: N 件」(:75-80 getFilterSummary、:183-219)、chip body = CardTagAddPopover trigger、testid `condition-chip-filter-tags`(:189)。option toggle 用 `handleTagsChipToggle`(:129-138)が **option 単位の除去 + 空カテゴリ prune + 空 map → undefined を既に実装済**(C の × はこの経路を除去専用で再利用可)。「すべてクリア」= :279-285(ml-auto)。
5. **TagFilterValue** = `Record<categoryId, optionId[]>`(card-filter-predicates.ts)。predicate はカテゴリ間 AND / カテゴリ内 OR、空配列カテゴリ・空 map = 絞り込みなし。カテゴリ名/option 名/色は ConditionBar が既に受ける `editorContext.categories/options`(ClientTagCategory/ClientTagOption)で揃う。色は `colorToClass(option.color)`(`lib/tags/color-palette`、card-tag-badge.tsx:68 と同一経路)。**追加 props 不要**。
6. **文言変更範囲**: sort プレフィックスは condition-bar.tsx:162 の 1 箇所。クリア文言は :284 の 1 箇所。shadcn Button に `size="icon-lg"`(size-9 = 36px)あり、`lucide-react@^1.14`(ChevronUp)導入済 = A に新規ライブラリ不要。

## 3. A — 戻るリンク撤去 + scroll-top ボタン(設計)

- `page.tsx` の Link + AppContainer wrapper を撤去し、`<ExamDetailPullGate examId={id} />` を素で残す(null render ゆえ視覚要素ゼロ)。card/table 両 view で上部余白が縮む(意図どおりのスペース節約)。shellTop は実測ゆえ追従。
- **ScrollTopButton**: ExamCardTable 内(containerRef と scroll 状態の所有者)で render。`position: fixed` 右下(`right-4 bottom-4` 目安)、shadcn `Button variant="outline" size="icon-lg"`(36px)+ lucide `ChevronUp`、`rounded-full shadow-sm` の控えめ表現。`aria-label="先頭へスクロール"` + `data-testid="scroll-top-button"`。click で `containerRef.current.scrollTo({ top: 0, behavior: 'smooth' })`(smooth が仮想化で jank する場合 instant へ切替、stg で判定)。
- **表示条件(推奨)**: 常時表示でなく **B と同一の scroll 信号(collapsed)と連動**して表示(scrollTop≈0 では非表示)。信号を 1 本に統一し閾値の二重管理を避ける。
- **選択時 action bar との競合(推奨)**: `selectedIds.length > 0` の間はボタン非表示(bulk 操作中に scroll-top は必須でなく、全幅 z-40 バーとの z/クリック競合を構造的に回避)。

## 4. B — 中間帯 collapse(設計)

- **信号**: container の React `onScroll`(ExamCardTable)で `collapsed: boolean` を導出。rAF throttle + boolean 変化時のみ setState(scroll 毎 render を防ぐ)。virtualizer の内部 listener とは独立(§2-2)。
- **閾値 + hysteresis(推奨)**: collapse = `scrollTop > 24px` / expand = `scrollTop < 8px`(境界振動防止)。
- **短コンテンツ guard(推奨)**: collapse 条件に `scrollHeight - clientHeight - 中間帯高 ≥ expand 閾値` を加える。理由: collapse で container が中間帯高ぶん伸びると maxScroll が同量減り、scrollTop が expand 閾値未満へ clamp → 即 re-expand の一往復ちらつきが出るため(コンテンツが僅かに溢れるだけの時)。中間帯高は collapse 対象 wrapper の実測(offsetHeight)。
- **collapse 対象と伝播**: 中間帯は 2 コンポーネント跨ぎ(§2-1)。ExamCardTable が collapsed を所有し、(a) 自身の ConditionBar wrapper を collapse、(b) 新 prop `onCollapsedChange?: (collapsed: boolean) => void` で exam-detail-view に通知 → table-chrome を collapse。ref の lift や context は導入しない(最小変更)。
- **collapse 方式(推奨)**: unmount しない(ConditionBar の popover state / ResizeObserver churn 回避)。wrapper を `grid grid-rows-[1fr] → grid-rows-[0fr]` + inner `min-h-0 overflow-hidden` の CSS transition で畳む(px 指定不要・可変高対応・Notion 的スライド)。transition が問題を出す場合の fallback = 無アニメの `hidden` toggle。
- **不変条件**: thead `sticky top-0`(container 相対)は collapse と独立に成立 = collapse 中は app-header + thead の 2 段固定、行は thead 直下から連続。scrollTop は書き換えない(scroll 保持と両立)。container 高変化は virtualizer が ResizeObserver(observeElementRect default)で追従。
- **既知エッジ(smoke で確認)**: 条件バーの Popover(filter editor)が開いたまま collapse すると anchor が隠れて popover が浮く。実害があれば collapse 時に閉じる対応を検討(先回り実装しない)。

## 5. C — 条件バー 2 ゾーン + タグ個別 chip(設計)

- **ゾーン分割**: `deriveConditions` の生成契約(kind 'sort'/'filter' の generic Condition[])は不変。ConditionBar の render 側で kind により左右へ**振り分けるだけ**(sort → 左 / filter → 右)。区切り = 縦線 `<div className="h-4 w-px bg-border" />`(両ゾーン非空時のみ)。左空 or 右空なら区切りなし、両空は現行どおり null(シュリンク)。
- **sort chip**: label から「並び替え: 」を削除し `{列名} ↑/↓` のみ(:162)。flip・×・testid `condition-chip-sort-*` は不変。
- **フィルタゾーン**: 回答状態・連続正解数 chip は現状維持(無彩色・testid 不変)。
- **tags 特例(generic 投影への局所例外)**: tags フィルタのみ「タグ: N 件」summary chip を廃し、TagFilterValue の **選択 option ごとに個別 chip** を展開。
  - label = `{カテゴリ名}: {option 名}`、色 = `colorToClass(option.color)`(タグ chip のみ色付き・他 chip 無彩色)。
  - 各 chip の × = **その option だけを TagFilterValue から除去**(既存 `handleTagsChipToggle` の除去経路を再利用: 空カテゴリ prune + 空 map → `undefined` 解除 = dot も消える。既存規約準拠)。
  - chip body は現 tags chip 同様 **CardTagAddPopover trigger を維持**(selectOnly・§8 論点3)。
  - testid = `condition-chip-filter-tags-{optionId}`(option 単位ユニーク)。**S1 記録の前提更新**: S1 は「testid は columnId 一意キー・同一列複数条件は S4 で再訪」としたが、tags は本追補で option 単位複数 chip に先行移行する(S4 のテキストフィルタ複数条件とは独立の局所特例)。
  - **特例の理由と局所化**: Notion 準拠 UX(フィルタ値の構成要素を chip で直接解除)のため。特例は ConditionBar 内 `columnId === 'tags'` 分岐に閉じ、deriveConditions・predicate 層(matchesTagFilter)・他フィルタ/sort の generic 経路・registry は不変。S3/S4 の登録追加拡張性を阻害しない。
  - **欠損 fallback**: filter 値が参照する option/category が削除済で lookup 不能の場合、chip は optionId を label に無彩色で表示し × は機能させる(解除不能な幽霊条件を作らない)。
- **クリア**: 文言「すべてクリア」→「クリア」(:284)。位置(ml-auto)・全解除挙動は不変。

## 6. Global Constraints(実装フェーズ厳守)

- predicate 層(card-filter-predicates)・S1 registry(cardTableFilterEditors / deriveConditions 契約)・`undefined` 解除規約を不変に保つ。tags 特例は ConditionBar 内に局所化。
- S2 確定事項を壊さない: app-shell 密封・element virtualizer(getScrollElement)・thead sticky・**scroll 保持**(scrollTop 非リセット)・列ボタン lift(controlled columnVisibility)。
- 回帰範囲を exam 詳細内に閉じる: `page.tsx` / `exam-detail-view.tsx` / `exam-card-table.tsx` / `exam-card-table-condition-bar.tsx`(+ 対応 test)。**app-header.tsx 非変更**。card view(InlineCardList)・inline 編集・side peek へ波及させない。
- 固定 px 高さ禁止(viewport 追従)・YAGNI・既存パターン踏襲・scope 外リファクタ禁止。
- `git commit --no-verify` / `-n` 禁止。push は OT。

## 7. 検証方針(概要・詳細は plan)

- 各 task = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical + Codex review 両者 Critical/Important 0 → controller が `[reviewed]` commit。A / B / C は各段単独 smoke 可能な粒度で分離(B の collapse と C の条件バー改修は別 task)。
- jsdom は layout/scroll 計算不可のため、collapse の実挙動・sticky 連続性・smooth scroll・popover エッジは stg smoke で締める。unit は状態機械(閾値/hysteresis/guard)・構造(class/testid)・chip 展開/除去ロジックを固定。
- 完了 gate: 全 task commit 後・OT push 前に **whole-branch review(opus)**(collapse × sticky × virtualizer × 条件バー改修の相互作用)+ whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` exit 0。
- **stg smoke(OT push 後・stg URL・ツール CC 裁量)**: ① scroll-top ボタン(container 先頭へ・少スクロール時非表示)② スクロールで中間帯 collapse → app-header + thead 2 段固定・先頭で復帰・scroll 保持と非干渉 ③ 条件バー 2 ゾーン・sort プレフィックス無し・タグ個別 chip 色付き・個別 × で option 単位解除・「クリア」文言・タグ全解除で dot 消滅 ④ mobile での collapse / scroll-top / 条件バー。証拠添付。

## 8. 論点(OT 承認対象・推奨添付)

1. **A 表示条件**: 推奨 = B の collapsed 信号と連動(scrollTop≈0 で非表示)。代替 = 常時表示(実装最小だが先頭で無意味なボタンが残る)。
2. **A × 選択 action bar**: 推奨 = 選択中(selectedIds > 0)はボタン非表示。代替 = action bar 外側 div に pointer-events-none + ボタン z-50(action bar への 1 行変更が要り、狭幅で視覚重なりは残る)。
3. **C tags chip body の click**: 推奨 = 現 tags chip と同じ CardTagAddPopover trigger を維持(編集導線の連続性)。代替 = body 非インタラクティブ(× のみ)。
4. **B collapse 方式**: 推奨 = grid-rows 0fr/1fr transition(unmount なし)。fallback = 無アニメ hidden。
5. **task 順序**: 推奨 = B → A → C(A の表示条件が B の scroll 信号を消費するため。C は独立)。

## 9. リスク

- **R1**: collapse の閾値/clamp 設計を誤ると境界でちらつき(§4 hysteresis + 短コンテンツ guard で抑止、stg で実証)。
- **R2**: collapse の状態伝播(ExamCardTable → exam-detail-view)で render churn(boolean 変化時のみ setState で抑止)。
- **R3**: tags 個別 chip 化で条件バーが横に伸びる(既存 flex-wrap で折返し。collapse(B)で畳めるため常時占有はしない)。
- **R4**: smooth scrollTo と仮想化の相性(jank 時 instant へ、stg 判定)。
