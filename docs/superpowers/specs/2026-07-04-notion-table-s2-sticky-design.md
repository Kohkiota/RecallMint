# Notion 式テーブル S2 — sticky ヘッダー design(spec / 凍結対象)

- 作成: 2026-07-04 / branch: develop / 起点 HEAD: 977c602(S1 完了 + fact-finding commit 後)
- 土台: `docs/superpowers/sessions/2026-07-04-notion-table-s2-sticky-factfinding.md`(commit 977c602)。7 項目の調査事実・方式候補は再調査しない。
- Step 0 実コード照合済(現 HEAD)。本 spec 内の行番号は 2026-07-04 時点。

## 1. 目的 / 背景

S1 で固定バー → Notion 式「ヘッダーメニュー + 動的条件バー」へ移行済。現状テーブルは **document 縦スクロール + window virtualizer**(fact-finding §①②)で、長い試験(300+ 行)ではヘッダー(列の意味)と条件バーが画面外へ流れ、どの列・どの条件で見ているか見失う。S2 は **テーブル領域だけをスクロールする bounded container 化** + その上に成立する 2 段 sticky + 付随 UI 2 点で、Notion 的な「見出し常時可視」を実現する。

## 2. スコープ(確定)

### (a) 2 段 sticky = 本体【方式 A 確定】
縦スクロール主体を document → **bounded 高さ container** へ変更。ナビ(上段)+ テーブル見出し行 thead(下段)を固定する。

### (b) 「列」ボタンを上部へ移設
列表示トグル(「列」ボタン)を、カード/テーブル view 切替ボタンの並びへ移設。sticky で上部 wrapper を作り直すのと同時に行い二度手間を回避。機能(列 ON/OFF・examViewPrefs 永続)は不変。

### (c) ヘッダーセル全体をメニュートリガー化
ヘッダーのラベル部分だけでなく **th セル全体**をソート/絞り込みメニューの起動対象に拡張。resize handle(セル端ドラッグ)は従来どおり別扱い(stopPropagation 維持)。

### スコープ外(記録のみ)
- 新規ソート種類(タイトル / ソートキー / タグ)= **S3**。タグソート基準 = 文字順(「カテゴリ:タグ」表示と整合)を S3 論点として記録。
- 新規フィルタ(タイトル / ソートキー / 問題文 / 解説 / メモ)= **S4**。テキストフィルタは「含む」のみ(完全一致トグルなし)を S4 論点として記録。
- S1 registry(capability-driven メニュー + generic 条件バー)を壊さず、S3/S4 が登録追加で載る構造を維持する。

## 3. 現状の実コード事実(Step 0 裏取り)

- ナビ `app/(app)/app/_components/app-header.tsx:22` = `<header className="border-b … bg-white">` — **非固定**(sticky/fixed/top-0 なし)。共有 layout(`app/(app)/app/layout.tsx`)が全 /app ページに描画。
- view 切替(カード/テーブル)= `exam-detail-view.tsx:78-95`(AppContainer 内、`role="group"`)。table view は `exam-detail-view.tsx:107` `<div className="w-full px-2 md:px-4"><ExamCardTable/></div>`。
- 縦スクロール container = `exam-card-table.tsx:555` `<div ref={tableContainerRef} className="overflow-x-auto">`(高さ制約なし)。virtualizer = `useWindowVirtualizer`(:101、scrollMargin=listOffset=container 上端の document 座標:512-533）。
- 列可視 = **ExamCardTable 所有**: `columnVisibility` useState(:217)/ `onColumnVisibilityChange`(:371)/ mount load(:386)+ 変更時 READ-MODIFY-WRITE で examViewPrefs 永続(:401-420)。`ColumnVisibilityToggle` は `table` instance 依存(getAllLeafColumns/getIsVisible/toggleVisibility)。exam-detail-view も handleToggle 内で hiddenColumns を read-modify-write 保持(:58-71)= **examViewPrefs の split-brain 書込**。
- ヘッダー menu = `ColumnHeaderMenu`(header-menu.tsx:46-52)trigger は **ラベル button のみ**。menu を持つ列 = canSort(question/lastCorrect/currentStreak/lastReview)+ tags(CardTagAddPopover 直)。他列(title/sort_key/options/explanation/memo/select)は plain flexRender = menu なし。th の背景 = 指定なし(透明)、table は `border-separate border-spacing-0`。
- 回帰範囲: window virtualizer は exam-card-table.tsx のみ(fact-finding §⑤)。InlineCardList は未仮想化。

## 4. 設計判断(フォーク + 推奨)— OT 承認対象

### D-1. layout / nav 固定モデル 【推奨: 案 ii(document-scroll 維持 + nav sticky + bounded table container)】
- 案 i(app-shell): /app layout を `h-dvh flex-col` に変え nav = flex-none / 本文 = flex-1 min-h-0 overflow スクロール。→ **全 /app ページに波及**(blast radius 大、「exam-card-table 単体」制約に反する)。不採用。
- **案 ii(推奨)**: document スクロールを維持。`app-header` に `sticky top-0 z-40`(+ 背景不透明は既存 bg-white)を付与し nav を viewport 上端固定。ExamCardTable 内の table container を `max-h-[calc(100dvh - α)] overflow-auto` の **bounded スクロール box** にし、その中で thead を `sticky top-0` する。→ 2 段 sticky = nav(document 軸 sticky)+ thead(container 軸 sticky)。blast radius = app-header(共有・sticky 追加のみ = 付加的)+ exam-card-table。
  - トレードオフ: 二重スクロール(document 軸 + container 軸)を OT が受容する前提(fact-finding §⑦)。α(引く高さ)は nav 高 + view toggle/条件バー等の実測で決める(§5 D-4)。
  - **共有 app-header に sticky を足す点は OT 承認要**(全 /app ページが sticky nav になる。一般に望ましい挙動だが明示確認)。

### D-2. virtualizer 差替【確定: element virtualizer】
`useWindowVirtualizer` → `useVirtualizer({ getScrollElement: () => tableContainerRef.current, ... })`。`count/estimateSize=120/getItemKey/overscan=5/measureElement` は流用。`observeElementRect`/`observeElementOffset` は default で足る見込み(明示指定しない)。**scrollMargin/listOffset は再定義**: element スクロールでは container 先頭が原点。thead を container 内 sticky に置くため、list(tbody)の scroll 原点からの offset は実質 **thead 高**(または 0 に固定できるかを実装 task で検証)。現 listOffset(document 座標: getBoundingClientRect().top + scrollY)は**廃止**。paddingTop/Bottom の `- scrollMargin` 基準も新定義に合わせる。**これが S2 の主リスク**(Fix-3 仮想化の再検証)= 独立 task + stg 300-card smoke で締める。

### D-3. 「列」ボタン移設 【推奨: 案 P(columnVisibility を exam-detail-view へ lift)】
- 案 P(推奨): columnVisibility state + 永続(examViewPrefs read-modify-write)を **exam-detail-view に集約**し、「列」ボタンを view 切替群の並びへ配置。ExamCardTable は `columnVisibility` + `onColumnVisibilityChange` を **controlled prop** で受ける。`ColumnVisibilityToggle` は列メタ(静的 ColumnDef の id/header/getCanHide 相当)から列挙する形へ小改修(live table instance 非依存化)。→ OT 要望(view toggle と同並び)を字義通り満たし、**現 split-brain(exam-detail-view と table が別々に examViewPrefs へ書く)を解消**(触るコードの正当な改善)。
- 案 R(却下寄り): 「列」ボタンを ExamCardTable の上部 toolbar(scroll container 外)に留置。最小変更だが view toggle と同並びにならず OT 要望を満たさない。split-brain も残る。
- **推奨 = 案 P**。ただし state lift は S2 の変更量を増やす(独立 task 化)。OT 承認対象。

### D-4. 条件バー配置 【確定: A-out(container 外・上・常時表示)】
条件バー(ConditionBar + ※列ボタンは D-3 で分離)は bounded container の**外・上**に置く。可変高バー(外)× 固定高 container(内で thead sticky)で関心分離 = バー高変化が sticky header の top に影響しない。bounded container の `max-h` calc は「nav + view toggle 行 + 条件バー(可変)」を引く必要があり、条件バー高変化に追従が要る → S1 の ResizeObserver 配線を **listOffset 算出でなく container 高(または上部 offset)調整**へ転用(fact-finding §④)。

### D-5. th 全体 trigger 【機構】
`ColumnHeaderMenu` の PopoverTrigger を、ラベル button でなく **th 内容 span 全体(ラベル + filter dot + sort glyph)を包む trigger**へ拡張(cell 全域クリックで menu 起動)。resize handle は th 内の別 sibling で `onMouseDown/onTouchStart` に stopPropagation 維持(ドラッグ=リサイズ、クリック=menu の分離を保つ)。対象 = menu を持つ列(canSort + tags)のみ。tags 列(CardTagAddPopover 直)も同様に cell 全域 trigger 化。menu なし列(title/sort_key/options/explanation/memo/select)は現状維持(S3/S4 で menu 追加時に自動的に全域 trigger 化)。aria-label(`${label} の列メニュー`)は維持。

## 5. アーキテクチャ(確定設計)

- **DOM 構造(table view)**:
  ```
  [app-header  sticky top-0 z-40]                         ← 共有 layout(D-1 案 ii)
  … exam 詳細見出し(タイトル/日付)… document スクロール
  [view toggle 行: カード/テーブル … 列ボタン]            ← exam-detail-view(D-3 案 P で列ボタン合流)
  [条件バー(ConditionBar・full width・可変高)]           ← container 外(D-4 A-out)
  [table container: max-h-[calc(100dvh-α)] overflow-auto  ← bounded(D-1/D-2)
     <table border-separate>
       <thead sticky top-0 z-10 + 不透明 th 背景>         ← 2 段目 sticky(D-1/D-5)
       <tbody>… element virtualizer で仮想化 …</tbody>
  ]
  [選択時: fixed bottom action bar(既存・pb 確保)]
  ```
- **th 背景**: 全 th に不透明背景(`bg-background` 相当)を追加(sticky 時に下の行が透けないため)。border-separate ゆえ border-b は td/th 側で維持。
- **virtualizer**: element scroll(D-2)。scrollMargin/padding は container 相対に再定義。
- **列可視**: controlled(D-3 案 P)。永続は exam-detail-view に集約。

## 6. Global Constraints(実装フェーズ厳守)

- predicate 層・S1 registry(cardTableFilterEditors / deriveConditions / ConditionBar 契約)を壊さない。S3/S4 が登録追加で載る構造を維持。
- `undefined` 解除規約・testid 規約(condition-chip-*)・S1 の chip/menu 挙動を不変に保つ。
- 回帰範囲 = exam-card-table.tsx + exam-detail-view.tsx(D-3 で列 state lift)+ app-header.tsx(D-1 で sticky 追加)に限局。card-view(InlineCardList)・inline 編集・side peek 未実装領域へ波及させない。
- bounded 高さは固定 px 禁止 = viewport 追従(dvh/calc、mobile 短 viewport で潰れない)。
- 簡潔性: YAGNI・既存パターン踏襲・scope 外リファクタ禁止(D-3 の split-brain 解消は「触るコードの改善」= 許容)。
- `git commit --no-verify` / `-n` 禁止。各 feat/fix commit に [reviewed]。

## 7. 検証方針(概要・詳細は plan)

- 各 task = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical + Codex 両者 Crit/Imp 0 → [reviewed] commit。
- virtualizer 差替(D-2)は独立 task。jsdom は layout 計算不可のため、仮想化の**行 window 正しさ**は既存 Fix-3 系 test の枠組み(count/測定)+ stg 300-card 実機で締める。sticky/背景/bounded 高は class/構造 assertion + stg 視覚。
- **whole-branch review(opus)**(全 task commit 後・OT push 前): cross-task 相互作用(仮想化差替 × sticky × bounded 高 × 条件バー外出し × 列ボタン lift × th 全体 trigger の相互影響、旧構造からの回帰)を検出。Crit/Imp 解消まで S2 完了としない(per-task の代替でなく追加)。
- whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0。
- **stg smoke(OT push 後・CC 裁量ツール)**: ① 2 段 sticky(nav + 見出し行がスクロール中固定)② bounded の二重スクロール UX ③ mobile 短 viewport の固定高・操作性 + 既存 fixed action bar 干渉(主リスク)④ 300-card 仮想化再検証(スクロール位置・行描画 anomaly・offset 追従)⑤ 列ボタン移設後の動作(ON/OFF・永続)⑥ th 全体クリックで menu 起動(端リサイズと非干渉)。証拠添付。

## 8. リスク

- **R1(主)**: virtualizer 差替で scrollMargin/offset 再定義を誤ると wrong row window / スクロール位置ズレ(Fix-3 の再来)。→ 独立 task + 300-card stg。
- **R2**: bounded 高さ calc の α 誤りで mobile 短 viewport で table が潰れる / fixed action bar と干渉。→ dvh + 実測、mobile smoke 必須。
- **R3**: 列 state lift(D-3)で controlled 化の際、mount load / 永続の READ-MODIFY-WRITE を集約し損なうと hiddenColumns 消失。→ 集約先を exam-detail-view 単一にし test で往復固定。
- **R4**: app-header sticky 追加が他 /app ページの既存レイアウトに視覚回帰。→ 付加的変更だが whole-branch + 目視確認。

## 9. スコープ外の記録(S3/S4 論点)

- S3: タグソート = 文字順(「カテゴリ:タグ」整合)。sort 種追加は S1 registry の登録で載せる。
- S4: テキストフィルタ = 「含む」のみ(完全一致トグルなし)。filter editor 追加は registry 登録で載せる。
