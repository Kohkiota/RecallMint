# 問題 3 after 計測 (bulk refactor、 before との比較)

- 日時: 2026-05-28
- 種別: session log / after 計測
- 対象 commit: `d06062c` (develop HEAD、 bulk refactor 完了版。 `git ls-remote origin develop` = d06062c で remote 反映確認済)
- 対象 stg: `https://stg.recallmint.nekotest.net`
- account: `komail9server+001@gmail.com` (IDB clear で clean state)
- 実行手段: Playwright MCP + DevTools Network / PerformanceResourceTiming
- before baseline: `docs/superpowers/sessions/2026-05-28-problem3-before-measurement.md` (per-event 版、 Function Duration 16.7〜17.4s)
- **状態: BLOCKED (client 実走) — Playwright が stg Clerk sign-in に阻まれ未認証。 下記§0 参照。 OT の認証 hand-off or 手動実走待ち**

---

## 0. 現状と blocker (停止理由)

`git ls-remote origin refs/heads/develop` = `d06062c` を確認 → **refactor は remote develop に反映済**。 ただし以下 2 点で Claude Code 自走が停止:

1. **認証 blocker (主因)**: Playwright で `https://stg.recallmint.nekotest.net/app` に navigate → `/sign-in` に redirect。 Clerk sign-in wall ("Sign in to recall-mint-dev" / Development mode、 Google OAuth or email+password)。 **Claude Code は account password / OAuth / OTP を保持せず認証不可**。 before 計測 (05:55-05:58) は認証済 Playwright session で実行されたが、 本 session の browser は fresh で未認証。
   - → CLAUDE.md「Smoke 確認」の OT 依頼条件「Claude Code 環境で届かない条件 (OT 専用 Clerk 設定 等)」に該当。
2. **deploy 反映 gate (未確認)**: remote develop = d06062c だが、 **stg Vercel が d06062c を build/deploy 完了して配信しているか**は未認証ゆえ未確認。 認証後に §2 の Function Duration が ~3s 付近なら反映済、 ~16s のままなら旧 per-event 版が配信中 (= 反映ずれ) と判定し、 OT に stg redeploy を要請する。

**進め方 2 択 (OT 判断)**:
- (A) OT が Playwright MCP browser に手動 sign-in (komail9server+001) → Claude Code が §1-3 の client 実走 + dump を継続。
- (B) OT が §1 手順を手動実走し、 §2 表に Function Duration / 識別子を記入 → Claude Code が §3 解釈。
どちらでも server per-phase timing は §4 で OT が Vercel log から取得 (before と同分担)。

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
