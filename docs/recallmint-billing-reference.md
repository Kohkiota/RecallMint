# RecallMint 課金リファレンス

> 課金まわりの全体像・実装済方針・既知事項を集約する参照用ドキュメント。 詳細経緯は `docs/superpowers/sessions/` および `docs/superpowers/specs/` に残し、 commit hash は各節に記載。 「現状の実装どおり」を反映 (= aspirational ではない、 履歴は §3)。 最終更新 2026-06-03。

---

## 1. 課金アーキテクチャ全体像

### 1.1 設計の芯 (2026-06-03 現在)
- **新規加入は Stripe Checkout、 paid 在籍のプラン変更は自前 `subscriptions.update` (in-place)**、 解約は Stripe Customer Portal、 の 3 経路。 旧設計 (in-place sprint 前) は Portal 一本だったが、 「2 本目 subscription 防止」 + 「期末ダウングレード予約 + 自動 release」 のため自前経路を追加した。
- 状態は `users` テーブルの複数カラムに集約 (§1.2)、 楽観更新はせず、 plan/status の最終正は **Stripe webhook 由来**。 例外: ダウングレード予約 3 列だけは自前 action (`changePlan` / `cancelDowngrade`) が直接書く (Stripe schedule 作成 / release と同期、 webhook で後追い冪等 clear)。
- webhook idempotency は `stripe_events` / `clerk_events` テーブル。 失敗は `notifyOps` + Discord で 200 swallow (再送ループ防止、 CLAUDE.md §Stripe-5)。 critical 削除フローの失敗だけは `deletion_failures` 監査も追加。

### 1.2 users カラム (課金 + 予約 + 削除)

```
plan                          'free' | 'standard' | 'pro' (default 'free'、 機能差の唯一の軸)
billingInterval               'month' | 'year' | NULL (plan と直交、 表示と Checkout のみで使用)
subscriptionStatus            'active' | 'past_due' | 'canceled' (Stripe 10 status を 3 値に正規化)
stripeCustomerId              UNIQUE (webhook 照合 key)
stripeSubscriptionId          UNIQUE (in-place 変更で追加、 1 user 1 active sub invariant)
currentPeriodEnd              課金期間終了 (解約後も履歴として残す、 .deleted では touched しない)
cancelAt                      解約予約日時 (NULL = 予約なし、 唯一の解約予約 signal)
scheduledDowngradeScheduleId  subscription_schedule.id (方針C ダウングレード予約、 §5.5 ブロック + release gate #1)
scheduledTargetPriceId        予約先 price (release gate #5)
scheduledChangeEffectiveAt    schedule phase[0].end_date (UI 表示専用、 切替発効日時)
deletedAt                     soft delete timestamp (Clerk アカウント削除フロー)
```

- **past_due の二重意味**: (a) `plan!=free` = 初回支払失敗の grace (アクセス保持)、 (b) `plan=free` = unpaid/incomplete 由来の downgrade 後。 UI は `(plan, status)` 組合せで区別が必要。
- **billingInterval transition window** (2026-05-17 以前): 旧課金 user は NULL、 次回 webhook で resync。 window 中は `paid && interval=NULL` が合法、 frontend は NULL を month 扱いで暫定表示する fallback 必須。
- **invariant**: `plan='free'` ⇒ `billingInterval=NULL`、 `plan IN(standard,pro)` ⇒ `billingInterval IN(month,year)`。 webhook の `resolvePlanFromSub` で担保。
- **scheduled 3 列の真実 source = DB 行**。 `sub.schedule != null` 単独はブロック条件にしない (Stripe 由来 schedule の混入を排除)。

### 1.3 価格マッピング
- 構成: **2 product (Standard / Pro) × 2 price (月 / 年) = 4 price** (idiomatic、 2026-06-02 OT 決定で 1×4 案不採用、 §3.2)。
- env: `STRIPE_PRICE_STANDARD_MONTHLY/YEARLY` + `STRIPE_PRICE_PRO_MONTHLY/YEARLY` の 4 本 (`lib/stripe/price-mapping.ts` が module load 時に双方向 map を構築、 欠落・重複は throw)。
  - `resolveFromPriceId(priceId)` → `{plan, interval}` | null (webhook 用、 不明は null fallback + notifyOps)
  - `priceIdFor(plan, interval)` → price ID (Checkout / changePlan 用、 exhaustive switch)
- 価格: Std 月 ¥680 / 年 ¥6,800 / Pro 月 ¥1,280 / 年 ¥12,800 (年額 約 17% OFF)。

### 1.4 プラン変更フロー (実装済 2026-06-03)

#### (i) free → paid 新規加入
- 経路: `/app/upgrade` → `<form action={createCheckoutSession}>` (`actions.ts:26-66`)
- 実装: `stripe.checkout.sessions.create({ mode:'subscription', customer: stripeCustomerId ?? undefined, customer_email: 既存なし時のみ, line_items:[{ price: priceIdFor(plan,interval), quantity:1 }], ... })`
- 既存 `stripeCustomerId` があれば再利用 (二重 customer 防止)、 無ければ email から Stripe が作る
- success_url = `?billing=new`、 cancel_url = `/app/upgrade`
- 結果は `checkout.session.completed` + `customer.subscription.created/.updated` webhook で DB 同期 (.completed 内でも sub を retrieve して plan/sub_id を即時 set = race defense)

#### (ii) paid 在籍 → 上位プラン (in-place upgrade)
- 経路: `/app/upgrade` → 確認 modal → `changePlan` (`actions.ts:72-145`) → `applyUpgrade(subId, itemId, targetPriceId, idempotencyKey)`
- 実装: `stripe.subscriptions.update(subId, { items:[{id:itemId, price:targetPriceId}], proration_behavior:'always_invoice', payment_behavior:'pending_if_incomplete' })`
- 即時差額請求 → 支払成功時のみ新 price 適用、 失敗時は `pending_update` のまま旧 price 維持 (= 支払失敗ゲート、 §3.1)
- 結果は `.updated` webhook で plan/billingInterval 同期。 失敗時は `invoice.payment_failed` で notifyOps のみ、 DB plan は触らず旧プラン維持
- 確認 modal 文言: 「今すぐ差額が請求され、 プランが変更されます」

#### (iii) paid 在籍 → 下位プラン (期末ダウングレード予約)
- 経路: `/app/upgrade` → 確認 modal → `changePlan` → `scheduleDowngrade(sub, targetPriceId, idempotencyKey, opts)`
- 実装: `stripe.subscriptionSchedules.create({ from_subscription: sub.id })` → `update(scheduleId, { end_behavior:'release', phases:[{ start_date, end_date, items:[現 price] }, { items:[target price], proration_behavior:'none' }] })`
- アプリが直接 DB の scheduled 3 列を set (ブロック即時有効化、 `actions.ts:138-142`)
- 期末到来 → Stripe が phase[1] へ移行 (item price=target) → `.updated` 受信 → release gate #1+#5 充足 → `releaseCompletedDowngrade` で能動 release → DB 3 列 clear (§1.6 release gate)
- phase[1] は **open-ended** (end_date 未指定)。 `end_behavior='release'` でも phase[1] 開放のため Stripe 側自然 release は発火せず、 app の能動 release が必要 (= 方針C の核心)
- 確認 modal 文言: 「現在の請求期間終了後に {plan} へ切り替わります。 それまでは現在のプランを利用できます」
- ブロック条件 (`actions.ts:106-112`): `pending.hasPendingUpdate || user.scheduledDowngradeScheduleId != null || pending.cancelScheduled` で `CHANGE_BLOCKED` throw

#### (iv) ダウングレード予約取消
- 経路: 予約 banner の「取消」 ボタン → `cancelDowngrade` (`actions.ts:149-179`) → `cancelScheduledDowngrade(scheduleId, idempotencyKey)` → `releaseScheduleIdempotent`
- 実装: `stripe.subscriptionSchedules.release(scheduleId)` (`already_released` / `resource_missing` は冪等成功扱い、 `lib/stripe/subscription.ts:235-255`)
- アプリが直接 DB の scheduled 3 列を null clear (`actions.ts:172-177`)
- `subscription_schedule.released` webhook も来るが、 既に clear 済 = 0 行 match 冪等 no-op

#### (v) Customer Portal (= 解約 + 支払い方法 + 請求履歴のみ)
- 経路: settings ボタン → `createBillingPortalSession` (`app/(app)/app/settings/actions.ts:7-24`) → `stripe.billingPortal.sessions.create({ customer, return_url })`
- **Portal の「顧客がプランを切り替えられるようにする」 は OFF** (Dashboard 設定、 2026-06-03 確認済) → Portal 経由のダウングレード予約 (subscription_schedule.created) は発生しない invariant
- 解約は Portal default = 期末解約予約 (`cancel_at` セット、 Stripe Dashboard 側 Portal 設定で決定)
- `portal_configuration` は渡さない (Dashboard default 設定)

### 1.5 解約フロー (2 段階、 stg 実機検証済 2026-06-03)

| 段階 | webhook | DB 影響 |
|---|---|---|
| (1) Portal で解約 click 直後 | `customer.subscription.updated` (`cancel_at` セット、 status=active のまま) | `cancelAt` / `currentPeriodEnd` に期末日 set、 `plan` / `billing_interval` / `subscriptionStatus='active'` / `stripe_subscription_id` は据え置き (= free 化しない、 中間状態) |
| (2) 期末到来 → Stripe 自動 cancel | `customer.subscription.deleted` | `plan='free'` / `billing_interval=null` / `subscription_status='canceled'` / `cancelAt=null` / `stripe_subscription_id=null` / scheduled 3 列=null、 `currentPeriodEnd` は履歴として残す |
| (3) (期末前に renew) | `customer.subscription.updated` (`cancel_at=null`) | `cancelAt` だけ null に上書き、 他不変 |

#### Clerk アカウント削除フロー (= 強制 cancel)
- `user.deleted` webhook 受信 (`app/api/webhooks/clerk/route.ts:132-235`) → `stripe.subscriptions.list({customer, status:'all'})` で全 sub 走査
- `CANCEL_TARGETS = { 'active', 'trialing', 'past_due' }` のみ `stripe.subscriptions.cancel(subId)` で**即時 cancel** (期末予約ではない)
- DB transaction (最大 3 retry、 backoff 500/1000/2000ms): `users.deleted_at = now()` (soft delete) + `exams` / `study_days` / `contact_messages` を物理削除 (`exams` の cascade で `cards` / `source_documents` / `reviews` も連鎖物理削除)
- Stripe customer 自体は削除しない (`stripe.customers.del` 非呼出)
- 失敗は `deletion_failures` テーブル + `notifyOps`

### 1.6 webhook 処理 (`app/api/webhooks/stripe/route.ts`)

購読 / 処理する Stripe event は **6 種**。 default は no-op + 200。

| # | event | DB 影響 | 役割 |
|---|---|---|---|
| 1 | `checkout.session.completed` | `stripeCustomerId` 紐付け + sub retrieve して plan/sub_id 同期 (race defense) | 新規加入の確証 |
| 2 | `customer.subscription.created` | plan/sub_id 同期 (event 1 と冪等な後追い) | sub 新規 |
| 3 | `customer.subscription.updated` | (a) plan-sync (6 列上書き、 scheduled 3 列は触らず) (b) release gate 評価 (予約あり時) → 委譲 release 成功で 3 列 clear (c) **方向2**: `sub.schedule==null` + DB に予約残存なら 3 列 clear | プラン変更 / 解約予約 / phase 進行 / 方向2 救済の本丸 |
| 4 | `customer.subscription.deleted` | plan='free' reset + cancelAt/sub_id=null + scheduled 3 列も null clear、 currentPeriodEnd は履歴保持 | 解約完了 / sub 消滅の最終 fallback |
| 5 | `invoice.payment_failed` | DB 触らず、 `notifyOps` のみ | 観測 (plan/status は `.updated` 最終正のため据え置き) |
| 6 | `subscription_schedule.released` | `where(scheduledDowngradeScheduleId = schedule.id)` で 3 列 null (0 行 match no-op) | 方向1 (best-effort 救済路、 §1.8) |

#### release gate (方針C、 `route.ts:374-426` `evaluateReleaseGate`)
- `.updated` で plan-sync 後、 `dbScheduleId != null` のときのみ評価
- **#1 schedule identity**: `sub.schedule` ID === DB `scheduledDowngradeScheduleId`
- **#5 target 反映**: `items[0].price.id` === DB `scheduledTargetPriceId` (= phase[1] への切替が実際に効いた決定的シグナル)
- 両充足 → `releaseCompletedDowngrade(scheduleId, 'autorelease:'+scheduleId)` 委譲 (status gate は同関数が判定: active/not_started のみ release、 終端は `already_terminal` no-op、 `lib/stripe/subscription.ts:269-`)
- 戻り値 `'released'` / `'already_terminal'` → 3 列 clear、 `'skipped'` (not_started 等) → 維持
- `sub.schedule == null` → **方向2: 3 列を冪等 clear して return** (2026-06-03 commit `9b8dd0d`、 Portal cancel 由来の `.released` 取りこぼし救済、 § 3.1)
- 別 non-null id → `notifyOps('stripe release gate schedule mismatch')` + return

#### normalizeSubStatus / resolvePlanFromSub
- `normalizeSubStatus`: Stripe 10 status → 内部 3 値。 `active/trialing → active`、 `past_due/unpaid/incomplete → past_due`、 `canceled/incomplete_expired/paused → canceled`
- `resolvePlanFromSub(status, priceId)`: canceled/unpaid/incomplete → `{plan:'free', interval:null}`、 active/trialing/past_due → priceId から resolve、 不明 → notifyOps + free fallback (throw しない、 webhook 再送ループ防止)
- past_due は **plan 維持** (grace、 §1.2 二重意味の (a))

#### extractSubFields
- API basil 以降 `items.data[0].current_period_end` (sub root ではない) に対応
- `cancel_at` (Unix 秒) → `Date` 化

### 1.7 プラン制限
- `lib/auth/plan-limits.ts`: `PLAN_LIMITS = { free:{ocrPagesPerMonth:30}, standard:{300}, pro:{無制限} }`。 月次は `upload_records` から SUM。
- `lib/plan-catalog.ts`: `rankPlan(plan, interval)` → 0=Free / 1=Std 月 / 2=Std 年 / 3=Pro 月 / 4=Pro 年。 `isUpgrade`、 年額 約 17% OFF を catalog で表現。

### 1.8 既知の軽微 / 未解決事項

#### 方向1 (`.released`) の購読補強
- `subscription_schedule.released` event は Stripe Dashboard endpoint の `enabled_events` に含まれている必要がある
- stg 実機で Portal cancel 経由の即時 release では本 event が配信されない事象を観測 (2026-06-03)、 方向2 で確実な救済路を確保したため日常的には問題なし
- OT が prod endpoint でも本 event を購読対象に含めること (実体は best-effort 補強、 方向2 の存在で日常運用は安全)

#### ChangePlan ガード × Portal 解約の race
- 自前 UI 経路の `changePlan` は §5.5 ガード (`actions.ts:106-112`、 cancelScheduled 含む) で「解約予約 → ダウングレード予約」 を弾く
- 逆方向 (ダウングレード予約成立後の Portal 解約) は **アプリ側で止められない** (Portal は外部 UI で自前ガードが効かない)
- webhook 順序によって瞬間的に DB「両方 set」 状態 (`cancelAt` + scheduled 3 列) が起きうる → 後続 webhook (`.updated` 方向2 / `.deleted`) で冪等に解消
- UI 側は cancelAt 優先表示 (`app/(app)/app/settings/page.tsx`) で defensive 対応済
- 影響: 瞬間的な DB 状態のみ、 ユーザ可視の破綻なし → 本 sprint では塞がない (実装するなら Portal を予約中ブロックする等だが UX 制約として強すぎる可能性)

#### past_due の二重意味
- §1.2 (a)/(b) 区別。 UI は `(plan, status)` 組合せで判定。 4 値化 (unpaid 別立て) は v1.x 検討

#### billingInterval transition window
- 2026-05-17 以前の旧課金 user は NULL → 次回 webhook で resync。 frontend NULL → month fallback で吸収

#### Portal 設定はコードに現れない
- 解約 mode (即時 / 期末) / cancel 受理 / プラン切替 ON-OFF 等は Stripe Dashboard 設定で git 管理外
- 現状: cancel = 期末 (default)、 プラン切替 = OFF (確認済 2026-06-03)

#### スコープ外: Smoke 5-C-2 未実施
- ダウングレード予約 + Portal 解約 で DB 両方 set 成立 → 整合収束の実機確認は 5-C-2 未実施
- 詳細: `docs/superpowers/sessions/2026-06-02-in-place-plan-change-behavior-smoke.md` の §5-C-2

---

## 2. UI 構造 (2026-06-03 実装後の現状)

### 2.1 `/app/upgrade` (プラン変更 page)
- server (`page.tsx`): user の plan/interval/予約状態を取得。 paid なら `resolveActiveSubscription` で sub を retrieve し `getPendingState` で pending/cancel flag、 予約 3 列の値を整形して props 渡し。 free は sub 不在で Stripe 呼出 skip
- client (`upgrade-plans.tsx`): 月↔年 toggle + Standard / Pro の **2 カード**。 Free カードは無い
- カード CTA は user の経路で 2 種:
  - free → `<form action={createCheckoutSession}>` (Checkout 直行、 確認 modal なし、 ラベル「Standard に加入」 / 「Pro に加入」)
  - paid → `PaidChangeForm` (確認 modal → `changePlan` action、 ラベル「Standard 月額 に変更」 等)
- 確認 modal 文言:
  - upgrade: 「今すぐ差額が請求され、 プランが変更されます」
  - downgrade: 「現在の請求期間終了後に {plan} へ切り替わります」
- `operationId` (UUID) は confirm 時に生成、 form hidden input に注入 (idempotency key 単位、 per-mount UUID は別 intent 再利用の事故を防ぐため不採用)
- 月↔年 切替の disable 判定: rank inline copy。 `rank(target) == rank(current)` で「現在のプラン」 disable、 他は変更 active。 paid → Pro 年額 でも入口 redirect しない (entry 統一)

### 2.2 `/app/upgrade` の banner / notice 出し分け
- **ダウングレード予約あり** (`hasScheduledDowngrade = user.scheduledDowngradeScheduleId != null`): page 上部に `DowngradeReservationBanner` (短縮版: 「Standard 月額 へ変更予約中（2026/07/01）— 取消」)、 取消ボタンは blocked でも有効 (唯一の操作経路)
- **blocked notice** (`hasPendingUpdate || cancelScheduled || hasScheduledDowngrade`) で全変更 CTA disable、 notice は状態別に出し分け:

| 状態 (優先順) | 表示 notice |
|---|---|
| `hasPendingUpdate=true` | 「お支払いの処理中です。 完了までお待ちください。」 |
| `cancelScheduled=true` | 「解約予約中です。 プラン変更するには『お支払い・解約を管理』 から予約を取り消してください。」 |
| `hasScheduledDowngrade` のみ true | **notice なし** (DowngradeReservationBanner が代替、 冗長回避) |

### 2.3 `/app/settings` (entry 統一済)
- 全 plan で「プラン変更」 link (→ `/app/upgrade`)
- paid のみ追加で「お支払い・解約を管理」 (Portal) を表示
- free は「プラン変更」 のみ (Portal は Stripe customer 不在で `createBillingPortalSession` が throw する経路のため非表示)
- 予約状態の表示 (優先順、 §1.8 race への defensive 対応):

| 状態 (優先順) | 表示 |
|---|---|
| `cancelAt != null` | 「解約予約中、 YYYY/MM/DD 終了」 (最優先) |
| `scheduledDowngradeScheduleId != null` | 「YYYY/MM/DD に Standard 月額 へ変更予約中」 (cancelAt 不在のときのみ) |
| `subscriptionStatus` (上記いずれも無し) | 「ステータス: active」 等 |

### 2.4 `/app` (dashboard) 下部 CTA
- 全 plan で「プラン変更」 link (→ `/app/upgrade`)、 Pro 年額含む全 plan で entry 統一済 (§7.4)

### 2.5 success banner (`?billing=...`)
- Checkout 完了 → success_url 経由で `/app?billing=new`
- in-place changePlan 成功 → `redirect('/app?billing=upgrade|downgrade')`
- ダウングレード予約取消 → `/app/upgrade` に戻る (banner なし、 ブロックが解除されただけ)
- 文言:
  - `?billing=new`: 「決済を受け付けました。 反映まで少し時間がかかる場合があります。」
  - `?billing=upgrade`: 「支払い確認後にプランが反映されます。」
  - `?billing=downgrade`: 「現在の請求期間終了後にプランが変更されます。」

---

## 3. 主要設計判断 (履歴)

### 3.1 採用方針 (2026-06-02 〜 2026-06-03、 in-place plan change sprint で実装済)

- **既存契約者の有料プラン変更は Checkout でなく `subscriptions.update`** (in-place、 2 本目を作らない)。 新規 (free) のみ Checkout 維持
- **1 user 1 active subscription invariant**、 `stripeSubscriptionId` 列を追加して webhook で populate (`AmbiguousSubscriptionError` で多重契約を弾く)
- **ダウングレードは期末適用 + proration なし** (subscription schedule で実装)、 即時クレジット表示は作らない (= 旧プラン期末まで維持 → phase[1] で目的 price に切替)
- **方針C (auto-release)**: schedule end_behavior='release' に頼らず (phase[1] open-ended のため自然 release しない設計)、 webhook gate (#1+#5) で能動 release を発火、 通常 subscription に戻す
- **ブロック条件は DB scheduled 列を真実 source** にする (`sub.schedule != null` 単独はブロック条件にしない、 Stripe 由来 schedule の混入排除)
- **同時変更ブロック**: `pending_update` / `cancelScheduled` / `scheduledDowngrade` のいずれかで全 CTA disable + 取消経路のみ許可
- **状態整合フォールバック**: idempotency key 必須、 webhook 由来を plan/status の最終正、 success redirect 到達だけで DB を確定しない、 二重 sub 検出は自動選択せずエラー
- **upgrade の支払い失敗ゲート**: `always_invoice + payment_behavior='pending_if_incomplete'` → 失敗で旧プラン維持 (`pending_update`)
- **release path の二重化** (2026-06-03、 commit `9b8dd0d`): 方向1 `subscription_schedule.released` (best-effort) + 方向2 `.updated` 内 `sub.schedule==null` 検知 clear (本命の救済路)
- **UI entry 統一**: 全 plan で「プラン変更」、 Pro 年額の除外は撤廃、 free の旧「プランを選択」 文言も廃止
- **Free の定義** (RecallMint 設計): Stripe subscription を持たない DB 上の無料状態。 Free への移行 = Portal 解約。 プラン変更 UI では扱わない (Free カードを足さない)
- **操作後の着地と文言**: 全操作 `/app` 着地、 redirect 到達だけで DB の plan/status を確定しない (webhook が最終正、 §2.5)

### 3.2 不採用案

- **1 product × 4 price**: 「Portal の期末ダウングレードは同一 product 間でしか効かない」 という指摘あったが、 本 MVP は Portal でプラン変更しない (自前 UI + schedule API) + schedule API には同 product 制約がないため、 1×4 の利点なし → **2×2 維持**
- **ダウングレード即時 + クレジット表示**: クレジット表示の捨て実装 + mid-cycle 機能剥奪の違和感 + 最終形 (期末適用) との不一致のため不採用 → **B (期末適用 + proration なし) 採用**
- **Stripe Portal でプラン変更**: Portal 経由の changePlan は subscription_schedule.created 等で別経路に流れ、 自前 gate がカバーできない。 Dashboard 側で「プラン切替」 を OFF にして閉鎖

### 3.3 関連 commit / doc

- 主要実装 sprint: T1-T12 + T6-T8 + 234175a + … (詳細は `docs/superpowers/plans/2026-06-02-in-place-plan-change.md` / `docs/superpowers/specs/2026-06-02-in-place-plan-change-design.md`)
- 方向2 (release 同期穴 fix): commit `9b8dd0d`
- UI 統一 (settings CTA / notice 出し分け / settings 予約表示): commit `a0eaa8a` / `e6c75ea` / `51cc977`
- smoke 実機進捗 (4-a / 5-B / 5-C step1-8 / 5-C step9-11 / U1-U5 PASS、 5-C-2 未実施): `docs/superpowers/sessions/2026-06-02-in-place-plan-change-behavior-smoke.md`
- 解約まわり挙動調査: `docs/superpowers/sessions/2026-06-02-billing-cancel-change-schema-investigation.md` (commit `6858be1`)
