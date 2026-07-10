# Stripe 期末 downgrade 予約 — 発効後 orphan 残留の設計バグ現場調査(read-only)

- 日付: 2026-07-10 / branch `develop`(F1 反映済)/ **read-only 調査(修正・push なし)**
- 入力: GPT が確定した Stripe 仕様(1〜6・本 doc は前提として扱う)+ 観測事実(pro月額→standard月額 downgrade 予約 → 期日到来 → plan=standard 発効・`scheduled_*` 3 列 orphan 残留・schedule status=active・`subscription_schedule.released` 来ず・`customer.subscription.updated` 再送も 200 "handler error swallowed" で DB 不変)
- 方法: 現コード first-hand read(handle-stripe-event / subscription / aggregate / repository / actions / upgrade・settings page)+ Stripe API 仕様裏取り(Context7 `/websites/stripe`)
- 前提の姉妹 doc: `docs/audit/2026-07-09-stripe-test-clock-reservation-verification.md`(Test Clock 手順)

---

## 結論(TL;DR)

1. **GPT 仮説は概ね裏取れた**。予約列 clear の**主経路(delegate)は「price が target に変わったか」ではなく「release API が成功したか(`releaseCompletedDowngrade` の戻り値 `'released'`/`'already_terminal'`)」に gate されている**(`handle-stripe-event.ts:243-249`)。price==target は delegate に到達するための routing 条件にすぎず、clear の必須条件は release 成功。→ release が throw すると clear は実行されず、handler 全体が outer catch で握られ "handler error swallowed"(`route.ts:60`)。**内部 DB orphan の設計バグ**で確定。
2. **throw 箇所** = delegate 内 `releaseCompletedDowngrade`(`subscription.ts:254`)の Stripe 同期呼出(`retrieve` :258 / `release` :203、非冪等 error は :206 で rethrow)。webhook handler の critical path で outbound Stripe mutation を同期実行しており、その失敗が DB clear を道連れにする構造。**正確な Stripe error code は静的コードから確定不能** — Vercel function log / `notifyWebhookError` の Discord payload が唯一の一次情報(OT 取得推奨)。
3. **orphan は self-heal しない可能性が高い**。phase1 は `iterations`/`duration`/`end_date` 未指定の**開放端 phase**(`subscription.ts:173-176`)。開放端の最終 phase は自然完了せず `subscription_schedule.released` が発火しない(GPT 仕様 1・2 と整合)。→ released 回収経路(`handle-stripe-event.ts:171`)は本 schedule 形状では**事実上 inert**。つまり delegate の active-release が唯一の clear 手段で、それが失敗 = **恒久 orphan**(severity 高)。
4. **fix 方向 = GPT 推奨(a)を核に採用**(clear を release 成功から切り離し、price==target を満たしたら**冪等条件付き UPDATE で無条件 clear**)。active-release(方針C)は**残すが best-effort 化**(失敗しても clear を阻害しない・throw を handler に伝播させない)を推奨(理由: schedule 残置時の再変更 Stripe 衝突を避ける方針C の狙いは有効)。純 (a)(active-release 撤去)か hybrid かは **§2 の実 error 判明で確定**。
5. **帰属 = F1 release gate の局所 fix**(全面再設計ではない)。変更は `evaluateReleaseGate` の delegate 分岐 + `evaluateRelease` の分類 + 付随 test に限局。upgrade(W-A2)/ cancel / deleted / projection 経路には波及しない。**重要 Fix(決済 webhook)= 小 sprint(G→R 1〜2 task)+ Test Clock stg smoke 必須**。
6. **app 表示矛盾は 2 症状で原因が別**。「変更予約中」banner + CTA 全 disable = `scheduled_*` orphan 由来(clear で直る)。「現プラン Pro」= DB(=standard)由来ではない別源(Clerk JWT `sessionClaims.plan` の stale。**clear では直らない**)。§5 で切り分け。

---

## 調査項目 1: 予約列 clear の発火条件(released 依存か / price 変化か)

予約 3 列(`scheduledDowngradeScheduleId` / `scheduledTargetPriceId` / `scheduledChangeEffectiveAt`)を DB で clear する site は **3 箇所**。それぞれの発火条件:

| # | site(file:line) | 発火経路 | clear 条件 | 期末 downgrade 発効(phase0→phase1)で発火するか |
| - | ----------------- | -------- | ---------- | ------------------------------------------------ |
| A | `handle-stripe-event.ts:171-183` | `subscription_schedule.released` event | schedule.id 一致で**無条件** clear | **しない**。released は開放端 phase1 では発火せず(§3・GPT 仕様1・2)。回収 path として設計されているが本 schedule 形状では inert |
| B | `handle-stripe-event.ts:218-224`(`clear_direct`) | `customer.subscription.updated` で `sub.schedule==null` かつ DB 予約残存 | 無条件 clear | **しない**。active phase1 では `sub.schedule` は非 null(schedule 継続 attach、GPT 仕様1)→ `clear_direct` に落ちない |
| C | `handle-stripe-event.ts:237-250`(`delegate`) | `customer.subscription.updated` で `sub.schedule==DB scheduleId` かつ **price==target** | **`releaseCompletedDowngrade` が `'released'`/`'already_terminal'` を返した時のみ**(:243-249) | **これが唯一到達する経路。だが clear は release 成功に gate されている** |

### 到達フロー(発効イベント)

`customer.subscription.updated`(phase 遷移で発火)→ `handle-stripe-event.ts:83`:
1. `projectStripeSubscription`(:88)→ plan 6 列を standard に射影(`saveProjection` `project-subscription.ts:59`)。**DB plan=standard はここで commit**(観測「plan は standard 発効」と一致)。RETURNING で既存予約列を取り出す(`scheduledDowngradeScheduleId`=非 null)。
2. `result.matched` true → `.updated` なので `evaluateReleaseGate`(:100)を呼ぶ。`priceId=extractPriceId(sub)`=standard、`dbScheduleId`=非 null、`dbTargetPriceId`=standard。
3. `evaluateReleaseGate`(:195):`dbScheduleId` 非 null → early return せず。`subScheduleId`=`sub.schedule`=schedule.id(active phase1 で継続 attach)。
4. `evaluateRelease`(`subscription-aggregate.ts:124-135`):`subScheduleId!=null`(→not clear_direct)、`==dbScheduleId`(→not mismatch)、`priceId==dbTargetPriceId`(→not skip)→ **`'delegate'`**。
5. delegate(:237):`releaseCompletedDowngrade(dbScheduleId, ...)` を await。**戻り値が `'released'`/`'already_terminal'` の時だけ `clearReservation`**(:243-249)。

**→ 結論(item 1)**: GPT 仮説どおり。**「price 変化」は delegate への routing にすぎず、実際の clear は release API の成功(`releaseCompletedDowngrade` 戻り値)に必須条件として gate されている**。release が throw/`'skipped'` を返すと clear は実行されない。GPT の「release API 成功を clear の必須条件にしない」= 現状は必須条件になっている、が正確。ズレの箇所は **`handle-stripe-event.ts:243`(`if (result === 'released' || result === 'already_terminal')`)**。

---

## 調査項目 2: `releaseCompletedDowngrade` の実挙動 + throw 箇所

`subscription.ts:254-289`。active phase1 schedule に対する分類:

| schedule.status | current_phase | 戻り / 副作用 | clear に到達するか |
| --------------- | ------------- | ------------- | ------------------- |
| `active` | 非 null | `releaseScheduleIdempotent` で release 実行 → **`'released'`** | **到達(clear する)** |
| `active` | null(異常) | notifyOps + **`'skipped'`** | しない(予約維持) |
| `completed`/`released`/`canceled` | — | **`'already_terminal'`** | 到達(clear する) |
| `not_started` | — | **`'skipped'`** | しない |

- **正常系(GPT 仕様3・Context7 裏取り済)**: active(current_phase 非 null)なら release は成功する(「A schedule can only be released if its status is `not_started` or `active`」— releasing detaches schedule, keeps subscription)。→ `'released'` → clear。**つまり本来はこの経路で clear されるべき**。
- **観測(orphan + schedule 依然 active + "handler error swallowed")が意味するもの**: release が **成功しなかった**(status が released でなく active のまま = release が効いていない)+ handler が **throw した**。status 拒否(deterministic)は Context7 上ありえない(active は releasable)ため、throw は以下いずれか:
  - `stripe.subscriptionSchedules.retrieve(scheduleId)`(`subscription.ts:258`)が Stripe 5xx/timeout で throw
  - `stripe.subscriptionSchedules.release(...)`(`subscription.ts:203`)が **非冪等 error**(`resource_missing`/`already released|completed` 以外)で throw → :206 rethrow
- **throw の伝播経路**: `releaseCompletedDowngrade` throw → delegate(`handle-stripe-event.ts:240`)は握らず伝播 → `handleEvent` → `route.ts:47` の try → catch(:49)→ `notifyWebhookError`(:53)→ `return 200 "handler error swallowed"`(:60)。**clear(:244)は throw で到達不能**。
- **最有力仮説(要 log 裏取り)**: **webhook handler の critical path で outbound Stripe mutation(retrieve+release)を同期実行**しており、Test Clock advance の event burst 下で Stripe 呼出が遅延/timeout(CLAUDE.md Stripe-2 の 10 秒制約とも競合)→ throw。**設計的 smell = 常に成功すべき DB clear を、失敗しうる外部 API mutation の後段に条件付きで置いている**。
- **確定に必要な一次情報**: swallowed error の中身。**`notifyWebhookError` の Discord 通知 payload(`handler:'stripe'`, `eventType:'customer.subscription.updated'`, `err`)or Vercel stg/prod function log**。これで retrieve/release どちらが・どの Stripe error code で落ちたか判明 → 純 (a) か hybrid か(§6)を確定できる。**この取得は OT 領域**。

---

## 調査項目 3: `scheduleDowngrade` の phase1 構造(約1年 phase1 の実体)

`subscription.ts:132-181`:
- `subscriptionSchedules.create({ from_subscription: sub.id })` → phase0 は from_subscription 由来(現 price / 現請求期間)。
- `update` で `end_behavior:'release'` + phases 2 本(:165-177):
  - **phase0**(:167-172): `start_date=currentPhase.start_date` / `end_date=currentPhase.end_date` / items=現 price。
  - **phase1**(:173-176): `items=[{price: targetPriceId, quantity:1}]` / `proration_behavior:'none'`。**`iterations` / `duration` / `end_date` いずれも未指定 = 開放端 phase**。
- 予約発効予定 = `effectiveAt = phase0.end_date`(`actions.ts:188`)= 現請求期間末。

### 「約1年」の実体 + released 発火可否(Context7 裏取り)

- Context7 changelog: phase 長は `duration`(旧 `iterations`、deprecated)で指定。Stripe 公式例(tax/subscriptions/update)でも最終 phase に **明示 `iterations: 1`** を置いている。**本コードは phase1 に何も置いていない = 開放端**。
- 開放端の最終 phase は自然完了しない → `subscription_schedule.completed`/`released` が発火しない(GPT 仕様1「全 phase 終了後に発動」/ 仕様2「全 phase 完了は completed」と整合。終了しない phase は発動条件を満たさない)。
- **→ 「約1年 phase1」は開放端の帰結**(standard 月額を無期限に継続 = 実質「downgrade 後ずっと standard」)。GPT の「約1年」は概算/別 config 由来の可能性。**厳密な自然 release 有無は Test Clock で advance して確認すべき**(§Test Clock 再検証)。
- **設計含意(重大)**: 開放端ゆえ released 回収 path(item1-A)が inert → **delegate の active-release が唯一の clear 手段**。それが §2 で失敗 = **恒久 orphan**。fix で active-release から clear を切り離すのが必須である根拠がここで補強される。

---

## 調査項目 4: `evaluateRelease` / release gate の blast radius(F1 波及)

usage grep 結果:
- **`evaluateRelease`(pure)**: 使用は `handle-stripe-event.ts:217`(`evaluateReleaseGate` 内)**1 箇所のみ**。他経路(upgrade / cancel)は未使用。
- **`releaseCompletedDowngrade`**: 使用は `handle-stripe-event.ts:240`(delegate)**1 箇所のみ**。
- **`cancelScheduledDowngrade`**(ユーザーが発効**前**に取消): `actions.ts:238`。内部は `releaseScheduleIdempotent` を**直接**使い、`releaseCompletedDowngrade` とは別経路。**本 fix の影響を受けない**(status gate を課さない別冪等経路 — `subscription.ts:225-230`)。
- **`clearReservation`(repo)**: `handle-stripe-event.ts`(released / clear_direct / delegate の 3 site)+ `actions.ts:243`(cancelDowngrade)。fix はうち **delegate site の条件のみ**変える。

**→ blast radius(item 4)**: fix は `evaluateReleaseGate` の **delegate 分岐 + `evaluateRelease` の `'delegate'` 分類**に**限局**。波及しない: (i) upgrade 即時課金(W-A2 `applyUpgrade` — `evaluateRelease` 非経由)、(ii) cancel(`cancelScheduledDowngrade` 別経路)、(iii) deleted リセット、(iv) `saveReservation`。F1 release gate の**発効=released 前提**が Stripe phase モデルと噛み合っていない範囲は delegate の active-release 依存**のみ**。他 gate 分類(clear_direct / mismatch / skip)と released 回収 path は概念上正当(released は本 schedule 形状で発火しないだけ)。**局所 fix で足り、release アーキの全面再設計は不要**。

---

## 調査項目 5: app 表示矛盾の原因(DB=standard なのに「現プラン Pro + 予約中」)

**2 症状で源が別。切り分けが必須。**

### 症状 A: 「変更予約中」banner + プラン変更 CTA 全 disable —— `scheduled_*` orphan 由来(clear で直る)

- upgrade page `hasScheduledDowngrade = user.scheduledDowngradeScheduleId != null`(`upgrade/page.tsx:32`)= orphan で **true**。
- → `DowngradeReservationBanner`(`upgrade-plans.tsx:73-78`)が「{target}へ変更予約中(発効日)」表示。`scheduledTargetPriceId`/`scheduledChangeEffectiveAt` で label 整形(`upgrade/page.tsx:55-69`)。
- → `blocked = hasPendingUpdate || cancelScheduled || hasScheduledDowngrade`(`upgrade-plans.tsx:54`)= **true** → 全 PlanCard の変更 CTA disable。
- settings page も同源: `isDowngradeReserved`(`settings/page.tsx:50-53`)→「変更予約中」行(:89-96)+ Portal ボタン非活性(MF-4)。
- **→ 予約列 clear でこの症状群は全て直る**(banner 消滅・CTA 復活・settings 表示是正)。

### 症状 B: 「現プラン Pro」—— `scheduled_*` 由来ではない(clear では直らない)

- upgrade page / settings page の「現(在の)プラン」は **`user.plan`**(`getCurrentUser()` = **純 DB lookup** `ensure-user.ts:38-51`)を `planLabelFor` に渡す(`upgrade-plans.tsx:68` / `settings/page.tsx:80`)。**DB=standard なら "Standard" 表示**。ここから "Pro" は出ない。
- `scheduled_*` は「現プラン」label に**一切効かない**(orphan があっても現プランは `user.plan`=DB のまま)。→ **item 5 の前提「scheduled_* 残存が現プラン判定に効く」は誤り**(効くのは予約 banner + blocked のみ)。
- では "Pro" はどこ由来か: plan を **Clerk JWT `sessionClaims.plan`** から読む surface(`getAuthContext()` `ensure-user.ts:69-82`)。実 plan 読取消費は **upload page**(`upload/page.tsx:41` `let plan = ctx.plan`、OCR gating)。JWT の plan claim が **stale(pro のまま)**なら Pro 扱いになる。
  - 発効イベントで `syncClerkPublicMetadata({plan:'standard'})` は projection 内(`project-subscription.ts:63-65`)で **throw 前に**呼ばれている(**syncClerk は throw しない**設計 `clerk-metadata.ts:52-69`、失敗時 ok:false + notifyOps)。→ Clerk publicMetadata は standard に更新済のはず。**ただしユーザーの現行 JWT は次回 token refresh まで旧 claim(pro)を保持** = 過渡的 stale。
  - もし Clerk API 側も失敗(ok:false)していれば publicMetadata が pro のまま残り**恒久 stale**。
- **→ item 5 の "Pro"**: DB でも `scheduled_*` でもなく **JWT/Clerk metadata の plan claim** 由来。**予約列 clear では直らない**。過渡的(JWT refresh 待ち)か恒久(Clerk sync 失敗)かは要確認。**OT 確認事項** = (i) "Pro" を見たのは具体的にどの画面か(upgrade/settings は DB=standard 表示のはず / upload 等 JWT 系なら Pro ありうる)、(ii) Clerk Dashboard で当該 test user の `publicMetadata.plan` の実値。

---

## 調査項目 6: fix 方向 (a)/(b) の現コード評価 + 推奨

### (a) 最小: clear を price==target で無条件化(GPT 推奨)

delegate を「release 成功で clear」から「price==target なら**冪等条件付き UPDATE で clear**」へ。active-release は撤去し、schedule は開放端 phase1 のまま残す。

- 変更点: `handle-stripe-event.ts:237-250` の delegate を無条件 `clearReservation` に。`evaluateRelease` の `'delegate'` は実質 `'clear'` に collapse(`clear_direct` と同挙動)。`releaseCompletedDowngrade` は**未使用化**(撤去 or 保持判断)。
- GPT の「冪等条件付き UPDATE(schedule_id/target_price_id 一致で clear)」: 現 `clearReservation` は `by:'stripeCustomerId'` の WHERE(条件なし)。**`WHERE scheduledDowngradeScheduleId = dbScheduleId AND scheduledTargetPriceId = priceId` を足す**と、発効と別予約の race clear を防げる(GPT 意図と一致)。repository に条件付き clear 口の追加が要る(I-9 の 3 列一括原則は維持)。
- **リスク**: schedule が phase1 中ずっと **subscription に attach したまま残る**。app UI は `canChangePlan`(`subscription-aggregate.ts:107-115`)が **DB `scheduledDowngradeScheduleId`(clear 済=null)でのみ**判定し `sub.schedule` は見ない(`actions.ts:116`)ため**再変更 UI は unblock される**。ただし実 Stripe API 段で: 再 downgrade は `subscriptionSchedules.create({from_subscription})` が既存 schedule と衝突しうる / 再 upgrade は attach schedule 下の in-place `subscriptions.update` が制約されうる。**= 発効後・自然 release 前の窓での再変更が Stripe で失敗しうる**(開放端ゆえこの窓は恒久)。方針C の active-release はまさにこれを避けるために存在。

### (b) clean: 発効後に release を撃って schedule を外す + clear

現 delegate はまさに (b) 型(active-release)。ただし **clear を release 成功に gate**しているのが不具合。

- **推奨 = (a) の無条件冪等 clear を核に、active-release を残すが best-effort 化した hybrid**:
  1. delegate 到達(price==target)→ **まず無条件・冪等条件付きで `clearReservation`**(release 結果に依存しない)。
  2. その後 active-release を **best-effort**(try で囲み、失敗は notifyOps のみ・**throw を handler に伝播させない**)。成功すれば schedule 即 detach(方針C の再変更衝突回避が効く)、失敗しても clear は既に済んでいて orphan は生じない。
- これで **GPT (a) の要件(clear を release から独立・冪等)を満たしつつ、方針C の detach 便益を保持**。純 (a)(active-release 撤去)との差は「再変更窓の Stripe 衝突を防ぐか」だけ。

### 推奨まとめ

- **core(確定推奨)**: **clear を release 成功から切り離し、price==target で冪等条件付き UPDATE clear**(GPT (a) の核)。`handle-stripe-event.ts:243` の gate 撤廃。
- **active-release の去就(§2 の実 error 待ちで確定)**:
  - error が **transient(Stripe timeout/5xx)**なら → **best-effort で残す**(hybrid、detach 便益維持)。
  - error が **deterministic(本 schedule 形状で常に落ちる)**なら → active-release は元々機能しておらず → **撤去(純 a)**。再変更窓の衝突は別 task で(発効後 detach を非同期 job 化 or 再変更時に既存 schedule を先に release 等)。
- **`releaseCompletedDowngrade`**: hybrid なら best-effort helper として保持(status gate は活かす)。純 a なら撤去可(usage は delegate のみ)。

---

## 帰属 + sprint 規模感

- **帰属**: **F1 release gate の局所 fix**。F1 の設計前提「発効=released で clear」が Stripe の phase モデル(発効=phase 遷移 / released=全 phase 完了後、開放端では発火せず)と噛み合っていない箇所は **delegate の active-release 依存に限局**。release アーキ(clear_direct / mismatch / skip / released 回収の分類)自体は保持でき、**全面再設計ではない**。
- **規模感**: F1 と同じ **G→R** の小 sprint。G=新挙動の golden pin(発効イベントで price==target なら 3 列 clear・release 失敗でも clear される・別予約 race で誤 clear しない)、R=delegate 分岐 + `evaluateRelease` 分類 +(条件付き clear なら)repository 口 + test 更新。**W(方針転換の広域配線)は不要**。task 数 1〜2。
- **必須経路(CLAUDE.md)**: 決済 webhook に触れる = **重要 Fix**。canonical review(general-purpose + template)+ Codex 独立レビュー、収束条件 Crit0/Imp0。**stg smoke = Test Clock 実走必須**(push→smoke 順ゆえ [reviewed] amend 窓は構造的に閉じる → session doc を正記録)。spec 凍結・plan 確定は brainstorming/writing-plans 経由(skip 不可)。

---

## Test Clock 再検証手順(fix 後・price トリガーの実 DB 裏取り)

前提手順は姉妹 doc(`2026-07-09-stripe-test-clock-reservation-verification.md` §Step 1・3)を流用。**fix 後に追加/変更する検証項目**:

1. **発効時 clear の確認(本 fix の主眼)**: clock 紐付き customer で app 経由 downgrade 予約(pro月額→standard月額)→ `scheduled_*` 3 列 set を確認 → period_end 直後へ advance → `ready` polling → **DB `scheduled_*` 3 列が NULL に clear されている**ことを確認(旧: orphan 残留)。plan=standard も確認。
2. **release 失敗でも clear される(hybrid の要件)**: 可能なら active-release を意図的に失敗させる条件下(or best-effort 実装の unit で)、**clear が先に済むこと**を確認。実機で難しければ unit golden で担保(plan に 1 行明記)。
3. **冪等 / 誤 clear なし**: 同 `.updated` 再送(新 event id)で 200 かつ DB 不変(既 clear 済で no-op)。別予約が挟まった場合に条件付き UPDATE が誤 clear しない(schedule_id/target 不一致で clear されない)。
4. **released 回収 path の挙動確認(§3 の裏取り)**: advance をさらに進めて **`subscription_schedule.released` が発火するか**を観測。発火しない(開放端で自然 release なし)なら item1-A が inert である前提が実証される。発火するなら回収 path が effective(fix の安全網)。
5. **表示是正**: clear 後に upgrade/settings で「変更予約中」banner 消滅・CTA 復活を DevTools MCP で確認(症状 A)。**症状 B(Pro)は JWT/Clerk 由来ゆえ本 fix の検証対象外**(別途 Clerk metadata / JWT refresh を確認)。
6. **webhook endpoint 前提**(姉妹 doc 罠4): Test Clock advance の webhook が stg `/api/webhooks/stripe` に届く登録 + secret 一致(OT 領域)。

---

## 未確定 / OT 判断ポイント

1. **swallowed error の中身(最重要)**: `notifyWebhookError` Discord payload or Vercel function log。retrieve/release どちらが・どの Stripe error code で throw したか。→ active-release を best-effort 保持(hybrid)か撤去(純 a)かを確定。**OT 取得**。
2. **"現プラン Pro" の実 surface + Clerk `publicMetadata.plan` 実値**(§5 症状 B)。upgrade/settings は DB=standard 表示のはず。JWT stale(過渡)か Clerk sync 失敗(恒久)か。
3. **phase1 開放端の自然 release 有無**(§3・再検証4)。released 回収 path が本当に inert か Test Clock で実証。
4. **fix 実装の clear 条件強度**: 単純 `by customerId` clear か、GPT 推奨の `schedule_id + target_price_id` 一致条件付き UPDATE か。後者は repository に条件付き clear 口の追加(I-9 3 列一括は維持)。
5. **sprint 化 GO 判断**: 上記 1〜3 を待ってから spec 起草(brainstorming)に入るか、並行で spec ドラフトするか。

---

## 参照(file:line)

- clear 3 site: `lib/stripe/handle-stripe-event.ts:171-183`(released)/ `:218-224`(clear_direct)/ `:237-250`(delegate・gate は :243)
- release gate 判定: `lib/stripe/domain/subscription-aggregate.ts:124-135`(`evaluateRelease`・delegate :134)
- active-release: `lib/stripe/subscription.ts:254-289`(throw 源 retrieve :258 / release :203・rethrow :206)
- webhook swallow: `app/api/webhooks/stripe/route.ts:46-61`(:60 "handler error swallowed")
- phase1 開放端: `lib/stripe/subscription.ts:132-181`(phase1 :173-176)
- 予約 set(effectiveAt=phase0 end): `app/(app)/app/upgrade/actions.ts:185-189`
- projection + Clerk sync: `lib/stripe/project-subscription.ts:24-67`(saveProjection :59 / syncClerk :63-65)
- Clerk sync 非 throw: `lib/auth/clerk-metadata.ts:36-70`
- plan 読取 2 系統: `lib/auth/ensure-user.ts:38-51`(getCurrentUser=DB)/ `:69-82`(getAuthContext=JWT plan)
- 表示: `app/(app)/app/upgrade/page.tsx:32,55-69` / `upgrade-plans.tsx:54,68,73-78` / `app/(app)/app/settings/page.tsx:50-53,80,89-96`
- change gate: `subscription-aggregate.ts:107-115`(`canChangePlan`)/ `actions.ts:116` / `subscription-changes.ts:36-47`(`getPendingState`)
- Stripe 仕様(Context7 `/websites/stripe`): release は `not_started`/`active` のみ・detaches schedule keeps subscription / phase duration は `duration`(旧 iterations)・開放端最終 phase は自然完了せず
</content>
</invoke>
