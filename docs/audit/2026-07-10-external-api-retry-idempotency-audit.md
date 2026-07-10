# 外部 API(Stripe/Clerk/Gemini)retry・冪等・失敗記録 ベストプラクティス横断監査(read-only)

- 日付: 2026-07-10 / branch `develop` / **read-only 調査(修正・push なし)**
- 前提 doc: `docs/audit/2026-07-10-webhook-external-dependency-pattern-audit.md`(DB 整合の外部依存)/ `2026-07-10-stripe-downgrade-reservation-clear-bug.md`(orphan bug)
- 対象 = 全 `stripe.*` / Clerk(`updateUserMetadata` / `auth`)/ Gemini(`generateContent`)/ Discord(`notifyOps`)+ retry 基盤(`lib/retry/` / `cancelWithRetry` / `callWithRetry` / `runTransactionWithRetry`)+ 失敗記録(`deletion_failures` / `notifyOps` / `source_documents.status`)
- 方法: 全外部呼出 site + retry 実装を first-hand read。

---

## 結論(TL;DR)

1. **前提「release 呼出に retry がない」は不正確**。Stripe SDK が `maxNetworkRetries: 2` + **自動 Idempotency-Key** + `timeout: 10000` で構成(`client.ts:79`)= **全 Stripe 呼出が 5xx/409/network/timeout を SDK レベルで 2 回 retry**。release も retrieve も update も例外でない。→ 「1 回で諦める」のは **429(rate limit)だけ**(SDK は 429 を retry 対象外)。
2. **429 の app 層 retry は `cancelWithRetry`(削除フロー専用)にしか無い**(`client.ts:88`)。release / schedule / update 等**他の全 Stripe mutation は 429 で即 throw**。= 唯一の実 retry gap。ただし **orphan bug の主因は retry 不在ではなく clear-release coupling**(前 doc #1)。**decouple すれば release の失敗(429 含む)は DB orphan を生まなくなる → retry 層は fix に必須でない**。
3. **Gemini は retry の gold standard**(`ocr.ts` `callWithRetry`): 指数 backoff(5s/20s+jitter)+ Retry-After 尊重(60s cap)+ `isRateLimitError`(429→即停止・AI-5 準拠)/ `isTransientError`(5xx/timeout/network→retry)/ permanent(parse→throw)の 3 分類。**429 即停止は無料枠保護の意図的設計で gap でない**。
4. **冪等は全面的に健全**。Stripe = SDK 自動 idem-key + 明示 idempotencyKey(applyUpgrade / scheduleDowngrade `:create`/`:update` / release / cancel)+ webhook event dedup(`stripe_events`/`clerk_events`)。Clerk = PATCH merge で本質冪等。二重処理防止は complete。
5. **分類(transient/permanent)は概ね存在**。Gemini(専用 classifier)/ DB(`isTransientDbError` SQLSTATE)/ Stripe(SDK 内部 + cancel の 429)。**「全部即記録 / 全部 retry なし」の箇所は無い**。gap は「Stripe 429 の app 分類が cancel のみ」の一点。
6. **失敗記録は分散、かつ Stripe subscription drift だけ永続 store が無い**(item 4)。永続 = `deletion_failures`(削除のみ・`resolved_at` 付)/ `source_documents.status`(OCR のみ)/ `entity_mutations` outbox(client sync のみ)。**Stripe の subscription 状態失敗(A-3 / release 失敗 / orphan / gate mismatch)は全て notifyOps→Discord のみ = ephemeral・reconciliation 不能**。→ 統一 reconciliation table の価値は**中〜高だが defense-in-depth**(decouple で主因は消えるため緊急でない)。
7. **総合**: retry/冪等/分類の基盤は**健全**。「外部 API hardening sprint」を単独で立てる必要は**ない**(YAGNI)。**downgrade decouple fix を主とし、任意で (a) 429-aware best-effort release helper、(b) release 残余失敗の永続記録 を小さく同梱**する程度。

---

## retry 基盤の実態(層別)

| 層 | 実装 | 対象呼出 | retry 挙動 |
| -- | ---- | -------- | ---------- |
| **Stripe SDK** | `new Stripe(key, {maxNetworkRetries:2, timeout:10000})`(`client.ts:79`) | **全 Stripe 呼出** | network/409/5xx/timeout を最大 2 回 + 自動 Idempotency-Key。**429 は対象外**(SDK `_shouldRetry` 仕様) |
| **Stripe app(429)** | `cancelWithRetry`(`client.ts:88-96`) | `subscriptions.cancel`(削除フローのみ) | `StripeRateLimitError` を 1s sleep + 1 retry。それ以外 throw |
| **Gemini app** | `callWithRetry`(`ocr.ts:106-147`)+ `transient-error.ts` | `generateContent`(OCR) | 指数 backoff 2 回(5s/20s+jitter)/ Retry-After 尊重(60s cap)/ 429 即 throw / permanent 即 throw |
| **DB tx** | `runTransactionWithRetry`(`handle-clerk-event.ts:287`) | 削除 transaction | transient SQLSTATE(40001/40P01/08*/57P*)を 3 retry(500/1000/2000ms) |
| **client sync** | `lib/retry/transient-error.ts` + `classify-bulk-error.ts` | outbox flush / bulk route(client→自 server) | 503+Retry-After で client 側 backoff retry(server 呼出でなく HTTP response 分類) |
| **Clerk** | **なし** | `updateUserMetadata` | 単発。throw-safe(ok:false)+ self-heal(次 webhook/backfill) |
| **Discord** | **なし** | `notifyOps` fetch | 単発・3s timeout・best-effort(catch→warn) |

---

## 全外部呼出 一覧表(retry / 冪等 / 分類 / 失敗扱い)

| 呼出(site) | kind | retry | 冪等 | 分類 | 失敗時扱い |
| ----------- | ---- | ----- | ---- | ---- | ---------- |
| `subscriptions.cancel`(`client.ts:90/94` via cancelWithRetry) | mut | **SDK 2x + app 429 1x** | SDK auto-idem | SDK + 明示 429 | throw → per-sub catch → **`deletion_failures`**(永続)+ notifyOps |
| `subscriptions.list`(`handle-clerk-event.ts:106`) | read | SDK 2x | N/A | SDK | catch → `deletion_failures`(kind=list)+ notifyOps |
| `subscriptions.retrieve`(`handle-stripe-event.ts:68`) | read | SDK 2x | N/A | SDK | throw → route 200 + notifyWebhookError(**self-heal:後続 sub.created/updated**) |
| `subscriptions.update`(applyUpgrade `subscription.ts:110`) | mut | SDK 2x + 明示 idemKey | 明示 idemKey | SDK | throw → action A-3 notifyOps + rethrow(UI error)+ webhook self-heal |
| `subscriptionSchedules.create/update`(scheduleDowngrade `:143/:151`) | mut | SDK 2x + 明示 idemKey(`:create`/`:update`) | 明示 idemKey | SDK | throw → action A-3 |
| **`subscriptionSchedules.release`**(releaseScheduleIdempotent `:203`) | mut | **SDK 2x(5xx/net/timeout)/ 429 app retry なし** | 明示 idemKey + already-released/missing 握り | SDK + `isAlreadyReleasedOrMissing` | **webhook delegate: throw → route 200 + notifyWebhookError(self-heal なし=orphan)** / **cancel action: A-3 + released webhook self-heal** |
| `subscriptionSchedules.retrieve`(releaseCompletedDowngrade `:258`) | read | SDK 2x | N/A | SDK | 同上(release と同経路) |
| `subscriptions.retrieve/list`(resolveActiveSubscription `:63/:83`) | read | SDK 2x | N/A | SDK | throw → action `resolveActiveSubscriptionOrNotify` notifyOps |
| `checkout/billingPortal.sessions.create`(`actions.ts:56/19`) | mut | SDK 2x + SDK idem | SDK auto-idem | SDK | throw → UI error(user retry) |
| `updateUserMetadata`(syncClerkPublicMetadata `clerk-metadata.ts:50`) | mut | **なし** | 冪等(PATCH merge) | 404 silent skip | **throw-safe: ok:false + notifyOps**(self-heal:次 webhook/backfill) |
| `generateContent`(callGemini `ocr.ts:130`) | mut | **app 2x backoff+jitter+Retry-After** | 再実行安全(`source_documents.status`) | `isRateLimitError`/`isTransientError`/permanent | throw → `source_documents.status='failed'` + notifyOps |
| `notifyOps` fetch(`ops.ts:55`) | notify | **なし**(3s timeout) | N/A(二重 post は benign) | — | catch → warn(+prod error)。prod URL 未設定 → throw(fail-fast) |

---

## item 1/5: retry が欠けている箇所(#1 以外)

**「retry が全く無い」外部呼出は実質ゼロ**(Stripe は SDK 2x が全呼出に効く)。厳密な gap は 2 点のみ:

1. **Stripe 429 の app 層 retry が `cancel` 以外に無い**(release / update / schedule / retrieve)。SDK は 429 を retry しないため、**429 受信時これらは 1 回で throw**。
   - 実リスク: subscription 系 mutation は低頻度ゆえ 429 は稀。かつ **downgrade orphan の主因は 429 でなく clear-release coupling**(前 doc)。**decouple すれば release の 429 失敗は orphan を生まない**。→ gap は実在するが severity 低、fix の必須要件でない。
2. **Clerk `updateUserMetadata` に retry 無し**。ただし **throw-safe(ok:false)+ self-heal(次 webhook / backfill)+ DB は既 commit で独立**。= decouple 済 + 自己回復ありで許容。

**Gemini / DB / notify は gap 無し**(Gemini の 429 即停止は AI-5 意図・DB は SQLSTATE 分類 3 retry・notify は best-effort が正)。

---

## item 3: 一時/恒久失敗の区別

| 経路 | classifier | 区別 |
| ---- | ---------- | ---- |
| Gemini | `isRateLimitError`(429→停止)/ `isTransientError`(5xx/timeout/net→retry)/ parse・validate→permanent throw(`transient-error.ts`) | **明確に 3 分類** |
| DB | `isTransientDbError`(40001/40P01/08*/57P*→retry・23xxx 等→即中断)(`handle-clerk-event.ts:262`) | **明確** |
| Stripe | SDK 内部(network/409/5xx→retry・429/4xx→no)+ cancel の `StripeRateLimitError` 判定 + `isAlreadyReleasedOrMissing`(release 冪等握り) | **概ね**(app 層 429 分類は cancel のみ) |
| client bulk | `classifyBulkError`(transient→503 / permanent→400)(`lib/retry/classify-bulk-error.ts`) | 明確(HTTP response 分類・server retry でなく client 誘導) |

**「区別せず全部即記録 / 全部 retry なし」の箇所は無い**。Test Clock advance 中の release 拒否が **どの class か(400=非 retry 妥当 / 409=SDK retry 済 / 429=app retry 無)は実 error log 待ち**(前 doc の未確定 #1 と同じ)。400 系なら retry 無意味で **decouple のみが正解**。

---

## item 4: 失敗記録の分散 + 統一 reconciliation table の価値

### 現状の記録先(3 永続 + Discord)

| store | 対象ドメイン | reconciliation |
| ----- | ------------ | -------------- |
| `deletion_failures`(`schema.ts:214`・**`resolved_at` 列あり**) | Clerk 削除(cancel/list/customer_missing/data_deletion) | 可(kind + resolved_at で OT/cron 回収可能な設計) |
| `source_documents.status='failed'` + `reconcileStaleProcessing` | OCR | 可(15 分 stale cleanup) |
| `entity_mutations` outbox | client→server sync | 可(client retry queue) |
| **notifyOps → Discord(ephemeral)** | **Stripe subscription 状態失敗の全部** + Clerk sync 失敗 + contact 等 | **不可(query 不能・cron 回収不能)** |

### gap: Stripe subscription drift に永続 store が無い

notifyOps→Discord のみで記録される Stripe 失敗 = A-3(db write failed after stripe success ×3)/ release-gate mismatch / autorelease current_phase null / unlinked customer / missing・unknown price / **orphan(notifyWebhookError)**。→ **これらは Discord を人が読む以外に検知・再処理する手段が無い**。downgrade orphan が起きた時の痕跡も notifyWebhookError の Discord 1 通のみ。

### 統一 table の価値評価

- **価値 = 中〜高、ただし defense-in-depth**。`deletion_failures` は既に理想形(userId/kind/errorMessage/**resolved_at**)。これを **`reconciliation_failures`(domain 判別子 + resolved_at)に一般化** or **`subscription_reconciliation_failures` を新設**すれば、orphan / A-3 drift を cron/OT が systematically 回収できる。
- **YAGNI 注意**: subscription drift の大半は **self-heal 済**(前 doc)。真に永続破綻するのは orphan の 1 ケースのみで、それは **decouple fix で消える**。→ 統一 table は「decouple 後も残る best-effort release 失敗(schedule 未 detach)を cron で再 release する」用途でのみ実益。**大規模 reconciliation subsystem を今作るのは過剰**。

---

## item 5 / downgrade fix に「retry 層」を含めるべきか

**含める必要はない(decouple で十分)**:
- release は **既に SDK が 2x retry** 済。clear を release から decouple すれば、release がどう失敗(429/5xx/timeout/400)しても **clear は先に確定し orphan は生じない**。→ correctness に retry 層は不要。
- **任意の polish**: best-effort 化した release を **429-aware にする**(`cancelWithRetry` 相当の 1 retry、or 小さな `withStripeRetry` helper)と schedule detach 成功率が上がる(方針C 便益)。ただし detach 失敗しても correctness は既に守られている(clear 済)ため **optional**。
- **任意の defense-in-depth**: decouple 後に残る「best-effort release が最終的に失敗 = schedule 未 detach」を **`deletion_failures` 相当の永続 store に 1 行記録** → cron で後日再 release。orphan は起きないが「schedule が phase1 中 attach し続け再変更を阻む」窓を潰せる。

---

## sprint 規模感

- retry/冪等/分類の基盤は**健全**ゆえ、**独立した「外部 API hardening sprint」は不要(YAGNI)**。
- **推奨** = **downgrade decouple fix を主 sprint(既 doc の G→R)**。その中に**任意で**:
  - (opt-1) 429-aware best-effort release helper(小・`cancelWithRetry` パターン流用)。
  - (opt-2) release 残余失敗の永続記録(`deletion_failures` 一般化 or 新テーブル + cron 再 release)= 中規模、別 sprint 候補。
- **opt-1 は同 sprint 内で安価**。**opt-2 は独立度が高く別 chore/sprint 化が妥当**(reconciliation subsystem は scope 膨張、YAGNI 判断は OT)。
- **W(広域配線)不要**。決済経路ゆえ canonical + Codex + Test Clock smoke 必須。

---

## 未確定 / OT 判断ポイント

1. **opt-1(429-aware best-effort release)を downgrade fix に同梱するか**。detach 成功率向上・小コスト。correctness には不要。
2. **opt-2(Stripe subscription drift の永続 reconciliation store)を作るか**。中規模・defense-in-depth。`deletion_failures` 一般化 vs 新設。**decouple で orphan は消えるため緊急でない** — 別 sprint 判断。
3. **Test Clock advance 中の release 拒否 error class**(400/409/429)= 前 doc 未確定 #1 と同一。log 取得で opt-1 の要否も確定(429 なら opt-1 有効 / 400 なら decouple のみで十分)。
4. **Stripe 429 app retry を cancel 以外にも一般化するか**(低頻度ゆえ優先度低)。

---

## 掃除(未完・OT 手動)

test clock 2 件(`downgrade2`/`cancel`)+ test10/test11 users 行削除は **CC 実行不可を確定**: (i) `.env.local` の `rk_test_` キーに `billing_clock_write` 権限なし(retrieve 可・delete は Permission denied)、(ii) `psql` 不在で DB DELETE 不可。→ OT が Stripe Dashboard(clock 削除)+ Supabase SQL(`DELETE FROM users WHERE ...` / FK cascade)で手動実施。

---

## 参照(file:line)

- Stripe SDK retry 設定: `lib/stripe/client.ts:79`(maxNetworkRetries/timeout)/ `:88-96`(cancelWithRetry 429)
- Gemini retry: `lib/ai/ocr.ts:106-147`(callWithRetry)/ `lib/retry/transient-error.ts:15-54`(分類 + backoff)/ `lib/ai/clients/gemini.ts:59-90`(parseRetryAfterMs)
- DB retry: `lib/clerk/handle-clerk-event.ts:262-318`(isTransientDbError / runTransactionWithRetry)
- release 冪等: `lib/stripe/subscription.ts:198-218`(releaseScheduleIdempotent / isAlreadyReleasedOrMissing)/ `:254-289`(releaseCompletedDowngrade)
- 失敗記録: `lib/ops.ts:23-117`(notifyOps / notifyWebhookError)/ `lib/db/schema.ts:214-227`(deletion_failures + resolved_at)/ `lib/clerk/handle-clerk-event.ts:217-248`(recordFailure)
- webhook event dedup: `app/api/webhooks/stripe/route.ts:35-44`(stripe_events)/ `app/api/webhooks/clerk/route.ts:71`(clerk_events)
- 前提 doc: `docs/audit/2026-07-10-webhook-external-dependency-pattern-audit.md` / `2026-07-10-stripe-downgrade-reservation-clear-bug.md`
</content>
