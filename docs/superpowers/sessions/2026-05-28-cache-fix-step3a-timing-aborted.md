# Step 3a Server-Timing 計測 (中断、 並走 pattern 物的証拠取得済)

- 日時: 2026-05-28
- 種別: session log / 計測 sprint (中断)
- 対象: cache-fix roadmap §4.5 Step 3a (bulk endpoint per-op timing 取得)
- 対象 commit: `8417e83 chore(perf): bulk endpoint 一時 timing log (TEMP-MEASURE) [no-review]` (= timing log 仕込み)
- 関連 sprint kickoff brief: 2026-05-27 (Session 3a 実走指示) + 2026-05-28 中断指示
- 関連 doc:
  - `docs/superpowers/sessions/2026-05-27-bulk-flush-latency-investigation.md` (= 投資 memo)
  - `docs/superpowers/sessions/2026-05-27-fsrs-sync-layer-survey.md` (= 直前 survey)

---

## 1. 経緯と中断判断

stg で FSRS smart 復習 1 session (cold) を Playwright MCP 経由で完走し、 `POST /api/review-events/bulk` の Server-Timing header から per-op timing 取得を試みた。 結果:

- Network response header / PerformanceResourceTiming の serverTiming entries とも **空**
- = 8417e83 で仕込んだ `Server-Timing` header が現 stg deploy で reach していない (= deploy 反映ずれ / Vercel proxy strip / 他の理由 のいずれか、 究明は別 sprint)
- ただし計測 sprint brief §E「期待 metric 出力なしの場合は即 stop、 fallback で計測コード再仕込み + 再 deploy は scope 外」 該当
- OT 判断 (2026-05-28): 計測中断。 取得済 18s 並走の物的証拠で問題 2 / 3 sprint には十分。 per-SQL 内訳は問題 2 / 3 着手に不要 = 計測コストかけない。 session 2 / 3 走行 (cold/warm) は中止

---

## 2. 取得 metric (cold session 1 のみ、 N=5)

### 2.1 計測条件

- account: `komail9server+001@gmail.com` (前回 smoke と同、 IDB clear で clean state)
- IDB clear: `indexedDB.deleteDatabase('recallmint')` + localStorage / sessionStorage clear (= Dexie 確認 `before: [recallmint] / after: []`)
- 設定: sessionLimit = 5 / FSRS モード オン / Free プラン
- card pattern: 5 cards × (任意選択肢 1 件 → 「回答する」 → Good (rating=3) → 「次へ」) を順次
- 5 件目 「次へ」 で `phase=finished` 遷移、 完了画面到達。 「ダッシュボードへ」 click は実施せず (= 経路 3 は未発火、 = 計測中断で打ち切り)

### 2.2 POST 観測 (PerformanceResourceTiming + browser_network_request)

| 項目 | POST #42 (経路推定 1) | POST #43 (経路推定 2) |
|---|---|---|
| URL | `/api/review-events/bulk` | `/api/review-events/bulk` |
| method / status | POST 200 | POST 200 |
| startTime (ms from navigation) | **73,221** | **73,221** (= 0-1ms 差) |
| requestStart | 73,221 | 73,222 |
| responseStart | 91,170 | 90,960 |
| responseEnd | 91,170 | 90,961 |
| **duration (TTFB ≒)** | **17,948ms** | **17,738ms** |
| transferSize | 329B | 329B |
| encodedBodySize | 29B | 29B |
| `Server-Timing` header | **(欠落)** | **(欠落)** |
| `serverTiming` entries (PerformanceResourceTiming) | **[]** | **[]** |
| `x-vercel-id` | `hnd1::iad1::vz7nl-...` | `hnd1::iad1::hslvt-...` |
| `x-vercel-cache` | MISS | MISS |
| `content-type` | application/json | application/json |
| `cache-control` | `public, max-age=0, must-revalidate` (Vercel default) | 同 |

### 2.3 payload (両 POST 同一)

```json
{
  "session": {
    "session_id": "29638c8b-ad28-4922-8e99-a8943343f37d",
    "mode": "smart",
    "card_ids": ["4e3efd54-...", "51ee294c-...", "5a805fd1-...", "e666b869-...", "0b3e8858-..."],
    "started_at": "2026-05-27T23:32:45.020Z",
    "completed_at": "2026-05-27T23:33:56.497Z",
    "status": "completed"
  },
  "events": [
    {"event_id": "3f4ed263-...", "card_id": "4e3efd54-...", "rating": 3, "answered_at": "2026-05-27T23:33:52.852Z", "is_correct": false, ...},
    ... 計 5 件 (rating=3 Good 統一、 is_correct=false 統一 = 任意選択肢 [1] が不正解)
  ]
}
```

---

## 3. 解釈

### 3.1 投資 memo §2.1 観測値の現コード再現性

| memo §2.1 値 | 今回 stg 実測 (N=5、 fix 後) | 解釈 |
|---|---|---|
| Function Duration 12-17s | TTFB **17.9s / 17.7s** | memo 上限を **若干上回る**、 同オーダー |
| 5-8 連続 POST | 1 session で **2 POST 並走** (= 経路 1 + 経路 2 並走 1 件分) + 経路 3 未発火 | 連打 fix (= Step 3b 完了) で events 累積消えた前提、 並走 1 件分の数値として整合 |
| Function region iad1 / Middleware iad1 | x-vercel-id `hnd1::iad1` = edge hnd1 / function iad1 | memo 通り |
| operation 数 ≠ POST 数 | events 5 件 = 期待値 5 件、 一致 | Step 3b fix 完了の裏取り (= 連打→累積 解消) |

= 投資 memo §2.1 観測値は **現コード基準で再現可能**。 数値は上振れ (~18s)、 ただし server side per-op breakdown 不能のため region RTT × SQL count (memo §5.2 試算 9,400ms RTT alone) との数値整合は今回未確認。 残 ~8.6s 分は (a) Vercel cold start / Brotli / Function init、 (b) DB 処理時間そのもの、 (c) 並走による DB lock 待ち、 (d) その他 のいずれか — **本 sprint では切り分け不能、 deferred**。

### 3.2 投資 memo §4.2 並走 pattern の物的証拠

実機で **同 session への bulk POST 2 件が 1ms 差で並走発火** を初確認。 ただし観測パターンは memo §4.2 とやや異なる:

- memo §4.2: 「経路 2 (finished useEffect) と 経路 3 (dashboard click) が並走」
- 今回観測: **経路 1 (5 件目 threshold flush) と 経路 2 (finished useEffect) が並走**、 経路 3 は未発火
- = 並走 source は memo 記述より広い (= 「経路 1 ↔ 経路 2」 「経路 2 ↔ 経路 3」 「経路 1 ↔ 経路 3」 全組合せが起こり得る)

両 POST の payload に `completed_at + status=completed` が含まれる根拠 (= 両方とも `completeStudySession` 後の `flushPendingEvents`、 = どちらか片方は 経路 2 を通っていることが確実、 残り片方は経路 1 が microtask order で completeStudySession 後に payload 構築した可能性 — タイミング詳細は実コード読み + race window 仮説、 §3.3 参照)。

### 3.3 経路 1 と「completed payload」 が共存する理由 (= 仮説)

実コード読みから推定する order:

```
5 件目 rate click
  → handleNextFsrsAfterRate → runSubmit(lastRating, () => goNext())
    L264-275 (sync): setError / setTally / setSubmittedCardIds / setLastRating
    L280 (sync):    onAfter() = goNext()
                       → setIdx(5) → cards.length に到達 → setPhase('finished')
                       ※ ここまで sync state 更新、 React batch
    L288-305 (async IIFE start, microtask):
      await recordAnswerEvent(...)            ← Dexie write 5 件目
      await countPendingAnswerEvents(...)     ← Dexie read、 pending=5
      if (>= 5) await flushPendingEvents(...) ← 経路 1 fetch 発火

[React commit phase] finished useEffect 走行
  L323-330: await completeStudySession(...)    ← Dexie update
            await flushPendingEvents(...)      ← 経路 2 fetch 発火
```

- 経路 1 と useEffect の completeStudySession は **microtask 順で race**
- 経路 1 の `getStudySession` (= L211) が completeStudySession の **後** で読まれると、 session.completed_at / status=completed が既に Dexie に書かれていて payload に乗る
- 一方で経路 1 の `getStudySession` が `completeStudySession` の **前** に読まれれば、 active / completed_at=null の payload になる

今回両 POST が `completed` 含んでいた = **どちらの `getStudySession` も completeStudySession の後で走った**、 = useEffect の `await completeStudySession` が経路 1 の microtask より先に Dexie に反映された order。 = 並走の根本は **同 events を pull する getPendingAnswerEvents の重複呼び**、 session state は副次。

= **問題 2 (in-flight guard 不在) の実機証拠**。 補強として、 server 側 `ON CONFLICT DO NOTHING` で副作用ゼロ (= 重複 INSERT 防止) を実コード確認済 (= survey §1.3)。

---

## 4. 中断後の方針確認 (OT 指示 2026-05-28)

| # | item | OT 判断 |
|---|---|---|
| 1 | 計測 sprint 続行 (session 2 / 3、 cold/warm 比較) | **中止** (= 取得済 18s 並走で十分) |
| 2 | per-SQL 内訳取得 | **不要** (= 問題 2 / 3 着手に不要と確定) |
| 3 | 8417e83 deploy 状態究明 | **deferred** (= 別 sprint 化判断、 直近着手なし) |
| 4 | 8417e83 revert commit + push | **本 sprint で実施** (= 別 task で続行、 stg を timing log 抜きに戻す) |
| 5 | 問題 2 spec 起草 | **直接移行**、 brainstorming skill フルフロー |

---

## 5. follow-up

- [x] partial session log (本 file) commit
- [ ] 8417e83 revert commit + origin/develop push + Vercel stg auto deploy 反映確認 (= 続 task)
- [ ] 問題 2 brainstorming kickoff (= 続 task、 spec 起草前に Claude Code 側論点整理 → claude.ai 連携)
- [ ] cache-fix roadmap §4.5 Step 3a section の状態更新 (「進行中」 → 「中断、 別 sprint 復旧待ち」)、 ただし優先度低 = 問題 2 / 3 完了後でも可

---

## 6. 学び / observation

- **Server-Timing header の deploy reach 確認** は事前に独立 verify せず計測を始めると本問題が起こる。 次回 deploy-dependent な計測を立てる場合、 deploy 確認 step を計測前に独立 task として持つべき (= 例: `/api/review-events/bulk` に `X-Step3a-Probe: 1` のような marker header を 1 commit で仕込み、 deploy 後 1 fetch でだけ verify してから本計測に進む)。 ただし今回は brief §E 通り「即 stop」 で時間損失を最小化できた
- **18s 並走の物的証拠は spec の数値根拠として十分**。 per-SQL 内訳がなくても「N=5 で 1 POST ~18s」 は問題 3 案 c (= per-event tx 維持 + bulk insert/update) の改善目標値の baseline として使える (= memo §5.2 試算 9,400ms の上回り = SQL RTT 単独では説明できない、 = 他要因 (cold start / lock 待ち / DB 処理) も寄与) — ただし数値の精密な分解は今後実施
- **問題 2 並走は経路全組合せで起こりうる**。 in-flight guard 設計は経路 1 + 経路 2 + 経路 3 + 各経路同士の全組合せをカバーする必要 (= OT 設計方針通り、 sessionId base ではなく event_id base or 全 trigger で 1 promise 共有方式)

---

## 7. 関連 file / commit

- 一時計測 inject (revert 予定): `8417e83 chore(perf): bulk endpoint 一時 timing log (TEMP-MEASURE) [no-review]`
- 投資 memo: `aea5e9c docs(perf): bulk flush latency investigation memo (claude.ai 起票) を commit [no-review]`
- survey report: `df8877f docs(perf): FSRS smart 復習 sync layer 俯瞰調査 report [no-review]`
- 本 session log (commit 予定): `docs/superpowers/sessions/2026-05-28-cache-fix-step3a-timing-aborted.md`
