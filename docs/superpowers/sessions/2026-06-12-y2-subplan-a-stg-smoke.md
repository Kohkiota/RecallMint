# Y-2 Sub-plan A stg smoke 結果 (2026-06-12)

deploy: develop branch (top = `6a6ca19`、 T-A1..T-A9 + T-A4 fix 全 9 task 反映済 stg)。 Claude Code が Playwright MCP で CC 機械検証分 7 項目を実走、 観測のみ。

実機決済 / 実 webhook 配信 / 実 deletion (token 期限切れの実 sign 含む) は OT 分。

## 結論

**Y-2 Sub-plan A stg smoke 全 PASS (7/7)**。 重要 fix T-A8 (39fa8c5) / T-A9 (be67276) の機能観点 stg 確認は完了。 OT 実機 (実 webhook 配信 / `DELETION_TOKEN_SECRET` 欠落 throw) 検証後、 amend `[reviewed]` → force-with-lease push 経路に進める状態。

## 観点別結果

| # | 観点 | 結果 | 実観測根拠 |
|---|------|---|---|
| **1** | **T-A1 non-regression**: カード add → reload 残存 / delete → reload 消失 | ✅ | 「手動で試験を作成」→ exam `smoke-y2a-2026-06-12` 作成 → 「＋ カードを追加」 → bulk POST 200 `{ok:true,applied:1,failed:[]}`。 reload 後「カード (1 件)」 + 「新規カード 1」 表示。 削除確認 dialog → 「削除する」 → bulk POST 200 → reload 後「カード (0 件)」 + 「まだカードがありません」 表示。 |
| **2** | **T-A4 fix**: webhook routes 未認証 POST = handler 400 (auth redirect なし) | ✅ | `POST /api/webhooks/stripe` (with cookies / `credentials:'omit'` 両方) → 400 `"missing stripe-signature"`、 `Location` header 無し、 `redirected:false`、 `type:'basic'`。 `POST /api/webhooks/clerk` → 400 `"missing svix headers"` 同 shape。 proxy.ts callback 内 `isWebhookBypass()` early return が構造保証として動作。 |
| **3** | **T-A7 contact rate limit**: 6 連送 → 6 回目 rate_limited UI | ✅ | sign-in 状態 (`userId:user_3EimF5HA1eiBo468AIT75lqG0lx` key) で `/contact` から 6 連続送信。 run 1-5 = success ("お問い合わせありがとうございます" + 「もう一度送る」)、 run 6 = error UI に「rate_limited」 表示 (silent fail でない)。 |
| **4** | **T-A9 正常系**: deletion-status polling URL が token 付きで飛ぶ | ✅ | `/app/settings` render に DeleteAccountButton の `deletionStatusToken` prop = 3 segment base64url token (segment 0 decode = `user_3EimF5HA1eiBo468AIT75lqG0lx` = Clerk userId 一致) が 1 件 embed されているのを確認。 同 token で `GET /api/me/deletion-status?token=<TOKEN>` を手動実行 → 200 `{"status":"pending"}` + `Cache-Control: no-store`。 実削除トリガーなし (確認 dialog にも進めず)。 |
| **5** | **T-A9 token 不正系**: token 不正 / 改竄 / 形式違反 → 401/404 系 (200 で情報返さない) | ✅ | token なし / 空 = 400 `{"error":"invalid"}` / garbage = 401 `{"error":"unauthorized"}` / 偽 HMAC で再 sign した tampered token = 401 unauthorized / segment 2 件 = 401 unauthorized / segment 4 件 = 401 unauthorized。 全 path で `Cache-Control: no-store`、 200 + status leak 0 件。 |
| **6** | **T-A9 期限切れ token → 410 単体 test 存在確認** | ✅ | 既存。 (1) `tests/integration/me-deletion-status.test.ts:147-158` Case 9 `token 期限切れ → 410 { error: "token_expired" }` で 25h 前 sign → 410 + DB 未触 + `no-store` を assert。 (2) `lib/security/deletion-token.test.ts:70-78` で helper level に ttl 超過時刻 → `{ok:true, userId, expired:true}` 返却を assert。 追加不要。 |
| **7** | **console error 0** (Clerk dev key warning 除く) | ✅ | application JS error 0。 console 上の 10 件 ERROR は本 smoke 自身が deliberate に叩いた 400/401 fetch の DevTools 由来 (`Failed to load resource` log)、 page code 由来ではない。 warnings は Clerk dev key 警告 7 件のみ (smoke 仕様で除外対象)。 |

## Findings (smoke ⚠️ / 注記)

- ⚠️ **T-A7 UI 文言**: rate_limited 時 contact form の error 表示が server action 由来 raw key 「`rate_limited`」 のまま表示される (`components/marketing/contact-form.tsx:49` で `setError(res.error)` を素通し)。 機能観点 PASS (silent fail でない)、 UX 観点では「しばらく時間をおいて〜」等の日本語 message へ key→label mapping するのが望ましい。 Sub-plan B / C ではなく将来の UX polish item。
- ℹ️ **DeleteAccountButton polling 経路の structural 確認**: 実 polling fetch は user.delete() 成功後の `phase === 'polling'` でしか発火しないため、 本 smoke は (a) page render の token prop embed + (b) 同 token を直接 fetch で 200 受信、 の 2 経路で URL pattern の妥当性を傍証した。 fetch 本数の連続観測は OT 実機削除 smoke に委ねる。
- ℹ️ **テストデータ掃除**:
  - exam `smoke-y2a-2026-06-12` 作成 + 削除済 (UI から 4→3 件に戻ったことを確認)。
  - `contact_messages` 5 件 INSERT 済 (`email='smoke+y2a@example.com'` / `user_id` = 上記 userId 紐付け先 internal id / `subject='smoke Y-2 A run 1..5/6'`)。 OT 判断で SQL 掃除。

## CC 機械検証分でない smoke (OT 実機)

- 実 Stripe webhook 配信 (test event 投下 → signature verify → 200) — T-A8 H5 の本番経路。
- 実 Clerk webhook 配信 — 同上。
- 実 user.delete() 経由の deletion-status polling 連続観測。
- 期限切れ token を**実 sign**して 410 を観測 (24h ttl のため stg 上で時間操作する場合の手順は単体 test の time-shift で代替済、 OT 判断で skip 可)。
- `DELETION_TOKEN_SECRET` 欠落環境での startup throw 確認 — 破壊的なので OT 実機 (be67276 commit message のとおり case 6)。

## evidence (transient、 commit せず)

- bulk add response body (item 1) + contact rate_limited 後 viewport screenshot は CC session 内 Playwright MCP の transient output (`.playwright-mcp/` は gitignore)、 内容は本 .md の「観点別結果」 / Findings 欄に集約済。 再現は同 session の Playwright trace で可能、 永続コピーは取らない (TLS 経由の test PII 配慮)。
