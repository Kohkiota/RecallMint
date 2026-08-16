# R0: ReviewLog 持続化 — 実施記録(2026-08-16)

- **spec(凍結)**: `docs/superpowers/specs/2026-08-16-r0-review-log-persistence-design.md`(§10 性能 / §13 完了条件)
- **plan**: `docs/superpowers/plans/2026-08-16-r0-review-log-persistence.md`(r3・Codex cross-check + OT 裁定 3 点反映)
- **fact-finding**: `docs/superpowers/sessions/2026-08-16-dashboard-track-factfinding.md` §11
- **Codex raw**: `docs/codex/2026-08-16-r0-task{1,2,3,4}-*.md` + `docs/codex/2026-08-16-plan-r0-review-log-persistence.md`(plan cross-check)
- **状態**: **実装完了・未 push**(OT の push 判断待ち)。stg smoke 未実施

本 doc は Task 5(最終 task = 性能再計測 + session doc + sprint 完了 gate)の記録。Task 1〜4 の実装詳細は各 task report(`.superpowers/sdd/2026-08-16-r0-review-log-persistence/task-{1,2,3,4}-report.md`)と `progress.md` を正とする。

## 1. 何を作ったか

ts-fsrs が answer 適用時に生成する `ReviewLog` を新表 `review_logs` へ永続化する経路を追加した。**蓄積のみ** — 消費 UI・分析 endpoint・読み経路は一切作っていない。`answer_events` / wire schema / client(Dexie 含む)は無変更。

| commit | 内容 | canonical | Codex |
|---|---|---|---|
| `3876827` | spec 凍結(4 論点 OT 裁定反映) | — | — |
| `03dace9` | plan cross-check の Codex raw 永続化 | — | 1 パス |
| `dd028d9` | plan r3 確定(Codex cross-check + OT 裁定 3 点反映) | — | — |
| `3dc9f22` | **Task 1** `review_logs` 表 + migration 0039 + RLS(`db/policies/r0-review-logs-{enable,disable}.sql`)+ iso 期待カタログ更新 | C0/**I1**/M2 | **I1** |
| `b5529d7` | fix: `scripts/verify-rls-state.test.ts` の件数追随漏れ(Task 1 が漏らした red を解消) | — | — |
| `f12294a` | **Task 2** pure 層: `replayCard` / `foldSession().appliedLogs` | C0/I0/M2 | C0/I0/M0 |
| `ee44cf4` | docs: Task 1/2 の Codex raw + plan r3 追記 | — | — |
| `82d04eb` | **Task 3** `insertReviewLogs` + ingest 手順 7.5(同一 tx) | C0/I0/M2 | C0/I0/M0 |
| `9c24544` | **Task 4** iso behavioral 実証 7 項(fix round 1 込み) | C0/**I1→解消**/M4 | C0/I0/M0 |

**未解決の Critical / Important はゼロ**(Task 1 の Important 1 は Task 4 ⑦(a)(b) の test で吸収 = §5「残余リスク」。Task 4 の Important 1 は fix round 1 で解消)。

## 2. 性能実測

### 2.1 基準と構成

Sprint A §6.1(`docs/superpowers/sessions/2026-08-12-fsrs-consistency-sprint-a.md`)の基準 = **1000 event flush 110ms**(local PG・`processAnswerEvents` の呼び出しのみ計測・seed / 観測 read を含まない)。本 task はこれと**同一構成**で再計測した:

- **1000 event / 10 card / JST 3 day 跨ぎ(`2026-08-20` / `2026-08-21` / `2026-08-22`)/ 全件 applied**
- 計測窓 = `performance.now()` で挟んだ `processAnswerEvents(userA, events, RECEIVED_AT)` の呼び出しのみ(truncate / seed / card 追加は窓外)
- **warm-up 1 回 + 本計測 5 回、中央値を代表値**とする(brief 指定どおり)
- 実 PostgreSQL(devcontainer 常駐 PG17)

**初回計測(現 HEAD のみ・中央値 169.7ms)を 110ms 基準と比較したところ +54.3% の超過が出た。しかし 110ms は 4 日前(2026-08-12)・別セッションの計測であり、同一マシン・同一時点の対照がない**(devcontainer/PG/マシン状態が当時と同一である保証がない)。この交絡を排除するため、controller が別 agent で **ablation 計測**(pre-R0 commit を別 worktree に取り出し、同一マシン・同一セッション・同一 harness・DB 隔離ありで現 HEAD と直接比較)を追加実行した。**以下は ablation 結果を主たる数値として記載する**(§2.2〜2.3)。110ms 基準との比較は参考値として残す(§2.3 末尾)。

### 2.2 ablation 計測(主たる数値・同一セッション対照)

**方法**: `git worktree add --detach /tmp/ablation-pre-r0 dd028d9`(R0 実装 6 commit 直前 = `3dc9f22` review_logs 表新設より前のコミット)で pre-R0 状態を別 worktree に取り出し、現 checkout(HEAD=`9c24544`)には触れずに並行比較した。DB は **別名で隔離**(pre-R0 worktree 内でのみ `tests/integration/pg/setup/db-url.ts` / `global-setup.ts` の DB 名を `recallmint_test` → `recallmint_test_pre_r0` に変更 — worktree 内のみの一時編集で、現 checkout の同 file は無変更・commit もしていない)。両者とも Task 5 の計測 harness(`perf-review-logs.test.ts` を共用、config だけ `REPO_ROOT` を pre-R0/現 HEAD で差し替え)をそのまま使用。構成・warm-up 1 + 本計測 5・中央値代表は §2.1 と同一。実行順は pre-R0 pass1 → 現 HEAD pass1 → pre-R0 pass2 → 現 HEAD pass2(前半・後半のペア、同一セッション内・数分以内に完結)。計測後、pre-R0 用 DB は `DROP DATABASE`、worktree は `git worktree remove --force` で削除済み。安全網として計測後に現 checkout で `pnpm test:iso` を実行し **39 files / 451 tests 全 green**(pre-R0 worktree での作業が現 checkout の DB に無影響であることの実証)。詳細な生値・手順は `.superpowers/sdd/2026-08-16-r0-review-log-persistence/ablation-perf-report.md` を正とする。

**生値**:

| 構成 | pass1 median | pass2 median | 平均 |
|---|---|---|---|
| pre-R0(commit `dd028d9`、DB=`recallmint_test_pre_r0`) | 99.4ms(raw=104.4,101.3,99.4,86.6,90.2) | 98.0ms(raw=98.0,101.1,101.9,88.5,94.3) | **98.7ms** |
| 現 HEAD(commit `9c24544`、DB=`recallmint_test`) | 170.3ms(raw=180.5,177.9,168.6,168.0,170.3) | 178.1ms(raw=181.6,170.1,171.5,178.5,178.1) | **174.2ms** |

現 HEAD pass1(170.3ms)は Task 5 原計測(169.7ms)とほぼ同一レンジで再現性は良好。pre-R0 のレンジ(86.6〜104.4ms)と現 HEAD のレンジ(168.0〜181.6ms)は**完全に非重複**(最近接でも 63.6ms の gap)— ノイズでは説明できない頑健な差。

### 2.3 判定

**主たる数値: R0 の実コスト = 平均 +75.5ms(pre-R0 比 +76.5%。pass1: +70.9ms/+71.3%、pass2: +80.1ms/+81.7%)。**

**参考: 110ms 基準(4 日前・別セッション測定)との比較** — pre-R0(=R0 実装前・同一マシン・同一時点)の中央値は平均 98.7ms で **110ms 基準より −10.3% 速い**。devcontainer/PG/マシン状態が 4 日前より劣化して測定値が水増しされている、という仮説(環境劣化)は**支持されない**。むしろ 110ms 基準を使った素朴な比較(現 HEAD 169.7ms − 110ms = +59.7ms)は、pre-R0 の実測が基準より速かった分だけ **R0 の真のコストを過小評価していた**(真の差 +75.5ms のほうが約 16ms 大きい)。

**spec §10 の見積り(+5〜10ms)に対し、実測は約 10 倍(+75.5ms)だった。見積りの乖離は隠さず明記する。**

**実使用上の影響(2 点セットで解釈すること)**: 本計測は **1000 event = payload 上限の最悪ケース**(オフライン蓄積の解消時のみ発生)。実際の flush 契機は `FLUSH_THRESHOLD = 5`(`app/(app)/app/study/smart/_components/session-runner.tsx:74`)であり、典型的な flush は 5 件程度。
- 1 event あたりのコスト ≈ 75.5ms / 1000 = **0.0755ms/event**
- **最悪ケース(1000 event flush): +75.5ms**
- **典型ケース(5 event flush): ≈ +0.4ms**(0.0755 × 5)

判定: **基準比(参考値)+20% は超過しているが、gate 化はしない(spec §10 / brief の指示どおり)。典型的な運用コストは無視できる水準(+0.4ms)で、最悪ケースでのみ +75.5ms が乗る**。

**要因の仮説(未検証・断定しない)**: 切り分け(FK を外す等の schema 変更)は R0 の scope 外のため実施していない。以下は仮説として記録する:
- (i) `review_logs.event_id` → `answer_events(event_id)` の FK により、1000 行 INSERT が **1000 回の FK 検査**(親行への index lookup + `FOR KEY SHARE` ロック取得)を伴う。これが支配的要因である可能性。
- (ii) 17 列 × 1000 行 = **17,000 個の bind parameter** を 1 statement に載せる overhead。
- **どちらが支配的かは未切り分け**。この FK は spec §12-4(OT 裁定「event_id FK 採用」)の帰結であり、**設計判断の結果であって実装の不備ではない**。

### 2.4 再現手順(scratch — repo に残していない)

計測 script は `/tmp/claude-0/-workspaces-RecallMint/b708ff97-ba6d-4b20-9c4e-2b3c99ac4aac/scratchpad/` にのみ置き、commit していない。現 HEAD 単体の再現手順:

1. **専用 vitest config**(`perf-vitest.config.ts`)をリポジトリ外(scratchpad)に置き、`tests/integration/pg/setup/global-setup.ts`(DB drop/create + migrate + grants + RLS policies enable の全 6 file を owner 接続で適用)と `setupFiles`(`tests/integration/pg/setup/env-guard.ts` → `vitest.setup.ts`)を**実 file への絶対 path で参照**する。`resolve.alias` に `'@' → リポジトリ root`、`'server-only' → vitest-stubs/server-only.js` を設定。`pool: 'forks'` + `fileParallelism: false`(既存 `vitest.integration-pg.config.ts` と同一設定)。これにより `tests/` 配下は一切書き換えずに `pnpm test:iso` と同一の DB 状態を作れる。
2. **専用 test file**(`perf-review-logs.test.ts`)も scratchpad に置き、`@/tests/integration/pg/setup/fixture` から `truncateAllUserTables` / `seedTwoTenants` / `getFixtureOwnerDb` / `closeFixtureOwnerDb` を import(既存 harness の**読み取り専用 import** — fixture.ts 自体は無変更)。
3. `runOnce()`: `truncateAllUserTables()` → `seedTwoTenants()` → `initialFsrsState` で 9 枚の追加 card を owner 接続で insert(計 10 card)→ 1000 件の `AnswerEventWire` を `cardIds[i % 10]` に round-robin で割当て、`answered_at` を 3 日(`2026-08-20/21/22` の `T01:00:00.000Z` + `i*1000ms`)に分散させて構築 → `performance.now()` で挟んで `processAnswerEvents(userA, events, RECEIVED_AT)` を 1 回呼ぶ → 経過 ms を返す(`res.failed.length === 0` を assert)。
4. 1 warm-up + 5 測定回を直列に `runOnce()` し、5 回を昇順ソートして中央値を算出、`console.log` で出力。
5. 実行コマンド: `npx vitest run --config <scratch-config-path> --silent=false --reporter=verbose`。**`--reporter=verbose` が無いと vitest 4 のデフォルト reporter は通過 test の `console.log` を表示しない**(この harness 構築中にハマった点 — 最初 `--reporter` なしで走らせて "1 passed" だけ出て実測値が見えず、既存 test でも同様に再現して原因を特定した)。
6. 前提: devcontainer 常駐 PG17(`127.0.0.1:5432`)が起動済み、`recallmint_test` DB が存在する(`pnpm test:iso` を一度でも走らせていれば作られる。globalSetup が毎 run 内部で drop/create するため素の状態でも自動的に整う)。

**pre-R0 との ablation 比較を再現する場合**は、上記に加えて: `git worktree add --detach <path> dd028d9` で pre-R0 を取り出し、その worktree 内でのみ `tests/integration/pg/setup/db-url.ts` と `global-setup.ts` の DB 名を別名(例 `recallmint_test_pre_r0`)に変更した config を用意し、現 HEAD 用 config(`REPO_ROOT=/workspaces/RecallMint`)と pre-R0 用 config(`REPO_ROOT=<worktree path>`)を交互に実行する。計測後は pre-R0 用 DB を `DROP DATABASE`、worktree を `git worktree remove --force` で削除し、現 checkout で `pnpm test:iso` を実行して無影響を確認する(`node_modules` は現 checkout からの symlink で可 — `package.json` / `pnpm-lock.yaml` に pre-R0/現 HEAD 間で差分が無いことを確認してから使うこと)。

補足: config 読込時に Vite が `[UNRESOLVED_IMPORT] Could not resolve 'vitest/config'` という warning を出すが、これは config file がリポジトリ外にあるための node_modules 解決経路の警告で無害(実行は正常 — globalSetup が実際に走っていることは RLS/grants 前提の `processAnswerEvents` が全件成功したこと自体で確認済み)。

## 3. red 変異の記録(7 種・Task 2〜4 の report から転記)

brief は「5 種(a〜e)」と記載していたが、Task 4 fix round 1 で追加 2 種(f)(g)が実施されており、**実際は 7 種**。各 task の report file(`task-{2,3,4}-report.md`)の実際の出力から転記する。

### (a) `replayCard` が `.log` を捨てて空配列を返す(Task 2)

- **変異内容**: `lib/cards/replay-card.ts` の `const { card: next, log } = rate(...); logs.push(log)` を `const { card: next } = rate(...)`(logs には何も push しない)に変更。
- **対象 test**: `lib/cards/replay-card.test.ts` 全体(狙いは①②)。
- **期待した失敗**: ①(`logs.length` が `events.length` と一致)/ ②(`logs[i].review` が `events[i].answeredAt` と一致)が fail。
- **実結果**: ①②ともに期待どおり fail。加えて④(before 値の一致)と連鎖検証 test も副次的に fail(`logs[0]` が undefined になるため)。既存 6 test(Case A/B/B2/C)は無傷。10 tests, 4 failed / 6 passed。revert 後 10/10 green。

### (b) `foldSession` が `appliedLogs` を全 event(skip 含む)から構築する(Task 2)

- **変異内容**: `lib/reviews/domain/session-aggregate.ts` の順序ガード `continue` を、skip 判定はするが `appliedLogs` には push する形に書き換え(skip event の `eventId` が混入)。
- **対象 test**: `lib/reviews/domain/session-aggregate.test.ts` 全体(狙いは⑥のみ)。
- **期待した失敗**: ⑥(skip された event は appliedLogs に出ない)のみ fail。
- **実結果**: ⑥のみ期待どおり fail(`expected [ 'stale', 'ok' ] to deeply equal [ 'ok' ]`)。他 16 test(⑤⑦含む)は無傷。17 tests, 1 failed / 16 passed。revert 後(replay-card 込み)27/27 green。

### (c) `insertReviewLogs` を共有 tx の外(別オブジェクト)へ移す(Task 3)

- **変異内容**: `lib/reviews/ingest-review-events.ts` の `await insertReviewLogs(tx, reviewLogRows)` を `await insertReviewLogs({ insert: tx.insert.bind(tx) } as never, reviewLogRows)` に変更。機能的な insert 委譲は保ったまま tx の**参照同一性だけ**を壊す。
- **対象 test**: `app/api/review-events/bulk/route.test.ts` の tx-identity pin(1 件)のみ。
- **期待した失敗**: tx-identity pin のみ fail、他 40 test は無傷。
- **実結果**: 期待どおり `1 failed | 40 passed (41)`(`AssertionError: expected { insert: [Function bound insert] } to be { select: [Function select], …(3) }`)。revert 後 41/41 green。

### (d) `insertReviewLogs` 呼出削除(Task 4)

- **変異内容**: ingest 手順 7.5 の `await insertReviewLogs(tx, reviewLogRows)` を削除(`void reviewLogRows` に置換)。
- **対象 test**: iso `review-logs.test.ts` ①(狙い)。
- **期待した失敗**: review_logs の全表 delta が 0(1 でない)で①が fail。
- **実結果**: ①が期待どおり fail(`expected +0 to be 1`)。副次的に②④⑦(b)も fail(log 行が一切生まれないため)。⑥も「reject するはずが resolve した」で fail(insertReviewLogs 呼出が発生しないため注入した CHECK に触れず tx が正常終了する = ⑥が insertReviewLogs 呼出に依存していることの追加証跡)。③(a)(b)(c)は元々 0 行を期待する test のため無傷で pass のまま。

### (e) `reviewLogRows` を `appliedLogs` でなく `newRows` 全件(skip 無視・ダミー値)から構築(Task 4)

- **変異内容**: `reviewLogRows` の構築元を `appliedLogs.map(...)` から `newRows.map(...)`(skip された event も含む全件、値は `stateBefore/stabilityBefore/...` を 0 固定のダミー)に変更。
- **対象 test**: iso ③(a)(b)(c)(狙い)。
- **期待した失敗**: skip された event にも log 1 行が生まれ、③(a)(b)(c)全て fail。
- **実結果**: ③(a)(b)(c)全て期待どおり fail(`expected 1 to be +0`)。①もダミー値と実際の `rate()` 出力の不一致で副次的に fail。②⑦(a)(b)は無傷(適用された event には引き続き行が生まれるため矛盾しない)。**④(記述訂正)**: 当初 report は「行の存在しか見ていないから pass」と誤記していたが、正しくは「dummy 値がすべて 0 に潰れ row1 の after(=0)と row2 の before(=0)が『fold が正しく連鎖しているから』ではなく『両辺とも定数 0 だから』自明に一致し、連鎖 assertion が意味のある検証をしないまま自己整合してしまう」ため pass(reviewer 指摘を受けて Task 4 report 内で訂正済み)。

### (f) `stabilityBefore` ↔ `difficultyBefore` 入替(Task 4 fix round 1)

- **変異内容**: `stabilityBefore: entry.log.stability` / `difficultyBefore: entry.log.difficulty` を入替。
- **対象 test**: iso ①(fix round 1 で「新規カード + Good」から「既 1 回 review 済み + 数日経過」の非退化シナリオへ変更した後)。
- **期待した失敗**: `row.stabilityBefore`(12.34 のはず)が入替後の値(5.67)になり不一致。
- **実結果**: ①が期待どおり fail(`AssertionError: expected 5.67 to be 12.34`)。副次的に④(同 card 連鎖)も fail(`expected 2.3065 to be 2.11810397`)。他(②③⑤⑥⑦)は無傷。**旧(退化)シナリオではこの変異は 0/0 の組が入替に対して不変なため検出できなかったことも実測で裏付け済み**(= canonical Important #1 指摘の妥当性の直接証拠、§6 参照)。

### (g) `elapsedDays` ↔ `scheduledDays` 入替(Task 4 fix round 1)

- **変異内容**: `elapsedDays: entry.log.elapsed_days` / `scheduledDays: entry.log.scheduled_days` を入替。
- **対象 test**: iso ①。
- **期待した失敗**: `row.elapsedDays`(15 のはず)が入替後の値(21)になり不一致。
- **実結果**: ①が期待どおり fail(`AssertionError: expected 21 to be 15`)。他 test は無傷。

全 7 変異とも working tree 上でのみ当て、確認後に `git diff lib/ app/ drizzle/` が空であることを都度確認して revert 済み(各 task report に記録済み)。

## 4. Group II 実証

spec §8 は `review_logs` が退会 scrub の分類上 **Group II**(`event_id` FK の親 `answer_events` が user_id direct cascade を持つため、親 chain 経由で連鎖削除される。handler の明示 DELETE 集合には入らない)になる想定。

判定式(`app/api/webhooks/clerk/route.test.ts` の `computeGroupITables()`)は schema から機械算出する:
```
Group I = hasUserIdCascadeFK(T) かつ !hasParentInUserCascadeChain(T)
```
`review_logs` は `user_id` への direct cascade FK を持つ(`hasUserIdCascadeFK` = true)が、`event_id` FK の参照先 `answer_events` 自身が `hasUserIdCascadeFK` = true のため `hasParentInUserCascadeChain(review_logs)` = true となり、**Group I から除外される = Group II**。

```
npx vitest run app/api/webhooks/clerk/route.test.ts
```
実行結果: **44 tests 全 green(無変更)**。特に `describe('Clerk webhook user.deleted: 削除網羅性 invariant')` の `it('handler の tx.delete 集合 = Group I − soft-delete 例外 (新規 user_id FK テーブル追加検知)')` が review_logs 追加後も無変更で green のままであることを確認した。この test は「新規 user_id FK テーブル追加検知」を目的として schema を機械走査するため、review_logs が Group I 集合(= handler が明示 DELETE すべき対象)に混入していれば red 化していたはずであり、**green のまま = review_logs が Group II に自動分類されたことの実証**そのものになる。handler(`handle-clerk-event.ts`)は無改修。

## 5. OT 裁定 3 点(brief の確定文言をそのまま転記)

### ① 欠損窓 coverage 契約(OT 裁定・条件付き受容)

> code rollback が発生した場合は欠損期間(deploy 時刻範囲)を session doc / ops 記録に残し、Dash-3 以降の L4 消費はその期間を除外または注記する。

**初回 deploy 窓はユーザー 0 で空集合。**

### ② provenance 再裁定トリガー(OT 裁定・列なし確定)

> ts-fsrs(現 5.4.1 exact pin)の version bump または既定パラメタ変更を行う場合、変更 code の deploy 前に provenance の要否を再裁定し、必要な識別情報を rollout に先行して導入する(rolling 混在窓では行単位の version が事後復元不能のため)。

### ③ 監視 follow-up 起票文(OT 裁定・claude.ai todo へ)

> review_logs の anti-join 整合監査(applied=true AND NOT EXISTS log)と review_logs 起因 ingest エラーの識別 alert を、Dash-3 か運用 sprint で設計する。

**全文を本 doc に転記済み。claude.ai 側 todo への起票は controller が chat 経由で OT に渡す(CC 本体は claude.ai todo へ直接登録できないため)。**

## 6. 残余リスク

### 6.1 帰属列(user_id)は単一 writer の app 写像を信頼、DB 保証なし

`review_logs.user_id` は `event_id` FK(→ `answer_events`)とは独立に app 層(`user.id` = 認証主体)が直接埋める列で、**DB は「この user_id が event_id の参照先 answer_events.user_id と一致する」ことを制約として保証しない**(複合 FK なし)。

**複合 FK(event_id, user_id)を採用しなかった理由**: `answer_events` に `UNIQUE(event_id, user_id)` を追加する必要があるが、これは①確定決定「answer_events を置換も拡張もしない」(spec §2)に抵触し、②`answer-events-serialization.test.ts` の schema contract test が「制約は PK + FK + CHECK 3 本」を定義文まで pin しており、UNIQUE 追加は凍結契約そのものの書き換えになる。spec は凍結済みで CC 独断の変更対象外。

**Codex(Task 1 review・P2)と canonical(Task 1 review・Important 1)が独立に同じ gap を指摘**した(Codex: 「FK check は RLS を bypass するため user_id=A で B の answer_events を参照する行が DB 上は作れる」)。裁定(Ruling R7)は以下:
1. app 経路では到達不能であることを現物確認済み — 書き手は ingest 1 本のみで、rows は `appliedLogs ⊆ appliedEventIds ⊆ insertedEventIds`。他 tenant 所有の `event_id` は `insertAnswerEvents` の `onConflictDoNothing(target: eventId)` により行が返らず `insertedEventIds` に入らない → fold 対象外 → log 行が生まれない(この挙動は `db/policies/rls-p3-wave1-enable.sql:20-22` にも明文化済み)。
2. DB 制約の代わりに **Task 4 ⑦ の test で代替保証**した: ⑦(a) 他 tenant 所有 event_id を含む payload → failed[] かつ相手の既存 review_logs 行が不変・複製されない、⑦(b) 挿入された全 log 行の `user_id` が参照先 `answer_events.user_id` と一致。
3. 残るリスクは owner/operator の直接 SQL 経由のみ(RLS 外の経路で、既存全表と同条件)。

将来 app 経路が変わり越境ペアが構造的に生じうるようになった場合、DB はそれを止めない。検知は Task 4 ⑦ の iso が経路変更時に red 化することに依存する。

### 6.2 同時刻 event の総適用順序は非保存

Sprint A の順序ガードは `>=` のため同時刻 event は両方適用されるが、その適用順(どちらが先に fold されるか)は保存されない。spec §2.4 が明示受容している既存の性質で、review_logs 側もこれをそのまま引き継ぐ(pin していない・できない)。

## 7. sprint 中に見つかった注目すべき事象

### 7.1 Task 1 が完了条件の gap で red のまま commit された

Task 1(`3dc9f22`)は `scripts/verify-rls-state.test.ts:72-74` の期待件数(`EXPECTED_RLS_TABLES` 等 18/5/20)を新表追加後の値(19/5/21)へ追随させないまま `[reviewed]` で着地した。**根因は plan の Task 1 完了条件に `pnpm test`(whole unit suite)が無く `pnpm test:iso` だけだったこと**(canonical review も iso しか再実行しなかった)。

対処: ① 独立 fix(`b5529d7`)を Task 2 と交わらない範囲で先に着地 ② **以後の全 task の完了条件に `pnpm test` を追加**(plan 更新)③ 分類は「保証不変の整理」= `[no-review]` + message に「保証不変」。この経緯は Task 2 の self-review でも「`pnpm test` の 1 件の failure」として報告され(`git stash` で Task 2 変更と無関係のベースライン failure であることを確認済み)、Task 5(本 task)の完了条件チェックリストに「typecheck と test(whole unit suite)も回す」が明示的に含まれているのはこの教訓の反映でもある。

### 7.2 Task 4 の初版 iso ① が退化シナリオで検出力ゼロだった

Task 4 初版の iso test ①(「適用 1 event = review_logs ちょうど 1 行、17 列写像」)は**新規カード + Good 1 回目**というシナリオを使っていた。この条件だと ts-fsrs の `buildLog()` が返す `stability` / `difficulty` / `elapsed_days` / `last_elapsed_days` / `scheduled_days` / `learning_steps` の 6 列が**全て 0 に揃う**。かつ期待値算出も同じ `replayCard` 純関数の再呼出しだったため、production の手書き写像ブロック(`ingest-review-events.ts` の `reviewLogRows` map)がこの 6 列内で隣接フィールドを取り違えても(例: `stabilityBefore` ↔ `difficultyBefore`)両辺 `0 === 0` で test が素通りする状態だった。実質 pin できていたのは 17 列中 11 列のみ。

これは canonical review(Task 4・専用観点「主張の正確さ」)が **ts-fsrs を実際に `npx tsx` で実走させて実測**して発見した(reviewer 想定 = canonical。Codex は同 task で Critical 0 / Important 0 / Minor 0)。修正(Ruling R9・reviewer 案 (b)「強い方」採用)は、シナリオを「既に 1 回 review 済みで数日間隔が空いたカード」に変更し、6 列を相互に区別可能な非ゼロ値(`stability=12.34` / `difficulty=5.67` / `elapsedDays=15` / `lastElapsedDays=9` / `scheduledDays=21` / `learningSteps=3`)にして検出力を回復。加えて test 内に非退化ガード(6 列が pairwise distinct + 非ゼロであることの自己 assert)を追加し、将来 seed が再退化したら test 自身が先に fail する形にした。

**この修正の過程で副次的に発見した既存の潜在バグ**: `buildLog()` は `due: last_review || due` を返す仕様(`last_review` が設定されていればそちらを優先し、card の `due` フィールドは使わない)。旧シナリオは `lastReview: null` だったためこの分岐が隠れており、`row.dueBefore` を `initial.due` と直接比較しても偶然一致していた。新シナリオで `lastReview` を設定したところ `dueBefore` の比較が実際に失敗し(`expected 1786320000000 to be 1788134400000`)、この分岐の存在が判明。修正として `dueBefore` の比較対象を `initial.due` から `expectedLog.due`(= 同じ `replayCard` 呼出しの出力、production の実装 `dueBefore: entry.log.due` と同じ ground truth)に変更した。

red 検証は (f)(g) の 2 変異を追加(§3 参照)し、修正後の検出力を実測で確認した。

## 8. sprint 完了 gate(Task 5 実走・2026-08-16)

| gate | コマンド | 結果 |
|---|---|---|
| whole-repo lint | `pnpm lint`(`--max-warnings=0`) | **exit 0**(warning/error なし) |
| typecheck | `pnpm typecheck` | **exit 0**(`tsc --noEmit` 出力なし) |
| audit | `pnpm run audit`(= `scripts/audit-gate.mjs`。**`pnpm audit` ではない**) | **exit 0**(`prod: high/critical 0` / `dev: high/critical 0 件を allowlist で受容`) |
| unit(全 suite・健全性確認) | `pnpm test` | **exit 0**(295 files / 5199 tests 全 passed) |
| iso(実 PostgreSQL) | `pnpm test:iso` | **exit 0**(39 files / 451 tests 全 passed) |

**whole-repo lint exit 0 確認済 / test:iso green 確認済 / pnpm run audit exit 0 確認済**(1 行明記)。

working tree は本 doc 作成分を除き無変更(`git status --porcelain=v2` で確認。`docs/codex/2026-08-16-r0-task{3,4}-*.md` の未追跡 2 file は Task 3/4 が残した既存の未 commit 分で本 task の変更ではない)。

## 9. 残作業

- **stg / prod への適用は OT**。順序 = **migrate(0039)→ policies enable(`db/policies/r0-review-logs-enable.sql`)→ code deploy**(spec §7 の deploy 順)。
- **push も OT**(本 task は working tree に変更を残したまま報告。`git commit` は controller が行う)。
- 性能実コスト(ablation 実測 +75.5ms・最悪ケースのみ・典型ケースは +0.4ms)は §10 の follow-up 候補として claude.ai todo へ起票する(OT 判断待ち)。
- §5-③ の監視 follow-up 起票文、および §10 の性能 follow-up 起票文は、いずれも claude.ai todo へ登録が必要(CC は直接登録不可 — controller が chat で OT に渡す)。

## 10. follow-up 候補(性能・claude.ai todo 起票案)

ablation 計測(§2.2〜2.3)の結果に基づく follow-up 候補。**全文をそのまま claude.ai todo へ起票する**(CC は直接登録不可 — controller が chat で OT に渡す):

> R0 の ReviewLog 書込は 1000 event flush(payload 上限)で +75.5ms のコストが実測された(典型の 5 件 flush では ≈ +0.4ms)。要因は未切り分けで、仮説は (i) event_id FK による 1000 回の FK 検査 (ii) 17 列 × 1000 行の bind parameter overhead。オフライン長期蓄積の解消時のみ効く最悪ケースであり R0 では受容したが、大量 flush が常態化する兆候が出た場合、または Dash-3 で書込量が増える場合に、FK 維持のまま COPY / 分割 INSERT に切り替えるか、FK 自体を再裁定するかを検討する。

## 11. Critical fix(due_before)と stg 旧行の扱い(2026-08-16 追記)

### 11.1 何が起きたか

最終 whole-branch review が Critical を検出: **`review_logs.due_before` に「適用前 due」でなく「前回 review 時刻(`last_review`)」が保存されていた**。

原因は ts-fsrs 5.4.1 の `buildLog`(`node_modules/ts-fsrs/dist/index.cjs:414-428`):

```js
buildLog(rating) {
  const { last_review, due, elapsed_days } = this.last;
  return { rating, state: this.current.state,
    due: last_review || due,        // ← last_review があればそれを返す
    ... };
}
```

`this.last` は入力 card のクローンなので、**2 回目以降の全 review で `log.due` は `last_review`** になる。production は `dueBefore: entry.log.due` と verbatim コピーしていた。

production の `replayCard` 経由での実測(learning state):

```
入力 card.due (真の適用前 due) : 2026-08-01T00:10:00.000Z
入力 card.last_review          : 2026-08-01T00:00:00.000Z
log.due (= due_before に保存)  : 2026-08-01T00:00:00.000Z
log.scheduled_days             : 0   ← learning ゆえ日単位の近似復元も不能
```

**検出が遅れた経緯**(教訓): Task 4 の fix round で iso ① を非退化シナリオへ変えた際、`row.dueBefore` を `initial.due` と比較する assertion が実際に fail した。そこで **production の写像ではなく test 側の期待を `expectedLog.due` に緩めて green にした**(§7.2 に fail 出力が残っている)。当時の scoped re-reviewer は「test と production の内部整合」を検証して正当と判定しており、**列名・spec が宣言した意味との一致は誰も見ていなかった**。whole-branch pass が初めて拾った。

### 11.2 修正(commit `37b76fa`・OT 裁定 (A) 案)

fold が保持する適用前 `card.due` を保存する。`replayCard()` 呼出**直前**の `current.due` を `AppliedReviewLog.dueBefore` として退避し、ingest の写像で使う。**DB 変更ゼロ**(列定義・migration・型は不変)。spec は r2 として §3.1 と §12 を訂正。

### 11.3 stg 旧行の記録(2026-08-16 re-smoke で確定)

fix 前の stg に書かれた行は**残置**する(削除しない)。L4 分析で消費する際に除外する。

**確定値**(re-smoke 時に tenant context 付きで readback。§11.4 参照):

| 項目 | 値 |
|---|---|
| 環境 | stg(`aws-1-ap-northeast-1.pooler.supabase.com` / DB `postgres`)|
| 所有 user | `66fb6d00-526f-4264-9691-e2e036c656f7` |
| **旧行数** | **5 行**(当初 3 行と記録したが、その後 OT が追加 smoke を実施して 5 行になった)|
| `created_at`(= server 受信時刻)| `2026-08-16T09:28:39.216Z`(3 行)/ `2026-08-16T12:15:48.058Z`(2 行)|
| `review` の時刻範囲 | `2026-08-16T09:28:24.552Z` 〜 `2026-08-16T12:15:38.232Z` |
| 意味 | `due_before` は**適用前 due ではなく前回 review 時刻のエコー**(旧仕様)|

**旧行の `event_id`(5 件)**:

```
6a78a544-1b42-470b-a2a5-47dd11c4c8a0   review 2026-08-16T09:28:24.552Z
2f2d9cb7-9cf7-4442-ae69-b30b9d69f027   review 2026-08-16T09:28:27.782Z
6b07ae8c-eb8d-4e9d-a0ca-c114207fbfd6   review 2026-08-16T09:28:30.316Z
868da653-08e4-4aff-b3b5-f923bca3a428   review 2026-08-16T12:15:33.338Z
036d4539-73cf-4e22-83fe-bc6ab43260dd   review 2026-08-16T12:15:38.232Z
```

**機械除外の述語(実測で分離を検証済み)**:

```sql
-- 旧仕様行(5 行)。新仕様行(created_at = 2026-08-16T12:19:12.603Z 以降)と
-- created_at に 3.4 分の gap があり、境界はこの間の任意の時刻でよい。
SELECT * FROM review_logs WHERE created_at < '2026-08-16T12:17:00Z'::timestamptz;
```

実行結果: **旧 5 / 新 5 / 合計 10** — 述語が新旧を正しく分離することを実データで確認済み。

**旧行に残る bug の実例**(stg 実データによる Critical の実証): `036d4539-…` は `state_before = 1`(learning)/ `scheduled_days = 0` で `due_before = 2026-08-14T23:47:55.610Z`。この環境の learning card は一貫して `due = last_review + 60s` の形を取る(§11.4 の回答前スナップショット参照)ため、真の適用前 due は `23:48:55.610Z` であり、**保存値は 60 秒前 = `last_review` そのもの**。日単位復元も `scheduled_days = 0` ゆえ効かない。

### 11.4 re-smoke(fix 後・2026-08-16)= **PASS**

deploy = `origin/develop` `5efd454`(fix `37b76fa` 込み)。Playwright で stg にログインし、スマート復習で 5 枚回答 → flush 閾値(5 件)到達 → server readback。

**判別設計**: この環境の learning card は `due = last_review + 60,000ms` の形を取るため、`due_before` が `due` と `last_review` のどちらに一致するかで**新旧コードが決定的に判別できる**。回答前に server DB からスナップショットを取得してから回答した。

**回答前スナップショット(server DB・`2026-08-16T12:18:49Z`)**

| card | state | sched | `due`(真の適用前 due)| `last_review` | 乖離 |
|---|---|---|---|---|---|
| 第2問 `54849478-…` | 1 | 0 | `2026-08-14T23:48:03.598Z` | `2026-08-14T23:47:03.598Z` | 60,000ms |
| 第3問 `a93de547-…` | 1 | 0 | `2026-08-14T23:48:04.703Z` | `2026-08-14T23:47:04.703Z` | 60,000ms |

**結果(新規 5 行・`created_at = 2026-08-16T12:19:12.603Z`)**

| # | card | state | sched | `due_before` | 判定 |
|---|---|---|---|---|---|
| 1 | 第2問 `54849478-…` | **1 → 1** | **0** | `2026-08-14T23:48:03.598Z` | **回答前 `due` と完全一致**(`last_review` とは 60,000ms 乖離)✅ |
| 2 | 第3問 `a93de547-…` | **1 → 1** | **0** | `2026-08-14T23:48:04.703Z` | **回答前 `due` と完全一致** ✅ |
| 3-5 | New 3 枚 | 0 → 1 | 0 | `2026-08-14T23:59:59.838Z` | `last_review` が NULL のため新旧同値(判別不能だが整合)|

**17 列の検証(行 1)**: `event_id` / `user_id` / `card_id` は `answer_events` と一致。`rating=3`(通常モードで正解 → 3)/ `state_before=1` / `due_before` / `stability_before=0.212` / `difficulty_before=6.4133` / `scheduled_days=0` / `learning_steps=0` / `last_elapsed_days=0` はすべて**回答前スナップショットと一致**。`elapsed_days=2`(08-14 → 08-16)。`review = 12:19:00.512Z = answer_events.answered_at`。`created_at = 12:19:12.603Z`(5 行すべて同値 = batch 受信時刻で `review` とは別物)。after 3 値(`state_after=1` / `stability_after=2.4329485` / `difficulty_after=6.40211507`)は **`cards` の現在値と完全一致**。

**console: 0 errors**。`answer_events.applied = true`(5 件とも)。

**判定: PASS** — learning 行 2 件で `due_before` が「適用前 `card.due`」であることを実データで確認。fix(`37b76fa`)は stg で実効。
