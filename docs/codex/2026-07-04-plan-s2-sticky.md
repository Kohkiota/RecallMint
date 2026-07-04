# Codex plan cross-check — s2-sticky (2026-07-04)

- **作成日**: 2026-07-04
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **scroll 座標系の切替が最大リスク**
  - `useWindowVirtualizer` から element virtualizer へ移るため、`scrollMargin` / spacer / padding の基準が document 座標から container 座標へ変わる。
  - 現 `listOffset = getBoundingClientRect().top + scrollY` は廃止または完全再定義が必要。
  - `thead` を sticky にする場合、仮想 row の開始位置と header 高の関係を明確にする必要がある。`scrollMargin = 0` でよいのか、thead 高を入れるのかは DOM 構造次第。

- **bounded height の決定責任**
  - 固定 px 禁止なので `dvh` / `calc` / flex で決める必要がある。
  - ただし app header、view 切替、条件バー、余白、bottom action bar、mobile viewport を含めた実効高さをどう保証するかが設計論点。
  - `min-h-0` / `flex-1` の入れ忘れで container が縮まず、結局 document scroll に戻るリスクがある。

- **2 段 sticky の定義**
  - 要件上の「2 段」は「ページ上部ナビ + table thead」。
  - 条件バーは container 外・上・常時表示とされているが、これは sticky ではなく layout 上常時見える設計になる可能性がある。
  - ページ全体がスクロールした場合、条件バーが本当に常時表示されるのか、bounded table 領域が viewport 内に固定されるだけなのかを明確にする必要がある。

- **app-header sticky 化の全体影響**
  - `app-header.tsx` は共有 UI の可能性があるため、exam table 以外の `/app` ページにも sticky header が波及する。
  - 調査では「app-header は非固定」とあるが、S2 要件では固定化対象。これは exam-card-table 単体想定より広い変更になる。
  - z-index、背景、既存 layout の top offset、anchor scroll、focus scroll への影響も見る必要がある。

- **横スクロールと縦スクロールの同居**
  - table container を `overflow-auto` にすると横・縦とも同じ container になる。
  - 条件バーを container 外に置く場合、条件バーや列ボタンは横スクロールに追従しない。これは望ましい一方、table 幅が広いと header/body だけ横移動する UX になる。
  - sticky thead は同じ scroll container 内なら横スクロールには追従するが、実装構造によっては header と body の横位置ずれが起きうる。

- **thead sticky と table layout の相性**
  - `position: sticky` を `thead` に付けるか、`th` に付けるかはブラウザ差・table layout 差の確認が必要。
  - `border-separate border-spacing-0`、virtual spacer rows、measured rows の組み合わせで header border や row overlap が崩れる可能性がある。
  - 全 `th` に不透明背景は必須。select 列も対象。

- **virtualizer の計測安定性**
  - `measureElement` 継続時、container scroll への切替後に再測定タイミングが変わる可能性がある。
  - resize 中の memo 凍結、column resize、row height 変動、条件変更で item count が変わる時の scroll position 補正が必要。
  - 300+ 件だけでなく、0件・1件・少数件・フィルタで件数が減るケースも確認対象。

- **条件バー外出し後の責務**
  - S1 の ResizeObserver は list offset 補正が目的だったため、そのまま残すと誤った責務になる。
  - 外出し後は JS で高さを測るのか、flex に任せるのかを決める必要がある。
  - 条件 chip の折り返しで table container 高が減る場合、mobile で操作可能な最小高さをどう守るかが論点。

- **列ボタン移設と state ownership**
  - 現状 `columnVisibility` が table 所有で、`exam-detail-view` も `examViewPrefs.hiddenColumns` を書く split-brain。
  - 移設により親 controlled 化するなら、永続化の単一所有、初期化順、view 切替時の保持、reload 復元が重要。
  - ColumnDef から列メタを導出する場合、header が string でない列、hideable false、select 列、将来追加列の扱いを明示する必要がある。

- **カード view との境界**
  - 列ボタンを view 切替の並びに移す場合、card view 中に表示するか非表示にするかが UX / 実装上の判断点。
  - 非表示にすると view 切替直後の table 設定変更導線が変わる。表示すると card view に関係ない操作に見える。

- **ヘッダーセル全体 trigger 化**
  - th 全体クリックと sort 操作、filter menu、resize handle、checkbox select-all のイベント境界が重要。
  - 「menu なし列は現状維持」とすると、全 th が同じ操作感にはならない。
  - pointer area 拡張により、sort glyph や filter dot のクリック意味が変わる可能性がある。

- **accessibility / keyboard**
  - th 全体 trigger 化で button nesting、aria-label、focus ring、keyboard activation、screen reader 名称を再確認する必要がある。
  - resize handle が pointer-only のままでも、既存より悪化しないかは見るべき。
  - sticky header による focus scroll / tab order の体感も確認対象。

- **z-index 階層**
  - pin は現状ないため角セル問題は scope 外。
  - ただし app header、thead、popover/menu、dropdown、fixed bottom action bar、possibly sticky condition area の z-index 衝突は別問題。
  - Popover が sticky/overflow container にクリップされるかどうかも重要。portal されているか確認が必要。

- **nested scroll UX**
  - document scroll から table 内 scroll に変わるため、wheel/touchpad/touch のスクロール連鎖が変わる。
  - mobile の慣性スクロール、overscroll、bottom action bar との干渉、横スクロールとの競合は実機 smoke が必要。
  - 外側 page に余白が残る場合、どこをスクロールしているのか分かりづらくなる可能性がある。

- **テスト設計**
  - 構造 test だけでは sticky/overflow/virtual scroll の実挙動を保証しにくい。
  - Playwright などで実 scrollTop、thead bounding rect、container scrollHeight/clientHeight、visible rows、menu clipping を見る必要がある。
  - unit test では `ResizeObserver` / `getBoundingClientRect` / virtualizer の mock 前提が変わる。

## plan ドラフトへの抜け・未考慮指摘

- **「条件バー常時表示」の意味が曖昧**
  - plan は A-out + flex sibling としているが、条件バー自体を viewport sticky にするとは書いていない。
  - page 上部が scroll した場合にも条件バーが常時見えるのか、table 領域が viewport 内に収まるため結果的に見えるのかを明文化した方がよい。

- **`thead` sticky の実装単位が未検証**
  - plan は `<thead>` に `sticky top-0` としているが、table sticky は `thead` より各 `th` sticky の方が安定するケースがある。
  - どちらを採用し、Playwright でどの browser を確認するかが不足。

- **Popover clipping / portal の確認が薄い**
  - th 全体 trigger 化、bounded `overflow-auto`、sticky header の組み合わせで menu が container にクリップされる可能性がある。
  - `ColumnHeaderMenu` / `CardTagAddPopover` が portal されるか、z-index が header/container を越えるかの確認項目が必要。

- **sort 操作とのイベント整理が不足**
  - 要件では「ヘッダーセル全体をメニュートリガー化」だが、現状 canSort 列に `cursor-pointer` がある。
  - クリックで sort していた列があるなら、menu trigger 化と競合する。sort は menu 内だけなのか、既存直接 sort を残すのかを明示すべき。

- **select 列 / menu なし列の扱いがやや曖昧**
  - S2-6 で menu なし列は現状維持とあるが、select-all th は全体 trigger 対象外のはず。
  - 「全 th 背景」と「全 th click menu」の対象が混ざらないよう、対象列リストを固定した方がよい。

- **column meta 導出の失敗ケースが未定義**
  - `ColumnDef` の `header` が string でない場合、label をどう決めるか。
  - accessor/id 未設定列、group column、display column、`enableHiding === false` の扱いを plan に入れるべき。
  - 将来 S3/S4 の登録追加で列が増えた時に壊れないことも明示した方がよい。

- **app-header sticky の全ページ波及が軽く扱われている**
  - plan は file 範囲に `app-header.tsx` を含めているが、共有 header 変更としての回帰確認が不足。
  - exam detail 以外の `/app` ページで二重 top spacing、z-index、layout shift が起きないか確認項目が必要。

- **bounded height の α が不確定**
  - plan は `h-[calc(100dvh - α)]` としているが、α をどう算出・どこに持たせるかが未定義。
  - flex 優先なら、どの親を `flex flex-col min-h-0` にするのかが重要。`exam-detail-view` だけで足りるか、さらに上位 layout が必要かを確認すべき。

- **0件・少数件・フィルタ後件数減少の virtualizer 確認が不足**
  - 300-card smoke はあるが、empty state / few rows / filter shrink 時の spacer と bounded height の確認が明示されていない。

- **scroll position reset / preservation の仕様がない**
  - filter 条件変更、sort 変更、view 切替、column visibility 変更時に container scrollTop を維持するのか先頭へ戻すのか未定義。
  - window scroll 時代と体感が変わる可能性がある。

- **mobile touch の横縦スクロール競合が不足**
  - mobile smoke はあるが、横に広い table で縦 scroll と横 scroll が同じ container にある点の確認が明示されていない。

- **test gate が重すぎる可能性**
  - 各 task ごとに whole-repo lint/typecheck と複数 reviewを要求している。品質面では強いが、S2-1 のような class 追加にも重い。
  - 実行時間・レビュー待ちで小変更のフィードバックが遅くなるリスクがある。

- **Task 順序に状態移動リスクが残る**
  - S2-5 の columnVisibility lift は bounded/sticky とは独立に見える。
  - ただし列ボタンの配置は上部 layout に影響するため、S2-2/S2-4 の高さ設計後に入れると再調整が出る可能性がある。

## リスク / 対立しうる設計判断

- **bounded container vs document scroll**
  - bounded container は sticky header と virtualizer の整合性が高い。
  - 一方で nested scroll UX、mobile 操作性、外側 page とのスクロール連鎖が悪化しうる。

- **条件バー外出し vs container 内 sticky**
  - 外出しは実装が単純で header top 連動が不要。
  - ただし「常時表示」の期待が viewport sticky まで含むなら、外出しだけでは不足する可能性がある。

- **flex height vs JS measured height**
  - flex は単純で ResizeObserver 不要になりやすい。
  - ただし上位 layout が flex/min-h-0 に対応していないと、意図通り縮まない。JS 測定の方が制御は明示的だが複雑。

- **`thead` sticky vs `th` sticky**
  - `thead` sticky は実装が簡潔。
  - `th` sticky はブラウザ/table layout 的に安定する可能性があるが、全セルへの class 付与や z-index 管理が増える。

- **header 全体 menu trigger vs 既存 sort direct action**
  - 全体 trigger は操作対象が広くなり Notion 風になる。
  - 既存の「クリックで sort」挙動がある場合、直接性を失うかイベント衝突が起きる。

- **columnVisibility 親集約 vs table 内閉包**
  - 親集約は split-brain を解消し、移設 UI と整合する。
  - ただし table instance 由来の column API を使えなくなるため、列メタ導出の正確性が新たな責務になる。

- **app-header 共有 sticky 化 vs exam detail 局所対応**
  - 共有 header sticky は要件の「上段 sticky」として自然。
  - ただし他画面への影響がある。exam detail だけで wrapper sticky を作る案より scope が広い。

- **厳格 gate vs 実装速度**
  - review/lint/typecheck/smoke を厚くするのは virtualizer 差替には妥当。
  - ただし全 task 一律に重くすると、単純な UI 移設や class 変更まで進行コストが大きい。