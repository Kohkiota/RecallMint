# Tag-4a-fix stg smoke 結果 (2026-06-07)

deploy: `863299e` (feat Tag-4a-fix optimistic 更新 + row click 分離) を含む 12 commits 反映済 stg。 Claude Code が Playwright MCP + DevTools (IndexedDB evaluate) で実行、 観測のみ。

Tag-4a smoke (`docs/superpowers/sessions/2026-06-07-tag-4a-stg-smoke.md`) で発見した UX 課題 2 件 (optimistic 反映 + row click 分離) の fix sprint smoke。 核心 = 「送信直後 reload なしで UI 反映」。

## 結論

**Tag-4a-fix stg smoke 全 PASS (機能観点)**。 UX 課題 2 件解消を実 UI 観測で確認。 Tag-4b の card 列タグ UI 設計時、 本 fix 確立した型紙 (optimistic + pen icon edit trigger) を踏襲する。

## 観点別結果

| # | 観点 | 結果 | 実観測根拠 |
|---|------|---|---|
| A.1 | カテゴリ作成 → 送信直後 UI/IDB 即時反映 | ✅ | submit 直後 (wait なし) で IDB に fix-cat-1 put + UI list 即表示 (Tag-4a smoke では reload 必須だった) |
| A.2 | option 作成 → 送信直後 即時反映 | ✅ | IDB に fix-opt-1 (color='red') put + UI 即表示 |
| A.3 | rename → 即反映 | ✅ | pen icon click → input → 'fix-opt-renamed' → blur → IDB+UI 即更新 |
| A.4 | color 変更 → 即 pill 色変わる | ✅ | red → blue → IDB color='blue' に即時更新 |
| A.5 | カテゴリ間移動 → 即移動先 | ✅ | Smoke分野 選択 → IDB category_id 即時更新 + UI から元 panel 即消滅 |
| A.6 | category 削除 → 即消滅 (+ cascade purge) | ✅ | confirm dialog → 削除確定 → IDB+UI 即消滅。 影響範囲「配下 0 件 / card 0 件」 表示 |
| A.7 | option 削除 → 即消滅 | ✅ | confirm → 削除確定 → IDB+UI 即消滅 |
| A.8 | bulk POST applied + 最終 synced | ✅ | POST /api/entity-mutations/bulk × 6 件すべて 200 + entity_mutations: pending=0 / syncing=0 / failed=0 |
| **B.1** | **category-row 全体 click → active 切替** (rename 誤起動なし) | ✅ | row click → 右 panel が option list に切替、 rename input 表示なし (前回 UX 課題が解消) |
| **B.2** | **pen icon click → rename mode** (stopPropagation) | ✅ | 編集 button click → active element が input "option 名 編集"、 row active 切替には進まない |
| B.3 | 削除 × button → row click 巻き込まれない | ✅ | A.6 / A.7 で削除 button click → 確認 dialog 起動、 active 切替 / rename mode 起動なし |
| B.4 | keyboard (a11y): Tab focus → Enter で active 切替 | ✅ | `role="button"` + `tabIndex=0` で row focus → Enter で active 切替 (bg-slate-100 + 右 panel 切替) |
| B.5 | option-row も pen icon で rename 統一 | ✅ | option-row 「編集」 button が pen icon img、 click で rename input active (A.3 で確認) |
| C.1 | 試験詳細 card 編集 (Tag-2a 経路) regression | ✅ | fetch 直送 title 編集 → applied:1 |
| C.2 | Tag-4a 本体機能 (UNIQUE / 影響範囲 / mobile Tabs) 維持 | ✅ | A.6 で「配下 option / 紐付き card」 影響範囲表示維持を確認 |
| F.1 | console error 0 / 全 API 200 | ⚠️ | stg /api/* 全 200。 console error 2 件は Clerk dev domain DNS 失敗 = Tag-4a-fix 無関係 (Tag-2/4a 同症状) |
| F.2 | entity_mutations pending 残らず | ✅ | pending=0 / syncing=0 / failed=0 |

## Tag-4a-fix の核心検証

### Before (Tag-4a)
送信 → form reset するが UI list 変わらず → reload (pull) で初めて反映 → UX 摩擦「あれ反映されてない?」

### After (Tag-4a-fix)
送信直後に IDB put → `useLiveQuery` 即時再描画 → UI 即時反映。 server applied は裏で実行されて synced 化。

これにより:

1. **ユーザーの UX 摩擦が解消** (reload 不要)
2. **Tag-4b の card 列タグ UI で同パターンを踏襲できる型紙が確立** (optimistic IDB put + enqueue 並列 + pen icon edit trigger)
3. row click 全体が active 切替に明示割当、 pen icon が edit trigger に明示分離 = 操作モデルがユーザーに直感的

## 設計判断の検証

- ✅ **既存 `inline-text-field.tsx:159` の optimistic pattern 踏襲**: 同じ「IDB 即時 put + enqueue 並列」 で UI 即反映
- ✅ **client 自前 cascade purge**: 削除時に IDB から即時消滅 (server cascade と二重で idempotent)
- ✅ **user_id='' で put**: server pull で正しい値に上書き、 useLiveQuery は user 別 filter してないため見える範囲影響なし
- ✅ **lucide `Pencil` icon button**: rename trigger を明示、 row click と分離 (stopPropagation)
- ✅ **a11y `role="button"` + `tabIndex=0` + onKeyDown**: row 全体 keyboard 操作可能 (Tab focus + Enter で active 切替)

## stg 残存変更 (cleanup)

- fix-cat-1 / fix-opt-renamed は smoke 内で削除済 (兼 cleanup)
- Smoke分野 + 他 (asksdfsd / multi など、 OT 手動 smoke の残骸推測) は維持
- card 030c1b55 の title は「Tag-4a-fix-regression」 (C.1 で更新)

## 実行環境

- URL: stg.recallmint.nekotest.net
- Clerk test mode `+clerk_test` アカウント
- 対象 exam: `Sync1 Smoke Exam` (id=08ec7835-db67-4e45-b402-db776ba93048)
- 対象 card: 030c1b55-8477-4907-8cb6-4f71d7518865 (regression 用)

## 参照

- 元 UX 課題: `docs/superpowers/sessions/2026-06-07-tag-4a-stg-smoke.md`
- Tag-4a-fix plan: `docs/superpowers/plans/2026-06-07-tag-4a-fix-ux.md`
- Tag-4a-fix smoke checklist: `docs/superpowers/plans/2026-06-07-tag-4a-fix-smoke-checklist.md`
- commits: `19b1858` (plan) / `863299e` (feat Tag-4a-fix)
- 既存 optimistic pattern: `app/(app)/app/exams/[id]/_components/inline-text-field.tsx:159`
