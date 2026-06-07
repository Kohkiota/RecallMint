# Tag-4a-fix stg smoke checklist (optimistic 更新 + row click 分離)

> 対象 commit: Tag-4a-fix Task 1 (optimistic) + Task 2 (row click 分離 + pen icon) を統合した単一 commit (controller が後で積む)。
>
> **核心**: Tag-4a 本体 smoke (`docs/superpowers/plans/2026-06-07-tag-4a-smoke-checklist.md`) で機能 PASS / UX 課題 2 件発見 (`docs/superpowers/sessions/2026-06-07-tag-4a-stg-smoke.md` §UX 課題)。 本 checklist は **fix 分の差分のみ** をチェックする。 機能網羅 (UNIQUE 二段防御 / 影響範囲表示 / mobile Tabs 等) は本体 checklist を再利用。

## 環境情報

- URL: https://stg.recallmint.nekotest.net/app/tags
- アカウント: `komail9server+clerk_test@gmail.com` / pw `komail9server` (memory `stg-smoke-login`)
- IDB 名: `recallmint`
- 残骸 (Tag-4a 本体 smoke 後): `Smoke分野` (multi) + `Smoke-B` (`Smoke分野` 配下)
- deploy commit: Tag-4a-fix 統合 commit (controller が push 後に記入)

## 事前準備

1. ログイン → `/app/tags` を 1 回開いて pull 完走 (`tag_categories` / `tag_options` 復元)。
2. DevTools console を開き、 必要時 `dump(store)` (本体 checklist §事前準備 step 2) で IDB 観測。
3. Network panel で `/api/entity-mutations/bulk` と `/api/pull` を filter。 **本 smoke の核心は「reload なしで UI に反映される」 こと**、 IDB 観測は補助。
4. 本 smoke で追加する残骸: `Smoke-4a-fix分野` カテゴリ + `Smoke-4a-fix-α` option。

## 観点 (PASS/FAIL チェックリスト)

PASS = (1) 期待動作通り、 (2) console error 0 (Clerk dev domain DNS 失敗除外、 Tag-4a 本体と同様)、 (3) 全 API 200。

### A. Optimistic 反映 (Task 1)

reload なしで UI に即時反映されることが核心。 enqueue 後 ~500ms 程度の debounce + POST は走るが、 **UI 反映は POST 完了を待たない** (IDB put → useLiveQuery 再描画)。

- [ ] **A.1** カテゴリ作成: name `Smoke-4a-fix分野` 入力 + `multi` 選択 + 「＋ カテゴリ追加」 click → **送信直後 (reload なし)** に左 list に行追加 + 自動 active 化。 form reset (name 空 / multi 維持)。
- [ ] **A.2** カテゴリ rename: `Smoke-4a-fix分野` 行の pen icon click → input 化 → ` (renamed)` 追記 → blur → **即時** に新名で表示 (旧名残らない)。 値を元に戻す。
- [ ] **A.3** option 作成: `Smoke-4a-fix分野` active 状態で name `Smoke-4a-fix-α` + color `red` で 「＋ option 追加」 → **送信直後** に右 list に row 追加 (red pill)。
- [ ] **A.4** option rename / color変更 / カテゴリ移動 (→ `Smoke分野`) / 戻す (→ `Smoke-4a-fix分野`) → 各操作 **送信直後** に UI 反映。 移動時は active カテゴリ panel から即消滅、 移動先 panel に即出現。
- [ ] **A.5** option 削除: `Smoke-4a-fix-α` 行末「×」 → confirm 「削除する」 → **削除直後** に右 list から消滅。
- [ ] **A.6** カテゴリ削除 (cascade): まず C.3 で `Smoke-4a-fix-α` を `Smoke-4a-fix分野` 配下に再作成 → カテゴリ削除 confirm 「削除する」 → **削除直後** に左 list から `Smoke-4a-fix分野` 消滅 + 配下 `Smoke-4a-fix-α` も即消滅 (client 自前 cascade purge) + active null → 右 panel placeholder に戻る。
- [ ] **A.7** (補助観測) A.1〜A.6 完了時点で `dump('entity_mutations')` の pending=0 / failed=0、 `dump('tag_categories')` / `dump('tag_options')` が server 真実と一致 (server cascade + pull 反映で残骸なし)。

### B. Row click 分離 + pen icon button (Task 2)

- [ ] **B.1** category-row 全体 click: name span 上 / 余白 (タイプ表示部分 / 削除 button 周辺) のどこを click しても **active 切替のみ** (rename mode 起動しない)。 active 切替で右 panel が該当カテゴリ option list に切替。
- [ ] **B.2** category-row の pen icon (lucide Pencil、 `aria-label="編集"`) click → rename mode 起動 (input 表示)。 row 全体 click イベントは発火しない (active が他カテゴリに勝手に切替わらない)。 input 表示中は pen icon 非表示。
- [ ] **B.3** category-row 削除 button (`aria-label="カテゴリ削除"`) click → confirm dialog 表示。 active 切替や rename mode は **発火しない** (stopPropagation)。 「キャンセル」 で何も起きないこと。
- [ ] **B.4** keyboard a11y (category-row): Tab で row に focus → Enter (or Space) で active 切替 + pen icon button が **独立 Tab stop** で focus 可 (Tab で pen icon に進める)。 pen icon focus 中 Enter で rename mode 起動。
- [ ] **B.5** option-row: name span click では **何も起きない** (rename mode 非起動)。 pen icon (`aria-label="編集"`) click が rename trigger の **唯一経路**。 color pill / 「移動」 / 削除 button それぞれ独立 click 可能 (互いに発火しない)。

### C. 既存 regression なし

- [ ] **C.1** `/app/exams/<examId>` で card title 編集 (Tag-2a 経路、 本体 checklist F.4 流用) が依然動作。
- [ ] **C.2** `/app/tags` の Tag-4a 本体観点 (A〜F のうち UNIQUE 二段防御 D.1 / 影響範囲表示 B.4 / mobile Tabs E.1〜E.4) が依然 PASS。 本 fix は UI layer のみの変更、 server / sync 経路に影響なし。

## FAIL 時の再現手順 + 原因仮説テンプレ

```
観点 #: A.6
症状: カテゴリ削除直後、 配下 option が UI から消えない (reload で消える)
再現手順:
  1. <カテゴリ id / option id を dump で控える>
  2. <削除 click 直前 / 直後の dump('tag_options') 差分>
原因仮説候補:
  A. category-row.tsx の cascade purge で `db.tag_options.where('category_id').equals(catId).delete()` が抜けている → `category-row.tsx` の delete handler 確認
  B. card_tags purge が optionIds 配列空で skip 分岐に入っている → `.anyOf([])` の挙動確認
  C. useLiveQuery の依存 key が category_id を含んでいない → `option-list.tsx` の where 句確認
```

## 参照

- 設計仕様 (本 fix の元): `docs/superpowers/sessions/2026-06-07-tag-4a-stg-smoke.md` §UX 課題
- plan: `docs/superpowers/plans/2026-06-07-tag-4a-fix-ux.md`
- 本体 smoke checklist: `docs/superpowers/plans/2026-06-07-tag-4a-smoke-checklist.md`
- 本体 smoke 結果: `docs/superpowers/sessions/2026-06-07-tag-4a-stg-smoke.md`
- 参照実装 pattern: `app/(app)/app/exams/[id]/_components/inline-text-field.tsx:159` (IDB 即時 put + enqueue 並列)
