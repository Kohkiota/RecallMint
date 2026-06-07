# Tag-4a stg smoke checklist (`/app/tags` タグ管理 page)

> 対象 commit: Tag-4a Task 1〜5 を統合した単一 commit (controller が後で積む)。
>
> **核心**: 本 sprint は **UI 経由で初めて `entity_type='tag_category'` / `'tag_option'`
> を enqueue** する。 UI 操作 → enqueue → flush → server applied → pull → IDB 反映
> → useLiveQuery 再描画 の 1 ループを実観測で通す。 server 経路は Tag-1/Tag-2 smoke
> で全 PASS 済 (`docs/superpowers/sessions/2026-06-07-tag-2-stg-smoke.md`)、
> 本 checklist は **UI 層が outbox に正しい mutation を積めるか / 削除 cascade
> + UNIQUE 二段防御 + mobile fallback** が中心。

## 環境情報

- URL: https://stg.recallmint.nekotest.net/app/tags
- アカウント: `komail9server+clerk_test@gmail.com` / pw `komail9server` (memory `stg-smoke-login`)
- IDB 名: `recallmint`
- 既存残骸 (Tag-2 smoke 終了時点、 `docs/superpowers/sessions/2026-06-07-tag-2-stg-smoke.md`):
  - tag_category `b61430cd-...` 名前 `Smoke分野` (select_type は要確認)
  - tag_option `9665475d-...` 名前 `Smoke-B`、 上記カテゴリ配下
  - card `030c1b55-...` title `Smoke-2-A` (card_tags 0 件、 Tag-2 B.3 後の状態)

## 事前準備

1. ログイン後 `/app/tags` を 1 回開いて pull を完走 (Tag-2 smoke 後初回 visit
   なので tag_categories / tag_options が IDB に hydrate される)。
2. DevTools console で baseline 観測:
   ```js
   const dump = (store) => new Promise((res) => {
     const r = indexedDB.open('recallmint')
     r.onsuccess = () => {
       const tx = r.result.transaction(store, 'readonly')
       const g = tx.objectStore(store).getAll()
       g.onsuccess = () => res(g.result)
     }
   })
   console.log('cats:', await dump('tag_categories'))
   console.log('opts:', await dump('tag_options'))
   console.log('mut:',  await dump('entity_mutations'))
   ```
3. 残骸 `Smoke分野` / `Smoke-B` の扱い:
   - **A 案 (推奨)**: 残骸はそのまま活用 (B/C で active 切替先 + 移動先として使う)。
     新規追加は `Smoke-4a分野` カテゴリ + `Smoke-4a-α` option を本 smoke で作る。
   - **B 案**: 残骸を先に削除 (D.1 を満たすため空状態から開始)。 D 経由で C.5 削除と
     重複するので非推奨。
4. DevTools Network panel を開き、 `/api/entity-mutations/bulk` と `/api/pull` を
   filter で見やすくしておく。

## 観点 (PASS/FAIL チェックリスト)

PASS = (1) 期待動作通り、 (2) console error 0 (Clerk dev domain DNS 失敗は除外、
Tag-2 smoke と同様)、 (3) 全 API 200。 各観点完了後 `entity_mutations` の
pending=0 を念のため確認。

### A. page アクセス + 基本動作

- [ ] **A.1** 上 nav に「タグ」 link が **5 番目** (アップロード / 試験 / スマート復習 /
      **タグ** / 設定 の順) で表示される。 click で `/app/tags` に navigate (Network
      で `/_next/static/chunks` の prefetch が link hover 時に走らないこと =
      `prefetch={false}` 反映、 DevTools Network "Disable cache" + hover 観測)。
- [ ] **A.2** desktop (>= 768px、 viewport 1280) で page 描画: 「タグ管理」 h1 +
      `md:grid md:grid-cols-3 md:gap-6` の 2 column。 左 1/3 にカテゴリ list、
      右 2/3 に option list (active 未選択時は「カテゴリを選択してください」 placeholder)。
- [ ] **A.3** mobile (DevTools mobile view, viewport iPhone 12 = 390x844) で Tabs
      切替表示 (`md:hidden` 側が見える)。 「カテゴリ」 / 「option」 の 2 tab、
      初期 `categories` active。
- [ ] **A.4** loading.tsx の skeleton 表示 (任意): DevTools Network throttle "Slow 4G"
      + Disable cache でリロード → 短時間 (~数百 ms) skeleton (h-8 タイトル + 縦並び
      rectangle) が見える。 hydration 後に shell に切替わる。

### B. カテゴリ CRUD

#### B.1 カテゴリ作成

- [ ] 1. 左 column の form に name `Smoke-4a分野` を入力、 radio で `multi` を選択
       (default)、 「＋ カテゴリ追加」 click。
- [ ] 2. Network: `POST /api/entity-mutations/bulk` 1 件 + response
       `{ok:true, applied:1, failed:[]}`、 status 200。
- [ ] 3. UI: 左 list に `Smoke-4a分野` row が即追加 + select_type バッジ `multi`、
       自動 active 化 (`bg-slate-100 border-slate-200`)。
- [ ] 4. 右 panel が active 切替で「option」 list に切替 + 「カテゴリを選択してください」
       placeholder が消え option 0 件状態に。
- [ ] 5. `dump('tag_categories')` に新 id (Smoke-4a分野) が出ること。
- [ ] 6. form が reset (name 空、 radio multi)。

#### B.2 カテゴリリネーム

- [ ] 1. `Smoke-4a分野` 行の名前 click → input 化 → 末尾に ` (renamed)` を追記して blur。
- [ ] 2. ~500ms 後に `POST /bulk` 1 件 (debounce 後 flush)、 applied:1。
- [ ] 3. UI 表示が `Smoke-4a分野 (renamed)` に更新 (useLiveQuery 再描画)。
- [ ] 4. `dump('tag_categories')` の name 反映を確認。
- [ ] 5. 値を元に戻す: 再度 click → ` (renamed)` を削除 → blur → applied:1。

#### B.3 active カテゴリ切替

- [ ] 1. 既存 `Smoke分野` (Tag-2 残骸) を click → active 切替 + 右 panel が
       `Smoke分野` 配下の option list (`Smoke-B`) に切替わる。
- [ ] 2. 再度 `Smoke-4a分野` を click → active 切替 + 右 panel が空 option list に。
- [ ] 3. 切替時に `POST /bulk` が **発火しない** (read-only 切替)。
- [ ] 4. mobile view では `Smoke分野` click → 自動で `options` tab に遷移
       (Tabs `value="options"`)。

#### B.4 カテゴリ削除 confirm (子なし → 子あり)

- [ ] 1. `Smoke-4a分野` 行末「×」 button (`aria-label="カテゴリ削除"`) click。
- [ ] 2. AlertDialog (ConfirmDialog) 表示: title 「カテゴリ『Smoke-4a分野』
       を削除しますか?」 / description 「配下の option **0** 件、 紐付き card **0** 件」 /
       button 「削除する」 (destructive) + 「キャンセル」。
- [ ] 3. 「キャンセル」 click で dialog close、 mutation 発火なし。
- [ ] 4. 次に C.1〜C.4 で option を `Smoke-4a分野` 配下に作ってから再度削除:
       dialog の option 件数 / card 件数が IDB count と一致 (100+ 丸めも観測可)。
- [ ] 5. 「削除する」 click → dialog close + `POST /bulk` 1 件 (`entity_type=
       'tag_category', op='delete'`) applied:1。 active が `Smoke-4a分野` だった
       場合は active が null に遷移 (右 panel が placeholder に戻る)。
- [ ] 6. ~5 秒待機後 reload → `dump('tag_categories')` から `Smoke-4a分野` が消え、
       `dump('tag_options')` から配下 option も消える (server cascade + pull
       tombstone purge、 Tag-1 smoke で server 経路 PASS 済)。

### C. option CRUD (active カテゴリ配下)

`Smoke-4a分野` を active 状態にしてから実行。

#### C.1 option 作成 + color 指定

- [ ] 1. 右 column 上部 form: 色 pill (`Smoke-4a分野` 直下の `h-8 w-8 rounded-full`) click。
- [ ] 2. ColorPalettePopover 表示: 13 cell grid (12 色 + 「色なし」 cell)。
- [ ] 3. `red` (1 行 1 列目想定) click → pill class が `bg-red-100 text-red-800 border-red-200`
       に変化。
- [ ] 4. name `Smoke-4a-α` を入力 → 「＋ option 追加」 click。
- [ ] 5. `POST /bulk` 1 件 (`entity_type='tag_option', op='create',
       patch:{category_id, name:'Smoke-4a-α', color:'red'}`) applied:1。
- [ ] 6. UI: right list に row 追加 (pill red + name `Smoke-4a-α`)。
- [ ] 7. form reset (name 空、 color null)。 `dump('tag_options')` に新 id 反映。

#### C.2 option リネーム

- [ ] 1. `Smoke-4a-α` 名前 click → input 化 → ` (renamed)` 追記 → blur。
- [ ] 2. ~500ms 後 `POST /bulk` 1 件 (`update_field`, field='name')、 applied:1。
- [ ] 3. UI 更新 + IDB 反映。 値を元に戻す。

#### C.3 color 変更 (popover 13 cell)

- [ ] 1. `Smoke-4a-α` の小さい pill (`h-5 w-5`) click → popover 表示。
- [ ] 2. `blue` cell click → 即 `POST /bulk` (`update_field`, field='color', value:'blue')。
- [ ] 3. UI: pill が `bg-blue-100 text-blue-800 border-blue-200` に切替。
- [ ] 4. 「色なし」 cell click → `value: null` 送信 → pill が `COLOR_NULL_CLASS`
       (`bg-slate-100 text-slate-700 border-slate-200`)。
- [ ] 5. `dump('tag_options')` の color が `null` で保存されること。

#### C.4 カテゴリ間移動 (option の「移動」 dropdown)

- [ ] 1. `Smoke-4a-α` 行の「移動」 button click → 自前 menu 表示
       (radix DropdownMenu ではなく controlled state、 backdrop fixed inset-0)。
- [ ] 2. menu に他カテゴリ `Smoke分野` が列挙される (現カテゴリ = `Smoke-4a分野` は除外)。
- [ ] 3. `Smoke分野` click → `POST /bulk` (`update_field`, field='category_id',
       value:'<Smoke分野 id>') applied:1 + menu close。
- [ ] 4. UI: 右 panel から `Smoke-4a-α` が消える (active = `Smoke-4a分野` のまま)。
       `Smoke分野` を active に切替 → `Smoke-4a-α` が表示される。
- [ ] 5. C.5 直前に `Smoke-4a-α` を `Smoke-4a分野` に戻しておく (削除 confirm 検証用)。

#### C.5 option 削除 confirm

- [ ] 1. `Smoke-4a-α` 行末「×」 click → AlertDialog 表示。
- [ ] 2. dialog: title 「option『Smoke-4a-α』 を削除しますか?」 / description
       「**0** 件の card に紐付いています」 (card_tags が無いため、 4b 以降で card 紐付け
       して再検証可)。
- [ ] 3. 「削除する」 click → `POST /bulk` (`entity_type='tag_option', op='delete'`)
       applied:1 + dialog close。
- [ ] 4. ~5 秒後 reload → `dump('tag_options')` から `Smoke-4a-α` が消える
       (Tag-2 smoke C.1 で server cascade 経路 PASS 済)。

### D. UNIQUE 違反 (client + server 二段防御)

#### D.1 client 事前チェック (option 作成)

- [ ] 1. `Smoke分野` を active 化 (既存 `Smoke-B` 配下)。
- [ ] 2. 右 form に name `Smoke-B` (既存と同名) を入力。
- [ ] 3. **送信前** に input が `border-red-400` + 「同名が既に存在します」 inline
       error 表示 + 「＋ option 追加」 button が `disabled`。
- [ ] 4. Network: `POST /bulk` 発火 **なし** (enqueue 抑止確認)。
- [ ] 5. name を `Smoke-B-2` に変更 → error 消失 + button 活性化 (commit はしない、
       残骸防止)。

#### D.2 client 事前チェック (リネーム + カテゴリ移動)

- [ ] 1. C.1 で再度 `Smoke-4a-α` を作成、 別 option `Smoke-4a-β` も作成。
- [ ] 2. `Smoke-4a-β` を rename して `Smoke-4a-α` に変更 → blur → input 残存
       (edit mode 継続) + 「同名が既に存在します」 inline error 表示 + `POST /bulk`
       発火 **なし**。 Esc で cancel。
- [ ] 3. 別カテゴリ `Smoke分野` に同名 `Smoke-4a-α` を作成 → カテゴリ間移動で
       `Smoke分野` → `Smoke-4a分野` を試みる → 「移動」 menu から `Smoke-4a分野` click
       → row 全体が `border-red-300 bg-red-50` + 「移動先に同名 option が存在します」
       inline error 表示 + `POST /bulk` 発火 **なし**。

#### D.3 server failed race

- [ ] D.3 は別端末で同名 option を先に作る race のシミュレートが stg では困難なため
      **skip**。 server failed[] 経路は単体 test (`option-row.test.tsx` /
      `option-create-form.test.tsx`) で担保済として記録。

### E. mobile fallback

- [ ] **E.1** DevTools mobile view (iPhone 12 = 390x844) で `md:hidden` 側が表示。
      Tabs (radix Tabs) の `カテゴリ` / `option` 2 trigger 表示 + 初期 `categories`
      active。
- [ ] **E.2** カテゴリ row click (B.3 `Smoke分野`) → `setMobileTab('options')`
      auto-trigger で options tab に遷移 + 右 panel (= options tab content) に切替。
- [ ] **E.3** option tab 内で C.1〜C.5 のうち 1 件 (例: C.3 color 変更) が動作。
      popover が viewport 内に収まる (mobile viewport で overflow しない)。
- [ ] **E.4** `categories` tab に戻る → active カテゴリ表示は維持される
       (shell state は tab 跨ぎで保持)。

### F. 全体

- [ ] **F.1** console error 0 (Clerk dev domain DNS 失敗は除外)、 全 `/api/*` 200。
- [ ] **F.2** 全観点完了時点で `dump('entity_mutations')` が pending=0 / syncing=0 /
       failed=0。
- [ ] **F.3** page reload 後、 `tag_categories` / `tag_options` が IDB から復元され
       useLiveQuery で再描画 (Tag-2 残骸 + 本 smoke 新規追加分が表示)。
- [ ] **F.4** 既存機能 regression なし: `/app/exams/<examId>` の card 編集 (Tag-2a
       経路 A.1〜A.6 から 1〜2 件サンプル) + `/app/study/smart` 起動 + `/app/settings`
       表示が引き続き動作。
- [ ] **F.5** `/api/pull` response に `tag_categories.rows[]` / `tag_options.rows[]`
       が乗り、 cursor が進む (cursors.tag_categories / cursors.tag_options が
       null → ISO 文字列 → 更新)。

## FAIL 時の再現手順 + 原因仮説テンプレ

```
観点 #: C.4
症状: 「移動」 menu click 後、 menu が表示されない / 別カテゴリが列挙されない
再現手順:
  1. <ここに DevTools console コマンドを順に貼る (dump('tag_categories') 結果含む)>
  2. <Network panel の bulk request body 抜粋>
原因仮説候補:
  A. allCategories prop が伝播していない (OptionList が useLiveQuery 結果を
     props に渡し忘れ) → `option-list.tsx:68-71` 確認
  B. menuOpen state が backdrop click と競合 (stopPropagation 抜け)
     → `option-row.tsx:289-345` 確認
  C. otherCategories.filter で現カテゴリ id 比較が undefined になっている
     (option.category_id が pull 反映漏れ) → `dump('tag_options')` で category_id 確認
```

## cleanup (smoke 完了後にまとめて、 OT 判断)

Tag-4a smoke で追加した残骸 + Tag-2 smoke 残骸の扱い:

- [ ] 維持案 (Tag-3 / Tag-4b smoke で再利用): 何もしない (`Smoke分野` / `Smoke-B`
       + `Smoke-4a分野` / `Smoke-4a-α` / `Smoke-4a-β` / `Smoke-4a-α` (Smoke分野配下)
       を残置)
- [ ] 一括削除案: `/app/tags` UI で B.4 / C.5 の手順で全削除 (server cascade で
       card_tags / tombstone も同期)
- [ ] Tag-2 残骸 (card title 等) はこの smoke の対象外、 Tag-2 cleanup checklist 参照

## 参照

- 設計仕様: `docs/superpowers/specs/2026-06-07-tag-4a-tag-manager-design.md`
- plan: `docs/superpowers/plans/2026-06-07-tag-4a-tag-manager-page.md`
- Tag-2 smoke (server 経路 PASS 済): `docs/superpowers/sessions/2026-06-07-tag-2-stg-smoke.md`
- Tag-2a smoke (regression baseline): `docs/superpowers/sessions/2026-06-06-tag-2a-stg-smoke.md`
- Tag-2 smoke checklist (形式踏襲元): `docs/superpowers/plans/2026-06-06-tag-2b-2c-smoke-checklist.md`
- UI 主要 file:
  - shell: `app/(app)/app/tags/_components/tag-manager-shell.tsx`
  - category: `app/(app)/app/tags/_components/category-list.tsx` / `category-row.tsx` / `category-create-form.tsx`
  - option: `app/(app)/app/tags/_components/option-list.tsx` / `option-row.tsx` / `option-create-form.tsx`
  - 共通: `delete-confirm-dialog.tsx` / `color-palette-popover.tsx` / `lib/tags/color-palette.ts`
  - nav: `app/(app)/app/_components/app-header.tsx` (5 番目「タグ」 link)
