# Edit-1 テーブルレイアウト解放 + 全列追加 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)で実装する。Steps は checkbox 追跡。

**Goal:** 試験詳細テーブルビューを画面幅まで解放して横スクロールを実発火させ、カードビュー全項目を列化(編集系は InlineTextField、選択肢は read-only)+ ユーザー column resize を入れる。

**Architecture:** (a) `<main>` の max-w-4xl を撤去し各 page が `AppContainer` で自前 cap、試験詳細は view 分岐で table のみ full-width。(b) `<table w-full>` を撤廃し TanStack column sizing(固定幅 + resize)で列幅合計 > viewport にして既存 overflow-x-auto を発火。(c) 列追加は全て `row.original.card` から供給(追加 join なし)、編集書込は既存 `InlineTextField` 内部の runOptimisticUpdate に委譲。

**Tech Stack:** Next.js App Router / TanStack Table 8.21.3 / Tailwind v4 / Dexie / Vitest + RTL。

**Spec(唯一の起点):** `docs/superpowers/specs/2026-06-24-edit-1-table-layout-columns-design.md`

## Global Constraints

- 起点は spec のみ。spec 凍結。仕様変更が要るなら停止して OT 相談。
- 各 task 完了条件 = ① 該当 unit/component test green ② review Critical 0 ③ `[reviewed]`(feat は canonical `superpowers:requesting-code-review` 経路必須・template 改変なし)。
- **カードビュー(InlineCardList)無改変**、**app-header 無改変**。回帰させない。
- **書込経路を新設しない**: 編集 cell は既存 `InlineTextField`(`cardId`/`field`/`initialValue`/`ariaLabel`[/`multiline`])をそのまま使う。親 mutation wiring を持たせない。
- **追加 join 禁止**: 全列データは `row.original.card`(ClientCard)から取得。
- 全 read は `user_id` scope を維持(既存 useLiveQuery filter を踏襲)。
- 左 pin は **title 列のみ**(select は非 pin)。問題文は中身無改変(read-only / `line-clamp-2` / `sortLikeServer` ヘッダソート保持)で pin のみ喪失。
- resize 幅は**非永続**(`examViewPrefs` schema 拡張しない)。初期幅は code 定数。
- Test: Vitest + RTL。AI/課金は非該当。`--no-verify` 全面禁止(lint は eslint.config.mjs が正本)。

## Sprint 完了 gate

- whole-repo `pnpm lint --max-warnings=0` exit 0(報告に1行明記)。
- layout/page を広く触るため追加で `pnpm typecheck` exit 0(依存/Next 設定/lockfile は不変のため frozen-install/build は不要)。
- review dispatch の観点 list に whole-repo lint 実行確認を含める(CC + reviewer 2 経路)。
- stg smoke(push 後 OT 指示で DevTools MCP 実走): **T1**(全 (app) page 回帰)/ **T2**(試験詳細 2 view + loading/error 幅)/ **T3-T6**(横スクロール発火・resize・新列・sticky)。

---

### Task 1: max-w-4xl 移設(AppContainer 導入)

**目的:** `<main>` から幅 cap を外し full-width 化、全 (app) page/loading/error を共有 `AppContainer` で従来見た目に維持。試験詳細 page は本 task では暫定 blanket cap(T2 で view 分岐へ)。

**Files:**
- Create: `app/(app)/app/_components/app-container.tsx`
- Modify: `app/(app)/app/layout.tsx:73`(main を `flex-1 w-full` に)
- Modify(各 content を `<AppContainer>` で wrap): page.tsx 10件 = `app/(app)/app/page.tsx` / `exams/page.tsx` / `exams/[id]/page.tsx`(暫定 blanket) / `settings/page.tsx` / `study/custom/page.tsx` / `study/smart/page.tsx` / `tags/page.tsx` / `upgrade/page.tsx` / `upload/page.tsx` / `upload/result/[sourceDocumentId]/page.tsx`
- Modify: loading.tsx 7件(`exams/[id]` / `exams` / `app` / `settings` / `study/custom` / `study/smart` / `tags`)+ `app/(app)/app/error.tsx`

**Interfaces(Produces):** `export function AppContainer({ children, className }: { children: React.ReactNode; className?: string }): JSX.Element` — `cn('mx-auto w-full max-w-4xl px-4 py-8', className)` を当てる div。

**制約:** 既存各 page の root 要素(`<div className="space-y-...">` 等)はそのまま残し、その**外側**を AppContainer で包むだけ(内部構造・余白クラスは変えない)。app-header(`:23`)は無改変。

**完了条件:** AppContainer の component test(子を描画 + 既定 class 付与 + className マージ)green。既存の page/component test suite 全 green。canonical review + 全 (app) page の stg smoke(レイアウト回帰)対象。

---

### Task 2: 試験詳細の view 分岐幅(table のみ full-width)

**目的:** 試験詳細を「header + ViewToggle + カードビュー = capped / テーブルビュー = full-width」に。T1 の暫定 blanket を per-section へ置換。

**Step 0 確定済(実コード読了、見込みなし):** page.tsx は T1 で `<AppContainer>` blanket → 内側 `div.space-y-6` に [戻りリンク div / `ExamDetailPullGate`(`return null`・UI なし) / `header` / `section`→`ExamDetailView`]。exam-detail-view.tsx は `div.space-y-4` → ViewToggle `div[role=group].flex.gap-1` + `{view==='card' && InlineCardList}` / `{view==='table' && ExamCardTable}`、**幅クラスは現状どこにも無い**(幅は page blanket 由来)。`cn = twMerge(clsx)` を確認 → `<AppContainer className="py-0">` は `py-8` を打ち消し `mx-auto w-full max-w-4xl px-4`(水平 cap のみ)になる = AppContainer を水平 cap に再利用可。

**Files(確定):**
- Modify `app/(app)/app/exams/[id]/page.tsx`: blanket を `<div className="w-full">` に置換し、その中で **(a)** 戻りリンク + `ExamDetailPullGate` + `header` を `div.space-y-6 md:space-y-3` ごと `<AppContainer>`(既定 py-8 維持=上部 page padding + 下部 view との間隔)で包み、**(b)** `<ExamDetailView/>` は AppContainer の外=full-width 領域に置く(`section` ラッパは不要、直置き)。
- Modify `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx`: 外側を `div.space-y-4 pb-8`(下部 page padding 復元)に。ViewToggle と card view は各々 `<AppContainer className="py-0">`(水平 cap のみ)で包む。table view は `<div className="w-full px-2 md:px-4">` で full-width。

**Interfaces(Consumes):** `AppContainer`(T1)。`className="py-0"` で水平 cap 化(twMerge 依存)。

**制約:** カードビュー(InlineCardList)を含む内部構造は無改変(wrap だけ追加、子の class/構造は触らない)。view state(`view`)・ViewToggle ロジック・conditional unmount は不変。`ExamDetailPullGate`(null)・selection prune(内部 state)・action bar(`fixed` viewport 相対)は幅と無関係 = 触らない。

**完了条件:** `exam-detail-view` の component test green = view='table' で table 容器が `w-full`(max-w-4xl を持たない)/ view='card' で容器が `max-w-4xl`、ViewToggle 押下で card↔table が切替わり幅クラスも切替わる、を assert。stg smoke(テーブル view=画面幅 / カード view=capped / loading・error 幅)対象。

---

### Task 3: 列幅固定モデル + column resize 配線

**目的:** `<table w-full>` を撤廃し各列に固定初期幅(`column.size`)+ getSize→style width 反映 + `enableColumnResizing` + resize handle。列幅合計 > viewport で既存 `:272 overflow-x-auto` が発火。

**Files:** Modify `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(table の `w-full` 撤去 → `style={{ width: table.getTotalSize() }}`、th/td に `style={{ width: header.getSize()/cell.column.getSize() }}`、`columnSizing` を `useState`(非永続)で持ち `enableColumnResizing: true` + `columnResizeMode: 'onChange'`、th に resize handle div + `header.getResizeHandler()`)/ `exam-card-table-columns.tsx`(既存6列に `size` 付与)。

**Interfaces(Produces→T4/T5 が踏襲):** 各 ColumnDef に数値 `size`(例: select 44 / question 320 / tags 200 / lastCorrect 96 / currentStreak 96 / lastReview 160、tunable)。table render は全 th/td が `getSize()` を style width に反映する形に統一。

**制約:** table を `border-collapse` から **`border-separate border-spacing-0` に倒し切る**(条件分岐なし)+ 行/セル境界を border util で明示(現 `border-b border-border` 相当を tr ではなく td/th 側に付け直す)。理由: 固定幅 + sticky セルで border-collapse の border 消失はほぼ確実な既知挙動で、条件分岐は T6 sticky header で初めて顕在化し T3 決定の蒸し返しになる。今 sprint は sticky 2軸を確実に入れるため collapse 温存の利得が薄い。resize handle は th 内 `absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none`、本文セル選択を阻害しない。既存の sort クリック(th onClick)と resize handle の click 干渉を `e.stopPropagation()` で分離。

**完了条件:** columns test に「全列が数値 size を持つ」assertion 追加 green。`exam-card-table.test.tsx` で th が style width を持つこと + resize handle 要素が存在することを assert、既存 test 全 green。stg smoke(横スクロール発火 + ドラッグ resize + 行/セル border が border-separate 下で崩れていない)対象。

---

### Task 4: 選択肢 read-only 列(新規軽量表示部品)

**目的:** 選択肢を read-only 表示する軽量 cell 部品を新設し列追加(正解ハイライト)。commit/working-set ロジックは持ち込まない。

**Files:** Create `app/(app)/app/exams/[id]/_components/exam-card-table-options-cell.tsx` / `.test.tsx`。Modify `exam-card-table-columns.tsx`(`options` 列追加、`enableSorting: false`、`size` 付与、cell で本部品を render)。

**Interfaces(Produces):** `export function OptionsReadonlyCell({ options }: { options: ClientCardOption[] }): JSX.Element` — 各 option を `text` 表示、`is_correct` のものは正解スタイル(emerald 系、InlineOptionRow の正解配色と整合)、不正解は素表示。`ClientCardOption` は `@/lib/client-db` から import。

**制約:** read-only(編集 UI・checkbox なし)。データは `row.original.card.options` から(追加 join なし)。`correct_answer_ids` は使わず各 option の `is_correct` で判定。空 options は空表示(throw しない)。列順の最終確定は T5。

**完了条件:** OptionsReadonlyCell の component test green(正解 option にハイライト class / 不正解は素 / 複数正解 / 空配列)。columns test 既存 green。

---

### Task 5: 編集系4列追加 + pin 移設 + 列順最終確定

**目的:** title / sort_key / 解説 / メモ を InlineTextField cell で列追加、sticky-left pin を問題文 → title へ移設、列順を spec §4.2 に最終確定。

**Step 0(着手前・必須・見込みで実装に入らない):** `exam-card-table.tsx` の左 pin render 実装を読み、pin が **(a) `meta.sticky` を汎用に読む**のか **(b) 特定列 id / 問題文列前提でハードコードされている**のかを判定する。
- (a) なら `meta.sticky` を question→title へ付け替えるだけで title に**無配線追従** → render 変更不要。
- (b) なら left pin render を汎用化する**要配線**を本 task に含める(列 id 直書きを排除し meta.sticky 駆動へ)。
判定結果(a/b と要配線有無)を chat に1行報告してから列定義の fix に進む。pin は今 sprint の横スクロール成立の核心であり、T5(pin)と T6(sticky header)が同一 render に依存するため、見込みのまま実装に入らない。

**Files:** Modify `app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx`(4列追加 + `question` 列から `meta.sticky` 除去 + `title` 列に `meta.sticky` 付与 + 配列順を最終形に並べ替え)/ `exam-card-table.tsx`(Step 0 が (b) 要配線と判定した場合のみ left pin render を meta.sticky 駆動へ汎用化)。

**Interfaces(Consumes):** `InlineTextField`(`from './inline-text-field'`)。**列の cell 配線:**
- `title`: `<InlineTextField cardId={card.id} field="title" initialValue={card.title} ariaLabel="タイトル 編集" />`(単一行)+ `meta:{ sticky:true }`
- `sort_key`: `field="sort_key"` `initialValue={card.sort_key ?? null}` `ariaLabel="ソートキー 編集"`(単一行)
- `explanation_text`: `field="explanation_text"` `initialValue={card.explanation_text ?? null}` `multiline` `ariaLabel="解説 編集"`
- `memo`: `field="memo"` `initialValue={card.memo ?? null}` `multiline` `ariaLabel="メモ 編集"`
- 最終列順: `select / title(pin) / sort_key / question / options / tags / explanation_text / memo / lastCorrect / currentStreak / lastReview`

**制約:** 問題文の中身は無改変(read-only / line-clamp-2 / sortLikeServer ヘッダソートを保持、pin だけ除去)。新規 sort_key 列に sort は付けない。編集書込は InlineTextField 内部に委譲(親 wiring なし)。各列に `size` 付与(title 広め=240、sort_key 100、explanation/memo 中=220)。

**完了条件:** columns test green(最終 column id 配列が上記順 / `meta.sticky` が title のみ true・question は false / 4編集列の存在)。`exam-card-table.test.tsx` で title cell の InlineTextField(aria-label「タイトル 編集」)描画を assert、既存 green。stg smoke(新列表示 + title pin + inline 編集 → mirror 反映)対象。
- **追加(T3×T5 交差点):** title 列(sticky-left pin)で column resize handle が機能すること = pin の sticky/z-index 配下でも handle を掴め、ドラッグで title 幅が追従する(横スクロール時も含む)を stg smoke で確認。title は「pin かつ resizable」な唯一の列のため、pin の z-index と resize handle の前面性の両立をこの完了条件で担保する。

---

### Task 6: sticky header(縦固定)

**目的:** thead th に `sticky top-0` を付与し縦スクロール時もヘッダ固定。title th は角セル(左+上 両軸)。

**Files:** Modify `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(thead th の className に `sticky top-0 z-10 bg-background` 追加、`meta.sticky`(=title)の th は `sticky left-0 top-0 z-20`、左 pin body td は `z-10` 維持)。

**制約:** z 設計 = 通常 th(top-0)z-10 / 左 pin body td(title)z-10 / 角セル(title th)z-20。`bg-background` で scrolled 下層の透けを防ぐ。縦スクロール境界は window のため `top-0` は viewport 上端固定(table 内 scroll container は作らない=横のみ overflow-x-auto 維持)。

**完了条件:** `exam-card-table.test.tsx` で thead th が `sticky`+`top-0` class、title th が `left-0`+`top-0` 両軸 class を持つことを assert、既存 green。stg smoke(縦スクロールでヘッダ固定 + title 左 pin 併存)対象。

---

## Self-Review

- **Spec coverage:** T-A→T1+T2 / T-B→T3 / T-C→T4(選択肢)+T5(編集4列・pin・順序)/ T-D→T6。OUT(選択肢編集・columnVisibility・side peek・app-header・resize 永続化・問題文 editable)はどの task でも触れない。✓
- **Placeholder scan:** なし(size の具体値は spec で「code 定数・tunable」と明記済の意図的初期値)。✓
- **Type consistency:** `AppContainer` 署名 T1↔T2 一致 / `OptionsReadonlyCell({options: ClientCardOption[]})` T4 / InlineTextField props は既存署名どおり / `meta.sticky` の参照は既存 render ロジック踏襲。✓
