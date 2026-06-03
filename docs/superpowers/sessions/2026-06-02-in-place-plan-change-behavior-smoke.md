# プラン変更 in-place 化 — behavior-only smoke 手順 (OT 実行)

- **日付**: 2026-06-02
- **目的**: T3/T4/T5 (決済 touch) の `[reviewed]` amend 前に、コードが Stripe に送る**正確な params** を OT が test mode で再現し、Stripe 実挙動を確認する。
- **対象 commit**: T3 `ab1a7d4` / T4 `f1b99ec` / T5 `e452db4` (いずれも tag 無し)。
- **params の出典**: `lib/stripe/subscription.ts` (T3 実装)。

> 注: これは UI 前の behavior-only smoke。我々の action 自体は UI(T6/7) 未実装のため、ここでは action が組み立てる API call を OT が Stripe CLI/dashboard で手動再現する。挙動が想定どおりなら amend → UI 実装へ。

## ⚠️ 前提: 「DB 紐付き ⇄ test clock」 の default 両立不可 (smoke を 3 系統に分ける)

OT は **DB を Supabase ブラウザ / Stripe・Clerk をダッシュボード**で目視する。 default 経路では 1 つの subscription で「DB 列確認」と「時間前進」を**同時には満たせない**:

- **アプリ Checkout が作る customer** は Clerk 紐付き (= DB `users` 行あり) で DB 列を確認できるが、 **test clock 配下にできない** (時間を進められない)。
- **Stripe CLI で作る test clock customer** は時間を進められるが **Clerk 未紐付け (unlinked)** で、 対応する DB `users` 行が無く DB 列を確認できない。

よって本 smoke は目的別に **3 系統**で実施する (各手順の見出しにどれかを明記):

- **(a) Stripe 挙動・時間前進が要る確認** → **CLI test clock sub (unlinked)** を使う。
  - 対象: Smoke 1 / 1b / 2 / 3、 および Smoke 5 の Stripe 側 + 管理外 sub release 安全 (= 5-A)。
- **(b) DB 列の set/clear・webhook→DB 同期の確認** → **アプリ Checkout の DB 紐付き sub (clock なし)** を使う。
  - 対象: setup の `sub_id` 同期確認、 **1b-B (支払い失敗時の plan 非昇格)**、 Smoke 4 (解約)、 Smoke 5 の DB 側 (= 5-B)。
- **(c) 自動 release full path 確認 (DB 紐付き × test clock 両立)** → 手動 setup で workaround (CLI で**空**の test clock customer 作成 → Supabase で当該 user 行の `stripe_customer_id` を当該 cus に手動更新 → アプリ Checkout で sub を作る)。 **stg/test 限定の手動操作**で、 本番コードには恒久的な裏口を作らない。
  - 対象: Smoke 5 の自動 release full path (= 5-C)。

> つまり「Stripe がどう動くか」は (a) で、「webhook を受けて DB がどう書き換わるか」は (b) で、「方針C の自動 release が gate #1/#5 充足 → release 発火 → DB 3 列 clear → §5.5 ブロック解除まで通る full path」は (c) で見る。

## price ID (env、新 product)
- Standard 月 `price_1TdqksJX13jw2LsMg1JPQYoe`
- Standard 年 `price_1TdqoFJX13jw2LsMmSeJA643`
- Pro 月 `price_1Tdqp4JX13jw2LsMhP2LzJXb`
- Pro 年 `price_1TdqqIJX13jw2LsMvz4bMX1A`

## 0. setup — test subscription を作る (+ webhook sub id 同期の確認)

0 では**系統 (a)(b) 用の sub を 2 本**用意する。 系統 (c) 用の sub は **Smoke 5-C 内で別途作る** (DB 紐付き × test clock 両立の手動 workaround setup のため、 ここでは作らない)。

### 0-(b) DB 紐付き sub (アプリ Checkout) — DB 列・webhook→DB 同期用
1. stg/test の app で Checkout (既存 `createCheckoutSession`) から **Standard 月**に加入 (test card `4242 4242 4242 4242`)。 これは Clerk 紐付き = DB `users` 行ありの sub (**test clock は付けられない**)。
2. **確認 (T4)**: `checkout.session.completed` / `customer.subscription.created` 受信後、DB `users.stripe_subscription_id` に `sub_...` が入ること。`users.plan='standard'`, `billing_interval='month'`。
3. `sub_XXX` (subscription id) と `si_XXX` (item id = `items.data[0].id`) を控える (`stripe subscriptions retrieve sub_XXX`)。

### 0-(a) test clock sub (Stripe CLI) — 時間前進が要る Stripe 挙動用
4. `stripe` CLI で test clock を作成 → その clock 配下の customer で **Standard 月**に加入 (CLI / dashboard)。 これは時間前進できるが **Clerk 未紐付け** で DB 列は確認できない (Stripe 側挙動のみ見る)。
5. test clock id (`clock_XXX`)、 `sub_XXX` / `si_XXX` を控える。 Smoke 1 / 1b / 2 / 3 / 5-A はこの sub で実施する。

## 1. applyUpgrade — 即時アップグレード (Standard月 → Pro月) 〔系統 (a) test clock sub〕
> **再確認の位置づけ**: Smoke 1 / 1b は前回確認済み。 ただし T10 (status gate) / T12 で周辺コードが変わったため**軽く再確認**する。 重点は **1b (支払い失敗時に旧 price が維持されること)** と、 2/3/5 (anchor 不変・自動 release)。 1 本体 (成功 upgrade) は流す程度でよい。

コードが送る call (`applyUpgrade`):
```
stripe subscriptions update sub_XXX \
  -d "items[0][id]"=si_XXX \
  -d "items[0][price]"=price_1Tdqp4JX13jw2LsMhP2LzJXb \
  -d proration_behavior=always_invoice \
  -d payment_behavior=pending_if_incomplete
```
**期待 (成功時, 4242、Stripe 側のみ)**: 即時に差額 proration invoice が作成・支払われ、`items[0].price` が Pro月に。`pending_update` は付かない。
> 確認対象は **Stripe 側のみ** (`subscription.items[0].price` / `pending_update` / `invoice`)。本 sub は test clock = Clerk 未紐付け = DB `users` 行なしのため **DB plan/billing_interval は確認しない**。DB 同期は **0-(b) / Smoke 4 / Smoke 5-B** で確認する。

### 1b. 支払い失敗パス (旧 price 維持 + pending_update) 〔系統 (a) test clock sub〕
customer の default payment method を**失敗するテストカード**にして同じ update を実行 (例: `4000 0000 0000 0341` = attach 成功・charge 失敗、または Stripe Testing docs の decline card)。
**期待 (Stripe 側のみ)**: invoice の支払いが失敗 → subscription は**更新されず旧 price (Standard月) を維持** + `sub.pending_update` がセット。`invoice.payment_failed` イベント自体は発火する。
> test clock sub は Clerk 未紐付けのため、**DB plan 据え置き / 自前 webhook が plan を昇格しないこと**はここでは見ない → **1b-B (系統 b)** で確認する。

### 1b-B. 支払い失敗時に自前 webhook が plan を昇格しないこと 〔系統 (b) DB 紐付き sub〕
0-(b) の DB 紐付き sub (Standard月) で、**customer と subscription の default_payment_method を失敗カード** (`pm_card_chargeCustomerFail` を customer + subscription **両方**に設定) にし、Smoke 1 と同じ `applyUpgrade` params を実行する。
**期待**:
- **Stripe 側**: `pending_update` が付き、`items[0].price` は**旧 price (Standard月) のまま**。
- **DB 側**: `users.plan` / `users.billing_interval` が**旧値 (standard / month) のまま昇格しない** (= 自前 webhook は pending_update 付き `customer.subscription.updated` を受けても、現在プランを **actual current item price から正規化**し target price へ昇格させない、§6.1 正規化の実機確認)。
- `invoice.payment_failed` → DB 不変 + Discord (`notifyOps`) 通知 (T4)。
- **主目的**: 1b の「Stripe が旧 price を維持」に加え、**「自前 webhook が誤って plan を更新しない」を DB で確認**する点。
> 註: 1b-B は sub に `pending_update` + 失敗カードを残すため、Smoke 4 / 5-B 用には**別の DB 紐付き sub を用意**するか、本 smoke 後に pending_update を解消 (正常カードで再 update or void invoice) + default_payment_method を戻してから進める。

## 2. scheduleDowngrade — 期末ダウングレード (例: Pro月 → Standard月) 〔系統 (a) test clock sub〕
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
> ⚠️ **注 (schedule update は phase を丸ごと再指定する)**: `subscription_schedules.update` は current/future phases を**丸ごと再指定**する API で、税 (`tax_rates`) / 割引 (`discounts`/`coupon`) / `trial` / `metadata` / `default_payment_method` / `collection_method` 等は**再投入しないと unset されうる**。現状の phase は price/quantity のみなので本手順で可。将来これら属性を使う場合は、retrieve した既存 phase / `default_settings` から保持値を再投入すること。

**期待**:
- **schedule 作成直後 (step2)**: 即時請求 / proration が発生しない (現 phase は現 price 維持)。`billing_cycle_anchor` / `current_period_end` が**不変**。`sub.schedule` に `sched_XXX` が付く (= getPendingState の scheduleId、以後 in-place 変更ブロック対象)。
- **test clock を phases[0].end_date 以降に前進 (phase1 発効後)**: `items[0].price` が target (Standard月) へ proration なしで切替。確認対象は **Stripe 側のみ** (test clock sub = Clerk 未紐付け = DB 行なし)。**DB 同期 (plan/billing_interval) はここでは見ない** → 発効 → DB 同期/3 列 clear は Smoke 5-A の Stripe 挙動 + Smoke 5-B / §6.4.1 released webhook で担保する。
- **billing anchor の確認 (重点)**: 「期末をまたぐと `current_period_end` が次周期へ進むのは**正常**」であり、これを **anchor ずれと混同しない**。区別して見るべきは:
  - ① 発効後も `billing_cycle_anchor` が **phase_start に意図せずリセットされていない**こと、
  - ② **次回請求日が本来の月次サイクルから外れていない**こと (start/end を明示指定したことで anchor がずれていないか)。

## 3. cancelScheduledDowngrade — 予約取消 (release) 〔系統 (a) test clock sub〕
> Smoke 2 で schedule がある状態 (test clock 前進前) で実行。
コードが送る call (`cancelScheduledDowngrade`):
```
stripe subscription_schedules release sched_XXX
```
**期待**: schedule が release され、subscription は**現 price (Pro月) のまま継続**。ダウングレードは起きない。`sub.schedule` が null に戻る。**price / billing anchor が release 後も不変**であること (重点確認項目)。

## 4. webhook sub id クリア (解約) — **実装上 2 段階**
Customer Portal からの解約は実装上 **4-a (.updated 段階) → 4-b (.deleted 段階)** の 2 段階に分解される。 旧 doc は .deleted 後の最終状態のみ書いており、 4-a の中間状態 (cancel_at set / plan は据え置き) が欠けていたため OT 観測とズレていた。

> 註: Portal の cancel mode (即時 / 期末) は **Stripe Dashboard 側 Portal 設定の default (= end of billing period)** で決まり、 自前コードは `cancel_at_period_end` を制御しない (`createBillingPortalSession` は `portal_configuration` を渡さない、 `app/(app)/app/settings/actions.ts:7-24`)。 stg 観測の「期末予約」 はこの default の結果。

### 4-a. Portal 解約ボタン直後 (.updated 段階、 期末予約成立) 〔系統 (b) DB 紐付き sub・clock なし〕 [PASS 2026-06-03]
> 実機確認 (stg): `cancel_at` に set / `current_period_end` 同値 set / `plan` / `billing_interval` / `subscription_status='active'` / `sub_id` は据え置き (= free 化しない) を Supabase で目視確認。
0-(b) の DB 紐付き sub (Standard 月) で Customer Portal から解約 → 期末予約成立 → `customer.subscription.updated` 受信 (この時点で sub は `status='active'` のまま、 `cancel_at_period_end=true`、 `cancel_at` に Unix 秒)。 handler: `route.ts:237-296`。
**期待 (.updated 段階)**:
- DB `users.cancel_at` に**予約日 (Date)** が set される。
- DB `users.current_period_end` に**期末日 (Date)** が set される (`item.current_period_end` と同値、 通常 `cancel_at` と一致)。
- DB `users.plan` / `users.billing_interval` / `users.subscription_status` (= `'active'`) / `users.stripe_subscription_id` は**据え置き** (= **free 化しない**)。
- DB scheduled 3 列は SET 句外なので触らない。
- Clerk publicMetadata は `plan` 据え置き値で再 sync (実質変化なし)。
> 註: ここで free 化を期待してはならない。 free 化は期末到来後の **4-b (.deleted)** で起きる。 4-a は clock 不要で実時間即観測可能 (OT 既観測の挙動と一致)。

### 4-b. 期末到来後 (.deleted 段階、 free 化確認) 〔系統 (c) 5-C 環境に相乗り〕 [PASS 2026-06-03 / 5-C step 9-11 経由]
> 実機確認 (stg): 5-C step 9-11 で実施。 詳細は下記 5-C 続き section 参照。
期末到来時に Stripe が `customer.subscription.deleted` を発火し、 自前 handler (`route.ts:298-334`) が DB を free 化する。 **実時間で期末まで待つのは現実的でない**ため、 **独立 setup を作らず 5-C の test clock 環境にステップとして相乗り**させる。 具体手順は **Smoke 5-C の step 9-11** (auto-release full path 検証完了後の独立追加ステップとして末尾配置)。
**期待 (.deleted 段階)**:
- DB `users.plan='free'` / `billing_interval=null` / `subscription_status='canceled'` / `cancel_at=null` / `stripe_subscription_id=null` / scheduled 3 列=null。
- DB `users.current_period_end` は**触らない** (履歴として残す、 `route.ts:302` の comment 明示)。
- Clerk publicMetadata が `plan='free'` で sync される (`route.ts:319-321`)。

## 方針C 追加 (T12 実装後に実施する auto-release smoke)
Smoke 1-4 は基盤挙動 (即時 upgrade / schedule 作成 / 手動 release=予約取消 / sub id 同期) を検証する。**方針C の「発効後 自動 release」** は webhook gate (spec §6.4) を要するため、T10-T12 実装後に別途 smoke する。

Smoke 5 は default 経路の「DB 紐付き ⇄ test clock 両立不可」のため **5-A (Stripe 挙動・時間前進 + 管理外 sub release 安全) / 5-B (DB 列 set/clear) / 5-C (両立 workaround で自動 release full path) の 3 つに分割**する。

### Smoke 5-A — Stripe phase 切替 + 管理外 (unlinked) sub release 安全 〔系統 (a) test clock sub〕
test clock sub (Clerk **未紐付け** = DB `users` 行なし) で **「Stripe 側の phase 切替・billing anchor が正しい」 + 「app が unlinked sub を勝手に release しない (= 管理外 sub release 安全)」** の 2 点を確認する。 DB 列は unlinked のため見ない (DB 同期は 5-B、 自動 release full path は 5-C で見る)。

> 註 (なぜ unlinked では release しないか): `scheduleDowngrade` が作る schedule は phase[1] (target) を **open-ended** で作るため (`lib/stripe/subscription.ts:210-213` で end_date 未指定)、 phase[0] 終了 → phase[1] 移行後も Stripe 側の `end_behavior='release'` は発火しない (全 phase 完了条件を満たさない)。 unlinked では release gate #1 (`sub.schedule === DB.scheduledDowngradeScheduleId`) も DB 行不在で評価できない → app の `evaluateReleaseGate` は呼ばれない (`route.ts:267-295`: unlinked = clerkId undefined で `notifyOps('stripe sub event for unlinked customer')` のみ発火しうる、 release 系の notify は出ない)。 結果として **sub.schedule は残ったまま** が正しい挙動 (= 管理外 sub への安全挙動)。

1. **予約**: Smoke 2 と同手順で schedule を張る (`sched_XXX` 取得、 `sub.schedule` に付与)。
2. **clock 前進前**: Stripe dashboard で `sub.schedule = sched_XXX` のまま残ること、 phase 切替も起きていないこと。
3. **clock 前進後** (test clock を `phases[0].end_date + 60 秒` 以降へ前進、 境界ピッタリより少し後にする) → phase[1] 有効化 → `customer.subscription.updated` 受信。 確認:
   - **Stripe 側 phase 切替**: `items[0].price` が target に切り替わる (= Stripe schedule の phase 進行による、 app の介入なし)。
   - **billing anchor (Smoke 2 と同基準)**: `billing_cycle_anchor` が phase_start に意図せずリセットされない / 次回請求日が本来の月次サイクルから外れない (「期末をまたいで `current_period_end` が次周期へ進む」のは正常、 anchor ずれと混同しない)。
   - **sub.schedule は `sched_XXX` のまま残る (null にならない)** — app は能動 release を発火せず、 Stripe end_behavior も phase[1] open-ended のため発火しない。 **null になることを期待しない**。
   - **Discord / notifyOps に release 関連通知が来ない** (unlinked .updated の汎用通知 `'stripe sub event for unlinked customer'` が環境次第で発火しうるが、 release 系の通知は出ない)。
4. 確認点: 前進後でも sub.schedule が `sched_XXX` のまま残ること = app は管理外 (unlinked) sub を release しない (安全挙動)。 自動 release が**発火する** full path の検証は **5-C** で実施 (linked + gate 充足で初めて app が release を発火する)。

### Smoke 5-B — DB 3 列の set/clear 〔系統 (b) DB 紐付き sub〕 [PASS 2026-06-03]
> 実機確認 (stg): Pro 月 → Standard 月 のダウングレード予約で `scheduled_downgrade_schedule_id` / `scheduled_target_price_id` / `scheduled_change_effective_at` の 3 列 set、 取消で 3 列 clear (null) を Supabase で確認。
DB 紐付き sub (test clock 無し) で、 予約 → DB set、 取消 → DB clear を確認する。 切替発火 (時間前進) は見ない。

1. **予約 (set)**: プラン変更 UI でダウングレードを予約 → Supabase で `users` の **`scheduled_downgrade_schedule_id` / `scheduled_target_price_id` / `scheduled_change_effective_at` の 3 列が set** されること。
2. **取消 (clear)**: 取消 banner から取消 → `subscriptionSchedules.release` → **3 列が clear (null)** されること。
3. 註: 切替発効後の「3 列の自動 clear」は test clock が要るためここでは見ない。 これは **5-C の full path** で担保する (linked + clock で app が能動 release → 3 列 clear → §5.5 ブロック解除)。 **5-A は unlinked sub のため app の能動 release / DB clear は期待しない** (5-A は管理外 sub release 安全側の確認)。

### Smoke 5-C — DB 紐付き × test clock × 自動 release full path 〔系統 (c) 手動 workaround〕 [PASS 2026-06-03 / step 1-8]
> 実機確認 (stg、 `+002` free): 空 test clock customer 紐付け → Pro 月 Checkout (`plan='pro'` set / `stripe_customer_id` 維持) → Pro 月 → Standard 月 ダウングレード予約 (3 列 set) → clock advance (`phases[0].end_date + 60 秒`) → `customer.subscription.updated` 受信 → app が `subscriptionSchedules.release` を能動発火 → `sub.schedule=null` / schedule status=`released` / `released_subscription` set / DB 3 列 clear / `plan='standard'` / §5.5 ブロック解除 (UI banner 消滅・CTA 再活性) を確認。 `billing_cycle_anchor` 不変。 二重 `released` は `releaseScheduleIdempotent` の status gate が吸収し副作用なし。
方針C の **「webhook gate #1+#5 充足 → app が能動 release → DB 3 列 clear → §5.5 ブロック解除」 の full path** を実機で 1 経路通す。 5-A (Stripe 側のみ) と 5-B (DB 側のみ・clock なし) の隙間に残っていた「linked sub に clock を載せた full path」をここで埋める。 手動 setup で workaround するため **stg/test 限定、 本番コードに恒久裏口なし**。

1. **CLI**: `stripe customers create -d test_clock=clock_XXX` で **空の test clock customer** を作成 (clock 配下、 sub なし)。 `cus_XXX` を控える。 (`-d` 形式 + 正規 param 名 `test_clock` で CLI 解釈事故を避ける)
   > ⚠️ **落とし穴 1 (既存 sub 持ち込み禁止)**: 0-(a) の Standard 月 入り customer を再利用しない。 既存 sub 持ち込みは Checkout で 2 本目の active sub を作り、 webhook が後勝ち上書きで 1 本目が DB から orphan 化する。 必ず empty な新規 customer を別に作る。
2. **stg の app で `komail9server+002@gmail.com` (plan='free') にログイン**。 Supabase で当該 user 行が `plan='free'` / `stripe_subscription_id=NULL` であることを事前確認 (必要なら手動で戻す)。
   > ⚠️ **落とし穴 2 (paid から始めない)**: paid アカウントだと `/app/upgrade` の CTA は Checkout ではなく `PaidChangeForm → changePlan` 経路になり、 本ルートが使えない。 必ず free から始める (`upgrade-plans.tsx:230-241` の `userPlan === 'free'` 分岐に乗せる)。
3. **Supabase で当該 user 行の `stripe_customer_id` を手動更新**: `stripe_customer_id = cus_XXX` (step1 の空 clock customer)。 同時に `stripe_subscription_id=NULL` / `plan='free'` / `billing_interval=NULL` であることも再確認。
4. **アプリ `/app/upgrade` で Checkout (Pro 月、 test card `4242 4242 4242 4242`)** → `createCheckoutSession` (`actions.ts:50-65`) が `customer: cus_XXX` を渡し、 当該 test clock customer 配下に sub が DB 紐付きで作られる。 webhook で `plan='pro'` / `billing_interval='month'` / `stripe_subscription_id=sub_...` が set されること、 `stripe_customer_id` が手入力値 (`cus_XXX`) のままなことを Supabase で確認。
   > 註: Pro 月 から始めるのは、 5-C の主目的 (auto-release full path) に対して**途中の `applyUpgrade` / proration invoice を挟まず最短経路で downgrade 予約に進む**ため。 billing anchor の正常性検証は 5-A (Smoke 2/3/5-A) に委譲する。
5. **アプリ UI で Pro 月 → Standard 月 のダウングレード予約**。 `PaidChangeForm → changePlan → scheduleDowngrade` 経路 (`actions.ts:72-145`)。 → Supabase で `scheduled_downgrade_schedule_id` / `scheduled_target_price_id` / `scheduled_change_effective_at` の **3 列が set** されることを確認。
6. **CLI で時間前進**: `stripe test_helpers test_clocks advance <clock_id> -d frozen_time=<phases[0].end_date + 60 秒>` (advance は現在より後・進めすぎない制約があるため、 境界ピッタリではなく少し後にする)。
7. **`customer.subscription.updated` 受信 → gate #1+#5 充足 → app が `subscriptionSchedules.release` を能動発火**。 確認:
   - **Stripe dashboard**: `sub.schedule = null` / schedule status = `released`。
   - **Supabase**: `scheduled_downgrade_schedule_id` / `scheduled_target_price_id` / `scheduled_change_effective_at` の **3 列が clear (null)**。
   - **アプリ UI**: §5.5 ブロックが解除され、 `/app/upgrade` で再びプラン変更 CTA が押せること (`PaidChangeForm` 上部に予約 banner が出ていないこと)。
8. **(option)** `subscription_schedule.released` の二重 fire でも DB が冪等であること (`route.ts:348-361` の where 句で 0 行 match → no-op、 `notifyOps` 出さない)。

**重点 NG (5-C)**: 自動 release が発火しない (linked + gate 充足なのに schedule が残る) / DB 3 列が clear されない / §5.5 ブロックが解除されない。 これが出たら方針C の webhook gate 実装 (`app/api/webhooks/stripe/route.ts:369-426` / `lib/stripe/subscription.ts:269-` の `releaseCompletedDowngrade`) を見直し。

---

#### 5-C 続き: 4-b (Portal 解約 → 期末到来 → free 化) の相乗り検証 [PASS 2026-06-03 / step 9-11]
> 実機確認 (stg、 5-C step 1-8 と同 user): Standard 月 active 状態で Portal 解約 → `cancel_at=8/3` set (4-a 中間状態を 5-C 環境でも再現、 `plan='standard'` 据え置き) → clock advance (`cancel_at + 60 秒`) → `customer.subscription.deleted` 受信 → DB free 化 (`plan='free'` / `billing_interval=null` / `subscription_status='canceled'` / `cancel_at=null` / `sub_id=null` / scheduled 3 列=null)、 `current_period_end=8/3` は履歴として残存 (破壊なし)。 Stripe sub `status=canceled` / `ended_at` set、 Clerk `publicMetadata.plan='free'` 同期も確認。
step 1-8 で auto-release full path を確認した後、 **同じ test clock customer + DB 紐付き user 上で続けて** 4-b を観察する。 step 9-11 は step 1-8 とは独立した追加検証であり、 step 1-8 が NG で停止した場合は 4-b 相乗りも実施しない (5-C 本来の検証を優先)。 sub 状態は step 8 終了時点で Standard 月 (downgrade 発効後)、 schedule released、 DB 3 列 clear、 ブロック解除済。

9. **(4-b 準備) アプリ `/app/settings` から Customer Portal を開き、 当該 sub (Standard 月) を解約**。 → `customer.subscription.updated` 受信 (期末予約)。 確認 (= **4-a の中間状態**を 5-C 環境でも再観測):
   - Supabase: `users.cancel_at` に**期末日 (Date)** / `users.current_period_end` に同値 (Date) が set。
   - Supabase: `users.plan='standard'` / `users.billing_interval='month'` / `users.subscription_status='active'` / `users.stripe_subscription_id` は**据え置き** (= free 化していない)。
   - 4-a (系統 b) で既に確認済の挙動と同一なので、 ここは skip 可。 5-C 環境でも再現することの裏取りとして観察したい場合のみ実施。
10. **CLI で時間前進**: `stripe test_helpers test_clocks advance <clock_id> -d frozen_time=<step 9 で set された current_period_end + 60 秒>` (step 6 の advance とは別の advance、 期末到来用。 境界ピッタリではなく少し後)。
11. **`customer.subscription.deleted` 受信 → DB free 化を確認** (= **4-b の最終状態**):
    - Supabase: `users.plan='free'` / `users.billing_interval=null` / `users.subscription_status='canceled'` / `users.cancel_at=null` / `users.stripe_subscription_id=null` / scheduled 3 列=null。
    - Supabase: `users.current_period_end` は**触らない (履歴として残る)**。
    - Clerk dashboard で当該 user の `publicMetadata.plan='free'` で sync されていること。

**重点 NG (5-C / 4-b)**: 4-a 段階 (step 9) で plan が free 化してしまう (= 中間状態で free 化される実装バグ) / 4-b 段階 (step 11) で free 化が起きない / `current_period_end` が消える (= 履歴破壊) / scheduled 3 列が clear されない。 これが出たら `route.ts:237-296` (.updated handler) / `:298-334` (.deleted handler) を見直し。

### Smoke 5-C-2 — ダウングレード予約 + Portal 解約 で DB 両方 set 成立 → 整合収束 〔系統 (c) 手動 workaround、 別 clock / 別 user〕 [未実施 2026-06-03]
**目的**: 調査で「ダウングレード予約 → Portal 解約」 path は changePlan ガードで塞がれず、 `.updated` handler の SET 句が scheduled 3 列を touched しない (`route.ts:252-261`) ため DB に `cancel_at` + scheduled 3 列が **両方 set** される状態が path 上成立しうる、 と判明。 アプリ handler は両方 set を冪等に解消し integrity を保つ (調査済) が、 **その前提となる「Stripe が schedule 付き sub の Portal cancel をどう扱うか」 はコードから判定不可** (調査の未確認点 1)。 ここで 1 経路通して実機確認する。

> 註: 5-C-2 は **step 1-8 (auto-release full path) / step 9-11 (4-b) とは独立した別フロー**。 干渉を避けるため **別の空 clock customer + 別の free アカウント** で 1 から立てる (step 1-8 で使う `+002` とは分け、 sub 使い回しによる orphan / 混線を回避)。 系統 (c) の手動 workaround setup は同じ。

1. **CLI**: `stripe customers create -d test_clock=clock_YYY` で **別の空 test clock customer** を作成 (step 1-8 の `clock_XXX` / `cus_XXX` とは別)。 `cus_YYY` を控える。
2. **stg の app で `komail9server+001@gmail.com` (free) にログイン**。 Supabase で当該 user 行が `plan='free'` / `stripe_subscription_id=NULL` であることを事前確認 (前 smoke の paid 状態が残っていれば手動で戻す)。
3. **Supabase で 001 の `stripe_customer_id` を手動更新**: `stripe_customer_id = cus_YYY` (step1 の空 clock customer)。 `stripe_subscription_id=NULL` / `plan='free'` / `billing_interval=NULL` も再確認。
4. **アプリ `/app/upgrade` で Checkout (Pro 月、 test card `4242 4242 4242 4242`)** → 当該 test clock customer 配下に DB 紐付き sub。 webhook で `plan='pro'` / `billing_interval='month'` / `stripe_subscription_id=sub_...` が set されることを Supabase で確認。
5. **アプリ UI で Pro 月 → Standard 月 のダウングレード予約**。 → Supabase で `scheduled_downgrade_schedule_id` / `scheduled_target_price_id` / `scheduled_change_effective_at` の **3 列が set** されることを確認。
6. **予約を残したまま (取消しない) `/app/settings` → Customer Portal で当該 sub を解約**。 → `customer.subscription.updated` 受信 (`cancel_at` set)。 確認 (= **両方 set 成立 + Stripe 側挙動観察 = 本 smoke の主目的**):
   - **Stripe dashboard (= 調査未確認点 1 の実機確認)**: schedule attach 済の sub を Portal が cancel 受理したか。 受理した場合 `sub.schedule` の扱いを目視:
     - (a) schedule 残ったまま (`sub.schedule = sched_XXX` 継続) → 期末発効時に gate #1 が DB と一致 → app が能動 release を発火しうる。
     - (b) Stripe が schedule を即時 release した (`sub.schedule = null` / schedule status = `released`) → `.released` webhook 受信 → DB 3 列 clear。
     - (c) Stripe が schedule を canceled にした (`sub.schedule = null` / schedule status = `canceled`) → `.released` webhook が出ないため `route.ts:348-361` の clear handler は走らない → DB 3 列残り、 後の `.deleted` handler (`:312-315`) で 3 列 clear される。
     - (d) Portal が cancel を**拒否**した (= 解約できない) → DB 不変、 c-1 そのものが成立しない (アプリ実装は影響なし)。
   - **Supabase**: `users.cancel_at` に**期末日 (Date)** が set + `users.current_period_end` に同値 (Date) が set + **scheduled 3 列も依然 set** (= DB 両方 set)。 `users.plan='pro'` / `users.billing_interval='month'` / `users.subscription_status='active'` / `users.stripe_subscription_id` は**据え置き**。
   - **notifyOps**: Discord に gate mismatch 等の異常通知が**出ていない**こと (この時点では `.updated` の通常受信のみ、 mismatch 経路に入る場合は理由を記録)。
7. **CLI で時間前進**: step 6 後、 まず `stripe subscriptions retrieve sub_XXX` で **`cancel_at` と `phases[0].end_date` の Unix 秒**を確認。 通常 default Portal cancel (期末予約) では `cancel_at == phases[0].end_date == current_period_end` で同値だが、 ズレがあれば早い方を採用。 `stripe test_helpers test_clocks advance <clock_id_YYY> -d frozen_time=<min(cancel_at, phases[0].end_date) + 60 秒>` で前進。 確認 (= **整合収束**):
   - 発火 event の順序: `customer.subscription.updated` (ダウングレード発効 = item price 切替、 phases[0] 終了) と `customer.subscription.deleted` (解約発効) のどちらが先か / 両方発火するか / どちらか片方のみか を Stripe dashboard の event log で目視。
   - **DB 最終状態の収束**:
     - 「ダウングレード発効 → 解約」 順なら: 一旦 plan='standard' に切替 + scheduled 3 列 clear (`route.ts:412-425` か `:348-361` 経由) → その後 .deleted で plan='free' / 全 reset。
     - 「解約発効 → ダウングレード発効」 順なら: .deleted で plan='free' / scheduled 3 列 clear (`route.ts:312-315`) + cancel_at=null / sub_id=null。 ダウングレード側は sub 消滅で発火しないか、 後着の `.updated` は unlinked customer 扱い (DB 行 stripeCustomerId が既に touched されていないため依然 hit はする — ただし plan='free' で normalize される)。
     - 同タイミング (典型ケース) なら: 上記いずれかの順序になるが、 handler の冪等性で最終整合は保たれる。
   - **Supabase で DB 最終状態を確認**: `users.plan='free'` (解約が最終的に効くため) / `users.billing_interval=null` / `users.subscription_status='canceled'` / `users.cancel_at=null` / `users.stripe_subscription_id=null` / scheduled 3 列=null / `current_period_end` は履歴として残る。 plan が 'standard' でも 'pro' でもなく **'free' に収束**することが正。
   - **notifyOps**: 未処理の異常通知 (gate mismatch / unlinked sub event 等) が出ていないか確認。 出た場合は内容を記録 (`stripe release gate schedule mismatch` は step 6-(c)-(d) パスで出うる、 `stripe sub event for unlinked customer` は本来出ないが出たら anomaly)。
8. **(option)** さらに clock を進めて残りのイベント (解約 or ダウングレードの後発分) が出ないかを確認、 最終状態が変動しないことを確認 (= 安定収束)。

**重点 NG (5-C-2)**: DB が両方 set のまま収束しない (cancel_at + scheduled 3 列が clear されないまま放置される) / `users.plan` が free でも standard でも pro でもない不整合な値で止まる / notifyOps に未処理の異常 (gate mismatch で release も clear もされず handler が無言で諦める) が記録される。 これが出たら `route.ts:237-296` (.updated) / `:298-334` (.deleted) / `:348-361` (.released) / `:369-426` (`evaluateReleaseGate`) を見直し。

> 註: 5-C-2 は **Stripe 側の Portal cancel × schedule 挙動の実機観察**が主目的。 アプリ handler の冪等性自体は調査済 + 5-A / 5-B / 5-C / 4-a / 4-b で個別カバー済のため、 step 6-7 で観測される Stripe 側挙動 (a)/(b)/(c)/(d) のうち**どれが起きたか**を記録するだけでも本 smoke の目的は達成される。

## UI smoke (T6-T8 実装後に実施、Smoke 1-5 と並行可)
backend smoke と別に、UI フロー (paid 在籍状態で DevTools mobile view) を確認する。実装詳細: `docs/superpowers/sessions/2026-06-03-in-place-plan-change-impl-T11-T12-T6-T8.md`。

- **U1 (entry 統一)** [PASS 2026-06-03]: 全 plan で entry CTA 文言を「プラン変更」 に統一 (settings page 統一 commit 反映済)。
  - **paid** user の `/app/settings`: 「プラン変更」 + 「お支払い・解約を管理」 の **2 ボタン** (Pro 年額含む)。
  - **free** user の `/app/settings`: 「プラン変更」 **のみ** (Portal ボタンは paid 限定 — free は Stripe customer 不在で Portal session 作成が失敗しうるため)。 旧「プランを選択」 文言は廃止。
  - **`/app` 下部 CTA** (dashboard): 全 plan で「プラン変更」 表示 (Pro 年額含む、 §7.4 既統一)。
  - **遷移先**: free / paid とも `/app/upgrade` (= 同じ)。 着地後の page 内分岐 (free → Checkout / paid → in-place changePlan) は別レイヤーで残存。
  - **案B (settings 予約表示) も PASS**: settings プラン欄に DB 予約 set 時の「{date} に {tier} {interval} へ変更予約中」 表示が出ることを確認。
- **U2 (card 選択可否)** [PASS 2026-06-03]: `/app/upgrade` で現プランのみ disable「現在のプラン」、下位プランも選択可 (旧「現在より下位プラン」disable が消滅)。pro+year でも redirect されず page 表示。
- **U3 (確認 modal)** [PASS 2026-06-03]: paid で上位/下位 card の CTA → 金額なし確認 modal。upgrade=「今すぐ差額が請求され…」/ downgrade=「現在の請求期間終了後に {plan} へ切り替わります…」。Esc / backdrop / キャンセルで閉、確認で changePlan 発火 → `/app?billing=upgrade|downgrade`。**mobile で modal が画面内に収まり tap 可能か** も確認。
- **U4 (予約中ブロック + 取消 banner)** [PASS 2026-06-03]: ダウングレード予約中 (DB `scheduled_downgrade_schedule_id` set) は全変更 CTA disable + 案内文、page 上部に短縮版 banner「**{tier} {interval}へ変更予約中（{date}）— 取消**」(例:「Standard 月額へ変更予約中（2026/7/1）— 取消」)。取消 → cancelDowngrade → 3 列 clear → 再操作可。日付が `Intl ja-JP` 整形。(T8-copy `234175a` で冗長版「Standard プラン 月額 への…」から短縮済)
  - **案A (notice 3 状態出し分け) も PASS**: ダウングレード予約のみ時に旧 blocked notice (「処理中の支払い完了 または 予約キャンセル…」) が消滅し、 banner のみ表示されることを確認。
- **U5 (success banner)** [PASS 2026-06-03]: `?billing=new` (Checkout 後) / `?billing=downgrade` (変更後) で対応文言 banner 表示・dismiss 可を確認。 `?billing=upgrade` は未確認 (仕組み共通のため省略)。 Checkout success_url が `?billing=new` に。
- 確認点: §5.5 ブロック中に UI で操作できる抜け道がない (server `changePlan` も同条件で `CHANGE_BLOCKED`)。
- UI smoke U1-U5 は現状のままで可 (U4 の取消 banner 文言のみ上記短縮版に更新)。

## [reviewed] amend の段取り (改訂)
方針C 採用に伴い、ダウングレードは「予約 → 期末切替 → **自動 release** → 通常 subscription 復帰」まで揃って完結する。よって **以下 10 commit の `[reviewed]` amend は、Smoke 1-5 + UI smoke (U1-U5) 通過後にまとめて実施**する (基盤だけ先に tag 付けしない):
T3 `ab1a7d4` / T4 `f1b99ec` / T5 `e452db4` / T10 `0ca575e` / T11 `0416924` / T12 `7607134` / T6 `fea94c5` / T7 `6d0af95` / T8 `6d63a36` / T8-copy `234175a` (変更予約 banner 文言短縮)。
(全実装 2026-06-03 完了。各 commit は spec compliance + code quality canonical review 通過済 = `[reviewed]` の実体は満たすが、決済/外部副作用の裏取りとして OT 実機 smoke を待つ。amend は連続 commit のため OT GO 後に `git rebase` で一括付与する。)

**tag 無し commit と Stop hook の運用 (確定)**: 上記 10 commit は「OT smoke 待ちの意図的 tag 無し (裏取り保留)」が正。
- Claude Code は `[reviewed]` を**先付けしない** (smoke 通過が裏取り条件)。
- Stop hook (`check-review.sh`) が tag 無し feat で turn 終了を妨げる場合は **bypass で通してよい** (保留中の正当状態)。hook の都合で `[reviewed]` を先付けするのは禁止。
- `[reviewed]` は OT smoke 通過後に 10 commit へ `git rebase` で一括付与 (OT GO → Claude Code が提案・実行)。
重点 NG 条件: Smoke 2/3/5-A で billing anchor がずれる、Smoke 1b で旧 price が維持されない、Smoke 5-A で app が unlinked sub を release してしまう (前進前後を問わず schedule が消える / release 関連 notifyOps が発火する)、Smoke 5-B で 3 列が set/clear されない、Smoke 5-C で自動 release が発火しない / DB 3 列が clear されない / §5.5 ブロックが解除されない、Smoke 4-a で plan が free 化する (中間状態で free 化する実装バグ)、Smoke 4-b で free 化が起きない / current_period_end が消える (履歴破壊)、Smoke 5-C-2 で DB が両方 set のまま収束しない / plan が free/standard/pro いずれでもない不整合値で止まる / 未処理の gate mismatch が記録される、のいずれかが出たら設計見直し (該当箇所の実装前に停止)。

---

## 別件メモ (本 sprint smoke 対象外)
解約まわりの実装挙動調査で判明したが、 本 sprint (プラン変更 in-place 化) の範囲外として記録のみ残す。 smoke 項目は立てない。

- **Clerk アカウント削除フロー** (`app/api/webhooks/clerk/route.ts:132-235`): `user.deleted` 受信 → `stripe.subscriptions.cancel` で**即時 cancel** (期末予約ではない) → DB transaction で `users` を**論理削除** (`deleted_at=now()`) + `exams` / `study_days` / `contact_messages` を**物理削除** (`exams` の cascade で `cards` / `source_documents` / `reviews` も連鎖物理削除)。 **Stripe customer 自体は削除しない** (`stripe.customers.del` の呼出なし)。
- **未確認 (cascade FK 持ち table の残置)**: `ai_usage_users` (`schema.ts:169`) / `user_preferences` (推定、 `:470`/`:489`) / `clerk_metadata_audit` 等 (`:548`/`:598`/`:637`/`:662`) は `users.id` に `onDelete: cascade` を持つが、 Clerk handler の明示 DELETE 対象外 + `users` 論理削除のため**残置されている**。 設計意図 (残置でよい / 漏れ) は本 sprint では確認しない。
- **未確認 (GDPR 整合性)**: `stripe.customers.del` を呼ばないことが GDPR 等の deletion 要件と整合するか (設計判断の問題、 コードからは判定不能)。
- **未確認 (削除フロー race)**: Clerk 削除と Stripe `.deleted` webhook の race で `syncClerkPublicMetadata` (`route.ts:321`) が削除済 Clerk user に対し呼ばれた時の error 挙動 (try/catch で swallow されるか)。 outer catch (`route.ts:55-67`) で 200 swallow される設計とは別問題。

該当 file path: `app/api/webhooks/clerk/route.ts:132-235` / `lib/db/schema.ts:62-122, :130-` / `app/api/webhooks/stripe/route.ts:298-334`。
