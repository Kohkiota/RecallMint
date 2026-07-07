# DDD P4 — インフラ DRY 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。

**Goal:** インフラ層に残る同型コピペの DRY と lib/ 配置統一(挙動不変・DDD リファクタ最終 phase)。
**spec:** `docs/superpowers/specs/2026-07-07-ddd-p4-infra-dry-design.md`(`9bcdcd8` OT 承認・論点 1 = (a) 移設 + CLAUDE.md 追随)。
**基点:** fact-finding `docs/superpowers/sessions/2026-07-07-ddd-p4-factfinding.md`(HEAD `a62fb1c`)。

## Global Constraints(全 task 共通)

- **挙動不変**: D-2 凍結契約 + P0 golden snapshot 更新ゼロ + 既存 test green。唯一の sanctioned 例外 = Task8 measure revert(spec §1.4/§3.2・TEMP 一時配管の設計通り撤去)。
- **限定共通化 ≠ 統合**(spec §3.1): Task1 は orchestrator 2 file(entity-mutation-flush.ts / review-flush.ts)不変・非対称部(retry controller / backoff / pullBack hook / session grouping)不触・in-flight set 2 インスタンス分離維持。
- **移動と書換えの分離**(OT 条件): Task4/6/7 = verbatim 移動(許容差分 = import/export 文と path のみ)、Task1/2/3/5/8 = 書換え。混ぜない。
- **簡潔性規律**: helper 引数は現 consumer が使う分のみ。予測共通化・設定可能化禁止。
- **scope 線引き**: VERCEL_ENV helper 置換は **lib/ 内のみ**(app 内 inline は P4 対象外・scope creep 禁止)。lint cross-feature allowlist 3 件 + react-hooks/refs 1 件も対象外。
- per-task gate: 対象 test + `pnpm test:contract`(77・**snapshot 更新ゼロ確認**)+ `pnpm typecheck` + whole-repo `pnpm lint --max-warnings=0` 全 exit 0。risk task(Task2/3/4/5/6/7 = import path 変更系)は + `pnpm build` + Codex 独立 review。full `pnpm test` は Task9 集約。
- commit: review pass → [reviewed] commit の一方向。SSoT 状態遷移(実装中)は最初の code commit に同梱、完了記録は Task9 の独立 [no-review] commit。
- エスカレーション(停止・OT 行き): 未解決 Critical / ① Task8 で timing log の consumer 発見 or 撤去が挙動変更化(spec §3.2 条件不成立)② Task1 で非対称部に触れざるを得ない構造判明(N-2 侵害)③ Task4 で fail-fast 発火タイミング変化 ④ P0 golden 赤(measure 非凍結面を除く)⑤ 仕様解釈揺れ。Important 以下は CC 吸収。

---

### Task 1: outbox per-table helper 化(W1)

- **目的**: 新 module `lib/sync/outbox-ops.ts` に per-table 機械操作 3 helper を切り出し、entity-mutations.ts ⇄ review-events.ts の同型 4 対を委譲に置換する。
  - `modifyByKeys(table, keyCol, ids, patch)`: `if (ids.length === 0) return; await table.where(keyCol).anyOf(ids).modify(patch)`(markSynced ×2 = patch `{sync_status:'synced'}` / markAttempted ×2 = patch `{last_attempted_at: nowIso}` の共通体)。
  - `dropStaleByKey({ table, keyCol, pending, timestampOf, idOf, now, maxAgeMs })` → `string[]`: cutoff 比較(**厳密に古い**・境界は残す)→ 該当 id を `{sync_status:'failed'}` に modify → id 配列 return(dropStale ×2 の共通体。判定列 edited_at ⇄ answered_at は timestampOf callback で caller が渡す)。
  - `createBulkApiClient(endpoint)` → `BulkApiClient`: 現 defaultClient(review-events.ts:238-257)の body を endpoint 引数化した verbatim。
- **制約**: 既存 8 シンボル(markEntityMutationsSynced/Attempted・dropStalePendingEntityMutations・markAnswerEventsSynced/Attempted・dropStalePendingAnswerEvents・defaultClient ×2)は**名前・シグネチャ・export 可視性を維持**し中身のみ委譲化(test の spy/mock 面を壊さない)。`BulkApiClient` 型は outbox-ops.ts へ移し review-events.ts が `export type { BulkApiClient } from './outbox-ops'` で re-export(既存 importer 不変・型 cycle なし)。`FlushResult` は review-events.ts 残置。**spec の「同型 5 対」の第 5 対 = in-flight set は確認のみ・helper 化しない**(inFlightEventIds / inFlightMutationIds = 2 インスタンス分離のまま不触。Codex 指摘の数え方明確化)。patch object は **caller 側で構築**(markAttempted の nowIso は現行どおり caller が 1 回計算して渡す — 評価タイミング保存・Codex 指摘)。
- **完了条件**: entity-mutations / review-events / entity-mutation-flush / review-flush の 4 suite green + per-task gate + canonical。[reviewed]。

### Task 2: pull server 内 factory 化(W2・risk)

- **目的**: `lib/db/pull-delta.ts` 新設(`import 'server-only'`)。`getDeltaRows({ table, userIdCol, cursorCol, mapper, cursorValueOf }, userId, since?)` → `{ rows, max: string | null }`。body = 現 6 module 共通形の verbatim: `const conds: SQL[] = [eq(userIdCol, userId)]; if (since) conds.push(gte(cursorCol, since))`(**since の条件式は現行 `if (since)` をそのまま使う** — 条件を書き換えない・Codex 指摘)→ select → `map(mapper)` → `max = maxIso(rows.map(cursorValueOf))`(**maxIso は現行どおり mapped rows の client field に対して計算** — `cursorValueOf: (clientRow) => string | 相当` を module が渡す・Codex 指摘)。6 module(cards / exams / tag-categories / tag-options / card-tags / tombstones)-pull.ts の公開 delta 関数は**名前・シグネチャ・return key(maxUpdatedAt / maxCreatedAt / maxDeletedAt)不変**のまま内部を factory 呼び出し + key rename に置換。
- **制約**: mapper・cursor 列選択・return key 命名・型 export は各 module 残置。card_tags 例外意味論の client 補完(lib/sync/pull.ts:16-20・213-225)不触。route(app/api/pull/route.ts)・wire・client 手展開・SYNC_META_KEYS 不変。study-days-pull は cursor 非同型(全件返し)のため**対象外**(確認のみ・実績欄記録)。Drizzle 型付けは pragmatic 可(table/column を引数で明示渡し・generic 過剰化しない)、ただし `any` での逃げは不可。
- **完了条件**: 6 module の co-located suite 全 green + pull contract green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 3: read-only 4 route の認証 wrapper(W3・risk)

- **目的**: `lib/auth/with-read-only-auth.ts` 新設。`withReadOnlyAuth(opts, handler)`: `headers = { 'Cache-Control': 'no-store' }` 生成 → getCurrentUser try/catch(UnauthenticatedError → 401 `{error:'unauthenticated'}` + headers / それ以外は **opts.authFailEvent あり** → `logger.warn({event, err})` + 500 `{error:'internal'}` + headers、**なし → rethrow**)→ `!user` → 200 `opts.emptyBody` + headers → `handler(user, headers)`。
- **route 対応表**(空 body は現 route から byte 同一で移す):

| route | emptyBody | authFailEvent |
|---|---|---|
| /api/pull | 空 6 stream + cursors(現 route の !user 応答そのまま) | `api.pull.auth_failed` |
| /api/dashboard/stats | `{todayCardCount:0,streak:0}` | `api.dashboard.stats.auth_failed` |
| /api/study-days/pull | `{studyDays:[]}` | `api.study_days.pull.auth_failed` |
| /api/exams/status | `{statuses:{}}` | **なし(rethrow 維持 — 現行の非対称を保存)** |

- **制約**: 各 route の成功 body 構築・内部 catch(route 固有 event 名 + 500)は route 残置。4 route の応答(status / body / header / log level)がバイト同一で保存されること = 受け入れ条件。**ground truth = 現行 route コード**(spec §3.4 冒頭の省略記法でなく「バイト同一」条項が正: UnauthenticatedError → **401** `{error:'unauthenticated'}` が現行 4 route 共通の実挙動・Codex 指摘で明確化)。**rethrow 経路(exams/status)は wrapper が応答を生成せず例外をそのまま framework へ届ける**(合成後挙動 = 現行と同一の framework default 500・no-store なし — この非対称を wrapper で「改善」しない・Codex 指摘)。mutation 2 route・webhook 2 route 不触。
- **完了条件**: 4 route の route.test green + pull contract green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 4: 並行命名解消 — clerk.ts / stripe.ts 移設 + CLAUDE.md 追随(W4a・risk・移動のみ)

- **目的**: `lib/clerk.ts` → `lib/clerk/env-check.ts`(verbatim・side-effect only)/ `lib/stripe.ts` → `lib/stripe/client.ts`(verbatim・env fail-fast + `stripe` SDK + `cancelWithRetry`)。test 同時移動(clerk.test.ts → lib/clerk/env-check.test.ts〈dynamic `import('./clerk')` の path 更新含む〉/ stripe.test.ts → lib/stripe/client.test.ts)。importer 更新: clerk = proxy.ts + lib/auth/ensure-user.ts(2 site)/ stripe = app/(app)/app/upgrade/actions.ts・app/api/webhooks/stripe/route.ts・app/(app)/app/settings/actions.ts・lib/stripe/subscription.ts・lib/clerk/handle-clerk-event.ts・lib/stripe/handle-stripe-event.ts(6 site)。**CLAUDE.md §Stripe-1 / §Clerk-1 の path 記述 2 行を新 path に追随**(fail-fast 動作は不変。stripe.ts 冒頭コメントに前例あり = Sprint A-3.2 の env-aware 文言書換)。
- **制約**: verbatim 移動(import/export 文と path のみ差分可)。**旧 path の re-export shim は置かない**(OT 論点 1 (b) 却下 — 完全移設・Codex 指摘の明文化)。**fail-fast 発火タイミング保存 = review 必須観点**(module-load throw の到達が現行と同じ入口〈proxy.ts / ensure-user.ts / stripe 各 consumer〉から連鎖することを importer 一覧で確認・audit §6.3 地雷)。**commit message に「lib/clerk.ts・lib/stripe.ts 移設 + CLAUDE.md fail-fast path 追随」を明示**(OT 条件・CLAUDE.md 変更の追跡可能性)。
- **完了条件**: env-check / client の test suite green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 5: replacer 統合 + VERCEL_ENV helper 化(W4b・risk・書換え / Task4 の後)

- **目的**: ① logger.ts の `expandError` を export 化し、ops.ts の `makeReplacer`(:121-133・byte-exact 重複)を削除して import 置換(新 file を作らない = 最小実装)。② `lib/env/runtime-env.ts` 新設: `runtimeEnv()` = `process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown'` / `isProduction()` = `process.env.VERCEL_ENV === 'production'`。置換対象(**lib 内のみ**・実測 site): logger.ts:69 + :41 / ops.ts:106 + :30,74 / auth/clerk-metadata.ts:64 / clerk/handle-clerk-event.ts ×2 / stripe/handle-stripe-event.ts ×6 / stripe/subscription.ts:267 / env/log-gate.ts:19 / Task4 移動後の clerk/env-check.ts・stripe/client.ts の `isProd`。
- **制約**: 挙動同一(fallback 値・判定式を変えない。`?? 'unknown'` を持たない site があれば現行式を保存し helper 不適用 — 式を変えて合わせない)。runtime-env.ts は依存ゼロ leaf(循環なし)。app 内 inline は対象外。expandError の export 化で logger public surface が増える点は意図的(重複 2 だが byte-exact + OT 確定 = spec §3.6 の例外)。**ops → logger の import 追加で循環が生じる場合(logger 側が ops を参照していた場合)は export 案を中止し共通 module 新設へ切替**(代替方針・Codex 指摘)。**実装直前に `rg VERCEL_ENV lib` で lib 内残存 site を再列挙**(Task4 移動後の path ずれ・列挙漏れ対策・Codex 指摘)— 上記列挙は plan 起草時実測であり最終リストは再スキャンが正。
- **完了条件**: logger / ops / log-gate / 置換対象 file の suite 全 green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 6: retry ⇄ transient dir 統合(W4c・risk・移動のみ)

- **目的**: `lib/transient/classify-bulk-error.ts` + `.test.ts` → `lib/retry/` へ verbatim 移動、`lib/transient/` dir 削除。importer 更新(app/api/entity-mutations/bulk/route.ts / app/api/review-events/bulk/route.ts + 参照 test)。
- **制約**: **実装統合しない**(transient-error.ts と別 file のまま。判定コード集合の差 = 意図的・spec §3.3)。`BULK_TRANSIENT_RETRY_SEC` 等 export 名不変。
- **完了条件**: classify-bulk-error suite + bulk route test 2 本 green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 7: contact-form server action 移設 + Block A allowlist 回収(W5・risk・移動のみ)

- **目的**: `app/(marketing)/contact/actions.ts` の `submitContact`(+同 file 局所 helper)→ `lib/actions/contact.ts`(verbatim・`'use server'` directive 維持・既存 lib/actions/result.ts と同居)。`actions.test.ts` → `lib/actions/contact.test.ts`。`components/marketing/contact-form.tsx:4` の import を `@/lib/actions/contact` に更新。`eslint.config.mjs:134-139` の Block A override(contact-form)を削除。
- **制約**: 移設前に actions.ts の全 importer を grep(contact-form 以外〈page 等〉があれば同時更新)。rate-limit / validation への既存 import 構造不変。**Block A allowlist 0 件**で whole-repo lint green(P0 lint 機構の最終回収)。**client component → lib 配下 'use server' module の import が Next の server action 制約に沿うことを build に加え review 観点にも含める**(Codex 指摘)。
- **完了条件**: contact suite green + override 削除後の lint green + per-task gate + build + canonical + Codex。[reviewed]。

### Task 8: measure revert — TEMP-MEASURE 撤去(W6)

- **目的**: spec §4.6 の撤去。app/api/review-events/bulk/route.ts: :70-86(measureEnabled / timings / measure closure / tStart / `review_events.bulk.request` marker)削除・:111 の `measure('session-upsert', ...)` unwrap(直 await 化)・:173-182(total 集計 + `review_events.bulk.timing` log)削除。lib/reviews/ingest-review-events.ts: `processSession` の `measure` 引数(:91)削除 + 6 call site unwrap(:109/:173/:228/:256/:273/:336・`measure(name, fn)` → `fn()` 展開)。route.ts:171 の呼び出しから第 5 引数除去。
- **制約**: `review_events.bulk.session_upsert_failed` log = TEMP 外・不触。制御フロー不変(measure = `return await fn()` パターンの unwrap のみ — try/finally の timings 記録以外に副作用なしを確認)。co-located test の measure 引数調整は可(assert 内容不変)。**consumer 再確認の範囲分担**(Codex 指摘の明文化): 実装者の再確認 = **repo 内 grep のみ**。repo 外(Vercel log 集計・運用 dashboard 等)の consumer 不在は **OT 判断済み前提**(spec §3.2 = OT 確定・2026-05 計測 campaign 完了済)— 実装者は repo 外を保証しない。**repo 内で consumer 発見 or 挙動変更化 → 即停止**(エスカレーション ①)。
- **完了条件**: review-events route.test + ingest-review-events suite green + **contract 77 snapshot 更新ゼロ**(timing/logger 非凍結の証明 = spec §3.2(i))+ per-task gate + canonical。[reviewed]。

### Task 9: 最終 gate + docs(W7)

- **目的**: full `pnpm test` / `pnpm typecheck` / whole-repo `pnpm lint --max-warnings=0` / `pnpm test:contract`(77・snapshot 更新ゼロ)/ `pnpm build` 全 exit 0。**CLAUDE.md の fail-fast path 記述と実 path の整合を最終確認**(Task4 追随の取りこぼし検知・Codex 指摘)。SSoT 進捗表(P4 完了 + HEAD SHA)+ 変更履歴 / baseline §B(vi) に P4 surface 追記 / 本 plan 実績欄追記。独立 [no-review] commit。
- **完了条件**: 全 gate exit 0 + docs commit。**P4 完了 = DDD リファクタ全体(P0〜P4)完了 → sprint 境界で停止・OT 判断待ち**(develop merge → まとめ stg smoke〈§B(vi)〉→ prod)。

---

## 実行順序と依存

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9。依存は **Task5 が Task4 の後**(移動先 file を書き換えるため)のみ — 他は相互独立だが直列で回す(subagent-driven・task 間 review)。

## 実績欄(実装時に追記)

(未着手)
