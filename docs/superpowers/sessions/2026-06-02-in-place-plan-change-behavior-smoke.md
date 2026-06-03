# プラン変更 in-place 化 — behavior-only smoke 手順 (OT 実行)

- **日付**: 2026-06-02
- **目的**: T3/T4/T5 (決済 touch) の `[reviewed]` amend 前に、コードが Stripe に送る**正確な params** を OT が test mode で再現し、Stripe 実挙動を確認する。
- **対象 commit**: T3 `ab1a7d4` / T4 `f1b99ec` / T5 `e452db4` (いずれも tag 無し)。
- **params の出典**: `lib/stripe/subscription.ts` (T3 実装)。

> 注: これは UI 前の behavior-only smoke。我々の action 自体は UI(T6/7) 未実装のため、ここでは action が組み立てる API call を OT が Stripe CLI/dashboard で手動再現する。挙動が想定どおりなら amend → UI 実装へ。

## ⚠️ 前提: 「DB 紐付き ⇄ test clock」 の両立不可 (smoke を 2 系統に分ける)

OT は **DB を Supabase ブラウザ / Stripe・Clerk をダッシュボード**で目視する。 ただし 1 つの subscription で「DB 列確認」と「時間前進」を**同時には満たせない**:

- **アプリ Checkout が作る customer** は Clerk 紐付き (= DB `users` 行あり) で DB 列を確認できるが、 **test clock 配下にできない** (時間を進められない)。
- **Stripe CLI で作る test clock customer** は時間を進められるが **Clerk 未紐付け (unlinked)** で、 対応する DB `users` 行が無く DB 列を確認できない。

よって本 smoke は目的別に **2 系統**で実施する (各手順の見出しにどちらかを明記):

- **(a) Stripe 挙動・時間前進が要る確認** → **CLI test clock sub** を使う。
  - 対象: Smoke 1 / 1b / 2 / 3、 および Smoke 5 の Stripe 側 (= 5-A)。
- **(b) DB 列の set/clear・webhook→DB 同期の確認** → **アプリ Checkout の DB 紐付き sub** を使う。
  - 対象: setup の `sub_id` 同期確認、 Smoke 4 (解約)、 Smoke 5 の DB 側 (= 5-B)。

> つまり「Stripe がどう動くか」は (a) で、「webhook を受けて DB がどう書き換わるか」は (b) で見る。 同一 sub で両方を見ようとしない。

## price ID (env、新 product)
- Standard 月 `price_1TdqksJX13jw2LsMg1JPQYoe`
- Standard 年 `price_1TdqoFJX13jw2LsMmSeJA643`
- Pro 月 `price_1Tdqp4JX13jw2LsMhP2LzJXb`
- Pro 年 `price_1TdqqIJX13jw2LsMvz4bMX1A`

## 0. setup — test subscription を作る (+ webhook sub id 同期の確認)

上記 2 系統に対応して **sub を 2 本**用意する。

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
**期待 (成功時, 4242)**: 即時に差額 proration invoice が作成・支払われ、`items[0].price` が Pro月に。`customer.subscription.updated` webhook → DB `plan='pro'`, `billing_interval='month'`。`pending_update` は付かない。

### 1b. 支払い失敗パス (旧 price 維持 + pending_update)
customer の default payment method を**失敗するテストカード**にして同じ update を実行 (例: `4000 0000 0000 0341` = attach 成功・charge 失敗、または Stripe Testing docs の decline card)。
**期待**: invoice の支払いが失敗 → subscription は**更新されず旧 price (Standard月) を維持** + `sub.pending_update` がセット。DB `plan` は **standard のまま変化なし**。`invoice.payment_failed` webhook が飛び、DB 不変 + Discord (`notifyOps`) 通知が出る (T4)。

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
**期待**:
- step2 時点で**即時請求 / proration が発生しない** (現 phase は現 price 維持)。
- `sub.schedule` に `sched_XXX` が付く (= getPendingState の scheduleId、以後 in-place 変更ブロック対象)。
- **test clock を phases[0].end_date 以降に前進** → phase1 が有効化、price が Standard月 へ proration なしで切替。`customer.subscription.updated` webhook → DB `plan='standard'`。
- **billing anchor / 次回請求日が切替後も変わらない**こと (start/end を明示指定したことで anchor がずれていないか = 重点確認項目)。

## 3. cancelScheduledDowngrade — 予約取消 (release) 〔系統 (a) test clock sub〕
> Smoke 2 で schedule がある状態 (test clock 前進前) で実行。
コードが送る call (`cancelScheduledDowngrade`):
```
stripe subscription_schedules release sched_XXX
```
**期待**: schedule が release され、subscription は**現 price (Pro月) のまま継続**。ダウングレードは起きない。`sub.schedule` が null に戻る。**price / billing anchor が release 後も不変**であること (重点確認項目)。

## 4. webhook sub id クリア (解約) 〔系統 (b) DB 紐付き sub〕
Customer Portal から解約 → 期末 or 即時で `customer.subscription.deleted` 発火。
**期待 (T4)**: DB `users.stripe_subscription_id` が `null` に、`plan='free'`, `subscription_status='canceled'`, `billing_interval=null`, `cancel_at=null`。`current_period_end` は履歴として残る。

## 方針C 追加 (T12 実装後に実施する auto-release smoke)
Smoke 1-4 は基盤挙動 (即時 upgrade / schedule 作成 / 手動 release=予約取消 / sub id 同期) を検証する。**方針C の「発効後 自動 release」** は webhook gate (spec §6.4) を要するため、T10-T12 実装後に別途 smoke する。

Smoke 5 は「DB 紐付き ⇄ test clock 両立不可」のため **5-A (Stripe 挙動・時間前進) と 5-B (DB 列 set/clear) に分割**する。

### Smoke 5-A — 自動 release の Stripe 挙動 + 発効前ブロック 〔系統 (a) test clock sub〕
test clock sub で「発効前は release されない / 発効後にのみ release される」を**2 ステップに分けて**確認する。 DB 列は unlinked のため見ない (5-B で見る)。

1. **予約**: Smoke 2 と同手順で schedule を張る (`sched_XXX` 取得、 `sub.schedule` に付与)。
2. **発効前 release されないこと (clock 前進前)**: この時点でもし `customer.subscription.updated` 等の webhook が来ても、 gate #4 (`current_phase.start_date <= now`) 未充足のため app は **release を発火しない**。 Stripe dashboard で `sub.schedule` が `sched_XXX` のまま (= 残っている) ことを確認。
3. **発効後 release されること (clock 前進後)**: test clock を **`phases[0].end_date` 以降へ前進** → phase1 有効化 → `customer.subscription.updated` 受信 → gate #1/#2/#4/#5 充足で app が `subscriptionSchedules.release` を発火 → **`sub.schedule` が null**。 Stripe dashboard で schedule の **status=released** を目視。
4. 確認点: 前進前は release されず (step2)、 前進後にのみ release される (step3) こと。 `subscription_schedule.released` の二重 webhook で副作用がないこと。

### Smoke 5-B — DB 3 列の set/clear 〔系統 (b) DB 紐付き sub〕
DB 紐付き sub (test clock 無し) で、 予約 → DB set、 取消 → DB clear を確認する。 切替発火 (時間前進) は見ない。

1. **予約 (set)**: プラン変更 UI でダウングレードを予約 → Supabase で `users` の **`scheduled_downgrade_schedule_id` / `scheduled_target_price_id` / `scheduled_change_effective_at` の 3 列が set** されること。
2. **取消 (clear)**: 取消 banner から取消 → `subscriptionSchedules.release` → **3 列が clear (null)** されること。
3. 註: 切替発効後の「3 列の自動 clear」は test clock が要るためここでは見ない。 これは **5-A の Stripe release 挙動 + `subscription_schedule.released` webhook の冪等 clear テスト**で担保する (発効 → released webhook → 3 列 clear の経路は同一ハンドラ)。

## UI smoke (T6-T8 実装後に実施、Smoke 1-5 と並行可)
backend smoke と別に、UI フロー (paid 在籍状態で DevTools mobile view) を確認する。実装詳細: `docs/superpowers/sessions/2026-06-03-in-place-plan-change-impl-T11-T12-T6-T8.md`。

- **U1 (entry 統一)**: paid user の `/app/settings` に「プラン変更」+「お支払い・解約を管理」2 ボタン / `/app` 下部 CTA が全 plan (pro+year 含む) で「プラン変更」表示。free は「プランを選択」のまま。
- **U2 (card 選択可否)**: `/app/upgrade` で現プランのみ disable「現在のプラン」、下位プランも選択可 (旧「現在より下位プラン」disable が消滅)。pro+year でも redirect されず page 表示。
- **U3 (確認 modal)**: paid で上位/下位 card の CTA → 金額なし確認 modal。upgrade=「今すぐ差額が請求され…」/ downgrade=「現在の請求期間終了後に {plan} へ切り替わります…」。Esc / backdrop / キャンセルで閉、確認で changePlan 発火 → `/app?billing=upgrade|downgrade`。**mobile で modal が画面内に収まり tap 可能か**。
- **U4 (予約中ブロック + 取消 banner)**: ダウングレード予約中 (DB `scheduled_downgrade_schedule_id` set) は全変更 CTA disable + 案内文、page 上部に短縮版 banner「**{tier} {interval}へ変更予約中（{date}）— 取消**」(例:「Standard 月額へ変更予約中（2026/7/1）— 取消」)。取消 → cancelDowngrade → 3 列 clear → 再操作可。日付が `Intl ja-JP` 整形。(T8-copy `234175a` で冗長版「Standard プラン 月額 への…」から短縮済)
- **U5 (success banner)**: `/app?billing=new|upgrade|downgrade` 着地で対応文言 banner 表示・dismiss 可。Checkout success_url が `?billing=new` に。
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
重点 NG 条件: Smoke 2/3/5-A で billing anchor がずれる、Smoke 1b で旧 price が維持されない、Smoke 5-A で発効前に release される (clock 前進前に schedule が消える)、Smoke 5-B で 3 列が set/clear されない、のいずれかが出たら設計見直し (該当箇所の実装前に停止)。
