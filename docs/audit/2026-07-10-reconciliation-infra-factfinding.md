# 外部連携失敗の永続記録・後追い回収(reconciliation)基盤 — 設計 fact-finding(read-only)

- 日付: 2026-07-10 / branch `develop` / **read-only 調査(実装・schema 変更・push なし)**
- 目的: 実ユーザー onboarding 前に、外部連携(Stripe/Clerk/Gemini)の失敗を**永続テーブルに残し、cron/手動で後追い回収**できる基盤の設計材料を集める。**zero users・DB 全消可ゆえ schema 自由・移行コード不要**。
- 前提 doc: `docs/audit/2026-07-10-{stripe-downgrade-reservation-clear-bug, webhook-external-dependency-pattern-audit, external-api-retry-idempotency-audit}.md`
- 方法: 全 `notifyOps`/`notifyWebhookError` 呼出(17 site)+ 永続 store(`deletion_failures`/`source_documents.status`/`entity_mutations`)+ cron/batch 基盤(`vercel.json`/`scripts/`)を first-hand read。

---

## 結論(TL;DR)

1. **回収に値する外部失敗は永続化されていない**。永続 store は `deletion_failures`(削除時 Stripe cancel のみ・`resolved_at` 付)/ `source_documents.status`(OCR)/ `entity_mutations` outbox(client sync)の 3 つで、**Stripe 課金系の失敗(orphan / A-3 drift / gate mismatch / under-set / price anomaly)+ Clerk sync 失敗は全て `notifyOps → Discord` のみ = SQL で引けず cron 回収不能**。
2. **cron 基盤は存在しない**。`vercel.json` に `crons` なし(regions + webhook maxDuration のみ)。唯一の reconciliation = `reconcileStaleProcessing`(OCR stale)は **cron でなく `/api/exams/status` の on-demand piggyback**。手動 batch の前例は `scripts/backfill-clerk-metadata.ts`(one-shot tsx script)。
3. **推奨設計 = (c) ハイブリッド寄り統一**: 外部連携失敗を **単一 `integration_failures` テーブル**(kind 判別子 + 型付き ref 列 + payload jsonb + `retry_count`/`next_retry_at`/`resolved_at`)に集約。**`deletion_failures` は zero-users ゆえ移行コードなしで吸収**。ただし `source_documents.status`(状態機械)と `entity_mutations`(outbox)は**別目的なので統合しない**。理由 = 回収対象の失敗は「外部 op 未完 → 後で end-state を保証」の同一 lifecycle を共有(≥5 種 = rule-of-three 成立)、1 テーブル + 1 cron が最小 DRY。
4. **回収 cron は Vercel Cron(Pro)で実現可**。`CRON_SECRET` guard 付き route が `WHERE resolved_at IS NULL AND next_retry_at<=now` を走査 → kind 別 recovery。**冪等性は「状態確認先行」**(Stripe retrieve→既に target なら再 act せず resolve。idempotency-key は ~24h prune で不可)。**自動回収可 = 冪等 state-reconciler(release 再撃 / clerk sync 再 PATCH / Stripe→DB 再射影)。手動のみ = 人間判断要(unlinked customer / unknown price / data_deletion tx 失敗)**。
5. **correctness fix と reconciliation は別 phase**。Phase A(#1/#5 clear decouple = golden 保証・orphan を根絶)を先行独立 sprint、Phase B(新テーブル + 記録配線 dual-write + cron = additive・防御網)を follow-up。**A は B を待たない / B は A を壊さない**。B 単独で中規模(3–5 task)。

---

## item 1: 失敗記録 全棚卸し表

**外部連携が失敗した」を扱う全箇所**(17 notifyOps/webhookError site + 3 永続 store):

| # | 箇所(file:line) | 何の失敗か | 現記録先 | SQL 可 | cron 回収可 | self-heal |
| - | ---------------- | ---------- | -------- | ------ | ----------- | --------- |
| S1 | `handle-stripe-event.ts:244`(clear skip)→ `route.ts:53` notifyWebhookError | **downgrade orphan(release 失敗で clear されず)** | Discord のみ | ✗ | ✗ | **なし(恒久)** |
| S2 | `handle-stripe-event.ts:226` | release gate schedule mismatch(sub.schedule≠DB) | Discord のみ | ✗ | ✗ | なし(要人間) |
| S3 | `subscription.ts:265` | autorelease: active だが current_phase null | Discord のみ | ✗ | △ | 予約維持(次 .updated) |
| S4 | `actions.ts:161/197/251` ×3 | **A-3: Stripe 成功後 DB write 失敗**(upgrade 射影 / downgrade set / cancel clear) | Discord + **UI error(rethrow)** | ✗ | △ | webhook 再射影 / released |
| S5 | `actions.ts:283` | subscription unresolved(0/複数/矛盾) | Discord のみ | ✗ | ✗ | なし(要人間) |
| S6 | `handle-stripe-event.ts:114/144` ×2 | unlinked customer(stripeCustomerId 紐付け欠落) | Discord のみ | ✗ | ✗ | なし(要人間) |
| S7 | `project-subscription.ts:40/48` ×2 | missing / unknown price_id | Discord のみ | ✗ | ✗ | なし(config/人間) |
| S8 | `handle-stripe-event.ts:163` | invoice.payment_failed(観測通知) | Discord のみ | ✗ | ✗ | Stripe dunning(外部) |
| C1 | `clerk-metadata.ts:61` | **Clerk publicMetadata sync 失敗** | Discord のみ | ✗ | ✗ | 次 webhook/backfill |
| C2 | `handle-clerk-event.ts:89` | user.deleted だが users 未同期 | Discord のみ | ✗ | ✗ | なし(順序異常) |
| D1 | `handle-clerk-event.ts:225/239` recordFailure | **削除時 Stripe cancel / list / data_deletion tx 失敗** | **`deletion_failures`(永続・resolved_at)** + Discord | **✓** | **✓** | なし(手動回収前提) |
| O1 | `process.ts:337` | OCR pipeline failed | Discord + `source_documents.status='failed'` | 部分 | on-demand | 再 upload(user) |
| O2 | `process.ts:410/462` ×2 | **cards insert / completion tx 失敗(OCR 成功後)** | Discord + status | 部分 | on-demand | なし(cost 消費済) |
| X1 | `contact.ts:104` | contact_messages insert 失敗 | Discord のみ | ✗ | ✗ | なし(送信ロスト) |
| W1 | `route.ts:53/92` notifyWebhookError | webhook handler top-level throw | Discord のみ | ✗ | ✗ | Stripe/Clerk 再送 or なし |

**永続 store の全体像**:

| store | 対象 | 形 | reconciliation 機構 |
| ----- | ---- | -- | ------------------- |
| `deletion_failures`(`schema.ts:214`) | 削除時 Stripe/DB 失敗 | id/user_id/clerk_id/sub_id/kind/error_message/**resolved_at** | **設計済(手動回収前提・cron なし)** |
| `source_documents.status` | OCR 進行/失敗 | 状態列(processing/failed 等) | `reconcileStaleProcessing`(on-demand・15 分 stale cleanup) |
| `entity_mutations` outbox | client→server sync | client 側 queue | client retry controller(`lib/retry/transient-error.ts`) |

---

## item 2: 永続化すべき失敗の分類 + 回収方法

**判定軸** = 「後で end-state を保証する後追いが要る(=永続必須)」か「通知だけでよい(一過性/self-heal/UI 可視)」。

| 失敗 | 回収要否 | 回収方法 | 理由 |
| ---- | -------- | -------- | ---- |
| **S1 downgrade orphan** | **要(高)** | **decouple で根絶 → 残余(best-effort release 失敗)を記録 → cron 再 release** | 恒久破綻・SQL で引けないと気付けない |
| S2 gate mismatch | 要(中) | **手動**(sub.schedule と DB の乖離 = 要人間確認) | 自動 clear/release は誤操作リスク |
| S3 autorelease current_phase null | 要(低) | cron 再評価 or 手動 | 異常状態・低頻度 |
| **S4 A-3 drift** | **要(中)** | **cron: Stripe retrieve → DB 再射影(冪等)** | Stripe=真・DB 遅延を後追い同期可 |
| S5 subscription unresolved | 要(中) | **手動**(0/複数/矛盾 = 要人間) | 自動選択は誤 sub 操作リスク |
| **S6 unlinked customer** | **要(中)** | **手動**(customer↔user 紐付けは人間判断) | 自動紐付け不能 |
| S7 missing/unknown price | 要(低) | **手動**(price mapping config 修正) | config 問題・コード対応 |
| S8 invoice.payment_failed | 不要 | — | Stripe dunning が外部で処理 |
| **C1 Clerk sync 失敗** | **要(中)** | **cron 再 PATCH(冪等)** or backfill script | metadata は idempotent・自動安全 |
| C2 user.deleted 未同期 | 要(低) | 手動(webhook 順序異常の調査) | 稀・順序逆転 |
| **D1 削除 Stripe cancel 失敗** | **要(高・既対応)** | **既 deletion_failures + 手動/cron 再 cancel** | 課金 leak・既に永続化済 |
| O2 cards insert 失敗(OCR 後) | 要(中) | 手動 or user 再 upload | cost 消費済・自動再実行は再課金 |
| S8/X1/W1 等 通知系 | 不要 | — | 一過性 or 外部再送 |

**永続化すべき中核** = S1(残余)/ S4 / S6 / C1 / D1(既) + 記録だけは全 anomaly(S2/S3/S5/S7/C2)も入れて OT が Discord でなく SQL で棚卸せるように。

---

## item 3: テーブル設計 3 案

### (a) 汎用統一 1 テーブル `integration_failures`

```
id uuid pk / kind text (enum: stripe_release|stripe_projection_drift|stripe_gate_mismatch|
  stripe_unlinked|stripe_price_anomaly|clerk_sync|deletion_cancel|deletion_data|... ) /
user_id uuid? / clerk_id text? / stripe_customer_id text? / stripe_subscription_id text? /
schedule_id text? / target_price_id text? /   -- 型付き ref (cron が WHERE/JOIN で使う)
payload jsonb /                                -- 全 context (notifyOps の context をそのまま)
error_message text / retry_count int default 0 / next_retry_at timestamptz? /
resolved_at timestamptz? / created_at timestamptz default now()
```

- **Pros**: 単一 query 面(`WHERE resolved_at IS NULL`)、1 cron で全 kind 走査、新 kind 追加 = enum 値足すだけ(migration 最小)、Discord と dual-write で「通知 + 台帳」両立。
- **Cons**: kind 別 recovery ロジックは結局要る、payload jsonb は型が緩い(→ 型付き ref 列で補う)、`deletion_failures` を吸収する判断が要る。

### (b) 種類別テーブル(deletion_failures 式を課金系にも個別)

- `subscription_reconciliation` / `clerk_sync_failures` / `deletion_failures`(既) …
- **Pros**: 各ドメイン型付き列、既存 pattern 踏襲。
- **Cons**: テーブル増殖、N cron or N 分岐、新 kind = 新 migration。zero-users で統一の好機を逃す。

### (c) ハイブリッド(推奨)

- **外部連携失敗 = (a) の統一 `integration_failures` に集約**(S1 残余/S2/S3/S4/S5/S6/S7/C1/C2/D1 全部)。**`deletion_failures` は zero-users ゆえ吸収**(移行コード不要 = テーブル差し替え)。
- **状態機械は統合しない**: `source_documents.status`(OCR の進行状態)/ `entity_mutations`(client outbox)は失敗台帳でなく別目的 → そのまま残す。
- **理由**: 回収対象は全て「外部 op 未完 → 後で end-state 保証」の同一 lifecycle(record→retry→resolve)。≥5 kind で rule-of-three 成立、1 テーブル + 1 cron が最小 DRY。`deletion_failures` は既に理想形(`resolved_at`)なのでその一般化にすぎず新発明でない(既存パターン踏襲、item 6)。

**→ 推奨 = (c)**。`deletion_failures` を `integration_failures` に一般化吸収し、OCR/outbox 状態機械は不干渉。

---

## item 4: 回収バッチの設計余地 + Vercel cron 制約

- **現状 cron ゼロ**(`vercel.json` に `crons` なし)。導入は `vercel.json` の `crons: [{path:"/api/cron/reconcile", schedule:"*/15 * * * *"}]`(**Pro plan で sub-hourly 可**・hnd1・function maxDuration は現行 webhook と同じ 60s、必要なら 900s まで設定可)。
- **route 設計**: `/api/cron/reconcile-integrations` を **`CRON_SECRET` guard**(`Authorization: Bearer` 検証、Vercel Cron が自動付与)。`WHERE resolved_at IS NULL AND (next_retry_at IS NULL OR next_retry_at<=now) AND retry_count<N` を走査 → kind 別 dispatch → 成功で `resolved_at=now`、失敗で `retry_count++`/`next_retry_at=now+backoff`。
- **冪等性 = 状態確認先行(必須)**: Stripe idempotency-key は ~24h prune(`subscription.ts` コメント)で cron 再試行には使えない。**代わりに retrieve→状態判定→既に end-state なら act せず resolve**(= `releaseCompletedDowngrade` の status gate と同思想)。例: orphan 回収 = schedule retrieve → status=released/completed なら DB clear だけ、active なら release+clear。
- **自動回収可(冪等 state-reconciler)**: S1 残余(release 再撃・status 確認付)/ C1(clerk metadata 再 PATCH・本質冪等)/ S4(Stripe retrieve→DB 再射影・Stripe が真)。
- **手動のみ(自動は危険)**: S6 unlinked(customer↔user 紐付けは人間)/ S5 unresolved(誤 sub 操作リスク)/ S2 gate mismatch(乖離要調査)/ S7 price anomaly(config 修正)/ D1 data_deletion tx(破壊的・要慎重)。→ これらは **記録 + Discord のみ、cron は resolve せず OT dashboard/SQL で手動**。
- **代替案(cron 無し)**: `backfill-clerk-metadata.ts` 式の **手動 tsx script**(OT が随時実行)。cron 導入前の暫定 or 手動 kind 専用。既存前例あり = 低コスト。

---

## item 5: correctness fix との関係(phase 分割)

- **Phase A(correctness・golden 保証・破壊的変更)**: #1/#5 の clear decouple(順序反転)+ 冪等条件付き UPDATE。**orphan を根絶**(release 失敗が DB を汚さない)。golden test で挙動 pin。→ **この時点で S1 の恒久破綻は消える**。
- **Phase B(reconciliation・additive・非破壊)**: `integration_failures` テーブル新設 + notifyOps site を **dual-write 化**(Discord 通知は残す + テーブルに 1 行)+ cron route + 自動 kind の recovery dispatch。**既存挙動を変えない additive**ゆえ低リスク。B が記録するのは主に「Phase A 後も残る best-effort release 失敗(schedule 未 detach)」+ S4/S6/C1 等の drift。
- **切り分け原則**: **A は B を待たない**(correctness が最優先・B 無くても orphan は消える)。**B は A を壊さない**(additive・golden に触れない)。→ 同 sprint 内なら「Phase 1=A(golden)→ Phase 2=B(additive)」、別 sprint なら A 先行。

---

## item 6: 既存パターンとの一貫性

- **`deletion_failures` 踏襲 + 改良**: `resolved_at` による手動回収前提の設計は正しい。改良点 = **`retry_count`/`next_retry_at` を足して cron 自動回収に対応**(deletion_failures は手動のみ想定だった)+ kind を課金系に拡張。統一テーブルはこの自然な一般化。
- **`syncClerkPublicMetadata` の throw-safe(ok:false + notifyOps)**: 「外部失敗を DB 整合から切り離す」= reconciliation の前提そのもの。統一テーブルへの記録は **この notifyOps を dual-write に置換**(throw-safe を維持・記録失敗が本処理を巻き込まない best-effort)。
- **`notifyOps` は残す**: 台帳(SQL 回収)と通知(即時 Discord alert)は目的が別。**dual-write(記録 + 通知)**が正。notifyOps を廃止して table 一本化しない。

---

## sprint 構成案 + 規模感

| phase | 内容 | 規模 | 依存 |
| ----- | ---- | ---- | ---- |
| **A: correctness** | #1/#5 clear decouple + 冪等条件付き UPDATE + golden | **小(G→R 1–2 task)** | 独立・最優先 |
| **B1: 記録基盤** | `integration_failures` schema(deletion_failures 吸収)+ `recordIntegrationFailure` helper + notifyOps site の dual-write 配線(~10 site) | **中(2–3 task)** | A の後(A の残余を記録) |
| **B2: 回収 cron** | `/api/cron/reconcile` route + CRON_SECRET + 自動 kind recovery(状態確認先行)+ vercel.json crons | **中(2 task)** | B1 の後 |

- **推奨** = **A を独立小 sprint で先行**(correctness 解消)、**B(B1+B2)を follow-up sprint**。B は additive で zero-users ゆえ急がない。同 sprint 化も可だが「A の golden を B の配線が汚さない」境界を plan で明示。
- **全部込みは 5–7 task = 単一 sprint の上限**。300 行 plan 制約に収めるなら **A+B を分割**が安全(A は既 doc で fact-finding 済、B は本 doc が起点)。
- 決済経路ゆえ canonical + Codex + Test Clock smoke。B の cron は smoke で「未解決行を cron が resolve」まで確認。

---

## OT が決めるべき設計判断

1. **テーブル設計 (a)/(b)/(c)**(推奨 c)。`deletion_failures` 吸収 or 残置。
2. **cron 導入 vs 手動 script 暫定**(Vercel Pro cron / `backfill-*.ts` 式)。導入するなら頻度(`*/15` 等)。
3. **自動回収を許す kind の範囲**(推奨: release/clerk_sync/projection のみ自動、他は手動)。
4. **notifyOps dual-write か置換か**(推奨: dual-write 維持)。
5. **sprint 分割**: A 独立先行 + B follow-up(推奨)/ A+B 単一 sprint 2 phase / B は当面見送り(A のみで orphan は消えるため B は defense-in-depth)。
6. **記録対象の広さ**: 回収要る中核(S1/S4/S6/C1/D1)だけか、全 anomaly(S2/S3/S5/S7/C2 も台帳化して SQL 棚卸し可能に)か。
7. **payload jsonb vs 型付き列**の粒度(推奨: 主要 ref は型付き列 + 残り jsonb)。

---

## 掃除(未完・OT 手動)

test clock 2 件 + test10/test11 users 行削除は CC 権限/環境で実行不可(`rk_test_` に `billing_clock_write` なし・`psql` 不在)→ OT が Stripe Dashboard + Supabase SQL で手動。

---

## 参照(file:line)

- 失敗記録 site: `lib/ops.ts:23-117`(notifyOps/notifyWebhookError)/ 全 17 notifyOps site(本 doc item 1 表)
- 永続 store: `lib/db/schema.ts:214-227`(deletion_failures + resolved_at)/ `lib/clerk/handle-clerk-event.ts:217-248`(recordFailure)
- cron 現状: `vercel.json`(crons なし)/ `app/api/exams/status/route.ts`(reconcileStaleProcessing on-demand)/ `scripts/backfill-clerk-metadata.ts`(手動 batch 前例)
- 冪等 recovery の型: `lib/stripe/subscription.ts:254-289`(releaseCompletedDowngrade status gate)
- 前提 doc: `docs/audit/2026-07-10-{stripe-downgrade-reservation-clear-bug, webhook-external-dependency-pattern-audit, external-api-retry-idempotency-audit}.md`
</content>
