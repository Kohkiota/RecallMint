# Webhook Runbook (Stripe / Clerk)

Stripe / Clerk webhook の運用 (監視 / stuck 検知 / 手動 retry) 手順を集約する runbook (Y-2 T-C5、 audit §10.4 #10)。 webhook 経由の course of action (= incident response) を明確化し、 ops 担当が dashboard 1 個ずつ巡回しなくて済むよう 1 page 化。

## 1. Endpoint 一覧 (本番 / staging)

| Provider | Path | 用途 |
|---|---|---|
| Stripe | `POST /api/webhooks/stripe` | 課金イベント (checkout 完了 / subscription 状態変更 / payment failed 等) の idempotent 受信 + DB 反映 |
| Clerk | `POST /api/webhooks/clerk` | user 作成 / 削除 / 公開 metadata 同期、 削除時の Stripe subscription cancel + data deletion |

両 webhook とも `proxy.ts` の `isWebhookBypass()` (segment-boundary `/api/webhooks/*`) で middleware の Clerk 認証 gate を素通しさせる。 認証 gate 不通の場合 401 / redirect で webhook が永久に到達できない。 詳細: [lessons/2026-04-26-clerk-nextjs-webhook-architecture.md](../superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md)。

### Endpoint URL 物理パス

| 環境 | Stripe webhook URL | Clerk webhook URL |
|---|---|---|
| production | `https://recallmint.nekotest.net/api/webhooks/stripe` | `https://recallmint.nekotest.net/api/webhooks/clerk` |
| staging | `https://stg.recallmint.nekotest.net/api/webhooks/stripe` | `https://stg.recallmint.nekotest.net/api/webhooks/clerk` |

(現 prod / stg 共に `nekotest.net` ドメイン配下で稼働。 将来 custom domain (= `recallmint.com` 等の独自ドメイン) に移行した場合、 OT が本 §1.1 / §2 + Vercel project domain 設定 + Stripe/Clerk Dashboard endpoint 登録を同時に更新する。)

## 2. Dashboard 監視 URL

### 2.1 Stripe Dashboard

| 種別 | URL |
|---|---|
| Webhook 一覧 (live mode) | `https://dashboard.stripe.com/webhooks` |
| Webhook 一覧 (test mode) | `https://dashboard.stripe.com/test/webhooks` |
| 個別 webhook endpoint 詳細 | `https://dashboard.stripe.com/webhooks/we_<id>` (event 配信履歴 / response status / retry 設定がここで観察可) |
| 個別 event detail (本番 / live) | `https://dashboard.stripe.com/events/evt_<id>` |
| 個別 event detail (test mode) | `https://dashboard.stripe.com/test/events/evt_<id>` |

観察ポイント: webhook 詳細 page で「Webhook attempts」 タブを開くと、 直近の 配信 attempt が一覧表示される (status 200 = 成功、 400/500 系 = 失敗、 retry 中も観察可)。

### 2.2 Clerk Dashboard

| 種別 | URL |
|---|---|
| Dashboard root (最新 active instance に飛ぶ) | `https://dashboard.clerk.com/last-active?path=webhooks` |
| Instance 別 webhooks (URL pattern) | `https://dashboard.clerk.com/apps/<appId>/instances/<instanceId>/webhooks` |
| 個別 webhook 詳細 (Message logs / Endpoints / Signing secret 別タブ) | webhooks page 内の endpoint card クリック |

観察ポイント: Clerk webhook 詳細の「Message logs」 タブで、 過去 message 一覧 + 各 message の response code / payload / retry attempt が観察可。 配信失敗が連続している場合「Endpoints」 タブで endpoint 自体の health (= 直近 success rate) が見える。

## 3. Stuck 検知 signal

### 3.1 現状実装可能な signal (本 sprint 範囲)

DB schema 限定 = 現状 `stripe_events` / `clerk_events` 両 table とも `{ event_id, type, processed_at }` の 3 列のみ (status 列なし)。 idempotency 用途で「過去に受信処理した event_id」 を index する設計、 stuck 状態 (= 受信して処理途中で失敗) は **DB row として記録されない** (idempotency に乗らないため、 該当 row も書かれない)。

そのため stuck 検知は **Dashboard / Vercel function log 経由**で行う:

| signal | 観察場所 | 判定基準 |
|---|---|---|
| 配信失敗連続 | Stripe Dashboard webhook attempts | 直近 5 attempts が全部 4xx/5xx |
| 配信失敗連続 | Clerk Dashboard message logs | 直近 message の delivery status = failed が連続 3 回以上 |
| handler 例外 (5xx) | Vercel function log (本番) | `event: 'webhook.stripe.error' / 'webhook.clerk.error'` が短時間に複数発生 |
| signature 不一致 (400) | Vercel function log | `event: 'webhook.stripe.bad_signature' / 'webhook.clerk.bad_signature'` 急増 |
| OPS Discord 通知 | OPS_DISCORD_WEBHOOK_URL 配下 channel | `notifyWebhookError` 由来の post が短時間連続 (cf. `lib/ops.ts` の `notifyWebhookError`) |

`stripe_events` には `processed_at` 列があるが、 これは「処理完了 timestamp」 でなく「**idempotent insert 時の timestamp (= 受信処理を試みた瞬間)**」 = processing 中失敗を反映しない。 plan T-C5 制約に「`status='pending'` 経過時間 > 1h」 と書かれているが、 現状 schema に status 列なし = 文字通りの signal は実装不能 (= 3.2 で Y-3 帰属に整理)。

### 3.2 Y-3 で追加予定の signal (`stripe_events.status` 列追加後)

audit §10.3 (b) #20 + spec §10.2 に基づく Y-3 拡張:

- `stripe_events` に `status` 列 (`pending` / `processed` / `failed`) を追加
- handler 受信時に `status='pending'` で insert → 完了で `status='processed'`、 例外で `status='failed'`
- 定期 job (毎時 cron candidate) で `WHERE status='pending' AND processed_at < now() - INTERVAL '1 hour'` を SELECT → 結果あれば OPS Discord 通知 + retry 候補 list 生成

本 runbook はその実装を**前提として**書かれているわけではない (= 3.1 の Dashboard / function log signal で運用継続、 Y-3 着手後に再改訂)。

## 4. 手動 retry 手順

### 4.1 Stripe webhook event 単発 retry

Stripe Dashboard の event detail page (`https://dashboard.stripe.com/events/evt_<id>`) で 右上「Resend webhook」 button → endpoint を選択 → confirm。

CLI 経由:
```
stripe events resend evt_<id> --webhook-endpoint we_<id>
```
(`stripe-cli` を local install して `stripe login` 済の前提。 `--webhook-endpoint` を省略すると endpoint 選択 prompt が出る、 stg / prod / local の取り違い防止のため明示推奨。)

### 4.2 Clerk webhook message 単発 retry

Clerk Dashboard の webhook 詳細 → Message logs タブ → 該当 message を select → 「Replay」 (= Resend)。 endpoint 単位での再配信、 Stripe と同じ semantics。 CLI なし (= Dashboard 経由のみ)。

### 4.3 一括 retry (Stripe)

直近 1 時間に失敗した event を Dashboard で filter (Date range = past 1h、 Status = failed) → 表示された event を順次 Resend。 件数が多い場合は CLI ループ:
```
for id in $(stripe events list --type 'invoice.payment_failed' --limit 100 | jq -r '.data[].id'); do
  stripe events resend "$id" --webhook-endpoint we_<id>
done
```

### 4.4 Endpoint 全体の再有効化 (= 配信停止からの復帰)

Stripe Dashboard の webhook 詳細 → 「Disable endpoint」 で disable 後に「Enable endpoint」 で再有効化 (= 配信 queue が抜ける場合あり、 副作用注意)。 Clerk Dashboard も同様の disable/enable UI あり。

### 4.5 secret rotation (signature 不一致が大量発生時)

Stripe / Clerk Dashboard 共通: webhook signing secret を rotate → Vercel env (`STRIPE_WEBHOOK_SECRET` / `CLERK_WEBHOOK_SECRET`) を新値で更新 → redeploy。 rotation 中は signature 不一致が短時間続く可能性 (旧 secret で送信された event は新 secret で reject)、 Dashboard 側 rotation 後の events のみ受理。

## 5. Incident response checklist

stuck 検知後の決定木:

1. **signature 不一致**: secret 環境変数の取り違い (test / live)。 Stripe / Clerk dashboard で endpoint の secret と Vercel env の値が一致しているか確認 → 不一致なら 4.5 で rotate。
2. **handler 5xx 連発**: Vercel function log で error stack を確認 → 該当箇所 fix → redeploy → 失敗 event を 4.1 / 4.2 で retry。
3. **handler 4xx (bad_request 等)**: webhook payload 形式と handler の schema 期待値の乖離 (Stripe / Clerk API version 不一致が原因の場合多し)。 Stripe Dashboard で webhook API version 確認、 Vercel 側依存 SDK 更新で同期。
4. **配信失敗連続だが handler は受け取っていない**: middleware (`proxy.ts`) の `isWebhookBypass` が壊れている可能性、 `/api/webhooks/*` への直接 fetch で 200/4xx/5xx 区別確認 (401 が返るなら bypass 破壊 = 最優先 fix)。
5. **Clerk 側の delete handler 不通で課金キャンセル滞留**: `deletion_failures` table に row が残っているはず (`lib/db/schema.ts` 内)、 該当 row の clerk_id / user_id で再処理。 詳細: [users-schema-decoupling lesson](../superpowers/lessons/2026-04-30-users-schema-decoupling.md)。

## 6. 既知の制約 / 将来拡張

- **現状自動監視なし**: stuck 検知の cron job は未実装 (= Y-3 帰属、 §3.2)。 本 sprint 範囲では手動 dashboard 巡回 (= 日次 1 回程度の目視) で運用。
- **OPS Discord 通知**: `notifyWebhookError` が handler 例外時に発火するため、 「Discord に通知が来た = handler error が発生した」 を一次トリガとする。 通知不在 = sliently OK ではなく、 「dashboard で目視確認」 の補助。
- **将来 custom domain 移行時の URL 更新**: 現 prod は `recallmint.nekotest.net` 配下で稼働中だが、 将来 `recallmint.com` 等の独自ドメイン採用時に §1.1 / §2 の URL を OT が一括更新 (Vercel project 設定 + Stripe Dashboard endpoint 登録 + Clerk Dashboard endpoint 登録 + 本 runbook 更新を同時に)。

## 関連

- audit §10.4 #10 (本 runbook の起源)
- spec §10.2 (Permissions-Policy / Vercel env 整備、 関連 ops 対応)
- spec §10.3 (b) #20 (`stripe_events.status` 列追加、 Y-3 帰属)
- lessons:
  - [2026-04-26-clerk-nextjs-webhook-architecture.md](../superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md)
  - [2026-04-30-users-schema-decoupling.md](../superpowers/lessons/2026-04-30-users-schema-decoupling.md)
  - [2026-05-19-vercel-hobby-deployment-protection-and-webhooks.md](../superpowers/lessons/2026-05-19-vercel-hobby-deployment-protection-and-webhooks.md)
- code:
  - `app/api/webhooks/stripe/route.ts` / `app/api/webhooks/clerk/route.ts` (handler)
  - `proxy.ts` の `isWebhookBypass()` (auth gate 素通し)
  - `lib/ops.ts` の `notifyWebhookError` (Discord 通知)
  - `lib/db/schema.ts:192-206` (`stripe_events` / `clerk_events` schema)
