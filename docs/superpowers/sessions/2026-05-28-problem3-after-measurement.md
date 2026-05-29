# 問題 3 after 計測 (bulk refactor、 before との比較)

- 日時: 2026-05-28
- 種別: session log / after 計測
- 対象 commit: `d06062c` (develop HEAD、 bulk refactor 完了版。 `git ls-remote origin develop` = d06062c で remote 反映確認済)
- 対象 stg: `https://stg.recallmint.nekotest.net`
- account: `komail9server+001@gmail.com` (IDB clear で clean state)
- 実行手段: Playwright MCP + DevTools Network / PerformanceResourceTiming
- before baseline: `docs/superpowers/sessions/2026-05-28-problem3-before-measurement.md` (per-event 版、 Function Duration 16.7〜17.4s)
- **状態: 🔴 CRITICAL — 認証は解決し smoke 実走したが、 smart session 1 で bulk write が real Postgres で全 event rollback (`failed[]` に 5 件全部)。 = bulk refactor は実 DB で機能していない。 perf 計測は suspend (rollback path の latency は無意味)。 root cause は Vercel log 待ち (§0)**

---

## 0. 🔴 CRITICAL FINDING — bulk write が real DB で rollback

認証 (komail9server+001 + 新デバイス email code) を解決し、 clean state (IDB before:[recallmint]→clear、 answer_events=0 確認) で smart session 1 (cold) を実走。 結果:

- **POST `/api/review-events/bulk` → 200 だが body = `{"ok":true,"failed":[<5 event_id 全部>]}`**。 = server が 5 event 全部を `failed[]` に積んだ。
- client 側: 全 5 event が `sync_status='pending'` のまま、 session も `pending` (= flush 失敗扱い、 次 flush で再送する状態)。 **実 DB には cards/reviews/study_days が 1 件も書かれていない (tx rollback)**。
- payload は正常: `mode:'smart'`、 5 event すべて valid UUID card_id (smart review が配信した実 card)、 `rating:3`、 valid event_id。 → **orphan ではない** (orphan なら SELECT 1 回で ~0.5s の fast path のはず)。
- Function Duration **4,019ms** (before 16.7-17.4s より速い → 新 bulk code は deploy 済、 ただし throw path)。 4s ≈ 数 statement 実行後に throw した時間 → **後段 phase (Phase 2e VALUES UPDATE or Phase 2f study_days) の実行時エラーで tx 全 rollback** と推定。

### なぜ unit test で出なかったか

`route.test.ts` は `getDb`/`tx` を mock し、 **実 SQL を Postgres に投げない**。 SQL 文字列の `toSQL()` rendering は valid (下記検証済) でも、 **実行時に postgres-js (`prepare: false` / Supabase PgBouncer transaction mode、 `lib/db/index.ts`) が特定の構文を rejcet する**ケースは mock では検出不能。 = real-DB integration の穴。

### toSQL() 検証 (Phase 2e VALUES UPDATE)

ローカルで実 drizzle (postgres-js) を使い Phase 2e の生成 SQL を render → **構文・型・列順すべて valid**:
```
update "cards" set "answered"=v.answered, ..., "updated_at"=$1
  from (VALUES ($2::uuid,$3::timestamptz,$4::real,...,$15::int), (...)) 
  AS v(id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, learning_steps, last_review, answered, last_correct, current_streak)
  where ("cards"."user_id"=$30 and "cards"."id"=v.id)
```
VALUES tuple の cast 順 = `AS v(...)` の列順 = cards 列型、 SET の `v.col` mapping もすべて整合。 → **SQL 文字列は正しい。 失敗は実行時 (driver/PgBouncer 層)**。 確定診断には Postgres の実エラーメッセージが要る。

### session 1 識別子 (OT の Vercel log 照合用 — 最優先)

| 軸 | 値 |
| --- | --- |
| session_id | `e6ddf69f-c2ca-4afb-8d53-69e9460f8cdc` |
| event_id (5) | `31217888` / `577d7899` / `c513dc27` / `cf0f0cfd` / `177d721e` |
| x-vercel-id | `hnd1::iad1::nv9j5-1779984405963-df92d392b7d7` |
| response date | Thu, 28 May 2026 16:06:49 GMT |
| region | iad1 (function) |

### OT への依頼 (root cause 確定)

1. **Vercel function log で `event:"review_events.bulk.tx_failed"` の `err` を取得** (上記 session_id / 時刻帯 / x-vercel-id で照合)。 これが Postgres の実エラー (message + code) で、 どの phase / どの SQL が落ちたか即判明する。 加えて `review_events.bulk.timing` があれば、 どの per-phase まで到達したか (`update-cards` の前で止まったか後か) も分かる。
2. **stg の deploy commit = `d06062c` か確認** (Vercel Deployments)。 万一 intermediate commit が live なら redeploy。

→ `err` を貰い次第 root cause を確定し fix する (現状の強い suspect は Phase 2e VALUES UPDATE の実行時 reject、 次点 study_days)。 **fix 前に perf 再計測しても無意味なので §2-3 は suspend**。

### 計測条件メモ (実走時の差分)

- plan: **Standard / active** (before doc は「Free」記載だったが現アカウントは Standard。 bulk endpoint は plan 非依存なので latency 比較に影響なし)。
- sessionLimit=5 / FSRS mode ON は設定画面で確認済 (before と一致)。
- 実行時刻 16:xx GMT = JST 翌日 2026-05-29 01:xx (before は JST 2026-05-28)。 study_days の「今日」は別 JST 日 = clean slate。

---

## 0-bis. 再 smoke (観測強化 a332b78 deploy 後) — Vercel log の err 取得用

`a332b78` (serializeDbError 観測強化) deploy 後、 同 stg / 同 account で 1 session 再現
(2026-05-29 02:04 GMT)。 **前回と同一の失敗を再現** (clean state → smart 5 問 Good → bulk POST が
200 + failed[全 5])。 本 smoke の目的は「OT が Vercel function log `review_events.bulk.tx_failed` を
引くための識別子確定」 (server log は client から見えないため)。

### 再現確認 (client dump)
- POST `/api/review-events/bulk` → **200 + `{"ok":true,"failed":[5 event 全部]}`** (前回と同じ rollback path)
- Function Duration **4,187ms** (前回 4,019ms と同オーダー = throw path、 cards/reviews/study_days 未書込)
- 全 5 event `sync_status='pending'` のまま (clean state: before:[recallmint]→clear、 answer_events=0 確認済)

### OT 照合用識別子 (この session の log を引く)
| 軸 | 値 |
| --- | --- |
| session_id | `cb466772-2927-444f-8c06-885d88e6d40c` |
| event_id (5) | `d65004c5-6a73-4776-9415-060c731b3f8b` / `be8c1491-04e1-4537-accc-ee1371fbde19` / `45d2ed45-6c4e-4871-92fa-a932b6ce15d7` / `c77cec7b-b25b-4705-be39-ac4e58946a93` / `71a4dc9a-b0cf-467f-ae67-d19ce182f284` |
| x-vercel-id | `hnd1::iad1::8mwxc-1780020275041-e695124d349d` |
| response date | Fri, 29 May 2026 02:04:38 GMT |
| region | iad1 (function) |

### OT が取得すべき log (a332b78 で native error が plain object 化され見えるはず)
Vercel function log で `event:"review_events.bulk.tx_failed"` を上記識別子で引き、 新 serializer 出力の
**`err`** object を共有:
- `err.message` (Drizzle wrap = `Failed query: ...`)
- **`err.cause`** = postgres-js native (`code` SQLSTATE / `severity` / `detail` / `hint` / `position` /
  `where` / `schema_name` / `table_name` / `column_name` / `constraint_name`) ← **root cause の核**
- top-level に `err.code` 等が出ていればそれも
- `err.paramsAnomaly {hasUndefined,hasNull,hasInvalidDate}` / `err.paramsTypeDistribution` /
  `err.cardIds` / `err.paramsCount` (Preview に `BULK_FULL_PARAMS_LOG=1` 設定済なら `err.fullParams` も)
- 併せて `event:"review_events.bulk.timing"` があれば到達 per-phase (`update-cards` の前で止まったか後か
  = どの SQL で落ちたかの切り分け)

→ `err.cause` の `code`+`detail` で root cause 確定 → B commit で対策。

---

## 0-final. fix 確証 smoke (B commit 0e78ef0 deploy 後) — ✅ 解決確認

`0e78ef0` (Phase 2e timestamptz ISO bind 化 + RETURNING 件数検知、 Drizzle #5789 fix) deploy 後、
同 stg / 同 account で 1 session (2026-05-29 03:12 GMT、 clean state、 sessionLimit=5 / FSRS ON)。

### ✅ 結果: rollback 解消・全件成功
- POST `/api/review-events/bulk` → **200 + `{"ok":true,"failed":[]}`** (前 2 回の failed[全5] から解消)
- Dexie: 全 5 event `sync_status='synced'` / session `synced` (= flush 成功、 前回は全 pending)
- RETURNING 件数照合: throw なし完走 (5 適用 = 5 returning、 正常パス確認)

### correctness (実 DB 反映、 dashboard で確認)
| 指標 | before smoke | after smoke |
| --- | --- | --- |
| 今日の学習問題数 | 0 | **5** (= 適用 5 distinct card、 study_days 反映) |
| スマート復習 due 件数 | 50 件 | **45 件** (= 5 card の FSRS due 前進、 cards 反映) |
| 連続日数 (streak) | 1 日 | **2 日** (本日学習計上) |

→ cards / reviews / study_days すべて実 DB に commit された (rollback でなく成功)。

### 性能 (1 数値、 cold sample)
- Function Duration (PRT.duration ≒ TTFB) = **4,769ms**
- **before 16.7〜17.4s → ~4.8s = 約 3.5x 改善**。 ただし spec 推定 ~3.2s より上振れ (単発 cold sample)。
  - 註: 成功 path は失敗 path (~4.0s、 update-cards で throp) より長い = update-cards + study_days まで完走するため。
  - ~3.2s との差の内訳 (study_days の per-day COUNT(DISTINCT)+upsert 往復 / Supabase pooler RTT / cold start) は
    OT が Vercel log の `review_events.bulk.timing` per-phase で要確認。

### OT 照合用識別子 (per-phase timing / paramsTypeDistribution 確認用)
| 軸 | 値 |
| --- | --- |
| session_id | `59d09e4f-690f-4289-aa84-bd09b312149d` |
| event_id (5) | `cbc8ebe2` / `f1eacac2` / `c357fbfa` / `fdaf053e` / `b5f01b64` |
| x-vercel-id | `hnd1::iad1::z5kzd-1780024364198-d45fd02bc718` |
| response date | Fri, 29 May 2026 03:12:48 GMT |

OT が `review_events.bulk.timing` で確認すべき (fix 証跡):
- `update-cards` が完走し `total` に乗っていること (前 2 回は throw で未完走)
- `paramsTypeDistribution.date: 0` (Date が全部 ISO string 化された #5789 fix 証跡)
- `paramsAnomaly.hasInvalidDate: false`
- `review_events.bulk.tx_failed` log が出ていないこと

### 達成判定
- **correctness: ✅ 完全解決** (rollback 解消、 全件成功、 DB 反映確認)。
- **性能: 大幅改善 (~3.5x) だが ~3.2s 推定より上振れ (~4.8s)**。 cold 単発のため断定不可、 per-phase 内訳と
  warm 計測は別 task。 bulk 化の主目的 (per-event tx × N → 単一 tx) は機能し、 16s 級は解消。

---

## 1. 計測手順 (before と厳密に同条件)

= sessionLimit=5 / Free プラン / 5 events ちょうど (= FLUSH_THRESHOLD)。

1. stg `/app` 着地 → IDB clear: `indexedDB.deleteDatabase('recallmint')` + `localStorage.clear()` + `sessionStorage.clear()` → reload → clean state 確認 (`indexedDB.databases()` が `recallmint` を含まないこと。 before:[recallmint] / after:[] の確認に相当)。
2. **smart モード × 3 session** (session 1=cold / 2-3=warm、 各 session 別 navigation で新 session_id):
   `/app/study/smart` 着地 → 5 cards を「任意選択肢 → 回答する → Good(rating=3) → 次へ」で完答 → 完了画面で経路 2 (`finished` useEffect の `flushAllPendingEvents`) が発火 → POST 完了まで待機 (~5-20s) → DevTools Network + `PerformanceResourceTiming` を dump。
3. **custom (通常) モード × 3 session** (smart と同条件、 別 navigation):
   custom 演習で 5 問を「任意選択肢 → 回答する → 次へ (= client が correct→3 / incorrect→1 で rating 自動決定)」で完答 → 完了 flush → POST dump。
   - 確認: payload に `mode: 'custom'` が乗ること、 各 event の `rating` が client 判定値 (3 or 1) で乗ること (server `deriveRating` は payload rating を優先し、 custom でも同じ replay/bulk SQL 経路を通る — handler は mode で分岐しない)。

`PerformanceResourceTiming` 取得 snippet (before と同一):
```js
performance.getEntriesByType('resource')
  .filter(e => e.name.includes('/api/review-events/bulk'))
  .map(e => ({ name: e.name, duration: Math.round(e.duration), transferSize: e.transferSize }))
```

---

## 2. 性能比較 (本命) — 記入待ち

### smart モード

| #   | 種別 | after Function Duration (PRT.duration ≒ TTFB) | before (per-event) | 削減率 | x-vercel-id | session_id | response date(GMT) |
| --- | ---- | --------------------------------------------- | ------------------ | ------ | ----------- | ---------- | ------------------ |
| 1   | cold | _TBD_                                          | 17,426ms           | _TBD_  | _TBD_       | _TBD_      | _TBD_              |
| 2   | warm | _TBD_                                          | 16,773ms           | _TBD_  | _TBD_       | _TBD_      | _TBD_              |
| 3   | warm | _TBD_                                          | 16,746ms           | _TBD_  | _TBD_       | _TBD_      | _TBD_              |

### custom モード

| #   | 種別 | after Function Duration | x-vercel-id | session_id | response date(GMT) | mode 確認 |
| --- | ---- | ----------------------- | ----------- | ---------- | ------------------ | --------- |
| 1   | cold | _TBD_                   | _TBD_       | _TBD_      | _TBD_              | custom?   |
| 2   | warm | _TBD_                   | _TBD_       | _TBD_      | _TBD_              | custom?   |
| 3   | warm | _TBD_                   | _TBD_       | _TBD_      | _TBD_              | custom?   |

達成判定: after が **~3.2s 付近** (before 16.7-17.4s の ~5x 削減) なら目標達成。 smart vs custom で性能差が出ないこと (handler は mode 非分岐) も確認。

---

## 3. correctness 観測 (test で見えない実 DB 反映) — 記入待ち

各モードで以下を 1 回ずつ:
- **再レート**: 1 session 内で同カードを「次へ」後に「前へ」戻って再回答 → その event が **別 event_id** で payload に乗ること (Network payload dump)、 reload 後の card 状態 / dashboard で **reps/streak が二重適用でなく順次累積** (同カード 2 回回答なら reps が初期+2) していること。
- **study_days**: 完了後 reload で dashboard「今日の学習問題数」が **適用 event 数だけ増加** (distinct card 数ベース) していること。
- **経路 2 維持**: 全 session で client POST が **1 本のみ** (in-flight guard 維持、 並走重複なし)。

---

## 4. OT 照合手順 (Vercel function log) — per-phase timing 取得

stg Vercel function log (Deployment → Functions → `/api/review-events/bulk`) で session ごとに引く。

### 4.1 marker 確認
各 session 発火時刻帯に `event: "review_events.bulk.request"` の log 行があるか。 1 行も無ければ deploy 未反映 / env ガード誤判定 → Claude Code に報告、 計測やり直し。

### 4.2 per-phase timing 取得 (**before から key が変わった**)
`event: "review_events.bulk.timing"` の `timings` を dump。 **bulk refactor で per-event key (`event-N-tx` / `event-N-submitTx` / `event-N-select-cards` …) は廃止、 per-phase key に統合**:

取得すべき `timings` キー (各 session、 eventCount=5):
- `session-upsert` (tx 外、 Phase 0)
- `select-cards` (Phase 1: owner-scope SELECT IN、 1 回)
- `insert-events` (Phase 2a: answer_events bulk INSERT、 1 回)
- `replay` (Phase 2c: in-memory FSRS fold、 DB 非依存なので極小のはず)
- `insert-reviews` (Phase 2d: reviews bulk INSERT、 1 回)
- `update-cards` (Phase 2e: cards VALUES 単一 UPDATE、 1 回)
- `study-days` (Phase 2f: JST day group ごとに COUNT(DISTINCT) + upsert)
- `total` (server 内部全体)

### 4.3 識別子表 (記入待ち)

| 照合軸 | smart-1 | smart-2 | smart-3 | custom-1 | custom-2 | custom-3 |
| --- | --- | --- | --- | --- | --- | --- |
| 時刻帯(GMT) | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| x-vercel-id | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| session_id | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| event_id 一覧 | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

---

## 5. 達成可否の所見 (記入待ち)

after Function Duration 記入後に確定。 想定:
- 目標達成 (~3.2s 付近): per-event N×往復 → 単一 tx + bulk SQL の RTT 削減が効いた。 §4 で `total` 内訳が「select-cards + insert-events + insert-reviews + update-cards + study-days」 の少数 round-trip に収まっているはず。
- 未達 (>3.2s 残る): どの phase が支配的か §4 timing で特定。 候補 — `study-days` (day group ごとに COUNT(DISTINCT) execute + upsert = 2 round-trip/day、 通常 1 day なので小)、 `select-cards` / `insert-events` の RTT、 Vercel↔DB region RTT (before の iad1 function / DB region 次第)。 cold/warm 差も併記。
