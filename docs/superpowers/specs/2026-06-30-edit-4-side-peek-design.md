# Edit-4: テーブル side peek(表示専用 / desktop 2カラム + mobile full-page)

- 作成: 2026-06-30(改訂: 確定スコープへ全面書き直し)
- シリーズ: 編集ビュー再構築 Edit-4(テーブルビューに「行の中身を回答画面風に確認する」従ビューを足す)
- 種別: spec(design record)。plan は本 spec を起点。
- 前提: Edit-1 / Edit-2 反映済(11 列・editable cell 7・columnVisibility)。改訂 fact-finding 報告を起点。本 spec は実装せず。
- スコープは OT 凍結済(§3)。spec はこれを動かさない。仕様変更が要るなら停止して OT 相談。
- **sticky header は Edit-4 に含めない(Edit-5 で別途)。ページ縦スクロールは現状 document 既定のまま触らない。**
- **編集化は別 sprint(Edit-4b)。本 sprint は表示専用。**

---

## 1. 目的 / ゴール

試験詳細テーブルビューで、行の内容を**回答画面 judged 風(問題文・選択肢の正解ハイライト・○×・選択肢別解説・カード解説)で確認**できるようにする。table = メイン編集面、side peek = 従(確認専用)。

- desktop: 右 side peek(2カラム・リサイズ可)。mobile: full-page 遷移で同じ確認ビュー。
- side peek は **table view 内に閉じる**。カードビュー(InlineCardList)は無影響で温存。

---

## 2. 全体ルール / 制約

- 起点は spec のみ。spec 凍結。
- 各 task 完了条件 = ① 該当 unit/component test green ② canonical(`superpowers:requesting-code-review`・template 改変なし)+ Codex 独立レビュー両者 Critical/Important 0 ③ `[reviewed]`。
- **表示専用**。peek/full-page に編集・保存・dirty 管理を載せない。**container 化しない**(状態を持つのは `ExamCardTable` のみ。full-page route は server/client で card を引き CardView に渡すだけ)。
- **簡潔性規律(横断)厳守**:
  - presentational のみ。**型変換マッパを作らない**(`ClientCard` をそのまま CardView に渡す。問題文・選択肢・正解 `options[].is_correct`・解説は既存型に有り。fact-finding §3)。
  - **同期コードを足さない**(peek は live `data` から引くだけ。§4.4)。
  - **prune 以外の防御コードを足さない**(空データ fallback も足さない。§4.7)。
  - **リサイズは自前最小**(部品ライブラリ追加しない。新 dep ゼロ)。
  - **PullGate 等の過剰防御を足さない**(mobile full-page は read-only ゆえ pull 不要。§4.6)。
  - タスク範囲外を触らない(ついで refactor 禁止)。
- **カードビュー(`InlineCardList`)・`exam-detail-view` の card/table 分岐(L100-109)は不変**。**SessionRunner 本体不変**(CardView は複製であり共有抽出しない)。
- 全 read は `user_id` scope 維持(既存 `liveData` 経路 + full-page は `db.cards.get` 後 `user_id` 検証)。
- Test: Vitest + RTL。AI/課金は非該当。`git commit --no-verify` / `-n` 全面禁止。

---

## 3. 確定した設計判断(OT 凍結)

1. **表示専用 side peek**。編集は載せない(編集化は Edit-4b)。回答画面 judged 状態を再現して確認できれば充足。
2. **CardView = SessionRunner の judged 表示部の複製**(共有でなく複製・SessionRunner 本体不変)。除去 = 全 footer handler / FSRS 採点 / outbox 書込 / 完了 flush effect / error・tally / 選択肢の toggle・disabled・aria-pressed / **判定 banner(採点表示なし)** / 進捗 header。**型変換マッパ不要**(ClientCard そのまま)。**desktop peek と mobile full-page で CardView 共有**。
3. **開く trigger = title 列ボタン**(行クリックは使わない=cell click-to-edit との bubble 競合回避)。**desktop = hover 表示 + focus-visible + aria-label / mobile = 常時表示**。
4. **desktop = 2カラム(左 table / 右 peek)**。**リサイズ可**(自前 window listener・min/max clamp・mount 中のみ listener で cleanup 厳守・新 dep なし)。**幅は非永続**(セッション state。examViewPrefs v3 化しない)。
5. **mobile = side peek 非提供。「開く」→ full-page 遷移**。新規 route `app/(app)/app/exams/[id]/cards/[cardId]/page.tsx`。**CSS 出し分け** = mobile `<Button asChild><Link prefetch={false}>` / desktop `<Button onClick>`、両方常時 render + `hidden`/`md:hidden`。**単票データ = client `db.cards.get` + `user_id` 検証**(新 server helper 不要)。full-page 滞在中 read-only ゆえ **pull 不要(PullGate 追加しない)**。
6. **アクティブ行 = 青枠**(`box-shadow inset`、pin セルまたぎで連続。rowSelection 無塗りゆえ非衝突)。`getVisibleCells` の index 0/末尾判定で左右縦線。
7. **閉じ方 = peek 外クリック + peek 内 × + Esc**。
8. **空データ fallback なし**(judged 描画の自然な結果。`options=[]`/解説空/問題文空は空のまま)。

---

## 4. fact-finding を起点にした設計判断(各点「現状」→「Edit-4 でどうするか」)

### 4.1 CardView(judged 表示の複製)
**現状**: 回答画面 judged 表示は `session-runner.tsx` 本体 return に inline 埋込み(L424-494: 問題文 :424-431 / 選択肢 list+正解ハイライト+○×+選択肢別解説 :433-471 / 判定 banner :473-484 / カード解説 :486-494)。`isJudged` が表示分岐の主軸。純関数 `stripPrefix`(:94)。
**Edit-4**: judged 表示を `card` 1 件のみ依存の presentational `CardView` に**複製**(SessionRunner は触らない)。§3.2 の除去対象を全て落とす。選択肢は `<button onClick>` でなく非インタラクティブ `<div>`(`aria-pressed` 除去)。判定 banner(`currentCorrect` = 採点結果依存・回答主体不在)は実装しない。`stripPrefix` は CardView 内に複製(純関数)。タグ・画像は出さない(回答画面に無い)。

### 4.2 active 行 state
**現状**: 行選択系は全て `ExamCardTable` 内 useState。`rowSelection`(:68, `getRowId: row=>row.card.id` :222)は checkbox 複数選択専用。peek 用 active 行 state は net-new。
**Edit-4**: `const [activeCardId, setActiveCardId] = useState<string|null>(null)` を ExamCardTable 内に新設。キーは `card.id`。**rowSelection とは用途直交・同期しない**。

### 4.3 prune(唯一の state 整合)
**現状**: rowSelection に prune effect(:290-310)で「選択 ⊆ 可視集合」維持。
**Edit-4**: active 行がフィルタ/削除で可視集合から外れたら **peek を閉じる**(可視 ID 集合流用で `activeCardId` を null 化)。これ以外の防御コードは足さない。

### 4.4 peek の表示ソース(live 追従)
**現状**: `liveData`(:87-103)は `{filteredCards,categories,options,cardTags}` オブジェクト。join 済み `data: ExamCardRow[]`(:109-113 useMemo、`ExamCardRow = CardWithTags = {card: ClientCard, tags}`、ref 安定)。cell 編集は mirror 直書き→useLiveQuery→data 再計算。
**Edit-4**: peek は snapshot せず `data.find((r) => r.card.id === activeCardId)?.card ?? null` で引く(`liveData` は配列でないので使わない)。cell 編集が data 再計算→peek 自動追従。**追加同期コードなし**。columnVisibility は data source 不干渉ゆえ列 hidden でも peek は全項目を出す。

### 4.5 2カラム shell + リサイズ(desktop)
**現状**: ルート :350 → filter bar(:352-360)/ `overflow-x-auto` table(:361-468)/ ActionBar(:469-479 fixed-bottom)。TanStack 列リサイズは稼働(:224-225)だが**列幅専用で流用不可**。`components/ui/` に split 部品なし、`window.addEventListener('mousemove')` 前例ゼロ、`localStorage`/`sessionStorage` 使用ゼロ(状態は Dexie sync_meta)。
**Edit-4**: :361 の table ブロックを左ペイン、:350 直下〜ActionBar 間に `<div className="md:flex">` ラッパ新設(左 = `width:tableWidth` + 既存 overflow table、右 = peek + 中央ドラッグハンドル)。filter bar / ActionBar はラッパ外。リサイズは自前 `onMouseDown→window mousemove/mouseup→clamp(min/max)→setState`(mount 中のみ listener・`mouseup`/unmount で cleanup 厳守)。**幅は非永続セッション state**(examViewPrefs を触らない)。

### 4.6 mobile full-page route
**現状**: カード単票ルートは無い(旧 `/app/cards/[id]` は 2026-05-27 `b73512b` で廃止=編集 page で用途違い・流用不可)。study 系は SessionRunner(密結合)で流用不可。exam-detail は server fetch(`initialCards` は bootstrap fallback)+ Dexie mirror 主、`ExamDetailPullGate` が滞在中 ambient pull を suppress。`<Button asChild>` で `<Link>` 内包可(`button.tsx:48`)。JS viewport 判定は前例ゼロ。
**Edit-4**: 新規 `app/(app)/app/exams/[id]/cards/[cardId]/page.tsx`。**単票データ = client `db.cards.get(cardId)` + `user_id` 検証**(server helper 不要)→ CardView に渡す。**read-only ゆえ PullGate を追加しない**。CSS 出し分け = mobile `<Button asChild className="md:hidden"><Link href=".../cards/[cardId]" prefetch={false}>` / desktop `<Button onClick className="hidden md:inline-flex">`、両方常時 render(`display:none` 側は不活性で click 競合なし)。**JS viewport 判定を導入しない**。

### 4.7 アクティブ行青枠 / 閉じ方 / 空データ
**現状**: `<table border-separate border-spacing-0>`(:367)、境界は各 td/th の `border-b` のみ。rowSelection の選択時塗りは**存在しない**(tr は `hover:bg-muted/50` のみ :437)。
**Edit-4**: 青枠 = active 行の各 td に `box-shadow inset`(横線連続 + index 0/末尾セルに左右縦線)。box-shadow は stacking 非依存で pin セル(不透明 bg・z-10)をまたいで途切れない。selection 無塗りゆえ視覚衝突なし。閉じ方 = peek 外クリック + peek 内 × button + Esc。空データは fallback を足さず judged 描画の自然な結果に任せる。

---

## 5. スコープ

### 5.1 IN(task 目安。境界は plan で確定)
- **T1** CardView(judged 複製 presentational、card 1 件依存)。
- **T2** activeCardId state + prune(ExamCardTable 内)。
- **T3** 2カラム shell + リサイズ(自前 window listener)+ 幅セッション state。peek は live data 追従。
- **T4** 開く trigger(title 列ボタン、desktop hover+focus-visible+aria-label / mobile 常時)+ active 行青枠 + 閉じ方(外クリック/×/Esc)。
- **T5** mobile full-page route(`cards/[cardId]/page.tsx`)+ CSS 出し分け(Link/button)+ 単票取得(`db.cards.get`+user_id)。

### 5.2 OUT(やらないこと)
- **編集機能**(Edit-4b)。**sticky header / ページ縦スクロール変更**(Edit-5)。
- **CardView の SessionRunner 共有抽出**(複製に限る・本体不変)。
- **型変換マッパ新設** / **同期 state/コード** / **空データ fallback** / **PullGate 追加**。
- **JS viewport 判定 hook**(CSS md: + DOM 両置きで回避)。
- **リサイズ幅の永続化**(examViewPrefs v3 化しない)/ **部品ライブラリ追加**。
- **行クリック peek**(title 列ボタンに限る)。**タグ / 判定 banner / 画像の表示**。
- **カードビュー・exam-detail 分岐・新 server helper の追加**。

---

## 6. テスト方針(概要・詳細は plan)
- **CardView**: 表示専用 unit(正解ハイライト class / ○× / 選択肢別解説 / カード解説 / 判定 banner 不在 / button でない=aria-pressed なし)。
- **ExamCardTable**: prune 純ロジック unit(T2)+ 開く→peek 表示・閉じ方・live 追従の統合(T3/T4 接続後)。
- **full-page route**: `db.cards.get` + user_id 不一致で出さない / CardView 描画(T5)。
- **実機 smoke が唯一の表面化手段**(build/typecheck/RTL 不可)= T3 リサイズ drag・clamp・幅保持・peek live 追従・ActionBar 非干渉 / T4 青枠 pin またぎ・hover/focus trigger・閉じ方 / T5 mobile full-page 遷移・CSS 出し分け・戻る挙動。各 task 完了条件に DevTools MCP stg smoke を明記(push 後)。
- Sprint gate: whole-repo `pnpm lint --max-warnings=0` exit 0(報告1行)+ `pnpm typecheck` exit 0 + sprint 末 stg smoke(§plan)。

---

## 7. 受け入れ基準(Done)
- **desktop(md:以上)**: title 列 hover/focus → 「開く」→ 右 peek に judged 風表示 / cell 編集→peek live 追従 / フィルタ・削除で active 消滅→peek 閉じる / Esc・外クリック・×で閉じる / 青枠 pin またぎ / リサイズ drag・clamp・幅セッション保持 / ActionBar×peek 非干渉。
- **mobile(375px)**: 開くボタン常時表示→full-page 遷移→カード表示 / side peek 非表示 / table 単独横スクロール / 戻る挙動。
- カードビュー・SessionRunner 不変。全 feat task が canonical + Codex 両 Critical/Important 0 → `[reviewed]`。

---

## 8. Open Questions(OT 判断待ち)
1. **mobile route パス**: `exams/[id]/cards/[cardId]`(spec 既定)で確定可か(代替 `exams/[id]/[cardId]`)。
2. **リサイズ min/max clamp の具体値**(例 table 最小 `480px` / peek `320–560px`)を spec で固定するか T3 実装裁量か。
3. **full-page 戻り導線**: ブラウザ戻る + 画面内「← 戻る」link の有無(study/smart は `router.push('/app')` 前例 :397)。最小で済ますか。
