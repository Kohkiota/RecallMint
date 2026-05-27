# bulk flush 遅延 / event 発火異常 調査メモ

- 起票日: 2026-05-27
- 最終更新: 2026-05-27 (Phase 1 rate-then-confirm fix 完了反映、 後回し決定反映)
- 種別: investigation memo (cache-fix roadmap Step 3a / 3b)
- 関連 roadmap: `docs/cache-fix-roadmap.md` (Step 3 LocalSync MVP 前の前提整備として挿入)
- 状態: 3 問題のうち問題 1 (rate-then-confirm) 完了、 残 2 件 + region 系後回し
- 推奨 commit 先: `docs/superpowers/sessions/2026-05-27-bulk-flush-latency-investigation.md`

---

## 0. 進捗サマリ (2026-05-27 時点)

| 項目 | 状態 | commit |
|---|---|---|
| 問題 1 (rate click ごとに event 発火) | **完了** | `9b2f1e2 fix(study) [reviewed]` + spec `3e0013e` + plan `2ab6d2c` |
| 問題 1 stg smoke | **完了** (rate 連打 → 次へ 1 POST、 IDB 蓄積も期待通り) | smoke session log |
| 問題 2 (flush trigger 2 経路並走 / in-flight guard 不在) | **未着手** | - |
| 問題 3 (bulk endpoint per-event serial + region mismatch) | **未着手** | - |
| Phase 0 Vercel hnd1 固定 | **後回し決定** (OT 判断) | - |
| Phase 3 Supabase Tokyo migration | **後回し決定** (OT 判断) | - |

= region 系を後回しにした前提で、 client / server 側の logic 修正だけで何ができるかを §6 / §10 で整理。

---

## 1. 結論サマリ

stg で smart 復習を 1 セッション流したとき、 完了画面 → ダッシュボード遷移までに 10〜17 秒の遅延 + 想定外の連続 POST が観測された。 root cause を切り分けた結果、 **独立した 3 問題が重なって発生**していることが確定。 server 1 か所だけの fix では根治せず、 client 側 + server 側 + インフラ 3 層の段階修正が必要。

| 問題 | 致命度 | 層 | 状態 |
|---|---|---|---|
| 1. rate click ごとに event 発火 (rate-then-confirm 仕様違反) | 高 (データ整合性破綻) | client | 完了 |
| 2. flush trigger が 2 経路で並走発火 (in-flight guard 不在) | 中 (POST 数倍増、 体感悪化) | client | 未着手 |
| 3. bulk endpoint の per-event serial transaction + region mismatch | 高 (1 POST あたり 12-17s) | server + infra | 未着手 |

---

## 2. 観測事実 (stg、 2026-05-27)

### 2.1 ネットワーク観測

- `POST /api/review-events/bulk` の Vercel Function Execution Duration: **12-17 秒** (複数 invocation で再現)
- 1 セッション (3 問〜11 問操作) で **5〜8 連続 POST** 発火
- 全 POST status 200 (失敗ではない、 OT 確認済)
- Function region: **iad1 (Virginia)**
- Middleware region: iad1

### 2.2 DB region

- Supabase stg DB: **ap-southeast-1 (Singapore)**
- Function ↔ DB RTT 推定: ~230ms

### 2.3 操作と POST 数の不整合

- OT 操作: 3 問対象、 戻る含めて 5-8 回 rate 操作 → POST 5 件
- OT 操作: 3 問計 8 回 + 1 問 retry 計 11 回 → POST 数「微妙に合わない」 (= events 数 ≠ POST 数の物的証拠)

問題 1 fix 完了後の stg smoke では rate 連打 4 click に対し IDB 蓄積 2 件 (= 各 card 1 件、 last rating 正確に forward)、 操作と POST 数の不整合は問題 1 由来分は解消。 残不整合は問題 2 (in-flight guard 不在) 由来。

---

## 3. 問題 1: rate click ごとに event 発火 ✅ **完了**

### 3.1 修正完了内容 (Step 3b、 commit 9b2f1e2)

`app/(app)/app/study/smart/_components/session-runner.tsx`:

- `handleRateFsrs(rating)`: inline state-only 化、 Dexie write 撤去 (setLastRating + tally + submittedCardIds のみ)
- `handleNextFsrsAfterRate()`: `runSubmit(lastRating, () => goNext())` 化
- `handlePrev()`: FSRS judged + rated 分岐で `runSubmit(lastRating, () => goPrev())` 追加
- `handleRetry()` / `handleNextNormal()` / `runSubmit` 本体: 変更なし

### 3.2 確定仕様 (実装済)

**通常モード**: 回答ボタン押下 = 即 submit (現状維持)

**FSRS モード**:
- 回答ボタン押下 → phase='judged' → 選択肢確定、 rate button 有効化
- rate button click → React state 更新のみ、 Dexie write しない
- rate 連打 / 変更 → setLastRating 上書き、 Dexie write しない
- 「次へ」 / 「前へ」 押下 → `runSubmit(lastRating, onAfter)` で Dexie write 1 件 + 画面遷移
- 「リトライ」 → resetCardState のみ、 submit なし
- 「前へ」 で戻った card で再回答 → 新 rate → 次へ / 前へ で **追加 1 件 Dexie write** (上書きせず、 server 側 submit-review-tx で順次 apply、 案 B 採用)

### 3.3 stg 実機検証結果 (2026-05-27 smoke 完了)

- 1 問目 Hard → Good → Easy 3 連打 + 次へ → IDB +1 件 (rating=4 Easy)
- 2 問目 Good rate + 前へ → IDB +1 件 (rating=3 Good)、 1 問目 selecting reset
- 合計 4 click に対し IDB 蓄積 2 件 = 各 card 1 件、 last rating で forward
- 仕様通り pending として保留 (FLUSH_THRESHOLD=5 未達 / session 未完了)

= 問題 1 fix 完了、 致命バグ root cause 修正成功。

---

## 4. 問題 2: flush trigger 2 経路の並走発火 (未着手)

### 4.1 現状の flush 発火経路

`session-runner.tsx` + `lib/sync/review-events.ts`:

1. **inline flush** (`runSubmit` 内): `if (pending >= FLUSH_THRESHOLD=5) flushPendingEvents()`
2. **finished phase useEffect**: `phase==='finished'` 遷移で background fire-and-forget
3. **「ダッシュボードへ」 click handler**: `await flushPendingEvents()` (race gate)

### 4.2 並走パターン

```
[3 events 完了] → phase=finished
   → useEffect で background flush 開始 (POST #1、 16s 処理中)
   ↓ 1-2 秒後
[user click 「ダッシュボードへ」]
   → handleDashboardNav 内 await flush (POST #2)
   → POST #1 と並走、 同じ events 含む
```

server 側 ON CONFLICT DO NOTHING で重複防止されているため **データ整合性は壊れない**が、 不要な server 負荷 + 体感遅延の原因。

### 4.3 影響

- POST 数 = events 数 × flush 経路数 (理論最大)
- server SSR / DB 負荷倍増
- 「保存中…」 UI 表示の長期化

### 4.4 修正方針 (未実施、 §6.2.2 参照)

`sessionFlushLocks: Map<string, Promise<FlushResult>>` で同 sessionId の flush を排他、 useEffect / click 両 caller が同じ Promise を await、 実 POST は 1 回。

---

## 5. 問題 3: bulk endpoint server 側ロジック (未着手)

### 5.1 現状の bulk route 構造

`app/api/review-events/bulk/route.ts`:

```
POST /api/review-events/bulk:
  1. studySessions upsert (1 SQL)
  2. for (const ev of events) {              ← per-event 直列 loop
       db.transaction(async (tx) => {
         a. INSERT answer_events ON CONFLICT DO NOTHING RETURNING (1 SQL)
         b. submitReviewTx:
            i.   SELECT cards (1 SQL)
            ii.  UPDATE cards (1 SQL)
            iii. INSERT reviews (1 SQL)
            iv.  SELECT COUNT(DISTINCT card_id) FROM reviews (1 SQL、 重い候補)
            v.   UPSERT study_days (1 SQL)
       })
     }
```

**N events で 6N + 1 SQL + N transactions**。

### 5.2 region mismatch 影響 (現状、 後回し決定済)

Function (iad1) ↔ DB (sin1) RTT ~230ms。 N=5 events:

| metric | 試算 |
|---|---|
| SQL count | 31 |
| Transaction count | 5 |
| SQL RTT 単独 | 31 × 230ms = **7,130ms** |
| Transaction begin/commit overhead | 5 × 2 RTT × 230ms = **2,300ms** |
| 合計 RTT alone | **~9,400ms** |
| + DB 処理 + Vercel cold start | 16s も完全説明可能 |

### 5.3 公式 / 業界 benchmark 裏付け

- PostgreSQL multi-row INSERT は single INSERT 繰返より速い (公式 doc + pgsql-jdbc benchmark)
- Vercel Functions は Pro plan で最大 3 region 指定可能、 `preferredRegion` で `hnd1` 固定可能 (Vercel 公式) — **後回し決定**
- Supabase 既存 project の region 変更不可、 新 project + migration 必要 (Supabase 公式) — **後回し決定**

### 5.4 修正方針 (未実施、 §6.3 参照)

single transaction + bulk insert + COUNT 末尾 1 回 + same card 集約 in-memory rate。

---

## 6. 修正方針 (優先順、 後回し決定反映済)

### 6.1 Phase 0: Vercel function region 固定 **後回し決定**

OT 判断: 後回し。 region 系移行を伴う修正は今 sprint 範囲外。 logic 修正 (Phase 1 残 / Phase 2) で対応可能な範囲を優先。

### 6.2 Phase 1: client 側 fix

#### 6.2.1 rate-then-confirm ✅ **完了** (commit 9b2f1e2)

§3.1 / §3.2 参照。

#### 6.2.2 in-flight guard (未着手)

```ts
// lib/sync/review-events.ts
const sessionFlushLocks = new Map<string, Promise<FlushResult>>()

export async function flushPendingEvents(sessionId: string, client = defaultClient) {
  const existing = sessionFlushLocks.get(sessionId)
  if (existing) return existing
  
  const promise = doFlush(sessionId, client).finally(() => {
    sessionFlushLocks.delete(sessionId)
  })
  sessionFlushLocks.set(sessionId, promise)
  return promise
}
```

= **useEffect / click の両方の caller は同じ Promise を await する**。 実際の POST は 1 回だけ、 両方の caller が結果を得る。

#### 6.2.3 失敗 events TTL drop (未着手)

- 24h 超過 pending events を起動時 / 定期 cleanup で削除
- `getPendingAnswerEvents` を sessionId 必須化 + 24h filter

```ts
export async function cleanupExpiredPendingEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  return getClientDb()
    .answer_events
    .where('sync_status').equals('pending')
    .filter((e) => e.answered_at < cutoff)
    .delete()
}
```

#### 6.2.4 離脱救済 pagehide best-effort (未着手)

`session-runner.tsx` の useEffect で `pagehide` event listener 登録、 タブ閉じる / browser 戻る時に best-effort flush。

### 6.3 Phase 2: bulk route refactor (未着手)

**新 flow**:
```
1. begin transaction (1 回のみ)
2. studySessions upsert (1 SQL)
3. INSERT answer_events (multi-row VALUES) ON CONFLICT DO NOTHING RETURNING (1 SQL)
4. 重複除外、 events を card_id でグルーピング
5. SELECT cards WHERE id IN (...) AND user_id = ? (1 SQL、 関連 cards 一括)
6. for each card_id (in-memory):
     for each event (sorted by answered_at):
       rate() in-memory で順次 apply (FSRS 仕様準拠)
     最終 state 蓄積
7. UPDATE cards CASE WHEN ... (or unnest pattern) で N cards を 1 SQL に集約
8. INSERT reviews VALUES (N rows bulk) (1 SQL)
9. SELECT COUNT(DISTINCT card_id) FROM reviews WHERE user_id AND day (1 SQL、 末尾 1 回)
10. UPSERT study_days (affected days のみ、 通常 1-2 row) (1 SQL)
11. commit
```

**N=5 events で 8 SQL + 1 transaction** (現状 31 SQL + 5 transaction)。

ただし `failed[]` semantics を「per-event 部分失敗」 維持するなら 1 transaction 化と矛盾、 spec で trade-off 決定要。

### 6.4 Phase 3: Supabase Tokyo migration **後回し決定**

OT 判断: 後回し。 stg / prod それぞれで新 project + データ migration が必要なため、 別途計画が立った段階で着手。

---

## 7. 試算サマリ (region 系後回し前提)

| 段階 | Function region | DB region | RTT/SQL | SQL count (N=5 events) | 試算合計 RTT |
|---|---|---|---|---|---|
| 現状 | iad1 | sin1 | 230ms | 31 | 9,400ms |
| Phase 2 後 (refactor のみ) | iad1 | sin1 | 230ms | **8** | **2,300ms** |
| 将来 Phase 0 適用 | hnd1 | sin1 | 70ms | 8 | 740ms |
| 将来 Phase 0+3 適用 | hnd1 | Tokyo | 5ms | 8 | ~50ms |

= 後回し前提でも **Phase 2 単独で 9.4s → 2.3s (~4x 改善)** が期待できる。 region 移行を加えれば段階的に ~190x まで改善可能。

---

## 8. 残課題 / 未決事項

### 8.1 既存累積データの扱い ✅ 確定 (silent drop)

OT 確認: 既存累積データは全破棄で OK (RecallMint user 0 名)。 DB ごと削除も許容。 migration script 不要。

### 8.2 in-flight guard 実装 (Phase 1 残 §6.2.2)

未着手。 spec 起草対象。

### 8.3 失敗 events TTL (Phase 1 残 §6.2.3)

未着手。 24h drop 仕様。 LocalSync MVP roadmap と整合。

### 8.4 離脱救済 (Phase 1 残 §6.2.4)

未着手。 `pagehide` event best-effort。

### 8.5 bulk refactor `failed[]` semantics (Phase 2 §6.3)

1 transaction 化と「per-event 部分失敗」 維持が矛盾、 spec で trade-off 決定要:
- 案 a: 全件 atomic (= 1 件失敗で全件 rollback、 failed[] は廃止)
- 案 b: 失敗候補 (FK 違反等) を事前 detect して該当 event のみ除外、 残りを 1 transaction
- 案 c: per-event tx 維持、 bulk insert/update のみ抽出

### 8.6 連打 UI 抑制 (オプション、 問題 1 fix で不要に)

問題 1 fix で「連打しても 1 event」 が保証されたため、 UI 側 visual 抑制は不要。

---

## 9. 関連 file / commit

### 9.1 主要 file

| 役割 | path |
|---|---|
| event 記録 + flush threshold + finished useEffect + handleDashboardNav | `app/(app)/app/study/smart/_components/session-runner.tsx` |
| client sync helper (record / get / flush / mark) | `lib/sync/review-events.ts` |
| Dexie schema (answer_events / study_sessions) | `lib/client-db.ts` |
| Server bulk endpoint | `app/api/review-events/bulk/route.ts` |
| per-event FSRS / reviews / study_days transaction | `lib/cards/submit-review-tx.ts` |
| dashboard 遷移後の pull 発火 | `app/(app)/app/layout.tsx` + `app/(app)/app/_components/pull-trigger.tsx` |

### 9.2 関連 commit

cache-fix Step 1-2 完了済:
```
5352e5c docs(perf): spec を実態整合に更新 [no-review]
b73512b refactor(perf): /app/cards/[id] 個別 card 編集 page を廃止 [reviewed]
30b3293 fix(auth): clerk-metadata の 404 を silent skip [reviewed]
326d7a9 feat(perf): PullTrigger を /app layout に移動 [reviewed]
```

cache-fix Step 3b (rate-then-confirm) 完了:
```
9b2f1e2 fix(study): rate-then-confirm 仕様変更 [reviewed]
2ab6d2c docs(plan): rate-then-confirm implementation plan [no-review]
3e0013e docs(spec): rate-then-confirm design [no-review]
```

### 9.3 保留中 (local 保持、 deploy せず)

```
8417e83 perf(observability): bulk route + submit-review-tx に timing log を追加 (一時計測用、 deploy 後 revert 前提)
```

→ 問題 1 fix 完了で events 数が正常 size に戻ったため、 Phase 2 spec 起草前の baseline 再計測に活用可能。 必要に応じて cherry-pick。

---

## 10. 次手 (sprint planning、 region 系後回し前提)

### 10.1 即時候補

region 移行を伴わない logic 修正で実施できる task:

| 候補 | 内容 | 規模 | 効果 |
|---|---|---|---|
| **A** | Phase 2 bulk route refactor | 大 | 9.4s → 2.3s 期待、 user 体感最大改善 |
| **B** | Phase 1 残 §6.2.2 in-flight guard | 中 | POST 数 = events 数に正規化、 重複発火解消 |
| **C** | Phase 1 残 §6.2.4 離脱救済 | 小 | タブ閉じる時の events 損失防止 |
| **D** | Phase 1 残 §6.2.3 TTL drop | 小 | 過去 session 残骸防止 (現状影響小) |

### 10.2 推奨順

**B → A → C → D** を推奨:

- **B (in-flight guard)**: 小規模 + 体感整合性改善 + 独立 sprint で完結、 まず client side で OT 観察「POST 数が合わない」 を完全解消
- **A (bulk refactor)**: B 完了後の正常 size payload で baseline 再計測 → 効果見える形で refactor 着手、 `failed[]` semantics の trade-off 決定要
- **C (離脱救済)**: A 完了後の lightweight 追加
- **D (TTL drop)**: LocalSync MVP と同時に組み込むのが自然

### 10.3 LocalSync MVP との関係

cache-fix roadmap Step 3 LocalSync MVP は本調査の Phase 2 (bulk refactor) 完了後に着手予定。 card_mutations bulk push が同じ pattern で組めるよう前提整備が完了するため。

### 10.4 region 系の将来再開判断

Phase 0 / 3 (Vercel hnd1 / Supabase Tokyo migration) は logic 修正 (Phase 1 残 + Phase 2) 完了後の効果計測で再判断。 Phase 2 で 2.3s まで短縮されれば region 移行の緊急度は低下、 さらに改善したい場合に再開。
