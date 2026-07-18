# RLS 導入前 性能実態 fact-finding(Perf-0)

- 日付: 2026-07-18 / branch: `develop`(HEAD `02355c2`)
- 目的: RLS(`SET LOCAL` + transaction 包み)導入判断の **before 計測** と、RLS が直撃する **並列/tx 構造の全列挙**。RLS 導入は前提決定済み(OT)。本調査はその配管設計と性能 gate の基礎数字を作る。
- **本 doc は調査のみ・変更なし・設計判断なし**(事実からの直接の含意のみ)。
- 関連: `docs/audit/2026-07-18-tenant-isolation-integration-test-factfinding.md`(Iso-0。§1.2 経路 inventory を再利用、load-bearing は現物再確認)/ `docs/superpowers/lessons/2026-05-25-link-prefetch-amplifies-server-load.md`(prefetch 並列増幅の一次記録)。
- 方法: 2 並列 general-purpose subagent(並列クエリ / tx 内 I/O)+ CC 本体裏取り(pool 設定・prefetch・RLS 機構・raw SQL)。
- **Perf-0b 追記(2026-07-18)**: §3 の read 経路 end-to-end p50/p95 を Playwright MCP 経由で stg 実測(path (a))。§3.2 = **RLS after 比較の基準線**。計装 deploy(案 b)・write 経路 30 回は OT 方針で不採用。

---

## 0. 要約(load-bearing facts)

1. **[裏取り済] RLS 機構の帰結 = 「request 全体を 1 tx に包む」必須**。Supabase Transaction Pooler(PgBouncer transaction mode)では session 単位 `SET` は使えず、`SET LOCAL`(tx-scoped)を各 request の tx 先頭で発行する形が唯一。→ 現在 `Promise.all` で **別コネクションに分散して並列実行している DB クエリ群は、1 tx = 1 コネクション上で直列化**される。これが RLS 性能コストの本体。
2. **[裏取り済] postgres-js の pool 上限は既定値 `max: 10`**(`lib/db/index.ts:20` は `{ prepare: false }` のみ指定、`max` 未指定 → postgres-js 既定 10。`node_modules/postgres/src/index.js:449`)。1 request = 1 tx = 1 コネクション占有ゆえ、RLS 後は「同時 in-flight request 数」がそのまま pool 圧に直結する。
3. **[裏取り済] RLS で並列性を失う server DB サイトは 3 箇所のみ**(§1): ① `GET /api/pull`(`route.ts:66`)6-way delta → **6 直列** ② RSC `/app/upload`(`page.tsx:91`)N=2 → 2 直列 ③ **`POST /api/entity-mutations/bulk`(`route.ts:274`)= 最大影響**。group 間 `Promise.allSettled`(Y-2 T-B3 の perf 最適化)+ per-mutation nested `db.transaction` の両方が単一 outer tx と衝突(§1.1)。他 RSC/route は逐次(RLS 影響 = SET LOCAL overhead のみ)。
4. **[裏取り済/Perf-0b 更新] read 経路 end-to-end は Playwright MCP 経由で stg 実測済**(§3.2)。Bash/local-script は sandbox の outbound deny(`curl` permission denied、IS_SANDBOX=1)で到達不能だが、**Playwright MCP の browser egress は stg に到達**するため read 計測はこの経路で実行。**未計測(据置)= ① DB 時間の切り出し/並列部 max vs sum(server-timing 計装未実装ゆえ計装 deploy 要)② write 経路(OT 方針で不採用)③ Supabase pooler 実値(OT dashboard、§7)**。
5. **[裏取り済] prefetch 並列爆発は S-perf-1 で対処済・現状維持**。全 dynamic `/app/*` `<Link>` に `prefetch={false}` 付与済(§5)。ただし RLS 観点では **prefetch とは独立に**、dynamic page が全て cookie(Clerk auth)依存で dynamic に倒れており、各 RSC render が `getCurrentUser()`(auth + users SELECT)を走らせる = RLS 後は各 render が個別 `SET LOCAL` tx を要する(§5.3)。
6. **[裏取り済] 既存 server tx 10 本の tx 内 外部 I/O = 0**(§2.A)。ただし 2 点が RLS 配管の要注意面: ① `runUploadGuardTx` が tx 保持中に別 `getDb()` 接続を +2 本取る(`canRunOcr`/`getTodayAiUsageGlobal`)= RLS で `SET LOCAL` 未伝播(correctness)+ pool 圧(§6.6)。② 「request 全体を 1 tx」設計を採ると OCR(Gemini 720s)/ 一部 Stripe・R2 経路が tx 内に落ちる。現行 OCR は既に guard/OCR/persistence を 3 tx 分離済で Gemini は tx 外(§2.B)= この分離を RLS 後も維持すれば refactor コスト低。

---

## 1. 並列クエリ箇所の全列挙(RLS 直撃面)

**結論: RLS(request = 1 接続 1 tx + `SET LOCAL`)で実際に並列性を失う server-side DB サイトは 3 箇所のみ**(全 async RSC の網羅 sweep + `Promise.all`/`allSettled` 全 grep で確認)。うち `entity-mutations bulk` が最大の影響面。

### 1.1 server 側 並列 DB クエリ(同一テナント・RLS 1-tx で直列化される面)

| file:line | 経路 | 並列本数 N | 各クエリ内容 | 同一 tx で直列化される本数 |
|---|---|---|---|---|
| `app/api/pull/route.ts:66` | GET `/api/pull`(`withReadOnlyAuth`) | **6** | cards / exams / tombstones / tag_categories / tag_options / card_tags delta。各 `getDeltaRows` = 単発 SELECT(`eq(userId)[+ gte(cursor)]`) | **6**(全て独立 SELECT。単一接続 tx で完全直列化)|
| `app/(app)/app/upload/page.tsx:91` | RSC `UploadPage`(GET `/app/upload`) | **2** | ① `getActiveExamsForUser`(exams SELECT)② `getCurrentMonthOcrPages`(upload_records SUM)| **2**(両方 DB 往復)|
| `app/api/entity-mutations/bulk/route.ts:274` | POST `/api/entity-mutations/bulk`(非 cascade path)| **= distinct entity-key group 数**(payload 最大 1000 mutation)| `Promise.allSettled` が group 間並列、group 内は逐次。各 mutation = `processMutation` が **per-mutation `db.transaction`**(dedupe SELECT + apply 層 query 群 + log INSERT)| **全 group**(= 全 mutation の DB 往復)。§0.6 の二重衝突ゆえ**最大の影響面** |

**`entity-mutations bulk` の二重衝突**(RLS 最重要論点):
1. **group 並列の無効化**: 現状 group 間 `Promise.allSettled` は Y-2 T-B3 の perf 最適化。RLS が request 全体を 1 接続 1 tx で包むと group 並列は原理的に成立せず、全 mutation が単一接続へ直列化。
2. **nested tx の衝突**: `processMutation` は mutation ごとに `db.transaction` を開く(= プール上で別接続 or savepoint)。「request path を 1 outer tx + `SET LOCAL`」方式と、複数の並行 per-mutation tx は 1 接続上で両立しない(concurrent nested tx を単一接続で開けない)。

### 1.2 別テナント/別ユーザーを跨ぐ並列(webhook / operator script)

| file:line | 経路 | 並列単位 | DB 並列か |
|---|---|---|---|
| `scripts/backfill-clerk-metadata.ts:77` | operator `runBackfill`(全 active user を chunk=10)| chunk 内 `Promise.all` で `deps.sync(...)` | **DB 並列でない** = Clerk API 呼び出し。DB read は先頭 `fetchUsers()` 1 回のみ |

- 他 operator script(`gc-image-assets.ts` / `backfill-card-asset-refs.ts` / `seed-perf-exam.ts`)は `--user` 省略で全 user 対象になり得るが `Promise.all` 不使用 = per-tenant DB は逐次。
- webhook handlers(`webhooks/clerk|stripe/route.ts`、`lib/clerk/` `lib/stripe/`)は `Promise.all`/`allSettled` **0 hit**(単一署名 event を 1 処理)。per-request-tenant の RLS tx 対象ではない(署名 event 由来の tenant 解決)。

### 1.3 誤検出(並列だが DB でない)+ 除外(client Dexie)

**並列だが DB 往復でない(RLS 直列化影響 = 0)**:
- `app/(app)/app/exams/[id]/_actions/asset-actions.ts:256` — `resolveAssetUrls`。DB SELECT は `Promise.all` の**前**に単発(`:245`)。`Promise.all` 中身は `presignGetUrl`(R2 **ローカル署名**、network なし)。
- `app/(app)/app/upload/_actions/process.ts:282` — `files.map` の `arrayBuffer()`/base64 = CPU 処理。DB クエリ皆無。

**逐次 RSC(並列 DB なし・RLS 影響は SET LOCAL overhead のみ)**: exam 詳細 `exams/[id]/page.tsx`(gate 依存で逐次)/ `upload/result/[…]/page.tsx` / `settings` / `study/custom` / `study/smart` / dashboard `app/page.tsx`(集計は client Dexie `useLiveQuery` へ移譲、RSC 側 DB は auth のみ)/ `exams/page.tsx` / `tags/page.tsx` / `(app)/app/layout.tsx` / `upgrade/page.tsx`。`POST /api/review-events/bulk`(`processSession`)も 1 tx 内 完全逐次(既に RLS 影響なし)。`GET /api/dashboard/stats`(`getReviewStatsForUser`)は raw SQL 2 本を逐次。

**除外(client Dexie = IndexedDB、Postgres 非該当)**: `lib/cards/get-custom-session-cards.ts:59` / `lib/sync/review-events.ts:239` / `lib/sync/pull.ts:127` / `lib/media/reclaim-local-asset-blobs.ts:16` / `exam-list-live.tsx:45` / `inline-card-list.tsx:205` / `exam-card-table.tsx:315`(全て `getClientDb()`)。

---

## 2. transaction 内 外部 I/O 検査(pool 占有リスク面)

**結論: 既存 server tx 10 本すべて、tx callback 内に外部 I/O(Stripe/Clerk/R2/Gemini/fetch/重CPU)を持たない。** ただし ①`runUploadGuardTx` が tx 保持中に別 pool 接続を 2 本取る(nested acquisition)②「request 全体を 1 tx」設計を採ると OCR / 一部 webhook が tx 内に落ちる、の 2 点が RLS 配管の要注意面。

### 2.A 既存 server tx の tx 内 I/O(全 10 本・外部 I/O なし)

| file:line | 経路/関数 | tx 内操作(要約) | tx 内 外部I/O | 備考 |
|---|---|---|---|---|
| `upload/_actions/upload-guard.ts:54` | `runUploadGuardTx` | advisory xact lock → inflight SELECT → `canRunOcr` → `getTodayAiUsageGlobal` → exams/source_documents INSERT | なし | **⚠️ nested 接続取得**: `canRunOcr`(`ai-usage-mcq.ts:49`)/`getTodayAiUsageGlobal`(`ai-usage-counter.ts:50`)が各々 別 `getDb()` read = tx 保持中に pool 接続を +2 本(§6.6)|
| `upload/_actions/upload-persistence.ts:23` | `saveExtractedCards` | cards bulk INSERT + `applyOcrTags`(同tx採番)+ `bumpExamCardCount` | なし | 全 tx-scoped SQL |
| `upload/_actions/upload-persistence.ts:59` | `completeUploadTx` | source_documents UPDATE(owner述語)+ upload_records INSERT | なし | |
| `upload/_actions/upload-persistence.ts:114` | `markFailed` | source_documents UPDATE(owner述語)+ upload_records INSERT | なし | best-effort |
| `exams/_actions/delete-exam.ts:48` | `deleteExam` | exam SELECT → child SELECT → tombstones INSERT → exams DELETE(FK CASCADE)| なし | |
| `lib/ai-usage-counter.ts:28` | `incrementAiUsage` | ai_usage UPSERT + ai_usage_users UPSERT | なし | OCR `onAttempt` 発火の独立小 tx |
| `app/api/entity-mutations/bulk/route.ts:102` | `processMutation` | dedupe SELECT → `entry.apply` → log INSERT | なし | per-mutation 独立 tx(§1.1)|
| `lib/clerk/handle-clerk-event.ts:330` | `handleUserDeleted` tx | users UPDATE(scrub)+ 10 table DELETE + assets UPDATE | なし | Stripe sub cancel ループ(外部)は tx **前**に完結 |
| `lib/reviews/ingest-review-events.ts:98` | `processSession` | cards SELECT → answer_events/reviews INSERT → cards UPDATE → study_days UPSERT | なし | 全 `eq(userId)` scoped・完全逐次 |
| `lib/exams/source-doc-status.ts:85` | `reconcileStaleProcessing` | source_documents UPDATE…RETURNING + upload_records INSERT | なし | best-effort |

**Stripe handlers = tx なし**(確認済): `lib/stripe/handle-stripe-event.ts` / `subscription-repository.ts` は `db.transaction` 不使用、各 write は単文 autocommit(`db.update(users)…`)。現状 pool-pinning なしだが 2.B の RLS wrap 候補。

### 2.B RLS で「1 tx 包み」を採った場合に tx 内へ落ちる 外部 I/O(現状は tx 外)

**upload/OCR パス `_processUpload`(`process.ts:121`)は既に 3 tx 分離済で、Gemini はどの tx にも入っていない**(設計コメント `process.ts:224-227`「OCR pipeline は transaction の外」):

| # | ステップ | 種別 | file:line |
|---|---|---|---|
| 3 | `runUploadGuardTx`(lock+quota+INSERT)| **DB TX #1(commit)** | `process.ts:231` |
| 5 | `runOcrPipeline`(Gemini、deadline 720s)| **外部 I/O・tx 外** | `process.ts:311` |
| 7 | `saveExtractedCards`(cards INSERT 等)| **DB TX #2** | `process.ts:398` |
| 8 | `completeUploadTx`(source_documents UPDATE 等)| **DB TX #3** | `process.ts:446` |

→ 各 tx 冒頭に `SET LOCAL` を打つだけでよく、**Gemini はどの tx にも入らない**ため refactor コスト低。危険は「request 全体を 1 tx」設計を採った時のみ(720s Gemini が接続 pin)。

**その他「DB が外部 I/O を bracket する」パス(いずれも現状 tx なし)**:
| パス | 順序(DB → 外部 → DB)| RLS 1-tx 化の懸念 |
|---|---|---|
| `finalizeAsset`(`asset-actions.ts:128`)| SELECT owner → **R2 HEAD(`headObject`, network, `:163`)** → UPDATE ready | 1 tx 化で R2 HEAD が tx 内に入る。現状 tx 外で pin なし |
| `checkout.session.completed`(`handle-stripe-event.ts:43`)| UPDATE users → **Stripe `subscriptions.retrieve`(`:70`)** → projection(DB write + Clerk sync)| tenant key は `clerkId`/`stripeCustomerId`(署名event由来、`app.user_id` でない)|
| `projectStripeSubscription`(`project-subscription.ts:24`)| `notifyOps`(Discord)→ `saveProjection`(DB)→ `syncClerkPublicMetadata`(Clerk)| 1 tx 化で Discord/Clerk sync が tx 内 |
| `reserveAsset`/`resolveAssetUrls` | DB → presign | **除外**: presign は `client.sign`(ローカル署名、network なし)|
| `handleUserDeleted` | SELECT(tx外)→ Stripe cancel(tx外)→ DB tx | **良い形**(外部 I/O は既に tx 外)|

---

## 3. 経路別 before 数字(計測)

**状態: Perf-0b(2026-07-18)で path (a) = read 経路 end-to-end p50/p95 を Playwright MCP 経由で stg 実測済(§3.2 = RLS after 比較の基準線)。**

- 計測環境 = stg(本番同等 Supabase + Transaction Pooler 越し)。ローカル PG は pooler / RTT が消え before として不適(課題文指定)。
- **測れたもの**: read 経路(dashboard / exams 一覧 / exam 詳細 / upload / `/api/pull` full+delta)の end-to-end 応答 p50/p95。非破壊 GET のみ(browser page-context `fetch`)。
- **測れないもの(据置)**: ① DB 時間合計 / 並列部 max vs sum の切り出し = server-timing 計装未実装(`Server-Timing` / `performance.now` の DB 区間 0 hit)ゆえ計装 deploy が要る(案 b、OT 方針で不採用 = after で悪化が出た時のみ再検討)。② write 経路(entity-mutations/review-events bulk)= OT 方針で不採用(素朴 RLS 案で group 並列が残る見込みゆえ before write 計測の価値薄)。③ Supabase dashboard 実値 = OT(§7)。

### 3.1 計測対象と静的クエリ本数(§1 enumeration からの導出)

| 経路 | 静的クエリ本数 | 並列本数 | RLS 1-tx 後の直列化 | 実測要否 |
|---|---|---|---|---|
| GET `/api/pull` | 6(+auth users SELECT)| **6 並列** | 6 直列(max→sum 悪化)| **要**(6 の per-query ms で max vs sum を出す)|
| RSC `/app/upload` | 2(+auth)| **2 並列** | 2 直列 | 要 |
| POST `/api/entity-mutations/bulk` | group 数 × (dedupe SELECT + apply N + log INSERT)| **group 並列** | 全 group 直列 + nested tx 不成立(§1.1)| **要**(最大影響。ただし write 経路=汚染懸念、§0.4 blocker 3)|
| RSC exam 詳細 `/app/exams/[id]` | 3(auth + exam + cards)| 逐次 | 影響 = SET LOCAL overhead のみ | 参考 |
| GET `/api/dashboard/stats` | 2(raw SQL 逐次)| 逐次 | 同上 | 参考 |
| POST `/api/review-events/bulk` | 1 tx 内 逐次多数 | 逐次 | 影響なし(既に 1 tx)| 参考 |

- クエリ本数は静的導出ゆえ計測不要。**「DB 時間合計 / 並列部 max vs sum / p50・p95」は §0.4 の blocker で本 sandbox 実測不能** = §3.3 の method を OT 実行 or 計装 deploy 承認後。

### 3.2 warm baseline(Perf-0b 実測・**RLS after 比較の基準線**)

各経路 warmup 5 回捨て後 30 回計測、end-to-end(request→full body 読了)、p50/p95 = nearest-rank。単位 ms。

| 経路 | p50 | p95 | mean | min | max | resp bytes | 備考 |
|---|---|---|---|---|---|---|---|
| dashboard `/app` | **91** | 114 | 94 | 81 | 120 | 36 KB | RSC(集計は client Dexie、RSC 側 DB は auth のみ)|
| exams 一覧 `/app/exams` | **91** | 162 | 100 | 80 | 181 | 34 KB | |
| exam 詳細(300件)`/app/exams/{id}` | **131** | 204 | 141 | 106 | 239 | 452 KB | 300 card render。逐次 RSC(auth+exam+cards)|
| `/app/upload` | **94** | 138 | 101 | 85 | 181 | 36 KB | warm。並列 DB N=2(§1.1)|
| `GET /api/pull` full | **181** | 226 | 179 | 138 | 265 | 979 KB | **6-way 並列**(§1.1)。rows: cards300 / exams1 / tombstones1066 / tag_cat7 / tag_opt28 / card_tags1621 |
| `GET /api/pull` delta(0行)| **77** | 85 | 78 | 69 | 85 | 204 B | steady-state(since=当日、全 stream 0 行)= auth + 6 空 index scan + RTT floor |

**RLS after 比較への読み**: `/api/pull` full の p50 181ms は 6-way 並列の **max**。RLS 1-tx 直列化後は各 delta の per-query 時間の **sum** に近づく。per-query の内訳は本計測(end-to-end 集約)からは分離不可(計装未実装)→ after 実測 or 計装で確認。参考値として full(181)と delta(77、~0 行)の差 ~104ms が「300cards+1621card_tags+1066tombstones の fetch+serialize+979KB 転送」で、DB 並列区間はこの一部。直列化の絶対悪化は数十 ms オーダーと推定(after で要検証)。

### 3.3 cold / first-hit(opportunistic 2 サンプル)

真の Vercel reclaimed cold-start ×5 は client から強制不可(instance idle 明けを制御できない)。→ **session 開始時(T≈13:03 UTC)と ~5分 idle 明け(T≈13:20 UTC)の first-hit を 2 サンプル**記録。単位 ms。

| 経路 | cold #1(session 開始)| cold #2(~5分 idle 明け)| warm p50 | 備考 |
|---|---|---|---|---|
| dashboard | 170 | 137 | 91 | |
| exams 一覧 | 113 | 157 | 91 | |
| exam 詳細 | 348 | 317 | 131 | |
| `/app/upload` | **1381** | **1270** | 94 | **2 回とも ~1.3s = Next.js route compile cold**(warm の 13×)。cold 突出は upload のみ |
| `/api/pull` full | 256 | 187 | 181 | |
| `/api/pull` delta | 82 | 90 | 77 | |

→ cold penalty は upload(route compile)を除けば warm の 1.2〜2.7×。upload の compile cold は RLS と無関係(SET LOCAL は warm-path コスト)。

### 3.4 計測条件

- **時刻**: 2026-07-18 ~13:03–13:21 UTC。**seed**: `[PERF-SEED] 300-card exam`(test1 = `komail9server+clerk_test`、exam id `75104e5f-aea5-42b5-9d15-cc1743bda55d`)。
- **client / egress**: Playwright MCP browser(stg 到達 egress)。page-context `fetch(url,{credentials:'include',cache:'no-store'})` で document GET(SSR)/ API JSON を計測、`performance.now()` で request→full body。
- **network floor**: 静的 edge-cache 資産(`/favicon.ico`)25 回で **RTT p50 ≈ 3ms** → 測定値はほぼ **server 処理時間**(browser は stg 近接、network 誤差小)。
- **非破壊**: read GET のみ。認証 = Clerk test モード(`+clerk_test` + 固定 OTP 424242)。

### 3.5 未計測(据置・OT / 後続)

- **並列部 max vs sum(= RLS 直列化コストの本体)**: server-timing 計装が要る(案 b、OT 方針で不採用 = after で悪化が出た時のみ再検討)。
- **write 経路**(entity-mutations/review-events bulk): OT 方針で不採用(素朴 RLS 案で group 並列が残る見込み)。
- **Supabase dashboard 実値**(§7): pooler pool size / max backend conn / 現在の同時接続 peak。

### 3.6 既知の before 数字(過去計測・引用)

- `2026-05-25` prefetch 調査(stg / Playwright + Resource Timing): navigation 1 回で `?_rsc=` GET が **5〜9 並列**、各 RSC SSR **400-650 ms TTFB(warm)/ 1000-2000 ms(cold)**。dashboard 単体 RSC SSR ~2000 ms。出所: lessons doc / `sessions/2026-05-25-stg-perf-rsc-prefetch-amplification.md`。
- 上記は **prefetch 並列**かつ full-page RSC SSR の数字。本 §3.2 の warm(dashboard p50 91ms 等)が桁違いに速いのは、S-perf-1 で prefetch を切り並列 SSR が消えたこと + 本計測が単発 fetch であることによる(整合)。RLS の tx 直列化コストは §3.2 の warm を基準線に after で比較する。

---

## 4. 接続・pool の現状

- **[裏取り済] postgres-js pool**: `getDb()`(`lib/db/index.ts:15-23`)は `postgres(DATABASE_URL, { prepare: false })`。`max` 未指定 = **既定 10 コネクション/instance**(`node_modules/postgres/src/index.js:449` `max: globalThis.Cloudflare ? 3 : 10`)。`prepare: false` は pooler(PgBouncer transaction mode)要件。
- **[裏取り済] singleton**: module-level memoized(`_db`/`_client`)。Vercel serverless の 1 instance 内で pool 共有、instance 数だけ pool が並立(Vercel の同時実行 instance 数 × 10 が理論上の Supabase 側 backend 圧)。
- **Promise.all 時の実接続本数**: postgres-js は同一 `sql` client に対する同時クエリを最大 `max` 本のコネクションに分散(`src/index.js` の queue/connection 割当)。→ `/api/pull` の 6-way `Promise.all` は最大 6 コネクションを同時に使う(pool 10 の 6 割)。RLS 1-tx 化でこれが 1 に減る(直列化)。
- **OT 確認項目(Supabase dashboard)**: §7 参照(pooler pool size / Nano 既定 / 現在の同時接続実態)。

---

## 5. prefetch 並列爆発の現状

- **[裏取り済] S-perf-1 で対処済**。dynamic `/app/*` 宛の全 `<Link>` に `prefetch={false}` 付与(`app-header.tsx` nav 6 link / `dashboard-actions.tsx` / `exam-list-live.tsx` の exam 行 / `settings/page.tsx` の upgrade+法的4 / `page.tsx` upgrade / `upload/page.tsx` / `custom-session-flow.tsx` / `study-session-host.tsx` / `inline-card-list.tsx` / `result-actions.tsx` / `pricing-table.tsx`)。
- **残件(RLS と独立、対処は scope 外・列挙のみ)**: marketing / auth 系 `<Link>`(`marketing-header.tsx` / `marketing-footer.tsx` / `auth-header.tsx` / `logo.tsx` / `(marketing)/page.tsx`)は `prefetch={false}` 未付与。ただし遷移先が static / 低負荷 marketing page ゆえ dynamic RSC 増幅は起きにくい(要 stg Resource Timing 1 回で確認 = §3 と同じく計測 blocked)。
- **[裏取り済] 5.3 RLS への含意**: prefetch を切っても dynamic page は cookie(Clerk auth)依存で全て dynamic 判定。各 page render は `getCurrentUser()`(`auth()` + `users` SELECT)を実行し、`React.cache()` の射程は同一 render tree 内のみ(cross-render を救わない、lessons §2.2)。→ RLS 後は **各 RSC render が個別に `SET LOCAL` tx を張る**必要があり、tx 数は「同時 render page 数」に比例する。prefetch=false でこの同時数は 1 に近づくが、layout+page の二重 render は残る。

---

## 6. RLS 配管設計への含意(事実からの直接の含意のみ)

1. **`SET LOCAL` は tx 内でのみ有効**。全 owner-scoped 経路(Iso-0 §1.2 の全 read/write)を `db.transaction` で包み、tx 先頭で `SET LOCAL` を発行する配管が要る。現在 tx 外で単発実行している read(§1 の Promise.all、§6.2 の raw `db.execute`)は全て tx 化対象。
2. **raw SQL 経路も対象**: `lib/db/streak.ts`(`getReviewStatsForUser`)は `db.execute(sql\`…\`)` を 2 回(既に逐次)。RLS 化で `SET LOCAL` を同 tx に載せる必要。逐次ゆえ直列化コストは増えない(SET LOCAL 分の overhead のみ)。
3. **Promise.all の直列化コスト**(§1)= RLS の主コスト。特に `/api/pull` の 6-way。定量値(max vs sum)は §3 計測に依存(未計測)。
4. **tx 内 外部 I/O を作らない**(§2.B): request 全体を素朴に 1 tx で包むと OCR(Gemini)call が tx 内に入る。現行の guard-tx / OCR / persistence-tx 分離を維持し、外部 I/O は tx 外に出す設計が要る。
5. **pool 圧**: 1 request = 1 tx = 1 コネクション占有(§4)。長い tx(OCR 経路等)が pool 10 を占有し続けると同時処理数が絞られる。tx 境界を短く保つ(外部 I/O を外に出す)ことが pool 健全性の条件。
6. **[要注意] tx 内での別 `getDb()` 取得**: `runUploadGuardTx` は tx 保持中に `canRunOcr` / `getTodayAiUsageGlobal` が別 pool 接続で read する(§2.A)。RLS では ①その別接続に `SET LOCAL` が伝播しない(**correctness**: owner-scope でない read だが RLS policy 下では user_id 未設定で 0 行になり得る)②tx 保持中に +2 接続 = pool 圧、の二重問題。→ RLS 配管では「同 tx 内 read は `tx.` 経由に寄せる」か「これら 2 read を guard tx の外へ出す」設計判断が要る(本 doc は列挙のみ)。
7. **entity-mutations bulk の再設計要**(§1.1): group 並列 + per-mutation nested tx は単一 outer tx と両立しない。RLS 配管はこの経路を「1 outer tx + `SET LOCAL` + group 逐次(savepoint per mutation)」へ作り替える必要があり、Y-2 T-B3 の並列 perf 最適化とトレードオフになる(定量は §3 実測待ち)。

---

## 7. OT 確認項目(Supabase dashboard / stg 実行)

1. **Supabase Transaction Pooler の pool size**(project 設定の実値。Nano tier 既定 + 手動上書きの有無)。`max_client_conn` / `default_pool_size`。
2. **Supabase 側 max backend connections**(compute tier 依存の上限)。postgres-js `max:10` × Vercel instance 数 がこの上限に収まるか。
3. **現在の同時接続実態**(dashboard の connection グラフ、peak 値)。
4. **read 経路 before 計測は完了(§3.2、Perf-0b)**。残 = DB 時間の切り出し(並列部 max vs sum)を測るなら server-timing 計装 deploy(案 b)の承認 — OT 方針では after で悪化が出た時のみ再検討。

---

## 付録: 調査メタ / 未確定

- 裏取り済: pool 既定値(postgres-js src)/ proxy 保護経路(`/app(.*)` のみ)/ prefetch 全 grep / streak raw SQL Read / server-timing 不在 grep / sandbox network deny。**Perf-0b: §3.2 read 経路 warm p50/p95 stg 実測**。
- **未確定(据置)**: DB 時間の切り出し / 並列部 max vs sum(計装要)/ §7 の dashboard 実値 / marketing link prefetch の実 Resource Timing / write 経路(不採用)。
- subagent: 2 並列 general-purpose(§1 並列クエリ / §2 tx 内 I/O)。foreground dispatch(同一メッセージ内 2 call)、CLAUDE.md 規律。Perf-0b 計測 = Playwright MCP(stg、非破壊 read)。
