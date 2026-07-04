# Notion 式テーブル S2 — sticky ヘッダー design(spec / 凍結対象)

- 作成: 2026-07-04 / branch: develop / 起点 HEAD: 977c602(S1 完了 + fact-finding commit 後)
- 改訂: 2026-07-04 — plan 段 Codex cross-check + OT 判断で **D-1 を app-shell 型へ差し替え**、scroll 保持 / タイトル chrome / 精緻化7点を反映(docs のみ)。
- 土台: `docs/superpowers/sessions/2026-07-04-notion-table-s2-sticky-factfinding.md`(commit 977c602)。7 項目の調査事実・方式候補は再調査しない。
- Step 0 実コード照合済(現 HEAD)。本 spec 内の行番号は 2026-07-04 時点。

## 1. 目的 / 背景

S1 で固定バー → Notion 式「ヘッダーメニュー + 動的条件バー」へ移行済。現状テーブルは **document 縦スクロール + window virtualizer**(fact-finding §①②)で、長い試験(300+ 行)ではヘッダー(列の意味)と条件バーが画面外へ流れ、どの列・どの条件で見ているか見失う。S2 は **テーブル view を viewport 高の app-shell 化**(テーブル領域だけ内部スクロール)+ 見出し行 sticky + 付随 UI 2 点で、Notion 的な「見出し常時可視」を実現する。

## 2. スコープ(確定)

### (a) app-shell 化 + 見出し行 sticky = 本体【方式 A で確定】
テーブル view の exam 詳細領域を **viewport 高の flex 列**にし、テーブル container だけを内部スクロールさせる。テーブル見出し行 thead を container 上端に sticky する。

### (b) 「列」ボタンを上部へ移設
列表示トグル(「列」ボタン)を、カード/テーブル view 切替ボタンの並びへ移設。app-shell の上部 chrome を作り直すのと同時に行い二度手間を回避。機能(列 ON/OFF・examViewPrefs 永続)は不変。

### (c) ヘッダーセル全体をメニュートリガー化
ヘッダーのラベル部分だけでなく **th セル全体**をソート/絞り込みメニューの起動対象に拡張。resize handle(セル端ドラッグ)は従来どおり別扱い(stopPropagation 維持)。

### スコープ外(記録のみ)
- 新規ソート種類(タイトル / ソートキー / タグ)= **S3**。タグソート基準 = 文字順(「カテゴリ:タグ」表示と整合)を S3 論点として記録。
- 新規フィルタ(タイトル / ソートキー / 問題文 / 解説 / メモ)= **S4**。テキストフィルタは「含む」のみ(完全一致トグルなし)を S4 論点として記録。
- S1 registry(capability-driven メニュー + generic 条件バー)を壊さず、S3/S4 が登録追加で載る構造を維持する。

## 3. 現状の実コード事実(Step 0 裏取り)

- ナビ `app/(app)/app/_components/app-header.tsx:22` = `<header className="border-b … bg-white">` — 非固定。**本 S2(app-shell 型)では触らない**(app-shell がページを document スクロールさせない → nav は自然に残る)。
- view 切替(カード/テーブル)= `exam-detail-view.tsx:78-95`(AppContainer 内、`role="group"`)。table view は `exam-detail-view.tsx:107` `<div className="w-full px-2 md:px-4"><ExamCardTable/></div>`。exam タイトル/日付は上位 `exam/[id]/page.tsx` 側(app-shell 化で chrome に取り込む対象、実装時に現物確認)。
- 縦スクロール container = `exam-card-table.tsx:555` `<div ref={tableContainerRef} className="overflow-x-auto">`(高さ制約なし)。virtualizer = `useWindowVirtualizer`(:101、scrollMargin=listOffset=container 上端の document 座標:512-533）。
- 列可視 = **ExamCardTable 所有**: `columnVisibility` useState(:217)/ `onColumnVisibilityChange`(:371)/ mount load(:386)+ 変更時 READ-MODIFY-WRITE で examViewPrefs 永続(:401-420)。`ColumnVisibilityToggle` は `table` instance 依存。exam-detail-view も handleToggle 内で hiddenColumns を read-modify-write 保持(:58-71)= **examViewPrefs の split-brain 書込**。
- ヘッダー menu = `ColumnHeaderMenu`(header-menu.tsx:46-52)trigger は **ラベル button のみ**。menu を持つ列 = canSort(question/lastCorrect/currentStreak/lastReview)+ tags(CardTagAddPopover 直)。他列(title/sort_key/options/explanation/memo/select)は plain flexRender = menu なし。**S1-1 で th 直接 sort onClick は撤去済**(header-menu.tsx コメント)= sort は menu 経由のみ(直接クリック sort との競合は存在しない)。canSort th に `cursor-pointer`(:589)が残存(S1-1 carry Minor)。th の背景 = 指定なし(透明)、table は `border-separate border-spacing-0`。
- 回帰範囲: window virtualizer は exam-card-table.tsx のみ(fact-finding §⑤)。InlineCardList は未仮想化。

## 4. 設計判断(確定 + OT 承認済)

### D-1. layout モデル 【確定: app-shell 型(テーブル view のみ)】
- exam 詳細の**テーブル view 領域**を viewport 高の flex 列(`h-[calc(100dvh - navH)] flex flex-col`。navH は実測=固定 px 禁止・calc/dvh)にする。ページ自体は document スクロールさせない(テーブル view 時)。
- 内包順 = [タイトル/日付 + view 切替 + 列ボタン(上部 chrome, flex-none)] → [条件バー(flex-none)] → [table container `flex-1 min-h-0 overflow-auto`]。table container だけ内部スクロール。
- 結果 **nav(app-header)は何も流れないので sticky 不要**=触らない。**カード view は現状の document スクロール維持**(app-shell 化はテーブル view のみ)。
- 破棄した旧案 ii(document スクロール維持 + nav sticky + table だけ bounded): bounded table 領域自体が document と一緒に流れ「見出し常時可視」が成立しないため不採用(Codex cross-check で顕在化)。

### D-2. virtualizer 差替【確定: element virtualizer】
`useWindowVirtualizer` → `useVirtualizer({ getScrollElement: () => tableContainerRef.current, ... })`。`count/estimateSize=120/getItemKey/overscan=5/measureElement` は流用。`observeElementRect`/`observeElementOffset` は default(明示指定しない)。**scrollMargin/listOffset は再定義**: element スクロールでは container 先頭が原点 = list(tbody)の scroll 原点からの offset は実質 **thead 高**(または 0 に固定できるかを実装 task で検証)。現 listOffset(document 座標)は**廃止**。paddingTop/Bottom の `- scrollMargin` 基準も新定義に合わせる。**これが S2 の主リスク**(Fix-3 仮想化の再検証)= 独立 task + stg 300-card smoke で締める。**scroll 位置 = 保持**(filter/sort/view/列変更で container scrollTop を先頭リセットしない = window 時代の体感維持)。**件数境界(0件/1件/少数/filter で件数減)**で spacer/padding が壊れないことを検証対象に含む。

### D-3. 「列」ボタン移設 【確定: 案 P(columnVisibility を exam-detail-view へ lift)】
- columnVisibility state + 永続(examViewPrefs read-modify-write)を **exam-detail-view に集約**し、「列」ボタンを view 切替群の並びへ配置。ExamCardTable は `columnVisibility` + `onColumnVisibilityChange` を **controlled prop** で受ける。`ColumnVisibilityToggle` は列メタ(静的 ColumnDef の id / header / hideable)から列挙(live table instance 非依存)。現 split-brain(exam-detail-view と table が別々に examViewPrefs へ書く)を解消(examViewPrefs 書込経路を単一化)。
- **列メタ導出の規約**: label = header が string ならそれ / 非 string(select 等)は id fallback。hideable = `enableHiding !== false`。select 列は toggle 対象外(現状同様)。将来 S3/S4 で列が増えても ColumnDef 追加で自動的に載る(壊れない)。
- **card view 中は列ボタン非表示**(table 専用 UI)。

### D-4. 条件バー配置 【確定: A-out(app-shell 上部 chrome の flex-none)】
条件バー(ConditionBar)は app-shell の flex-none 領域(table container の外・上)に置く。flex が可変高バーの高さを吸収し container(flex-1 min-h-0)が残りを埋める = バー高変化が sticky header の top に影響しない(関心分離)。**S1 の listOffset 用 ResizeObserver は D-2 で廃止**、高さ配分は flex ネイティブに委ねる(container 高調整の JS を新設しない = YAGNI。flex で不足する場合のみ最小 JS を justify)。

### D-5. th 全体 trigger 【確定・機構】
`ColumnHeaderMenu` の PopoverTrigger を、ラベル button でなく **th 内容 span 全体(ラベル + filter dot + sort glyph)を包む trigger**へ拡張(cell 全域クリックで menu 起動)。resize handle は th 内の別 sibling で `onMouseDown/onTouchStart` に stopPropagation 維持(ドラッグ=リサイズ、クリック=menu の分離)。**S1-1 で th 直接 sort は撤去済=競合なし**。canSort th の残存 `cursor-pointer` は全域 trigger と整合(cell 全域が pointer target)。
- **対象列の固定**: menu trigger 化 = **canSort 列 + tags 列のみ**。select 列・menu なし列(title/sort_key/options/explanation/memo)は trigger 対象外(現状維持、S3/S4 で menu 追加時に自動全域化)。aria-label(`${label} の列メニュー`)維持。
- **不透明背景は別軸**: sticky のための th 背景(D-1/§5)は **全 th**(select 含む)に付与(trigger 対象列とは独立)。

## 5. アーキテクチャ(確定設計)

- **DOM 構造(table view = app-shell)**:
  ```
  [app-header]                                  ← 共有 layout・非変更(page 非スクロールで自然に残る)
  [exam 詳細 table view: h-[calc(100dvh - navH)] flex flex-col]
    [上部 chrome(flex-none): タイトル/日付(最小・truncate)+ view 切替 + 列ボタン]  ← D-3
    [条件バー ConditionBar(flex-none・full width・可変高)]                        ← D-4 A-out
    [table container(flex-1 min-h-0 overflow-auto)]                              ← D-1/D-2
       <table border-separate>
         <thead sticky top-0 z-10 + 全 th 不透明背景>                            ← D-1/D-5
         <tbody>… element virtualizer で仮想化 …</tbody>
  ]
  [選択時: 既存 action bar(app-shell 内 or 現状踏襲、実装時に干渉確認)]
  ```
- **タイトル/日付 chrome**: flex-none で常時表示・1 行 truncate + 日付は小さく(mobile 縦幅節約。圧縮幅は実装時 mobile 実機で微調整)。
- **th 背景**: 全 th に不透明背景(`bg-background` 相当)。border-separate ゆえ border-b は td/th 側で維持。
- **thead sticky**: `<thead>` に `sticky top-0` を第一候補。browser 差/table layout で崩れる場合は **per-th sticky** に fallback(実装 task で判定)。
- **Popover clipping**: bounded `overflow-auto` container + sticky header 下で ColumnHeaderMenu / CardTagAddPopover が container にクリップされないこと(Radix portal 前提)を検証(§7)。
- **列可視**: controlled(D-3)。永続は exam-detail-view に集約。

## 6. Global Constraints(実装フェーズ厳守)

- predicate 層・S1 registry(cardTableFilterEditors / deriveConditions / ConditionBar 契約 / testid `condition-chip-*`)を壊さない。S3/S4 が登録追加で載る構造を維持。
- `undefined` 解除規約・S1 の chip/menu 挙動・sort/filter 意味を不変に保つ。
- 回帰範囲 = `exam-card-table.tsx` + `exam-detail-view.tsx`(D-3 列 state lift + app-shell chrome)+ `exam-card-table-column-toggle.tsx`(D-3 列メタ列挙)+ `exam-card-table-header-menu.tsx`(D-5 trigger)。**app-header.tsx は触らない**。card-view(InlineCardList)・inline 編集・side peek 未実装領域へ波及させない。
- bounded 高さは固定 px 禁止 = viewport 追従(dvh/calc/flex、mobile 短 viewport で潰れない)。
- 簡潔性: YAGNI・既存パターン踏襲・scope 外リファクタ禁止(D-3 の split-brain 解消は「触るコードの改善」= 許容)。
- `git commit --no-verify` / `-n` 禁止。各 feat/fix commit に [reviewed]。

## 7. 検証方針(概要・詳細は plan)

- 各 task = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical + Codex 両者 Crit/Imp 0 → [reviewed] commit。
- virtualizer 差替(D-2)は独立 task。jsdom は layout 計算不可のため、仮想化の**行 window 正しさ**は既存 Fix-3 系 test の枠組み(count/測定)+ **件数境界(0/1/少数/filter 減)**+ stg 300-card 実機で締める。sticky/背景/bounded/scroll 保持は class/構造 assertion + stg 視覚/実測。
- **Popover clipping**: bounded overflow + sticky 下で menu が portal されクリップされないことを stg smoke で確認(該当段)。
- **whole-branch review(opus)**(全 task commit 後・OT push 前): cross-task 相互作用(app-shell 化 × 仮想化差替 × sticky × 条件バー flex-none × 列ボタン lift × th 全体 trigger の相互影響、旧構造からの回帰)を検出。Crit/Imp 解消まで S2 完了としない(per-task の代替でなく追加)。
- whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0。
- **stg smoke(OT push 後・CC 裁量ツール)**: ① 見出し行 sticky(app-shell 内部スクロール中も thead 固定・nav は自然に常時表示)② app-shell 二重スクロール UX(外側 page 非スクロール・container 内部スクロール)③ mobile 短 viewport の固定高・操作性 + 既存 action bar 干渉(主リスク)④ 300-card 仮想化再検証(scroll 位置・行描画 anomaly・offset 追従・**scroll 保持**・**0/1/少数/filter 減**)⑤ 列ボタン移設後の動作(ON/OFF・reload 永続・card view 非表示)⑥ th 全体クリックで menu 起動(端 resize 非干渉)+ **menu が container にクリップされない**。証拠添付。

## 8. リスク

- **R1(主)**: virtualizer 差替で scrollMargin/offset 再定義を誤ると wrong row window / スクロール位置ズレ(Fix-3 の再来)。→ 独立 task + 300-card stg + 件数境界。
- **R2**: app-shell 高さ(flex chain / calc)の誤りで mobile 短 viewport で table が潰れる / 既存 action bar と干渉。→ dvh + flex-1 min-h-0 chain を切らさない・mobile smoke 必須。
- **R3**: 列 state lift(D-3)で controlled 化の際、mount load / 永続の READ-MODIFY-WRITE を集約し損なうと hiddenColumns 消失。→ 集約先を exam-detail-view 単一にし test で往復固定。
- **R4**: Popover(ColumnHeaderMenu / CardTagAddPopover)が bounded overflow container にクリップされる。→ Radix portal 確認 + z-index + stg 実機。

## 9. スコープ外の記録(S3/S4 論点)

- S3: タグソート = 文字順(「カテゴリ:タグ」整合)。sort 種追加は S1 registry の登録で載せる。
- S4: テキストフィルタ = 「含む」のみ(完全一致トグルなし)。filter editor 追加は registry 登録で載せる。
