# Tag-2 (Tag-2b + Tag-2c) stg smoke 結果 (2026-06-07)

deploy: `9cb932d` (feat Tag-2b card_tags 独立同期 + Tag-2c 書込 handler) を含む 5 commits 反映済 stg。 Claude Code が Playwright MCP + DevTools (IndexedDB evaluate) で実行、 観測のみ (コード変更なし)。

書込 UI は未実装 (Tag-4) のため、 fetch 直送で trigger し、 「**送信 → pull 経由の反映 → IDB 観測**」 で実経路を通して取り直しを観測。 各送信後に reload + 5 秒待ちで pull を trigger。

## 結論

**Tag-2 stg smoke 全 PASS**。 案 a (cards.updated_at bump 起点の取り直し) が同期穴 (「関連付けのみ外す」 = `[A,B] → []` を含む) を正しく解決していることを実観測で確認。

## 観点別結果

| # | 観点 | 結果 | 実観測根拠 |
|---|------|---|---|
| 前提 1 | Dexie v5 + `card_tags` store | ✅ | IDB version=50 (= schema v5)、 stores に `card_tags` 存在 |
| 前提 2 | /api/pull に card_tags stream + cursor | ✅ | response keys に `card_tags` + `cursors.card_tags` |
| 事前準備 | tag_category + option ×2 (A=`68b474f2`, B=`9665475d`) 作成 | ✅ | bulk POST applied:3 → reload → IDB tag_categories / tag_options に反映 |
| A.1 | title 編集 regression | ✅ | applied:1 → reload → IDB cards.title="Smoke-2-A"、 updated_at 進み (07:04:09) |
| **B.1 単一付与** | value=[optA] | ✅ | applied:1 → reload → IDB card_tags 1 件 (option_id=optA)、 cards.updated_at 進み (07:05:17) |
| **B.2 付け替え (取り直し)** | value=[optB] | ✅ | applied:1 → reload → IDB card_tags 1 件 (**option_kind=B、 旧 A 消滅**)、 cards.updated_at 進み (07:05:58) |
| **B.3 空集合化 (案 a 核心)** | value=[] | ✅ | applied:1 → reload → **IDB card_tags 該当 cardId 0 件**、 cards.updated_at 進み (07:06:30)。 「関連付けのみ外す」 が pull 経由で正しく IDB から消えた |
| cards.updated_at bump | 各送信後 | ✅ | B.1: 07:05:17 → B.2: 07:05:58 → B.3: 07:06:30 と単調進む (handler 内独立 SQL の bump → pull で client mirror に反映) |
| B.4 (7) 非 uuid | per-mutation failed | ✅ | batch (failed×3 + 正常 title×1) → response applied:1 / failed:3、 巻き込みなし |
| B.4 (8) 101 件超 | failed | ✅ | 同 batch 内、 failed[] に含まれる |
| B.4 (9) 他 user option | failed | ⏭️ | skip (stg で他 user option 用意難。 単体 test `card-field-handlers.test.ts` で担保済) |
| B.4 (10) 存在しない option_id | failed | ✅ | 同 batch 内、 failed[] に含まれる |
| B.4 IDB 不変 | 失敗 mutation で card_tags 変化なし | ✅ | reload → IDB card_tags 該当 cardId 0 件 (B.3 後の状態維持) |
| C.1 option 削除 cascade | optA 削除 → card_tags 消滅 | ✅ | optA 付与 → 1 件 → tag_option=optA delete applied:1 → reload → IDB tag_options から optA 消滅 + 該当 card_tags 行消滅 (option_id 起点 cascade purge) |
| C.2 card 削除 cascade | 新 card + optB 付与 → card delete → card_tags 消滅 | ✅ | C2-card 作成 + optB 付与で card_tags 1 件 → card delete applied:1 → reload → IDB cards 消滅 + card_tags 0 件 (card_id 起点 cascade purge) |
| D.1 全 API 200 | | ✅ | stg /api/* は全 200 |
| D.1 console error 0 | | ⚠️ | console error 2 件あったが Clerk dev domain (`delicate-liger-51.clerk.accounts.dev`) への DNS 失敗 = Tag-2 と無関係の Clerk infrastructure (auth は cookie で動作中)。 regression 評価対象外 |
| D.2 entity_mutations pending 残らず | | ✅ | pending=0 / syncing=0 / failed=0 |

## Tag-2b の cursor 動作 (副次的観測)

最新 /api/pull URL: `since_cards=...&since_card_tags=2026-06-07T07:09:31.468Z` を含む = `sync_meta.cardTagsCursor` が正しく書込・読込されている。

## 核心観点の振り返り (案 a の検証)

### B.2 付け替え (取り直し動作)
- 送信: server で `card_tags` を `[optA] → [optB]` に whole-set replace + cards.updated_at bump
- reload pull: cards 増分 pull で **変更カード集合 = [対象 cardId]** を検知 → **IDB の該当 cardId の card_tags を全削除** → server 返却分 (= optB のみ) を bulkPut → 結果として IDB が `[optB]` 1件に置換
- 観測: IDB card_tags の option_id が optA → optB に切り替わった

### B.3 空集合化 (案 a が解決した同期穴の核心)
- 送信: server で `card_tags` を `[optB] → []` に置換 (DELETE のみ、 INSERT なし) + cards.updated_at bump
- reload pull: cards 増分 pull で **変更カード集合 = [対象 cardId]** を検知 → IDB の該当 cardId の card_tags を全削除 → server 返却分 (= 該当 cardId の card_tags は 0 件) を bulkPut → 結果として IDB が空集合に
- 観測: IDB card_tags 該当 cardId 0 件
- **これが「created_at 増分 pull だけでは拾えなかった減少」 を案 a が解決している実証**

## 実行環境

- URL: stg.recallmint.nekotest.net
- Clerk test mode `+clerk_test` アカウント (memory `stg-smoke-login`)
- 対象 exam: `Sync1 Smoke Exam` (id=`08ec7835-db67-4e45-b402-db776ba93048`)
- 対象 card: `030c1b55-8477-4907-8cb6-4f71d7518865` (= 前 Tag-2a smoke と同じ)
- 今 smoke で新設: tag_category `b61430cd-... Smoke分野` / tag_option `68b474f2-... Smoke-A` (C.1 で削除済) / `9665475d-... Smoke-B` / 新 card `266ecd91-...` (C.2 で削除済)

## stg 残存変更 (cleanup 未実施)

- card `030c1b55-...`: title="Smoke-2-A" / card_tags 0 件 (B.3 後の状態) / 前 smoke 残骸 (sort_key=null / question_text 末尾 "(smoke-2a)" / opt2 正解化) も残存
- tag_categories: `Smoke分野` 残存
- tag_options: optB (`Smoke-B`) 残存、 optA は C.1 で削除済
- cleanup は OT 判断 (Tag-3 / Tag-4 smoke でも使うなら維持、 clean に戻すなら一括 restore)

## 観察された注意事項

- console error 2 件は Clerk dev domain (`delicate-liger-51.clerk.accounts.dev`) への DNS 失敗。 アプリの認可は cookie session で継続動作、 全 /api/* 200 返却。 Tag-2 とは無関係のため regression 評価対象外。 OT 側で Clerk dev tenant の状況確認推奨。

## 参照

- 設計判断: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` §4 (案 a 確定)
- Tag-2b + 2c plan: `docs/superpowers/plans/2026-06-06-tag-2b-2c-card-tags-sync.md`
- smoke checklist: `docs/superpowers/plans/2026-06-06-tag-2b-2c-smoke-checklist.md`
- Tag-2a smoke 報告: `docs/superpowers/sessions/2026-06-06-tag-2a-stg-smoke.md`
- commits: `fab0948` (sessions 案 a 確定) / `4a9a763` (plan) / `9cb932d` (feat Tag-2b + 2c)
