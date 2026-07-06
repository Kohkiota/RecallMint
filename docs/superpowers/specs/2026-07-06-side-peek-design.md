# side peek(統合 1 本): テーブル行の単票編集パネル

- 作成: 2026-07-06
- 種別: spec(design record)。plan は本 spec を起点。
- 前提: S1〜S5(notion-table 再構築)反映済。fact-finding = `docs/superpowers/sessions/2026-07-06-edit-4-side-peek-factfinding-v2.md`。
- **旧 Edit-4 spec/plan(2026-06-30・表示専用 2 段構成)は失効・破棄**(OT 確定)。本 spec が唯一の正。
- spec 凍結。仕様変更が要るなら停止して OT 相談。

---

## 1. 目的 / ゴール

試験詳細テーブルの行から単票を右スライドパネル(side peek)で開き、**開いたら見える・セルクリックでその場編集**(click-to-edit)を単票の全項目で行う。表示専用の中間モードは作らない(Edit-4 / Edit-4b の 2 段分割は廃止・統合 1 本)。

side peek の価値 = 長文(解説・メモ)のフル編集・長文確認・単票集中編集。table = 一覧横断編集、peek = 単票深掘り、の補完関係。

---

## 2. 全体ルール / 制約

- 各 task 完了条件 = ① 該当 unit/component test green ② canonical + Codex 両 Critical/Important 0 ③ `[reviewed]`。
- **書込経路は全ビュー共通経路のみ**: `runOptimisticUpdate` / `runOptimisticCreate` + `useCardTagToggle`(canonical)。新 helper・server action・別経路を作らない。
- **既存 click-to-edit プリミティブ(`InlineTextField` / `InlineOptionList`(`InlineOptionCell` / `useCardOptions`)/ `CardTagsSection`)をそのまま peek 内に載せる**。fork・縮退変種を作らない。
- **追加 dep ゼロ**(radix-ui@1.4.3 同梱 Dialog + tw-animate-css)。追加 fetch ゼロ(手元 row 流用)。同期コードゼロ(useLiveQuery 自動反応)。
- 全 read/write は `user_id` scope 維持。既存テーブル挙動(セル click-to-edit / 選択 checkbox / 列 toggle / sticky / pinning / virtualizer)を壊さない。
- 簡潔性規律(CLAUDE.md 横断)厳守。タスク範囲外を触らない。
- Test: Vitest + RTL。`git commit --no-verify` / `-n` 全面禁止。

---

## 3. 確定した設計判断

### 3.1 OT 確定(brief 由来)

1. **統合 1 本**(表示/編集 2 段廃止)。click-to-edit プリミティブを peek に直載せ。
2. **overlay 方式**(Portal + fixed right + slide-in)。push(2 カラム)不採用。
3. **行クリック不使用**(セル click-to-edit と直衝突)。専用トリガー新設(具体案は §3.3 = CC 設計)。
4. **書込 = 共通経路**、useLiveQuery で peek 編集がテーブル行へ即反映(追加配線不要)。
5. **編集範囲 = 単票の全項目**(タイトル / sort_key / 問題文 / 選択肢(テキスト・ID・選択肢別解説・正解切替・追加削除)/ タグ / 解説 / メモ)。
   - 注: brief の列挙に問題文・選択肢 ID は明示されないが「単票の全項目」= `InlineCardList` 1 枚分(`inline-card-list.tsx:280-373`)と同一集合と解釈(問題文抜きの単票編集は成立しないため)。OT レビューで要確認。
   - **カード削除ボタンは載せない**(brief スコープ外。テーブルの bulk 削除が既存経路。peek 中の削除は §3.6 prune が閉じるので技術障害はなく、要望が出たら 1 行追加で足せる)。
6. **モバイル = 全幅 overlay(案 b)を推奨**(§3.7 比較)。

### 3.2 パネル本体: radix Dialog **non-modal**(`modal={false}`)+ backdrop なし

- **modal にしない理由**: modal は scroll lock + focus trap + backdrop でテーブルが暗転・操作不能になり、「peek 編集がテーブル行へ即反映」の価値と、peek を開いたままテーブル側もセル編集する併用ワークフローを殺す。Notion の side peek も non-modal。
- radix Dialog を使う理由(素の fixed div と比較): Portal / `role="dialog"` + aria / open 時の focus 移動 / **Esc の layer 処理**(peek 内で tag popover 等を開いた時、Esc が最内層のみ閉じる dismissable layer stack)が既存実装で手に入る。旧 plan の手動 `defaultPrevented` 配線が不要になる。
- `Dialog.Overlay` は描画しない(backdrop なし・テーブル可視のまま)。
- **閉じ方 = × ボタン + Esc のみ。外クリックでは閉じない**(`onInteractOutside` は preventDefault)。理由: 外クリック close はテーブル側セル編集クリックのたびに peek が閉じ、併用ワークフローと矛盾。旧 plan の「閉じない領域 ref 台帳」も丸ごと不要化。開いている行のトリガー再クリックは close(toggle)。
- Esc とセル編集の関係: `InlineTextField` は Esc handler を持たない(blur commit のみ)ため、peek 内 input 編集中の Esc は panel close → blur commit で**値は保存されて閉じる**(破壊なし)。tag popover 等 radix 系は layer stack が先に消費する。この挙動を仕様として明記(追加ガードは書かない)。
- 入退場: `tw-animate-css` の `data-open:slide-in-from-right` / `data-closed:slide-out-to-right`。duration は `duration-200`(既存 popover 系は duration-100 だがパネルは大型のため)+ `motion-reduce:transition-none`(既存慣習)。

### 3.3 開くトリガー = **専用列(非 hideable)**

- **新列 `open` を select 列の直後に追加**(`examCardTableColumns` 配列)。幅 36px 固定・`enableHiding: false`・`enableSorting: false`。セル内容 = icon button(lucide、`aria-label="カードを開く"`)**常時表示**。click で `meta.setActiveCardId(card.id)`(既存 table meta 配線パターン)。開いている行の再 click は close。
- **title 列ボタン案(旧 spec 凍結案)を不採用にした根拠**: title 列は hideable(column toggle の除外は `select` のみ、`exam-card-table-column-toggle.tsx:35`)。title 非表示にするとトリガーごと消え peek へ到達不能になる。専用列は列 toggle から除外(select と同パターン)し常時到達可能。
- 既存挙動との非衝突: 専用セルは click-to-edit 要素・checkbox・popover trigger のいずれとも別セル = 伝播衝突なし(stopPropagation 不要)。行 `<tr>` に onClick は引き続き置かない。
- 列 toggle(`deriveColumnToggleMeta`)の除外に `open` を追加。列 pinning 境界計算(S5 `computePinnedLeft`)は列定義追加に自動追従するが、回帰 test で担保。
- キーボード: icon button は natural tab order で到達可(hover 出現式にしないため追加細工不要)。

### 3.4 peek のデータ供給(手元 row 流用・live 追従)

- `ExamCardTable` 内に `const [activeCardId, setActiveCardId] = useState<string | null>(null)` 新設(キー = `card.id`。`rowSelection` と用途直交・同期しない)。
- peek の row = `data.find((r) => r.card.id === activeCardId) ?? null`(`ExamCardRow = {card: ClientCard, tags}` join 済)。**`data` は exam 全件**(`liveData.filteredCards` は user 絞り + sort のみの legacy 名。列フィルタは TanStack 層 `columnFilters` + `getFilteredRowModel`)なので、行がフィルタで非表示でも参照は生きる。
- セル/peek どちらの編集も mirror 書込 → useLiveQuery 再評価 → `data` 再計算 → 両者自動追従。**snapshot・追加 fetch・同期 state を持たない**。
- 選択肢: `useCardOptions(cardId, serverOptions)` へ live row の `card.options` を渡す(既存 merge 駆動がそのまま効く)。
- タグ: `CardTagsSection` を card view と同 props 形で再利用(`cardTags` = row.tags 由来、context は既存 `getCardContext` 流用)。書込は canonical `useCardTagToggle`(hook 内 useLiveQuery なし制約を維持)。
- **`key={activeCardId}` で peek 内容を remount**(カード切替時に編集 state / autoEdit / working-set をリセット。`InlineCardList` の `<li key={card.id}>` と同じ担保方式)。

### 3.5 peek のレイアウト

- `fixed inset-y-0 right-0` 固定幅パネル: **desktop(md 以上)= 480px 固定・リサイズなし**(YAGNI。旧 spec の自前リサイズは廃止スコープごと破棄)。**mobile(md 未満)= 全幅 `w-full`**(§3.7 案 b)。
- パネル内部 = ヘッダー(× ボタン)+ `overflow-y-auto` 本文(単票フィールド縦積み = `InlineCardList` 1 枚分レイアウトを雛形に)。document / テーブルのスクロールは触らない(non-modal・scroll lock なし)。
- 内容は route 非依存の新規 component `exam-card-side-peek.tsx`(`_components/` 配下)。props で row / callbacks を受ける(container 化しない。状態 owner は `ExamCardTable`)。

### 3.6 prune(閉じる条件の整合)

- **カードが `data` から消えた時(= 削除・exam 移動)のみ自動 close**。`activeCardId` が `data` に見つからなければ peek 非描画 + `activeCardId` を null 化。
- **フィルタ・ソートで可視集合から外れても閉じない**(旧 spec からの変更)。根拠: ① `data` は全件なので参照が壊れない ② peek でタイトル等を編集中、自分の編集でテキストフィルタから外れた瞬間に peek が閉じる事故(blur 前の入力破棄)を構造的に排除。rowSelection の可視集合 prune(`exam-card-table.tsx:458-478`)とは目的が異なるため流用しない。
- これ以外の防御コード(空データ fallback 等)を足さない。

### 3.7 モバイル分岐: 2 案比較 → **案 b(全幅 overlay)推奨**

| | 案 a: 新 route `exams/[id]/cards/[cardId]` | 案 b: peek をモバイル全幅 overlay |
|---|---|---|
| 新規コード | page.tsx + 認可(user_id+exam_id)+ loading/not-found 区別 + 戻る導線 + lint glob 確認 + page test 一式 | パネル幅の CSS 1 行(`w-full md:w-[480px]`)のみ |
| トリガー側 | desktop onClick / mobile Link の 2 系統出し分け(CSS md: 両置き) | 1 系統(onClick のみ) |
| 工数 | 1 task 強(旧 plan T5 相当 + トリガー分岐) | ほぼゼロ(overlay 実装に内包) |
| UX 差分 | URL 共有可・ブラウザ戻るで閉じる | URL なし・戻るは × / Esc(ブラウザ戻るはページ離脱) |
| リスク | 認可漏れ・not-found 点滅など新規面 | mobile キーボード + fixed overlay の干渉(smoke で確認) |

- **推奨 = 案 b**(OT 指示「小さい方を推奨」)。モバイルのフル編集はカードビュー(`InlineCardList`)が既に提供しており、mobile peek は補助経路。design-policy §3.3「モバイル = full page 遷移」からの逸脱になる点は OT 最終判断(逸脱を許容しないなら案 a を別 task で追加可能 — 案 b 採用が案 a の将来追加を妨げない)。
- 案 b 採用時、JS viewport 判定(useMediaQuery 等)は導入しない(CSS breakpoint のみ。既存慣習)。

### 3.8 z-index / ActionBar 共存

- 現行台帳(全て Tailwind 直書き・トークンなし): pinned td `z-[1]` / sticky thead・pinned th `z-10` / scroll-top FAB `z-30` / 選択 ActionBar `z-40` / popover・dropdown・confirm-dialog・billing-banner `z-50`。
- **peek パネル = `z-[45]`**(ActionBar より上・popover/dialog 帯より下)。効果:
  - peek 内で開く tag popover / confirm-dialog(z-50・Portal で body 末尾)はパネルより上に出る。
  - 選択 ActionBar(z-40 fixed bottom 全幅)は peek 開時、右端 480px がパネルに覆われるが左側で bulk 操作は継続可能(bulk と単票編集は直交ワークフローのため特別対応しない — これを仕様として明記)。
  - scroll-top FAB(`fixed right-6 bottom-4 z-30`)は peek 開時パネルに覆われる。許容(peek 側は自前スクロール、テーブルのスクロールはパネル外で継続可能。FAB 退避は scope 外)。
- **z-50 帯の全面整理(リナンバー)はしない**(触ると回帰面が広い。台帳の文書化 + peek 用 `z-[45]` 新設のみ = 最小)。

---

## 4. スコープ外(OUT)

- パネルのリサイズ・幅永続(examViewPrefs 不変)。
- 新 route `exams/[id]/cards/[cardId]`(案 b 採用時。OT が案 a を選べば別 task 起票)。
- カード削除ボタン・カード追加を peek に載せる。
- judged 風確認ビュー(CardView 複製)— 旧 Edit-4 の遺物。学習確認は study 画面の責務。
- FAB / ActionBar の退避・レイアウト変更。z-index の全面リナンバー。
- SessionRunner / InlineCardList / exam-detail-view の view 切替・既存テーブル列(open 列追加を除く)の変更。
- 行クリック・行 hover トリガー。JS viewport 判定 hook。

---

## 5. テスト方針(Vitest + RTL)

- open 列: トリガー存在・click で peek 表示・再 click で close・列 toggle 一覧に `open` が出ない・pinning 境界回帰。
- peek 本体: activeCardId の card 内容表示 / `InlineTextField` 等プリミティブが正しい props(cardId/field/userId)で render / × と Esc で close / 外クリック(テーブルセル click)で**閉じない** / `key` remount(カード切替で編集 state リセット)。
- live 追従: data 更新 → peek 表示反映(既存 exam-card-table.test.tsx のパターン踏襲)。
- prune: data から削除 → close + null 化。**columnFilters で行が非表示になっても閉じない**。
- 書込: peek 内編集が `runOptimisticUpdate` 経由で mirror に書かれる(既存プリミティブの test 資産があるため、peek 側は配線検証に留める)。
- 実機系(slide-in アニメ・mobile 全幅・キーボード・z 重なり・ActionBar 共存)は sprint 末 stg smoke(DevTools MCP)に集約。

---

## 6. Open Questions(OT レビュー時判断)

1. **§3.1-5**: 編集範囲 = `InlineCardList` 1 枚分と同一(問題文・選択肢 ID 含む)の解釈で確定可か。
2. **§3.7**: 案 b(モバイル全幅 overlay)採用 = design-policy「モバイル full page 遷移」からの逸脱を許容するか。
3. **§3.3**: トリガー = 専用列(常時表示 icon・非 hideable)で確定可か。対抗 = title セル内 hover ボタン(旧案。title 列が hideable なため到達不能ケースあり・不採用推奨)。
