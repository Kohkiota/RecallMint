# Notion 式テーブル S5 — 列固定(column pinning)design(spec / 凍結対象)

- 作成: 2026-07-05 / branch: develop / 起点 HEAD: 90c44a1(S4 完了・stg smoke pass 後)
- 設計方針は OT brief で確定済。fact-finding(§2)は本セッションで現 HEAD + installed @tanstack/table-core 8.21.3 の実物 d.ts/js に照合済。

## 1. 目的 / 背景

横スクロール時に基準列(タイトル等)を見失う問題を、Notion の「その列まで固定」方式の**ユーザー選択式・左固定**で解決する。ヘッダーメニューに「固定表示」項目を追加し、押した列＋それより左の全列を左 sticky にする。固定境界は examViewPrefs V3 に永続する。

前史: Fix-3 T2(commit 4cb9fe7)で select+title の**決め打ち** sticky 固定を「Notion 準拠で固定しない」理由で撤去した。S5 はユーザーが境界を選ぶ方式のためこの撤去方針と矛盾しない(決め打ち固定はしないまま)。`exam-card-table-columns.tsx:7` の撤去コメントは本 sprint で現状化する。

## 2. 現状の実コード事実(fact-finding・8.21.3 実物照合済)

- table 状態: `rowSelection/sorting/columnFilters/columnSizing` = ExamCardTable 内 useState(非永続)、`columnVisibility` のみ exam-detail-view 所有の controlled prop + examViewPrefs 永続(S2-5 単一所有 + prefsLoaded/userInteracted guard、exam-detail-view.tsx:64-136)。
- 永続層: `lib/sync/sync-meta.ts` — examViewPrefs は V1(view)/V2(+hiddenColumns)の discriminatedUnion + `examViewPrefsToV2` 正規化。書込は常に最新 version。
- 列幅は CSS 変数配布(Fix-3 T1): `columnSizeVars` useMemo(exam-card-table.tsx:492-504、deps = columnSizingInfo/columnSizing/columnVisibility)が `--header-{id}-size` / `--col-{id}-size` を `<table>` に emit。**resize 中は MemoizedTableBody が memo 凍結**(isResizing comparator)され、CSS 変数のみで視覚追従する。
- table は `border-separate border-spacing-0`(T3)+ thead `sticky top-0 z-10` + th `bg-background`(S2-3)。td は `border-b` のみで**背景なし**、行 hover は `<tr>` の `hover:bg-muted/50`(半透明)。
- 行仮想化は element virtualizer(行のみ・S2-2)。spacer `<tr>` は `colSpan={visibleColCount}` の空 td。
- header menu(ColumnHeaderMenu)は capability-driven Popover: 昇順/降順(canSort 時)+ filterEditor(渡された時)。menu gate = `canSort || filterEditor 有り`(S4-3)。menu を持つ列 = title / sort_key / question / tags / explanation_text / memo / lastCorrect / currentStreak / lastReview の 9 列。**select / options は menu なし**。
- TanStack 8.21.3 の column pinning API(installed d.ts/js 確認済):
  - `ColumnPinningState = { left?: string[]; right?: string[] }` / `onColumnPinningChange: OnChangeFn<ColumnPinningState>`。
  - **`getHeaderGroups()` / `row.getVisibleCells()` は [left(pinning 配列順), center, right] に並び替える**(headers.js / ColumnVisibility.js 実装確認)。left 配列を元の列順で構築すれば視覚列順は不変。
  - `column.getStart('left')` = 自列より前の**可視** left-pinned 列幅の合計(columnSizing に memo 依存 = resize 追従)。`column.getIsPinned()` / `column.getIsLastColumn('left')`(可視 leaf 基準)あり。
  - hidden 列が pinning state に残っても `getHeaderGroups` は可視 leaf との find + filter(Boolean) で**無害に skip**し、可視復帰で自動復活(brief の想定どおり)。

## 3. スコープ(確定)

- ヘッダーメニュー(menu を持つ 9 列)に「固定表示 / 固定を解除」項目を追加。押した列＋それより左の全列を左固定(Notion の「その列まで固定」)。
- select 列は固定境界が 1 つでも引かれている時のみ固定領域の左端に付随。境界なし = select も固定しない(全列スクロール)。select 自身の独立トグルなし(menu なし列のまま)。
- 固定境界 1 本を examViewPrefs V3 へ永続(V1/V2 migration 維持)。
- 視覚境界: 最右 pinned 可視列の th/td に右セパレータ。z 階層 = pinned-header > sticky-header = pinned-body-cell > body。
- **スコープ外**: 右固定(right pinning)/ 列の並び替え(columnOrder)/ select・options 列への menu 追加 / columnSizing・columnFilters の永続化 / card view への影響。

## 4. 設計判断(確定)

### D-1. 状態モデル = TanStack `columnPinning` を exam-detail-view 所有の controlled prop で追加

`columnVisibility` と同型(S2-5 パターン踏襲): exam-detail-view が `useState<ColumnPinningState>({ left: [], right: [] })` を所有し、`columnPinning` / `onColumnPinningChange` を ExamCardTable へ controlled prop で渡す。ExamCardTable は `state` に columnPinning を追加 + `onColumnPinningChange` 配線(既存 state と独立共存)。userInteracted wrap(handleColumnVisibilityChange と同型の handleColumnPinningChange)で spurious write を防ぐ。`right` は常に `[]`(right pinning 非対象)。

### D-2. 境界モデル = 単一 boundary columnId から left 配列を導出(順序保証を構造化)

- 純関数 2 本を `_lib/column-pinning.ts`(新規・小)に置く:
  - `computePinnedLeft(boundaryId: string | null): string[]` — `examCardTableColumns` の module 定義順で先頭から boundaryId まで(select 含む・boundaryId 含む)の id 配列。boundaryId が未知 id(将来の列改廃 / 不正永続値)なら `[]`。
  - `derivePinnedBoundary(state: ColumnPinningState): string | null` — `left` 末尾の id(空なら null)。select のみの配列は発生しない(書込経路が computePinnedLeft のみのため)が、末尾が 'select' の場合も null に落とす(防御は導出 1 箇所に集約)。
- **left 配列は必ず computePinnedLeft 経由で書く**(menu handler / load 復元の 2 経路とも)。§2 のとおり getHeaderGroups は pinning 配列順に並べるため、この導出一元化が「視覚列順不変」の構造的保証になる。`column.pin()` は使わない(単列 append であり境界 semantics と不一致)。
- select 付随(brief 確定)はここで実現: boundary 非 null → left = ['select', ...] / null → []。

### D-3. menu 項目とラベル(Notion 準拠・境界移動 1 操作)

- ColumnHeaderMenu に props `pinning?: { isBoundary: boolean; onSelect: () => void }` を追加(capability-driven 維持: 渡された時のみ固定節を render)。配置 = 昇順/降順の下・filterEditor の上。click 後 `setOpen(false)`(sort 項目と同規約)。
- ラベルと動作:
  - **boundary 列自身** → 「固定を解除」→ boundary = null(全解除)。同一列の再押下 = トグルという brief 文言と一致。
  - **それ以外(未固定列・固定済みだが非境界の列)** → 「固定表示」→ boundary = その列。固定済み非境界列で押すと境界がその列へ**縮小移動**(Notion の Freeze up to this column と同挙動・1 操作で境界移動)。
- 親(exam-card-table.tsx の th render)が `pinning` prop を組み立てる: menu を出す全列に渡す(gate 変更なし — menu gate は S4 の `canSort || filterEditor` のまま)。handler は `onColumnPinningChange({ left: computePinnedLeft(id), right: [] })` / 解除は `computePinnedLeft(null)`。

### D-4. 永続 = examViewPrefs V3(discriminatedUnion 拡張)

- `examViewPrefsV3Schema = { version: 3, view, hiddenColumns, pinnedBoundary: string | null }`(`.strict()`・zod)。読み取り union に V3 追加、書込は常に V3。
- `examViewPrefsToV2` → `examViewPrefsToV3` に置換(呼び出しは exam-detail-view 1 箇所): V1/V2 → `pinnedBoundary: null`。
- load(exam-detail-view mount effect): `pinnedBoundary` → `setColumnPinning({ left: computePinnedLeft(pinnedBoundary), right: [] })`。未知 id は computePinnedLeft が [] に落とす(load 時無害化)。
- persist effect: 既存 effect の deps に columnPinning を追加し `pinnedBoundary: derivePinnedBoundary(columnPinning)` を書く。hidden 列を boundary にしたまま隠しても boundary は保存継続(可視復帰で復活 = brief 確定)。

### D-5. sticky 描画 = 既存 CSS 変数パターンに left offset を追加

- `columnSizeVars` を拡張: left-pinned 可視列に `--col-{id}-start`(= `column.getStart('left')`)を追加 emit。deps に `table.getState().columnPinning` を追加。**resize 中の memo 凍結 body でも pinned offset が CSS 変数でリアルタイム追従**する(既存 Fix-3 T1 パターンの延長。getStart は columnSizing に memo 依存 = drag 中も再計算される)。
- th(pinned): `sticky z-10` + `style.left = calc(var(--col-{id}-start) * 1px)`。縦は thead の `sticky top-0 z-10` が既に担い、横は th 自身の sticky left — 交差セルは両 sticky の合成で成立(brief 確定)。`bg-background` は既存。thead 内 stacking で pinned th(z-10)> 非 pinned th(z-auto)。
- td(pinned): MemoizedTableBody の td render に分岐追加 — `sticky z-[1]` + 同 left 変数 + **不透過背景必須**(下を通過する非 pinned セルの透け防止)。
- z 階層(brief 確定): thead(z-10)= pinned-header 帯 > pinned td(z-[1])> 非 pinned td(z-auto)。thead が table レベルで td 帯より上のため pinned-header > pinned-body は自動成立。既存 z-30(scroll-top)/ z-40(action bar)/ Popover(portal)とは干渉しない。
- 行 hover の色一致: `<tr>` に `group` を付与し、pinned td = `bg-background group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]`(非 pinned セルの `hover:bg-muted/50` over background と同色の不透過合成。token 名は globals.css:49,59 の `--background` / `--muted` に照合済)。半透明のままだと sticky 下の scroll 内容が透けるため不透過が必須。色味の最終確認は stg smoke(合わなければ近似 token へ倒す判断は OT)。

### D-6. セパレータ = 最右 pinned 可視列に border-r

`column.getIsLastColumn('left')`(可視 leaf 基準 = hidden boundary でも正しく最右可視列に付く)で判定し、th/td 両方に `border-r border-border` を付与。縦罫線が他にないため静的 border で境界視認可。scroll 連動 shadow は導入しない(YAGNI — stg smoke で視認不足なら follow-up 起票)。

### D-7. virtualizer / spacer との直交

行仮想化は行のみ対象で列 pinning と非干渉(brief 確定)。spacer `<tr>` の td は colSpan 全幅・非 sticky・空のまま(高さのみで視覚影響なし)。変更不要。

### D-8. コメント現状化

`exam-card-table-columns.tsx:7` の Fix-3 T2 撤去コメントを「決め打ち固定はしない(不変)。S5 でユーザー選択式 pinning を導入」に更新。

## 5. アーキテクチャ(変更 file 一覧)

- `_lib/column-pinning.ts`(新規): computePinnedLeft / derivePinnedBoundary + unit test。
- `lib/sync/sync-meta.ts`: V3 schema + union 拡張 + examViewPrefsToV3(+ test)。
- `exam-detail-view.tsx`: columnPinning state 所有 / load / persist / userInteracted wrap / props 配線。
- `exam-card-table.tsx`: state 配線 + columnSizeVars 拡張 + th sticky 分岐 + pinning prop 組み立て。
- `exam-card-table-header-menu.tsx`: pinning 節追加。
- MemoizedTableBody(exam-card-table.tsx 内): td sticky 分岐 + tr group。
- `exam-card-table-columns.tsx`: 冒頭コメント現状化のみ(ロジック不変)。
- 対応 test(helper / schema / menu / th・td 配線)。

## 6. Global Constraints(実装厳守)

- 既存挙動不変: ソート群(S3)/ テキスト・タグ・回答状態・streak フィルタ(S4 以前)/ 列可視 + V2 永続互換 / resize(CSS 変数・memo 凍結)/ S2b collapse / 行仮想化 / 選択・bulk 操作。
- 固定なし(boundary null)時の DOM/挙動は現状と完全一致(sticky/z/border の追加 class は pinned 列のみに付く)。
- 固定 px 禁止(left offset は列幅由来の計算値で可)。YAGNI・既存パターン踏襲・scope 外リファクタ禁止。`--no-verify` 禁止・push は OT。

## 7. 検証方針(概要・詳細は plan)

- 各 task = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"`(+ lib/sync)全 green + canonical + Codex 両者 Crit/Imp 0 → `[reviewed]` commit。
- helper unit: computePinnedLeft(通常 / boundary=null / 未知 id / select 付随 / 全列 boundary)・derivePinnedBoundary(往復同一性 / 空 / select 単独→null)。
- schema unit: V1/V2/V3 読み取り + toV3 正規化 + V3 書込 + 不正値 reject(既存 sync-meta.test.ts 拡張)。
- 配線 unit(jsdom): menu 項目の出し分け(boundary 列=解除 / 他=固定表示)/ 押下で onColumnPinningChange に期待配列 / pinned th・td に sticky class + left 変数 style + separator / boundary null で追加 class ゼロ / exam-detail-view の load→復元・変更→persist(V3 書込値)。
- jsdom 不能領域(実 sticky 交差・横スクロール実挙動・hover 色)は stg smoke。
- 完了 gate: whole-repo `pnpm lint --max-warnings=0` exit 0。
- **stg smoke(OT push 後・CC 裁量)**: ① タグ列で「固定表示」→ select〜タグの 6 列が横スクロールで固定・境界 border 視認 ② 境界移動(固定済み左列で固定表示)③ 解除で全列スクロール ④ reload で境界復元(V2→V3 migration 含む)⑤ boundary 列を hidden→復帰 ⑥ resize 中の pinned offset 追従 ⑦ 行 hover 色の pinned/非 pinned 一致 ⑧ 縦スクロール併用(交差セル)⑨ 300-card 体感。証拠添付。

## 8. リスク

- **R1**: 縦(thead)× 横(th)sticky 交差のブラウザ差・border-separate との相性。→ border-separate は sticky に好都合(既採用)。実挙動は stg ⑧。
- **R2**: pinned td の背景処理ミスで hover 時に下のセルが透ける。→ D-5 の不透過 + color-mix。stg ⑦。
- **R3**: resize 中の pinned offset 凍結(memo body)。→ CSS 変数 emit(D-5)で構造的に解消。stg ⑥。
- **R4**: pinning 配列順 ≠ 列順による視覚列順崩れ。→ 書込経路を computePinnedLeft に一元化(D-2)で構造的に排除。
- **R5**: V3 追加による既存 prefs 破壊。→ discriminatedUnion + toV3 + 既存 test 拡張(V1/V2 読み取り不変を固定)。
- **R6**: 全列を boundary にした場合(全列 pinned)の余剰 sticky。→ 無害(スクロール余地なし or 通常フローと同視覚)。Notion も最終列まで許容。stg ①系で目視のみ。
