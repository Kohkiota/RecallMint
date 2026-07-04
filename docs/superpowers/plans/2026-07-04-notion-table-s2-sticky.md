# Notion 式テーブル S2 — sticky ヘッダー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(RecallMint 規律に適応 = review-before-commit)。

**Goal:** テーブル領域だけをスクロールする bounded container 化 + 2 段 sticky(ナビ + 見出し行)+ 列ボタン上部移設 + ヘッダーセル全体のメニュートリガー化。

**Architecture:** spec `docs/superpowers/specs/2026-07-04-notion-table-s2-sticky-design.md`(commit 9ca57f4)§4 の D-1〜D-5 が設計判断の正本。本 plan は task 分割と各段の検証方針のみ。設計理由は spec 参照(重複回避)。

**Tech Stack:** Next.js 16 / TanStack Table + TanStack Virtual(`useVirtualizer`)/ Tailwind v4 / Vitest / Playwright(stg smoke)。

## Global Constraints(全 task 共通・spec §6)

- predicate 層 / S1 registry(`cardTableFilterEditors` / `deriveConditions` / `ConditionBar` 契約 / testid `condition-chip-*`)を壊さない。S3/S4 が登録追加で載る構造を維持。
- `undefined` 解除規約・S1 の chip/menu 挙動・sort/filter 意味を不変に保つ。
- bounded 高さは固定 px 禁止 = viewport 追従(`dvh`/`calc`/flex、mobile 短 viewport で潰れない)。
- 回帰範囲 = `exam-card-table.tsx` + `exam-detail-view.tsx`(D-3 列 state lift)+ `app-header.tsx`(D-1 sticky)に限局。card-view(InlineCardList)・inline 編集・side peek 未実装領域へ波及させない。
- 簡潔性: YAGNI・既存パターン踏襲・scope 外リファクタ禁止(D-3 の examViewPrefs split-brain 解消は「触るコードの正当な改善」= 許容)。
- 各 task 完了 = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical review(`superpowers:requesting-code-review`・template 改変なし)+ Codex review(`scripts/ai/codex-review.sh`)両者 Critical/Important 0 → controller が `[reviewed]` commit(subagent に commit/tag させない)。実装者は commit しない。
- `git commit --no-verify` / `-n` 禁止。明示 add・push は OT。

## File 構成(確定)

- Modify: `app/(app)/app/_components/app-header.tsx`(S2-1 sticky)
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(S2-2 bounded+virtualizer / S2-3 sticky thead+th bg / S2-4 条件バー配置 / S2-5 controlled columnVisibility / S2-6 th trigger 連携)
- Modify: `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx`(S2-5 列 state lift + 列ボタン配置)
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-column-toggle.tsx`(S2-5 列メタ列挙化)
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-header-menu.tsx`(S2-6 trigger 範囲拡張)
- 各 `.test.tsx` を対応追加/更新。

## Task 間 interface(先に凍結)

- S2-5 で `ExamCardTable` は `columnVisibility: VisibilityState` + `onColumnVisibilityChange: (u: Updater<VisibilityState>) => void` を **controlled prop** で受ける(内部 useState 廃止)。永続(examViewPrefs read-modify-write)は `exam-detail-view.tsx` が単一所有。
- `ColumnVisibilityToggle` は `{ columnVisibility, onColumnVisibilityChange, columns }` を受け、列メタ(id / label / hideable)から列挙(live `table` instance 非依存)。列メタは columns.tsx の ColumnDef から導出(id + header string + `enableHiding !== false`)。
- 条件バー wrapper(現 `filterBarWrapperRef`)は S2-4 以降 ConditionBar のみ内包(列ボタンは S2-5 で上部へ移動)。

---

### Task S2-1: ナビ sticky 化(D-1 案 ii)

**目的**: `app-header.tsx` の `<header>` を `sticky top-0 z-40` で viewport 上端固定(背景は既存 `bg-white` 不透明で流用)。document スクロール中もナビが残る = 2 段 sticky の上段。
**制約**: Global。共有 layout の付加変更のみ(既存 class を消さない)。z 階層は後続 thead(z-10)より上・既存 fixed bottom action bar と非干渉。他 /app ページのレイアウトを構造変更しない。
**完了条件**: header の sticky/top/z class 付与を構造 test で固定(既存 header test があれば更新)+ full-dir green + whole-repo lint/typecheck exit0。stg smoke ①(nav 固定)は S2 締めでまとめて。単独で視覚確認可能な粒度。

### Task S2-2: bounded container + element virtualizer 差替(D-2・主リスク・独立)

**目的**: table 領域を viewport 追従の bounded スクロール box 化し、`useWindowVirtualizer` → `useVirtualizer({ getScrollElement: () => tableContainerRef.current })` へ差替。縦スクロール主体を document → container に移す。`scrollMargin`/paddingTop/paddingBottom を container 相対に再定義し、`listOffset`(document 座標 = getBoundingClientRect().top+scrollY)算出を廃止。高さは flex 方式を優先(表示領域を `h-[calc(100dvh - α)] flex flex-col`、container を `flex-1 min-h-0 overflow-auto`)。thead はまだ非 sticky(S2-3)。
**制約**: Global。`count`/`estimateSize=120`/`getItemKey=card.id`/`overscan=5`/`measureElement` 流用。memo 凍結(isResizing)・resize CSS 変数のリアルタイム更新を不変に保つ。`observeElementRect`/`observeElementOffset` は default(明示指定しない)。row window 正しさ厳守。α は実測(nav 高等)= 固定 px でなく calc/dvh。
**完了条件**: 仮想化の spacer/paddingTop/Bottom・window 計算の対象 test green(element virtualizer 前提へ更新、旧 document 座標 test は再 point/削除)+ full-dir green + typecheck/lint exit0。**stg 300-card 実機**(S2 締め ④)で scroll 位置・行描画 anomaly なし・offset 追従を確認。R1 の主検証段。

### Task S2-3: sticky thead + th 不透明背景(D-1 下段 / spec §5)

**目的**: S2-2 の bounded container 内で `<thead>` を `sticky top-0 z-10`、全 `<th>` に不透明背景(`bg-background` 相当)を付与。内部スクロール中も見出し行を固定、行が透けないようにする。
**制約**: Global。`border-separate border-spacing-0` 維持・border-b(td/th)不変・resize handle 不変。pin は不在(fact-finding §③)ゆえ角セル z-index 交差なし。z は S2-1 nav(z-40)未満・body 行より上。
**完了条件**: thead の sticky/top/z + 全 th の背景 class を構造 test で固定 + full-dir green + lint/typecheck exit0。stg smoke ①(見出し行固定)は S2 締め。

### Task S2-4: 条件バー A-out 確定 + 高さ追従の簡潔化(D-4)

**目的**: `ConditionBar` を bounded container の**外・上**(flex-none sibling)に確定。可変高バーは flex-none / container は flex-1 min-h-0 で **flex がネイティブに高さ配分**(バー高変化が thead top に影響しない = 関心分離)。S1 の listOffset 用 ResizeObserver は S2-2 で廃止済のため、ここでは container 高調整用 JS を**足さない**(flex で足りる)ことを確認。flex で不足する場合のみ最小 JS を justify する。
**制約**: Global。ConditionBar 契約・chip 挙動・testid 不変。バー高変化で sticky header の top を動かさない。※spec D-4 は「ResizeObserver 転用」を挙げるが、flex-native が同一要件をより単純に満たすため優先(spec 意図 = バー外出し + 高独立、の範囲内。逸脱でなく mechanism 精緻化)。
**完了条件**: 条件 add/remove でバー高が変わっても container/thead レイアウトが崩れない構造 test + full-dir green + lint/typecheck exit0。stg ②④ で二重スクロール UX と offset 追従。

### Task S2-5: 「列」ボタン移設 + columnVisibility lift(D-3 案 P)

**目的**: `columnVisibility` state + examViewPrefs 永続(read-modify-write)を `exam-detail-view.tsx` に集約(現 split-brain 解消 = table 側の永続 effect を撤去し親単一所有)。「列」ボタン(`ColumnVisibilityToggle`)を view 切替(カード/テーブル)の並びへ配置。`ExamCardTable` は `columnVisibility`/`onColumnVisibilityChange` を controlled prop 受領。`ColumnVisibilityToggle` を列メタ列挙(id/label/hideable)へ小改修し live `table` instance 非依存化。
**制約**: Global。機能不変(列 ON/OFF・examViewPrefs 永続・mount load・sort_key 初期 hidden)。card-view 非波及(view='card' 時は列ボタン非表示 or 無効)。examViewPrefs の書込経路を**単一**にする(view と hiddenColumns を同一所有者が read-modify-write)。
**完了条件**: 列 toggle の往復(hide→show)+ 永続 read-modify-write(view と hiddenColumns 相互非破壊)の test green + full-dir green + lint/typecheck exit0。stg ⑤(列移設後 ON/OFF + reload 永続)。

### Task S2-6: ヘッダーセル全体を menu トリガー化(D-5)

**目的**: `ColumnHeaderMenu` の PopoverTrigger を、ラベル button でなく **th 内容全体(ラベル + filter dot + sort glyph)を包む trigger** に拡張(cell 全域クリックで menu 起動)。tags 列(CardTagAddPopover 直)も cell 全域 trigger 化。
**制約**: Global。resize handle は th 内の別 sibling で `onMouseDown/onTouchStart` の stopPropagation 維持(ドラッグ=リサイズ / クリック=menu の分離)。aria-label(`${label} の列メニュー`)維持。menu なし列(title/sort_key/options/explanation/memo/select)は現状維持(S3/S4 で menu 追加時に自動全域化)。
**完了条件**: cell 全域クリックで menu open + resize handle 部クリック/ドラッグで menu 非起動、の test green(端 resize 非干渉)+ full-dir green + lint/typecheck exit0。stg ⑥。

---

## S2 完了 gate(全 task commit 後・OT push 前)

- **whole-branch review(opus)**: cross-task 相互作用(仮想化差替 × sticky × bounded 高 × 条件バー外出し × 列ボタン lift × th 全体 trigger の相互影響、旧構造からの回帰)を検出。Critical/Important 解消まで S2 完了としない(per-task の代替でなく追加)。carry Minor を triage。
- whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0(報告に明記)。
- **stg smoke(OT push 後・DevTools/Playwright MCP・CC 裁量)**: ① 2 段 sticky(nav + 見出し行がスクロール中固定)② bounded の二重スクロール UX ③ mobile 短 viewport の固定高・操作性 + 既存 fixed action bar 干渉(主リスク)④ 300-card 仮想化再検証(スクロール位置・行描画 anomaly・offset 追従)⑤ 列ボタン移設後動作(ON/OFF・reload 永続)⑥ th 全体クリックで menu 起動(端 resize 非干渉)。証拠(snapshot/console/計測)添付。
- Sprint 境界 = OT 判断で停止。

## 実装順序 / 停止条件

- S2-1 → S2-6 直列(各段が単独 smoke 可能な粒度)。virtualizer 差替(S2-2)は独立段 = 主リスク隔離。併合しない(型 swap の教訓)。
- Critical 検出・仕様解釈揺れ・外部設定変更要で停止(自走継続条件は S1 と同一: canonical/Codex の未解決 Critical のみ即上げ、Important 以下は CC 吸収)。

## Minor 記録(whole-branch triage 用)

- (現時点なし。各 task の per-task review で発生分を controller が ledger へ記録し S2 締め triage)
