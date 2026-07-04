# Notion 式テーブル S2 — sticky ヘッダー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(RecallMint 規律に適応 = review-before-commit)。

**Goal:** テーブル view を viewport 高の app-shell 化(テーブル領域だけ内部スクロール)+ 見出し行 sticky + 列ボタン上部移設 + ヘッダーセル全体のメニュートリガー化。

**Architecture:** spec `docs/superpowers/specs/2026-07-04-notion-table-s2-sticky-design.md`(commit 9ca57f4 → app-shell 改訂版)§4 の D-1〜D-5 が設計判断の正本。本 plan は task 分割と各段の検証方針のみ。設計理由は spec 参照(重複回避)。

**Tech Stack:** Next.js 16 / TanStack Table + TanStack Virtual(`useVirtualizer`)/ Tailwind v4 / Vitest / Playwright(stg smoke)。

## Global Constraints(全 task 共通・spec §6)

- predicate 層 / S1 registry(`cardTableFilterEditors` / `deriveConditions` / `ConditionBar` 契約 / testid `condition-chip-*`)を壊さない。S3/S4 が登録追加で載る構造を維持。
- `undefined` 解除規約・S1 の chip/menu 挙動・sort/filter 意味を不変に保つ。
- bounded 高さは固定 px 禁止 = viewport 追従(`dvh`/`calc`/flex、mobile 短 viewport で潰れない)。flex-1 min-h-0 chain を切らさない。
- 回帰範囲 = `exam-card-table.tsx` + `exam-detail-view.tsx`(D-3 列 state lift + app-shell chrome)+ `exam-card-table-column-toggle.tsx`(D-3 列メタ列挙)+ `exam-card-table-header-menu.tsx`(D-5 trigger)。**app-header.tsx は触らない**(app-shell 型ゆえ nav は非スクロールで自然に残る)。card-view(InlineCardList)・inline 編集・side peek 未実装領域へ波及させない。
- 簡潔性: YAGNI・既存パターン踏襲・scope 外リファクタ禁止(D-3 の examViewPrefs split-brain 解消は「触るコードの正当な改善」= 許容)。
- 各 task 完了 = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical review(`superpowers:requesting-code-review`・template 改変なし)+ Codex review(`scripts/ai/codex-review.sh`)両者 Critical/Important 0 → controller が `[reviewed]` commit(subagent に commit/tag させない)。実装者は commit しない。
- `git commit --no-verify` / `-n` 禁止。明示 add・push は OT。

## File 構成(確定)

- Modify: `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx`(S2-1 app-shell chrome + S2-5 列 state lift + 列ボタン配置)
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(S2-1 app-shell 内包整合 / S2-2 bounded+virtualizer / S2-3 sticky thead+th bg / S2-4 条件バー flex-none / S2-5 controlled columnVisibility / S2-6 th trigger 連携)
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-column-toggle.tsx`(S2-5 列メタ列挙化)
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-header-menu.tsx`(S2-6 trigger 範囲拡張)
- 参照/取込確認: `app/(app)/app/exams/[id]/page.tsx`(タイトル/日付を app-shell chrome に取り込む要否、S2-1 で現物確認)
- 各 `.test.tsx` を対応追加/更新。**app-header.tsx は不変。**

## Task 間 interface(先に凍結)

- S2-5 で `ExamCardTable` は `columnVisibility: VisibilityState` + `onColumnVisibilityChange: (u: Updater<VisibilityState>) => void` を **controlled prop** で受ける(内部 useState 廃止)。永続(examViewPrefs read-modify-write)は `exam-detail-view.tsx` が単一所有。
- `ColumnVisibilityToggle` は `{ columnVisibility, onColumnVisibilityChange, columns }` を受け、列メタ(id / label / hideable)から列挙(live `table` instance 非依存)。列メタ = columns.tsx の ColumnDef から導出: label = header string / 非 string は id fallback、hideable = `enableHiding !== false`、select 列は除外。
- app-shell の高さ chain: exam-detail-view の table view branch が `h-[calc(100dvh - navH)] flex flex-col`(navH は実測)を確立し、ExamCardTable がその中で [条件バー flex-none] + [container flex-1 min-h-0 overflow-auto] を構成。

---

### Task S2-1: exam 詳細テーブル view の app-shell 化(D-1)

**目的**: exam-detail-view の table view branch を viewport 高の flex 列(`h-[calc(100dvh - navH)] flex flex-col`)にする。上部 chrome(flex-none)= [タイトル/日付(最小・1 行 truncate)+ view 切替 + ※列ボタンは S2-5)]。ページを document スクロールさせず、以降 ExamCardTable 側の container が内部スクロール主体になる土台を作る。nav(app-header)は触らない(非スクロールで自然に残る)。タイトル/日付を chrome に取り込むかは page.tsx の現物を見て決める。
**制約**: Global。app-header 非変更。card view branch は現状の document スクロール維持(app-shell 化は table view のみ)。navH は固定 px 禁止(calc/dvh・実測)。この段では virtualizer 差替(S2-2)を含めない(まず高さ骨格)。
**完了条件**: table view が viewport 高 flex 列になり外側 page が document スクロールしない構造 test(高さ/flex-col/flex-none chrome)+ full-dir green + lint/typecheck exit0。stg smoke ①②(app-shell スクロール構造)は S2 締め。単独で視覚確認可能。

### Task S2-2: element virtualizer 差替 + container 内部スクロール(D-2・主リスク・独立)

**目的**: `tableContainerRef` を app-shell の `flex-1 min-h-0 overflow-auto` container 化し、`useWindowVirtualizer` → `useVirtualizer({ getScrollElement: () => tableContainerRef.current })` へ差替。`scrollMargin`/paddingTop/paddingBottom を container 相対に再定義、`listOffset`(document 座標 = getBoundingClientRect().top+scrollY)算出と S1 の listOffset 用 ResizeObserver を廃止。thead はまだ非 sticky(S2-3)。
**制約**: Global。`count`/`estimateSize=120`/`getItemKey=card.id`/`overscan=5`/`measureElement` 流用。memo 凍結(isResizing)・resize CSS 変数のリアルタイム更新を不変に保つ。`observeElementRect`/`observeElementOffset` は default(明示指定しない)。**scroll 位置 = 保持**(filter/sort/view/列変更で先頭リセットしない)。row window 正しさ厳守。
**完了条件**: 仮想化 spacer/paddingTop/Bottom・window 計算の対象 test green(element virtualizer 前提へ更新、旧 document 座標 test は再 point/削除)+ **件数境界 test(0件/1件/少数)** + full-dir green + typecheck/lint exit0。**stg 300-card 実機**(S2 締め ④)で scroll 位置・行描画 anomaly なし・offset 追従・scroll 保持・filter で件数減時の spacer を確認。R1 の主検証段。

### Task S2-3: sticky thead + th 不透明背景(D-1 下段 / spec §5)

**目的**: S2-2 の container 内で `<thead>` を `sticky top-0 z-10`(第一候補)、全 `<th>`(select 含む)に不透明背景(`bg-background` 相当)を付与。内部スクロール中も見出し行を固定、行が透けないようにする。thead sticky が browser 差/table layout で崩れる場合は **per-th sticky** に fallback(実装判定)。
**制約**: Global。`border-separate border-spacing-0` 維持・border-b(td/th)不変・resize handle 不変。pin 不在(fact-finding §③)ゆえ角セル z-index 交差なし。z は body 行より上・後述 Popover(portal)未満。不透明背景は全 th(trigger 対象列とは独立軸)。
**完了条件**: thead/th の sticky/top/z + 全 th 背景 class を構造 test で固定 + full-dir green + lint/typecheck exit0。stg smoke ①(見出し固定)+ ⑥(Popover が container にクリップされない = portal 確認)は S2 締め。

### Task S2-4: 条件バー A-out(flex-none)確定(D-4)

**目的**: `ConditionBar` を app-shell の flex-none 領域(container の外・上)に確定配置。flex が可変高バーを吸収し container(flex-1 min-h-0)が残りを埋める = バー高変化が thead top に影響しない。S1 の listOffset 用 ResizeObserver は S2-2 で廃止済のため、**container 高調整の JS を新設しない**(flex で足りることを確認。不足時のみ最小 JS を justify)。
**制約**: Global。ConditionBar 契約・chip 挙動・testid 不変。バー高変化で sticky header の top を動かさない。ResizeObserver 等の JS 高さ制御を足さない(YAGNI)。
**完了条件**: 条件 add/remove でバー高が変わっても container/thead レイアウトが崩れない構造 test + full-dir green + lint/typecheck exit0。stg ②④ で二重スクロール UX・件数変化時の追従。

### Task S2-5: 「列」ボタン移設 + columnVisibility lift(D-3 案 P)

**目的**: `columnVisibility` state + examViewPrefs 永続(read-modify-write)を `exam-detail-view.tsx` に集約(現 split-brain 解消 = table 側の永続 effect を撤去し親単一所有)。「列」ボタン(`ColumnVisibilityToggle`)を view 切替(カード/テーブル)の並び(app-shell 上部 chrome)へ配置。`ExamCardTable` は `columnVisibility`/`onColumnVisibilityChange` を controlled prop 受領。`ColumnVisibilityToggle` を列メタ列挙(id/label/hideable、interface 凍結節の規約)へ小改修し live `table` instance 非依存化。card view 中は列ボタン非表示。
**制約**: Global。機能不変(列 ON/OFF・examViewPrefs 永続・mount load・sort_key 初期 hidden)。card-view 非波及。examViewPrefs の書込経路を**単一**(view と hiddenColumns を同一所有者が read-modify-write)。列メタ端ケース(header 非 string→id / enableHiding===false / select 除外 / 将来追加列)を規約どおり。
**完了条件**: 列 toggle 往復(hide→show)+ 永続 read-modify-write(view と hiddenColumns 相互非破壊)+ 列メタ導出(非 string header の label fallback)の test green + full-dir green + lint/typecheck exit0。stg ⑤(列移設後 ON/OFF + reload 永続 + card view 非表示)。

### Task S2-6: ヘッダーセル全体を menu トリガー化(D-5)

**目的**: `ColumnHeaderMenu` の PopoverTrigger を、ラベル button でなく **th 内容全体(ラベル + filter dot + sort glyph)を包む trigger** に拡張(cell 全域クリックで menu 起動)。tags 列(CardTagAddPopover 直)も cell 全域 trigger 化。
**制約**: Global。resize handle は th 内の別 sibling で `onMouseDown/onTouchStart` の stopPropagation 維持(ドラッグ=リサイズ / クリック=menu の分離)。**S1-1 で th 直接 sort は撤去済=競合なし**。canSort th の残存 `cursor-pointer` を全域 trigger と整合(cell 全域が pointer target)。aria-label(`${label} の列メニュー`)維持。**対象 = canSort 列 + tags 列のみ**(select 列・menu なし列は trigger 対象外・現状維持)。button nesting/focus/keyboard activation を悪化させない。
**完了条件**: cell 全域クリックで menu open + resize handle 部クリック/ドラッグで menu 非起動 + menu なし列は不変、の test green(端 resize 非干渉)+ full-dir green + lint/typecheck exit0。stg ⑥(全域クリック + 端 resize 非干渉 + Popover 非クリップ)。

---

## S2 完了 gate(全 task commit 後・OT push 前)

- **whole-branch review(opus)**: cross-task 相互作用(app-shell 化 × 仮想化差替 × sticky × 条件バー flex-none × 列ボタン lift × th 全体 trigger の相互影響、旧構造からの回帰)を検出。Critical/Important 解消まで S2 完了としない(per-task の代替でなく追加)。carry Minor を triage。
- whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0(報告に明記)。
- **stg smoke(OT push 後・DevTools/Playwright MCP・CC 裁量)**: ① 見出し行 sticky(内部スクロール中 thead 固定・nav 自然に常時表示)② app-shell 二重スクロール UX(外側 page 非スクロール・container 内部スクロール)③ mobile 短 viewport の固定高・操作性 + 既存 action bar 干渉(主リスク)④ 300-card 仮想化再検証(scroll 位置 anomaly・offset 追従・scroll 保持・0/1/少数/filter 減)⑤ 列ボタン移設後動作(ON/OFF・reload 永続・card view 非表示)⑥ th 全体クリックで menu 起動(端 resize 非干渉)+ Popover が container にクリップされない。証拠(snapshot/console/計測)添付。
- Sprint 境界 = OT 判断で停止。

## 実装順序 / 停止条件

- S2-1 → S2-6 直列(各段が単独 smoke 可能な粒度)。virtualizer 差替(S2-2)は独立段 = 主リスク隔離。併合しない(型 swap の教訓)。
- Critical 検出・仕様解釈揺れ・外部設定変更要で停止(自走継続条件は S1 と同一: canonical/Codex の未解決 Critical のみ即上げ、Important 以下は CC 吸収)。

## Minor 記録(whole-branch triage 用)

- (現時点なし。各 task の per-task review で発生分を controller が ledger へ記録し S2 締め triage)
