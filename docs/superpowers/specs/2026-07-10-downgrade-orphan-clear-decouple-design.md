# Downgrade 予約列 orphan correctness fix(clear decouple)— design spec

- 日付: 2026-07-10 / 前提監査: `docs/audit/2026-07-10-{stripe-downgrade-reservation-clear-bug, webhook-external-dependency-pattern-audit, external-api-retry-idempotency-audit, reconciliation-infra-factfinding}.md`
- 対象バグ: downgrade 発効時、予約 3 列(`scheduled_*`)の clear が release API 成功に gate され(`handle-stripe-event.ts:243`)、release throw で恒久 orphan(self-heal なし・webhook 常時 200 で再送もなし)。

## 1. 確定判断(spec の前提・固定 — claude.ai + OT 承認済)

1. **主 fix = #1 delegate clear の decouple**: DB clear を先に確実に実行(price==target 充足で release 結果に無関係に冪等条件付き UPDATE)→ active-release は best-effort(throw を handler に伝播させない)。参照実装 = `handle-clerk-event.ts` user.deleted の forward-only。
2. **#5 cancel clear(`upgrade/actions.ts:243`)も同梱**: 同じ冪等条件付き clear helper を 2 経路で共用(二重防御)。
3. **冪等条件付き clear** = repository に `WHERE scheduledDowngradeScheduleId=? AND scheduledTargetPriceId=?` の clear 口を 1 つ追加(I-9 の 3 列一括原則維持)。別予約 race での誤 clear を防ぐ。
4. **opt-1**: best-effort release に 429-aware app retry を追加(SDK は 5xx/timeout/network を maxNetworkRetries:2 で retry 済・429 のみ gap)。
5. **active-release は撤去せず best-effort 保持**(hybrid・detach 便益維持)。
6. **W なし = G→R**(F1/F2/F3 と同型)。新挙動を golden で pin。
7. **失敗記録の永続化(integration_failures)は Sprint 2**。本 spec は correctness のみ、best-effort release 失敗は notifyOps→Discord のまま。

## 2. スコープ / やらないこと

- **触る**: `lib/stripe/handle-stripe-event.ts`(delegate 分岐)/ `lib/stripe/subscription.ts`(`releaseScheduleIdempotent` 429 retry)/ `lib/stripe/subscription-repository.ts`(条件付き clear 口)/ `app/(app)/app/upgrade/actions.ts`(cancelDowngrade の clear を条件付き化)/ 対応 test。
- **触らない**: `evaluateRelease`(pure・4 分類 verbatim = F1 golden 継続)/ `releaseCompletedDowngrade` の status gate 契約 / upgrade(W-A2)・deleted・projection・released・clear_direct 経路 / schema / `scheduleDowngrade` の phase 形状(開放端 phase1 の是非は別議)/ integration_failures(Sprint 2)/ notifyOps の Discord 通知先。

## 3. 設計構造

### 3.1 repository: 条件付き冪等 clear 口(確定 3 の具体化)

`subscription-repository.ts` に新関数 1 つ:

```
clearReservationMatching(tx, key: SubKey, match: { scheduleId: string; targetPriceId: string })
  → UPDATE users SET 予約3列=NULL
    WHERE whereFor(key)                                   -- owner scope(Codex 指摘採用)
      AND scheduled_downgrade_schedule_id = match.scheduleId
      AND scheduled_target_price_id = match.targetPriceId
    RETURNING(既存 RETURNING_SHAPE)→ SaveResult
```

- **owner scope(SubKey)を必須第 2 引数に維持**: #1 は `{by:'stripeCustomerId'}`、#5 は `{by:'id'}`。schedule id は Stripe 全体で一意だが、CLAUDE.md Clerk-3(query は必ず owner 条件)+ 既存 repository 全関数の SubKey pattern に整合させる(Codex「customer scope 不明」採用)。
- 書込値は既存 `clearReservation()` aggregate 出力(全 NULL)を verbatim 使用 = I-9(3 列一括)維持。match 引数は **non-null string**(I-9 により scheduleId 設定行は targetPriceId も設定済 — `reserveDowngrade` 型が保証)。
- **0-row match は正常 no-op**(既 clear 済 / 別予約に差替済 = 誤 clear 防止がこの口の存在理由)。観測は `SaveResult.matched` で可能。notifyOps は**発火しない** — 0-row の主因(冪等再送・race)は正常系で、異常(破損データ)と区別不能なまま通知するとノイズ化するため(Codex「0-row 観測」は matched 返却 + golden で判別可を採用、通知は不採用)。
- 既存 `clearReservation`(無条件・SubKey 版)は released handler(:177)/ clear_direct(:219)で継続使用。released が targetPriceId を見ない理由 = scheduleId 単独で予約の同一性が確定する(I-9 で pair 一括保存ゆえ scheduleId 一致 = その予約)+ event payload の schedule.id は Stripe 発の事実(推測でない)。

### 3.2 #1 delegate 分岐の順序反転(確定 1 の具体化)

`evaluateReleaseGate` の `case 'delegate'` を以下に置換(`evaluateRelease` の分類・他 case は不変):

```
0. if (dbTargetPriceId == null) { notifyOps('release gate: reservation missing target price', {...}); return }
   // I-9 上ありえない破損データ。誤 clear せず予約維持 + 観測(TS strict の null narrowing も充足)
1. await clearReservationMatching(db, { by:'stripeCustomerId', value: customerId },
     { scheduleId: dbScheduleId, targetPriceId: dbTargetPriceId })
2. try { await releaseCompletedDowngrade(dbScheduleId, 'autorelease:' + dbScheduleId) }
   catch (err) { await notifyOps('stripe autorelease failed (reservation cleared)', {...}) }
   // throw を握る = handler へ伝播させない(clear は 1. で確定済・orphan は生じない)
```

- **clear(1.)の throw は握らない**(Codex 指摘採用): DB 失敗 = correctness 重大ゆえ従来どおり伝播(outer catch → notifyWebhookError + 200)。release(2.)には進まない。回復経路 = 次に届く任意の `.updated`(月次請求更新等)で delegate が再評価され clear 再試行(transient DB 障害なら回復)。**境界: release throw は握る / clear throw は握らない**。
- **transaction 境界**(Codex 指摘採用): clear は単発 UPDATE(auto-commit・既存 repository pattern の DbExecutor)で、**commit 完了後に** release へ進む。clear と release を同一 tx にはしない(外部 API を tx に入れない)。
- **catch 位置は call site(evaluateReleaseGate)**。`releaseCompletedDowngrade` 自体は throw 契約を維持(関数契約不変・test 資産温存)。
- notifyOps payload(Codex 指摘で pin): `{ eventId, customerId, scheduleId, targetPriceId, error, environment, timestamp }`(Error serialize は notifyOps 内 `expandError` が既対応)。**Sprint 2 はこの catch に integration_failures dual-write を足す**(seam をコメントで明示)。
- release の戻り値(released/already_terminal/skipped)は clear を gate しない(情報のみ)。`current_phase null → notifyOps + skipped` は関数内に現状のまま残る。
- 再送/多重 `.updated` は: clear 済 → 1. が 0-row no-op、release は status gate(`already_terminal`)で収束。従来と同じ冪等構造。
- **latency 上界**: 最悪 retrieve(~10s×SDK retry)+ 429 sleep(1s 固定)+ release で Stripe 側 delivery timeout を超えうるが、clear は先頭で確定済 + `stripe_events` dedup が再送を 200 duplicate で吸収するため correctness 影響なし(観測: Vercel log)。best-effort release は「短く諦める」方針 = 429 retry は 1 回固定・Retry-After 不使用(§3.4)。

### 3.3 #5 cancelDowngrade: 順序は**不変**・clear のみ条件付き化(確定 2 の具体化)

**共用するのは clear 口のみで、順序反転は #1 だけ**。理由: #5 は発効**前**のユーザー取消であり、clear を release より先にすると「DB は予約なし・Stripe は schedule 生存 → 期末に意図しない downgrade 発効 + UI ブロック解除で二重変更余地」という**逆向きの破綻**を新設してしまう。#1 は発効**後**(予約は既に消費済)だから clear 先行が正しい — この非対称が本 fix の核心。

`cancelDowngrade`(actions.ts)の変更は 1 点のみ:

```
release 成功(従来どおり throw は UI へ伝播)
→ clearReservation(by:'id') を clearReservationMatching({ by:'id', value: user.id },
   { scheduleId: pending.scheduleId, targetPriceId: user.scheduledTargetPriceId }) に置換
   (user.scheduledTargetPriceId が null なら match 不能ゆえ従来型 clear へは倒さず 0-row 扱い —
    予約なし cancel は NO_SCHEDULE ガードが先に弾くため実質到達しない)
```

- 条件の scheduleId は **実際に release した id(`pending.scheduleId`)**。DB `scheduledDowngradeScheduleId` と不一致(mismatch anomaly)なら 0-row no-op = 予約維持(anomaly を勝手に消さない・従来の無条件 clear より安全側)。
- release 失敗 → throw → A-3 catch 群は現状維持。self-heal(released webhook :171 の無条件 clear)も現状維持 = 二重防御の 2 層目。429 時は §3.4 の 1s retry で UI 待ちが最大 +1s(許容・明記のみ)。
- **将来の実装者への固定**(Codex リスク指摘採用): 「#1 と共通化して clear 先行に揃える」変更は N-5 test が fail して止まる設計 + call site コメントで非対称の理由(§3.3 冒頭)を明示する。

### 3.4 opt-1: 429-aware release(確定 4 の具体化)

`releaseScheduleIdempotent`(subscription.ts:198)に内蔵(**汎用 helper は作らない** — 429 app retry は cancelWithRetry に次ぐ 2 例目で rule-of-three 未満、既存 `cancelWithRetry` パターン踏襲):

```
try release
catch err:
  if StripeRateLimitError → sleep 1s → release 再試行 1 回(同一 idempotencyKey)
     → 再失敗が StripeRateLimitError/非冪等 → throw(#1 では 3.2 が握る / #5 では UI へ)
  if isAlreadyReleasedOrMissing → return(既存)
  else throw(既存)
```

- 429 retry は **同一 idempotencyKey 再利用**(429 は未処理リクエストゆえ Stripe 仕様上安全・SDK の network retry と同方式)。状態確認先行は `releaseCompletedDowngrade` の status gate が既に担う(重複させない)。
- **1s 固定・1 回のみ・Retry-After 不使用**(Codex 指摘採用: best-effort は correctness 外ゆえ webhook では短く諦める。`cancelWithRetry` と同値構造で新規性を持ち込まない)。
- SDK `maxNetworkRetries:2` との重複なし(SDK は 429 を retry しない — `client.ts:63` 注記)。
- 効能は #1(delegate best-effort)と #5(cancel)の両方に自動で乗る(共通経路ゆえ)。**release 専用の 429 retry である契約は G-7 golden で縛る**(汎用化しない)。

## 4. Phase 構成 = commit 境界(G→R・固定)

| phase | 内容 | commit |
| ----- | ---- | ------ |
| **G** | **既存挙動の回帰 golden 先張り(green で commit)**: evaluateRelease 4 分類 / mismatch・skip・clear_direct / released handler / #5 現行順序(release→clear)/ 既存 test で未 pin の分を補強 | `test(stripe): release gate 既存挙動 golden 補強 [no-review]` |
| **R** | §3 の 4 変更を **TDD で実装**(新挙動 test を先に書き red 確認 → 実装 → green)。新挙動 test(§5 N-1〜N-7)と実装を同 commit に同梱 | `fix(stripe): 予約列 clear を release 成功から decouple`(tag 運用は §7) |

- **red test を単独 commit しない**(Codex 指摘採用): lefthook は lint のみで red commit は技術的に可能だが、中間 commit で `pnpm test` が落ちると bisect 汚染 + repo 慣行(F1 の G = 現挙動 pin)に反する。TDD の red→green は R commit **内**の作業順序として実施(superpowers TDD 準拠)。
- R は 1 commit(4 変更は挙動変更の単位として一体)。canonical review + Codex review → Critical/Important 0 → tag は「重要 Fix の裏取り」規律(§7)に従う。

## 5. test 対象挙動(G = 既存 pin / N = R 内 TDD の新挙動・7 本)

既存 test 資産(handle-stripe-event / subscription / actions の各 .test.ts + integration/stripe-webhook.test.ts)に追加。Stripe は全て mock(実 API 禁止)。

**Phase G(既存挙動・green)**: evaluateRelease 4 分類 verbatim / mismatch notifyOps / skip / clear_direct / released handler(scheduleId 一致 clear)/ deleted reset / #5 現行順序 — 既存 test で pin 済みの分は重複追加しない(不足分のみ補強)。

**Phase R 内 TDD(新挙動・red→green)**:

| # | 挙動 | pin する不変条件 |
| - | ---- | ---------------- |
| N-1 | delegate 到達 + release **throw** → 予約 3 列 clear される + handler は throw しない(200 経路)+ notifyOps 発火(payload に scheduleId/targetPriceId) | **本 fix の主命題**(旧実装で fail = red 確認) |
| N-2 | delegate 到達 + release 成功 → clear + **順序: clear が release より先**(spy 呼出順) | 順序反転 |
| N-3 | clear 済み行への再送 .updated → 0-row no-op(matched:false)・二重副作用なし | 冪等 |
| N-4 | DB 予約が**別の** scheduleId/targetPriceId(race で差替済)→ clear されない(matched:false) | 誤 clear 防止(条件付き UPDATE の存在理由) |
| N-5 | #5: release が非冪等 error で throw → clear **されない**・throw は伝播 | **#5 の順序不変を pin**(§3.3 の逆破綻防止・「共通化」誤解の防波堤) |
| N-6 | #5: release 成功 → 条件付き clear(owner=user.id scope)。scheduleId 不一致なら 0-row no-op(予約維持) | mismatch anomaly を消さない |
| N-7 | release 429 → 1s + 1 retry で成功 / 429 連続 → throw(#1 では N-1 経由で握られる)/ 429 retry は release 経路専用 | opt-1(fake timer で 1s を決定論化) |

補足: delegate の clear throw(DB 失敗)→ 伝播 + release 未実行は N-1 の裏面として 1 case 追加(§3.2 の境界を pin)。

## 6. Test Clock stg smoke(R push 後・OT 指示で CC 実走)

前提手順 = `docs/audit/2026-07-09-stripe-test-clock-reservation-verification.md`(clock 紐付き customer + app UI 経由予約 = full-fidelity 経路 (a))。

1. **主検証**: app UI で downgrade 予約(pro月額→standard月額)→ `scheduled_*` 3 列 set 確認 → period_end 直後へ advance → `ready` polling → **実 DB で `scheduled_*` 3 列 = NULL + plan=standard**(前回 orphan だった経路の実証)。
2. **#5 cancel 経路**(Codex 指摘採用・advance 不要で即検証可): app UI で downgrade 予約 → 「取消」→ 実 DB で 3 列 NULL + UI 復帰(banner 消滅・CTA 有効化)。
3. 表示是正: upgrade/settings の「変更予約中」banner 消滅・CTA 復活(DevTools MCP)。**「現プラン Pro」表示(Clerk JWT/publicMetadata stale)は本 fix の対象外・完了条件に含めない**(別件 — 監査 doc §5 症状 B)。
4. 観測: Vercel log で `.updated` 受信 200(swallowed でない)+ schedule の release 成否(best-effort の実挙動・失敗なら notifyOps Discord 到達)。
5. released webhook の発火有無を記録(開放端 phase1 の自然 release 有無の実証 — 監査未確定 #3 の回収)。
6. **release 失敗系(N-1)の smoke は unit golden で代替**(実環境で Stripe 失敗を意図的に起こせないため)— 本 spec で 1 行明記(CLAUDE.md smoke 代替規律)。

## 7. 制約・完了条件

- 制約: TypeScript strict / 既存パターン踏襲(cancelWithRetry・I-9・A-3)/ scope 外変更なし / `.env.example` 変更なし(新 env なし)/ whole-repo `pnpm lint` --max-warnings=0 exit 0。
- 完了条件: G 補強分 + N-1〜N-7(+ clear throw 裏面 case)全 green + 既存全 test green / canonical + Codex review で未解決 Critical 0・Important 0 / **重要 Fix(決済)ゆえ [reviewed] は Test Clock smoke 後 — push→smoke 順で amend 窓が閉じるため session doc を正記録とする(恒久規律)**。
- Sprint 2 境界: 本 sprint は integration_failures に**一切触れない**。§3.2 の catch が Sprint 2 の dual-write 挿入点(コメントで seam 明示)。

## 8. CC 判断点(確定 7 判断の範囲内での具体化・OT veto 対象)

1. §3.1: 条件付き clear は **SubKey(owner scope)+ 2 列 match の別口関数**(既存 repository pattern 整合)。
2. §3.3: **#5 は順序不変**(clear 先行は #1 のみ)+ 条件 scheduleId は release した `pending.scheduleId`(mismatch 時に DB を触らない安全側)。
3. §3.2: best-effort の catch は call site(`releaseCompletedDowngrade` の throw 契約は不変)+ **clear throw は握らない**境界。
4. §3.4: 429 retry は `releaseScheduleIdempotent` 内蔵・汎用 helper 非新設(rule-of-three 未満)・同一 idempotencyKey 再利用・1s 固定 1 回。
5. §4: R = 1 commit(4 変更を挙動変更の単位として一体化)。red test の単独 commit はしない(TDD red→green は R 内)。
6. §3.2 手順 0: dbTargetPriceId null(I-9 破損)は notifyOps + 予約維持(clear せず観測)。

## 9. Codex cross-check 統合記録(帰属)

- 実行: `scripts/ai/codex-plan-review.sh downgrade-orphan-clear-decouple`(2026-07-10・detector PASS)。raw = `docs/codex/2026-07-10-plan-downgrade-orphan-clear-decouple.md`。
- **Codex 独立論点と CC spec の一致**(双方が独立に同結論): clear decouple の主命題 / 条件付き冪等 clear の必要性 / **#1・#5 の順序非対称**(発効後 vs 発効前・逆 orphan)/ evaluateRelease 4 分類不変 / 429 は補助 / released・clear_direct 無条件 clear 継続。
- **Codex 指摘を採用して spec を修正した点(帰属: Codex)**:
  1. §3.1 owner scope(SubKey)を条件付き clear に追加(CLAUDE.md Clerk-3 整合)。
  2. §3.2 clear throw の境界明記(握らない・release に進まない・回復は次回 .updated)。
  3. §3.2 transaction 境界明記(clear auto-commit 後に release)。
  4. §3.2 手順 0: dbTargetPriceId null guard(`!` assert 廃止 → notifyOps + 予約維持)。
  5. §3.2/§3.4 notifyOps payload pin(targetPriceId 追加)+ 429 は 1s 固定 1 回・Retry-After 不使用の明文化。
  6. §4 G/R 分担是正(red test 単独 commit 廃止 → G = 既存 pin green / 新挙動は R 内 TDD)。
  7. §6 smoke に #5 cancel 経路追加 + 「現プラン Pro」(JWT stale)の対象外明記。
  8. §5 N-7 に「429 retry は release 経路専用」の契約 pin / released handler が targetPriceId を見ない理由の明文化(§3.1)。
- **不採用(理由付き)**: 0-row no-op への notifyOps(正常系と区別不能でノイズ化 — matched 返却 + golden で判別可、§3.1)/ 条件付き clear への「customer 条件を含めない理由の明文化」で済ます案(含める側を採用)/ Retry-After 対応(best-effort は短く諦める方針)。
- **Codex リスク指摘のうち Sprint 2 送り**: best-effort release 失敗の永続記録(確定 7 のとおり notifyOps のまま・catch 位置と payload を dual-write しやすく設計済 §3.2)。

## 参照

- 現行コード: `lib/stripe/handle-stripe-event.ts:195-253`(gate)/ `lib/stripe/subscription.ts:198-289`(release 系)/ `lib/stripe/subscription-repository.ts:179-192`(clearReservation)/ `app/(app)/app/upgrade/actions.ts:218-266`(cancelDowngrade)/ `lib/stripe/client.ts:61-96`(SDK retry + cancelWithRetry)
- 監査 4 本(冒頭)+ Test Clock 手順 doc
</content>
