# Grid-1 設計: 試験詳細「カード / テーブル」ビュー切替 + テーブル閲覧 + 単票タグ操作 + 行選択 state

- 日付: 2026-06-16
- 対象 sprint: Grid-1 (Grid-2 / Grid-3 とは別 sprint)
- 種別: feat (UI 機能追加 + 表示状態永続化 + 新規依存導入)

## 1. 目的

試験詳細画面 `/app/exams/[id]` に「カードビュー」と「テーブルビュー」の切替を導入し、テーブルビューを **閲覧 + 単票タグ操作 + 行選択 state** 専用として実装する。 目的は「table を導入する」ではなく「**table を選べるようにする**」。 既存カードビューは温存し、置き換えない。

本 spec の出力は Grid-2 (フィルタ + アクションバー + 一括タグ操作) の基盤になる。 Grid-2 のスコープは本 spec に含めない。

## 2. スコープ (in)

- TanStack Table v8 を新規導入し、テーブルビューを実装する。
- テーブル列: **checkbox 列 (選択 state のみ) / # 列 / 問題文列 (line-clamp + 第 1 列 pin) / タグ列**。
- タグ列は「横 wrap + 余剰を `+N` に集約」する一括ビュー相当の表示。
- 単票タグ操作: タグセル (`+N` または セルクリック) から **既存 `CardTagOptionList` をカテゴリ起点で開いて付与/除去**。
- ビュー切替トグル (カード / テーブル) を試験詳細に追加。
- 表示状態の最小永続化を `sync_meta` に追加 (view 切替値のみ、列幅・ソート・表示列は保存しない)。
- データ供給: 既存 `useLiveQuery` 経路 (`inline-card-list.tsx` の cards + tag_categories + tag_options + card_tags 4 store 1 subscription) を**そのまま流用**し、新規 fetch 経路を増やさない。

## 3. スコープ外 (Grid-1 では扱わない)

以下は本 spec が**意図的に除外**する範囲。 spec の Definition of Done にも判定基準を入れない。

- 選択肢列 / 選択肢編集 / 正解切替 (別スライス)。
- 編集ビューの密度切替・表示プロパティ ON/OFF。
- **列幅 (`columnSizing`) / ソート (`sorting`) / 表示列 (`columnVisibility`) の永続化** (Grid-2 以降)。
- floating アクションバー、一括操作、フィルタ (Grid-2)。
- 試験間移動 (Grid-3)。
- side peek、列ヘッダー DnD。
- **仮想化は入れない**。 1 試験あたり数百件規模 (目安 300 件) を想定しており、 TanStack Table 標準の DOM レンダリングで操作不能にならないことを perf gate で担保するため、 react-virtual 等の仮想化レイヤーを Grid-1 では導入しない。

## 4. アーキテクチャ

### 4.1 ファイル境界 (新規 / 改修)

`/app/(app)/app/exams/[id]/_components/` 配下に**追加**するもの:

- `exam-detail-view.tsx` — **新規**。 view='card' | 'table' state を持ち、 view prefs の load / save + view toggle UI + `InlineCardList` / `ExamCardTable` の出し分けを担う wrapper。
- `exam-card-table.tsx` — **新規**。 TanStack Table v8 の table instance を組み立て、 thead / tbody を render。 行選択 state も本 component に閉じる。
- `exam-card-table-columns.tsx` — **新規**。 column defs (checkbox / # / 問題文 / タグ) を切り出す。 column defs は module スコープで定義し、 props ref 不安定問題を構造的に回避。
- `exam-card-table-tag-cell.tsx` — **新規**。 タグ列セル + `+N` 集約 + `CardTagOptionList` をカテゴリ起点で開く popover を含む adapter wrapper。
- `view-toggle.tsx` — **新規**。 'card' / 'table' 切替の SegmentedControl 相当 UI (実装案は §11.1)。

`/app/(app)/app/exams/[id]/page.tsx` (page.tsx:60-66 の `<section>` 内):

- **改修**。 `<InlineCardList ... />` を `<ExamDetailView initialCards={cards} examId={id} userId={userId} />` に差し替える。 server fetch (`getCardsForExam`) は SSR initialCards 供給で残す。

`lib/sync/sync-meta.ts` および `lib/client-db.ts`:

- **改修**。 view prefs 用の JSON helper / key を追加 (§5)。 既存 `getSyncMeta / setSyncMeta` は string-only のままで触らない (sync-meta.ts:6-8 のコメント方針に従う)。

`/app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx`:

- **改修**。 `initialStage?: Stage` / `initialCategoryId?: string` props を追加し、 グリッドのタグセルから「カテゴリ起点 = `initialStage='option'` + `initialCategoryId=<cell-of-category-id>`」 で開けるようにする (実装案は §11.2)。 既存 5 stage state machine と既存 `selectedCategoryId` 内部 state にそのまま乗る。 既存 caller (バッジ click / `+ タグを追加` button) は props 未指定 = 現挙動を維持する。

### 4.2 既存コンポーネントを壊さない境界 (regression gate)

- Grid 用 component (`exam-card-table*`, `exam-card-table-tag-cell.tsx`) は **adapter wrapper** として作り、 既存 `CardTagsSection` / `CardTagOptionList` / `CardTagAddPopover` の責務を侵食しない。
- 単票タグ操作の **mutation 経路は `CardTagsSection` の `handleToggle` (card-tags-section.tsx:603-653) と同じ canonical Dexie tx + outbox enqueue 経路を共有**する。 グリッド側で独自経路を作らない。 共有方法は plan で決める (案: handleToggle を module スコープに切り出し + 両 caller が import / 案: `useCardTagToggle(cardId, userId, ...)` hook 化)。
- **既存カードビュー** (`InlineCardList`) で rename / color / delete / add / remove のタグ挙動が**不変**であることを完了条件で確認する。
- `CardTagOptionList` の「カテゴリ起点で開く」 改修は、 既存 `selectedCategoryId` prop と `CardTagAddPopover` の stage 遷移設計に**そのまま乗る**形で実装する (新 popover を起こさない、 stage machine を作り直さない)。

### 4.3 React Compiler OFF 前提での参照安定性

React Compiler は OFF 維持が前提のため、 TanStack Table の `columns` / `data` / `state` は**参照を安定させる** (不安定だと table の再レンダーが暴発し、 行選択 / 編集 cell の state を吹き飛ばす)。

- `columns`: module スコープで定義 (`exam-card-table-columns.tsx`)。 component 内で `useMemo` 採番を**しない**。
- `data`: 親の `useLiveQuery` 戻り値 (`liveData.cards` + `tagsByCardId` の派生) を `useMemo` で安定化。 既存 `inline-card-list.tsx` の `useMemo` 安定化 (L137-148) と同じ哲学。
- `state.rowSelection`: TanStack 内部 state を `useReactTable` の `state` に渡し、 setter は `onRowSelectionChange` に流す (React Compiler OFF 前提では setter の identity も意識する)。

## 5. 表示状態の永続化 (sync_meta のみ)

### 5.1 key と型

`SYNC_META_KEYS` に `examViewPrefs` を追加する:

```ts
export type ExamViewPrefsV1 = { version: 1; view: 'card' | 'table' }
```

- Grid-1 で保存する値は **`view` のみ**。 列幅・ソート・表示列は保存しない。
- `version: 1` を持つ理由: **Grid-2 で `columnSizing` / `columnVisibility` を足すときの後方互換** のため。 version mismatch / shape 不一致時は default ('card') にフォールバックする (§6 と整合)。

### 5.2 JSON 化 helper の分離

既存 `getSyncMeta / setSyncMeta` (sync-meta.ts:25-38) は **string-only** であり、 コメント L6-8 に「unknown を許す必要が出たら別 helper を用意し、 本 helper は string 専用のまま維持して呼出元を狭く保つ」 と明記されている。 この方針に従う:

- 新規 `getJsonSyncMeta<T>(key, schema)` / `setJsonSyncMeta<T>(key, value)` helper を `sync-meta.ts` に追加する (string-only helper と共存)。
- read 時は **zod safeParse** で shape validate。 不正値 / 欠損は `undefined` を返し、 呼出側で default にフォールバック。
- key の集合は `SYNC_META_KEYS` を**そのまま使う** (string key と JSON key を**別 enum に分けない**。 enum 分割は将来 columnSizing 等が増えたタイミングで再検討)。

### 5.3 SSR 安全性

`getClientDb()` は server 呼出で throw する保護があり (client-db.ts:314-325)、 `getJsonSyncMeta` の呼出元は client component に限定する。 view state の初期化は `useEffect` 内で Dexie から load し、 SSR 中は default ('card') を**初期表示**として使う (= no flash の SSR/CSR mismatch 回避は許容する。 詳細は §11.3 で扱う)。

## 6. 初期 view の決定順序

1. `examViewPrefs` を Dexie から load し、 zod safeParse に成功した値があれば**それを優先**する。 saved 値があれば端末幅が変わっても勝手に view を戻さない (= 端末横断で view が安定する)。
2. saved prefs が**ない** / 不正値 / 欠損値の場合は **mobile / desktop 共に `'card'` を初期値**とする。
3. desktop も初期 `'card'` の理由: saved prefs が無い既存ユーザーの試験詳細が**初回アクセスで別 UI に変わるリスクを避ける**。 table はトグルで明示選択した人にだけ出す。 これは spec として明示的な決定であり、 後から「desktop 初期 table」 に倒す場合は別 spec で議論する。

## 7. selection (行選択)

- TanStack の `getRowId` は **`card.id`** を使う (1 問 1 行 = row=card を死守。 selection / filter モデルを単純に保つ)。
- selection は **非永続**: ページ再読込で復元しない (session-local、 React state)。 sync_meta / localStorage 等の永続層に**書かない**。
- **table view を離れた時 (= view が 'card' へ切り替わった時) に selection を clear する**。 理由: Grid-1 にアクションバーは無く、 card view に戻った後に見えない選択状態が残るのは事故要因 (Grid-2 でアクションバー導入後の挙動を**今**作り込むことを避け、 単純に「離脱 = clear」 で固定)。
- 実装方針: ExamDetailView は view='card' のときに **ExamCardTable を unmount** する (= conditional render `{view === 'table' && <ExamCardTable ... />}`)。 unmount により React tree 解除で TanStack の rowSelection state が自然に消えるため、 明示的な `setRowSelection({})` reset は不要。 view='table' へ戻った場合は新規 mount で selection は空 state から start する。 仮に hide 方式 (display:none で常時 mount) に切り替える場合は明示 clear を実装する必要がある (この場合は spec 改訂を要する)。

## 8. タグ列の表示ルール

- タグ列は**最大 2 行まで**表示。 超過分は `+N` に集約。
- `+N` クリック または **セルクリック** (バッジ以外のセル余白) で単票タグ操作 popover を開く。
- バッジ順は**タグカテゴリの sort_key 順**。 既存 `CardTagsSection` の `sortedCardTags` (card-tags-section.tsx:533-545) ロジックと同じ `sortByKeyThenCreated` を使う。
- `+N` の N 算出方法、 2 行制約の判定方法、 タグ無し (バッジ 0 件) セルの click target は §11.4 で扱う (実装案併記)。

## 9. データ供給 (useLiveQuery 流用)

- 既存 `InlineCardList` の `useLiveQuery` (inline-card-list.tsx:102-128) は cards / tag_categories / tag_options / card_tags の 4 store を 1 subscription で読む。 同 tick 更新 = card_tags 楽観反映時に「タグだけ stale」 問題なし。 この設計は Grid-1 でも維持する。
- ExamDetailView 配下で **同一 useLiveQuery を 1 度だけ実行し、 card view / table view 共に同じ live data を共有する**。 view 切替で**二重 subscription にしない**。
- `liveData.cards` (Map ベース) の TanStack `data` への受け渡しは、 `useMemo` で配列形に正規化し ref を安定化する。 同じ deps なら同じ ref を返す。
- TanStack に渡すための join (card + 該当 card_tags + 必要な category 情報) は **`useMemo` で 1 度組み立てる**。 join のシェイプは plan で決める (案: `Array<{ card: ExamDetailCard; tags: Array<{ category: ClientTagCategory; option: ClientTagOption }> }>` のような flat 形)。

## 10. perf gate

「table が card より速い」 は**要求しない**。 以下 3 分解を満たすことが合格条件:

1. **client perf**: 数百件 (目安 300 件) で **table view の初回描画**・**view 切替時** に明確な固まり (操作不能、 5 秒超のメインスレッドブロック) が無いこと。
2. **resource**: table 導入で **RSC / API fetch 数が増えないこと** (既存の `getCardsForExam` SSR + `useLiveQuery` Dexie 直読み経路を変えない)。
3. **stg**: stg 実機 (`stg.recallmint.nekotest.net`) で**既存 card view と比較し、 明確に遅い結果が再現しない**こと (絶対値ではなく非劣化が条件)。

合格条件の言い換え:
- 「明確な悪化が無い」 = stg で card / table の wall-clock を実測し、 table が card より明確に遅くなる (例: 倍以上) ような結果が**再現しない** こと。
- 「数百件で操作不能にならない」 = 300 件試験で table 描画後、 view toggle / row checkbox 押下が 1 秒以内に visual feedback。
- 「fetch 数を増やさない」 = RSC payload size / `/api/pull` 呼出回数が card view と同じ。

table 描画が card 描画を**必ず下回ること**、 は要求しない。

wall-clock は **stg 実測が正本** (jsdom / fake-indexeddb で wall-clock を assert しない)。

## 11. Open Questions と CC 推奨

各 OQ は「案を併記 + CC 推奨を明示」 のフォーマット。 OT 判断が必要なもの (◆) / CC 推奨で進めるもの (○) を分ける。

### 11.1 ◆ view toggle UI の見た目

- 案 A (CC 推奨): `Tabs` 風の 2 セグメント切替 (shadcn の `Tabs` か独自 button group)。 「カード」 と「テーブル」 を並列で表示。
- 案 B: icon-only toggle (List icon / Table icon)。 mobile で狭い場合に有利だが、 文字ラベルの明示性が落ちる。
- 案 C: dropdown menu (「表示: カード ▾」)。 将来 view を増やすなら拡張容易だが、 click が 1 step 増える。
- **CC 推奨: 案 A** — Grid-2 でフィルタ chip / アクションバーが上に並ぶことを考えると、 toggle は 2 セグメントで明示性を取りたい。 mobile 幅の確保は icon + 短ラベル (「カード」 / 「テーブル」 を漢字 3 文字) で凌げる想定。

### 11.2 ◆ CardTagAddPopover「カテゴリ起点で開く」 props 設計

- 案 P-1 (CC 推奨): 既存 popover に **`initialStage?: Stage`** + **`initialCategoryId?: string`** props を 2 つ追加。 caller (グリッドのタグセル) は `initialStage='option'` + `initialCategoryId=<categoryId>` で open する。 既存 caller (`CardTagsSection` 内) は props 未指定で現挙動。
- 案 P-2: 新規 `CardTagCellPopover` を新設し、 内部実装の category select 部分だけを別 popover として持つ。 stage machine を簡素化できるが**コード重複**。
- 案 P-3: 既存 `CardTagEditPopover` (バッジ click 時の popover) を流用。 ただし `CardTagEditPopover` は「**特定 option の編集**」用であり、 「カテゴリ全体の option 一覧 + 付与」 とは責務が違う。

- **CC 推奨: 案 P-1** — 既存 5 stage state machine に `initial*` props で素直に乗る。 popover open 時に `initialStage` から start し、 `initialCategoryId` を `selectedCategoryId` の初期値とする。 close 時は通常の reset 経路で戻る (card-tag-add-popover.tsx:18-20)。 既存 caller の挙動を**1 行も変えない**で済む。

### 11.3 ◆ SSR と view prefs load の flicker 抑制

- 案 F-1 (CC 推奨): **初回 SSR は default 'card' で render** → mount 後 `useEffect` で Dexie から load → saved が 'table' なら切替。 saved 'table' ユーザーは一瞬 card → table の flicker を見る (1 frame 程度)。
- 案 F-2: `useSyncExternalStore` で Dexie を subscribe し SSR mismatch を構造的に避ける。 ただし view prefs を Dexie に置く設計と React 19 SSR の組合せで実装複雑度が上がる。
- 案 F-3: cookie に view prefs を同期書きし、 SSR 時に cookie を読んで初期 view を決める。 cookie + Dexie の二重永続でラグなし。 ただし**永続層 2 系統**になり、 sync_meta 単一の brief 制約と背反する。

- **CC 推奨: 案 F-1** — flicker は 1 frame 程度で許容範囲。 sync_meta 単一永続の brief 制約を守る方が重要。 SSR mismatch は `'use client'` 配下で `useEffect` 内 load + setState のため発生しない (SSR は default 'card' で描画完了)。

### 11.4 ◆ タグ列「+N」 と空セルの実装方法

「2 行で溢れた分を `+N` に集約」 の判定方法:

- 案 TC-1: CSS `line-clamp: 2` のみ + `+N` は**常に末尾に表示** (実際の溢れと無関係に「全タグ件数 N が閾値以上なら +N を表示」)。 measure 不要、 単純。
- 案 TC-2: ResizeObserver でセル幅測定 + 各 badge 幅を累積 → 入り切る分だけ render + 残りを `+N`。 厳密だが measure コスト + 数百件で観測コストが効く可能性。
- 案 TC-3 (CC 推奨): **CSS による視覚的 2 行制約 + 件数閾値で `+N` 表示**。 例: タグが 5 個以上なら `+N` を出す、 4 個以下なら全部出す。 line-clamp で視覚的に切れた分は `+N` クリックで popover を開けば全て見られる。 measure 不要、 数百件で安全。

- **CC 推奨: 案 TC-3** — Grid-1 のスコープでは厳密な「ぴったり 2 行 fit」 は要求しない。 閾値設定で十分に「+N で popover を開く」 UX を提示できる。 閾値の具体値 (5 個? 6 個?) は plan / 実装時に視覚調整。

空セル (タグ 0 件) の click target:

- 案 EC-1 (CC 推奨): セルに **placeholder badge (「+」 アイコンのみ)** を 1 つ表示。 click で popover 開く。 visual affordance あり。
- 案 EC-2: セルそのものを click target (空セル余白 click で popover)。 ただし空セルだと click できることが分からない (affordance 不足)。

- **CC 推奨: 案 EC-1** — 空セルでも click target が明示される。 popover 起動カテゴリは未指定 (= stage='category' から start、 既存挙動)。

### 11.5 ◆ # 列の意味

- 案 H-1 (CC 推奨): **配列 index (1-based)** — sortKey 由来の sort 後の表示順位 (= 試験内連番 108 のような UI 表示)。 cards 配列 index + 1 を render。 sortKey 自体は別 (cards に sortKey 列があり inline 編集だが、 table view では Grid-1 ではそれを編集しない)。
- 案 H-2: sortKey そのもの (text 値)。 ただし sortKey は表示順を決めるための内部値であり、 user 視点では「連番」 が見たい想定。

- **CC 推奨: 案 H-1** — 「108」 のような連番値は配列 index ベース。 Grid-1 では#列は read-only。

### 11.6 ◆ filter / sort UI の有無

- 案 FS-1 (CC 推奨): **filter / sort UI を実装しない**。 sort は既存 `sortLikeServer` (inline-card-list.tsx:61-72) を再利用し**固定順序**。 filter は Grid-2 で来るため Grid-1 では入れない。
- 案 FS-2: filter / sort UI を実装するが永続化しない (リロードで初期)。 TanStack の機能を活かせるが、 中途半端 UX。

- **CC 推奨: 案 FS-1** — brief「sorting / filter UI を Grid-1 に含めない」 と整合。 Grid-2 で filter 設計を一度に固める方が UX が一貫する。

### 11.7 ◆ mobile での table view 提供範囲

- 案 ML-1: mobile で table を**出さない** (mobile 強制 card)。 toggle UI は desktop でのみ表示。
- 案 ML-2 (CC 推奨): mobile でも table を出す (**横スクロール許容**)。 列幅最低限。 user が table を明示選択した端末では尊重する。
- 案 ML-3: mobile では table を出すが、 一部列を hide (例: # 列 hide、 問題文 + タグ列のみ)。 ML-2 より画面に収まる。

- **CC 推奨: 案 ML-2** — view prefs は端末横断で安定 (§6) なため、 「desktop で table 選択 → mobile で開いたら card に戻る」 は user 期待と乖離する。 mobile での横スクロールは数百件 × 4 列でも操作不能にはならない想定 (perf gate で確認)。 列省略 (ML-3) は Grid-1 では実装複雑度を増やすため避ける。

### 11.8 ○ selection state の格納場所

- 案 SE-1 (CC 推奨): **TanStack table の `state.rowSelection`** を使う (controlled or uncontrolled どちらでも可)。
- 案 SE-2: 自前 React state + getRowId 引数。

- **CC 推奨: 案 SE-1** — TanStack の流儀。 §7 の `getRowId = card.id` と整合。 view 切替時の clear は `table.resetRowSelection()` で API がある。

### 11.9 ◆ `handleToggle` 共有経路の切り出し方

`CardTagsSection` の `handleToggle` (canonical Dexie tx + outbox enqueue + flush) をグリッドセル popover が共有する方法:

- 案 HT-1: **`handleToggle` を module スコープに切り出し** + `card-tags-section.tsx` 内の hook と グリッド側 popover の両方が import。 ロジックは 1 箇所。 ただし closure に必要な引数 (cardId, userId, categories, options, allAssignedOptionIds) が多く、 caller でこれを揃える必要あり。
- 案 HT-2 (CC 推奨): **`useCardTagToggle(cardId, userId)` hook** を新設し、 内部で `useLiveQuery` 結果 (categories / options / cardTags) を**親から渡してもらう** か **自分で subscribe** する。 caller 1 行で `const toggle = useCardTagToggle(cardId, userId)` → `toggle(categoryId, optionId)`。
- 案 HT-3: そのまま `CardTagsSection` 内の private 実装に残し、 グリッド側は**完全に別経路** で実装する。 ただしこれは regression gate (§4.2) と背反 (canonical 経路が 2 つになる)。

- **CC 推奨: 案 HT-2** — caller 側のコード量が最小、 親から `useLiveQuery` の categories / options / cardTags を**propsで渡す形** にすれば二重 subscribe を回避できる。 hook 名 / 引数の確定は plan で決める。

### 11.10 ○ TanStack Table 導入 commit の review tag

`@tanstack/react-table v8` 追加 commit (Task 0):

- 案 RT-1 (CC 推奨): `chore(deps): add @tanstack/react-table v8 [no-review]` で commit。 実装ロジック変更なし (import するだけのプレースホルダ ファイルは含めない、 純粋な依存追加のみ)。 CLAUDE.md の「chore / docs / test / refactor で実装ロジック変更なしのみ skip 可」 に該当。
- 案 RT-2: 最小 smoke (空 table を 1 試験で render) も含めて `feat(grid): add tanstack react-table + minimal table [reviewed]` で commit。 1 commit で動作確認できるが、 revert 単位として依存と実装が混ざる。

- **CC 推奨: 案 RT-1** — brief「失敗時に revert 可能な単位にする (導入だけの commit)」 に整合。 最小 smoke 用の空 table render は別 task として後続 commit に分離。

### 11.11 ○ React Compiler OFF 維持と参照安定性の検証手段

React Compiler は OFF 維持が前提 (§4.3)。 参照不安定で再レンダーが暴発しないことの検証:

- 案 RC-1 (CC 推奨): **手動 review チェックリスト** — column defs が module スコープに居ること、 `data` が `useMemo` 安定化されていること、 `state` setter が `useCallback` 安定化されていることを per-task gate に含める。
- 案 RC-2: render 回数を test で assert (例: react-testing-library で render spy)。

- **CC 推奨: 案 RC-1** — 数百件 perf gate と stg 実測で実害が出るかを判断する方が現実的。 render 回数 test は Grid-1 のスコープに対して過剰。

## 12. per-task gate

table 系 component は hook を多用するため、 **各 task の gate に lint (hook-rules) + typecheck + build を含める**。

- `pnpm lint` (--max-warnings=0) exit 0
- `pnpm typecheck` exit 0
- `pnpm build` exit 0 (Next 設定 file を触る task では必須、 触らない task でも tanstack の SSR 互換性確認のため含める)

Sprint 完了 gate (CLAUDE.md 規律) は本 spec で重複定義しない (CLAUDE.md 既出ルールに従う)。

## 13. Definition of Done

完了とみなすには以下を**全て満たす**:

### 13.1 view prefs

- [ ] `SYNC_META_KEYS.examViewPrefs` が追加されている。
- [ ] `ExamViewPrefsV1` 型 (`{ version: 1; view: 'card' | 'table' }`) が定義され、 zod schema で validate される。
- [ ] `getJsonSyncMeta / setJsonSyncMeta` helper が `sync-meta.ts` に追加され、 既存 string-only helper と分離されている。
- [ ] card/table 切替が `sync_meta.examViewPrefs` に保存され、 reload 後に**復元される**。
- [ ] **不正値 / 欠損値では 'card' にフォールバックする** (zod safeParse 失敗時 + 行未存在時の両方)。

### 13.2 selection

- [ ] TanStack `getRowId` が `card.id` を返す。
- [ ] ページ再読込で selection を**復元しない** (sync_meta / localStorage に書かれない、 unit test で確認)。
- [ ] **table view 離脱時 (view='card' へ切替時) に selection を clear する** (table.resetRowSelection 相当の挙動)。

### 13.3 タグ操作

- [ ] タグセル (`+N` / セル本体 / 空セル placeholder) から `CardTagOptionList` が**正しいカテゴリ起点**で開く (initialStage / initialCategoryId が反映される)。
- [ ] 付与 / 除去の**optimistic 書込が既存 canonical 経路** (`handleToggle` 同等 = Dexie rw tx + outbox enqueue + flush) を通る。
- [ ] グリッドのタグセル popover で付与した tag が、 同一 card の card view (= `CardTagsSection`) に**即時** 反映される (useLiveQuery 共有のため)。

### 13.4 regression

- [ ] 既存カードビュー (`InlineCardList`) のタグ挙動 (rename / color / delete / add / remove) が**不変**。 既存 unit test 不変通過。
- [ ] 既存 inline 編集 cell (sort_key / title / question_text / explanation_text / memo / option 4 field) の挙動が**不変**。
- [ ] `+ カードを追加` の autoEditOnMount 挙動が**不変** (inline-card-list.tsx:168, 342)。

### 13.5 correctness unit test

- [ ] TanStack table の `getRowId` 設定が `card.id` を返す (= row selection の key が array index ではなく card.id である) ことの unit test。
- [ ] 与えられた cards 配列に対し `getRowId` の戻り値に**重複が無い** (card.id の uniqueness) ことの unit test。
- [ ] カテゴリ起点 popover が **正しいカテゴリで開く** (初期 `selectedCategoryId` が一致する) ことの unit test。
- [ ] view prefs zod safeParse: 正常 / 異常 (不正 view 値 / version mismatch / 欠損) で fallback が 'card' になることの unit test。

### 13.6 perf

- [ ] §10 の **3 分解 (client / resource / stg)** を全て満たす。 stg 実測 (300 件試験で card / table 両方の wall-clock 観測) の証拠を session log に残す。
- [ ] jsdom / fake-indexeddb で wall-clock を assert する test は**書かない** (CLAUDE.md 規律 + brief 指定)。

### 13.7 mobile

- [ ] モバイル DevTools 表示でビュー切替が機能する。
- [ ] mobile / desktop ともに **saved prefs なし時の初期 view が 'card'** であることを確認。
- [ ] mobile での table view 横スクロールで操作不能にならないことを実機 / DevTools で確認。

### 13.8 sprint gate

- [ ] whole-repo `pnpm lint` (--max-warnings=0) exit 0。
- [ ] `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` exit 0 (依存導入を伴うため必須)。
- [ ] 各 feat / fix commit に `[reviewed]` または `[no-review]` tag。 §11.10 の Task 0 のみ `[no-review]` 該当。

## 14. 参考 file path (Grid-0 fact-finding + 本 spec 起票時の現物確認)

- `app/(app)/app/exams/[id]/page.tsx:18-69` — 試験詳細 page (toggle 挿入位置決定)
- `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:102-128` — 4 store useLiveQuery (table view も共有)
- `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:290-383` — 全 card map render (置換せず温存)
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx:518-709` — CardTagsSection inner (handleToggle: 603-653 = canonical 経路)
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:60-119` — 5 stage state machine + selectedCategoryId 内部 state (initial* props 拡張の起点)
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx:64-170` — kind='option' + selectedCategoryId 変化 watch (filter reset 連動)
- `lib/sync/sync-meta.ts:1-38` — string-only helper + SYNC_META_KEYS (JSON helper 追加位置)
- `lib/client-db.ts:240-264, 314-325` — Dexie schema 定義 + getClientDb() server-throw 保護

## 15. 本 spec の凍結

本 spec は実装フェーズで書き換えない (CLAUDE.md 規律「spec は実装フェーズで書き換えない」)。 仕様変更が必要な場合は実装を停止して OT に相談する。
