# 演習 push retry + 多タブ排他 — stg smoke 結果

- 日時: 2026-05-29 (09:16〜09:28 GMT)
- 種別: session log / stg smoke (実装変更・commit なし、 結果 doc のみ)
- 対象 stg: `https://stg.recallmint.nekotest.net` (deploy `dpl_9uj7jwST2FEbzhSoqLLjQCsgFqgx`、 origin/develop `06c9ba2` 反映済)
- 対象実装: `feat(study): review-events push の失敗保全 + 多タブ flush 排他` (06c9ba2)
- account: `komail9server+001@gmail.com` (OT が 2FA code hand-off、 plan=standard)
- 手段: chrome-devtools MCP (Playwright 同等)。 client logger が console に JSON 出力するため `review_events.flush.*` を browser console で直接検証 + DevTools Network (x-vercel-id / PerformanceResourceTiming) + IndexedDB 直接操作で再現困難条件を deterministically に検証
- **結論: 全 7 観点 PASS。 判断が要る異常なし。**

---

## 結論サマリ

| # | 観点 | 結果 | 主な実値 |
| --- | --- | --- | --- |
| 1 | 基本動作 (bulk push / region / 応答) | ✅ PASS | bulk 200 `{ok:true,failed:[]}`、 x-vercel-id `hnd1::hnd1`、 **601ms** (TTFB 598ms)、 5 event synced |
| 2 | 再送 trigger (mount/visibility/online) | ✅ PASS | 3 trigger とも `kick` 発火 → pending flush → `outcome=ok` |
| 3 | 429 即停止 | ✅ PASS | `outcome=rate-limited` + `rate_limited_stop` ログ、 retry スケジュールなし、 pending 据置 |
| 4 | 24h drop | ✅ PASS | mount 時 `stale_dropped count:1`、 該当 event `sync_status=failed` |
| 5 | backoff | ✅ PASS | `retry_scheduled` 11455ms → 33257ms (≈10s→30s 指数増)、 retry 実発火 → ok で drain |
| 6 | 多タブ排他 / 回復 | ✅ PASS | lock 保持中は `lock_busy` で skip (二重 POST なし)、 解放後 trigger で drain |
| 7 | 既存機能 非回帰 | ✅ PASS | 今日の学習 10→15、 due 50→45、 ○×判定/正答率 60% 正常 |

> 註: 3/4/5/6 の自然条件 (実 server 429 / 実 24h 経過 / 実 2 タブ・別端末 / 実オフライン) は再現困難なため、 **client 側ロジックを stg 実機上で deterministically に再現** (fetch override / IndexedDB 直接注入 / Web Locks 手動保持) して検証した。 自然条件での end-to-end 確認手順は §OT 実機手順 に残す。

---

## 1. 基本動作 (item 1)

- ログイン (2FA は OT hand-off) → `/app` ダッシュボード baseline: 今日の学習 **10** / 連続 1 / due **50**。
- スマート復習 5 問を回答 (FSRS、 rate-then-confirm)。 session 完了 (5 枚 / 3 正解 / 60%)。
- **bulk POST** (DevTools Network reqid=195): `POST /api/review-events/bulk` → **200** `{"ok":true,"failed":[]}`。
  - x-vercel-id: `hnd1::hnd1::6nb4r-1780046513051-6748f3850e4b` = **function 東京 (hnd1)**。
  - PerformanceResourceTiming: **duration 601ms / TTFB 598ms** = sub-1s (東京移行後レンジ 769ms と整合)。
  - payload: session `ccca8c1d-...` completed + **5 event** (event_id / card_id / rating 同梱)、 全 distinct card。 JWT に dbUserId / plan=standard。
- **session 全体で bulk POST は 1 本のみ** = 5 件閾値 (経路1) と session 完了 (経路2) が in-flight guard で集約され二重 POST が起きていない (問題 2 pattern 非回帰)。

## 2. 再送 trigger (item 2)

`ReviewFlushTrigger` が `(app)` layout に mount され、 3 trigger 全てで controller が pending を flush (console 実値):

| trigger | 手順 | console ログ実値 |
| --- | --- | --- |
| mount | `/app` reload | `{"reason":"mount","outcome":"no-pending","event":"...flush.kick"}` (pending 無し時) |
| online | pending 注入 → `dispatchEvent(new Event('online'))` | `{"reason":"online","outcome":"ok",...kick}` → pending 1→0 |
| visibilitychange | pending 注入 → `dispatchEvent(new Event('visibilitychange'))` (visible) | `{"reason":"visibilitychange","outcome":"ok",...kick}` → pending 1→0 |

→ 演習画面を離れた後の未送信 pending が、 通常画面の mount / フォーカス復帰 / 再接続で回復 flush される。

## 3. 429 即停止 (item 3)

- 手段: `window.fetch` を bulk endpoint のみ 429 応答に override → pending 注入 → online trigger。
- console 実値:
  - `{"reason":"online","outcome":"rate-limited","event":"...flush.kick"}`
  - `{"reason":"online","event":"...flush.rate_limited_stop"}`
- pending は据置 (synced されず)、 **`retry_scheduled` ログは出ない** = 自動 retry せず即停止 (CLAUDE.md ルール 5)。 次の通常 trigger に委ねる。

## 4. 24h drop (item 4)

- 手段: answered_at = `now - 25h` の pending を IndexedDB に注入 → `/app` reload (mount)。
- console 実値: `{"event":"...flush.stale_dropped","count":1}` → 続けて `kick outcome=no-pending`。
- IDB 確認: 該当 event `sync_status='failed'` に隔離 (物理削除せず痕跡保持)、 pending 0。 境界扱い (answered_at 基準) 通り。

## 5. backoff (item 5)

- 手段: `fetch` を 503 (transient) に override → online trigger → 途中で実 fetch に復旧。
- console 実値 (指数 backoff chain が完走):
  - `kick outcome=transient` → `retry_scheduled {attempt:0, delayMs:11455}` (base 10s + jitter ≤2s)
  - ~11.5s 後 `kick reason=retry outcome=transient` → `retry_scheduled {attempt:1, delayMs:33257}` (base 30s + jitter ≤5s)
  - ~30s 後 (fetch 復旧後) `kick reason=retry outcome=ok` → pending drain (synced)
- → transient 失敗で **指数 backoff (≈10s→30s) で再送**、 closure-scope timer で実発火、 復旧後に成功 drain。

## 6. 多タブ排他 / 回復 (item 6)

- 手段 (多タブ排他): Web Locks は origin 全タブ共有のため、 同一 origin で `navigator.locks.request('recallmint:review-events:flush', {mode:'exclusive'}, …)` を**手動保持** (= 別タブが flush 中を再現) → pending 注入 → online trigger。
- console 実値:
  - `{"event":"...flush.lock_busy","lockName":"recallmint:review-events:flush"}`
  - `{"reason":"online","outcome":"lock-busy","event":"...flush.kick"}`
  - lock 保持中は pending 据置 (flush skip = 二重 POST 抑止、 queue で待たない)。
- lock 解放 → 再 online trigger → pending 0 (drain)。 = 一時 skip であり恒久 block でない。
- **オフライン回復**: 機構としては item 5 の transient retry (network 断 = httpStatus 0 → transient → backoff) + item 2 の online trigger で実証済。 実オフライン (airplane mode) の end-to-end は §OT 実機手順 参照。

## 7. 既存機能 非回帰 (item 7)

- 今日の学習問題数: **10 → 15** (5 distinct card 反映)。
- スマート復習 due: **50 → 45** (FSRS due 前進)。
- ○×判定 (正解/不正解表示) ・正答率 (3/5=60%) ・連続日数 (同日 1 維持) 正常。
- = 回答記録 → bulk push → server FSRS 再計算 → study_days/cards pull → dashboard 反映 の全ループが従来通り。

---

## 検証で注入したテストデータ (要認識)

stg test account に smoke 用の追加 answer_events を IndexedDB 経由で注入し server に flush した:
- 回復 trigger 検証 (item 2/3/5/6) で計 数件の synced event (実 card への追加 review)。 → 今日の学習問題数 / due に smoke 由来の上振れが残る。
- 24h drop 検証 (item 4) の 1 件は `failed` 隔離 (server 未送信)。
- 異常・データ破壊なし。 clean state に戻したい場合は OT 判断 (test account の IDB clear + 再 pull / 該当 review の扱い)。

---

## OT 実機手順 (自然条件での end-to-end 確認、 任意)

client ロジックは stg 実機上で検証済。 以下は「自然条件」 での確証が欲しい場合の手順。 確認は Vercel log の `review_events.flush.*` (本実装の観測ログ) で後追い可。

1. **実オフライン → online 回復**: DevTools Network を Offline → 演習 5 問 → 完了 (flush 失敗・pending 残置を IDB で確認) → Online に戻す → online trigger で flush → dashboard 反映。 Vercel log で bulk 200 を確認。
2. **実 2 タブ / 別端末**: 同一 account で 2 タブ (or PC + mobile) を開き、 両方で pending を作って同時に visibilitychange/online を起こす → 片方が `lock_busy`、 もう片方が flush。 server 側は event_id UNIQUE で二重適用なし (failed[] / 重複 row が出ないこと)。
3. **実 429**: 自然発生は困難。 一時的に bulk route 前段で 429 を強制返却する feature flag を差すか、 Vercel WAF rate-limit を一時的に厳しくして 429 を誘発 → client が `rate_limited_stop` で即停止し retry しないこと、 pending が次 trigger まで残ることを確認。 (実装変更を伴うため OT 判断)
4. **実 24h 経過**: 演習途中で意図的にオフラインのまま放置し 24h 超過 → 翌日 mount で `stale_dropped` が出て pending が落ちること。 (時間がかかるため任意)

---

## 計測識別子 (OT の Vercel log 照合用)

| 軸 | 値 |
| --- | --- |
| deploy | `dpl_9uj7jwST2FEbzhSoqLLjQCsgFqgx` |
| bulk session_id | `ccca8c1d-e712-49b8-9da1-8baa07fb099a` |
| bulk x-vercel-id | `hnd1::hnd1::6nb4r-1780046513051-6748f3850e4b` (Fri, 29 May 2026 09:21:53 GMT) |
| dbUserId | `1231f42d-9c9f-4edb-addd-104890193571` (JWT) |
| 観測ログ event 名 | `review_events.flush.{kick,retry_scheduled,rate_limited_stop,retry_exhausted,lock_busy,stale_dropped}` |
