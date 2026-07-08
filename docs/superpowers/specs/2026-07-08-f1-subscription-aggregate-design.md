# F1: Subscription aggregate — design spec

- 日付: 2026-07-08 / branch `develop` / 前提 HEAD: fact-finding 時 `e476ea9`(着手時に再スキャン)
- 入力: `docs/audit/2026-07-08-f1-subscription-factfinding.md`(58f5cd4)+ OT/claude.ai 確定 6 判断(下記・**再議論しない**)
- 位置づけ: 完全 DDD の F1(意図 doc `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` §5)。**repository / aggregate / VO の「型の基準回」** — F2/F4 はこの形を踏襲する。

---

## 1. 確定判断(spec の前提・固定)

1. **aggregate 境界** = `users` 行全体でなく **subscription slice のみ**(plan 6 列: plan / billingInterval / subscriptionStatus / currentPeriodEnd / cancelAt / stripeSubscriptionId + 予約 3 列: scheduledDowngradeScheduleId / scheduledTargetPriceId / scheduledChangeEffectiveAt)。clerkId / email 等 billing 外は境界外。
2. **VO = 2 つのみ**: (a) status→plan 導出(I-1/2/3)(b) 予約 3 列 = ScheduledChange(I-9・6 site 最重複)。他列は VO 化しない(YAGNI)。
3. **source of truth** = Stripe(plan/status の system of record)。DB 列 = gating 用 local materialization。書込方向 = Stripe snapshot → 射影 → DB、gating read = DB。**aggregate が方向を保証し逆流(DB/ローカル計算値から plan 列を書く)を構造禁止**。
4. **W-A2 は F1 内で埋める**。webhook route の 200-swallow(D-2 凍結 wire)は不触。挙動変更は純粋 refactor と**別 commit に隔離**。
5. **repository = フル実装**(型の基準回)。ただし server-only 単一 table ゆえ薄い(sync/client/runOptimistic* なし・drizzle over subscription slice のみ)。フル展開の最終判断は F3 到達時。
6. **安全網 = F1 先頭 step の golden 先張り**(独立 phase にしない)。characterization を F1 内に畳む。

環境前提: **zero users(prod 含む)・migration 一切不要**。lazy migration / version 分岐 / 互換シムを書かない。※本 spec は結果として **schema 変更ゼロ**(列の追加・削除・変更なし。DROP+再作成の権利は留保するが不要)。

## 2. スコープ / やらないこと

**やる**: subscription slice の aggregate + VO 2 + repository + 射影 use-case 化(server-only)/ golden 先張り 7 本 / W-A2 fix / I-7 signal drift の定義一本化。
**やらない**: wire 変更(webhook envelope・400/200 分離・response body = D-2 凍結)/ schema 変更 / client 側の一切(mirror 不在ゆえ非該当)/ Quota・plan-limits の aggregate 化(Plan/User subdomain・F1 外)/ checkout セッション作成 flow の再設計 / event sourcing / domain event 型の新設(F5)/ 他 aggregate への波及。

## 3. 目標構造と file 配置(P1 carve-out / P2「lib/stripe 既存」踏襲)

```
lib/stripe/
  domain/                          ← 新設(純粋層。将来 packages/domain の下敷き)
    subscription-values.ts         ← VO(a)(b)
    subscription-aggregate.ts      ← aggregate(状態 + 遷移 + gating 判定。全 pure)
  subscription-repository.ts       ← repository(infra。drizzle over users の subscription slice)
  project-subscription.ts          ← 射影 use-case(Stripe snapshot → aggregate → repo → Clerk sync)
  subscription.ts                  ← 既存維持(Stripe API 呼出 = infra service: applyUpgrade /
                                      scheduleDowngrade / release 系。aggregate からは呼ばない)
  subscription-changes.ts          ← 既存維持(classifyChange / getPendingState。cancel 判定は
                                      VO の単一定義を参照する形に接続)
  handle-stripe-event.ts           ← orchestrator に縮退(event 分岐 + use-case 呼出)
  price-mapping.ts                 ← 既存維持(VO(a) が参照)
app/(app)/app/upgrade/actions.ts   ← aggregate gating + repo 経由に置換(W-A2 で射影 use-case を共用)
```

**import 純度(構造保証の実体)**: `lib/stripe/domain/*` は **`import type Stripe` のみ可**(runtime import ゼロ)— drizzle / next / lib/ops / lib/db / price-mapping 不可。price 解決は resolver 注入(§3.1(a)・Codex 指摘採用)で受け、env-coupled module への依存を持たない。P0 lint 機構(eslint flat config の import 境界)に enforce ルールを追加(escape 規約は CLAUDE.md 準拠)。lint ルール追加は挙動不変だが lint surface が変わるため **R 系列内の独立 commit に分離可**(plan で確定)。repository と use-case だけが drizzle / notifyOps に触れる。
※ domain が `Stripe.Subscription` 型を受ける結合は許容(型 only = runtime 依存なし・P1 `subscription-changes.ts` 前例。判断 3 の「射影入力 = Stripe オブジェクト強制」という構造保証が優先。F4/モノレポ時は型 alias で切断可 — Codex 対立論点への回答)。

### 3.1 VO(判断 2)

**(a) status→plan 導出**(`subscription-values.ts`):
- `normalizeSubStatus(stripeStatus) → 'active'|'past_due'|'canceled'`(現 handle-stripe-event.ts:32-50 を verbatim 移設)。
- `derivePlanFromStripe(stripeStatus, priceId, resolvePrice) → { plan, billingInterval, anomaly: null | 'unknown_price' | 'missing_price' }`(現 resolvePlanFromSub:63-102 の**純粋 core**。price↔plan 解決は `resolvePrice` 引数注入 — use-case が `price-mapping.resolveFromPriceId` を渡す。domain の env 依存ゼロ化・unit test 容易化 = Codex 指摘採用)。
- **anomaly 通知の挙動不変条件**(Codex 指摘採用): notifyOps は caller(use-case)が **導出直後・DB 書込前**に発火(現行 resolvePlanFromSub 内発火と同順序)。DB 書込が後で失敗しても通知は済んでいる。payload 文言・回数は現行維持(G2 + 既存 unknown-price golden が pin)。
- I-2(unpaid/incomplete = status past_due だが plan free)の非対称は VO 内に閉じる。

**(b) ScheduledChange**(`subscription-values.ts`)— 概念 = **「予約された将来変更」**(downgrade 予約と解約予約の両方。I-6 gating が両者を同格に CHANGE_BLOCKED で扱う現行構造に対応 — cancel predicate の同居理由・Codex 指摘採用):
- `type ScheduledChange = { scheduleId, targetPriceId, effectiveAt } | null` — 予約 3 列を単一値として扱う(I-9 の set-together/clear-together を型で保証。列を個別に書く API を repository に作らない)。
- `isCancelScheduled(sub: Stripe.Subscription): boolean` — cancel 判定(`cancel_at != null || cancel_at_period_end === true`)の**単一定義**。getPendingState はこれを参照(I-7 drift の回収 — §7)。

### 3.2 aggregate(`subscription-aggregate.ts`・全 pure)

状態 = subscription slice の snapshot(repository が row から構築)。メソッド(名称は指針・plan で確定):
- `projectStripeSnapshot(sub: Stripe.Subscription) → SliceUpdate` — plan 6 列の射影(判断 3 の唯一の書込入口。checkout/created/updated/W-A2 が共用)。
- `applyDeleted() → SliceUpdate` — `.deleted` の reset(plan free / status canceled / cancelAt null / subId null / 予約 clear。currentPeriodEnd 非更新は現行維持)。**scrub 済 row(clerkId null)にも同一動作** — 有効 user と scrub row の区別は書込側でなく通知/Clerk sync 側(A-4 分岐)の責務(Codex 指摘採用)。
- `reserveDowngrade(change: ScheduledChange)` / `clearReservation()` — 予約 3 列遷移(I-9)。
- `canChangePlan(pending: PendingState) → ok | blocked(reason)` — I-6 gating(DB 列 = 真実 source を aggregate 内に固定)。
- `evaluateRelease(dbState, stripeSub) → 'delegate' | 'clear_direct' | 'skip' | 'mismatch'` — release gate #1/#5 + 保険分岐(I-8)の**判定だけ**を pure 化。Stripe API 実行(releaseCompletedDowngrade 等)は infra service に残し、use-case が判定→実行→結果適用を編成。**mismatch = 書かず notifyOps・OT 介入**(現行 :371-381)を保存。判定値ごとの副作用・throw/swallow・再入の対応表は **plan で現行コードから起こす**(Codex 指摘採用・spec では現行挙動 verbatim 維持を規定)。

**判断 3 の構造禁止**: plan 6 列を返す SliceUpdate を生成できるのは `projectStripeSnapshot` / `applyDeleted` のみ(引数に Stripe オブジェクトを要求 = ローカル計算値からの逆流を型で不可能にする)。

### 3.3 repository(`subscription-repository.ts`・判断 5)

- `DbExecutor` 型(tx/db 両対応・既存 apply 関数群と同形)で drizzle 直叩きを包む。
- load: `byUserId` / `byStripeCustomerId` / `byScheduleId`(現 3 種の WHERE を網羅)。
- save は**単一汎用口にしない**(Codex 指摘採用): 意図別メソッド `saveProjection` / `applyDeletedReset` / `saveReservation` / `clearReservation` に分け、各引数型を対応する aggregate メソッドの戻り値型に限定 — 逆流禁止(判断 3)と予約 3 列 atomicity(I-9)を**型で**保証(予約列を個別に書ける口を作らない)。
- **戻り値(RETURNING)shape**(Codex 指摘採用): `{ matched: boolean, clerkId: string | null, scheduledDowngradeScheduleId, scheduledTargetPriceId }` — A-4 の row-match/clerkId 分離と release gate 評価に現行分岐が要求する全 field を明示(単なる updatedCount にしない)。
- **identity/correlation fields**(stripeCustomerId / clerkId / deletedAt)は aggregate **状態ではなく** lookup key・RETURNING correlation として repository/use-case 層で扱う(境界の精密化・Codex 指摘採用)。
- **owner-scope 絶対則**: 全 query は現行の WHERE(users.id / clerkId / stripeCustomerId / scheduleId)を verbatim 維持。0 行 match 時の分岐(silent / notifyOps)も現行維持 — zero users 前提は migration 不要の根拠であって **runtime 防御分岐の削除理由にしない**(過去 event / 残存 customer は来うる・Codex 指摘採用)。

### 3.4 射影 use-case(`project-subscription.ts`)

`projectStripeSubscription(db, key, sub)` = VO 導出 → **anomaly 通知(DB 書込前・§3.1(a))** → aggregate.projectStripeSnapshot → repo 書込 → RETURNING gate 付き Clerk publicMetadata sync。webhook 3 経路(checkout Step2 / created / updated)の重複射影を単一化し、**W-A2(phase W)で upgrade action からも共用**する。

- **key 設計**(Codex 指摘採用): caller ごとに明示 — checkout Step2 = `clerkId` / created・updated = `stripeCustomerId` / W-A2 action = `users.id`(owner-scope)。0 行 match 時の挙動差(checkout = Clerk sync skip / created = silent / updated = notifyOps)は use-case でなく **caller 側分岐に残す**(現行挙動 verbatim 維持のため)。
- **error 伝播の呼び出し側差分**(Codex 指摘採用): use-case は throw を伝播する。webhook 側 = route outer catch → notifyWebhookError + 200(現行・不触)。action 側(W)= A-3 型 catch(§6)。
- **Clerk sync の重複実行**: action(W)と webhook が同値 plan を重複 sync しうるが、`syncClerkPublicMetadata` は同値 set 冪等 + 非 throw(ok:false)で現行 webhook 3 経路間でも既に重複しており新規性なし(Codex 論点への回答)。

## 4. Phase 構成 = commit 境界(安全網先行順序・固定)

| phase | commit | 内容 | 挙動 |
|---|---|---|---|
| **G** | `test(stripe): F1 golden 先張り…`(1 commit) | §5 の golden 7 本 | 不変(test 追加のみ) |
| **R** | `refactor(stripe): …`(移動系。plan で 2-3 commit に分割可) | §3 の抽出・配線置換。**golden/snapshot 更新ゼロ = 挙動不変の客観証明** | 不変 |
| **W** | `fix(billing): close upgrade projection window (W-A2)`(単独 commit) | §6。専用 test 同梱 | **変更(隔離)** |

- R で golden が赤 → 即停止(挙動不変の破れ)。golden を修正して通す行為は禁止(P0〜P4 と同じ規律)。
- W は決済重要 fix → review pass → **TAG 無し commit** → stg/OT 実機確認後 amend で `[reviewed]`(A-3 と同運用)。G/R は canonical(+リスク箇所 Codex)review 後 `[reviewed]`(G は test-only だが billing 安全網ゆえ canonical 通す)。

## 5. Phase G: golden 先張り(具体対象・7 本)

fact-finding の「効く GAP 8 件」中、F1 refactor が触る経路に効く 7 本(GAP #7 は G7 に統合。番号は audit doc §6 GAP 対応):

| # | 置き場 | 内容 | 塞ぐ GAP |
|---|---|---|---|
| G1 | `tests/contract/webhook-stripe.contract.test.ts`「status matrix」 | `paused → status=canceled, plan=free` + 未知 status(default 分岐)→ canceled | #1 |
| G2 | `app/api/webhooks/stripe/route.test.ts` 配線 describe | price 欠落(items 空)→ notifyOps `'stripe sub missing price_id'` + plan=free | #3 |
| G3 | `tests/integration/stripe-webhook.test.ts` | checkout Step2 `subscriptions.retrieve` reject → Step1 link は成功・outer catch → notifyWebhookError + **200**・plan 書込なし | #4 |
| G4 | `lib/stripe/subscription.test.ts` | `cancelScheduledDowngrade` の already-released **message regex** path swallow(既存 resource_missing の対) | #5 |
| G5 | `app/(app)/app/upgrade/actions.test.ts` | Stripe 側 cancel 予約 × DB 予約列 non-null **共存** → CHANGE_BLOCKED + Stripe mutate 未呼出 | #6 |
| G6 | `tests/integration/stripe-webhook.test.ts` | `.created` 先着(0 行 match・silent)→ `checkout.session.completed` 後着で link + plan sync 完了(順序 recovery end-to-end) | #8 |
| G7 | `lib/stripe/subscription-changes.test.ts` **新設** | classifyChange 全 rank matrix + getPendingState cancel 合成 predicate(cancel_at のみ / cancel_at_period_end のみ / 両方)= VO 抽出の直接安全網 + I-7 の現関係 pin | #2 + #7 |

既存凍結(contract status matrix / release gate §6.4 全分岐 / A-4)は追加不要 — R の回帰の正はこれら + G1-G7 の合計。**「更新禁止対象」= 既存 golden/snapshot 全部 + G1-G7**(G で追加した分も R では凍結)。R 中の高速反復は unit/route.test 中心、integration(G3/G6)は commit 前 gate で回す(反復速度への Codex 論点 — 運用詳細は plan)。

## 6. Phase W: W-A2 fix(upgrade 整合窓を埋める)

**現状**: `changePlan` upgrade 枝(actions.ts:130-132)は `applyUpgrade`(Stripe)→ `redirect` で **DB 書込ゼロ**。webhook 遅延/欠落時 Stripe=新価格 / DB=旧 plan が無検知で残る(fact-finding W-A2)。

**機構 = eager projection(推奨・CC 判断点①)**: `applyUpgrade` は更新後 `Stripe.Subscription` を返す(subscription.ts:104-119 確認済)。upgrade 成功後、action がその**返却 snapshot** を §3.4 の `projectStripeSubscription` に渡して即時射影する。

- **判断 3 との整合**: 射影入力は Stripe response そのもの = 「Stripe snapshot → DB」方向を維持(webhook 専属を「射影 use-case 専属」に一般化。ローカル計算値の逆流は引き続き構造禁止)。
- **webhook との競合**: 後着 `.updated` webhook は同じ snapshot 系列を冪等再射影(現行「後勝ち同じ値」と同じ性質)。順序不定でも終状態同一。
- **edge(支払保留)**: `payment_behavior: 'pending_if_incomplete'` で支払失敗時、返却 sub は旧 price + pending_update。I-14(pending_update 非昇格)どおり extractSubFields は現 item price を読む → **旧 plan を射影 = 正しい**(upgrade 未発効を DB が正確に反映)。
- **検知**: 射影の DB 書込失敗は **A-3 と同型**(db 書込のみ try/catch → 内側 best-effort notifyOps(`operation: 'applyUpgrade'`)→ 元 error rethrow・redirect は try 外)。
- **失敗 UX と自己修復**(Codex 指摘採用・明記): DB 射影失敗時、user にはエラーが見えるが Stripe は変更済(A-3 既存 2 窓と同じ二重状態・notifyOps で OT 可視)。**再試行は自己修復**: DB=旧 plan のまま → classifyChange=再び upgrade → Stripe 側は既に target price のため同 price update = 実質 no-op(proration 差分なし・operationId 別で idempotency 衝突なし)→ 返却 snapshot の再射影で DB が治る。webhook 到達でも治る(二重経路)。二重課金は Stripe の同 price update 性質により構造的に発生しない。
- **200-swallow 不触**: 変更は action path のみ。webhook route / handle-stripe-event の error 面は一切触れない(判断 4)。
- **Clerk sync**: 射影 use-case を共用するため RETURNING gate 付き Clerk sync も同時に走る(webhook と完全対称・単一定義。sync 失敗は非 throw(ok:false)ゆえ upgrade を落とさない)。

**非真空 test(実失敗を起こす)**:
1. upgrade 成功 → users に plan/interval/status/periodEnd が **Stripe 返却値どおり**書かれる(値 assert・「throw しない」だけの真空 assert 禁止)。
2. 射影 db 書込 reject → notifyOps 1 回(operation='applyUpgrade')+ 元 error rethrow・redirect 不到達(A-3 test :349-392 と同型)。
3. notifyOps 自身 throw でも元 DB error を rethrow(A-3 :376 同型)。
4. pending_if_incomplete(返却 sub = 旧 price + pending_update)→ **旧 plan のまま**射影される(I-14 の action 側 pin)。
5. 射影後に `.updated` webhook 後着 → 終状態不変(冪等・G 系 + 既存 route.test で担保、W で統合 1 本)。

**却下した代替(記録)**: (i) 検知専用(期待値列 + 突合)= 列と突合機構の追加で機構過剰・窓自体は開いたまま(YAGNI)。(ii) webhook 到達監視(外部 timer)= 新規 infra・Vercel 制約(常駐なし)と不整合。

## 7. I-7 signal drift の回収(副産物・phase R 内)

drift = gating(getPendingState:42 の合成 predicate)と永続(extractSubFields → cancelAt のみ)が別定義。回収 = **定義の一本化**(挙動不変): `isCancelScheduled` VO(§3.1(b))を唯一の cancel 判定定義とし getPendingState が参照。永続は現行どおり `cancelAt` raw 保存(gating = 合成 / 永続 = raw という**関係自体を G7 が pin** し、意図として VO に註記)。`cancel_at_period_end` の DB 列は既に廃止済 = DROP 対象の残骸なし。

## 8. 制約(全 phase 共通)

- D-2 凍結 wire 不変: webhook envelope(署名 400 / idempotency / handler error→200 / response body)・`/api/*` 契約に一切触れない。contract 77 は**snapshot 更新ゼロ**で通す(G の追加分を除き既存 snapshot 不変)。
- owner-scope 絶対則(CLAUDE.md Clerk 3): repository の全 query が現行 WHERE を維持。
- A-4(row-match / clerkId 分離)・A-3(既存 2 窓の検知)の挙動を R で変えない(route.test A-4 suite + actions.test A-3 suite が pin)。
- 簡潔性規律: aggregate メソッドは実在遷移のみ(起きえない遷移の防御分岐を書かない)。VO は確定 2 つのみ。
- test 方針: 既存 mock 境界(stripe / db / ops / clerk)を維持。実 API 禁止。

## 9. 完了条件

1. Phase G/R/W の全 commit が §4 の境界で分離され、R は **golden・snapshot 更新ゼロ**で full test green。
2. whole-repo gate: `pnpm lint --max-warnings=0` / `typecheck` / `test`(full)/ `build` 全 exit 0(import 境界 lint 追加を含む)。
3. W の非真空 test 5 本 green + W-A2 の検知が A-3 と同型で作動(unit で実証)。
4. canonical + Codex review(risk = R の配線置換と W)で未解決 Critical 0 / Important 0。
5. W commit は TAG 無し → OT 実機(stg upgrade 実走)確認後 `[reviewed]` amend。
6. stg smoke(push 後 OT 指示): 正常 upgrade / downgrade 予約→取消 / 退会 の非退行 + upgrade 直後 DB 反映(W-A2)の確認。

## 10. CC 判断点(6 決定の範囲内での具体化・OT veto 対象)

1. **W-A2 機構 = eager projection**(§6。「埋める」の実現として検知専用でなく窓自体を閉じる)。
2. **file 配置 = `lib/stripe/domain/` subdir 新設**(P1 の「lib/domain 一括新設せず」は維持しつつ、feature 内 subdir で純粋層の物理 seam を作る = F4/モノレポの下敷き。flat 配置より import 境界 lint が単純)。
3. **eager projection に Clerk sync を含める**(射影 use-case 共用の帰結・webhook と単一定義。DB のみ書いて Clerk を webhook 任せにする分割は二重定義に戻るため不採用)。
4. **price 解決は resolver 注入**(Codex 指摘採用で当初案から変更 — domain の runtime import ゼロ化。§3.1(a))。

## 11. Codex cross-check 統合記録(帰属)

`docs/codex/2026-07-08-plan-f1-subscription-aggregate.md`(1 パス・独立論点)。CC spec との突き合わせ結果:

- **採用(spec に反映)**: ① repository save の意図別メソッド化(単一汎用口の型保証不足)② price resolver 注入(domain の env 依存除去)③ W-A2 失敗 UX + 再試行自己修復の明記 ④ RETURNING shape の具体化(matched/clerkId/予約列)⑤ identity fields の層別扱い(状態でなく key/correlation)⑥ anomaly 通知の順序固定(DB 書込前)⑦ use-case error 伝播の呼び出し側差分明記 ⑧ applyDeleted の scrub row 動作明記 ⑨ isCancelScheduled 同居理由の概念定義 ⑩ 「更新禁止対象」の範囲明確化(既存+G 追加分)⑪ zero-users ≠ runtime 防御不要の明文化 ⑫ lint 追加 commit の分離可。
- **部分採用(plan へ委譲)**: release gate 判定値→副作用対応表 / integration test の反復運用。
- **不採用(理由記録)**: domain の Stripe SDK 型結合の回避 — 型 only import は runtime 依存なしで、判断 3 の構造保証(射影入力 = Stripe オブジェクト強制)が優先(§3 註記)。
- **確認のみ(spec 変更不要)**: G6 の silent 期待は現行事実(`.created` 0 行 silent = A-4 で維持確認済)と一致 / source-of-truth 非対称の型分離は §3.2-3.3 で既対応。

## 参照

- fact-finding: `docs/audit/2026-07-08-f1-subscription-factfinding.md`(I-1〜I-16 / GAP 1-8 / W-A2 / 列型 3 点セット)
- 意図 doc: `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` / SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(D-2 / N-5 / P1〜P4 配置前例)
- Group A: A-3 = `c5075e0`(検知パターンの型)/ A-4 = `e476ea9`(row-match 分離)
