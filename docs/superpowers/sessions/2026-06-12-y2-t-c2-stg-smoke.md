# Y-2 Sub-plan C T-C2 stg smoke (2026-06-12)

OT が 8 commit を push、 stg 反映後 (commit `c24b03b` = T-C2 段 2 まで含む)。 T-C2 helper (`lib/validation/review-session-bounds.ts`) の cap 値が stg 環境で実際に効くか、 `/api/review-events/bulk` を直接 POST して 4 case 検証。

## 結論

**全 4 case expected status 一致 = T-C2 段 1 (.max) + 段 2 (.min(1) tightening) ともに stg で稼働確認**。 異常なし、 次 task (T-C3) 着手可。

## 計測条件

- 環境: stg.recallmint.nekotest.net、 commit `c24b03b` (= develop top、 T-C2 段 2 まで反映)
- driver: Playwright MCP
- 計測時刻: 2026-06-12T15:21-15:22 (browser session 経由)
- 認証: test user (前 turn の T-B1 smoke から session 持続、 cookies 維持)
- 経路: `browser_evaluate` 内で `fetch('/api/review-events/bulk', { method: 'POST', headers: {'Content-Type':'application/json'}, body: ... })` を 4 回連投
- payload 構造: route.ts の `sessionSchema` / `eventSchema` に準拠 (session_id / card_ids / events[] の最小有効形)、 UUID は `crypto.randomUUID()` 生成

## 結果

| # | label | expected | actual status | zod message (body excerpt) | 判定 |
|---|---|---|---|---|---|
| 1 | `valid_empty_events` (session 完了 + events 0) | 200 | **200** | `{"ok":true,"failed":[]}` | ✅ |
| 2 | `boundary_selected_answer_ids_51` (events[0].selected_answer_ids = 51 件 `'opt-N'`) | 400 | **400** | `Too big: expected array to have <=50 items` (path = `events[0].selected_answer_ids`, code = `too_big`, maximum = 50, inclusive = true) | ✅ 段 1 `.max(50)` 効果 |
| 3 | `boundary_card_ids_2001` (session.card_ids = 2001 uuid) | 400 | **400** | `Too big: expected array to have <=2000 items` (path = `session.card_ids`, code = `too_big`, maximum = 2000, inclusive = true) | ✅ 段 1 `.max(2000)` 効果 |
| 4 | `item_format_empty_string` (events[0].selected_answer_ids = `['']`) | 400 | **400** | `Too small: expected string to have >=1 characters` (path = `events[0].selected_answer_ids[0]`, code = `too_small`, minimum = 1, inclusive = true) | ✅ 段 2 `.min(1)` tightening 効果 |

### Network reqid

Playwright MCP `browser_network_requests` 結果:

| reqid | method | path | status |
|---|---|---|---|
| 43 | POST | /api/review-events/bulk | 200 |
| 44 | POST | /api/review-events/bulk | 400 |
| 45 | POST | /api/review-events/bulk | 400 |
| 46 | POST | /api/review-events/bulk | 400 |

順序対応 = 表 # 1〜4 と 1:1 一致。

### Console 検証

新規 console output (`.playwright-mcp/console-2026-06-12T15-21-21-671Z.log`):

- LOG × 2: `review_events.flush.kick` / `entity_mutations.flush.kick` (`outcome: no-pending`) = mount 時の保全 trigger、 T-B1 cleanup 後の baseline 状態反映、 正常
- WARNING × 1: Clerk dev keys (stg では常時、 pre-existing)
- **ERROR × 3**: `Failed to load resource: 400` × 3 件 (case 2 / 3 / 4 由来、 browser が 400 response を resource error として log するため expected)、 内訳一致

異常 console error 0 件。

## Test user 影響評価

- 1 件のみ study_session row 残置 (case 1 の valid_empty_events、 status = 'completed' + events = 0)
- card_ids / event 行は無し (case 1 events 0 件、 case 2-4 は 400 で reject されたため DB write 到達せず)
- 残置影響は test user account の study_sessions 1 row、 OT 本アカウント未汚染、 cleanup 不要 (Y-2 範囲外、 試験スコア統計に1件参入する程度)

## 完了判定

T-C2 段 1 (cap 2000 / 50) + 段 2 (.min(1) tightening) ともに stg で expected 通り稼働。 T-C2 stg smoke = **PASS**。 T-C3 着手可。

## 関連

- T-C1 smoke は本 session log 範囲外 (OT が prod cutover 前に確認、 stg では Dexie outbox cap 30d の挙動は時間軸的に観測困難)
- 影響経路: `app/api/review-events/bulk/route.ts:53-79` の `sessionSchema` / `eventSchema` 経由
- helper: `lib/validation/review-session-bounds.ts` (commit `c24b03b` 時点)
