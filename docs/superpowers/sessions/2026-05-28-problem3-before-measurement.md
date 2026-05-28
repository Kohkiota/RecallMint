# 問題 3 before 計測 (bulk refactor baseline)

- 日時: 2026-05-28
- 種別: session log / before 計測 (実装変更なし)
- 対象 commit: `d3617a8 chore(perf): bulk endpoint timing 計測を logger 出力へ (TEMP-MEASURE) [no-review]` (stg deploy 前提)
- 対象 stg: `https://stg.recallmint.nekotest.net`
- account: `komail9server+001@gmail.com` (IDB clear で clean state)
- 実行手段: Playwright MCP + DevTools Network / PerformanceResourceTiming
- 位置づけ: 問題 3 (bulk per-event serial transaction → bulk 化) refactor の **before baseline**
- 状態: **client 側 dump 完了 / server 側 per-op timing は OT の Vercel log 取得待ち**

---

## 0. 計測分担 (構造的制約)

`d3617a8` の per-op timing は **server logger (Vercel function log) 出力**で、 response には載せていない (Server-Timing header は除去済)。 = **Claude Code (DevTools) からは per-op 数値が見えない**。 分担:

- **Claude Code (本 log §2-3)**: client 側 POST 発火 + 照合識別子 (session_id / event_id / x-vercel-id / date / Function Duration)
- **OT (§4 手順)**: Vercel function log で marker (`review_events.bulk.request`) + timing (`review_events.bulk.timing`) を §4 の識別子で引き、 per-op 数値を取得 → Claude Code に渡す → §3 解釈を数値で確定

---

## 1. 計測手順

1. stg `/app` 着地 → IDB clear (`indexedDB.deleteDatabase('recallmint')` + localStorage/sessionStorage clear) → clean state
2. 各 session: `/app/study/smart` 着地 → 5 cards を (任意選択肢 → 回答する → Good(rating=3) → 次へ) で完答 → 完了画面で経路 2 (finished useEffect) が `flushAllPendingEvents` を発火 → POST 完了まで ~20s 待機 → DevTools Network + PerformanceResourceTiming を dump
3. 3 session 反復 (session 1 = cold、 2-3 = warm)。 各 session は別 `/app/study/smart` navigation で新 session_id

= sessionLimit=5 / FSRS モード / 5 events ちょうど (= FLUSH_THRESHOLD)。

---

## 2. client 側 dump (3 session)

### 共通

- 全 session **client POST 1 本のみ** (= 問題 2 in-flight guard 維持、 並走なし)
- 全 POST status 200 / events 5 件 / x-vercel-id region `hnd1::iad1` (edge hnd1 / function iad1)
- Server-Timing header なし (= d3617a8 で除去、 logger 一本化の確認)

### session 別

| #   | 種別 | Function Duration (PerformanceResourceTiming.duration ≒ TTFB) | x-vercel-id           | session_id                             | response date (GMT) |
| --- | ---- | ------------------------------------------------------------- | --------------------- | -------------------------------------- | ------------------- |
| 1   | cold | **17,426ms**                                                  | `z29sb-1779947749063` | `55d153cd-862d-4f1b-899b-286cd493d521` | 05:56:06            |
| 2   | warm | **16,773ms**                                                  | `9d9fs-1779947823197` | `91eb3e3a-13f0-48e7-8458-321cb19734e9` | 05:57:19            |
| 3   | warm | **16,746ms**                                                  | `g8vmx-1779947896993` | `276e052a-dc27-4601-baf5-58dcc02c3def` | 05:58:33            |

### event_id 一覧 (OT の log 照合用)

- **session 1** (55d153cd): `84bdeeb8` / `afcde7e3` / `3fbf3bbd` / `e98d967f` / `039465fc`
- **session 2** (91eb3e3a): `2b706478` / `ceb5760e` / `285c3383` / `0b02d410` / `cd8ef56c`
- **session 3** (276e052a): `d0ba6924` / `c4b0620c` / `119b8bf8` / `837b21a6` / `dfb00a45`

(全 event rating=3 Good、 answered_at は各 session 内で ~0.87s 間隔の昇順)

---

## 3. 解釈

### 3.1 client 側で確定できる範囲

- **Function Duration ~16.7〜17.4s** (body 29B なので ≒ TTFB ≒ server 実行 + network RTT)。 投資 memo §2.1「12-17s」 / cache-fix-roadmap §4.5「TTFB 10.7s」 と同オーダー、 やや上振れ
- **cold/warm 差 ~0.66s** (cold 17.4s - warm 平均 16.76s)。 = **Vercel cold start の寄与は小さい**。 16s の大半は cold start ではなく per-event serial transaction の DB 処理 / RTT
- 3 回とも ~16.7-17.4s で **安定** (= measurement noise 小、 baseline として信頼できる)

### 3.2 per-op breakdown (OT の server log 取得後に確定)

以下は §4 で OT が取得する `review_events.bulk.timing` の `timings` から確定する。 現時点は **未取得**:

- [ ] per-SQL 時間が region RTT (~230ms、 iad1↔sin1) 近傍か、 大きく上回るか
- [ ] `event-N-tx` ≈ 6 × per-SQL か (tx begin/commit overhead 小)、 大幅超過か (tx overhead 支配的)
- [ ] submitReviewTx 内 5 sub-op (select-cards / update-cards / insert-reviews / select-distinct / upsert-study-days) の重み配分。 特に `select-distinct` (COUNT(DISTINCT) 全 reviews 集計) が重い候補 (投資 memo §5.1 で「重い候補」 と注記)
- [ ] `session-upsert` 単独時間
- [ ] `total` (server 内部) vs client Function Duration の差 = network 往復 + Vercel edge overhead
- [ ] 投資 memo §5.2 試算 (RTT 230ms × 31 SQL = 7,130ms + tx overhead 2,300ms = ~9,400ms) と実測 total の整合度

### 3.3 bulk 化の改善目標 baseline

- 現状 N=5 で **server 内部 ~16s** (client Function Duration ベース、 server total は OT 取得後に確定)
- 投資 memo §6.3 の bulk refactor (31 SQL + 5 tx → 8 SQL + 1 tx) が効けば、 §7 試算で **9.4s → 2.3s (~4x)** が目標
- ただし「16s の内訳 = SQL RTT 支配か / DB 処理支配か / tx overhead 支配か」 を §3.2 で確定しないと、 bulk 化で削減できる量が数値で示せない → **OT の server log 取得が次の必須ステップ**

---

## 4. OT 照合手順 (Vercel function log)

stg の Vercel function log (Deployment → Functions → `/api/review-events/bulk`) で、 以下を session ごとに引く:

### 4.1 marker 確認 (scope 1 = 信頼性担保)

各 session の発火時刻帯に `event: "review_events.bulk.request"` の log 行が出ているか。 **1 行も出ていなければ計測前提が崩れている** (= d3617a8 未 deploy / env ガードで preview 判定が効かず production 扱い / logger 未動作) → その旨を Claude Code に報告、 計測やり直し。

### 4.2 timing 取得 (scope 2)

`event: "review_events.bulk.timing"` の log 行から `timings` オブジェクトを session ごとに dump:

| 照合軸                | session 1           | session 2           | session 3           |
| --------------------- | ------------------- | ------------------- | ------------------- |
| 時刻帯 (GMT)          | 05:55:48〜05:56:06  | 05:57:03〜05:57:19  | 05:58:16〜05:58:33  |
| x-vercel-id           | z29sb-1779947749063 | 9d9fs-1779947823197 | g8vmx-1779947896993 |
| sessionId (log field) | 55d153cd-...        | 91eb3e3a-...        | 276e052a-...        |

取得すべき `timings` キー (各 session、 eventCount=5):

- `session-upsert`
- `event-0-tx` 〜 `event-4-tx` (= 各 event の transaction 全体)
- `event-0-insert` 〜 `event-4-insert` (= answer_events INSERT)
- `event-0-submitTx` 〜 `event-4-submitTx` (= submitReviewTx 全体)
- `event-0-select-cards` 〜 `event-4-select-cards` 等の 5 sub-op (= submitReviewTx 内、 prefix `event-N-`)
- `total`

これらを §3.2 に当てはめて per-op breakdown を確定 → §3.3 の改善目標を数値化。

---

## 5. やったこと / やらないこと / 次手

- やった: 3 session の client POST 発火 + 識別子 dump + Function Duration (cold/warm)
- やらない: server per-op 取得 (= OT の Vercel log 領域)。 SQL refactor 本体 (問題 3 本体) は本 task scope 外
- 次手: OT が §4 で marker/timing 取得 → §3.2 を数値確定 → bulk refactor (問題 3 本体) の spec 起草へ
