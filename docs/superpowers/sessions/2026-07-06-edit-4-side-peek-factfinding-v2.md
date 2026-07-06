# Edit-4 side peek 事実確認 v2(S1〜S5 反映後・実装前 fact-finding)

- 日付: 2026-07-06
- 目的: side peek(Edit-4 表示 / Edit-4b 編集)実装前の実コード事実確認。実装・commit なし(OT 指示)。
- 手法: Explore agent 5 体並列(単票 UI / 行操作 / パネル土台 / 書込経路 / モバイル・perf)+ 既存 spec/plan 突き合わせ。
- 旧文書: `docs/superpowers/specs/2026-06-30-edit-4-side-peek-design.md`(凍結 spec・表示専用)/ `docs/superpowers/plans/2026-06-30-edit-4-side-peek.md`(**未確定ドラフト**・Codex cross-check 2 回済)。

## 0. 旧 spec/plan の失効点(最重要)

旧 spec(6/30)凍結後、S1〜S5(7/3〜7/5)で exam テーブル系が +7,900 行規模で変化:

| 旧 spec の前提 | 現状 |
|---|---|
| document scroll 既定・sticky header は Edit-5 で別途 | **app-shell 密封済**(`exam-detail-view.tsx:236-239` `table-app-shell` = `height: calc(100dvh - shellTop)` 縦 flex)+ sticky thead 実装済(S2-3) |
| filter bar(:352-360) | **condition-bar に置換**(`exam-card-table-condition-bar.tsx`、scroll collapse `grid-rows-[0fr|1fr]`) |
| `overflow-x-auto` table ブロック :361 | **`overflow-auto` 単一スクロールコンテナ**(`exam-card-table.tsx:618-622`)+ **TanStack Virtual 行仮想化**(`:131-138`, ESTIMATED_ROW_HEIGHT=120) |
| 列固定なし | **S5 column pinning 実装済**(pinned td `sticky z-[1]` `:205`、pinned th `z-10` `:665`)+ examViewPrefs V3 |
| 行番号参照(:68/:290-310/:361 等) | 全て失効(exam-card-table.tsx は 633 行規模で改変) |
| 「md:flex 2 カラム(push)+ 自前リサイズ」レイアウト | 縦 flex 密封シェル前提が変わり再設計要(§3) |

また新方針(design-policy §3.3「解説・メモのフル編集、長文確認、単票集中編集」)は旧凍結スコープ(表示専用・タグ/メモ出さない・judged 確認ビュー)と**内容が異なる**。design-policy 文書自体はリポジトリ内に存在しない(OT 側文書と推定)。

## 1. 単票 UI の実態(Q1)

- **S2-0 の単票編集 page(`/app/cards/[id]` + `card-editor.tsx`)は廃止済・現存しない**(commit `b73512b`、`app/(app)/app/exams/[id]/page.tsx:8-10` に明記)。`SingleCard` 相当の named component は存在しない。
- 現存の「1 枚のカード UI」3 系統:
  - **`InlineCardList`**(card view、`inline-card-list.tsx:64`): 1 枚分ブロック(`:280-373`)が事実上の単票編集 UI。**全フィールド編集可**。
  - **`ExamCardTable`**(table view): 同じ編集プリミティブをセルに再利用。
  - **`SessionRunner`**(study、`session-runner.tsx:138`): judged 表示(正解ハイライト・○×・解説)を持つが**表示+回答専用**・route 密結合。
- 編集可能フィールド(InlineCardList 1 枚分): sort_key / title / tags(CardTagsSection)/ question_text / options[].text / options[].id / options[].explanation / options[].is_correct(checkbox)/ 選択肢追加削除 / explanation_text / memo / カード削除。`correct_answer_ids` は is_correct から再生成(UI 直接編集なし)。
- テーブル inline(Edit-1〜3)との差分: **選択肢 ID 編集のみテーブル側に無い**(`CompactOptionsCell` は text/explanation のみ、`exam-card-table-options-edit-cell.tsx:54,81`)。それ以外の編集項目は両ビュー完全重複(同一プリミティブ `InlineTextField` / `InlineOptionCell` / `useCardOptions` / タグ系を共有)。
- side peek 固有になりうるもの = ①長文の広い編集面(テーブルセルは幅制約)②選択肢 ID 編集 ③judged 風確認表示(SessionRunner :424-494 の複製が必要 — 既存単票 UI には無い)。
- プリミティブは **container 非依存で再利用可**(cardId + 値 + callback を props で受け、書込は Dexie singleton 経由)。`InlineCardList` の 1 枚分レイアウトがほぼそのまま side peek の雛形になる。

## 2. 開くトリガー(Q2)

- 行 `<tr>` に onClick なし(`exam-card-table.tsx:183-189`、`group hover:bg-muted/50` のみ)。行クリック=選択でもない(選択は checkbox onChange のみ)。
- セルは click-to-edit: `InlineTextField` 表示 div `role="button"` `onClick={startEdit}`(`inline-text-field.tsx:319-324`)、options/tags セルも全て行内クリック要素。**行クリックで peek を開くと startEdit・popover・checkbox と直衝突**(stopPropagation を全セルに撒く必要が生じる)。
- Notion「OPEN」相当の hover アフォーダンスは**未存在**。ただし tr に `group` class 済で、セル内 `opacity-0 group-hover:opacity-100` ボタンは既存パターンで置ける。専用アクション列の新設も `examCardTableColumns` 配列(`exam-card-table-columns.tsx:68`)に足すだけで可(pinning 対象化も可)。
- 旧 spec 凍結判断も「**行クリック不使用・title 列ボタン**(desktop hover+focus-visible / mobile 常時)」で、現状コードと整合。
- Escape: inline 編集セルに Esc handler なし(blur commit のみ)。Esc 実装は tag popover 系のみ(`card-tag-add-popover.tsx:362-386` 等)。peek の Esc close は新規論点(旧 plan T4 の `defaultPrevented` 案が参考)。

## 3. パネル実装土台(Q3)

- **Sheet/Drawer 相当は未存在**。`components/ui/` は button/card/confirm-dialog(自前 createPortal・z-50)/dropdown-menu/input/label/popover/tabs/textarea のみ。
- **radix 統合パッケージ `radix-ui@1.4.3` に Dialog/AlertDialog が含まれており追加 install 不要**。shadcn 標準 Sheet(radix Dialog ラッパ)を自作する構成が既存 popover/dropdown(radix + Portal + z-50 + `data-open:animate-in`)と一貫。
- アニメーション: `tw-animate-css@1.4.0` 導入済(`globals.css:2`)。`slide-in-from-right`/`slide-out-to-right` + `duration-100` + `motion-reduce:transition-none` が既存パターン。
- レイアウト: app-shell はヘッダー非 fixed の `min-h-screen flex flex-col`(`app/(app)/app/layout.tsx:49-77`)、サイドバー無し。テーブルは `table-app-shell`(`exam-detail-view.tsx:236-239`、`calc(100dvh - shellTop)` 実測 + resize リスナ再測 `:163-173`)内の単一 `overflow-auto` コンテナ(`exam-card-table.tsx:618-622`)。
- **overlay 方式(Portal + `fixed inset-y-0 right-0`)= 干渉最小**。スクロールコンテナ外に描画されクリップされない。
- **push 方式(2 カラム)= 改修コスト大**: 表領域スロットの縦 flex 前提改修 + table が `width: getTotalSize()`(`:631`)固定でテーブル自体は詰まらず横スクロール量が増えるだけ + peek open/close は resize を発火しないため shellTop 再測トリガー追加要。
- z-index 実態: pinned td `z-[1]` / sticky thead・pinned th `z-10` / scroll-top FAB `z-30` / 選択 ActionBar `z-40`(`fixed inset-x-0 bottom-0`)/ popover・dropdown・confirm-dialog・billing-banner `z-50`(最上位帯に密集、z トークン定義なし)。peek は ActionBar・FAB との重なり処置(退避 or z 順)+ peek 内 popover(タグ編集)が z-50 同帯になる点の設計が必要。

## 4. 表示(Edit-4)/ 編集(Edit-4b)の分離要否(Q4)

- 編集プリミティブは**セル単位 display↔edit 内包**(click-to-edit、blur 即 commit、保存ボタン/dirty guard なし)。つまり「編集込み単票」を最初から peek に載せる技術的障壁はない — その意味では 2 段に割る必然性は薄い。
- ただし旧 spec の Edit-4「表示」= **SessionRunner judged 風の確認ビュー(CardView 複製: 正解ハイライト・○×・選択肢別解説)**であり、これは編集 UI(InlineCardList 型)と見た目・部品が別物。
- → 2 段の意味は「表示」の定義に依存:
  - (a) judged 確認ビュー(旧 spec 凍結)なら Edit-4 と Edit-4b は別部品で段階に意味がある(4b で編集面をどう同居させるかは新規設計)。
  - (b) 新 design-policy の「長文確認 + フル編集」なら InlineCardList 流用 1 本で最初から編集込みが最小実装(Edit-4 単独の中間成果物は薄い)。

## 5. 書込経路と live 反映(Q5)

- 書込は**全ビュー共通で分裂なし**: `runOptimisticMutation` / `runOptimisticUpdate` / `runOptimisticCreate`(`lib/sync/optimistic-mutation.ts:72-287`、mirror + outbox を 1 Dexie rw tx、失敗は auto-rollback)+ `enqueueEntityMutation`(coalesce、`lib/sync/entity-mutations.ts:69-123`)→ `/api/entity-mutations/bulk`。
- タグ canonical = `useCardTagToggle`(`_hooks/use-card-tag-toggle.ts:71-130`、multi-store tx 直張り)。テーブルは **table レベル 1 回 instantiate + `getCardContext(cardId)` getter 配布**(`exam-card-table.tsx:327-340`)が canonical(単一 subscription 則)。
- live 反映: テーブルは `useLiveQuery` 4 store 1 subscription(`exam-card-table.tsx:296-312`)→ `joinCardTags` → data。**peek が同 cardId の mirror を書けば自動で行再描画 — 追加同期配線ゼロ**。
- peek 側の表示ソース注意点: ①手元 `data.find(r => r.card.id === activeCardId)` で渡すのが既存慣習(独自 `useLiveQuery` を peek に持たせると二重 subscription — card/table view は conditional unmount で 1 本維持している)②`useCardOptions(cardId, serverOptions)` は serverOptions ref 変化で merge 駆動 = live data 由来 options を渡せばそのまま効く ③`key={cardId}` remount で autoEdit/state リセット(InlineCardList も `<li key={card.id}>`)。
- エラー処理既定: フィールド編集は silent(logger.warn + 次回 pull reconcile)、明示アクション(追加/削除/タグマスタ)は `throwOnError:true` + inline error UI。

## 6. モバイル分岐(Q6)

- **既存カード画面への route は廃止済で現存しない**(§1)。「モバイル = full page 遷移」には**新規 route が必要**(旧 plan T5 = `app/(app)/app/exams/[id]/cards/[cardId]/page.tsx`、client `db.cards.get` + user_id/exam_id 検証案。Codex cross-check で認可・loading/not-found 論点整理済)。
- 代替解釈: card view(InlineCardList)がモバイルで実質単票編集を既に提供しており、「モバイルは card view へ誘導(route 新設なし)」という割り切りも選択肢。
- 出し分けパターン: **CSS breakpoint のみ**(`hidden md:grid` / `md:hidden`、参照実装 `tags/_components/tag-manager-shell.tsx:52,66`)。useMediaQuery/matchMedia 前例ゼロ(旧 spec も JS viewport 判定禁止を凍結)。
- notion-table はモバイルでも同一テーブル(内部横スクロール + `md:` タッチターゲット調整のみ)。モバイル行タップの既存挙動 = セル単位 click-to-edit。

## 7. 件数とパフォーマンス(Q7)

- **カード枚数のプラン上限なし**(制限は AI OCR 月次ページのみ: free 30 / standard 300 / pro 無制限、`lib/auth/plan-limits.ts:10-14`)。1 upload 上限 40 ページ(`lib/ai/ocr-limits.ts:4`)、生成件数は文書依存。
- 実態基準: seed 300 cards/exam(`scripts/seed-perf-exam.ts:282`)、stg smoke も 300 件基準。user 全体 ~2k 想定(`client-db.ts:287-290`)。行仮想化済。
- **テーブル行は Dexie フル行(projection なし)**: `db.cards.where('exam_id').equals(examId).toArray()`。`ClientCard`(`client-db.ts:70-100`)に title/sort_key/question_text/options(全文+選択肢別解説)/correct_answer_ids/explanation_text/memo/images/FSRS 系まで**単票表示に必要な全フィールドが既在 → peek 開時の追加 fetch 不要**(タグも join 済 data or `getCardContext` 再利用)。
- 開閉コスト = `data.find` 1 回(実質ゼロ)。SSR 側 `getCardsForExam` の 7 列 projection は InlineCardList の bootstrap fallback 専用でテーブル/peek には無関係。

## 8. 論点(OT 判断向け)

1. **旧 spec/plan の扱い**: 旧 plan は未確定ドラフトのまま前提失効(§0)+ 新 design-policy とスコープ矛盾(表示専用 vs フル編集)。spec 改訂(または新 spec)→ codex-plan-review 再走が必要。
2. **Edit-4/4b 分割の意味**(§4): 「表示」= judged 確認ビューなら 2 段に意味あり。「長文確認」なら編集込み 1 本が最小。
3. **overlay vs push**(§3): 旧 spec は push(2 カラム + リサイズ)凍結だが、S2 app-shell 密封後は overlay の方が低リスク・低コスト。push は shellTop 再測 + 縦 flex 改修 + テーブル詰まらない問題。
4. **モバイル遷移先**(§6): 新規 route 新設(旧 plan T5 案)vs card view 誘導の割り切り。
5. **z-index / ActionBar 干渉**(§3): peek の z 帯設計と選択 ActionBar(z-40 fixed bottom)との共存。
