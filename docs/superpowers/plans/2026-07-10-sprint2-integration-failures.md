# Sprint 2: integration_failures 統一台帳 + Discord dual-write — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。steps は checkbox で追跡。

**Goal:** 課金・外部連携の失敗を Discord notify に加えて DB テーブル `integration_failures` にも additive に残し、手動 SQL / tsx script で棚卸し・回収できる記録基盤を作る(回収の自動化・cron はしない)。

**Architecture:** `deletion_failures` を 4 軸判別列(service / operation / workflow / failure_code)+ 型付き ref 列 + context jsonb に一般化した統一テーブルへ吸収し廃止。4 軸語彙の SSoT はコード側 catalog(`INTEGRATION_FAILURE_CATALOG` 7 entry)に一元化(DB CHECK・`$type` union・FK なし)。記録 helper `recordIntegrationFailure`(INSERT→notifyOps 順)を新設し、既存 4 系統の `notifyOps` 呼び出しを byte 不変で置換する。

**Spec(凍結・正本):** `docs/superpowers/specs/2026-07-10-sprint2-integration-failures-design.md`(§ 参照は本 spec)

## Global Constraints(spec §7 verbatim・全 task 共通)

1. webhook handler は常に 200(既存不変条件)。helper 追加でこの経路に新しい throw を持ち込まない(§5 契約 3/4)。
2. Sprint 1 の clear→release 順序・golden test に触れない(catch 内部への 1 呼び出し追加のみ)。
3. Discord 通知は subject / payload とも正常経路 byte 不変(dual-write は「追加」であり「変更」でない。例外は §5 の台帳書込失敗フラグのみ)。
4. `retry_count` / `next_retry_at`(default 以外)/ `resolution_note` を読み書きするコードを作らない(dormant 列)。
5. 4 軸値の書込は catalog 経由のみ(自由文字列の 4 軸を helper 入力に持たない)。
6. 新規 env なし(`.env.example` 変更なし)。context に新規 secret を混入させない。
7. spec 凍結。実装中に仕様変更が要るなら停止して OT 相談。
8. 全 commit green(typecheck / test を赤いまま task 間に持ち越さない)。

**共通 gate(各 task)**: `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm test`(full)全 exit 0。schema 変更 sprint ゆえ typecheck 必須(依存 / Next / Node / lockfile は触らないため install / build の追加 gate は不要)。

**review 経路(feat/fix task 共通)**: canonical `superpowers:requesting-code-review`(default 経路・general-purpose subagent・template 改変禁止)pass → `scripts/ai/codex-review.sh <topic>` → CC が canonical 指摘 + Codex 保存 md 両方を読み、未解決 Critical 0 + Important 0 まで反復(上限 3 周)→ commit 直前宣言 4 点 → commit。**課金・削除経路に触れるため「重要 Fix の裏取り」規律を適用**: review pass → commit(tag 無し)→ push 後 stg smoke → session doc を [reviewed] の正記録とする(push 済 commit の amend はしない。Sprint 1 前例)。docs(session log)は `docs(_)` + `[no-review]` で即 commit。

**stg smoke 代替(spec §8・1 行明記)**: 失敗経路の実発火は stg で誘発困難ゆえ unit test を正とし、smoke は ① migration 適用確認(table 存在)② 正常経路 regression(subscription 更新 / user 削除フローが従来どおり)に限定する。

## 参照事実(2026-07-10 HEAD 走査済・再調査不要)

- schema: `deletionFailures` = `lib/db/schema.ts:214-227`(+ 型 export `:800-801` 付近)。`jsonb` / `integer` は import 済。
- 手本: `recordFailure` = `lib/clerk/handle-clerk-event.ts:217-248`(DB INSERT → notifyOps 順)。`notifyOps` = `lib/ops.ts:23-79`(production で URL 未設定 throw の既存契約)。
- 配線 site: ① `lib/stripe/handle-stripe-event.ts:274-287`(autorelease catch・Sprint 1 seam コメント :277)② 同 `:234-243`(mismatch case)③ `lib/auth/clerk-metadata.ts:61-67`(sync 失敗・戻り値 `{ok:false}` 契約)④ `handle-clerk-event.ts:217-248`(recordFailure・呼出 3 箇所 = cancel `:116` / list・customer_missing `:126-137` / data_deletion `:194`)。
- 既存 test: site 1/2 = `app/api/webhooks/stripe/route.test.ts`(mismatch / autorelease failed の case 既存)。site 4 = `app/api/webhooks/clerk/route.test.ts`(`deletionFailures` INSERT を多数 assert = 追随対象)。helper 単体 test は新規。
- migration 採番: 既存最新 `0021_flowery_lifeguard.sql` → 本 sprint は `0022`(生成は **Task 3 で 1 回だけ** = CREATE + DROP が 1 本に入る)。

---

## Task 1: schema 追加(additive)+ catalog + helper `lib/integration-failures.ts`(TDD)

- **目的**: `integrationFailures` table + 型 export(`IntegrationFailure` / `NewIntegrationFailure`)を `lib/db/schema.ts` に**追加**し、spec §5 の `INTEGRATION_FAILURE_CATALOG`(7 entry・4 軸値 verbatim)+ `recordIntegrationFailure` を新設。
- **制約**: `deletionFailures` は**この task では残置**(handle-clerk-event の import を壊さない = commit green 維持。DROP は Task 3)。migration 生成もしない(Task 3 で 1 回)。schema は spec §4 verbatim: 4 軸列に `$type<>` なし・FK なし・CHECK なし・index PK のみ・user_id / error_message nullable・context notNull jsonb・retryCount default 0。helper 契約 = spec §5: catalog key 入力(自由文字列 4 軸不可)/ INSERT→notifyOps 順 / INSERT 失敗は握って `logger.error`(event: `integration_failures.insert_failed`)+ context に `ledgerWriteError: <msg>` 追記で notifyOps 継続(自 table 再帰なし)/ notifyOps throw は伝播 / `import 'server-only'` は付けない(`@/lib/db` が保証)。
- **手順**:
  - [ ] helper unit test を先に書く(mock DB / mock notifyOps・route.test.ts パターン踏襲): (a) 7 catalog key → 4 軸値が catalog どおり INSERT (b) ref / context verbatim INSERT (c) INSERT→notifyOps 呼出順 (d) INSERT 失敗 → throw-safe + `logger.error` の event 名 = `integration_failures.insert_failed` を assert + `ledgerWriteError` 付き notifyOps 継続 (e) notifyOps throw の伝播 (f) **byte 不変の経路分離**: 成功経路 = notifyOps に渡る context が入力と完全一致 / INSERT 失敗経路 = `ledgerWriteError` 追加のみ(他 field 不変)。**入力 context object は mutate しない**(`ledgerWriteError` は notifyOps へ渡す派生 object にのみ付与・入力への副作用なしを assert)(g) **catalog 全 entry の 4 軸 tuple が一意**(将来 entry 追加時の識別性事故を防ぐ)→ red 確認。
  - [ ] schema 追加 + catalog + helper 実装 → green 確認。
  - [ ] gate(lint / typecheck / full test)→ review 経路 → commit。
- **完了条件**: unit (a)-(f) green + gate exit 0 + review pass(Critical 0 / Important 0)+ commit。

## Task 2: 配線 site 1-3(stripe autorelease / gate mismatch / clerk sync)(TDD)

- **目的**: spec §6 表の site 1-3 の `notifyOps(...)` を `recordIntegrationFailure(...)` に置換(subject / context は byte 不変で helper に渡し、ref 列を追加)。
- **制約(spec §6)**: site 1 = key `stripe_release`・ref stripeCustomerId / stripeSubscriptionId(=sub.id)/ scheduleId(=dbScheduleId)・errorMessage = caught err・**seam コメント(:277)を削除**。site 2 = key `stripe_gate_mismatch`・同 ref・errorMessage NULL(subScheduleId は context 内)。site 3 = key `clerk_sync`・ref clerkId / userId(=input.dbUserId があれば)・**戻り値 `{ok:false}` 契約不変・404 silent skip は記録対象外のまま**。Sprint 1 golden test 不干渉(Global 2)。
- **site 3 workflow=null の可観測性(spec §6 の plan 確認事項・意図的判断)**:
  - [ ] 現 notifyOps payload(`clerkId` / `keys` / `error`)に呼出元識別が実在するか実コードで再確認する。**先行調査の事実**: `keys` は更新 metadata key の配列で、plan sync = `['plan']` / user.created 初期 sync = `['dbUserId','plan']` と**傾向は推測できるが確定判別列ではない**(backfill script も `['dbUserId','plan']` を送るため初期 sync と重なる)。
  - [ ] 判断 = **「厳密判別は不能を許容」を採用**(workflow=null 維持・override 引数は入れない=4 軸原則。keys による傾向推測は可能、という補足付き)。この判断は **catalog の `clerk_sync` entry 近傍コメント**(呼出 site コメントより保守されやすい)+ session doc に記録する(未確認のまま null にしない、を充足)。
- **手順**:
  - [ ] site 1/2: `stripe/route.test.ts` の既存 case(mismatch / autorelease failed)を「失敗発火 → integration_failures 行(catalog key の 4 軸 + ref)+ Discord subject 不変」の assert に拡張 → red → 配線実装 → green。
  - [ ] site 3: clerk-metadata の test を helper 呼出前提に更新(`{ok:false}` 不変 / 404 skip は記録なしを維持 assert)→ red → 配線実装 → green。
  - [ ] notifyOps throw × webhook 200 の相互作用は **helper unit (e) + 既存 outer catch の文書化契約(`lib/ops.ts` の misconfig fail-fast)で担保**とし、配線 test では再テストしない(既存挙動の surface は不変 = spec §5 契約 4。ここは意図的判断)。
  - [ ] gate → review 経路 → commit。
- **完了条件**: site 1-3 test green + workflow=null 判断の記録 + gate exit 0 + review pass(Critical 0 / Important 0)+ commit。

## Task 3: site 4 置換 + deletion_failures 全廃 + migration 生成(TDD)

- **目的**: `recordFailure`(handle-clerk-event.ts)の中身を helper 呼出に置換し(key = `deletion_cancel` / `deletion_list` / `deletion_customer_missing` / `deletion_data`・ref = userId / clerkId / stripeSubscriptionId(=subId)・subject / context byte 不変)、`deletionFailures` を schema・型 export ごと削除、migration を 1 本生成。
- **制約**: spec §6 site 4。deletionFailures 参照の全廃(schema / handle-clerk-event import / clerk route.test)。migration はこの task で **1 回だけ** `pnpm db:generate` → `CREATE TABLE integration_failures` + `DROP TABLE deletion_failures` の**両方**が 1 本(0022 相当)に出ることを**目視**(片方欠落なら STOP)→ `pnpm db:migrate`(dev)適用。zero-users ゆえ DROP 無条件安全(spec §9)。
- **手順**:
  - [ ] `clerk/route.test.ts` の `deletionFailures` INSERT assert(cancel / list / customer_missing / data_deletion 全 case)を `integrationFailures` + 対応 catalog key(4 軸値)前提に書き換え → red。
  - [ ] recordFailure 置換(subject 2 種の分岐 = 既存 verbatim 維持)+ schema から `deletionFailures` / 型 export 削除 + import 整理 → green。
  - [ ] `pnpm db:generate` → 生成 SQL 目視(CREATE + DROP 両出)→ `pnpm db:migrate` → typecheck。db:migrate が環境制約(DB 接続不可)で実行不能な場合は SQL 目視 + typecheck までで本 task 完了とし、適用は OT 運用(spec §9)へ引き継ぎを報告に明記。
  - [ ] gate → review 経路 → commit。
- **完了条件**: 全 case green + migration 目視 pass + gate exit 0 + review pass(Critical 0 / Important 0)+ commit。

## Task 4: 完了 gate + grep 検証 + session doc + 停止

- **目的**: sprint 完了 gate と spec §8 完了条件の最終確認、smoke 引き継ぎの確定、stop checkpoint。
- **手順**:
  - [ ] **grep 完了条件(spec §8)**: `grep -rn "deletionFailures\|deletion_failures" --include="*.ts" --include="*.tsx" .`(node_modules / `.next` 除外)で **code 参照ゼロ**を確認(`drizzle/migrations/*.sql` の CREATE/DROP 履歴と docs 記述は対象外 = 除外理由も報告に 1 行)。残存あれば STOP。
  - [ ] whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` + `pnpm test`(full)全 exit 0(報告に「whole-repo lint exit 0 確認済」を 1 行明記)。
  - [ ] session doc(`docs/superpowers/sessions/2026-07-10-sprint2-integration-failures.md`)に実装記録 + site 3 workflow=null 判断 + smoke checklist(migration 適用確認 / 正常経路 regression)+ **既知の未台帳化 failure 一覧(S4 / S6 / S5 / S7 / S3 / C2 = 将来 catalog entry 追加で取込)** + **catalog key は DB 非保存ゆえ運用 query は 4 軸 tuple で扱う**旨を書き `docs(session)` + `[no-review]` 即 commit。
  - [ ] stop checkpoint 報告で停止(push = OT。push 後 OT 指示で CC が DevTools MCP で正常経路 regression smoke → 結果を見て session doc を [reviewed] 正記録。失敗経路の実発火は unit test 代替 = 上記 stg smoke 代替行のとおり)。
- **完了条件**: grep ゼロ + 全 gate exit 0 + session doc commit 済 + 停止報告。
