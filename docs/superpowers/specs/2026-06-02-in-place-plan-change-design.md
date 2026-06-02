# 既存契約者プラン変更の in-place 化 — 設計 (spec)

- **日付**: 2026-06-02
- **種別**: design / spec (brainstorming output。実装は後続 plan)
- **前提調査**: `docs/superpowers/sessions/2026-06-02-billing-cancel-change-schema-investigation.md`
- **clean slate**: Clerk users / Stripe customer / DB は stg/prod とも実ユーザー 0。Stripe は 2 product × 2 price (月/年) に作り直し済、env 4 本 (`STRIPE_PRICE_STANDARD_MONTHLY/YEARLY`, `STRIPE_PRICE_PRO_MONTHLY/YEARLY`) は新 price ID 設定済。

---

## 1. 背景と問題

既存契約者のプラン変更が Checkout (`mode:subscription`) 経由で **新規 subscription を作り二重契約**になる (調査 §2)。`users` に subscription id 列が無く (調査 §3)、in-place 変更の足場も無い。

## 2. ゴール / 非ゴール

**ゴール**: 有料契約者のプラン変更を Checkout でなく `subscriptions.update` / subscription schedule による **in-place 変更**にし、二重契約を構造的に消す。新規 (free→有料) のみ Checkout を維持。

**非ゴール / 維持**:
- Customer Portal は支払い方法・請求履歴・解約のみ。プラン変更は出さない。
- Free = Stripe subscription を持たない DB 上の無料状態。Free への移行 = 解約 (Portal)。プラン変更 UI では扱わない。
- price ↔ (plan, interval) は env 読みの既存 `lib/stripe/price-mapping.ts` 方式を維持 (Stripe price metadata は使わない)。
- 金額プレビュー (upcoming invoice) は MVP スコープ外。

---

## 3. データモデル

`users` に列追加 (Drizzle migration):

- `stripeSubscriptionId text` (nullable, unique)。

**invariant: 1 user 1 active subscription**。`stripeSubscriptionId` は subscription 系 webhook で populate / clear する (§6)。`subscriptionStatus` / `plan` / `billingInterval` / `cancelAt` / `currentPeriodEnd` の既存 6 カラムは現状維持 (調査 §1.1)。`stripeSubscriptionId` 以外の schema 変更は無し。

---

## 4. ドメインロジック (新規 `lib/stripe/subscription.ts`)

Stripe 呼出とビジネス判定を 1 ファイルに集約し、純粋部分を単体テスト可能にする。

### 4.1 `resolveActiveSubscription(user)` — invariant 強制
- `user.stripeSubscriptionId` 有: `subscriptions.retrieve(id)` → status が active 系 (`active`/`trialing`/`past_due`) かつ `customer` が `user.stripeCustomerId` と一致を検証。OK なら `{ sub, itemId: sub.items.data[0].id }` を返す。不一致 → `AmbiguousSubscriptionError`。
- `user.stripeSubscriptionId` 無 (clean slate の保険 fallback): `subscriptions.list({ customer, status:'active' })` で **active が 1 本だけなら採用**。0 本 → `NoSubscriptionError`、複数 → `AmbiguousSubscriptionError`。
- **自動で 1 本を選ばない**。Ambiguous/不一致は呼出側で `notifyOps` + 汎用エラー → 手動 reconcile。

### 4.2 `classifyChange(currentRank, targetRank)` → `'upgrade' | 'downgrade' | 'same'`
- rank は既存 `lib/plan-catalog.ts` の `rankPlan` を再利用 (free=0 / std月=1 / std年=2 / pro月=3 / pro年=4)。
- `target > current` = upgrade (月→年含む) / `target < current` = downgrade (tier 下げ・年→月含む) / `==` = same。

### 4.3 `getPendingState(sub)` → `{ hasPendingUpdate: boolean, scheduleId: string | null, cancelScheduled: boolean }`
- `hasPendingUpdate = sub.pending_update != null`
- `scheduleId = sub.schedule ?? null`
- `cancelScheduled = sub.cancel_at != null || sub.cancel_at_period_end === true`

### 4.4 Stripe 操作本体 (全て idempotency key 付与, §5.4)
- `applyUpgrade(subId, itemId, targetPriceId, idempotencyKey)`:
  `subscriptions.update(subId, { items:[{ id:itemId, price:targetPriceId }], proration_behavior:'always_invoice', payment_behavior:'pending_if_incomplete' })`。
  支払成功時のみ Stripe が反映、失敗時は pending_update に保持され**旧 price 維持** (Context7 で挙動確認済)。
- `scheduleDowngrade(sub, itemId, targetPriceId)`:
  `sub.schedule` 無なら `subscriptionSchedules.create({ from_subscription: subId })` で schedule 化 → `subscriptionSchedules.update(scheduleId, { end_behavior:'release', phases:[<現 phase: 現 price, end_date=current_period_end>, <次 phase: targetPrice, proration_behavior:'none'>] })`。current_period_end 以降に下位 price へ切替、proration なし。
- `cancelScheduledDowngrade(scheduleId)`: `subscriptionSchedules.release(scheduleId)`。schedule を解放し subscription を**現 phase で継続**。`subscriptionSchedules.cancel` は subscription 自体を cancel しうるため**使わない**。

---

## 5. プラン変更フロー

### 5.1 アップ/ダウン判定はサーバ側 (rank 比較)
ユーザーは行き先プランを選ぶだけ。`classifyChange` で内部判定。

### 5.2 アップグレード (即時適用)
1. 確認 modal (金額なし) → 「今すぐ差額が請求され、プランが変更されます」。
2. `changePlan` action: `resolveActiveSubscription` → §5.5 ブロック判定 → `applyUpgrade`。
3. `/app?billing=upgrade` に redirect。DB 確定は webhook (§6)。

### 5.3 ダウングレード (期末適用)
1. 確認 modal (金額なし, **推奨で必須化**) → 「現在の請求期間終了後に {plan} へ切り替わります。それまでは現在のプランを利用できます」。
2. `changePlan` action: `resolveActiveSubscription` → §5.5 ブロック判定 → `scheduleDowngrade`。
3. `/app?billing=downgrade` に redirect。

### 5.4 idempotency key (操作単位で一意)
- **deterministic key (`changePlan:{subId}:{targetPrice}`) は使わない**。Stripe の idempotency 保持期間 (~24h) 内に同 sub+同 target への正当な再操作が前回レスポンスを replay する事故を招く。
- ユーザーの 1 回の confirm/submit ごとに `operationId` (UUID) を生成 (confirm modal 確定時に client 生成 → hidden input で送信)。idempotency key = `changePlan:{userId}:{operationId}`。
- 同一操作の retry (SDK 自動 network retry 含む) は同じ key を再利用。別操作なら同 subId/targetPrice でも別 key。
- **24h 抑止ロジックは持たない**。二重 submit / 同時変更防止は別レイヤー (§5.5 + button disable)。

### 5.5 同時変更ブロック (DB フラグ無し、retrieve で都度判定)
`getPendingState` を見て以下は新規プラン変更を**受け付けない** (全 CTA disable + 文言「処理中の支払い完了 または 予約キャンセルを先に行ってください」):
- `hasPendingUpdate` (アップグレード即時課金が処理中)
- `scheduleId != null` (ダウングレード予約中)
- `cancelScheduled` (解約予約中。`cancel_at`/`cancel_at_period_end`)。解約予約がある subscription への downgrade schedule 作成はブロックし、先に Portal で解約予約を取り消すよう案内。

**例外**: ダウングレード予約 (`scheduleId`) のキャンセルのみ許可。プラン変更ページ上部に「{plan} へのダウングレード予約中 ({date}) — 取消」を表示、`cancelDowngrade()` action → `subscriptionSchedules.release`。

---

## 6. Webhook (DB が最終正)

`app/api/webhooks/stripe/route.ts` を拡張。redirect 到達では DB を確定しない。全 handler は `stripe_events` で既存どおり冪等 (調査 §4)。

### 6.1 現在プランの正規化規則 (明記)
- **現在プランは常に actual subscription item の current price から正規化**する (`sub.items.data[0].price.id` → `resolveFromPriceId`)。
- **`pending_update.subscription_items` 内の target price を現在プランとして扱わない**。
- `past_due` 等の status 変更があっても、pending_update の target price へ DB plan を先行更新しない。
- 既存の `past_due` → plan 維持 (grace) 処理 (調査 §4 `resolvePlanFromSub`) と矛盾しないこと。

### 6.2 イベント別
- `customer.subscription.created` / `.updated`: 既存の plan/status/interval/periodEnd/cancelAt 同期に加え **`stripeSubscriptionId = sub.id` を populate**。schedule 期末発火の `.updated` (新 price) は既存ロジックが current item price から自動反映。
- `customer.subscription.deleted`: 既存 reset (plan=free 等) に **`stripeSubscriptionId = null`** を追加。
- **`invoice.payment_failed` (新規追加、現状未処理)**: DB plan を**変更しない** (plan/status は `.updated` が最終正)。観測性のため `notifyOps`。upgrade 即時課金失敗時は pending_update のまま旧 price 維持 = DB 据え置きで整合。
- pending update の applied / expired 系イベントは、必要に応じ監視対象に追加 (MVP では `.updated` の current price 正規化で収束するため任意。観測性目的なら notifyOps のみ)。

### 6.3 収束保証
Stripe 側変更済・DB 更新失敗時は、webhook 再送 または 次回 `resolveActiveSubscription`/retrieve 再同期で最終収束 (既存パターン)。

---

## 7. UI

### 7.1 プラン変更ページ (`app/(app)/app/upgrade/`, path 維持)
- `page.tsx`: **pro+year → /app redirect を撤廃** (全員入れる)。paid なら `resolveActiveSubscription` + `getPendingState` を呼び、pending/予約情報を client に渡す。free はサブスク無 → Checkout 経路。
- `upgrade-plans.tsx` (label「プラン変更」):
  - 全プラン (Standard/Pro × 月/年 toggle、Pro 年額含む) を表示。**Free カードは足さない**。
  - **現プランのみ選択不可** (rank 同値、transition window の interval NULL は month 同 rank 扱い、現行踏襲)。それ以外は upgrade/downgrade とも選択可。
  - 既存の `targetRank < userRank → disabled` 分岐は**撤廃** (下位プランも期末ダウングレードに繋ぐ)。
  - free user: 各 CTA は従来どおり `createCheckoutSession` (Checkout)。paid user: upgrade/downgrade とも確認 modal → `changePlan`。
  - pending/予約/解約予約中は全 CTA disable + 案内文 (§5.5)。予約中は上部に取消 banner。

### 7.2 確認 modal (新規 client component)
- `components/ui/` に dialog 無し → 軽量 custom modal を新規 (CLAUDE.md「テンプレ AI デザイン回避」「世界観統一」、`window.confirm` 不可)。
- upgrade / downgrade 双方で表示 (金額なし、§5.2 / §5.3 の文言)。

### 7.3 設定ページ (`settings/page.tsx`)
- paid: 「プラン変更」(/app/upgrade) + 「お支払い・解約を管理」(従来 Portal) の 2 ボタン構成。
- free: 従来どおり「プランを選択」(/app/upgrade → Checkout)。

### 7.4 ダッシュボード / 他 CTA
- `/app` 等の「アップグレード」CTA は全 plan で「プラン変更」に統一 (pro+year 除外を撤廃)。

### 7.5 成功文言 (`/app?billing=<kind>` を client banner が表示)
- `/app` は現状 `?checkout=success` を表示する仕組みが無い → 小さな client banner を新規追加。
- 既存 `?checkout=success` (Checkout success_url) は **`?billing=new` に統合**。
- kind 別文言:
  - `new`: 決済を受け付けました。反映まで少し時間がかかる場合があります。
  - `upgrade`: 支払い確認後にプランが反映されます。
  - `downgrade`: 現在の請求期間終了後にプランが変更されます。
  - `cancel`: 現在の請求期間終了後に Free へ戻ります。(Portal 経路。MVP では従来どおり Portal return、本 banner 統合は任意)
- どの操作経路も最終的に `/app` 着地。

---

## 8. エラー処理

- `NoSubscriptionError` / `AmbiguousSubscriptionError`: action で catch → 汎用エラー表示 + `notifyOps` (手動 reconcile)。自動で subscription を 1 本選ばない。
- ブロック条件 (§5.5) 該当: 汎用案内文を返し操作不可。throw ではなく UI 状態で表現。
- Stripe 成功・DB 失敗: §6.3 で収束。

---

## 9. テスト方針

- **Unit (Vitest, Stripe 全 mock, 実 API 禁止)**:
  - `resolveActiveSubscription`: id 有/無 × 0/1/複数/customer 不一致。
  - `classifyChange`: rank 全遷移 (up/down/same、月↔年、tier 跨ぎ)。
  - `getPendingState`: pending_update / schedule / cancel_at の各組合せ。
  - idempotency key 生成: operationId 単位で一意、deterministic でないこと。
  - webhook: `stripeSubscriptionId` populate / delete で null / `invoice.payment_failed` で DB plan 不変 / schedule 期末 `.updated` で current price から正規化 / pending_update の target を現在プランに昇格しないこと / `stripe_events` 冪等。
- **Stripe 実走 smoke (OT 依頼)**: in-place update (即時課金・pending_update)、schedule 期末切替、`release` 後に current price / billing anchor が不変なこと (Context7 未確認の実挙動)。課金 API 呼出のため CLAUDE.md smoke 規律で OT 担当。
- Claude Code は UI〜action 入口を DevTools (chrome-devtools/playwright) で検証 (証拠: Network 順序 / console / snapshot)。

---

## 10. 環境変数

新規環境変数の追加は無し (price env 4 本は OT 設定済)。`.env.example` 変更不要。

---

## 11. 残留判断 (OT 承認済)

- R1: `?checkout=success` → `?billing=new` 統合。
- R2: custom modal 新規 (window.confirm 不可)。downgrade 押下にも金額なし確認を**必須**化。
- R3: path `/app/upgrade` 維持、label のみ「プラン変更」。
- R4: idempotency key は operation 単位 UUID (§5.4)。deterministic key 不可。
