# 既存契約者プラン変更の in-place 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (既定) で task 単位に実装。各 task は fresh subagent + task 間 review。steps は checkbox 管理。

**Goal:** 有料契約者のプラン変更を Checkout でなく `subscriptions.update` / subscription schedule による in-place 変更にし、二重契約を構造的に消す。

**Architecture:** ドメインロジックを `lib/stripe/subscription.ts` に集約 (純粋判定 + Stripe 呼出)、server action が orchestrate、DB は webhook を最終正とする。新規 (free→有料) のみ Checkout 維持。

**Tech Stack:** Next.js 15 App Router / Drizzle / Stripe (subscriptions.update, subscription_schedules) / Vitest (Stripe 全 mock)。

**Spec:** `docs/superpowers/specs/2026-06-02-in-place-plan-change-design.md` (以下 §N は本 spec を指す)。

---

## 全体ルール (各 task 共通、冒頭一度のみ)

- **絶対ルール**: Stripe webhook 署名検証・`stripe_events` 冪等・エラー時 200 返却を維持 (CLAUDE.md §Stripe)。全 query は `user_id`/`clerk_id` scope。AI 関連は本 sprint 無関係。
- **TDD**: test 先行 (Vitest)。**Stripe は全 mock、実 API 禁止**。webhook は `stripe.webhooks.generateTestHeaderString` で署名 test。
- **完了条件 (全 feat/fix task 共通の末尾)**: 該当 test 通過 + `pnpm build`/`tsc` 通過 + code-reviewer Critical 0 + `[reviewed]` tag。review は `superpowers:requesting-code-review` canonical 経路 (general-purpose subagent、template 改変なし)。
- **決済 touch task (T3/T4/T5)** は CLAUDE.md「重要 Fix 裏取り」対象: review pass → tag 無し commit → **OT 実機確認** → `git commit --amend` で `[reviewed]` 追記。Claude Code 単独で `[reviewed]` を付けない。
- **UI task (T6/T7/T8)** は DevTools (chrome-devtools/playwright) で render/操作を検証し証拠を report に含める。実 Stripe 走行 smoke は課金 API のため OT 依頼。
- 命名: file kebab-case / Component PascalCase / 関数 camelCase。import 順 外部→内部→相対。

---

## Task 1: schema — stripeSubscriptionId 列追加

**Files:** Modify `lib/db/schema.ts` (users) / Create drizzle migration。

- **目的**: §3。in-place 変更の subscription 識別足場。`users.stripeSubscriptionId text` (nullable, unique) を追加。
- **制約**: 既存課金 6 カラム不変。drizzle-kit で migration 生成 (手書き SQL 禁止)。実装ロジック変更なし。
- **完了条件**: migration 生成・適用 (`pnpm db:*` 既存手順)、`pnpm build` 通過、既存 webhook test green。schema/chore のみ → `chore(db)` `[no-review]` 可 (migration 適用は確認必須)。

---

## Task 2: ドメイン純粋部 — classify / pending 判定 / error 型

**Files:** Create `lib/stripe/subscription.ts` (純粋部のみ) / Test `lib/stripe/subscription.test.ts`。

- **目的**: §4.2 `classifyChange(currentRank, targetRank)` → `'upgrade'|'downgrade'|'same'`、§4.3 `getPendingState(sub)` → `{hasPendingUpdate, scheduleId, cancelScheduled}`、error 型 `NoSubscriptionError` / `AmbiguousSubscriptionError`。
- **制約**: `classifyChange` は `lib/plan-catalog.ts` の `rankPlan` を**再利用** (rank の再実装禁止、DRY)。`getPendingState` は `sub.pending_update` / `sub.schedule` / (`sub.cancel_at` \|\| `sub.cancel_at_period_end`) を読む純関数 (Stripe 呼出なし)。
- **完了条件**: Vitest — rank 全遷移 (up/down/same、月↔年、tier 跨ぎ)、pending/schedule/cancel の各組合せ。+ 全体ルール完了条件。`[reviewed]`。

---

## Task 3: ドメイン Stripe 部 — resolve / upgrade / downgrade / 取消

**Files:** Modify `lib/stripe/subscription.ts` / Modify `lib/stripe/subscription.test.ts`。

- **目的**: §4.1 `resolveActiveSubscription(user)`、§4.4 `applyUpgrade` / `scheduleDowngrade` / `cancelScheduledDowngrade`。
- **制約**:
  - `resolveActiveSubscription`: id 有→`subscriptions.retrieve` で status active 系 (active/trialing/past_due) かつ customer 一致を検証、`{sub, itemId}` 返す。id 無→`subscriptions.list({customer, status:'active'})` で 1 本のみ採用、0→`NoSubscriptionError`、複数/不一致→`AmbiguousSubscriptionError`。自動で 1 本選ばない。
  - `applyUpgrade`: `proration_behavior:'always_invoice'` + `payment_behavior:'pending_if_incomplete'`、idempotency key は**引数受領** (operationId は呼出側生成、§5.4)。
  - `scheduleDowngrade`: `from_subscription`→schedule 化→現 phase(現 price, end=current_period_end)+次 phase(targetPrice, `proration_behavior:'none'`)、`end_behavior:'release'`。
  - `cancelScheduledDowngrade`: `subscriptionSchedules.release` (`cancel` は subscription 自体を消すため禁止)。
- **完了条件**: Vitest (Stripe SDK mock) — resolve 0/1/複数/不一致、applyUpgrade のパラメータ、scheduleDowngrade の 2 phase + release、取消の release 呼出。実 API 禁止。**決済 touch → 裏取り経路**。`[reviewed]` は OT 実機後 amend。

---

## Task 4: webhook 拡張 — sub id populate/clear + payment_failed + 正規化

**Files:** Modify `app/api/webhooks/stripe/route.ts` / Modify `app/api/webhooks/stripe/route.test.ts` (既存 test に追加)。

- **目的**: §6。subscription id の同期、`invoice.payment_failed` 追加、現在プラン正規化の不変条件。
- **制約**:
  - `customer.subscription.created`/`.updated`: 既存同期に `stripeSubscriptionId = sub.id` populate を追加。`.deleted`: 既存 reset に `stripeSubscriptionId = null` を追加。
  - `invoice.payment_failed` (新規 case): **DB plan を変更しない** + `notifyOps`。
  - **現在プランは actual subscription item の current price から正規化** (`sub.items.data[0].price.id`)。`pending_update` 内 target price を現在プランに昇格しない。`past_due`→plan 維持 (grace) と非矛盾 (調査 §4 `resolvePlanFromSub`)。
  - `stripe_events` 冪等・エラー時 200 維持。
- **完了条件**: Vitest — populate/clear、payment_failed で plan 不変、pending_update target 非昇格、冪等 (重複 event skip)。**決済 touch → 裏取り経路**。`[reviewed]` は OT 実機後 amend。

---

## Task 5: server action — changePlan / cancelDowngrade

**Files:** Modify `app/(app)/app/upgrade/actions.ts` / Test `app/(app)/app/upgrade/actions.test.ts`。

- **目的**: §5。`changePlan(formData)` と `cancelDowngrade()` を追加。`createCheckoutSession` (free 用) は維持。
- **制約**:
  - `changePlan`: `getCurrentUser` (user_id scope) → `resolveActiveSubscription` → §5.5 ブロック判定 (`hasPendingUpdate` \|\| `scheduleId` \|\| `cancelScheduled` なら非実行で案内) → `classifyChange` → upgrade:`applyUpgrade` / downgrade:`scheduleDowngrade` → `/app?billing=<upgrade|downgrade>` redirect。
  - operationId は hidden input (client 生成 UUID) を受領、idempotency key = `changePlan:{userId}:{operationId}` (§5.4、deterministic key 禁止)。
  - `Ambiguous/NoSubscriptionError` は catch → `notifyOps` + 汎用エラー (自動選択しない)。
  - `cancelDowngrade`: `resolveActiveSubscription`→`cancelScheduledDowngrade`→`/app` redirect。
- **完了条件**: Vitest (Stripe/db mock) — up/down 分岐、ブロック時非実行、operationId が key に反映、error→notifyOps、`createCheckoutSession` 回帰なし。**決済 touch → 裏取り経路**。`[reviewed]` は OT 実機後 amend。

---

## Task 6: プラン変更 page + カード選択可否

**Files:** Modify `app/(app)/app/upgrade/page.tsx` / Modify `app/(app)/app/upgrade/upgrade-plans.tsx` / Test 併設。

- **目的**: §7.1。pro+year redirect 撤廃、paid の sub 状態取得、カード選択可否の刷新。
- **制約**:
  - `page.tsx`: `user.plan==='pro' && billingInterval==='year'` の `/app` redirect を**撤廃**。paid は `resolveActiveSubscription`+`getPendingState` を server で呼び、pending/予約/解約予約 state を client に渡す。free はサブスク無 → Checkout 経路。
  - `upgrade-plans.tsx`: 全プラン (Standard/Pro×月年 toggle、Pro 年額含む) 表示、**Free カード追加なし**。**現プランのみ disable** (rank 同値、interval NULL は month 同 rank 現行踏襲)。`targetRank<userRank → disabled` 分岐を**撤廃** (下位も選択可)。free→`createCheckoutSession`、paid→確認 modal→`changePlan`。pending/予約/解約予約中は全 CTA disable + 案内文 (§5.5)。**ダウングレード予約の判定は DB 列 `scheduledDowngradeScheduleId`** (方針C)、pending/cancel は `getPendingState`。label「プラン変更」。
- **完了条件**: render test — 現プラン disable、下位選択可、free は checkout form、paid は modal trigger、pending 時 全 disable。UI → DevTools 検証。+ 全体ルール完了条件。`[reviewed]`。

---

## Task 7: 確認 modal + ダウングレード予約取消 banner

**Files:** Create `components/ui/confirm-dialog.tsx` (軽量 custom modal) / Modify `app/(app)/app/upgrade/upgrade-plans.tsx` (組込) / Test 併設。

- **目的**: §7.2 / §5.5。
- **制約**:
  - `components/ui/` に dialog 無 → 軽量 custom modal を新規 (`window.confirm` 不可、世界観統一・テンプレ AI デザイン回避)。upgrade/downgrade 双方で**金額なし確認** (文言は §5.2「今すぐ差額が請求され…」/§5.3「現在の請求期間終了後に {plan} へ切り替わります…」)。confirm 時に operationId (UUID) を生成し form に載せる。
  - 予約中: page 上部に「{plan} へのダウングレード予約中 ({date}) — 取消」→ `cancelDowngrade`。日付は **`user.scheduledChangeEffectiveAt`** を `Intl.DateTimeFormat('ja-JP')` で整形 (settings の `formatCancelDate` と整合)。予約有無判定は **`user.scheduledDowngradeScheduleId != null`** (方針C, §5.5)。
- **完了条件**: render test — modal open/confirm/cancel、banner 表示・取消 submit、focus/Esc の最低限 a11y。UI → DevTools 検証。+ 全体ルール完了条件。`[reviewed]`。

---

## Task 8: entry point 統一 + /app 成功 banner

**Files:** Modify `app/(app)/app/settings/page.tsx` / Modify `app/(app)/app/page.tsx` / Create `app/(app)/app/_components/billing-banner.tsx` / Modify `app/(app)/app/upgrade/actions.ts` (success_url) / Test 併設。

- **目的**: §7.3 / §7.4 / §7.5 / R1。
- **制約**:
  - settings: paid は「プラン変更」(/app/upgrade) + 「お支払い・解約を管理」(従来 Portal) の 2 ボタン、free は「プランを選択」維持。
  - `/app` ほかの「アップグレード」CTA を全 plan「プラン変更」化 (pro+year 除外撤廃)。
  - `/app` に `?billing=<kind>` を読む client banner 新規。文言: `new`=「決済を受け付けました。反映まで少し時間がかかる場合があります。」/ `upgrade`=「支払い確認後にプランが反映されます。」/ `downgrade`=「現在の請求期間終了後にプランが変更されます。」/ `cancel`=「現在の請求期間終了後に Free へ戻ります。」。
  - `createCheckoutSession` の `success_url` を `?checkout=success`→`?billing=new` に統合 (R1)。
- **完了条件**: render test — banner kind 別文言、settings ボタン出し分け、CTA label。UI → DevTools 検証。+ 全体ルール完了条件。`[reviewed]`。

---

## 方針C 追補タスク (T9–T12) — ダウングレード schedule の発効後 release

> 背景: spec §3.1 / §6.4 / R5。2 phase open-ended schedule は自動終了せず `sub.schedule` が永続するため、切替発効後に webhook gate で能動 release し、ブロックは DB 列で管理する。T3/T4/T5 は実装済 (tag 無し) で、本追補が乗る。**T3/T4/T5 の `[reviewed]` amend は、T9–T12 完了 + 方針C 込みの combined OT smoke 通過後**にまとめて行う (発効後 release まで揃って初めてダウングレードが完結するため)。

### Task 9: schema — ダウングレード予約トラッキング 3 列 (OT-gated migrate)

**Files:** Modify `lib/db/schema.ts` (users) / Create drizzle migration (0017)。

- **目的**: §3。`scheduledDowngradeScheduleId text` / `scheduledTargetPriceId text` / `scheduledChangeEffectiveAt timestamptz` を追加 (全て nullable)。
- **制約**: `pnpm db:generate` のみ (列追加 + 副作用なしを目視)。**`db:migrate` は実行しない** (OT が stg→prod 手動、[[db-migrate-ot-gated]] と同段取り)。既存列不変。
- **完了条件**: migration 生成、`pnpm build` 通過、既存 test green。`chore(db)` `[no-review]` 可。**この task 後に停止し OT migrate を待つ** (T1 と同じ)。

### Task 10: domain — scheduleDowngrade metadata + releaseCompletedDowngrade

**Files:** Modify `lib/stripe/subscription.ts` / Modify `lib/stripe/subscription.test.ts`。

- **目的**: §4.4。`scheduleDowngrade` の `update` 呼出に `metadata:{ kind:'recallmint_downgrade', userId, targetPriceId, operationId }` を付与 (引数に userId/operationId 追加)。`releaseCompletedDowngrade(scheduleId, idempotencyKey)` を追加。
- **制約**: metadata は gate 必須条件にしない (デバッグ用)。`from_subscription` の create には metadata を付けない (update 側のみ)。
  - **`releaseCompletedDowngrade` の冪等主判定は status gate** (message regex ではない): release 前に `subscriptionSchedules.retrieve` し `status` で分岐 — `active`→current_phase null guard 通過後 release (戻り `'released'`) / `completed`/`released`/`canceled`→release せず no-op (`'already_terminal'`) / `not_started`→切替前なので release せず skip (`'skipped'`) / `active` かつ current_phase null→notifyOps + skip (`'skipped'`)。戻り値は `'released' | 'already_terminal' | 'skipped'`。
  - idempotencyKey `autorelease:{scheduleId}` は短期 retry 用。message regex (already released/completed) + `resource_missing` は retrieve〜release race の**保険のみ** (コメント明記)。無関係 error は rethrow。位置づけ (主=status gate / retry=key / 保険=regex) をコメント。
  - Stripe 全 mock。
- **完了条件**: Vitest — metadata が update に乗る / status 各値で release 呼出有無と戻り値が正しい (active→released・terminal3種→already_terminal・not_started→skipped・active+current_phase null→skipped+notifyOps) / 保険: retrieve 後 release が resource_missing/already released を投げても resolve / 無関係 error は rethrow。**決済 touch → 裏取り経路** (tag 無し commit)。

### Task 11: action — 3 列 set/clear + DB 列ブロック

**Files:** Modify `app/(app)/app/upgrade/actions.ts` / Modify `app/(app)/app/upgrade/actions.test.ts`。

- **目的**: §5.3 / §5.5。`changePlan` downgrade 経路で `scheduleDowngrade` 成功後、戻り schedule から `scheduledDowngradeScheduleId`=schedule.id / `scheduledTargetPriceId`=targetPriceId / `scheduledChangeEffectiveAt`=`phases[0].end_date` を `users` に set (user スコープ update)。ブロック判定を `user.scheduledDowngradeScheduleId != null`(DB 列) + `getPendingState` の hasPendingUpdate/cancelScheduled に変更。`cancelDowngrade` は `cancelScheduledDowngrade` 成功後 3 列 clear。
- **制約**: ブロックは DB 列が主 (`sub.schedule != null` 単独不可)。user スコープ。Stripe/db mock。
- **完了条件**: Vitest — downgrade で 3 列 set / scheduleId 残存でブロック / cancelDowngrade で clear。**決済 touch → 裏取り経路** (tag 無し)。

### Task 12: webhook — release gate + subscription_schedule.released

**Files:** Modify `app/api/webhooks/stripe/route.ts` / Modify `app/api/webhooks/stripe/route.test.ts`。

- **目的**: §6.4。`customer.subscription.updated` で plan 同期後、`user.scheduledDowngradeScheduleId` set 時のみ評価。**webhook 側 gate = #1 + #5**: #1 `sub.schedule`(id)===DB `scheduledDowngradeScheduleId` / #5 `sub.items[0].price.id`===`scheduledTargetPriceId`。両充足で `releaseCompletedDowngrade(scheduleId, 'autorelease:'+scheduleId)` に委譲 (status/#2/#3/#4 は同関数=T10 が担当)。**戻り値で clear 分岐**: `'released'`/`'already_terminal'`→3 列 clear / `'skipped'`→clear しない。`sub.schedule`=null は no-op (clear は released handler 担当)、別 non-null id は notifyOps。`subscription_schedule.released` handler 新規: schedule.id で対象 user を引き 3 列を冪等 clear。`customer.subscription.deleted` の reset に 3 列 clear 追加。
- **制約**: 既存枠組み (署名/`stripe_events` 冪等/200) 不変。pending_update target を現在プランに昇格しない (§6.1) を維持。Stripe 全 mock。
- **完了条件**: Vitest — #1+#5 充足→delegate / #5 未反映で delegate せず / delegate 結果 released・already_terminal で clear、skipped で clear しない / `sub.schedule` null で no-op・別 id で notifyOps / `subscription_schedule.released` で 3 列冪等 clear / **release 成功+clear 失敗を `.released` が回収 (§6.4.1)** / `.released` 先着→後着 `.updated` no-op / deleted で clear / 冪等。**決済 touch → 裏取り経路** (tag 無し)。

---

## Self-Review (spec 照合)

- 全 spec §を task に割当済: §3→T1+**T9** / §3.1→**T9-T12** / §4.1→T3 / §4.2-4.3→T2 / §4.4→T3+**T10** / §5→T5(logic)+T6/T7(UI)+**T11** / §6→T4 / §6.4→**T12** / §7.1→T6 / §7.2→T7 / §7.3-7.5→T8 / §8 error→T3/T5 / §9 test→各 task / §10 env 変更なし / §11 R1→T8・R2→T7・R3→T6・R4→T5・**R5→T9-T12**。
- placeholder なし。型整合: `resolveActiveSubscription`/`classifyChange`/`getPendingState`/`applyUpgrade`/`scheduleDowngrade`/`cancelScheduledDowngrade`/**`releaseCompletedDowngrade`** の名称を一貫使用。`scheduleDowngrade` は metadata 用に userId/operationId 引数追加 (T10、呼出側 T11 と整合)。
- 決済 touch (T3/T4/T5/**T10/T11/T12**) は裏取り経路を完了条件に明記。**T3/T4/T5 の `[reviewed]` amend は T9-T12 完了 + combined smoke 後**にまとめて実施。
- 依存順: T9 (schema, OT migrate gate) → T10 (domain) → T11 (action)・T12 (webhook) → UI (T6/T7 は scheduledChangeEffectiveAt / DB 列ブロックを使用)。
