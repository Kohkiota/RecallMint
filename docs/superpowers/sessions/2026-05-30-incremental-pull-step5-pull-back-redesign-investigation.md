# 増分 pull Step 5 pull-back 再設計 pre-investigation — flush 経路と成功判定の実コード確定

- **日付**: 2026-05-30
- **契機**: Step 5 stg smoke の観点1 FAIL(`2026-05-30-incremental-pull-step5-pull-back-flush-hook-stg-smoke.md`)。pull-back が bulk commit と race し stale 取得。
- **目的**: 再設計(所与方針)に向け、flush 3 経路の戻り値・in-flight guard・成功判定・commit タイミングを実コードで確定する。
- **結論**: 弁別子は **`FlushResult.syncedEventIds.length > 0`**(実送信成功)。`classifyFlushResults` が skip(`attempted:0`)を `'ok'` に誤分類するのが FAIL の核心。bulk は 200 返却前に commit 済 → `syncedEventIds` 非空を pull-back gate にすれば commit 前 race を構造的に排除できる。

---

## 1. FlushResult の戻り値構造(`review-events.ts:220-230`)

```
type FlushResult = {
  attempted: number          // この呼出で実 POST した event 数
  syncedEventIds: string[]   // 実送信して成功した event_id
  failedEventIds: string[]   // 失敗した event_id
  sessionSynced: boolean
  reachable: boolean
  httpStatus: number
}
```

`flushPendingEvents`(`review-events.ts:284-396`)の戻り値パターン:

| ケース | 条件 | 戻り値の特徴 |
|---|---|---|
| **skip (in-flight 確保中)** | `pendingAll>0 && targets(=非in-flight)===0`(L306) / または session 不在(L289) | `{attempted:0, syncedEventIds:[], failedEventIds:[], reachable:false, httpStatus:0}` |
| **実送信成功** | POST ok + 全件成功(L366-389) | `{attempted:targets.length(>0), syncedEventIds:[非空], failedEventIds:[], sessionSynced:true, httpStatus:200}` |
| **部分失敗** | POST ok + 一部 failed | `syncedEventIds:[一部], failedEventIds:[一部]` |
| **送信失敗** | POST !ok(L353) | `{attempted:targets.length, syncedEventIds:[], failedEventIds:[全件], reachable:..., httpStatus:応答}` |
| **session-only POST** | `pendingAll===0`(events 無し)で session status のみ送る | `{attempted:0, syncedEventIds:[], failedEventIds:[], sessionSynced:true, httpStatus:200}` |

→ **「実送信して成功した」唯一の弁別子は `syncedEventIds.length > 0`**。`attempted:0` は skip と session-only の両方を含み、いずれも card FSRS 変化なし = pull-back 不要。`syncedEventIds` 非空は「card を実際に更新した event を送って 200 を得た」を意味する。

## 2. classifyFlushResults の誤分類(`review-flush.ts:52-61`)

```ts
export function classifyFlushResults(results: FlushResult[]): FlushOutcome {
  if (results.length === 0) return 'no-pending'
  const failures = results.filter((r) => r.failedEventIds.length > 0)
  if (failures.length === 0) return 'ok'   // ← skip も session-only も 'ok' に畳む (誤)
  // ... 失敗時 rate-limited / transient / permanent
}
```

- 設計意図は**controller の retry 分類**(429 即停止 / 5xx retry / 4xx 永続)。「failed が無い = 'ok'」は retry 観点では正しい(retry しない)が、**「実際に event を sync したか」を区別しない**。
- skip 結果 `[{attempted:0, failedEventIds:[]}]` → failures 空 → **`'ok'`**。これを pull-back gate に流用したため premature 発火した(smoke FAIL)。
- caller 棚卸し: `runGuardedFlush`(`review-flush.ts:99,109`、controller 経路)/ `session-runner.tsx:312`(session 完了)。他に production caller なし。

## 3. in-flight guard の確保・解放タイミング(`review-events.ts:218,318-394`)

- module-scope `inFlightEventIds: Set<string>`(`:218`)。
- `flushPendingEvents`: targets を `inFlightEventIds.add`(L318-320)→ POST → **`finally` で必ず `delete`**(L390-394、成否問わず)。
- 並走 flush は `targets = pendingAll.filter(!inFlightEventIds.has(...))`(L305)で他 flush 確保分を除外 → 全件 in-flight なら早期 return(skip)。
- **race の実機序(daily=5=threshold)**: 5問目回答 → threshold flush(`flushPendingEvents`)が 5 events を add して POST(実 sync)→ ほぼ同時に session 完了 `flushAllPendingEvents` が同 events を全て in-flight と判定 → 早期 return skip(`attempted:0`)→ `classifyFlushResults` が `'ok'` 誤分類 → **threshold flush の POST が commit する前**に pull-back 発火 → stale。

## 4. 実送信成功の確定点と commit 前後関係

- `flushPendingEvents` は `const response = await client.post(payload)`(L352)→ **ok 確認後に `markAnswerEventsSynced(syncedEventIds)`**(L372)→ `syncedEventIds` を戻す。つまり **`syncedEventIds` が非空 = `await post` が 200 を返した後**。
- bulk route(`bulk/route.ts`): `processSession` が `db.transaction(...)` 内で cards を `updatedAt: sql\`now()\``(L333)更新 → **`await processSession` 完了(commit)後に `return Response.json({ok:true}, {status:200})`**(L536-548)。
- ⇒ **client が `response.ok`(200)を得た時点で bulk tx は commit 済**(FSRS 値 + updated_at=now() 永続化済)。smoke で実証: bulk 200 直後の手動 fetch が `updated_at=06:57:16.227Z` の FSRS 後値を返した。
- **帰結**: pull-back の gate を `syncedEventIds.length > 0`(= post ok 後にのみ非空)にすれば、**pull-back は必ず bulk commit 後に走る**。commit 前 race は構造的に起きない。

## 5. 各経路の hook 位置(再設計の落とし所)

| 経路 | 実送信成功の確定点 | 現状 hook |
|---|---|---|
| threshold flush | `session-runner.tsx:287-289` の `flushPendingEvents` 戻り値 | **無し**(戻り値破棄) |
| session 完了 flush | `session-runner.tsx:309-312` の `flushAllPendingEvents` 戻り値 | `classifyFlushResults==='ok'`(誤) |
| controller flush | `review-flush.ts` kick の `runGuarded()`(→`classifyFlushResults`)結果 | `outcome==='ok'` → `onFlushed`(誤、Task 1) |

→ 3 経路とも「`syncedEventIds` 非空 = 実送信成功」を gate にすれば正しい。`classifyFlushResults` を「`'ok'` = failed 無し **かつ** 実 sync ≥1 件」に修正すれば、**'ok' を gate にしている既存 2 経路(session 完了 / controller onFlushed)は自動的に正される**。残るは threshold flush への hook 追加のみ。

## 6. 確定した修正設計(minimal)

1. **`classifyFlushResults` の `'ok'` 再定義**: `failures.length === 0` のとき、`results.some(r => r.syncedEventIds.length > 0)` なら `'ok'`、さもなくば `'no-pending'`。= skip / session-only / 空振りを `'ok'` から除外。retry 挙動は不変(controller は 'ok'/'no-pending' を同じ「retry しない」分岐で扱う、`review-flush.ts:212-222`)。
2. **threshold flush に hook 追加**(`session-runner.tsx:287-289`): `const r = await flushPendingEvents(sessionId); if (classifyFlushResults([r]) === 'ok') pullBack('threshold-flush')`。U6 を見直し(実 sync なら threshold でも pull-back 可、in-flight guard で coalesce)。
3. **session 完了(:312)/ controller onFlushed: コード変更不要**(再定義で自動的に正される)。
4. `pullBack` helper は共通 1 関数のまま再利用。
5. **race regression test 必須**: skip 結果 → `classifyFlushResults` が `'ok'` でなく `'no-pending'` → pull-back 不発 / 実 sync 結果 → `'ok'` → 1 回発火。

### race 解消の検証(全シナリオ 1 回だけ正発火)
- daily=5=threshold: threshold flush 実 sync(synced 非空→'ok'→pullBack)/ session 完了 skip(synced 空→'no-pending'→不発)→ **1 回、commit 後**。
- threshold 先完了: threshold が pullBack / session 完了 flushAll は pending 空→`[]`→'no-pending'→不発 → 1 回。
- <5 問(threshold 未到達): session 完了 flushAll 実 sync→'ok'→pullBack → 1 回。

## 7. 実装前に確認・判断が要る点(OT 認識)

- **R1(成功判定の直し方・確定）**: `classifyFlushResults` の `'ok'` を「実 sync ≥1」に再定義する(別 predicate 新設や `runGuardedFlush` 戻り値型変更はしない)。理由: 'ok'-gate の既存 2 経路を最小改変で同時に正し、retry 挙動も不変。所与方針「classifyFlushResults 相当を…スキップを 'ok' と扱わないよう修正」に直接対応。
- **R2(skip の outcome 名・軽微)**: skip を `'no-pending'` に畳む(やや名称ズレ、「pending はあるが他 flush が処理中」)。専用 `'skipped'` outcome 新設も可(より honest だが FlushOutcome union 追加)。**既定: 'no-pending'**(最小)。OT が明確さ優先なら 'skipped'。
- **R3(U6 反転・確定）**: threshold flush に hook を追加(再設計で U6 撤回)。in-flight guard で /api/pull は 1 本に coalesce、study_days は idempotent full-replace のため無駄打ち許容(step4 U3 同方針)。
- **R4(既存 commit の扱い・確定)**: step 5 既存 4 feat commit(`f178f47`/`a1adbf9`/`e2b7004`/`df1b3e4`、push 済・[no-review])は**書き換えず修正を上に積む**(additive)。理由: push 済履歴の rewrite 回避、修正は「classify 再定義 + threshold hook 追加」で自然に additive。session 完了 hook(`df1b3e4`)のコードは再定義で**そのまま正しくなる**ため変更不要。再 smoke PASS 後に step5 全 feat commit を filter-branch で [reviewed] 化(step1-4 同手順)。
- **R5(spec 再修正・要対応)**: §3.3 の前回補正(`7dbbf29`)は「session 完了 flush 成功時 classifyFlushResults==='ok'」とのみ記述。再設計で(a)threshold flush も hook、(b)発火条件は「実 sync(syncedEventIds 非空)」= classifyFlushResults 'ok' 再定義、を追記修正する(doc、[no-review])。
- 所与方針との食い違い: なし(R1 は「classifyFlushResults 相当を修正」の具体化、R2 は実装細部、R3 は方針の明示反映)。
