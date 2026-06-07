# Tag-4a stg smoke 結果 (2026-06-07)

deploy: `a26ecd5` (feat Tag-4a タグ管理 page /app/tags) を含む 9 commits 反映済 stg。 Claude Code が Playwright MCP + DevTools (IndexedDB evaluate) で実行、 観測のみ。

UI 経由で初めて `entity_type='tag_category'` / `'tag_option'` を enqueue する sprint。 fetch 直送ではなく実 UI 操作で全 CRUD を確認。

## 結論

**Tag-4a stg smoke 全 PASS (機能観点)**。 UX 課題 2 件発見、 別 issue として記録 (Tag-4b 着手前に検討推奨)。

## 観点別結果

| # | 観点 | 結果 | 実観測根拠 |
|---|------|---|---|
| A.1 | nav「タグ」 → /app/tags 遷移 | ✅ | nav 5 番目「タグ」 表示、 click で navigate + title「タグ管理 — RecallMint」 |
| A.2 | desktop 2 column 描画 | ✅ | 左カテゴリリスト + 右 placeholder「カテゴリを選択してください」 |
| B.1 | カテゴリ作成 (Tag-4a-cat / multi) | ✅ (functionally) | POST applied:1 → reload pull で IDB 反映。 ⚠️ optimistic 更新未実装、 pull 経由 |
| B.2 | カテゴリ rename | ✅ | inline rename → POST → IDB name="Tag-4a-renamed"、 updated_at 進み |
| B.3 | active 切替 | ✅ | タイプ表示部分 click で右 panel が option list に切替。 ⚠️ name button が row 大部分を覆い、 row click が rename mode を誤起動 |
| B.4 | カテゴリ削除 confirm + 影響範囲 | ✅ | dialog「配下の option 0 件、 紐付き card 0 件のタグも消えます」 (IDB count、 server roundtrip ゼロ) |
| C.1 | option 作成 (opt-A / red) | ✅ | POST `tag_option create` patch.color='red' (色名文字列) applied、 reload pull で IDB 反映 |
| C.3 | color 変更 (red → blue) | ✅ | palette popover 13 cell 表示確認、 blue click で IDB color='blue' に更新 |
| C.4 | カテゴリ間移動 (→ Smoke分野) | ✅ | 「移動」 menu に他カテゴリ表示 (current 除外)、 click で IDB category_id 更新 |
| C.5 | option 削除 confirm | ✅ | dialog「0 件の card に紐付いています」、 削除確定で IDB から消滅 (tombstone 経路) |
| D | UNIQUE 違反 client 事前 | ✅ | 同 category 内同名「opt-A」 入力 → 即「同名が既に存在します」 alert 表示、 button disabled、 server 送信なし |
| E.1 | mobile Tabs fallback (400×800) | ✅ | viewport mobile で tablist「カテゴリ」 (selected) + 「option」、 1 active 切替 |
| E.2 | カテゴリ選択 → option tab 自動切替 | ✅ | カテゴリ click 後、 自動で 「option」 tab が selected |
| F.1 | 全 API 200 / console error | ⚠️ | stg /api/* は全 200。 console error 2 件は Clerk dev domain DNS 失敗 = Tag-4a と無関係 (Tag-2 smoke と同症状、 cookie で auth 動作中) |
| F.2 | entity_mutations pending 残らず | ✅ | pending=0 / syncing=0 / failed=0 |
| F.3 | 試験詳細 card 編集 regression | ✅ | card title 編集 fetch 直送 → applied:1 (Tag-2a/2c 経路無傷) |

## 重要確認点

### Tag-4a 設計判断の検証

- ✅ **CSS grid + Tabs fallback (react-resizable-panels なし)**: desktop 2 column / mobile Tabs 切替が動作
- ✅ **既存 ConfirmDialog 流用 (AlertDialog 不採用)**: 削除 confirm が a11y 担保で動作、 影響範囲 description 表示も成立
- ✅ **shadcn 3 component (Popover / DropdownMenu / Tabs) を file 追加 (npm dep ゼロ)**: 全動作、 git diff package.json 空確認済
- ✅ **color 保存形式: 色名文字列**: IDB color='red'/'blue' で保存、 UI 側 colorToClass で Tailwind class 変換
- ✅ **影響範囲 count は IDB ローカル**: 削除 confirm で「0 件」 表示、 server roundtrip ゼロ
- ✅ **UNIQUE 違反 client 事前 + server failed race**: client 即時表示が動作、 server 送信なし

## 発見した UX 課題 (別 issue 候補)

### 1. optimistic 更新なし

カテゴリ / option の作成・rename・color変更・移動・削除すべて、 enqueue 直後の UI 反映がない (pull 経由)。

- ユーザー操作 → form reset するが UI list は変わらず → 数秒〜の auto pull or reload まで反映なし
- 機能としては正常 (POST applied + IDB pull 反映)、 UX としては改善余地大
- 既存 card 編集 (inline-text-field) は server 確定を待たずに UI 即時表示 (Dexie put) で滑らかに動く
- Tag-4a の category-create-form / option-create-form / category-row rename / option-row rename / color popover etc. は **`enqueueEntityMutation` のみ呼び出し、 IDB put による即時反映を実装していない**
- → Tag-4b でも同じ問題が起きる可能性、 修正方針 (各 form/row で IDB put 即時反映) は Tag-4b 着手前に検討推奨

### 2. row click が name button hit

カテゴリ row 全体が `cursor:pointer` で active 切替を意図しているが、 name button が DOM 上で row 大部分を覆っているため、 name 部分 click は rename mode を起動 (active 切替に至らない)。

- 余白 (タイプ表示部分 / 削除 button 周辺) を click すれば active 切替動作
- 直感的でない UX、 ユーザーが混乱する可能性
- 修正方針: row click と name click の領域を分離 (name は明示的に edit icon button、 row 全体は active 切替) or row click を active 切替に明示割当 + name click のみ rename

## stg 残存変更 (cleanup)

- Tag-4a-cat (経由 Tag-4a-renamed) / opt-A は削除済 (smoke 兼 cleanup)
- Smoke分野 + Smoke-B は Tag-4b smoke 用に残存
- card `030c1b55-...` の title は「Tag-4a-regression-test」 (F.3 で更新) のまま、 Tag-4b smoke で regression 続行可

## 実行環境

- URL: stg.recallmint.nekotest.net
- Clerk test mode `+clerk_test` アカウント
- 対象 exam: `Sync1 Smoke Exam` (id=08ec7835-db67-4e45-b402-db776ba93048)
- 対象 card: 030c1b55-8477-4907-8cb6-4f71d7518865 (regression 用)

## 参照

- 設計仕様: `docs/superpowers/specs/2026-06-07-tag-4a-tag-manager-design.md`
- plan: `docs/superpowers/plans/2026-06-07-tag-4a-tag-manager-page.md`
- smoke checklist: `docs/superpowers/plans/2026-06-07-tag-4a-smoke-checklist.md`
- 設計判断: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md`
- commits: `fe952fe` (spec) / `120fb19` (spec/plan shadcn) / `a26ecd5` (feat Tag-4a)
