# 問題 2 (flush in-flight guard) stg smoke

- 日時: 2026-05-28
- 種別: session log / stg smoke (実装変更なし)
- 対象 commit: `5e86839 fix(study): flush 並走重複を event_id ベース in-flight guard で排除 (cache-fix 問題 2) [reviewed]` (stg deploy 済)
- 対象 stg: `https://stg.recallmint.nekotest.net`
- account: `komail9server+001@gmail.com` (前回計測と同、 IDB clear で clean state)
- 実行手段: Playwright MCP + DevTools Network / PerformanceResourceTiming
- 関連: `2026-05-28-cache-fix-step3a-timing-aborted.md` (= fix 前の計測、 並走 2 本観測)
- 結論: **確認項目 1-4 全 PASS**。 並走重複は解消、 経路 3 削除も機能

---

## 1. 確認項目と結果

| # | 項目 | 結果 | 根拠 |
|---|---|---|---|
| 1 | 並走重複の解消 | **PASS** | bulk POST が **1 本のみ** (#45)、 5 events 全部を 1 payload に集約、 event_id 重複なし。 計測時 (fix 前) は同 5 events を含む POST が #42/#43 の **2 本、 1ms 差並走** だった |
| 2 | 経路 3 削除 | **PASS** | 完了画面「ダッシュボードへ」 click で btnDisabled=false / warning UI なし / 「保存中」 表示なし、 click 後 URL=/app に即遷移 (await flush なし) |
| 3 | group flush | **PASS (通常ケース)** | clean state の 1 session なので 1 POST。 複数 session 残骸ケース (session 数分 POST) は clean state のため未観察、 = 「通常 1 session なら 1 POST」 を確認 |
| 4 | データ反映 | **PASS** | reload 後 dashboard「今日の学習問題数 10」 (前回 session 5 + 今回 5)、 smartDue 15 (20 - 5)。 連続日数 1 |

---

## 2. POST dump (in-flight guard 効果の物的証拠)

### 2.1 今回 (fix 後、 5e86839)

```
network: #45 [POST] /api/review-events/bulk => 200   ← 1 本のみ
PerformanceResourceTiming: count=1
  startTime 23,102ms / duration 17,537ms / responseEnd 40,639ms / serverTiming entries=0
```

- **serverTiming=0**: 一時計測 log (8417e83) の revert (1f6319a) が stg 反映済の確認 (= Server-Timing header が消えた)
- **duration 17.5s**: 1 POST あたりの server 処理時間は問題 3 (per-event serial transaction) 未対応のため fix 前と同オーダー。 本 sprint scope 外

### 2.2 payload (#45、 request-body)

```
session: { session_id: 49d2db53-f5a2-4a50-9683-503133ce10e3, status: "completed",
           completed_at: 2026-05-28T05:22:47.943Z, card_ids: [5 件] }
events (5 件、 全 event_id 相異、 answered_at 昇順):
  1. 04f196f1-5f4a-4c8f-a7eb-14072bd880b2  card 7226fdd3  answered_at 05:22:44.450Z  rating 3
  2. 4005b30b-7b96-4959-9e58-67f43fd854dd  card 3a71cad0  answered_at 05:22:45.324Z  rating 3
  3. 17eeed3f-8225-4c5d-98ec-dd82c067c18c  card e858e708  answered_at 05:22:46.197Z  rating 3
  4. 8af908ed-baa6-41e9-9cea-402bdabf3344  card 412f6f39  answered_at 05:22:47.069Z  rating 3
  5. 617733b0-3407-4700-b956-28c7da5e169b  card 12c27e1f  answered_at 05:22:47.942Z  rating 3
```

- payload に `status=completed` + `completed_at` 含む = 経路 2 (finished useEffect の completeStudySession 後 flushAllPendingEvents) または経路 1 が completeStudySession 後に走った 1 本
- もう片方の経路は in-flight 除外後 events 0 件で **early-return skip** = 二重送信なし (= in-flight guard 効果)

### 2.3 計測時 (fix 前、 timing-aborted log §2 再掲)

```
network: #42 + #43 [POST] /api/review-events/bulk => 200   ← 2 本並走
  #42 startTime 73,221ms / TTFB 17,948ms
  #43 startTime 73,221ms / TTFB 17,738ms   (= 1ms 差で同一 5 events を二重送信)
```

= **fix 前後の決定的差分**: 2 本並走 → 1 本。

---

## 3. response header (#45)

```
x-vercel-id: hnd1::iad1::jqrrw-1779945768015-d9eea29f45da
x-vercel-cache: MISS
date: Thu, 28 May 2026 05:23:05 GMT
content-type: application/json
(Server-Timing header なし = revert 反映済)
```

- Function region iad1 不変 (= 問題 3 / region 系は別 scope)

---

## 4. OT 照合ポイント (Vercel function log)

Claude Code は DevTools 側 (client が送った POST) を確認済。 **server 側で同 POST を 1 回だけ受信・処理したか** を OT が Vercel function log で照合:

| 照合軸 | 値 |
|---|---|
| endpoint | `POST /api/review-events/bulk` |
| 時刻帯 (GMT) | **2026-05-28 05:22:47 〜 05:23:05** (= client 発火 05:22:47 完了画面到達直後 〜 response 05:23:05) |
| x-vercel-id | `jqrrw-1779945768015-d9eea29f45da` (= この invocation を log で特定) |
| session_id | `49d2db53-f5a2-4a50-9683-503133ce10e3` |
| event_id (5 件) | `04f196f1` / `4005b30b` / `17eeed3f` / `8af908ed` / `617733b0` |

**照合してほしいこと**:
1. 上記時刻帯の `/api/review-events/bulk` invocation が **1 件のみ** であること (= 計測時のような 2 件並走 invocation がない)
2. その 1 invocation で 5 event が処理され、 reviews / study_days に反映されたこと
3. (もし 2 件以上の invocation があれば) in-flight guard が client 側で機能していない兆候 → 異常として要報告

---

## 5. 観察事項 (問題 2 fix と無関係、 別 issue 候補)

- **遷移直後の dashboard は pull 完了前の古い mirror を表示**: 完了画面 click → /app 即遷移直後 (3s) は「今日の学習問題数 5」 (= smart 着地時に pull した古い値)、 **reload 後に 10** に更新。 = PullTrigger の pullAllStudyDays が fire-and-forget で、 dashboard 初回 render が pull 完了を待たない既存挙動。 問題 2 (flush guard) の scope 外だが、 「演習直後の dashboard 即時性」 として将来 UX 課題になりうる (= 別 issue 候補)

---

## 6. やったこと / やらないこと

- やった: 並走解消 (項目 1) / 経路 3 削除 (項目 2) / group flush 通常ケース (項目 3) / データ反映 (項目 4) を DevTools で機械確認
- やらない: silent retry (POST 失敗時の再送) は stg で意図的失敗の再現困難のため skip (brief 許容)。 group flush の複数 session 残骸ケースは clean state のため未観察 (= 通常ケースのみ)
- OT 依頼: §4 の Vercel function log 照合 (= server 受信が 1 回のみか)
