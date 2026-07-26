# Stripe Test Clock 検証 運用 runbook(downgrade / 予約取消 回帰)

`scripts/stripe-test-clock-verify.ts` の使い方。目的 = deps bump 等の後に **決済経路(downgrade 予約 /
予約取消 の発効)が壊れていないかの回帰**を、OT の手作業 Test Clock 操作を減らして毎回同じ動作で回す。
背景 fact-finding = `docs/audit/2026-07-09-stripe-test-clock-reservation-verification.md`(手順・罠・発効経路)。
本 runbook はその **CC 部分(setup / advance / 観測 / 掃除)を script 化**した位置づけ。

## 責務分担(絶対)

- **CC(script)**: ① setup(clock 付き顧客 + DB link)② observe(前後の DB/Stripe dump)③ advance(時間送り)④ cleanup。
- **人力(OT)**: app UI で **upgrade Checkout → downgrade / 予約取消**。= 検証したい独自ロジック
  (`scheduleDowngrade` / `cancelScheduledDowngrade` / webhook release gate)を **本物の経路**で通す。
- script は予約を打つ/取り消す Stripe 呼出と Checkout 生成を **再実装しない**(迂回すると独自層が未検証の穴)。

## 前提(OT provisioning — 初回のみ)

1. **`STRIPE_TEST_CLOCK_SECRET_KEY`**(推奨・least-privilege): `billing_clock_write`(Test Clocks Write)
   権限付きの **test key**(`rk_test_`/`sk_test_`)を `.env.local` に置く。app の `STRIPE_SECRET_KEY`
   (Restricted Key)は通常この権限を持たない(実測 `StripePermissionError`)。app key に
   `billing_clock_write` を足す運用でも可(その場合 `STRIPE_TEST_CLOCK_SECRET_KEY` 未設定で
   `STRIPE_SECRET_KEY` に fallback)。
2. **固定ユーザーの `users.id`**(uuid): script の `--user-id`。**app-role(RLS)では CC が自力探索
   できない**設計ゆえ OT が値を渡す(= owner 露出防止の裏返し・健全)。固定アカウント =
   `komail9server+clerk_testclock@gmail.com`(Clerk / DB user 作成済)。
3. **stg test mode webhook** が `https://stg.recallmint.nekotest.net/api/webhooks/stripe` に登録済 +
   `STRIPE_WEBHOOK_SECRET` 一致(未登録だと advance しても DB は動かない・罠4)。
4. `STRIPE_PRICE_*`(4 price)+ `DATABASE_URL_APP`(app-role)が `.env.local` にある。

> DB は **app-role のみ**(`DATABASE_URL_APP` + `withTenantTx(固定 user.id)`)。owner/admin
> (`DATABASE_URL_ADMIN`)は使わない。全 DB 操作は「自分の行」限定で `users_select`/`_update`
> policy(`id = app_current_user_id()`)下を通る。SQL を owner で打つ必要は無い。

## 実行(subcommand・人力操作を挟むため分割)

```bash
RUN="node --env-file=.env.local --conditions=react-server --import tsx scripts/stripe-test-clock-verify.ts"
UID=<固定ユーザーの users.id>

# 1. 下ごしらえ(CC)。--interval は検証する課金サイクル
$RUN setup   --user-id=$UID --interval=month     # or --interval=year

# 2. 人力(OT): stg に固定アカウントでログイン →
#    app UI で <interval> プランに upgrade(Checkout=この clock 顧客の sub)→
#    app UI で downgrade もしくは 予約取消(= 検証本体)

# 3. advance 前観測(CC)
$RUN observe --user-id=$UID --label=before

# 4. 時間送り(CC): period_end+1d へ 1 回 advance → ready まで polling
$RUN advance --user-id=$UID --interval=month

# 5. advance 後観測(CC): 数秒待って webhook 反映後
$RUN observe --user-id=$UID --label=after

# 6. 掃除(CC): sub cancel → customer del → clock del → DB user 行 reset
$RUN cleanup --user-id=$UID
```

## 2 シナリオ

- **downgrade 発効**: step2 で下位プランへ変更(予約 schedule 作成)→ advance → after で
  `plan` が target へ / 予約 3 列 clear / `DB↔Stripe consistency: OK`。
- **予約取消**: step2 で downgrade 予約 → 予約取消(release)→ advance → after で
  **downgrade が発効しない**(plan は現状維持・予約 3 列は取消時点で clear 済)。
- month / year は **別 run**(別 clock/customer)。1 clock advance は配下全 sub を同時に動かすため
  混ぜない(罠2)。

## 観測列(users)

`plan, billing_interval, subscription_status, current_period_end, cancel_at, stripe_customer_id,
stripe_subscription_id, scheduled_downgrade_schedule_id, scheduled_target_price_id,
scheduled_change_effective_at`。`observe` は上記 + Stripe(sub/schedule)を dump し、現 Stripe sub の
active price を逆引きした (plan, interval) が DB と一致するか(= 決済経路の回帰観点)を info 表示。

## 安全 guard

L1 production 拒否 / L2 test key 必須 / L3 `DATABASE_URL_APP` の stg/test/dev/localhost token 検査
(`TESTCLOCK_FORCE=1` で bypass)/ L4 `--user-id` 必須・setup/advance は `--interval` 必須。cleanup は
cascade 非依存の明示順(sub cancel → customer del → clock del)。固定 user の reset は課金列のみで
`clerk_id`/`deleted_at` 不変ゆえ **再ログイン可**(手作業は初回作成のみ)。
