# プラン変更 in-place 化 — behavior-only smoke 手順 (OT 実行)

- **日付**: 2026-06-02
- **目的**: T3/T4/T5 (決済 touch) の `[reviewed]` amend 前に、コードが Stripe に送る**正確な params** を OT が test mode で再現し、Stripe 実挙動を確認する。
- **対象 commit**: T3 `ab1a7d4` / T4 `f1b99ec` / T5 `e452db4` (いずれも tag 無し)。
- **params の出典**: `lib/stripe/subscription.ts` (T3 実装)。

> 注: これは UI 前の behavior-only smoke。我々の action 自体は UI(T6/7) 未実装のため、ここでは action が組み立てる API call を OT が Stripe CLI/dashboard で手動再現する。挙動が想定どおりなら amend → UI 実装へ。

## price ID (env、新 product)
- Standard 月 `price_1TdqksJX13jw2LsMg1JPQYoe`
- Standard 年 `price_1TdqoFJX13jw2LsMmSeJA643`
- Pro 月 `price_1Tdqp4JX13jw2LsMhP2LzJXb`
- Pro 年 `price_1TdqqIJX13jw2LsMvz4bMX1A`

## 0. setup — test subscription を作る (+ webhook sub id 同期の確認)
1. stg/test の app で Checkout (既存 `createCheckoutSession`) から **Standard 月**に加入 (test card `4242 4242 4242 4242`)。**test clock 配下の customer** で作っておくと Smoke 2 の期末前進が可能 (Stripe Dashboard で test clock を作成 → その customer で加入、または `stripe` CLI で test clock customer を用意)。
2. **確認 (T4)**: `checkout.session.completed` / `customer.subscription.created` 受信後、DB `users.stripe_subscription_id` に `sub_...` が入ること。`users.plan='standard'`, `billing_interval='month'`。
3. `sub_XXX` (subscription id) と `si_XXX` (item id = `items.data[0].id`) を控える (`stripe subscriptions retrieve sub_XXX`)。

## 1. applyUpgrade — 即時アップグレード (Standard月 → Pro月)
コードが送る call (`applyUpgrade`):
```
stripe subscriptions update sub_XXX \
  -d "items[0][id]"=si_XXX \
  -d "items[0][price]"=price_1Tdqp4JX13jw2LsMhP2LzJXb \
  -d proration_behavior=always_invoice \
  -d payment_behavior=pending_if_incomplete
```
**期待 (成功時, 4242)**: 即時に差額 proration invoice が作成・支払われ、`items[0].price` が Pro月に。`customer.subscription.updated` webhook → DB `plan='pro'`, `billing_interval='month'`。`pending_update` は付かない。

### 1b. 支払い失敗パス (旧 price 維持 + pending_update)
customer の default payment method を**失敗するテストカード**にして同じ update を実行 (例: `4000 0000 0000 0341` = attach 成功・charge 失敗、または Stripe Testing docs の decline card)。
**期待**: invoice の支払いが失敗 → subscription は**更新されず旧 price (Standard月) を維持** + `sub.pending_update` がセット。DB `plan` は **standard のまま変化なし**。`invoice.payment_failed` webhook が飛び、DB 不変 + Discord (`notifyOps`) 通知が出る (T4)。

## 2. scheduleDowngrade — 期末ダウングレード (例: Pro月 → Standard月)
> Smoke 1 で Pro月 になっている前提。なっていなければ現 price を読み替え。
コードが送る 2 call (`scheduleDowngrade`):
```
# step1: from_subscription で schedule 化 (他 param 同時指定不可のため分離)
stripe subscription_schedules create -d from_subscription=sub_XXX
#   → 出力の id = sched_XXX、phases[0].start_date / phases[0].end_date を控える

# step2: 2 phase + release で update
stripe subscription_schedules update sched_XXX \
  -d end_behavior=release \
  -d "phases[0][start_date]"=<phases[0].start_date> \
  -d "phases[0][end_date]"=<phases[0].end_date> \
  -d "phases[0][items][0][price]"=price_1Tdqp4JX13jw2LsMhP2LzJXb \
  -d "phases[0][items][0][quantity]"=1 \
  -d "phases[1][items][0][price]"=price_1TdqksJX13jw2LsMg1JPQYoe \
  -d "phases[1][items][0][quantity]"=1 \
  -d "phases[1][proration_behavior]"=none
```
**期待**:
- step2 時点で**即時請求 / proration が発生しない** (現 phase は現 price 維持)。
- `sub.schedule` に `sched_XXX` が付く (= getPendingState の scheduleId、以後 in-place 変更ブロック対象)。
- **test clock を phases[0].end_date 以降に前進** → phase1 が有効化、price が Standard月 へ proration なしで切替。`customer.subscription.updated` webhook → DB `plan='standard'`。
- **billing anchor / 次回請求日が切替後も変わらない**こと (start/end を明示指定したことで anchor がずれていないか = 重点確認項目)。

## 3. cancelScheduledDowngrade — 予約取消 (release)
> Smoke 2 で schedule がある状態 (test clock 前進前) で実行。
コードが送る call (`cancelScheduledDowngrade`):
```
stripe subscription_schedules release sched_XXX
```
**期待**: schedule が release され、subscription は**現 price (Pro月) のまま継続**。ダウングレードは起きない。`sub.schedule` が null に戻る。**price / billing anchor が release 後も不変**であること (重点確認項目)。

## 4. webhook sub id クリア (解約)
Customer Portal から解約 → 期末 or 即時で `customer.subscription.deleted` 発火。
**期待 (T4)**: DB `users.stripe_subscription_id` が `null` に、`plan='free'`, `subscription_status='canceled'`, `billing_interval=null`, `cancel_at=null`。`current_period_end` は履歴として残る。

## 方針C 追加 (T12 実装後に実施する auto-release smoke)
Smoke 1-4 は基盤挙動 (即時 upgrade / schedule 作成 / 手動 release=予約取消 / sub id 同期) を検証する。**方針C の「発効後 自動 release」** は webhook gate (spec §6.4) を要するため、T10-T12 実装後に別途 smoke する:
- **Smoke 5 (auto-release)**: Smoke 2 で schedule を張り test clock を phases[0].end_date 以降へ前進 → `customer.subscription.updated` 受信 → gate #1/#2/#4/#5 充足で app が `subscriptionSchedules.release` を発火 → `sub.schedule` が null → DB `users` の `scheduled_downgrade_schedule_id` 等 3 列が clear → §5.5 ブロック解除 (プラン変更 UI が再び操作可)。
- 確認点: 発効前 (#4 false) は release されない / `subscription_schedule.released` 受信でも 3 列が冪等 clear / 二重 webhook で副作用なし。

## [reviewed] amend の段取り (改訂)
方針C 採用に伴い、ダウングレードは「予約 → 期末切替 → **自動 release** → 通常 subscription 復帰」まで揃って完結する。よって **T3 `ab1a7d4` / T4 `f1b99ec` / T5 `e452db4` の `[reviewed]` amend は、方針C タスク (T9-T12) 完了 + Smoke 1-5 通過後にまとめて実施**する (基盤だけ先に tag 付けしない)。
重点 NG 条件: Smoke 2/3/5 で billing anchor がずれる、Smoke 1b で旧 price が維持されない、Smoke 5 で発効前に release される/3 列が clear されない、のいずれかが出たら設計見直し (該当箇所の実装前に停止)。
