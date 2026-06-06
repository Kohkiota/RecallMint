# Tag-2a stg smoke 結果 (2026-06-06)

deploy: `7df0a93` (chore: dead applyCardCreate 撤去) + `d10af71` (feat: Tag-2a field handler registry 分解) 反映済 stg。 Claude Code が Playwright MCP で実行、 観測のみ (コード変更なし)。

## 結論

**全 10 観点 PASS**。 Tag-2a の handler registry 化は **既存 card 編集の挙動を一字も壊していない**ことを実観測で確認。

## 観点別結果

| # | 観点 | 結果 | 実観測根拠 |
|---|------|---|---|
| A.1 | title 編集 | ✅ | POST `{field:"title", value:"Smoke-2a-A"}` → `applied:1`、 IDB cards.title 反映、 sync_status=synced |
| A.2 | sort_key '' → null 正規化 | ✅ | POST `{field:"sort_key", value:""}` → applied:1、 IDB cards.sort_key=null (server side で null 化) |
| A.3 | question_text 編集 | ✅ | POST `{field:"question_text", value:"...(smoke-2a)"}` → applied:1、 IDB 反映、 synced |
| A.4 | explanation_text 入力 + '' → null | ✅ | 入力時 POST applied:1 → IDB="smoke-expl-2a"。 クリア時 POST `value:""` → IDB=null |
| A.5 | memo 入力 + '' → null | ✅ | 入力時 IDB="smoke-memo-2a"。 クリア時 POST `value:""` → IDB=null |
| A.6 | options 編集 + correct_answer_ids 再生成 | ✅ | options 配列 whole-set replace → applied:1、 IDB options 8 件保持、 **correct_answer_ids=["1","2"] (server 再生成、 client patch 不依存)** |
| B.7 | card 作成 (applyCardCreateWithId 経路) | ✅ | POST `{op:"create", patch:{exam_id, title:"新規カード 6", sort_key:"114"}}` → applied:1、 IDB に新 card row 生成、 exam card_count=6 |
| B.8 | card 削除 (applyCardDelete 経路) | ✅ | POST `{op:"delete"}` → applied:1、 IDB から該当 card 消滅、 exam card_count=5 復元 |
| C.9 | 未知 field 注入 → dispatch 段 failed | ✅ | fetch 直送 `{field:"nonexistent_field"}` + 同 batch の正常 `{field:"title"}` → `{ok:true, applied:1, failed:[<unknown 側の mutation_id>]}`。 **正常 mutation は巻き込まれず applied** (server defensive 機能、 envelope 早期 reject の代替 gate が動作) |
| D.10 | console error 0 / 全 API 200 | ✅ | console errors=0 (warnings=1=Clerk dev key、 既存)、 POST /api/entity-mutations/bulk × 10 件すべて 200 |
| D.11 | entity_mutations flush 後 pending 残らず | ✅ | IDB entity_mutations: pending=0 / syncing=0 / failed=0 |

## Tag-2a 重要不変点 (handler registry 化で破綻していないこと)

- ✅ '' → null 正規化 (sort_key / explanation_text / memo の 3 field で確認)
- ✅ correct_answer_ids 再生成 (options handler が server 側で options.is_correct から生成、 client patch 不依存)
- ✅ owner-scope (全 mutation applied = owner-scope 通過)
- ✅ envelope 緩和の代替 gate: 未知 field を server defensive で確実に弾く
- ✅ 既存 op='create' / op='delete' 経路 (Tag-2a で不変) も applied、 cascade で card_count も整合

## stg 残存変更 (cleanup は Tag-2b smoke 後にまとめて)

card id=`030c1b55-8477-4907-8cb6-4f71d7518865` (元 C9-edit-A) に以下が残存:

- title: `C9-edit-A` → `Smoke-2a-A`
- sort_key: `109` → null
- question_text 末尾に ` (smoke-2a)` 追記
- options opt2.is_correct: false → true (correct_answer_ids: ["1"] → ["1","2"])

OT 判断: **Tag-2b smoke でも同 card / 同 exam を使うため、 restore は 2b smoke 完了後にまとめて** (二度手間回避)。

## 実行環境

- URL: stg.recallmint.nekotest.net
- Clerk test mode `+clerk_test` アカウント (memory `stg-smoke-login`)
- 対象 exam: `Sync1 Smoke Exam` (id=08ec7835-db67-4e45-b402-db776ba93048)

## 参照

- 設計判断: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md`
- Tag-2a plan: `docs/superpowers/plans/2026-06-06-tag-2a-field-handler-registry.md`
- commit: `7df0a93` (chore dead 撤去) / `d10af71` (feat Tag-2a)
