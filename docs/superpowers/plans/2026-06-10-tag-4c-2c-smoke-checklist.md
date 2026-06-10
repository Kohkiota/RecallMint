# Tag シリーズ (4c-2b + 4c-2c) stg 統合 smoke checklist

## 目的 / scope

`develop` を stg に deploy 済の状態で、 Tag シリーズ全 sprint (4c-2b popover D&D + 4c-2c manager D&D) の挙動を OT が stg 実機で一括確認するための checklist。 4c-2b spec §9 + 4c-2c spec §9 を統合、 各項目に「期待挙動」 + 「NG だった場合の fallback (別 hotfix scope、 本 sprint には inline しない)」 を併記。

## 前提

- develop branch が stg に deploy 済
- stg login: `komail9server+001` (memory `stg-smoke-login`)
- 確認 device: PC ブラウザ (Chrome) + Chrome DevTools mobile view + 可能なら実機
- 並べ替え対象タグ fixture を最低限用意:
  - category 3 件以上 (双方向反映 + 数値順 verify 用)
  - 1 category 配下に option 11 件以上 (数値比較 verify、 `'0'..'10'` で string 比較が誤順を起こすケースを踏む)
- 試験詳細画面 (`/app/exams/[id]`) と タグ管理画面 (`/app/tags`) の両方を開ける card と category fixture

## 実行記録

実行日:
実行者:
develop HEAD SHA (実行時点):
結果サマリ (A/B/C/D 各セクション件数):

---

## A. popover D&D (試験詳細画面、 4c-2b §9)

- [ ] **(a) KeyboardSensor Esc と popover Esc 階層の衝突**
  - 手順: 試験詳細画面で card のタグ popover を開き、 stage1 (category 一覧) で keyboard 並べ替えを起動 (handle に Tab で focus → Space で掴む → 矢印で位置移動) → 確定前に **Esc** を押す
  - 期待: drag cancel のみ発生、 popover の stage は category 一覧のまま (1 段戻らない)
  - NG (drag cancel 後に stage が 1 段戻る or popover 閉じる) → 別 hotfix で `DndContext` ラッパに `onKeyDown` で `event.stopPropagation()` を追加 (spec 4c-2b §9 (a))

- [ ] **(b) in-place transform の scroll 容器 clip**
  - 手順: 1 category 配下に option 15-20 件を作って popover stage2 を開き、 最終行 (下端) を handle で**上方向に長距離ドラッグ**
  - 期待: ドラッグ中の行が popover の枠 (`PopoverContent` の `max-w-sm` 縦範囲) で clip / cut off しない、 行全体が見える
  - NG (clip 発生) → 別 hotfix で `DragOverlay` を `PopoverPortal` 内に逃がす (spec 4c-2b §9 (b))

- [ ] **(c) モバイル long-press + scroll 誤発火**
  - 手順: Chrome DevTools mobile view (iPhone 14 Pro 等) + 可能なら実機で stage1/stage2 を開く
    - handle を long-press でドラッグ起動できるか (delay 250ms)
    - tap (= category 選択 / option 付与) が drag に化けないか
    - リスト縦スクロールが drag に化けないか
  - 期待: long-press でのみ drag 起動、 tap / scroll は通常動作
  - NG → 別 hotfix で `delay: 300-400` or `tolerance: 8` への調整 (spec 4c-2b §9 (c))

- [ ] **popover の通常 D&D (マウス)**
  - 手順: stage1 で category を、 stage2 で option を、 マウスで handle ドラッグして並べ替え
  - 期待: drop 位置で確定、 並びがすぐ反映 (in-place transform)、 flicker なし

- [ ] **filter 中は handle 非表示 (`dndEnabled` gate)**
  - 手順: popover の combobox 入力欄に 1 文字以上入力した状態で handle button の有無を確認、 入力を消すと handle が戻ることも確認
  - 期待: filter non-empty で handle button 0 件、 filter 空に戻すと handle 復活

- [ ] **`items.length < 2` で handle 非表示**
  - 手順: 0 件 / 1 件しかない category/option 一覧で handle 表示確認
  - 期待: handle button 0 件 (並べ替え不能で grip を出さない)

---

## B. manager D&D (タグ管理画面 `/app/tags`、 4c-2c §9)

- [ ] **category 一覧の D&D (マウス)**
  - 手順: `/app/tags` で category 一覧 (左 column / mobile Tabs `カテゴリ`) を handle でマウスドラッグ並べ替え
  - 期待: drop 位置で確定、 並びがすぐ反映

- [ ] **option 一覧の D&D (マウス)**
  - 手順: category を 1 つ active にして option 一覧 (右 column / mobile Tabs `option`) を handle でマウスドラッグ並べ替え
  - 期待: drop 位置で確定、 並びがすぐ反映 (当該 category 配下のみ reindex、 別 category の option を巻き込まない)

- [ ] **manager 既存操作が drag で誤発火しない**
  - 手順: drag handle 以外の各 button を click して既存挙動を発火させる
    - CategoryRow: row 本体 click による active 切替 / pen icon rename / 削除 button (×)
    - OptionRow: color pill (color picker popover) / pen icon rename / **カテゴリ移動 dropdown (移動 button + menu)** / 削除 button (×)
  - 期待: いずれも従来通り発火、 drag は起動しない
  - **特に重要**: カテゴリ移動 dropdown と handle drag が混ざらない (dropdown 操作で drag 起動しない / drag 中に dropdown 開かない)

- [ ] **handle 以外 (行本体) を掴んでも drag が起動しない**
  - 手順: CategoryRow / OptionRow の本体エリア (name / badge / button 以外) でマウス press-and-move を試行
  - 期待: handle 以外の pointerdown では drag が起動しない (`setActivatorNodeRef` + `touch-none` が handle のみ)

- [ ] **モバイル view で manager の handle long-press ドラッグ + scroll 誤発火なし**
  - 手順: mobile view で `/app/tags` を開き Tabs で `カテゴリ` / `option` 切替、 handle long-press でドラッグ
  - 期待: long-press で drag 起動、 リスト縦スクロールが drag に化けない

- [ ] **`list.length < 2` で handle 非表示**
  - 手順: 0 件 / 1 件しかない一覧で handle 表示確認 (category 一覧 / option 一覧の両方)
  - 期待: handle button 0 件、 素の `<li><CategoryRow/></li>` / `<li><OptionRow/></li>` で render

- [ ] **mobile breakpoint 下の Tabs 切替中の drag state 持ち越し問題なし**
  - 手順: mobile view で Tabs を `カテゴリ` ↔ `option` 切替、 切替直後に drag を試行
  - 期待: 切替後の Tab で正常に drag 起動、 前 Tab の drag state が残留しない

---

## C. 両画面双方向反映 (4c-2b + 4c-2c 統合の肝)

- [ ] **popover で並べ替え → manager に即反映**
  - 手順: 試験詳細画面の popover stage1/stage2 で並べ替え → 別タブ (or 戻って) `/app/tags` を開く
  - 期待: 同じ並び順、 IDB `useLiveQuery` 経由で 0 ラグ反映

- [ ] **manager で並べ替え → popover に即反映**
  - 手順: `/app/tags` で並べ替え → 試験詳細画面に戻って popover を開く
  - 期待: 同じ並び順、 IDB subscription で即反映

- [ ] **どこで作っても末尾に来る (作成末尾採番 + null 混在なし)**
  - 手順:
    - popover で category 新規作成 → 一覧末尾に来るか
    - popover で option 新規作成 → 一覧末尾に来るか
    - manager で category 新規作成 → 一覧末尾に来るか
    - manager で option 新規作成 → 一覧末尾に来るか
  - 期待: 全 4 経路で「先頭に古い + 末尾に新規がバラつく」 状態が起きない、 共有 `nextSortKey` で末尾採番が両画面で揃う
  - 4c-2b T7 fix V-a で popover create も enqueue patch に sort_key を含めるよう統一済 → server に null を残さない

- [ ] **並べ替え後にリロード → 並び順保持**
  - 手順: 並べ替え → ブラウザリロード (or 別タブで開き直し)
  - 期待: sort_key が永続化されており同じ並び順、 server 経由で別端末でも同じ並び (`updated_at` 自動打刻 → pull で受信)

- [ ] **11 件以上で数値順に並ぶ (数値比較が効いている)**
  - 手順: 1 category 配下に option を 11 件以上作って並べ替え (`sort_key` が `'0','1',...,'10','11',...` になる状態)
  - 期待: `0,1,2,...,10,11,...` の数値順に並ぶ
  - NG (`'0','1','10','11',...,'2','3',...` の string 比較順) → 共有 `sortByKeyThenCreated` の数値比較化 (4c-2b §4.6 T1.5) が壊れた可能性、 別 hotfix で要修正

- [ ] **(可能なら) 別タブ / 別端末で pull 反映**
  - 手順: 別タブ or 別端末でアプリを開いて並び順確認、 片方で並べ替え → もう片方を refresh (or pull cycle 待ち)
  - 期待: 同じ並び順、 `entity_mutations` + `updated_at` + pull 経路で同期成立

---

## D. 既存機能の回帰 (D&D 追加で壊れていないか)

### popover (試験詳細画面)
- [ ] combobox 検索 (category / option 両 stage で名前で絞り込み) → 検索結果に handle 非表示
- [ ] 新規作成 (combobox の「新規作成: {入力値}」 行 → category は createCategoryType stage で single/multi 選択 → option は直接作成)
- [ ] 型選択 stage (createCategoryType で single/multi 切替 + 初期 focus が「マルチセレクト」 button)
- [ ] kebab (`...` button) からの編集 stage 遷移 → rename / color 変更 / 削除 + impact count 表示 + confirm
- [ ] バッジ付与・解除 (multi で複数選択 / single で 1 個のみ + 0 個に戻る)
- [ ] 編集 popover (バッジクリックで開くカテゴリ別 popover) も無変更で動作

### manager (タグ管理画面)
- [ ] category の作成 (末尾採番) / rename (pen icon → input → Enter/Blur) / 削除 (× → ConfirmDialog with 影響範囲 count)
- [ ] option の作成 (末尾採番) / rename / color picker (color pill から ColorPalettePopover) / カテゴリ移動 (移動 button → menu → 移動先選択、 移動先同名 conflict 時 inline error)
- [ ] active category 切替 (category click) → 右 column / mobile Tabs で option 一覧が切替
- [ ] mobile Tabs の動作 (カテゴリ ↔ option 切替、 category 選択時の自動 options tab 遷移)

### card 表示
- [ ] タグ付与した card のバッジ表示 (Tag-4b-fix で固定の `category.name → option.name` ja-localeCompare 順) が正常、 sort_key 並びは popover/manager のみ反映 (バッジ並びは別軸)
- [ ] バッジ click で edit popover 開く → 同 category の option 切替 → 削除 etc が動作

---

## NG 時の対応方針 (まとめ)

各 NG fallback は本 checklist に記載するが、 **実装は別 hotfix sprint**:
- (a) Esc 衝突 → DndContext ラッパに onKeyDown stopPropagation
- (b) scroll clip → DragOverlay を PopoverPortal 内 portal target に逃がす
- (c) モバイル long-press / scroll 誤発火 → `delay: 300-400` or `tolerance: 8` への調整
- 数値順誤順 → 共有 `sortByKeyThenCreated` 回帰調査 (4c-2b T1.5)
- 双方向同期失敗 → IDB `useLiveQuery` subscription / `updated_at` 打刻 / pull 経路の調査

本 checklist 完走 → Tag シリーズ stg 検証完了。 全項目 GO で本番統合 (Tag シリーズ全体を prod に反映、 OT 手順)。
