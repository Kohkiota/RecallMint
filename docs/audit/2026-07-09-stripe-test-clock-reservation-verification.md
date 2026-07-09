# Stripe Test Clock による予約発効(downgrade / cancel)検証 — 手順裏取り + 現状調査

- 日付: 2026-07-09 / branch `develop` / **read-only 調査**(コマンド実行なし・push なし)
- 目的: F1(Subscription)で入れた downgrade 予約 / 解約予約が **期日到来で実発効するか**を Stripe Test Clock で確認するための、OT 実機手順の正確化 + 現コードの発効経路 + 罠の固定。
- 方法: Stripe CLI(`/usr/bin/stripe` 実在)`--help` + Context7(Stripe CLI / Stripe docs)で構文裏取り。発効経路は現コード first-hand(Explore)。
- **CC は実行しない**。本 doc を見て OT が実機で撃つ。

---

## Step 1: Test Clock コマンド構文(裏取り・引用付き)

`frozen_time` は **Unix epoch 秒(integer)**(例 `1577836800` = 2020-01-01)。CLI は test API key(`sk_test_…` / `rk_test_…`)を `--api-key` or `STRIPE_API_KEY` で渡す(CLI `[Agent guidance]` 明記)。

### 1-1. Clock 作成

```
stripe test_helpers test_clocks create --frozen-time <unix> [--name <string>]
```

> CLI `create --help`: `--frozen-time <unix-time> The initial frozen time for this test clock` / `--name <string>`。作成直後の status = `ready`。

### 1-2. Clock 紐付き customer 作成(★create 時のみ・後付け不可)

```
stripe customers create --test-clock <clock_id> [--email <…> ...]
```

> CLI `customers create` params: `--test-clock <string> ID of the test clock to attach to the customer`。**customer は clock に紐付けて作る一択。既存 customer を後から clock に付けることはできない**(罠1)。

### 1-3. Clock を進める

```
stripe test_helpers test_clocks advance <test_clock> --frozen-time <unix> [-c]
```

> CLI `advance --help`: `stripe test_helpers test_clocks advance <test_clock> ... --frozen-time <unix-time> The time to advance the test clock`。`-c/--confirm` で警告 prompt skip。
> **制約(罠3・Stripe docs)**: 「frozen_time Must be **after** the test clock's current frozen time. **Cannot be more than two intervals in the future from the shortest subscription** in this test clock. If there are no subscriptions … cannot be more than two years in the future.」→ **1 回の advance で「最短 sub の 2 課金間隔」以上は飛べない**。period 末発効を見るなら「現在 → period_end 直後(1 間隔強)」へ 1 回で advance すれば足りる。

### 1-4. Clock 状態確認(advancing → ready の polling)

```
stripe test_helpers test_clocks retrieve <test_clock>
```

> `status` enum = **`advancing` | `ready` | `internal_failure`**(Stripe docs)。advance は非同期: 直後 `advancing` → 完了で `ready`。**`ready` になるまで retrieve を polling**してから DB を確認する(webhook 到達も advance 完了後)。`internal_failure` は失敗。
> advance は「**triggering webhooks and state changes**」(docs)= clock 上の全 sub の billing/renewal/schedule 発効 webhook が発火。

### 1-5. 後始末

```
stripe test_helpers test_clocks delete <test_clock>
```

> clock は `deletes_after`(作成 + 約 7 日、example: created→deletes_after ≈ 604800s)で自動削除もされる。

---

## Step 2: 現状調査(発効経路 = 現コード)

### 2-1. 予約 3 列 + 投影列(`lib/db/schema.ts:74-91`)

| DB 列(snake_case)                                            | 型          | 意味                             |
| ------------------------------------------------------------ | ----------- | -------------------------------- |
| `clerk_id` / `stripe_customer_id` / `stripe_subscription_id` | text unique | user↔Stripe 紐付け               |
| `plan`                                                       | text        | 'free'\|'standard'\|'pro'        |
| `billing_interval`                                           | text        | 'month'\|'year'\|null            |
| `subscription_status`                                        | text        | 'active'\|'past_due'\|'canceled' |
| `current_period_end` / `cancel_at`                           | timestamptz | 期末 / 解約予定時刻              |
| **`scheduled_downgrade_schedule_id`**                        | text        | 予約 = downgrade schedule id     |
| **`scheduled_target_price_id`**                              | text        | 予約 = 移行先 price              |
| **`scheduled_change_effective_at`**                          | timestamptz | 予約発効予定時刻                 |

### 2-2. downgrade 予約の仕組み(`lib/stripe/subscription.ts:132-181`)

Stripe **`subscription_schedules`**: `create({ from_subscription })` → `update` で `end_behavior: 'release'` + phase0(現 price を `end_date` まで)+ phase1(target price・`proration_behavior:'none'`)。予約 3 列は app が `saveReservation`(`app/(app)/app/upgrade/actions.ts:176-189`・`effectiveAt = phase0.end_date`)で保存。**予約は app の upgrade 画面(下位プランへ変更)経由で作られる**のが正規経路。

### 2-3. 発効時の webhook 経路(`lib/stripe/handle-stripe-event.ts`)

| event                                      | 発効内容                                                                          | 書く列                                                                                                                                   | 予約 3 列 clear                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `customer.subscription.updated`(:82-122)   | schedule release 後、plan 6 列を target price に投影 + **release gate**(:195-253) | plan 6 列投影                                                                                                                            | gate 通過 + `releaseCompletedDowngrade`='released'/'already_terminal' で **YES**(:244-248 `clearReservation`) |
| `subscription_schedule.released`(:171-182) | phase0 `end_date` 到達で Stripe 自動 release(`end_behavior:'release'`)            | 予約 3 列のみ clear                                                                                                                      | **YES**(scheduleId 一致で直接)                                                                                |
| `customer.subscription.deleted`(:124-156)  | 解約発効                                                                          | `applyDeletedReset`: **plan→'free' / status→'canceled' / interval→null / cancel_at→null / stripe_subscription_id→null / 予約 3 列→null** | **YES**(全リセット)                                                                                           |

**release gate**(`domain/subscription-aggregate.ts:124-135` `evaluateRelease`・`customer.subscription.updated` からのみ発火):`sub.schedule` が null→`clear_direct` / DB `scheduled_downgrade_schedule_id` と不一致→`mismatch`(notifyOps・no-op)/ price 未同期→`skip` / 両一致→`delegate`→`releaseCompletedDowngrade`。**dbScheduleId が null なら early return**(:205)= 予約 3 列を app が設定していない場合 gate は動かないが、**plan 投影自体は `customer.subscription.updated` が行うので downgrade は反映される**(gate は予約 bookkeeping の後始末)。

### 2-4. webhook endpoint(`app/api/webhooks/stripe/route.ts`)

`POST /api/webhooks/stripe`。`constructEvent`(署名検証・`STRIPE_WEBHOOK_SECRET`)+ `stripe_events` 冪等(onConflictDoNothing・重複は 200)+ handler エラーも常時 200。
→ **Test Clock advance の webhook を stg が受けるには、Stripe test mode の webhook endpoint が `https://stg.recallmint.nekotest.net/api/webhooks/stripe` を向いて登録済 + stg の `STRIPE_WEBHOOK_SECRET` が一致している必要**(罠4・OT ドメイン: webhook 登録は OT 手動)。ローカル代替は `stripe listen --forward-to <url>`。

### 2-5. 既存 test account の clock 紐付き(調査結論)

- clock 紐付きは **customer 作成時のみ**(Step 1-2)。既存 test account(komail9server+clerk_test1/2)の customer は通常 Checkout 由来 = **clock 非紐付け** → advance 不可(罠1)。
- OT が個別確認する場合: `stripe customers retrieve <cus_id>` → `test_clock` field が null なら非紐付け。
- **→ 検証には新規に clock 紐付き customer を作る必要**。その customer を app の user に効かせるには `users.stripe_customer_id` をその customer に向ける必要(2-3 の webhook は customer/clerkId で user を引く)。

---

## Step 3: OT 実機推奨手順(罠込み・DB 確認 SQL 付き)

### 前提チェック(撃つ前に)

- [ ] 罠4: Stripe **test mode** の webhook endpoint が stg `/api/webhooks/stripe` を向いて登録済・`STRIPE_WEBHOOK_SECRET` 一致(未登録なら advance しても stg DB は動かない)。Vercel stg の Function log で webhook 受信を観測。
- [ ] test API key(`sk_test_`/`rk_test_`)を `STRIPE_API_KEY` に設定。
- [ ] **downgrade と cancel は別 customer / 別 clock に分ける**(罠2: 1 clock を advance すると同 customer の全 sub が同時に動く)。

### 罠まとめ

1. **clock 紐付き customer は作成時のみ**(既存流用不可)。
2. **1 clock advance = その clock の全 sub が同時発効** → シナリオ A/B は別 clock。
3. **advance は最短 sub の 2 課金間隔まで**(period_end 直後へ 1 回で advance)。`ready` まで polling。
4. **stg webhook endpoint 登録 + secret 一致**が無いと DB に反映されない。
5. clock customer を app user に効かせるには `users.stripe_customer_id` 更新が要る(投げ捨て test user 推奨)。

### 予約の作り方(2 択・OT 判断)

- **(a) app UI 経由(full-fidelity・推奨)**: **app Checkout は既存 customer を再利用する**(`upgrade/actions.ts:67` `customer: user.stripeCustomerId ?? undefined`)。よって **① clock 紐付き customer を CLI 作成 → ② `users.stripe_customer_id` をその customer に SQL で更新(投げ捨て test Clerk user)→ ③ その user が app で Checkout 加入 = clock customer の sub になる → ④ app upgrade 画面で下位プランへ変更 = `scheduled_*` 設定 + schedule 作成**。→ **release gate + scheduled\_\* clear + 投影まで完全に検証可能**(この経路が feasible と確認済)。test PM は Checkout が処理。
- **(b) Stripe API 経由(projection のみ)**: CLI で subscription*schedule / cancel_at を直接設定 → \*\*plan 投影の発効は検証できるが、app の `scheduled*_`3 列 clear + release gate delegate は動かない**(dbScheduleId null ゆえ early return)。gate まで見たいなら`scheduled\__` を SQL で app 相当に手挿入。

### シナリオ A: downgrade 予約発効(別 clock A)

```
# 1. clock 作成(現在時刻付近の unix を frozen_time に)
stripe test_helpers test_clocks create --frozen-time <now_unix> --name "F1-downgrade"
# 2. clock 紐付き customer + test PM + subscription(standard month 等・上位)
stripe customers create --test-clock <clockA_id> --email dg@test --payment_method pm_card_visa \
  -d "invoice_settings[default_payment_method]=pm_card_visa"
stripe subscriptions create --customer <cusA_id> -d "items[0][price]=<price_standard_month>"
# 3. 予約設定: (a) app UI で下位へ変更  or  (b) API で schedule
#    → scheduled_downgrade_schedule_id / target_price / effective_at が入る(a の場合)
# 4. period_end 直後へ advance(current_period_end + 1 日 程度の unix)
stripe test_helpers test_clocks advance <clockA_id> --frozen-time <period_end_unix + 86400> -c
# 5. ready まで polling
stripe test_helpers test_clocks retrieve <clockA_id>   # status:ready を確認
```

**期待 DB(該当 user 行)**:

```sql
SELECT plan, billing_interval, subscription_status,
       scheduled_downgrade_schedule_id, scheduled_target_price_id, scheduled_change_effective_at
FROM users WHERE stripe_customer_id = '<cusA_id>';
-- 期待: plan = 下位プラン / billing_interval = 予約通り / subscription_status='active'
--       scheduled_* 3 列 = すべて NULL(発効で clear)
```

### シナリオ B: 解約予約発効(別 clock B)

```
stripe test_helpers test_clocks create --frozen-time <now_unix> --name "F1-cancel"
stripe customers create --test-clock <clockB_id> --email cancel@test --payment_method pm_card_visa \
  -d "invoice_settings[default_payment_method]=pm_card_visa"
stripe subscriptions create --customer <cusB_id> -d "items[0][price]=<price_standard_month>"
# 解約予約(期末解約): app の解約 or
stripe subscriptions update <subB_id> -d "cancel_at_period_end=true"
# period_end 直後へ advance → customer.subscription.deleted 発火
stripe test_helpers test_clocks advance <clockB_id> --frozen-time <period_end_unix + 86400> -c
stripe test_helpers test_clocks retrieve <clockB_id>   # ready
```

**期待 DB**:

```sql
SELECT plan, subscription_status, billing_interval, cancel_at, stripe_subscription_id,
       scheduled_downgrade_schedule_id, scheduled_target_price_id, scheduled_change_effective_at
FROM users WHERE stripe_customer_id = '<cusB_id>';
-- 期待(applyDeletedReset): plan='free' / subscription_status='canceled' / billing_interval=NULL
--   cancel_at=NULL / stripe_subscription_id=NULL / scheduled_* 3 列=NULL
```

### 観測ポイント

- **webhook 受信**: Vercel stg Function log(`/api/webhooks/stripe`)で `customer.subscription.updated` / `subscription_schedule.released`(A)/ `customer.subscription.deleted`(B)の受信 + 200。
- **冪等**: 同 event.id 再送は `stripe_events` で 200 duplicate(DB 二重更新なし)。
- **release gate mismatch**: A で `sub.schedule` と DB `scheduled_downgrade_schedule_id` 不一致なら notifyOps(no-op)= 予約が app 経由でない場合に起こりうる(2-3 早期 return)。

---

## 未確定 / OT 判断ポイント

1. **予約の作り方 (a) app UI か (b) Stripe API か**(§Step 3)。→ **確認済: app Checkout は既存 `users.stripe_customer_id` を session の `customer` に渡す**(`upgrade/actions.ts:67`)ので **(a) full-fidelity 経路が feasible**(clock customer を SQL で user に紐付け → app で加入 = clock 上の sub)。(a) 推奨。(b) は plan 投影のみ。
2. **stg webhook endpoint(test mode)登録状態**(罠4)= OT 領域・未確認。
3. **price id**(standard_month 等)= stg/test の実 price を OT が指定。
4. subscription 作成の test PM(`pm_card_visa`)添付形は Stripe test の標準だが、trial / collection_method 等の分岐は OT の Stripe 設定次第。

## 参照

- Stripe CLI: `stripe test_helpers test_clocks {create,advance,retrieve,delete} --help` / `stripe customers create --help`(`--test-clock`)
- Stripe docs(Context7 `/websites/stripe`): test_clocks advance の frozen_time 制約(2 intervals)+ status enum(advancing/ready/internal_failure)+ 「triggering webhooks」
- 発効経路: `lib/stripe/handle-stripe-event.ts`(:82-188 / gate :195-253)/ `lib/stripe/domain/subscription-aggregate.ts:124-135`(evaluateRelease)/ `lib/stripe/subscription.ts:132-181`(scheduleDowngrade)/ `app/(app)/app/upgrade/actions.ts:176-189`(saveReservation)/ `app/api/webhooks/stripe/route.ts` / `lib/db/schema.ts:74-91`
