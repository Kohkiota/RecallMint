# flush in-flight guard (cache-fix 問題 2) — design

- **作成日**: 2026-05-28
- **OT 状態**: brainstorming 完了 (論点 A-I 確定) / 確定仕様 + 確定設計 + scope 承認済
- **後続 skill**: writing-plans → executing-plans (plan は別 sprint 指示)
- **関連 roadmap**: `docs/cache-fix-roadmap.md` §4.5 (Step 3 LocalSync MVP 前の前提整備)
- **関連 doc**:
  - `docs/superpowers/sessions/2026-05-27-bulk-flush-latency-investigation.md` (= 投資 memo、 問題 2 = §4 / §6.2.2)
  - `docs/superpowers/sessions/2026-05-27-fsrs-sync-layer-survey.md` (= sync layer 俯瞰、 §1 flush 経路 / §2 sessionId)
  - `docs/superpowers/sessions/2026-05-28-cache-fix-step3a-timing-aborted.md` (= 並走の物的証拠、 §3.2)

---

## 1. 背景 / 問題

cache-fix Step 2 stg 計測で発覚した bulk flush 異常 3 問題のうち、 **問題 2 (flush trigger の並走発火、 in-flight guard 不在)** を fix する。 問題 1 (rate-then-confirm) は `9b2f1e2` で完了済。

### 観測 (実機裏取り済)

2026-05-28 stg 計測 (= timing-aborted session log §2-3) で、 1 session 完了時に `POST /api/review-events/bulk` が **同 events 5 件を含む payload で 2 件、 startTime 1ms 差で並走発火** (TTFB 17.7-17.9s) するのを実機確認した。 並走 source は:

- **経路 1**: `session-runner.tsx` `runSubmit` 内 IIFE、 `recordAnswerEvent` 後に `countPendingAnswerEvents(sessionId) >= FLUSH_THRESHOLD(=5)` で `flushPendingEvents(sessionId)` 発火 (fire-and-forget)
- **経路 2**: `phase==='finished'` useEffect、 `completeStudySession(sessionId)` 後に `flushPendingEvents(sessionId)` 発火 (fire-and-forget)
- **経路 3**: 完了画面「ダッシュボードへ」 click (`handleDashboardNav`)、 `await flushPendingEvents(sessionId)` (race gate)

5 件目 rate → 「次へ」 で 経路 1 (threshold) と 経路 2 (finished useEffect) が microtask order で並走し、 同 events を二重送信する (= 投資 memo §4.2、 当初想定の「経路 2 ↔ 経路 3」 より広く、 **全経路の任意組合せ**で起こりうる)。

### 影響

- **server 負荷倍増**: 同 events を含む POST が N 経路分発火、 per-event serial transaction (= 問題 3) の重い処理を重複起動
- **体感遅延**: 「保存中…」 状態の長期化
- **データ整合性は壊れない**: server `ON CONFLICT (event_id) DO NOTHING` + client `markAnswerEventsSynced` の `anyOf` 冪等性で重複 INSERT / 二重 sync 化は防止済 (= survey §1.3 実コード確認済)。 = 本 fix は **整合性修正ではなく効率 / 体感修正**

### 目的

flush の重複発火を **event_id ベースの in-flight guard** で排除し、 1 event = 1 in-flight POST に正規化する。 同時に体感を損ねていた経路 3 の同期 race gate を撤去し、 PWA らしい silent retry に倒す。

---

## 2. 確定仕様

### 2.1 経路 3 削除 (確定: 論点 A1 / E1)

- 完了画面「ダッシュボードへ」 click の `await flushPendingEvents` を **削除**、 click handler は即 `router.push('/app')` に簡素化
- `NavState` type ('idle' | 'flushing' | 'warning') + 関連 state (`navState` / `setNavState`) + warning UI (= 「一部の回答を後で再送します」) + 「保存中…」 label 切替 を **完全撤去**
- 失敗の user-visible 表示は撤回 = **silent retry** (= 失敗 events は Dexie pending のまま、 次 trigger で自動再送)
- 完了画面フッターは「もう一度」 + 「ダッシュボードへ」 の 2 button、 後者は単純 navigation

### 2.2 in-flight guard (確定: 論点 B1 / C1 / H)

- `lib/sync/review-events.ts` に module-level `inFlightEventIds: Set<string>` を置く (= **memory のみ、 IDB には持たない**)
- 複数 tab / crash recovery は **server idempotency (event_id UNIQUE + ON CONFLICT DO NOTHING) が安全網**、 過剰な堅牢化はしない (= tab close で finally 不到達 → Set 残留しても、 次 tab は fresh module load で Set 初期化、 再送は server 冪等で安全)
- `flushPendingEvents` 内部で in-flight 除外 + Set add / **finally remove** を一元化
- 重複排除の適用範囲: **経路 1 同士 / 経路 2 同士 / 経路 1-2 並走、 全パターン**
- タイムアウト保険不要 (= Vercel function 30s abort で client fetch promise が resolve/reject、 finally 到達保証)

### 2.3 各経路の取得条件 (in-flight 除外は共通、 確定: 論点 C1 / D)

| 経路 | pending 取得範囲 | in-flight 除外 | POST 発火 |
|---|---|---|---|
| 経路 1 (threshold) | 当該 session のみ (= 現状維持 `getPendingAnswerEvents(sessionId)`) | あり | 当該 session 1 POST |
| 経路 2 (finished useEffect) | **全 session** (= `getAllPendingAnswerEvents()` 新規) | あり | session_id ごとに **N POST 並列** (`Promise.allSettled`) |

- event_id ベースの除外なので、 経路 2 が全件取得しても経路 1 と **重複しない** (= 経路 1 が掴んだ event_id は inFlightEventIds に在るため経路 2 は除外)
- 経路 2 の「全 session」 は、 完了 session 本体 + 過去 session の未送信残骸 (= 前回 session の失敗 pending 等) を完了時に一括 sweep する意図

### 2.4 in-flight 除外後 events 0 件の扱い (設計判断、 spec で明示)

flushPendingEvents(sessionId) で in-flight 除外後に events が 0 件になった場合 (= 同 session を別経路が既に掴んでいる):

- **当該 flush は POST せず early return** (= 無駄 POST 削減)
- session status (completed 等) は、 当該 events を掴んだ **他経路の flush が同 session の getStudySession で payload に乗せて送る** ため、 status 取りこぼしは起きない
- 例外: 「events 0 件かつ session 状態を誰も送っていない」 ケース (= events 全部 synced 済で session status だけ pending) は現状の「events 0 件でも session flush」 挙動を維持する。 = **in-flight 除外で 0 件になった場合のみ skip、 元々 0 件 (= 純粋な session-only flush) は従来通り POST**

→ 判定: `元 pending > 0 かつ in-flight 除外後 0 件` のときだけ skip。 それ以外 (元から 0 件) は従来通り。

### 2.5 helper 仕様 (確定: 論点 C1)

- `getPendingAnswerEvents(sessionId?)`: **既存 signature 維持** (sessionId optional)。 変更なし
- `getAllPendingAnswerEvents()`: **新規追加**。 全 session の `sync_status='pending'` events を返す (= `getPendingAnswerEvents(undefined)` と等価だが、 呼出意図を明示する named helper)
  - 実装は `getPendingAnswerEvents()` への薄い委譲で良い (= 意味的別名)。 もしくは経路 2 で `getPendingAnswerEvents()` を直接呼び session_id で group 化する設計でも可。 plan で実装粒度を決める
- `flushPendingEvents(sessionId, client?)`: in-flight guard を内部追加。 signature は維持

### 2.6 FlushResult 戻り値仕様 (確定: 論点 H)

- 経路 3 削除で `FlushResult` を読む production caller は消える (= 経路 1 / 経路 2 とも fire-and-forget で戻り値を使わない)。 残る consumer は test のみ
- `attempted` の意味論: **in-flight 除外後の実送信対象数** とする (= 「実際に POST に乗せた events 数」)。 既存 test の attempted 期待値は調整
- `skippedEventIds` 等の新 field は **追加しない** (= YAGNI、 caller が消えるため区別需要なし)

---

## 3. 実装方針 (経路別、 コードは plan / generator が TDD で書く)

### 3.1 `lib/sync/review-events.ts`

- module スコープに `const inFlightEventIds = new Set<string>()`
- `flushPendingEvents(sessionId, client)` 内部フロー:
  1. `session = getStudySession(sessionId)` (= 現状維持、 不在なら no-op return)
  2. `pendingAll = getPendingAnswerEvents(sessionId)`
  3. `targets = pendingAll.filter(e => !inFlightEventIds.has(e.event_id))`
  4. `if (pendingAll.length > 0 && targets.length === 0) return <skip 用 FlushResult>` (= §2.4)
  5. `targets.forEach(e => inFlightEventIds.add(e.event_id))`
  6. `try { POST (payload は targets) → markAnswerEventsSynced 等 } finally { targets.forEach(e => inFlightEventIds.delete(e.event_id)) }`
- `getAllPendingAnswerEvents()` 新規 (= §2.5)
- 経路 2 用の group flush helper (= 全 session pending を session_id で group 化し、 各 session に `flushPendingEvents` を `Promise.allSettled` で並列発火) を新規追加。 命名 / 配置は plan で確定 (例: `flushAllPendingEvents()`)

### 3.2 `session-runner.tsx`

- 経路 1 (`runSubmit` 内 IIFE): **変更なし** (= 当該 session flush + in-flight guard は flushPendingEvents 内部に吸収されるため caller 側は touch 不要)
- 経路 2 (`phase==='finished'` useEffect): `flushPendingEvents(sessionId)` → **全 session group flush helper** に差し替え (= §3.1 の `flushAllPendingEvents()` 等)。 `completeStudySession(sessionId)` は維持 (= 完了 status を Dexie に書いてから group flush)
- 経路 3 (`handleDashboardNav`): **削除**。 完了画面 button は `onClick={() => router.push('/app')}` に簡素化、 `NavState` 関連を全撤去

### 3.3 `app/api/review-events/bulk/route.ts` / `lib/cards/submit-review-tx.ts`

- **本 sprint では touch しない** (= 問題 3 scope)。 ただし F1 / F3 test 追加の対象 (= 既存ロジックの順序保証を test で固定するのみ、 実装変更なし)

---

## 4. テスト方針 (確定: 論点 F1+F2+F3 / G / I)

### 4.1 in-flight guard 単体 (`lib/sync/review-events.test.ts`)

- 同 session に対し `flushPendingEvents` を **2 回連続 invoke** (= 1 回目の POST resolve 前に 2 回目)、 2 回目は in-flight 除外で events 0 → skip、 POST は 1 回のみ
- **別 session 並走**: session A / B を同時 flush、 互いに独立に POST (= 別 event_id で除外干渉なし)
- **失敗時 finally remove**: POST が reject (network fail) しても inFlightEventIds から remove される (= 次 invoke で再 pickup 可能)
- **部分 in-flight**: events [1..5] のうち [1..3] が in-flight、 [4..5] のみ送信
- `getAllPendingAnswerEvents` の全 session 取得 + group flush (= session_id ごとに正しく分配されて N POST)

### 4.2 戻り順整合 (F2、 `lib/sync/review-events.test.ts`)

- `getPendingAnswerEvents` の戻り順が **local_id 昇順 = answered_at 昇順** で一貫する (= Dexie `++local_id` auto-increment 順と answered_at 順の整合)。 = 同 card 複数 events の apply 順序の前提を固定

### 4.3 同 card 順次 apply (F1、 `lib/cards/submit-review-tx.test.ts`)

- 同 card に N events (例: Hard → Good → Easy) を **順次 `submitReviewTx` direct call**、 結果 FSRS state を **invariant check** で assert:
  - `due` は呼出ごとに将来方向へ進む (= 単調増加 or 各 apply で更新)
  - `reps` は events 数分 increment
  - `currentStreak` は correct (rating>=2) 連続で increment、 incorrect (rating=1) で 0 reset
- **ts-fsrs version up 耐性のため、 rate() の具体的戻り値を hard-coded で assert しない** (= invariant のみ)。 既存 submit-review-tx.test.ts は rate() mock 済だが、 本 test は実 lib での invariant 確認を志向 (mock するか実 lib かは plan で確定、 invariant assert を主軸にする方針は固定)

### 4.4 per-event tx loop の順序 (F3、 `app/api/review-events/bulk/route.test.ts`)

- bulk route の per-event tx loop が **payload の events 配列順で `submitReviewTx` を呼ぶ** (= 同 card 複数 events が payload 順 = answered_at 順で apply される) ことを mock 検証

### 4.5 既存テスト破壊範囲 (確定: 論点 G)

- **破壊 (反転 / 削除)**: `session-runner.test.tsx` の S-cache-3.1 describe (= 完了画面 flush gating、 3 件) → 「click で即 router.push、 flush を await しない」 に反転。 NavState 関連 component assertion を削除
- **既存維持**: `flushPendingEvents` の全件成功 / 一部失敗 / network fail / 500 / events 0 件 / rating 含有 / session 不在 (17 it 中、 attempted 期待値の調整のみ)
- **新規見積もり**: in-flight guard 5-7 件 + 全 session group flush 2-3 件 + F1/F2/F3 各 1-2 件 = **計 ~10-15 件**

---

## 5. スコープ外 (問題 3 sprint に持ち込み、 本 sprint では触らない)

- bulk API schema 拡張 (= 複数 session を 1 POST に集約)
- bulk refactor (= SQL 6N+1 削減、 single tx 化、 failed[] semantics trade-off)
- client Dexie の outbox リネーム検討
- TTL drop (= synced + 7日超を起動時 1 回 IDB query で削除、 client + IDB 完結)
- Step 3a Server-Timing 計測の復旧 (= 別 sprint、 timing-aborted session log §4 参照)

---

## 6. 影響範囲 / 破壊範囲サマリ

| file | 変更種別 | 内容 |
|---|---|---|
| `lib/sync/review-events.ts` | 機能追加 | inFlightEventIds Set + flushPendingEvents 内部 guard + getAllPendingAnswerEvents + group flush helper |
| `app/(app)/app/study/smart/_components/session-runner.tsx` | 機能変更 | 経路 2 を group flush に差し替え / 経路 3 (NavState + handleDashboardNav) 完全撤去 |
| `lib/sync/review-events.test.ts` | test 追加 + 調整 | in-flight guard / group flush / 戻り順 test 追加、 attempted 期待値調整 |
| `app/(app)/app/study/smart/_components/session-runner.test.tsx` | test 反転 + 削除 | S-cache-3.1 flush gating 反転、 NavState assertion 削除 |
| `lib/cards/submit-review-tx.test.ts` | test 追加 | F1 同 card 順次 apply invariant |
| `app/api/review-events/bulk/route.test.ts` | test 追加 | F3 per-event tx loop 順序 |

- **touch しない**: `app/api/review-events/bulk/route.ts` 本体 / `lib/cards/submit-review-tx.ts` 本体 / `lib/client-db.ts` schema / pull 系

---

## 7. 完了条件

- in-flight guard で経路 1 / 2 並走時に同 event_id を含む POST が 1 回に正規化される (= test で証明)
- 経路 3 削除、 完了画面 click は即 navigation (= NavState 撤去)
- F1 / F2 / F3 test 追加、 invariant check で ts-fsrs version 耐性
- 全 test pass + typecheck clean
- `requesting-code-review` skill canonical 経路 (= feat(study) or fix(study) commit、 general-purpose subagent、 template 改変なし) で Critical 0
- 裏取り category (決済 / 認証 / 削除 / 外部副作用) 該当なし → review pass で [reviewed] 付与可
- [reviewed] tag 付与

---

## 8. 確定論点 (brainstorming step 3、 claude.ai 確定済)

| 論点 | 確定 |
|---|---|
| A (経路 3 UX) | A1 = NavState 完全削除、 silent retry |
| B (Set 生存範囲) | B1 = 受け入れる、 server 冪等が安全網、 過剰堅牢化なし |
| C (全 session payload 化) | C1 = session_id ごと N POST 並列 (Promise.allSettled)、 event_id ベース除外 |
| D (経路 2 発火範囲) | 全 session pending を group flush |
| E (state/lib 撤去範囲) | E1 = NavState 完全撤去 + 既存 test 反転 |
| F (順序保証 test) | F1 + F2 + F3 すべて採用 |
| G (test 破壊範囲) | 破壊 ~3 件 / 新規 ~10-15 件 で妥当 |
| H (FlushResult 仕様) | attempted = 除外後実送信数、 新 field 追加なし (YAGNI) |
| I (ABA 期待値) | I1 = invariant check、 hard-coded 回避 |
