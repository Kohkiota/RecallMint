# Downgrade 予約列 orphan correctness fix(clear decouple)— implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。steps は checkbox で追跡。

**Goal:** 予約 3 列 clear を release API 成功への依存から切り離し、downgrade 発効時の恒久 orphan を根絶する(spec: `docs/superpowers/specs/2026-07-10-downgrade-orphan-clear-decouple-design.md` 承認済・確定 7 判断 + CC 判断点 6 は再議論しない)。

**Architecture:** repository に owner-scope + 2 列 match の冪等条件付き clear 口を 1 つ追加し、#1(webhook delegate)は「clear 先行 → best-effort release」に順序反転、#5(cancelDowngrade)は順序不変で clear のみ条件付き化。opt-1 = release の 429 app retry(1s 固定 1 回)。

**Tech Stack:** 既存のみ(Vitest / drizzle / stripe-node mock)。新規ライブラリ・schema 変更・新 env なし。

## Global Constraints(全 task 共通)

- 触る 4 file + test のみ(spec §2)。`evaluateRelease` 4 分類 verbatim / `releaseCompletedDowngrade` の throw 契約・status gate 不変 / upgrade・deleted・projection・released・clear_direct 経路不変。
- **#1/#5 非対称が核心**: 順序反転(clear 先行)は #1 のみ。#5 は release 成功 → clear の順序不変(逆にすると DB 予約なし・Stripe schedule 生存 → 期末に意図しない downgrade の逆破綻)。call site コメントで明示。
- Stripe は全 test で mock(実 API 禁止)。TS strict。YAGNI(汎用 retry helper 非新設)。
- per-task gate: `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm test`(full)/ 最終 task で `pnpm build` — 全 exit 0。
- commit 境界: G = green・`[no-review]` / R = 1 commit(4 変更一体)・**red test を単独 commit しない**(TDD red→green は R 内の作業順序)。R の tag: 重要 Fix(決済)ゆえ push→Test Clock smoke 後に session doc を [reviewed] 正記録(恒久規律・force-push しない)。
- R は canonical review(superpowers:requesting-code-review デフォルト経路・template 改変禁止)+ Codex review(`scripts/ai/codex-review.sh`)を **commit 前に** pass(未解決 Critical 0・Important 0)。
- Sprint 2 seam: §3.2 の best-effort catch に `// Sprint 2: integration_failures dual-write 挿入点` コメントを残す。integration_failures には一切触れない。

## 参照事実(2026-07-10 現 HEAD 走査済・task から参照・再調査不要)

### A. 既存 test の pin 状況(G で重複追加しない)

| 挙動 | pin 済み場所 |
| ---- | ------------ |
| evaluateRelease 4 分類 + null 境界(6 本) | `lib/stripe/domain/subscription-aggregate.test.ts:179-246` |
| delegate: released/already_terminal → clear・skipped → 維持・skip(price 不一致) | `app/api/webhooks/stripe/route.test.ts:812-917`(**R で書換対象**) |
| clear_direct 方向2 ×3 / mismatch notify / 予約なし gate 全 skip | `route.test.ts:918-1091` |
| released handler: clear + 0-row 冪等 + recovery + 先着後着 | `route.test.ts:1089-1170` |
| deleted reset 3 列 clear | `route.test.ts:~1194` |
| releaseCompletedDowngrade status gate 全 6 分岐 + race 保険 | `lib/stripe/subscription.test.ts:519-622` |
| releaseScheduleIdempotent: 呼出形 + resource_missing + already-released | `subscription.test.ts:474-518`(**429 は未 pin = N-7**) |
| #5: 成功 → clear(user スコープ)/ NO_SCHEDULE / A-3 群 | `app/(app)/app/upgrade/actions.test.ts:796-921` |
| repository 観点1-5(owner WHERE verbatim / I-9 / SaveResult / 0-row) | `lib/stripe/subscription-repository.test.ts` |

**G の不足 = 1 本のみ**: 「#5 cancelScheduledDowngrade が throw → DB clear 未呼出(順序の pin)」が存在しない。

### B. R で書換必須の既存 test(挙動変更の正体)

1. `route.test.ts:812`(released で clear)→ 新: clear は release **前**。
2. `route.test.ts:845`(already_terminal でも clear)→ 新: release 結果非依存の clear に統合。
3. `route.test.ts:871`(skipped → clear しない)→ **新挙動では clear される**(delegate 到達 = 発効済)。
4. `actions.test.ts:855`(成功後 3 列 clear・user スコープ)→ `clearReservationMatching`(owner=id + 2 列 match)assert に更新。
5. `subscription-repository.test.ts:181-205` 観点3 allowlist に `clearReservationMatching` を追加(forbidden regex は不変で PASS するが、予約 writer allowlist の意味を保つため明示追加)。

### C. 実装 anchor(spec §3 の対応)

- 条件付き clear 口: `subscription-repository.ts`(`clearReservation` :181-192 の直後に併設)。signature = `clearReservationMatching(tx, key: SubKey, match: {scheduleId: string; targetPriceId: string})` → `whereFor(key) AND eq(schedule) AND eq(target)` + 既存 `RETURNING_SHAPE` → `SaveResult`。
- #1 delegate: `handle-stripe-event.ts:237-250` を spec §3.2 の手順 0(null guard + notifyOps)→ 1(clear 先行・`{by:'stripeCustomerId', value: customerId}`)→ 2(best-effort release・catch → notifyOps `{eventId, customerId, scheduleId, targetPriceId, error, environment, timestamp}`)に置換。**clear throw は握らない / release throw は握る**。tx 境界: clear は単発 UPDATE(auto-commit・DbExecutor)で、await 完了後に release へ進む(同一 tx にしない)。
- **clear の `matched` は release を gate しない**(Codex 論点で確定): matched:false(再送/race)でも release へ進む — dbScheduleId は gate 検証済(sub.schedule 一致)の発効済 schedule であり、release は status gate(`already_terminal`)が過剰呼出を吸収する。「release 結果を clear に gate しない」の対称。
- notifyOps の environment/timestamp は **call site が渡す**(handle-stripe-event 既存全 notifyOps と同型)。test は call site 渡し値を assert(route.test.ts mismatch test と同型)。
- #5: `actions.ts:243` の `clearReservation` → `clearReservationMatching({by:'id', value: user.id}, {scheduleId: pending.scheduleId, targetPriceId: user.scheduledTargetPriceId})` 置換のみ(順序・A-3 catch 不変)。`user.scheduledTargetPriceId` は **明示 guard**(null なら既存 `NO_SCHEDULE` throw に合流・non-null assertion 禁止 — TS strict の narrowing 充足)。
- 429: `subscription.ts:198-208` `releaseScheduleIdempotent` の catch 先頭に `StripeRateLimitError → 1s sleep → 同一 idempotencyKey で 1 回再試行` を挿入(`cancelWithRetry` `client.ts:88-96` と同値構造)。

---

## Phase G(1 commit: `test(stripe): #5 cancel 順序 pin 補強 [no-review]`)

### Task 1: G 補強(1 本)

- **目的**: #5 の現行順序「release 失敗 → clear されない」を pin(R の順序不変を通貫保証する防波堤 = spec N-5 の実体。R 後も green 維持)。
- **制約**: 現行実挙動を先に手元実行で観測してから assert(期待値の捏造禁止)。既存 pin(§A)と重複追加しない。
- **手順**: `actions.test.ts` cancelDowngrade describe に「`cancelScheduledDowngrade` reject(非冪等 error)→ throw 伝播 + `db.update` 未呼出(予約維持)」1 本 → 現 HEAD で green 確認 → commit。
- **完了条件**: 新 test green + 既存全 test green + per-task gate exit 0。

## Phase R(1 commit: `fix(stripe): 予約列 clear を release 成功から decouple`・tag は smoke 後 session doc)

### Task 2: R — 4 変更を TDD で(red→green は本 task 内の作業順序)

- **目的**: spec §3 の 4 変更(repository 口 → #1 順序反転 → #5 条件付き化 → 429 retry)を一体実装し、新挙動 N-1〜N-7 を pin。
- **制約**: Global Constraints 全部 + §C の anchor どおり。既存 test 書換は §B の 5 点のみ(それ以外の既存 test に触れない)。
- **TDD 順序**(各 sub-step で red 確認 → 最小実装 → green):
  1. **repository**: `clearReservationMatching` の test 先行(観点1 追補: owner WHERE + 2 列 match の AND 合成 verbatim / 観点2: 3 列一括 null / 観点4: SaveResult shape / 観点5: 0-row → matched:false)→ red(関数不在)→ 実装 → green。観点3 allowlist 更新(§B-5)。
  2. **#1 delegate**: N-1(release throw → clear 済 + handler 非 throw + notifyOps payload)/ N-2(clear が release より先 — mock 呼出順 assert)/ N-3(clear 済み再送 → matched:false・**release は status gate `already_terminal` で release API 未呼出・notifyOps なし** = 二重副作用なしの定義)/ N-4(別予約 race → clear されない(matched:false)・release へは進む)/ 裏面(clear throw → 伝播 + release 未呼出)を route.test.ts に追加 → **N-1 が旧実装で fail することを必ず観測**(red 根拠: 旧 delegate は release throw で clear 到達不能)→ §C の配線 → green。§B-1〜3 の既存 3 本を新挙動に書換。手順 0 の null guard(dbTargetPriceId null → notifyOps + 予約維持)も 1 case。配線コメント 2 点: released handler(scheduleId 単独)と delegate(2 列 match)の条件差の理由(spec §3.1)/ Sprint 2 seam。
  3. **#5**: N-6(成功 → `clearReservationMatching` 引数 pin / scheduleId 不一致 → 0-row で予約維持)+ targetPriceId null → NO_SCHEDULE guard 1 case を actions.test.ts に追加 → red(旧は無条件 clear)→ 置換 → green。Task 1 の pin(N-5 相当)が green のままであることを確認。§B-4 書換。call site コメントで #1 との順序非対称を明示。
  4. **429**: N-7(429 → fake timer 1s → 同一 key 再試行 → 成功 / 429 連続 → throw / release 経路専用)を subscription.test.ts に追加(fake timer の promise flush 手順は `client.test.ts` の cancelWithRetry test pattern を参照)→ red → 実装 → green。
- **完了条件(数え上げ)**: N-1〜N-7 + null guard 2 case(#1 手順 0 / #5 targetPriceId)+ clear throw 裏面 1 case + 書換 5 点(§B)全 green / 既存全 test green / per-task gate + `pnpm build` exit 0 / **canonical + Codex review pass(Critical 0・Important 0)→ commit 直前宣言 → commit(review pass 後 commit までに差分を変えない — 変えたら再 review)**。

## 最終

### Task 3: whole-repo gate + session doc + smoke 準備

- **目的**: sprint 完了 gate と smoke 引き継ぎの確定。
- **手順**: whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` + `pnpm test` + `pnpm build` 全 exit 0(報告に「whole-repo lint exit 0 確認済」明記)→ session doc(`docs/superpowers/sessions/2026-07-10-downgrade-orphan-clear-decouple.md`)に実装記録 + smoke checklist を書き `docs(session)` commit(**scope 外変更ではない** — CLAUDE.md「docs は必ず即 commit・[no-review]」の恒久規律)→ stop checkpoint 報告(push は OT)。
- **Smoke(push 後・OT 指示で CC が DevTools MCP 実走・spec §6 verbatim)**: ① Test Clock: app UI downgrade 予約 → `scheduled_*` set 確認 → advance → ready polling → **実 DB 3 列 NULL + plan 発効** ② #5 cancel 経路(advance 不要): 予約 → 取消 → 3 列 NULL + UI 復帰 ③ banner 消滅・CTA 復活(「現プラン Pro」JWT stale は対象外)④ Vercel log: .updated 200 + release 成否 ⑤ released webhook 発火有無の記録 ⑥ release 失敗系は unit golden 代替(本 plan で明記済)。前提 = `docs/audit/2026-07-09-stripe-test-clock-reservation-verification.md`(罠 1-5・clock 紐付き customer 必須)。
- **完了条件**: 全 gate exit 0 + session doc commit 済 + 停止報告(smoke 結果を見て [reviewed] session doc 正記録 → prod 判断は OT)。

## Codex plan cross-check 統合記録(帰属)

- 実行: `scripts/ai/codex-plan-review.sh downgrade-decouple-plan`(2026-07-10・detector PASS)。raw = `docs/codex/2026-07-10-plan-downgrade-decouple-plan.md`。
- **独立論点の一致**(Codex が spec と同結論を独立導出): #1/#5 非対称 / owner scope 必須 / clear・release の障害境界 / tx 境界 / I-9 null guard / released 無条件 clear 温存 / 429 スコープ / G=既存・R=新挙動の境界。
- **採用 9 件(帰属: Codex)**: ① §C「clear の matched は release を gate しない」明文化(matched:false でも release 続行 — 実装者が迷う分岐)② N-3「二重副作用なし」の定義具体化(release API 未呼出 + notifyOps なし)③ #5 targetPriceId null は NO_SCHEDULE guard 合流(non-null assertion 禁止)④ Task 2 完了条件を数え上げ化(null guard 2 case を N 群と別立て)⑤ notifyOps payload の生成責務明記(call site 渡し・test は渡し値 assert)⑥ 429 fake timer は cancelWithRetry test pattern 参照 ⑦ session doc commit の規律根拠明示 ⑧ review pass 後 commit まで差分不変(変えたら再 review)⑨ released(scheduleId 単独)vs delegate(2 列)の条件差理由を配線コメント化。
- **不採用(理由付き)**: whole-repo gate の per-task/最終重複削減(CLAUDE.md sprint 完了 gate 規律 + F1-F3 実績で許容)/ REQUIRED SUB-SKILL header の分離(CLAUDE.md 実装方式既定の運用規律・設計要件でないことは本記録で明示)/ 0-row 通知再評価・Retry-After・R 1 commit 分割(いずれも spec 確定済 — 0-row 通知は Sprint 2 論点として送り)。
- **リスク受容(spec 確定済の意図的トレードオフ)**: release 失敗の可視性が Discord/Vercel log 依存(Sprint 2 で永続化)/ Retry-After 無視による release 成功率の限定(correctness は clear で担保)。
