# Tag-4b stg smoke checklist (試験詳細 page card の「タグ」 section)

> 対象 commit: Tag-4b Task 1 (pill + dropdown) + Task 2 (category-row + section + optimistic) + Task 3 (parent 一括 subscribe + memo) + Task 4 (本 checklist) を統合した単一 commit (controller が後で積む)。
>
> **核心**: 本 sprint は **Tag-2c handler (`field='tag_option_ids'` whole-set replace) を UI から初めて呼ぶ**。 Tag-2 smoke では DevTools fetch 直送で server 経路のみ通したが、 本 smoke で **UI 操作 → optimistic IDB put/delete → enqueue whole-set → flush → server applied → pull で card_tags 取り直し** の 1 ループを実観測で通す。 案 a の取り直し経路 (`docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` §4) が UI 経由でも正しく成立することを担保する。

## 環境情報

- URL: https://stg.recallmint.nekotest.net/app/exams/08ec7835-db67-4e45-b402-db776ba93048
- アカウント: `komail9server+clerk_test@gmail.com` / pw `komail9server` (memory `stg-smoke-login`)
- IDB 名: `recallmint`
- 対象 exam: `Sync1 Smoke Exam` (id=`08ec7835-db67-4e45-b402-db776ba93048`、 Tag-2 / Tag-2a / Tag-2b smoke で使用済)
- 既存残骸 (Tag-2 / Tag-4a / Tag-4a-fix smoke 終了時点):
  - tag_category `Smoke分野` (multi) + tag_option `Smoke-B` (`Smoke分野` 配下)
  - card `030c1b55-...` title `C9-edit-A` 系 (card_tags 0 件で残置されている前提)
- deploy commit: Tag-4b 統合 commit (controller が push 後に記入)

## 事前準備

1. ログイン → `/app/tags` を 1 回開いて pull 完走 (`tag_categories` / `tag_options` 復元)。
2. 本 smoke 用の single カテゴリを `/app/tags` で 1 件作成: name `Smoke-4b-single分野` / select_type `single` (radio で `single` を選択) + 配下 option を 2 件 (`Smoke-4b-S-α` / `Smoke-4b-S-β`、 色は任意) 作成。
3. 既存 `Smoke分野` (multi) 配下の option が 1 件 (`Smoke-B`) のみの場合は 1 件追加 (`Smoke-4b-M-γ`、 色任意) して multi 動作の検証を可能にする。
4. 対象 exam page に navigate (`/app/exams/08ec7835-...`)。 card 一覧表示完了を待つ (pull 完走)。
5. DevTools console で観測 helper を定義 (Tag-2b smoke checklist の `readCardTags(cardId)` / `readCardUpdatedAt(cardId)` をそのまま流用、 加えて `dump(store)` は Tag-4a smoke checklist §事前準備 step 2 を流用)。
6. DevTools Network panel を開き、 `/api/entity-mutations/bulk` と `/api/pull` を filter で見やすくしておく。
7. 対象 card を 1 件選定し cardId をメモ (`dump('cards')` で id を控える)。 以下 `<cardId>` と呼ぶ。

## 観点 (PASS/FAIL チェックリスト)

PASS = (1) 期待動作通り、 (2) console error 0 (Clerk dev domain DNS 失敗は除外、 Tag-2 smoke 等と同様)、 (3) 全 API 200。 各観点完了後 `dump('entity_mutations')` の pending=0 を念のため確認。

### A. UI 表示 + 基本動作

- [ ] **A.1** 試験詳細 page の各 card listitem の title 行直下に「タグ」 section が表示される (問題文 div の前)。 section 見出し `タグ` + 横に「タグ管理 →」 link (`/app/tags`)。
- [ ] **A.2** カテゴリ別に row が並ぶ: カテゴリ名 + 型アイコン (multi=lucide `CheckSquare` / single=lucide `Circle`、 `text-slate-500`) + 付与済 pill 群 + 「+ 追加」 button。 順序は `created_at ASC`。
- [ ] **A.3** dropdown 開閉: 「+ 追加」 click で DropdownMenu 表示。 keyboard a11y: Tab で trigger に focus → Enter / Space で open、 Esc で close。
- [ ] **A.4** 「タグ管理 →」 link click で `/app/tags` へ遷移 (`prefetch={false}` のため hover 時に prefetch req が走らないこと、 Network 観測)。

### B. multi カテゴリ動作 (`Smoke分野` を使用)

- [ ] **B.1** 「+ 追加」 click → dropdown menu に `Smoke-B` / `Smoke-4b-M-γ` 等が並ぶ (`created_at ASC`)。 各 item: 色 pill + name、 付与済は checkmark 表示。
- [ ] **B.2** `Smoke-B` menu item click → **送信直後 (reload なし)** に該当カテゴリ row に `Smoke-B` pill が出現 (optimistic)。 **menu は閉じない** (multi)。
- [ ] **B.3** 続けて `Smoke-4b-M-γ` click → 2 個目の pill が即出現、 menu open のまま、 両 item とも checkmark。
- [ ] **B.4** `Smoke-B` pill の × click → 即 pill 消滅 (optimistic)、 menu 再 open で `Smoke-B` の checkmark が外れている。
- [ ] **B.5** 裏で `POST /api/entity-mutations/bulk` 発火 (~500ms 程度 debounce)、 各操作で `{ok:true, applied:1, failed:[]}` 200。 `dump('entity_mutations')` で pending=0 / syncing=0 / failed=0。
- [ ] **B.6** `await readCardTags('<cardId>')` で IDB 状態と UI 表示が一致 (option_id の集合)。

### C. single カテゴリ動作 (`Smoke-4b-single分野` を使用)

- [ ] **C.1** 「+ 追加」 click → dropdown menu に `Smoke-4b-S-α` / `Smoke-4b-S-β` が並ぶ。 型アイコンは `Circle`。
- [ ] **C.2** `Smoke-4b-S-α` click → 即 pill 表示 + **menu 閉じる** (single)。
- [ ] **C.3** 再度「+ 追加」 → `Smoke-4b-S-β` click → 旧 `Smoke-4b-S-α` pill が即外れて新 `Smoke-4b-S-β` pill 表示 (radio 的)、 menu 閉じる。
- [ ] **C.4** **再度「+ 追加」 → `Smoke-4b-S-β` を再 click → 0 個に戻る** (最大 1 個、 0 個許容の確認)、 menu 閉じる。 row は pill なし状態に。
- [ ] **C.5** 再度付与後、 pill × click → 0 個に戻る (× 経路でも 0 個許容)。
- [ ] **C.6** 裏で `POST /bulk` applied:1 を確認、 `dump('entity_mutations')` pending=0。

### D. whole-set 構築の不変条件 (核心、 他カテゴリ落とし事故防止)

`Smoke分野` (multi) と `Smoke-4b-single分野` (single) を **同一 card** で併用し、 子 row が自カテゴリのみ操作したつもりが他カテゴリのタグを誤って落とさないことを担保。

- [ ] **D.1** 同 `<cardId>` で multi カテゴリ `Smoke分野` に `Smoke-4b-M-γ` を付与 → `await readCardTags('<cardId>')` で 1 件 (option_id=`Smoke-4b-M-γ`).
- [ ] **D.2** 続けて single カテゴリ `Smoke-4b-single分野` に `Smoke-4b-S-α` を付与 → `readCardTags` で 2 件 (`Smoke-4b-M-γ` + `Smoke-4b-S-α`)。
- [ ] **D.3** multi カテゴリの `Smoke-4b-M-γ` pill × click → `readCardTags` で **1 件** (`Smoke-4b-S-α` のみ残る)。 single 側のタグは落ちない。
- [ ] **D.4** single カテゴリの `Smoke-4b-S-α` pill × click → `readCardTags` で **0 件**。 両カテゴリとも 0 個。
- [ ] **D.5** 裏の `/bulk` request body の `patch.value` が **常に card 全カテゴリ横断の whole-set** であること (Network → 該当 request body 確認、 自カテゴリ差分のみ送る誤実装ではないこと)。

### E. 案 a 取り直し経路 (UI 経由で初の観測、 核心)

UI から付与/解除 → server で whole-set replace + cards.updated_at bump → 同端末 reload で pull → IDB card_tags が server 真実で取り直される、 を観測する (別端末は同端末 reload で simulation)。

- [ ] **E.1** `<cardId>` の `tsBefore = await readCardUpdatedAt('<cardId>')` を記録。
- [ ] **E.2** multi カテゴリで `Smoke-B` を付与 → 即 pill 表示 (B.2 と同じ)。 ~500ms 後 `POST /bulk` applied:1。
- [ ] **E.3** 5 秒待機後 `tsAfter = await readCardUpdatedAt('<cardId>')` → `tsAfter > tsBefore` (ISO lexicographic 比較で OK、 server で bump された)。
- [ ] **E.4** **page reload** (Ctrl+R or Cmd+R、 IDB は保持) → pull 完走 → `readCardTags('<cardId>')` で `Smoke-B` 1 件 (server から取り直しても整合)。 UI 表示も pill 残存。
- [ ] **E.5** **全 pill を × で外す** (multi / single 両方を 0 個に) → `readCardTags` で 0 件 → reload → pull 後も `readCardTags` で **0 件**。 取り直し経路で空集合化が同端末でも保持される (B.3 相当を UI 経由でも観測)。
- [ ] **E.6** `dump('entity_mutations')` で pending=0 / failed=0、 `/api/pull` response の `cards.rows[]` に `<cardId>` が乗ること (Network 確認、 cards.updated_at bump 経路)。

### F. regression (既存機能の維持)

- [ ] **F.1** 同 card で title / sort_key / question_text / options / 解説 / メモ の編集 (Tag-2a 経路 A.1〜A.6 から 1〜2 件サンプル) が依然動作。
- [ ] **F.2** `/app/tags` のタグ管理 page (Tag-4a + Tag-4a-fix smoke 観点 A〜F 全部はやらないが、 任意の 1 観点 = カテゴリ作成 + option 作成 + リネーム + 削除) が依然動作。
- [ ] **F.3** 試験詳細 page の card 追加 (handleAddCard) + card 削除 (delete-card-button) が依然動作。
- [ ] **F.4** カテゴリ 0 件 user / 0 件 exam の placeholder 検証 (補助): 任意の test 用アカウントで `/app/tags` の全カテゴリを削除した状態で試験詳細 page を開く → 各 card のタグ section に「タグ管理ページでカテゴリを作成すると、 ここでタグを付けられます。」 placeholder + `/app/tags` link が表示される (本 smoke では skip 可、 unit test で担保済)。

### G. 全体

- [ ] **G.1** console error 0 (Clerk dev domain DNS 失敗は除外)、 全 `/api/*` 200。
- [ ] **G.2** 全観点完了時点で `dump('entity_mutations')` が pending=0 / syncing=0 / failed=0。
- [ ] **G.3** `dump('card_tags')` の状態が UI 表示および server 真実 (cleanup 後の期待) と一致。

### H. パフォーマンス感覚 (任意、 card 多い試験で)

- [ ] **H.1** card 数が多い試験 (10+ 件) を開き、 1 card のタグを 1 個付ける際の体感: UI 反映が即時 (< 100ms 体感)、 他 card の再描画で page が固まらない。 React DevTools Profiler で「タグ 1 個付与」 commit が **該当 card の CardTagsSection のみ** に止まることを確認 (Task 3 の memo + useMemo が効いている)。 全 card が re-render する場合は追加最適化判断の入力としてメモ。

## 観測手順 (補助)

- A〜D は UI 直接操作。 補助で `readCardTags('<cardId>')` を呼ぶ。
- E は reload + 5 秒待ちで pull 経由の取り直しを観測 (別端末 simulation は同端末 reload で代替)。
- H は React DevTools の Profiler tab で「commit 範囲」 を確認。

## FAIL 時の再現手順 + 原因仮説テンプレ

```
観点 #: D.3
症状: multi カテゴリの pill × click 後、 single カテゴリ側のタグも消滅
再現手順:
  1. <ここに dump('card_tags') 結果と Network /bulk request body 抜粋>
  2. <該当操作の click 順序>
原因仮説候補:
  A. card-tag-category-row.tsx の whole-set 構築で `allAssignedOptionIds` (parent 計算) ではなく `assignedOptionIds` (自カテゴリのみ) を base にしている → whole-set logic 確認
  B. parent (inline-card-list.tsx) で allAssignedOptionIds を計算 / props 渡しを忘れている → useMemo + props 渡し確認
  C. enqueue 時の `patch.value` が自カテゴリ option_ids のみ。 Tag-2c handler は whole-set replace なので、 自カテゴリだけ送ると他カテゴリ行も全 DELETE される → Network /bulk request body 確認
```

## cleanup (smoke 完了後にまとめて、 OT 判断)

Tag-4b smoke で残った状態の扱い:

- [ ] 維持案 (Tag-3 / Tag-4c smoke で再利用): 何もしない (`Smoke-4b-single分野` / `Smoke-4b-S-α` / `Smoke-4b-S-β` / `Smoke-4b-M-γ` を残置、 対象 card の card_tags は E.5 で空集合化済の前提)
- [ ] 一括削除案: `/app/tags` UI で本 smoke 追加分カテゴリ / option を削除 (server cascade で card_tags 自動 purge)
- [ ] Tag-2 / Tag-4a 残骸 (`Smoke分野` / `Smoke-B`) は本 smoke 対象外、 Tag-4a cleanup 参照

## 参照

- 設計仕様: `docs/superpowers/specs/2026-06-07-tag-4b-card-tags-section-design.md`
- plan: `docs/superpowers/plans/2026-06-07-tag-4b-card-tags-section.md`
- 案 a 設計判断: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` §4 (取り直し) / §5 (whole-set replace + updated_at bump)
- Tag-2 smoke (server 経路 PASS 済): `docs/superpowers/plans/2026-06-06-tag-2b-2c-smoke-checklist.md` / `docs/superpowers/sessions/2026-06-07-tag-2-stg-smoke.md`
- Tag-4a smoke (形式踏襲元): `docs/superpowers/plans/2026-06-07-tag-4a-smoke-checklist.md`
- Tag-4a-fix smoke (差分 checklist 形式): `docs/superpowers/plans/2026-06-07-tag-4a-fix-smoke-checklist.md`
- Tag-2a smoke (regression baseline): `docs/superpowers/sessions/2026-06-06-tag-2a-stg-smoke.md`
- UI 主要 file:
  - section: `app/(app)/app/exams/[id]/_components/card-tags-section.tsx`
  - category-row (whole-set 構築 + optimistic): `app/(app)/app/exams/[id]/_components/card-tag-category-row.tsx`
  - dropdown: `app/(app)/app/exams/[id]/_components/card-tag-add-dropdown.tsx`
  - pill: `app/(app)/app/exams/[id]/_components/card-tag-pill.tsx`
  - parent (4 store subscribe + memo): `app/(app)/app/exams/[id]/_components/inline-card-list.tsx`
- Tag-2c handler (whole-set replace + updated_at bump): `lib/cards/card-field-handlers.ts:CARD_FIELD_HANDLERS.tag_option_ids`
