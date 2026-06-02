# 課金ロジック (解約 / プラン変更) と関連スキーマ 調査

- **日付**: 2026-06-02
- **種別**: read-only 調査 (コード変更なし)
- **目的**: 課金まわり、特に解約・プラン変更フローと、関連 DB スキーマの現状把握

---

## 0. 結論 (要約)

- 課金は **Stripe Checkout (新規/upgrade) + Stripe Customer Portal (サイクル変更・解約)** の 2 経路。アプリ内に自前の解約/変更 API は持たず、状態変化はすべて **Stripe webhook 経由で DB に反映**する設計。
- **解約**には 2 系統ある: (a) ユーザー操作による subscription 解約 (Portal で予約 → 期間末に自動 cancel)、(b) **アカウント削除に伴う強制 cancel** (Clerk `user.deleted` webhook が Stripe sub を cancel)。両者は別経路・別ファイル。
- **プラン変更** (upgrade / downgrade / 月↔年) は実質すべて Stripe 側 (Checkout または Portal) で行い、アプリは webhook (`customer.subscription.updated` 等) を受けて `users` 行を上書きするのみ。proration は Stripe 任せ。
- 状態は `users` テーブルの 6 カラム (`plan` / `subscriptionStatus` / `stripeCustomerId` / `currentPeriodEnd` / `cancelAt` / `billingInterval`) に集約。Stripe の 10 status は内部 3 値に正規化。
- webhook は `stripe_events` / `clerk_events` で **idempotency** を取り、失敗は `deletion_failures` 監査 + Discord 通知 (`notifyOps`)。エラー時も 200 返却で再送ループを防止 (CLAUDE.md §Stripe-5)。

---

## 1. 関連スキーマ一覧 (`lib/db/schema.ts`)

### 1.1 `users` — 課金状態の集約 (schema.ts:62-109)

| カラム | 型 | 役割 |
|--------|-----|------|
| `id` | uuid PK | 内部 identity (auth provider 非依存) |
| `clerkId` | text UNIQUE NOT NULL | Clerk 連携 key。webhook の照合 key |
| `email` | text NOT NULL | Checkout の `customer_email` に使用 |
| `stripeCustomerId` | text UNIQUE | Stripe customer。subscription webhook の照合 key |
| `plan` | text `'free'\|'standard'\|'pro'` (default `'free'`) | 機能差を決定する唯一の軸 |
| `subscriptionStatus` | text `'active'\|'past_due'\|'canceled'` | Stripe 10 status を正規化した内部値 |
| `currentPeriodEnd` | timestamptz | 課金期間終了。解約後も**履歴として残す** |
| `cancelAt` | timestamptz | **解約予約日時**。`null` = 予約なし (唯一の解約予約 signal) |
| `billingInterval` | text `'month'\|'year'` (NULL 可) | 課金サイクル。`plan` と直交、機能差には不関与 |
| `createdAt/updatedAt` | timestamptz | 監査。`updatedAt` は `$onUpdate` |
| `deletedAt` | timestamptz | soft delete (users のみ。Stripe/audit retention 用) |

**重要 invariant / 設計メモ**:
- `plan='free'` ⇒ `billingInterval IS NULL` / `plan IN (standard,pro)` ⇒ `billingInterval IN (month,year)` (webhook + price-mapping で担保)。
- `subscriptionStatus='past_due'` は **二重意味**: (a) `+plan!=free` = 初回支払失敗の grace 期間 (アクセス保持) / (b) `+plan=free` = unpaid/incomplete 由来の downgrade 完了後。UI は `(plan, status)` 組合せで区別が必要。
- `billingInterval` 列導入 (2026-05-17) 以前の旧課金 user は NULL のまま → 次回 webhook で resync。transition window では `paid plan && interval NULL` が合法で、frontend は NULL を `'month'` 扱いで暫定表示する fallback 必須。

### 1.2 idempotency テーブル (schema.ts:167-181)
- `stripe_events` (`eventId` PK, `type`, `processedAt`) — Stripe webhook 重複排除。
- `clerk_events` (同構造) — Clerk webhook 重複排除。
- ルール B 例外: 両者とも `user_id` を持たない (event 単位)。

### 1.3 `deletion_failures` — 削除/cancel 失敗 監査 (schema.ts:189-202)
- FK なし (template ポータビリティ重視)。`userId` (uuid) + `clerkId` (text) を両保持。
- `failureKind`: `'list' | 'cancel' | 'customer_missing' | 'data_deletion'`。
- `subId` (cancel 失敗時のみ)、`errorMessage`、`createdAt`、`resolvedAt` (手動復旧マーク用)。

### 1.4 cascade 関係 (削除時)
- `users` のみ soft delete。子テーブルは hard delete。
- `exams` 削除 → `cards` / `source_documents` / `reviews` が FK `ON DELETE CASCADE` で連動。
- `study_days` / `contact_messages` は users.id への FK のみ (users は hard delete されないため) → webhook で**明示 DELETE** が必要。
- `ai_usage_users` / `user_settings` / `upload_records` も users.id に cascade。
- `ai_usage` (グローバル日次) / `stripe_events` / `clerk_events` は user 紐付けなし。

---

## 2. Stripe クライアントとキー検証 (`lib/stripe.ts`)

- `VERCEL_ENV=production` → `rk_live_`/`sk_live_` + `pk_live_` 必須 (test 拒否)、それ以外 → test 必須 (live 拒否)。module load 時に fail-fast (stripe.ts:16-58)。
- `new Stripe(key, { maxNetworkRetries: 2, timeout: 10000 })` (stripe.ts:78)。timeout 10s は Vercel function 予算を 1 本の hung call で食い潰さないため。
- `cancelWithRetry(subId)` (stripe.ts:87-95): HTTP 429 (`StripeRateLimitError`) のみ 1 秒 sleep + 1 回 retry。SDK の Idempotency-Key 自動付与で cancel は retry 安全。CLAUDE.md AI-5 (429 即停止) は Gemini 無料枠専用ルールで Stripe には**非適用** (paid API のため)。

### 価格 ID マッピング (`lib/stripe/price-mapping.ts`)
- 4 env (`STRIPE_PRICE_STANDARD_MONTHLY/YEARLY` / `STRIPE_PRICE_PRO_MONTHLY/YEARLY`) から双方向 map を module load 時に構築。欠落・重複は throw (fail-fast)。
- `resolveFromPriceId(priceId)` → `{plan, interval} | null` (webhook 用)。
- `priceIdFor(plan, interval)` → priceId (Checkout 用)。

---

## 3. プラン変更フロー

### 3.1 新規 / upgrade (Checkout)
- UI: `app/(app)/app/upgrade/upgrade-plans.tsx` — 月↔年 toggle + Standard/Pro の 2 カード。現プラン/下位プランは disabled。
- `app/(app)/app/upgrade/page.tsx`: **Pro 年額** (最上位) ユーザーは `/app` に redirect。
- server action `createCheckoutSession(formData)` (upgrade/actions.ts:11-50):
  - hidden input から `plan` + `interval` を受け取り検証 → `priceIdFor()` で priceId 解決。
  - `stripe.checkout.sessions.create({ mode:'subscription', client_reference_id: clerkId, customer: 既存 stripeCustomerId ?? undefined, customer_email: なければ email, success_url:/app?checkout=success, cancel_url:/app/upgrade })`。
  - DB row 未同期 (`getCurrentUser()` null) は `throw 'USER_NOT_SYNCED'` (webhook race 対策)。

### 3.2 サイクル変更 (月↔年) / 解約 / 解約撤回 (Customer Portal)
- server action `createBillingPortalSession()` (settings/actions.ts:7-24):
  - `stripe.billingPortal.sessions.create({ customer, return_url:/app/settings })` → redirect。
  - 月↔年 切替・解約予約・解約撤回・支払い方法更新はすべて Portal 内で完結。
  - upgrade ページの注記でも「同プランの月↔年切替・解約は『お支払い・解約を管理』から」と Portal に誘導。
- 変更結果は Stripe が `customer.subscription.updated` を発火 → §4.2 で DB 同期。proration は Stripe 任せ。

---

## 4. Stripe Webhook での状態反映 (`app/api/webhooks/stripe/route.ts`)

- 署名検証 `stripe.webhooks.constructEvent` (route.ts:32)。
- idempotency: `stripe_events` に `INSERT ... ON CONFLICT DO NOTHING RETURNING`、空なら duplicate として 200 即返し (route.ts:42-49)。
- handler エラーは outer catch で `notifyWebhookError` + **200 返却** (再送ループ防止、route.ts:54-66)。

### status 正規化 (route.ts:84-157)
- `normalizeSubStatus`: 10 status → 3 値。`active/trialing`→active、`past_due/unpaid/incomplete`→past_due、`canceled/incomplete_expired/paused`→canceled。
- `resolvePlanFromSub`: `(status, priceId)` → `{plan, billingInterval}`。
  - canceled 相当 → `free` / NULL。
  - `unpaid`/`incomplete` → `free` / NULL (downgrade)。
  - `active/trialing/past_due` → priceId から解決。priceId 欠落/不明 → `notifyOps` + free fallback (**throw しない**)。
  - `past_due` は plan を維持する設計 (grace 期間)。
- `extractSubFields` (route.ts:162-175): API basil 以降 `items.data[0].current_period_end` へ移動した点に対応。`cancel_at` → `cancelAt`。

### 処理イベント
- **`checkout.session.completed`** (route.ts:180-234): Step1 = `client_reference_id` (clerkId) で `stripeCustomerId` を UPDATE。Step2 = webhook 順序逆転対策で `session.subscription` を直接 retrieve し plan/status/interval/periodEnd/cancelAt を同期。UPDATE が 0 行 match (user.created 後着 race) なら Clerk metadata sync を**発火しない** (clobber 防止)。
- **`customer.subscription.created` / `.updated`** (route.ts:235-274): `stripeCustomerId` で UPDATE → matched なら `syncClerkPublicMetadata`。`.updated` で unlinked = Portal 由来の異常として `notifyOps` (`.created` の unlinked は checkout 後着で救済されるため alert 不要)。
- **`customer.subscription.deleted`** (route.ts:276-307): `plan='free'` / `billingInterval=null` / `subscriptionStatus='canceled'` / `cancelAt=null` に reset。`currentPeriodEnd` は履歴として保持。Clerk metadata を `free` に sync。unlinked は recover 経路なしの整合崩壊として `notifyOps`。

---

## 5. 解約 (Cancel) フロー 2 系統

### 5.1 ユーザー操作による subscription 解約
1. 設定ページ → Customer Portal。
2. Portal で「解約」 → Stripe が `cancel_at` を期間末にセット。
3. `customer.subscription.updated` webhook → `users.cancelAt` 更新 (plan は期間末まで維持)。
4. 設定ページ表示 (settings/page.tsx:45-48): `plan!=free && cancelAt` で「解約予約中、YYYY/MM/DD 終了」。
5. 期間末に Stripe が自動 cancel → `customer.subscription.deleted` → `plan='free'` 化。

### 5.2 アカウント削除に伴う強制 cancel (`app/api/webhooks/clerk/route.ts`)
- トリガ: `app/(app)/app/settings/delete-button.tsx` が Clerk `useReverification()` + `user.delete()` → Clerk `user.deleted` webhook。
- `handleUserDeleted(clerkUserId)` (route.ts:140-236):
  1. SELECT-first で `users.id` + `stripeCustomerId` 取得。未同期 (0 行) は `notifyOps` して return (順序逆転 edge)。
  2. `customerId` ありなら **transaction 外**で Stripe sub を cancel ループ: `stripe.subscriptions.list({customer, status:'all'})` を走査し、`CANCEL_TARGETS = {active, trialing, past_due}` のみ `cancelWithRetry`。
     - cancel 失敗 → `recordFailure(kind:'cancel')` / list 失敗 → `'list'` or `'customer_missing'` (canceled 済 ID を error_message に詰め admin が残 sub を grep 可能に)。
  3. DB transaction (最大 3 retry、transient error のみ。backoff 500/1000/2000ms): `users.deletedAt=now()` (soft) + `exams`/`study_days`/`contact_messages` を hard delete (exams cascade で cards/source_documents/reviews 連動)。最終失敗は `recordFailure(kind:'data_deletion')`。
- `CANCEL_TARGETS` 定義: clerk/route.ts:32-36。
- Stripe cancel は forward-only (失敗しても DB transaction は実行)。失敗は監査 + Discord で人手復旧に回す。

### 5.3 削除完了の polling
- `app/api/me/deletion-status/route.ts`: `not_found | pending | clerk_synced | completed`。delete-button が 1 秒間隔・最大 30 秒 poll。

---

## 6. プラン制限・カタログ

- `lib/plan-catalog.ts`: 表示用カタログ + `rankPlan` (0=Free <1=Std月<2=Std年<3=Pro月<4=Pro年) / `isUpgrade` / `planLabelFor` (interval NULL → "(同期中)")。年額は約 17% OFF。
- `lib/auth/plan-limits.ts`: backend ガード。`PLAN_LIMITS = { free:{ocrPagesPerMonth:30}, standard:{300}, pro:{null=無制限} }`。`limitsForOrFree(plan)` で未知値は free fallback。月次ページ数は `upload_records` から SUM。

---

## 7. Clerk Metadata Sync (`lib/auth/clerk-metadata.ts`)

- `syncClerkPublicMetadata({clerkId, dbUserId?, plan?})`: plan を Clerk publicMetadata → JWT sessionClaims に載せ、後続ページ/API で SELECT なしに plan 判定。
- 404 (削除済) は silent skip + `ok:true`、その他エラーは `notifyOps` + `ok:false`。
- caller: `user.created` (`{clerkId, dbUserId, plan:'free'}`)、Stripe subscription webhook (`{clerkId, plan}`)。

---

## 8. 主要ファイル索引

| ファイル | 役割 |
|---------|------|
| `lib/stripe.ts` | Stripe client + キー検証 + `cancelWithRetry` |
| `lib/stripe/price-mapping.ts` | price_id ↔ (plan, interval) 双方向 map |
| `lib/plan-catalog.ts` | 表示カタログ / rank / discount |
| `lib/auth/plan-limits.ts` | OCR ページ上限ガード |
| `lib/auth/clerk-metadata.ts` | publicMetadata sync |
| `lib/db/schema.ts` | users / stripe_events / clerk_events / deletion_failures 他 |
| `app/api/webhooks/stripe/route.ts` | subscription lifecycle 反映 |
| `app/api/webhooks/clerk/route.ts` | user.deleted → Stripe cancel + データ削除 |
| `app/api/me/deletion-status/route.ts` | 削除完了 polling |
| `app/(app)/app/upgrade/{page,actions,upgrade-plans}.tsx` | Checkout (新規/upgrade) |
| `app/(app)/app/settings/{page,actions,delete-button}.tsx` | Portal 起動 / プラン表示 / アカウント削除 |
| `lib/ops.ts` | notifyOps / notifyWebhookError (Discord) |

---

## 9. 観測された設計上の論点 (記録のみ、本調査では未対応)

- `subscriptionStatus='past_due'` の二重意味 — 4 値化 (unpaid 別立て) は schema コメント上 v1.x 検討扱い。
- `billingInterval` の transition window (旧課金 user の NULL) — frontend fallback に依存。次回 webhook で resync 前提。
- アプリ内に解約/変更の自前 API がなく Portal 全面依存 — Stripe Portal 設定 (許可する操作・proration 挙動) が UX を直接規定する。Portal 設定自体はコードに現れない (Stripe Dashboard 管理)。
