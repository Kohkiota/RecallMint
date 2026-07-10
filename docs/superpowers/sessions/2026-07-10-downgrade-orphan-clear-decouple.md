# Downgrade 予約列 orphan clear decouple — 実装 session log

- 日付: 2026-07-10 / branch `develop` / base `77cf59a`(plan commit)
- spec: `docs/superpowers/specs/2026-07-10-downgrade-orphan-clear-decouple-design.md`
- plan: `docs/superpowers/plans/2026-07-10-downgrade-orphan-clear-decouple.md`
- 監査 4 本: `docs/audit/2026-07-10-{stripe-downgrade-reservation-clear-bug, webhook-external-dependency-pattern-audit, external-api-retry-idempotency-audit, reconciliation-infra-factfinding}.md`
- 方式: `superpowers:subagent-driven-development`(fresh Opus implementer per task・実装 subagent は commit せず controller が review 後 commit)

## 成果(bug の根絶)

downgrade 発効時、予約 3 列 clear が Stripe `release` API 成功に gate され、release throw で**恒久 orphan**(self-heal なし・webhook 常時 200 で Stripe 再送なし・開放端 phase1 で `subscription_schedule.released` も来ず)。→ **clear を release 成功から decouple**(clear 先行・冪等条件付き UPDATE)して根絶。

## commit(develop・push は OT)

| commit | 内容 | tag |
| ------ | ---- | --- |
| `73055ae` | Task 1 (G): #5 cancelDowngrade 順序 pin 補強(release reject → clear 未到達) | [no-review] |
| `cb7ce29` | Task 2 (R): 予約列 clear を release 成功から decouple(4 変更一体) | [reviewed] |
| (docs) | Codex R review artifacts | [no-review] |

## 実装内容(R = 4 変更)

1. **repository `clearReservationMatching`**(`subscription-repository.ts`): `WHERE owner(SubKey) AND schedule=? AND target=?` の 3 列一括 null clear(I-9 維持)。0-row = 正常 no-op(matched:false・notifyOps なし)。既存 `clearReservation`(無条件)は released/clear_direct 用に温存。
2. **#1 webhook delegate 順序反転**(`handle-stripe-event.ts`): 手順0 = dbTargetPriceId null guard(notifyOps + 予約維持)/ 手順1 = clear 先行(`clearReservationMatching`・release 成否非依存・**clear throw は握らず伝播**)/ 手順2 = best-effort `releaseCompletedDowngrade`(try/catch → notifyOps・**release throw は握る**)。release 戻り値で clear を分岐しない。
3. **#5 cancelDowngrade**(`actions.ts`): **順序不変**(release → clear)。clear のみ `clearReservationMatching`(owner=id + schedule/target)へ差替。`user.scheduledTargetPriceId === null` は NO_SCHEDULE guard に合流(non-null assertion なし)。
4. **429 retry**(`subscription.ts` `releaseScheduleIdempotent`): `StripeRateLimitError` → 1s 固定・1 回・同一 idempotencyKey 再試行。**retry も already-released/missing swallow を honor**(review fix)。2 度目 429 は伝播。release 経路専用。

**2 gate 対称性**: (a) release 結果は clear を gate しない (b) clear の matched は release を gate しない(status gate が過剰 release を `already_terminal` で吸収)。**Sprint 2 seam**: 手順2 の best-effort catch = `integration_failures` dual-write 挿入点(コメント明示)。

**不変(触っていない)**: `evaluateRelease` 4 分類 / `releaseCompletedDowngrade` status gate・throw 契約 / released・clear_direct・deleted・projection・upgrade 経路 / schema。新 lib/env なし。

## test(G = 既存 pin / N = 新挙動 TDD)

- Task 1: #5 順序 pin 1 本(N-5 の恒久防波堤)。
- Task 2: N-1(release throw でも clear + handler 非 throw)/ N-2(clear が release より先)/ N-3(再送 matched:false・release は already_terminal で API 未呼出)/ N-4(別予約 race → clear されず・release へは進む)/ N-6(#5 成功 clear + mismatch 0-row)/ N-7(a/b/c)(429 retry・swallow)+ 裏面(clear throw 伝播・release 未呼出)+ null-guard 2。既存 test 書換 5 点(delegate 旧挙動反転 + repository allowlist + #5 clear assert)。
- **N-1 red 確認済**(旧実装で release throw → clear 到達不能 = 主命題の証明)。

## review 経路(全 pass)

- **canonical**(`superpowers:requesting-code-review` デフォルト経路・general-purpose Opus・template `## Read-Only Review` 改変なし)+ **Codex**(`codex-review.sh`)。
- round1: canonical + Codex が**独立に同一 Important 1 件**を検出(429 retry が idempotent swallow を失う = #5 user path の regression)→ fix → 焦点再レビュー **approve** + **Codex round2 Crit0/Imp0/Minor0**。
- **最終 whole-branch review**(Opus・G+R 一体・`77cf59a..HEAD`)= **Ready to merge**(Crit0/Imp0/Minor2)。全 invariant を runtime 合成で検証。
- Codex artifacts: `docs/codex/2026-07-10-downgrade-decouple-R{,-round2}.md`。
- **Minor 2(記録のみ・非 blocking)**: (i) `actions.test.ts` `db.update 成功` の fixture `sched_y` vs `sched_x` = DB mock が WHERE を filter しないため無害。(ii) 二重 429 test が call-args 非 assert = key 再利用は N-7(a/c) で pin 済ゆえ十分。

## gate(sprint 完了)

whole-repo `pnpm lint`(--max-warnings=0)exit 0 / `pnpm typecheck` exit 0 / `pnpm test` **3186 passed** / `pnpm build` exit 0。**whole-repo lint exit 0 確認済**。

## Test Clock stg smoke = R commit `cb7ce29` の [reviewed] 正記録(OT 実機・2026-07-10・全 PASS)

決済 fix ゆえ **本 section が R commit `cb7ce29` の [reviewed] 正記録**(push→smoke 順で amend 窓が構造的に閉じる・push 済 commit の force-push はしない — 恒久規律 6cd468a)。Test Clock 実機は CC 環境で不可のため **OT が実機実走**。前提手順 = `docs/audit/2026-07-09-stripe-test-clock-reservation-verification.md`(clock 紐付き customer 必須・罠 1-5)。

- [x] **① 主検証(発効経路 #1)= PASS**: app UI で downgrade 予約(pro月額→standard月額)→ `scheduled_*` 3 列 set → clock advance(period_end 越え)→ `ready` → **実 DB で plan=standard / interval=month 発効 + `scheduled_*` 3 列 全 NULL**。**前回(fix 前)は同一操作で予約列が orphan 残留した箇所が今回 clear = correctness fix 実証**。
- [x] **② #5 cancel 経路(advance 不要)= PASS**: app UI で downgrade 予約 → 「取消」→ **`scheduled_*` 3 列 NULL + subscription_schedule status=released**(順序不変 release→clear が正常動作・逆破綻なし)。
- [x] **③ 表示是正 = PASS**: `scheduled_*`=NULL により「変更予約中」banner 消滅・CTA 復活は決定的(①② で DB=NULL 確認済 / banner = `scheduledDowngradeScheduleId != null` 由来)。**「現プラン Pro」(Clerk JWT stale)は対象外**(監査 §5 症状 B)。
- [x] **④ 観測 = PASS(fix 核心の実 driver 証拠)**: **advance 中に Discord へ `advancement underway`(release API が Test Clock advance 中に拒否)発火。それでも `scheduled_*` は NULL** = **clear が release 成功に依存せず先行実行された(順序反転 #1)の実 driver 証拠**。best-effort release が失敗しても orphan にならないことを本番相当 driver で実証。
- [x] **⑤ released webhook = 記録済**: #5(user 起点 release)= released 発火。#1(advance)= release が `advancement underway` で拒否 → released 非発火だが **clear は先行済ゆえ無影響**(開放端 phase1 で自然 release が来なくても correctness が保たれる = 監査未確定 #3 の実証: released 回収経路に依存しない設計が効いた)。
- [x] **⑥ release 失敗系 = unit golden(N-1)+ 実 driver 二重実証**: 429 の人工発生は不可ゆえ unit で pin(N-1/N-7)。加えて ④ の `advancement underway` が「release 失敗でも clear」を**本番相当 driver で実再現**。冪等 clear 口(owner/2列/0-row)・429 retry も unit で pin 済(実機再現不要)。

### smoke 結論
**全項目 PASS。fix の核心命題(clear を release 成功から decouple・#1 順序反転)を、release が実際に拒否された driver 条件下で実証。** #5 の順序不変(release→clear・逆破綻なし)も実機確認。→ **R commit `cb7ce29` は本 section をもって [reviewed] 正記録確定**。

## 後続

- **Sprint 2**: `integration_failures` 永続記録テーブル + 回収 cron(fact-finding = `docs/audit/2026-07-10-reconciliation-infra-factfinding.md`)。本 sprint の手順2 catch が dual-write 挿入点。
- **掃除(別・CC 実行不可)**: test clock 2 件 + test10/11 users 行削除 = OT 手動(Stripe Dashboard + Supabase SQL・`rk_test_` に `billing_clock_write` 権限なし・psql 不在)。

## STOP checkpoint
whole-repo gate 全 exit 0 + 4 段 review(canonical + Codex×2 + 最終 whole-branch)= Crit0/Imp0 pass。**push 済(origin/develop = 13e66aa)+ Test Clock stg smoke 全 PASS(OT 実機・上記 section)= R commit `cb7ce29` [reviewed] 正記録確定**。**残 = prod 反映判断(OT 専権)+ 掃除(test clock 2 件 / test10・11 users 行 = OT 手動)**。
</content>
