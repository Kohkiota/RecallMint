# F1: Subscription aggregate — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(fresh subagent per task + task 間 review)。

**Goal:** subscription slice を aggregate + VO 2 + 意図別 repository + 射影 use-case に集約し(挙動不変)、W-A2(upgrade 整合窓)を eager projection で閉じる。

**spec:** `docs/superpowers/specs/2026-07-08-f1-subscription-aggregate-design.md`(2b92705・承認済)。6 確定判断 + CC 判断点 4 は固定。
**HEAD:** plan 起草時 `2b92705`(code は fact-finding 時 `e476ea9` から不変を diff で確認済)。着手時に対象 file 再スキャン。

## Global Constraints(全 task 共通)

- **挙動変更は Task 6(W)のみ**。G/R は挙動不変 — 既存 golden/snapshot + G1-G7 の**更新ゼロ**が客観証明。golden 赤 = 即停止(golden を直して通す行為は禁止)。
- schema 変更ゼロ・migration 一切書かない(zero users)。wire(webhook envelope・200-swallow・response body)不触(D-2)。
- owner-scope: repository の WHERE(users.id / clerkId / stripeCustomerId / scheduleId)は現行 verbatim。0 行 match 分岐(silent / notifyOps)も現行維持。
- **実装レーン**: 全 task = CC(Opus)fresh subagent。実装 subagent は commit しない(controller が review 後 commit)。
- review: 全 code task = canonical(SDD task-reviewer・read-only)。**risk task(Task 4 配線置換 / Task 6 W)= + Codex review**(codex-review.sh・未解決 Crit/Imp 0・上限 3 周)。
- per-task gate: 対象 test + whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` 全 exit 0。**R 系 task は追加で** `pnpm vitest run tests/contract/webhook-stripe.contract.test.ts tests/integration/stripe-webhook.test.ts` + golden/snapshot 更新ゼロ確認(`git status` に snapshot diff なし)。TDD 反復中は対象 unit/route.test のみ回す(integration は commit 前 gate で回す — spec §5 の運用具体化)。
- phase 完了 gate(Task 5 後 = R 完了 / Task 6 後 = W / Task 7 = 最終): full `pnpm test` + `pnpm build` 追加。
- commit/TAG: G・R = review 後 `[reviewed]`。W = `fix(billing)` **TAG 無し** → stg/OT 実機確認後 amend で `[reviewed]`(A-3 と同運用)。
- エスカレーション(Global): 未解決 Critical / golden 赤(挙動不変の破れ)/ 仕様解釈揺れ / Sprint 完了 のみ停止。Important 以下は CC 吸収。

## 参照事実(task から参照・再調査不要)

### A. release gate 判定→副作用対応表(現行コードから verbatim 抽出・spec §3.2 の plan 委譲分)

evaluateReleaseGate(handle-stripe-event.ts:334-403)の判定と副作用。**pure 判定(→ aggregate.evaluateRelease)と副作用実行(→ use-case が現行順序で実行)の境界**:

| 判定値 | 条件(pure・dbState + stripeSub のみで決まる) | 副作用(use-case 実行・現行 verbatim) | throw/swallow | 再入・冪等 |
|---|---|---|---|---|
| (前提) | `!dbScheduleId` | なし(gate 全 skip) | — | — |
| `clear_direct` | `subScheduleId == null` かつ DB 予約あり(方向2 保険) | 予約 3 列 clear(WHERE stripeCustomerId) | 通常 flow | `.released` 後着と両者 null SET で冪等 |
| `mismatch` | `subScheduleId !== dbScheduleId`(両 non-null) | notifyOps('stripe release gate schedule mismatch')・**DB 書かない** | 通常 flow | event ごと通知 |
| `skip` | `priceId !== dbTargetPriceId`(#5 未充足) | なし(予約維持) | — | — |
| `delegate` | #1(id 一致)&& #5(price 切替済) | `releaseCompletedDowngrade(dbScheduleId, 'autorelease:'+dbScheduleId)` 実行 → 'released'/'already_terminal' なら予約 3 列 clear / 'skipped' なら維持 | **throw は伝播**(webhook route outer catch → notifyWebhookError + 200・§6.4.1) | 下記 B |

### B. delegate 先 = releaseCompletedDowngrade(subscription.ts:254-289・**infra service に残す**。Stripe retrieve を要するため pure 化しない)

status gate: `active`+`current_phase null` → notifyOps + 'skipped'(予約維持)/ `active` → releaseScheduleIdempotent 実行 → 'released' / `completed|released|canceled` → 'already_terminal'(release 呼ばず)/ `not_started`・default → 'skipped'。冪等 3 層 = status gate(主)+ idempotencyKey(短期 retry)+ regex/resource_missing(race 保険・isAlreadyReleasedOrMissing:213-218)。**この関数は移動しない**(F1 では現 file 現 shape 維持)。

### C. Stripe 裏取り(W-A2 自己修復の根拠・Context7 /websites/stripe 2026-07-08 取得)

- 「**Prorations are only triggered by updates that affect the current billing cycle's billable amounts, such as altering a subscription item's price or quantity**」(docs.stripe.com/billing/subscriptions/coupons)→ 同 price update = billable 変化なし = proration 生成なし。
- `always_invoice` = 「create prorations, automatically invoice the customer **for those proration adjustments**」(docs.stripe.com/api/subscriptions/update)→ proration ゼロなら請求対象ゼロ。
- 「Switching prices does not normally change the billing date or generate an immediate charge unless: billing interval changed / free→paid / trial」→ 同 price は全て非該当。
- **結論: 再 upgrade(同 price)で二重課金は構造的に発生しない**。限定: 「$0 invoice オブジェクトが作られない」の明文は未取得(課金額に影響なし)。idempotency は operationId 別 = 別 key = 新 request(既存 §5.4 コメントの確立運用)。**自己修復は保険 — 窓を閉じる本体(eager projection)はこの裏取りに依存しない**。stg smoke で再試行経路を実確認(Task 7 申し送り)。

---

## Phase G(1 commit: `test(stripe): F1 golden 先張り(G1-G7)[reviewed]`)

### Task 1: golden 7 本先張り

- **目的**: R の挙動不変証明の基準を先に凍結(spec §5)。test-only・実装不触。
- **内容**(置き場・assert は spec §5 の表が正):
  - G1 `tests/contract/webhook-stripe.contract.test.ts` status matrix: `paused` → status=canceled/plan=free + 未知 status(`'future_status' as any`)→ default 分岐 canceled/free(snapshot 2 本追加。**追加後は R で凍結対象**)
  - G2 `app/api/webhooks/stripe/route.test.ts`: `.updated` で items.data 空(priceId null)→ notifyOps(現行文言 'stripe sub missing price_id')+ plan=free
  - G3 `tests/integration/stripe-webhook.test.ts`: checkout.session.completed で `subscriptions.retrieve` reject → **200** + notifyWebhookError + Step1 link(1 回目 db.update)は実行済・Step2 書込なし
  - G4 `lib/stripe/subscription.test.ts`: cancelScheduledDowngrade で release が `StripeInvalidRequestError`(message 'This subscription schedule has already been released.')throw → swallow(regex path・既存 resource_missing の対)
  - G5 `app/(app)/app/upgrade/actions.test.ts`: pending.cancelScheduled=true × DB 予約列 non-null 共存 → CHANGE_BLOCKED + Stripe mutate(applyUpgrade/scheduleDowngrade)未呼出
  - G6 `tests/integration/stripe-webhook.test.ts`: `.created` 先着(customer 未 link・0 行 match)→ silent(notifyOps 不発)→ checkout.session.completed 後着 → link + plan sync 完了
  - G7 `lib/stripe/subscription-changes.test.ts` **新設**: classifyChange **全 rank matrix(rank 0-4 × 0-4 の 25 組を機械列挙**・spec「全 rank matrix」準拠)+ getPendingState の cancel 合成 predicate 4 象限(cancel_at のみ / cancel_at_period_end のみ / 両方 / なし)+ scheduleId string/object/null + hasPendingUpdate
- **制約**: 既存 test・実装コードに触らない(追加のみ)。既存 mock 境界(stripe/db/ops/clerk)踏襲。**期待値は現行実挙動**(先に手元実行で観測してから assert を書く — 期待値を仕様から推測しない)。
- **完了条件**: 新 test 全 green + 既存 full test green + per-task gate + canonical review Crit0/Imp0。

## Phase R(3 commits: R1 → R2 → R3、+ lint 独立 commit(spec §3 註)。移動/新設/書換えを commit 分離 = bisect 可能・spec §4「2-3 commit」準拠)

### Task 2: R1 — VO 抽出(`refactor(stripe): F1-R1 VO 抽出 [reviewed]`)

- **目的**: spec §3.1 の VO 2 つを `lib/stripe/domain/subscription-values.ts` に新設し、既存 caller を配線(挙動不変)。
- **内容**: ① normalizeSubStatus を handle-stripe-event.ts:32-50 から **verbatim 移設** ② `derivePlanFromStripe(status, priceId, resolvePrice)`(resolvePlanFromSub:63-102 の純粋 core・notifyOps は返り値 anomaly を caller が**導出直後・DB 書込前**に現行文言で発火)③ `ScheduledChange` 型 + `isCancelScheduled(sub)`(cancel_at != null || cancel_at_period_end === true)④ getPendingState の cancelScheduled を isCancelScheduled 参照に置換(I-7 一本化・G7 が pin)。
- **制約**: domain file は `import type Stripe` のみ(runtime import ゼロ)。handle-stripe-event 側は import 先変更 + anomaly→notifyOps 分岐のみ(通知 payload/文言/回数不変 — G2 + 既存 unknown-price golden が pin)。
- **完了条件**: per-task gate + R 系 gate(contract/integration green・golden 更新ゼロ)+ canonical Crit0/Imp0。

### Task 3: R2 — aggregate + repository 新設(`refactor(stripe): F1-R2 aggregate/repository 新設 [reviewed]`)

- **目的**: spec §3.2/3.3 の純粋 aggregate と意図別 repository を**新設 + unit test**(既存コード未配線 = additive only。配線は Task 4)。
- **内容**: ① `lib/stripe/domain/subscription-aggregate.ts`: **projectStripeSnapshot(sub, derived)** — 責務分担: plan/interval の**導出は use-case 側**(derivePlanFromStripe + resolver 注入)、aggregate は導出済み値 + Stripe sub(status/periodEnd/cancelAt/subId 抽出。**Stripe オブジェクト引数必須 = 逆流の構造保証**)を SliceUpdate に整形 / applyDeleted()→DeletedReset / reserveDowngrade(change) / clearReservation() / canChangePlan(pending, dbScheduleId) / evaluateRelease(dbState, stripeSub)→'delegate'|'clear_direct'|'skip'|'mismatch'(判定条件 = 参照事実 A の表 verbatim)② `lib/stripe/subscription-repository.ts`: loadByUserId/ByStripeCustomerId/ByScheduleId + 意図別 save 4 メソッド(saveProjection / applyDeletedReset / saveReservation / clearReservation・引数型 = aggregate 戻り値型限定)+ RETURNING shape `{matched, clerkId, scheduledDowngradeScheduleId, scheduledTargetPriceId}` ③ 両者の unit test(aggregate = pure・repository = 既存 db mock 流儀)。**aggregate test は evaluateRelease の全判定値(参照事実 A の全行)を網羅**。**repository test 観点 5 点**: owner-scope WHERE verbatim / 予約 3 列 atomicity(set/clear-together)/ 個別予約列 update 口の不在(型検証)/ RETURNING shape / 0 行 match の戻り shape。
- **制約**: SliceUpdate 生成は projectStripeSnapshot/applyDeleted のみ(逆流の構造禁止)。DbExecutor 型は既存 apply 関数群と同形。既存 file 不触。
- **完了条件**: 新 unit test green + per-task gate + R 系 gate + canonical Crit0/Imp0。

### Task 4: R3 — 射影 use-case 新設 + webhook/action 配線置換(`refactor(stripe): F1-R3 配線置換 [reviewed]`・**最大 risk task**)

- **目的**: `lib/stripe/project-subscription.ts`(spec §3.4)を新設し、handle-stripe-event と actions.ts の全 write site を aggregate/repo 経由に置換(挙動不変・1 commit = 書換えの bisect 単位)。
- **内容(webhook 側)**: projectStripeSubscription(db, key, sub) = derivePlanFromStripe → anomaly notify → projectStripeSnapshot → repo.saveProjection → RETURNING gate 付き Clerk sync。3 射影経路(checkout Step2 = clerkId / created・updated = stripeCustomerId)を単一化、0 行 match 分岐(checkout=sync skip / created=silent / updated=notifyOps)は **caller 側に残す**。`.deleted` reset → applyDeleted + repo.applyDeletedReset。evaluateReleaseGate の判定部を aggregate.evaluateRelease に置換し、副作用(参照事実 A の表)を use-case が現行順序で実行。releaseCompletedDowngrade は**現 file のまま呼ぶ**(参照事実 B)。
- **内容(action 側)**: changePlan block 判定(:109-116)→ aggregate.canChangePlan / downgrade 予約 set(:143-147)→ repo.saveReservation / cancelDowngrade clear(:201-205)→ repo.clearReservation。**A-3 try/catch + notifyOps + rethrow 構造は actions.ts 側に verbatim 維持**(repo 呼出を包む形へ)。action 全分岐の pin = actions.test 37 本(A-3 系 6 / block 3 条件 + DB-col-truth regression 対 / resolve error 系)+ G5。
- **中間検証**(blast radius 対策): webhook 側配線完了時点で route.test + integration を 1 回実走(commit はしない)— 原因特定を配線半ばで可能にする。
- **制約**: throw 伝播不変(webhook = route outer catch → 200 / action = rethrow)。A-4 分岐(row-match/clerkId 分離)・mismatch(書かず notifyOps)・`.deleted` の currentPeriodEnd 非更新・CHANGE_BLOCKED/NO_CHANGE/NO_SCHEDULE 文言・redirect 位置・idempotencyKey 生成を verbatim 維持。route.ts 不触。
- **完了条件**: per-task gate + R 系 gate(**route.test 全 suite / release gate / A-4 / actions.test 37+G5 / A-3 suite / contract / integration 全 green・snapshot 更新ゼロ**)+ canonical + **Codex**(risk task)Crit0/Imp0。

### Task 5: R4 — import 境界 lint(`chore(lint): F1 domain import 境界 [reviewed]`)

- **目的**: `lib/stripe/domain/**` の runtime import ゼロを eslint flat config で enforce(spec §3 註・独立 commit)。
- **制約**: `files:` glob は minimatch — escape 規約(CLAUDE.md)遵守。検証 = 違反 import を一時挿入して lint が赤くなることを確認してから戻す(enforce の実証)。**実証記録(挿入した import 文 + lint failure 出力)は ledger(progress.md)の本 task 行に残す**(review で検証可能に)。
- **完了条件**: whole-repo lint exit 0 + 違反検出の実証記録 + canonical(glob 検証観点)+ **phase R 完了 gate: full test + build 全 exit 0**。

## Phase W(1 commit: `fix(billing): close upgrade projection window (W-A2)` **TAG 無し**)

### Task 6: W — eager projection(spec §6)

- **目的**: upgrade 枝の DB 書込ゼロ窓を閉じる。`const updated = await applyUpgrade(...)` の返却 snapshot を projectStripeSubscription(key=users.id)で即時射影 + A-3 型検知。
- **内容**: actions.ts upgrade 枝: applyUpgrade → 射影(try/catch: 内側 best-effort notifyOps(operation:'applyUpgrade'・A-3 と同 payload 形)→ 元 error rethrow・redirect は try 外)。**非真空 test 5 本**(spec §6 verbatim): ① 成功 → users に Stripe 返却値どおり plan/interval/status/periodEnd(値 assert)② 射影 db reject → notifyOps 1 回 + rethrow・redirect 不到達 ③ notifyOps 自身 throw でも元 error rethrow ④ pending_if_incomplete(返却 sub = 旧 price + pending_update)→ 旧 plan のまま射影(I-14 action 側 pin)⑤ 射影後 `.updated` 後着 → 終状態不変(冪等)。
- **制約**: webhook 側・route.ts 不触(200-swallow 不変)。挙動変更は本 task のみ。二重課金なしの根拠 = 参照事実 C(推測禁止・裏取り済)。
- **完了条件**: 新 test 5 green + 既存 full green + per-task gate + canonical + **Codex** Crit0/Imp0 → **TAG 無し commit**(OT 実機後 amend)。

## 最終

### Task 7: 最終 gate + docs

- **目的**: sprint 完了 gate + 記録。
- **内容**: full `pnpm test` / `pnpm build` / whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` 全 exit 0 + **golden 更新ゼロの最終確認**(G1-G7 含む全 snapshot が R 開始時点から不変)+ whole-branch review(G〜W 全 commit)+ ledger 記録 + 完了 docs commit(`[no-review]`・**W commit とは別 = 挙動変更 commit に docs を混ぜない**)。stg smoke 申し送り: 正常 upgrade(**+ 直後 DB 反映 = W-A2**)/ downgrade 予約→取消 / 退会非退行 / **再 upgrade 再試行経路**(参照事実 C の実確認)。
- **完了条件**: 全 gate exit 0 + 報告 chat に「whole-repo lint exit 0 確認済」明記 + 停止(OT push 判断待ち)。

---

## Codex plan cross-check 統合記録(帰属)

`docs/codex/2026-07-08-plan-f1-subscription-aggregate-plan.md`(1 パス)。独立論点 15 = 全て plan/spec と整合(相違なし)。plan 指摘 10 の扱い:

- **採用 8**: ① projectStripeSnapshot の責務明確化(導出 = use-case / 整形 + Stripe オブジェクト必須 = aggregate — Task 3)② evaluateRelease unit test の表全網羅を完了条件化(Task 3)③ repository test 観点 5 点明示(Task 3)④ lint 実証記録の置き場 = ledger(Task 5)⑤ G1 snapshot の R 凍結明記(Task 1)⑥ G7 全 rank matrix 25 組(Task 1・spec 準拠に補正)⑦ action 分岐 pin の test 列挙 + 中間検証(Task 4)⑧ docs commit と W の分離明示(Task 7)。
- **部分採用 2**: ⑨ Stripe 出典強化 — 主出典 = api/subscriptions/update・coupons は「Prorations are only triggered by…」の唯一の明文として補強位置づけ(参照事実 C は現状維持 + stg 実確認併記済)⑩ Task 3 の Codex review 追加 — canonical 観点に repository 型境界検証を明示する形で吸収(additive-only task に 3 周 Codex ループは過大)。
- **リスク項(記録のみ)**: R3 1 commit の blast radius(spec §4 上限内・中間検証⑦で緩和)/ domain の Stripe 型結合(spec §3 で既決)/ eager projection UX(A-3 同形 payload で OT 対応可・spec §6 済)。

- 行数: 本 plan 123 行(< 250)。
