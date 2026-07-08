# 完全 DDD F1(Subscription aggregate)fact-finding

- 日付: 2026-07-08 / branch `develop` / HEAD **`e476ea9`**(Group A invariant fixes A-1〜A-4 反映済)
- scope: **read-only 調査のみ**(impl / spec / schema 変更なし)。F1 spec 起草の入力。
- 方法: 並列 general-purpose 3 体(write paths+整合窓 / state schema+sync / invariants+tests)+ controller が critical fact(列型3点セット・A-3 detection code・A-3 reject test)を first-hand spot-verify。file:line は **HEAD `e476ea9` 時点**(意図 doc `2026-07-08-full-ddd-intent-and-factfinding.md` の file:line は Group A 前 `7c90246` = stale、本 doc が最新)。
- 判断は claude.ai + OT に返す(本 doc は事実整理・所感まで)。

---

## Step 0: 既存骨子 doc の粒度

意図 doc `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` を読了。

**F0〜F5 の定義(§5「フェーズ骨子」)**
| F | 内容 | 種別 |
|---|---|---|
| **F0** | brainstorming → spec。D-1/N-5 解除範囲・bounded context・§4 発見 4 件の裏取り/fix 先行判断を OT 確定 | **設計判断 phase** |
| **F1** | Subscription aggregate + VO(Plan/Rank/Status)+ state machine 化(server-only・二重実装なし・最高リターン) | 実装 |
| F2 | Session aggregate(ingest-review-events からの持ち替え)+ status 遷移ガード | 実装 |
| F3 | server 側 invariant 強化(発見 #1/#3・**挙動変更含む**・凍結契約 D-2 と要整理) | 実装 |
| F4 | Card/Tag aggregate + 共有 invariant module(client/server 単一定義化) | 実装 |
| F5(任意) | domain event 明示 / Exam↔SourceDocument 境界 / モノレポ package 化 | 実装 |

- **F0 ≠ pragmatic DDD の P0 相当の安全網 phase**。P0 は contract/golden baseline(golden 77)を作る安全網だったが、**完全 DDD の F0 は brainstorming→spec の設計判断 phase**。両者は別物。
- **F1 記述の粒度 = 棚卸し + skeleton どまり(spec-ready でない)**。§3 は invariant「数(9)」と分散度・file:line(stale)、§5 は VO 候補と一行 phase 記述のみ。**9 invariant の列挙定義 / state machine 遷移表 / VO の値集合・検証規則 / 列型3点セット は未記載**。→ Step 1 以降を続行(本 doc で補完)。

---

## Step 1: subscription 書込経路 全棚卸し

subscription state を持つのは **単一 table `users`**(後述 Step 3)。書込経路は **action / webhook / deletion cascade** の3系統。

### (a) action path(user 起点)— `app/(app)/app/upgrade/actions.ts`, `app/(app)/app/settings/actions.ts`

| # | path | Stripe call | DB 書込列 | owner-scope |
|---|---|---|---|---|
| A1 | `createCheckoutSession` :26-70 | `checkout.sessions.create` :50 | **なし**(state は webhook `checkout.session.completed` 経由) | `getCurrentUser()` |
| A2 | `changePlan` **upgrade 枝** :130-132 | `applyUpgrade` :131 | **なし**(plan/status は `customer.subscription.updated` webhook 待ち)→ `redirect` :132 | `getCurrentUser()` + resolve owner-check |
| A3 | `changePlan` **downgrade 枝** :133-171 | `scheduleDowngrade` :134 | **予約3列**(`scheduledDowngradeScheduleId`/`scheduledTargetPriceId`/`scheduledChangeEffectiveAt`)を set :143-147 | `WHERE users.id = user.id` :147 |
| A4 | `cancelDowngrade` :176-228 | `cancelScheduledDowngrade` :196 | **予約3列を null clear** :201-205 | `WHERE users.id = user.id` :205 |
| A5 | `createBillingPortalSession`(settings/actions.ts:7-24) | `billingPortal.sessions.create` :19 | **なし**(portal 変更は webhook で戻る) | `getCurrentUser()` + requires `stripeCustomerId` |

★**action 層が DB に書く subscription state は「予約3列」だけ**(A3 set / A4 clear)。plan/status/interval/period は action からは一切書かれない。

### (b) webhook handler — `lib/stripe/handle-stripe-event.ts`(idempotency = `stripe_events` INSERT ON CONFLICT・route.ts:37-45)

| event | 位置 | DB 書込列 | release gate |
|---|---|---|---|
| `checkout.session.completed` | handleEvent :125-180 | Step1 `stripeCustomerId`(WHERE clerkId)/ Step2 `plan,billingInterval,subscriptionStatus,currentPeriodEnd,cancelAt,stripeSubscriptionId`(WHERE clerkId)+ RETURNING clerkId→Clerk sync | なし |
| `customer.subscription.created`/`.updated` | :181-250 | 同 6 列(WHERE **stripeCustomerId**)+ RETURNING clerkId & 予約2列。**予約3列は SET しない**(:193-194) | `.updated` かつ行 match 時のみ `evaluateReleaseGate` :226-234 |
| `customer.subscription.deleted` | :251-294 | `plan='free',billingInterval=null,subscriptionStatus='canceled',cancelAt=null,stripeSubscriptionId=null` + **予約3列 clear** :266-268(WHERE stripeCustomerId)。`currentPeriodEnd` は意図的に非更新 :255 | n/a |
| `subscription_schedule.released` | :308-322 | **予約3列 clear**(WHERE `scheduledDowngradeScheduleId=schedule.id`)= 取りこぼし recovery | release path |
| `invoice.payment_failed` | :295-307 | **なし**(notifyOps のみ・plan/status 不変) | なし |

`evaluateReleaseGate` :334-403 も 2 sub-path(:359-366 Stripe 既 release・:393-402 releaseCompletedDowngrade 完了後)で予約3列を clear(WHERE stripeCustomerId)。

### (c) deletion cascade — `lib/clerk/handle-clerk-event.ts` `handleUserDeleted` :69-203

- Stripe cancel step :100-139: `subscriptions.list({customer,status:'all'})` → `CANCEL_TARGETS`(active/trialing/past_due)を `cancelWithRetry`。**tx 外**、失敗は `recordFailure` で rethrow せず。
- DB scrub step :175-202(tx): `users` soft-delete + PII scrub `{deletedAt,email:null,clerkId:null}` + 子 10 table cascade delete。**plan / subscriptionStatus / 予約列は reset しない**。`stripeCustomerId` は correlation key として**意図的に保持** :164-166。
- ★退会は subscription state を null にしない → scrub 行(row 有・clerkId null)が残り、Stripe 自己誘発 `.deleted`/`.updated` を A-4 が無害 skip(:216-248, :277-293)。

### action / webhook 対称・非対称(★核心)

| 列クラス | 書き手 | source of truth | conflict |
|---|---|---|---|
| **plan/billing 6 列**(plan,billingInterval,subscriptionStatus,currentPeriodEnd,cancelAt,stripeSubscriptionId) | **webhook 専属**(action は 1 列も書かない) | **Stripe**(webhook が射影) | Stripe 後勝ち(:143 コメント) |
| **予約3列** | **action と webhook の両方** | gating 判定=**DB 列**(:106-108 コメント)/ clear=Stripe 駆動 | mismatch(`subScheduleId≠dbScheduleId`)時 gate は書かず alarm :371-381・OT 介入 |
| `stripeCustomerId` | webhook 専属(checkout Step1) | Stripe | — |

→ **上流の「変更」は action、下流の「確定/射影/recovery」は webhook** という非対称。A-3 detection(Step 2)がこの非対称のどこに効くかが要点。

---

## Step 2: ④整合窓 + A-3 detection

### 整合窓(Stripe 成功後 DB 不整合が構造的に開く窓)

| 窓 | 位置 | 内容 | A-3 検知 |
|---|---|---|---|
| **W-A2(upgrade・最広・未検知)** | actions.ts:130-132 | upgrade は `applyUpgrade`(Stripe)後 **DB 書込ゼロ**→`redirect`。webhook 射影が遅延/欠落すると Stripe=新価格 / DB=旧 plan が無限に残る。action 側検知なし | **なし**(書く列が無く wrap 対象が無い) |
| W-A3(downgrade reserve) | actions.ts:143-147 | schedule 作成成功後 DB 予約 set 失敗→gate が発火できない | **A-3 で検知** |
| W-A4(cancel-downgrade) | actions.ts:201-205 | release 成功後 DB clear 失敗→幻の予約が残る(gate/`.released` で最終 reconcile) | **A-3 で検知** |
| W-DEL(deletion) | handle-clerk-event.ts:113 | Stripe cancel 後 scrub 失敗 | deletion-failure 監査証跡で別途 cover(`recordFailure`) |
| (webhook 内) checkout Step2 `subscriptions.retrieve` throw | handle-stripe-event.ts:152 | retrieve 失敗→degraded recovery(後続 `.created/.updated`) | A-3 対象外(別窓) |

### A-3 detection(commit `c5075e0`)= 検知のみ・挙動不変(first-hand 確認済)

- **downgrade**(actions.ts:142-169)/ **cancelDowngrade**(:200-226):`db.update` のみ try/catch → 内側 best-effort `try{notifyOps(...)}catch{}` → `throw err`(元 DB error 優先 rethrow)。
- **挙動不変の根拠**: ① `redirect()` は try の**外**(:170 / :227)= 成功 path 不変 ② 元 DB error を rethrow = user 向け error 不変 ③ notifyOps を内側 catch で囲む = prod で `OPS_DISCORD_WEBHOOK_URL` 未設定時の fail-fast throw(`lib/ops.ts:31`)が root cause DB error を隠蔽しない。
- ★**A-3 は action path 専属**。検知するのは**予約列書込の 2 窓(W-A3/W-A4)のみ**。
  - **W-A2(真の upgrade 整合窓)は A-3 対象外**(書く列が無い)。
  - **webhook path に A-3 形の検知は無い**が、webhook の DB 失敗は route の外側 catch(:48-63)→ `notifyWebhookError` → **200 返却**(CLAUDE.md Stripe 則「エラー時も 200」・resend loop 防止)で**別機構で観測**される。→ 検知は両側に在るが**形が非対称**(action=inline per-write notify+rethrow / webhook=route-level swallow-to-200・user 面なし・Stripe retry なし)。

---

## Step 3: 状態表現の実態(列型3点セット・first-hand 確認)

subscription/billing state は **単一 table `users`**(`lib/db/schema.ts:74-134`)。`cancel_at_period_end` 列は**廃止済**(grep 0 hit・`cancelAt != null` で判定)。

| # | `table.column : drizzle 型(SQL)` | schema.ts |
|---|---|---|
| 1 | `users.clerkId : text unique` | :76 |
| 2 | `users.stripeCustomerId : text unique` | :78 |
| 3 | `users.stripeSubscriptionId : text unique`(1 user 1 active sub invariant) | :81 |
| 4 | `users.scheduledDowngradeScheduleId : text` | :87 |
| 5 | `users.scheduledTargetPriceId : text` | :88 |
| 6 | `users.scheduledChangeEffectiveAt : timestamptz`(UI 表示専用) | :89-91 |
| 7 | `users.plan : text $type<'free'\|'standard'\|'pro'> notNull default 'free'` | :92-95 |
| 8 | `users.subscriptionStatus : text $type<'active'\|'past_due'\|'canceled'> nullable` | :107-109 |
| 9 | `users.currentPeriodEnd : timestamptz` | :110 |
| 10 | `users.cancelAt : timestamptz`(null=予約なし) | :112 |
| 11 | `users.billingInterval : text $type<'month'\|'year'> nullable` | :125 |

(補助: `id`,`email`,`createdAt`,`updatedAt`,`deletedAt`(soft-delete)。)

schema コメント自体が invariant を明文化: 1-user-1-active-sub(:79-81)/ 予約3列 方針C(:82-91)/ status 正規化 10→3(:96-98)/ `past_due` 二重 semantics(a grace / b free downgrade)(:100-105)/ billingInterval 不変条件(free⇒NULL, paid⇒month|year)(:118-124)。

### 予約変更 / 期末 downgrade / scheduled change の受け方(現状マップ)

- **予約は application code が作る**(webhook ではない): downgrade 経路 `scheduleDowngrade`(`subscription.ts:132-181`・`end_behavior:'release'` の subscription_schedule 作成)→ action A3 が予約3列を DB set。
- **webhook は clear/release のみ**: `.updated` release gate(#1 schedule id 一致 + #5 現 item price==target)/ `subscription_schedule.released`(recovery)/ `.deleted`。
- **期末 downgrade の発効** = schedule 完了を Stripe が `.updated`(schedule→null)で通知 → release gate が予約3列 clear + 新 plan 射影。

---

## Step 4: sync 伝搬 — **server-only(client mirror なし)**(first-hand 傍証済)

3 層すべてで subscription state は client に出ない:

1. **`/api/pull`**: `app/api/pull/route.ts:66-73` は 6 stream のみ(cards/exams/tombstones/tag_categories/tag_options/card_tags)。`users`/subscription delta なし。`lib/sync/pull.ts` `PullResponse` も同 6 stream。
2. **apply/mutation registry**: `lib/sync/server/entity-mutation-registry.ts` は `card`/`tag_category`/`tag_option` のみ。tombstone は `exam|card|tag_category|tag_option` のみ(users は soft-delete + PII scrub で tombstone 非対象)。
3. **Dexie stores**: `lib/client-db.ts`(v1-v7)= exams/cards/user_settings/study_sessions/answer_events/entity_mutations/sync_meta/study_days/tag_categories/tag_options/card_tags。**subscription/billing store なし**。`ClientUserSettings` は `session_limit`+`fsrs_mode` のみ(plan/status/stripe 列を持たない)。

**client が plan を知る唯一の経路** = webhook が `syncClerkPublicMetadata({clerkId,plan})`(`handle-stripe-event.ts:176,219,289` / `lib/auth/clerk-metadata.ts:36-50`)で **Clerk JWT publicMetadata.plan** に射影。**一方向 projection**(status/period/cancelAt/予約列/interval は DB のみ、client に出ない)。

→ **Subscription aggregate は純粋 server-side・local-first 同期面なし**。F1 は client repository / mirror / outbox の考慮が不要(N-5 の論点は F1 に非該当)= 完全 DDD の中で**最も blast radius が小さい**。

---

## Step 5: 現状の不変条件棚卸し(F1 aggregate 集約候補・16 件)

「explicit guard」=runtime check / 「implicit」=無検査で依存。

| ID | 不変条件 | enforce 位置 | 分散/種別 |
|---|---|---|---|
| I-1 | Stripe status(10値)→ 内部 3値 正規化(exhaustive+default) | `handle-stripe-event.ts:normalizeSubStatus:32-50` | 単一・explicit |
| I-2 | plan 導出の非対称(unpaid/incomplete=status past_due だが plan=free) | `resolvePlanFromSub:63-102`(:77 で原 status 再判定) | 単一・explicit(contract 凍結) |
| I-3 | 未知/欠落 price_id → notifyOps + free fallback・**throw しない**(resend loop 防止) | `resolvePlanFromSub:81-100` | 単一・explicit |
| I-4 | plan rank 全順序(free0<std/m1<std/y2<pro/m3<pro/y4) | `plan-catalog.ts:rankPlan:77-82`(consumer=classifyChange/isUpgrade) | 単一・explicit |
| I-5 | upgrade=即時 prorated / downgrade=期末 scheduled / same=reject | `actions.ts:changePlan:118-171`(applyUpgrade/scheduleDowngrade) | 単一・explicit |
| I-6 | 変更/pending/schedule/cancel 排他(**gating の source=DB 列**、Stripe schedule 単独ではブロックしない) | `actions.ts:changePlan:109-116` | 単一・explicit・★設計核心 |
| I-7 | cancel 単一 source(`cancelAt`)・`cancel_at_period_end` 列廃止 | `subscription-changes.ts:getPendingState:42` / `handle-stripe-event.ts:117-118` | 単一・**signal drift 注意**(下記) |
| I-8 | release gate 多層防御(予約 clear は正確に1回・冪等) | 4-5 層: `evaluateReleaseGate:334-403` / `releaseCompletedDowngrade:254-289` / `releaseScheduleIdempotent:198-208` / `.released` handler:308-322 | ★**最重複**・集約最有力 |
| I-9 | 予約3列の atomicity(set-together / clear-together) | **6 site**: actions.ts:143-147/201-205, handle-stripe-event.ts:266-268/316-319, evaluateReleaseGate:361-365/396-400 | ★implicit・>3 重複・集約最有力 |
| I-10 | plan tier 集合 {free,standard,pro} + price↔plan 双射(load 時 fail-fast) | `price-mapping.ts:42-52,65-72` / `plan-limits.ts:10-16` | mapping 単一・tier 文字列は複数 guard |
| I-11 | resolveActiveSubscription: 自動選択禁止・DB↔Stripe customer 一致・0=NoSub/≥2=Ambiguous | `subscription.ts:resolveActiveSubscription:59-97` | 単一・explicit |
| I-12 | webhook envelope(署名400 / idempotency / handler error は 200 / 10s) | `route.ts:POST:20-63` | 単一・transport 層(aggregate 境界外の可能性) |
| I-13 | plan/status の source=`.updated`。`invoice.payment_failed` は plan 不変 | `handle-stripe-event.ts:295-307` | implicit(書込を省くことで担保) |
| I-14 | pending_update 非昇格(現 item price を採用・pending target 不採用) | `extractSubFields:107-120` | implicit |
| I-15 | checkout race 防御(2-step link + RETURNING gate で Clerk sync) | `handle-stripe-event.ts:125-179` | explicit |
| I-16 | 行 match 判定と clerkId 分離(GDPR scrub 偽アラート防止)= **A-4** | `.updated:216-248` / `.deleted:277-293` | explicit(Group A) |

**signal drift(I-7 要注意)**: `getPendingState` は Stripe の `cancel_at_period_end` を読むが DB は `cancelAt` のみ persist → ブロック判定と永続状態が別 signal。F1 で VO 化する際に整理対象。

**集約優先**: I-9(予約3列 6 site)と I-8(release gate 5 層)が最重複 = aggregate に引き上げる最有力。I-1/I-2/I-3(status→plan)は既に単一 source かつ golden 済 = **value object 境界**の自然な候補。I-6(DB=truth ブロック)/ I-7(cancel 単一 source)は単一 site だが意味的に同 aggregate。

---

## Step 6: 既存 test 網

### A-3 DB 失敗注入 unit test = **存在**(first-hand grep 確認)

`app/(app)/app/upgrade/actions.test.ts`(commit `c5075e0` で +110 行)。両 write path をカバー:
- downgrade: `:349`(db.update 失敗→notifyOps 1回+rethrow・redirect 不到達)/ `:376`(notifyOps 自身 throw でも元 DB error rethrow)/ `:386`(成功→notifyOps 不発・negative control)。
- cancelDowngrade(mirror): `:624`(失敗→notifyOps・targetPriceId なし・rethrow)/ `:654`(成功)/ `:670`(notifyOps throw variant)。
→ **F1 で新規追加は不要**(既に厚い)。

### subscription 周り test カバレッジ

- **unit `lib/stripe/subscription.test.ts`**: classifyChange / getPendingState / error classes / resolveActiveSubscription(9 分岐)/ applyUpgrade / scheduleDowngrade / cancelScheduledDowngrade / releaseCompletedDowngrade status gate(a-f)。
- **unit `actions.test.ts`**: createCheckoutSession(価格 wiring・拒否)/ changePlan(upgrade/downgrade/3 block 条件/DB=truth regression/A-3)/ cancelDowngrade。37 `it()`。
- **unit `route.test.ts`**: event 別 wiring / deleted の strict SET-key(currentPeriodEnd 非更新 regression)/ past_due 保持 / unpaid→free / unknown price→notifyOps / idempotency / **release gate §6.4 全分岐** / **A-4 scrub 偽アラート(:1206-1338)**。
- **contract/golden `tests/contract/webhook-stripe.contract.test.ts`**: 400/200 分離 + **status matrix golden snapshot**(active/trialing/past_due/unpaid/incomplete/canceled/incomplete_expired/unknown-price)= I-1/I-2/I-3 の凍結。
- **integration `tests/integration/stripe-webhook.test.ts`**: 実 `constructEvent`+`generateTestHeaderString`(実署名)/ checkout link / created/updated/deleted / idempotency / cancel_at Date⇄null / outer-catch→200。

### 注目 GAP(test 無し)

1. `normalizeSubStatus('paused')`(→canceled)と default 分岐が全 test で未実行。
2. `subscription-changes.test.ts` **不在**(classifyChange/getPendingState は間接のみ)。
3. `resolvePlanFromSub` の **null/欠落 price_id** 分岐(:81-89)未 test(unknown は test 済)。
4. checkout Step2 `subscriptions.retrieve` throw(degraded recovery :148-152)未 test。
5. user-cancel 経由の `releaseScheduleIdempotent` 「already released 正規表現」path 未 test(resource_missing のみ)。
6. Stripe 側 cancel と DB 予約の共存 interaction 未 test。
7. I-7 signal drift(cancel_at_period_end vs cancelAt)を pin する test 無し。
8. multi-event 順序(`.created` が checkout 先着 等)の end-to-end recovery 未 simulate。

---

## 所感: F1 は「F0 相当の安全網(subscription wire の contract/golden 先行)」を要するか

**結論(所感・判断は OT/claude.ai)**: **フル F0/P0 相当の独立安全網 phase は不要。ただし F1 着手前に「対象窓を狙った小規模 golden top-up」を推奨**。

根拠:
- subscription は **server-only**(Step 4)→ client mirror 破壊のリスクなし = blast radius 小。
- wire は既に **contract/golden で相当凍結**済: `webhook-stripe.contract.test.ts` の status matrix golden(I-1/I-2/I-3)+ `route.test.ts` の release gate §6.4 全分岐 + A-4 + integration の実署名。**P0 が担った "凍結 baseline" の役割を既存 test が相当果たしている**。
- F1 = server-only の aggregate 集約(挙動不変前提)。ただし**最も集約する所ほど subtle**: I-8(release gate 5 層)/ I-9(予約3列 6 site)は refactor で最も壊れやすい。
- その I-8/I-9 周辺に **GAP #4/#5/#6/#8**(checkout retrieve throw / user-cancel の already-released / cancel⇄予約共存 / multi-event 順序)が集中。

→ 推奨 = **F1 の TDD baseline として、release gate + 予約3列遷移に絞った golden/contract を数本先行**(フル phase でなく F1 task 内の先頭 step)。status→plan(VO 化対象)は既存 golden で足りる。GAP #1(paused)#3(null price_id)#7(signal drift)は F3(挙動変更)寄りなので F1 では記録のみでも可。

---

## F1 spec の主判断点(先取り・OT/claude.ai へ)

1. **aggregate 境界**: 予約(reservation)+ plan projection + release gate を 1 aggregate に閉じるか。webhook envelope(I-12)は transport 層として境界外に置くか。
2. **VO 化**: Plan / Rank(plan-catalog)/ SubscriptionStatus(10→3)/ BillingInterval を VO 化。classifyChange/rankPlan/normalizeSubStatus を VO メソッドに内包。
3. **source of truth の明文化**: plan 6 列=Stripe 後勝ち / 予約3列=DB gating・Stripe clear の**非対称**を aggregate 不変条件として型で表現(I-6/I-8/I-9)。
4. **整合窓の扱い**: W-A2(upgrade 未検知)を F1 で detection 追加するか(挙動変更 = F3 送りか)を spec で決める。**A-3 の action-only 非対称**をどう埋めるか(webhook 側は既に 200-swallow で別途観測ゆえ現状維持も選択肢)。
5. **repository 深さ**: server 側のみ(N-5 は F1 非該当)。`DbExecutor` 型の apply 前段を Subscription repository interface に昇格するか。
6. **安全網**: 上記所感の golden top-up を F1 に同梱するか。

---

## 参照
- 意図 doc: `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md`(§3-4 は HEAD `7c90246`・本 doc が最新)
- Group A(A-3/A-4 origin): `docs/audit/2026-07-08-server-invariant-verification.md` / `docs/superpowers/specs/2026-07-08-group-a-invariant-fixes-design.md`
- 主要 file(HEAD `e476ea9`): `lib/stripe/handle-stripe-event.ts` / `subscription.ts` / `subscription-changes.ts` / `app/(app)/app/upgrade/actions.ts` / `lib/clerk/handle-clerk-event.ts` / `lib/db/schema.ts:74-134`
