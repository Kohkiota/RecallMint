# 増分 pull Step 5「pull-back 配線」 UI 経由 stg smoke — 観点1 FAIL (pull-back が bulk commit と race)

- **日付**: 2026-05-30
- **対象**: origin/develop @ `7dbbf29`(Step5: `f178f47`/`a1adbf9`/`e2b7004`/`df1b3e4` feat + `7dbbf29` spec、全 `[no-review]`)
- **plan**: `docs/superpowers/plans/2026-05-30-incremental-pull-step5-pull-back-flush-hook.md` の UI 経由 4 観点
- **環境**: staging `https://stg.recallmint.nekotest.net/app`、chrome-devtools MCP。user=`1231f42d-...`、FSRS モード、daily session=5 問、`FLUSH_THRESHOLD=5`。
- **結論**: **観点1(主観点)FAIL**。pull-back は発火するが **bulk push の commit を待たず race で stale を取得**し、mirror に FSRS 値が即時反映されない。指示に従い `[reviewed]` amend せず停止。観点2-4 は未実施(FAIL で停止)。

## 観点1 (通常フロー pull-back) — FAIL

### 操作
スマート復習 5 問(KCI 4.5.10.1 / 4.4.8.4 / 4.4.7.2 / 4.5.8.5 / 4.5.6.2)を回答 → セッション完了。baseline: cards 52 / `cards_cursor=2026-05-30T01:51:48.586Z` / dueCount 46。

### Network シーケンス(セッション完了時)
| reqid | 内容 | x-vercel-id epoch |
|---|---|---|
| 219 | `POST /api/review-events/bulk`(5 events 全件 + session completed)→ `{"ok":true,"failed":[]}` | `...235845` |
| 220 | `GET /api/study-days/pull` (pull-back) | — |
| 221 | `GET /api/pull?since_cards=2026-05-30T01:51:48.586Z..` (pull-back) | `...235846` |

→ bulk POST → study-days + /api/pull の **順序自体は出た**(pull-back は発火している)。**しかし 219 と 221 の x-vercel-id epoch が 1ms 差 = ほぼ同時発射**で、pull-back が bulk の commit を待っていない。

### 症状(mirror 未反映)
pull-back(221)レスポンスは **`since_cards=01:51` の境界行のみ**(前回 01:51 セッションの 問3/問6/問7/問14/問31、`updated_at=01:51:48.586Z`)を返し、**今回回答した 5 枚を含まない**。結果:
- `cards_cursor` 据え置き `01:51:48.586Z`(前進せず)
- 回答 5 枚の FSRS 後値が mirror に未反映、dueCount 46 のまま

### サーバー側は正常(データ経路の健全性を分離確認)
- bulk(219)リクエスト body = 5 events 全件、レスポンス `{ok:true, failed:[]}`。
- 直後に**手動 fetch** で同 `?since_cards=01:51` を叩くと、回答 5 枚が **`updated_at=2026-05-30T06:57:16.227Z`(前進)・FSRS 後値**(due 07:0x、stability 2.3065、reps+1)で返る = **bulk commit 済・step 1 の `now()` クロックも正常動作**。
- さらに**実クライアント pull(visibilitychange 発火)**を 1 回走らせると mirror が正しく更新:`cards_cursor` `01:51:48.586Z`→`06:57:16.227Z`、dueCount 46→**41**、回答 5 枚が FSRS 後値で mirror 反映。

→ データ経路(bulk commit / updated_at bump / 増分 pull / mirror 書込)は全て健全。**問題は「session 完了時の pull-back が bulk commit より先に走り stale を取る」timing race に限定**。

## 根本原因(確定)

**5件閾値 flush と session 完了 flush の race + in-flight-skip 結果の `'ok'` 誤分類**:

1. daily session=5 問 = `FLUSH_THRESHOLD`(5)。5 枚目回答の `recordAnswerEvent` block で `pending=5 >= 5` → **5件閾値 flush(`flushPendingEvents`)が events を `inFlightEventIds` に確保して bulk POST(=219、実 sync)**。
2. ほぼ同時に finished useEffect が `completeStudySession` → **`flushAllPendingEvents`** を実行。これは内部 `flushPendingEvents` で全 event が in-flight 中 → 早期 return `{attempted:0, syncedEventIds:[], failedEventIds:[], ...}`(`review-events.ts:306-314`)。**219 の commit を待たない**。
3. `classifyFlushResults([{attempted:0, failedEventIds:[]}])` は **failures 空 → `'ok'`**(`review-flush.ts:52-61`)と判定。
4. session-runner(`session-runner.tsx:312`)が `=== 'ok'` で **pull-back を即発火(221)** → 219 の commit 前に走り stale。

= **session 完了 pull-back hook が「実 sync は別経路(threshold flush)が担い、自分は in-flight-skip の no-op」というケースを `'ok'` と誤認して premature 発火する**。`classifyFlushResults` は in-flight-skip(attempted:0・failed 空)を `'ok'` に畳むため、「実際に同期した」保証にならない。

### 影響範囲
- **daily session=5 = threshold のため、通常の 1 セッション完了は毎回この race を踏む**(card 数が threshold の倍数で同様)。= §8-2 ⑤「FSRS 値の即時 mirror 反映」が通常フローで成立しない。
- データ損失はない(次の pull トリガ mount/visibility/online/reload で正しく反映)。あくまで「session 完了直後の即時反映」が壊れる。dashboard に戻った瞬間は dueCount が stale(46 のまま、本来 41)。

## 修正方向(plan 段階で要再設計、本 smoke では未実施)
- 案A: pull-back の発火条件を `classifyFlushResults==='ok'` でなく **「実際に sync された」**(`results.some(r => r.syncedEventIds.length > 0)`)に変更。ただし threshold flush が実 sync を担う場合 session-complete は no-op になり pull-back が出なくなるため、**threshold flush 成功側にも pull-back を hook する**必要(U6 の再検討)。
- 案B: pull-back を「flush が実際に event を sync した確定点」(`flushPendingEvents` の同期成功)に hook を移し、経路(threshold / session-complete)に依らず 1 回 coalesce 発火させる。runGuardedPull の in-flight guard で二重化は吸収。
- 案C: in-flight-skip 結果を `classifyFlushResults` で `'ok'` でなく専用 outcome(例 `'in-flight'`)に分類し、pull-back 対象外にする(ただし案A 同様 threshold flush 側 hook が別途必要)。
- いずれも U5/U6 の再検討を伴うため、**plan に戻して再設計**するのが適切。

## 観点2-4
FAIL 検出のため未実施(指示: いずれか FAIL で amend せず停止)。

## テストデータ
復習 5 問は通常操作(FSRS 状態が正規に進行、削除対象の「テストデータ」ではない)。サーバー側で 5 枚の reps+1 / due 更新が確定済(巻き戻しは行わない)。破壊的操作なし。

## 結論
観点1 FAIL。pull-back の発火経路に race による premature/stale 問題があり、通常フローで即時反映が成立しない。`[reviewed]` amend は行わず、再設計のため plan に差し戻す。
