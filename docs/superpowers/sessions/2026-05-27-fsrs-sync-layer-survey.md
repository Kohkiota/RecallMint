# FSRS smart 復習 sync layer 俯瞰調査

- 起票日: 2026-05-27
- 種別: investigation memo / survey (実装着手なし)
- 対象 commit: `aea5e9c` (= 直前 commit、 問題 1 fix + 投資調査 memo commit 直後の状態)
- 関連 doc:
  - `docs/superpowers/sessions/2026-05-27-bulk-flush-latency-investigation.md` (= 投資調査 memo、 以下「投資 memo」)
  - `docs/cache-fix-roadmap.md` §4.5 Step 3a / 3b
  - `docs/superpowers/sessions/2026-05-27-rate-then-confirm.md` (= 問題 1 closure log)
- 表記: 「実コード確認済」 / 「未確認」 / 「仮説」 を明示。 投資 memo 引用は「memo §x.y」 と記す

---

## 0. survey の目的

問題 2 (flush trigger 2 経路並走) / 問題 3 (bulk per-event serial) 着手前に、 FSRS smart 復習の sync layer (client → server → dashboard 反映まで) 全体を実コードで再確認し、 投資 memo §4-6 のコード sketch / 経路列挙が現コード基準で確定情報なのか仮説なのかを判別する。 修正案は決めない。

---

## 1. flush 発火経路の悉皆 (scope 1)

### 1.1 実コード grep 結果 (`flushPendingEvents` 呼出、 非 test)

| # | caller | 発火条件 | 同期形態 | reject 処理 |
|---|---|---|---|---|
| A | `session-runner.tsx:300` (`runSubmit` 内 IIFE) | `recordAnswerEvent` 後 `countPendingAnswerEvents(sessionId) >= FLUSH_THRESHOLD(=5)` | `void (async () => { ... try { await ... } catch {} })()` (= fire-and-forget、 内部で await) | `catch {}` で silent (= 次 trigger で再試行) |
| B | `session-runner.tsx:328` (`phase==='finished'` useEffect) | `phase` が `'finished'` に変わった瞬間 | `void (async () => { try { await completeStudySession; } catch {}; try { await flushPendingEvents; } catch {} })()` | `catch {}` で silent |
| C | `session-runner.tsx:394` (`handleDashboardNav` click handler) | 完了画面「ダッシュボードへ」 click、 ただし `navState==='warning'` のときは flush 呼ばず即 `router.push('/app')` | `await flushPendingEvents(sessionId)` (= caller を実際に待たせる race gate) | `try/catch` で `navState='warning'` (silent な fall-back UI) |

= **3 経路の存在は実コード確認済** (= 投資 memo §4.1 と完全一致)。

### 1.2 in-flight guard 不在の確認

- `lib/sync/review-events.ts` 全文確認: `Map` / `WeakMap` / sessionFlushLocks / Promise キャッシュは **無し** (実コード確認済)
- `flushPendingEvents` 内部は `getStudySession → getPendingAnswerEvents → client.post → markAnswerEventsSynced → markStudySessionSyncStatus` の純線形 (実コード確認済)
- `client.post` (= default `fetch`) は呼出側で重複検出しない (実コード確認済)
- = 投資 memo §4.2「同 events を含む POST が並走しうる」 の前提は実コード一致 (確認済)

### 1.3 並走パターンの再現性 (scope 7 一部)

memo §4.2「finished useEffect の background flush 開始 → 1-2 秒後に user click → click handler が新たな await flush を発火 → 同 events を含む POST が並走」 は実コード上 **発生可能** (確認済、 ただし stg 実機での観察ログは repo 内に未存在 = 観測としては「再現可能と推論される」 段階で、 物的証拠は memo §2.1 にしかない)。

ON CONFLICT DO NOTHING + `markAnswerEventsSynced` の `anyOf` 冪等性で「データ整合性は崩れない」 主張も実コード確認済 (route.ts:207 `onConflictDoNothing` / review-events.ts:154-159 `where('event_id').anyOf(...).modify(...)`)。

---

## 2. sessionId 管理実態 (scope 2)

### 2.1 生成 / 持ち回し (実コード確認済)

```
study-session-host.tsx (client)
  useEffect mount once (deps=[]):
    1. Dexie / server から cards 確定
    2. const id = newId()          ← crypto.randomUUID()
    3. createStudySession({session_id: id, ...})  ← Dexie write
    4. setResolvedCards(chosen); setSessionId(id)
    5. <SessionRunner sessionId={id} ...>

session-runner.tsx
  props.sessionId は mount 中 stable (= host が再 setState しない限り)
  runSubmit / useEffect / handleDashboardNav の 3 経路すべて
  同じ props.sessionId を flushPendingEvents に渡す
```

### 2.2 Map key としての安定性 (仮説検証)

- props.sessionId は SessionRunner mount 中 **stable** (確認済、 host useEffect は `[]` で 1 回しか走らない + cancelled flag で StrictMode 2 回目を弾く)
- ただし StrictMode dev 環境では host useEffect 2 回 mount → 2 回目 `newId()` を作って Dexie に追加で createStudySession → cancelled で setSessionId 抑制、 という挙動 (実コード読み: L57-90)。 結果として「Dexie に同一 user の 2 session 行」 が dev で残る可能性があるが、 SessionRunner に渡る `sessionId` は 1 つだけ (= cancelled 前に setState 済 or 後の setState は捨てられる)
- 仮説: **`sessionFlushLocks: Map<sessionId, Promise>` の key として OK**。 SessionRunner mount 内では sessionId 不変、 異 session = 別 key、 process 越え (= mount 越し) で Map をまたぐ必要は無い (= 「同一 process 内で並走する flush」 のみ抑止すれば足りる)
- 補足: Map は module-level (= file-scoped singleton) で持つことになるが、 SPA 内で長寿命の Promise が残ると memory leak になりうる → memo §6.2.2 `.finally(() => map.delete(...))` で解消方針 (確認済)

### 2.3 sessionId に絡む補助関係

- Dexie `study_sessions` PK = `session_id` (`client-db.ts:194`)
- server `studySessions` upsert key も `session_id` (`route.ts:158`)
- `answerEvents` 側は `event_id` UNIQUE + `session_id` FK (確認済、 route.ts:198-204)
- = sessionId を中心に client/server 両側で一意性が担保されている (確認済)

---

## 3. bulk route の SQL 構造 + transaction 境界 + failed[] semantics (scope 3)

### 3.1 SQL 構造 (実コード確認済)

`app/api/review-events/bulk/route.ts` を実コード読みで再展開:

```
POST /api/review-events/bulk:
  1. auth: getCurrentUser() → 401 / user_not_synced 401 分岐
  2. zod parse (payload max 1000 events)
  3. measure() helper で per-op timing 計測 (= 一時計測 commit 8417e83 由来、 §9 参照)
  4. session-upsert:
       db.insert(studySessions).values(...).onConflictDoUpdate({
         target: sessionId,
         setWhere: eq(studySessions.userId, user.id),  ← C-1 tenant 分離
         set: { completedAt, status },                 ← card_ids は initial insert のみ (I-1)
       })
       throw 時は 500 session_upsert_failed で early return
  5. for (ev of events):  ← per-event serial loop (= 投資 memo §5.1 確認済)
       try {
         await db.transaction(async (tx) => {       ← per-event tx
           a. tx.insert(answerEvents).values(...).onConflictDoNothing({target: eventId}).returning({id})
           b. if (inserted.length === 0) return;    ← 重複 event_id は FSRS skip
           c. const rating = ev.rating ?? (ev.is_correct ? 3 : 1)
           d. await submitReviewTx(tx, {userId, cardId, rating, now}, timings, `event-${i}`)
         })
       } catch (err) {
         failed.push(ev.event_id)                    ← per-event failure isolation
       }
  6. return 200 { ok: true, failed } + Server-Timing header
```

### 3.2 transaction 境界 (実コード確認済)

- **N events で N 個の独立 transaction**。 session upsert は transaction の外 (= 別 SQL、 失敗時のみ早期 return)
- 1 transaction 内の SQL: `answerEvents INSERT` 1 + `submitReviewTx` 5 (`SELECT cards / UPDATE cards / INSERT reviews / SELECT COUNT(DISTINCT) / UPSERT studyDays`) = **6 SQL / tx**
- 全体: `session-upsert (1) + N × tx-begin/commit + 6N SQL` = **6N + 1 SQL + N tx**
- 投資 memo §5.1 の「6N + 1 SQL + N transactions」 と完全一致 (確認済)

### 3.3 failed[] semantics 実態 (実コード確認済)

- 「per-event tx 失敗で他 event を巻き込まない」 = 実装通り (L224-235 catch で failed.push、 loop は次 event に進む)
- 「重複 event_id」 (= ON CONFLICT で 0 行返り) は **failed[] に積まれない** (`return` で tx 内 early return、 catch には入らない) → 200 success 扱い (= client 側で `markAnswerEventsSynced` の対象に入る = 再送冪等)
- 「server 受領済の event は再送で重複 sync 化されない」 と「server 失敗した event は failed[] で client 側 pending 維持」 が明確に分離されている (確認済)
- = 投資 memo §8.5「1 transaction 化と per-event 部分失敗維持が矛盾」 の指摘は実コード一致 (1 tx 化すると 1 件失敗で全 N 件 rollback、 failed[] semantics 廃止が必要)

---

## 4. submit-review-tx の per-event 処理 + 同 card 連続 events 取扱い (scope 4)

### 4.1 per-event 処理 (実コード確認済)

`lib/cards/submit-review-tx.ts`:

```
(1) SELECT cards WHERE id = cardId AND userId = userId LIMIT 1
    rows.length === 0 → throw 'card not found'
(2) DB row → ts-fsrs Card 型に手で変換 → rate(fsrsCard, rating, now) → next
(3) UPDATE cards SET (due/stability/difficulty/elapsedDays/scheduledDays/
       learningSteps/reps/lapses/state/lastReview/answered/lastCorrect/
       currentStreak: correct ? card.currentStreak + 1 : 0)
       WHERE id AND userId
(4) INSERT reviews (userId, cardId, rating, reviewedAt: now) ← append-only
(5) SELECT COUNT(DISTINCT card_id) FROM reviews
       WHERE user_id = userId AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date = day
(6) INSERT studyDays (...) ON CONFLICT DO UPDATE {
       reviewCount: ${reviewCount} + 1,
       correctCount: ${correctCount} + ${correct ? 1 : 0},
       distinctCardCount: <(5) の値>      ← 上書き
    }
```

= 5 SQL / call (投資 memo §5.1 と完全一致)。

### 4.2 同 card 連続 events の扱い (実コード読みからの推論)

問題 1 fix 完了後は「1 card = 1 event / 1 session」 が基本だが、 「前へ戻り後の再回答」 で **同 card に追加 event** が発生しうる (投資 memo §3.2 step 7 / closure log §3 案 B 採用)。 この場合 bulk 内に 同 card_id の event が複数並ぶ。

- 同 bulk 内 events[i] と events[j] (同 card_id、 i < j) は **別 transaction で順次 apply** (per-event serial loop)
- events[i] tx 内: SELECT cards で「event[i] 適用前」 の card 行を取り、 rate() で next 計算 → UPDATE cards → reviews INSERT
- events[j] tx 内: SELECT cards で「event[i] 適用後」 の card 行を取り、 rate() で next 計算 → UPDATE cards → reviews INSERT
- = FSRS の順次適用が成立 (実コード上はそう動く、 ただし stg / unit test で「同 card_id × 2 events を 1 payload に乗せて apply 順序を verify」 する test は **未確認 = repo 内に存在しない**、 §8 参照)
- bulk endpoint 内の `events.entries()` は payload の配列順 (= client recordAnswerEvent 順 = answered_at 昇順、 仮説: Dexie `++local_id` の auto-increment 順) を保つ。 ただし payload を作る `flushPendingEvents` 内の `events.map(...)` は `getPendingAnswerEvents` 戻り値順 (= `.where('sync_status').equals('pending').toArray()` の Dexie 内部順、 **明示 sort なし** = 実コード確認済) → 「local_id 昇順 ≒ answered_at 昇順」 は **strict には未保証** (仮説)

= **同 card 複数 events の順序保証 = 仮説段階 / test 未整備**。 LocalSync MVP / 問題 3 refactor 着手前に確定したい論点。

### 4.3 1 transaction 化 (問題 3 refactor) との影響

memo §6.3 で示される「INSERT answer_events bulk → events を card_id でグルーピング → SELECT cards IN (...) → in-memory で順次 rate() apply → UPDATE cards CASE WHEN / UNNEST → INSERT reviews bulk → study_days 再集計」 という refactor は、 同 card 複数 events の順序保証を **in-memory ループ内で明示的に sorted by answered_at** で取れば実現できる (仮説、 ただし sort key 確定 / Dexie 側 read order 担保とセットで spec 化が必要、 §11 論点)。

---

## 5. dashboard 遷移後の pull / 表示更新タイミング (scope 5)

### 5.1 pull 経路 (実コード確認済)

`app/(app)/app/layout.tsx`: server component で `<PullTrigger />` を全 (app) 配下に共通配置 (commit 326d7a9 で page → layout に移動済)。

`app/(app)/app/_components/pull-trigger.tsx`:
```ts
useEffect(() => {
  void pullAllCards().catch(...)
  void pullAllExams().catch(...)
  void pullAllStudyDays().catch(...)
}, [])
```

- mount 1 回、 失敗 silent (確認済)
- internal nav (= layout 維持) で re-fire **しない** (stg smoke で確認済、 session log 2026-05-27-cache-fix-step2-stg-smoke.md §B-2)
- deep link / reload / BFCache 復元で **再 fire される** (smoke 同 §B-3)

### 5.2 ダッシュボード「ダッシュボードへ」 → pull → 表示更新の timing

実コード読みからの再現:

```
[完了画面で「ダッシュボードへ」 click]
  handleDashboardNav (session-runner.tsx:387)
    1. setNavState('flushing')
    2. await flushPendingEvents(sessionId)   ← race gate (12-17s かかる可能性、 memo §2.1)
    3. result.reachable && failed.length===0 → router.push('/app')
       else → setNavState('warning')

[router.push('/app') → SmartReview SessionRunner unmount → /app layout mount]
  layout.tsx server-side: getCurrentUser → 認証 OK なら render
  PullTrigger mount → useEffect 1 回:
    pullAllCards / pullAllExams / pullAllStudyDays   ← background, silent
  AppHeader / dashboard children (= /app/page.tsx) render
```

= 「dashboard が pull を待たずに先に render され、 後から study_days mirror が更新されると dashboard 上の数字が遅延更新される」 ことが起こり得る (仮説、 ただし dashboard side の Dexie 読み戻し / re-render hook は未確認、 §11 論点)。

### 5.3 整合性に関わる点 (仮説 + 実コード ヒント)

- 完了画面の flush が **server reviews / cards / study_days を更新** → dashboard 遷移後の `pullAllStudyDays` が **更新後の値** を Dexie に書く → dashboard 上の streak / todayCount 表示が反映される、 という流れが「整合的 happy path」
- ただし上記は `flushPendingEvents` 成功が事前条件。 失敗 (warning UI で押し抜けた場合) では server 側は古いまま、 pull も古い値を返し、 dashboard 表示も古い → 次 flush trigger まで遅延 (仮説、 stg 実機未検証)
- C-3 観測: cache-fix-step2-stg-smoke の C-1 で「今日の学習問題数 4 / 連続日数 1 日」 が表示されている = dashboard 側で study_days mirror を読んでいる証拠 (確認済、 source ファイル特定は本 survey scope 外)

---

## 6. 投資 memo §4 / §5 / §6 と実コードの乖離点 (scope 6)

| memo 箇所 | 実コード照合 | 乖離 |
|---|---|---|
| §4.1 flush 3 経路 (inline / finished useEffect / dashboard click) | 完全一致 (§1.1) | 無 |
| §4.2 並走パターン (background flush + click 並走) | 実コード上発生可能 (§1.3) | 無 (ただし stg 観察ログは memo §2.1 のみ、 §1.3 注記) |
| §4.4 修正方針 `sessionFlushLocks: Map<sessionId, Promise>` | 実装は未存在 = 提案として整合 | 提案段階 (未着手) |
| §5.1 bulk route SQL 構造 (6N + 1 SQL, N tx) | 完全一致 (§3.1-3.2) | 無 |
| §5.2 region mismatch 試算 (iad1 / sin1 / 230ms / 9400ms) | 実コード関知外 (= infra 観察値)、 RTT/SQL counts の理屈は §3.2 と整合 | 数値は memo §2.1 観察 + 公式 doc 由来、 repo 内一次資料に **stg 実機 Server-Timing ログは未存在** (§9.2 参照) |
| §5.4 修正方針 (single tx + bulk insert + COUNT 末尾 1 回 + same card 集約) | 提案段階、 §4.3 で論点提示 | 提案段階 |
| §6.2.1 rate-then-confirm | commit `9b2f1e2` で実装済、 §3 完了部分 | 一致 (実装済) |
| §6.2.2 in-flight guard | 未着手、 module-level `Map<string, Promise<FlushResult>>` 提案 | 提案段階 |
| §6.2.3 失敗 events TTL drop | 未着手、 `getPendingAnswerEvents` 24h filter + sessionId 必須化提案 | 提案段階。 ただし**現実装の `getPendingAnswerEvents` は sessionId optional** (実コード `lib/sync/review-events.ts:135-145` 確認済) — memo §6.2.3 の「sessionId 必須化」 は signature 変更を含む (= 影響範囲: review-events.test.ts の 1-2 test、 session-runner.tsx の 1 caller、 §11 論点) |
| §6.2.4 離脱救済 (pagehide best-effort) | 未着手 | 提案段階 |
| §6.3 bulk refactor | 未着手、 §4.3 / §11 で論点 | 提案段階 |

= **memo の経路列挙 / SQL 構造 / 提案方針は実コード基準で破綻なし**。 stg 観察値 (Function duration / region) は repo 内に一次資料が memo §2.1 以外存在しない (§9 参照)。

---

## 7. §2 観測事実の現コード再現性 + 一次資料 (scope 7)

### 7.1 memo §2.1 観測項目と repo 一次資料の対応

| memo §2.1 観測 | 値 | repo 内一次資料 |
|---|---|---|
| `POST /api/review-events/bulk` Function Duration | 12-17s / 5-8 連続 POST | **無し** (memo 内記述のみ、 stg Vercel dashboard / Network 観察由来と推定) |
| Function region iad1 / Middleware region iad1 | iad1 | **無し** (Vercel project settings 由来、 repo 内には次の Step 3a 計測 commit 8417e83 が timing log を仕込んでいる段階) |
| Supabase stg DB region ap-southeast-1 | sin1 | **無し** (Supabase project settings 由来) |
| operation 数 ≠ POST 数 (5-8 click → 5 POST / 8 click + 1 retry → 微妙に合わない) | client 観察 | **無し** |
| problem 1 fix 後の smoke (4 click → IDB 2 件) | rate-then-confirm closure log §5 を引用 | `2026-05-27-rate-then-confirm.md` §5 + `follow-up §7 #3` (= stg smoke 自体は **未着手**)。 = closure log 内の「stg smoke」 表記は問題 1 fix の **unit test 全 822 pass** を指しており、 stg 実機の smoke は OT/claude.ai 担当の **follow-up 未着手項目** (= memo §2 数値の物的根拠としては不十分) |

### 7.2 cache-fix-roadmap §4.5 引用値

- TTFB **10,733ms** (body 1ms) が cache-fix-roadmap §4.5 Step 3a 「観測」 行に明記 (確認済)
- これが memo §2.1「12-17s」 の出処の一つ (cache-fix-roadmap も memo 自体も「session log 計測予定」 と書いており、 stg Server-Timing 取得は未着手)

### 7.3 結論

- memo §2.1 観測事実は **stg 実機で OT が一度観測した値が memo 経由で repo に入ったもの**、 物的なログ (Playwright network log / Server-Timing header dump / Vercel dashboard screenshot) は repo 内に **未配置**
- 再現性の確認には Step 3a の Server-Timing 取得 (timing log commit 8417e83 を stg で発火させて値を取る) が前提 (= cache-fix-roadmap §4.5「未実施」 項目)
- = 観測値そのものは「一次資料未確認、 memo 起票者 (claude.ai 経由 OT) の直接観察に依拠」 と扱うのが正確

---

## 8. 既存テスト状況 (scope 8)

### 8.1 sync layer test 一覧 (実コード grep 確認済)

| file | LOC | test 数 | 主な被覆 |
|---|---:|---:|---|
| `lib/sync/review-events.test.ts` | 380 | 17 it | newId / createStudySession / completeStudySession / recordAnswerEvent / getPendingAnswerEvents / countPendingAnswerEvents / flushPendingEvents (全件成功 / 一部失敗 / network fail / 500 / 0 件 / rating 含有 / session 不在) |
| `app/api/review-events/bulk/route.test.ts` | 480 | 16 it | auth 401 × 2 / invalid JSON / zod / 正常 系 / is_correct false / rating 明示 (2/4) / rating 範囲外 / 重複 event_id / 一部 FSRS 失敗 / session upsert throw / 1001 件超 / 空 events / completed_at upsert / C-1 tenant 分離 |
| `lib/cards/submit-review-tx.test.ts` | 281 | 5 it | rating=3 正常 / rating=1 streak=0 / distinct_card_count 上書き / card 不在 throw / now 反映 |
| `app/(app)/app/study/smart/_components/session-runner.test.tsx` | 1600 | 大量 (`describe` 6 + 多数 `it`、 rate-then-confirm 専用 describe あり) | 通常 / FSRS 両モードの UI / rate-then-confirm 連打 → 1 件 / 「前へ」 submit / 戻り再 rate / リトライ guard / 完了画面 flush gating |
| `app/(app)/app/study/smart/_components/study-session-host.test.tsx` | 248 | 7 it | Dexie ≧ 1 / Dexie 0 + server cards / Dexie throw silent / userId/sessionLimit forward / Dexie+server 両 0 = empty UI |
| `app/(app)/app/_components/pull-trigger.test.tsx` | 68 | 3 it | mount で 3 helper 各 1 回 / UI null / 1 helper reject でも他は呼ばれる |
| **合計 sync 関連** | **3057** | **約 50 件** | — |

### 8.2 不足箇所 (未確認 / 仮説)

- 問題 2 並走 flush の test (= memo §4.2 シナリオ) は **未存在** (確認済: review-events.test.ts に `Promise.all([flushPendingEvents, flushPendingEvents])` 系 test 無し)
- 同 card 複数 events の **適用順序** verify test (= §4.2 論点) も bulk route.test.ts / submit-review-tx.test.ts いずれにも **未存在** (確認済 grep)
- `getPendingAnswerEvents` の **戻り値順序** に依存する callers (`flushPendingEvents` の payload 配列順) を ordering 観点で verify する test も **未存在** (確認済)
- pageshow / pagehide / visibilitychange / online 等の event 駆動 flush trigger は **未実装 + 未テスト** (memo §6.2.4)
- TTL drop の test も **未実装 + 未テスト** (memo §6.2.3)

= 既存 test は flushPendingEvents の単独 invoke / per-event 失敗 / payload 形 / route の auth・冪等性は厚いが、 **同時 invoke / 順序保証 / TTL / pagehide は完全に未テスト**。

---

## 9. 一時計測 commit `8417e83` の内容 (scope 9)

### 9.1 git show 結果 (実コード確認済)

- title: `chore(perf): bulk endpoint 一時 timing log (TEMP-MEASURE) [no-review]`
- 修正範囲: `app/api/review-events/bulk/route.ts` (+42 / -... 計 42 行追加) + `lib/cards/submit-review-tx.ts` (+35 / 計 35 行追加)
- 内容:
  - bulk route.ts: `measure()` helper + per-phase wrap (`session-upsert` / `event-${i}-tx` / `event-${i}-insert` / `event-${i}-submitTx`) + `Server-Timing` response header 出力
  - submit-review-tx.ts: optional `timingsOut` / `timingsPrefix` 引数追加、 5 個の sub-op (`select-cards` / `update-cards` / `insert-reviews` / `select-distinct` / `upsert-study-days`) を timing wrap
- 機能変更: ゼロ (commit message 主張、 全 test 818 pass 表記、 実コード読み確認済 = 計測 side-effect のみ)
- 既存 caller の signature 互換性: `submit-review.ts` 経由の `submitReviewTx({...})` は 2nd/3rd 引数が optional なので無影響 (実コード確認済、 ただし `submitReview` server action 自体は cache-fix Step 1 で bulk API 経路に置換済でコメントアウト残のため実害ほぼ無、 §session-runner.tsx:61-62)

### 9.2 deploy 状況 (cache-fix-roadmap §4.5 + 投資 memo §9.3 確認済)

- `origin/develop` = `8417e83` 反映済 (Vercel stg auto deploy 反映済)
- production: 絶対 deploy しない方針 (= revert commit 立ててから main 反映、 §4.5 注記)
- 計測実走: **未実施** (Step 3a「未実施」 項目: Playwright で 1 session 流して Server-Timing 取得 + cold/warm 差観察 + EXPLAIN ANALYZE)

### 9.3 残作業

- timing 値の収集
- 収集後の **revert commit を別途追加** して stg をクリーンに戻す (= 8417e83 単独 push のみ stg 残置中、 production 反映前に消す)

---

## 10. 現状サマリ (scope 全体)

- **flush 3 経路 + in-flight guard 不在**: 実コード一致、 memo §4.1-4.2 確定
- **sessionId は mount 内 stable**: Map key として OK の仮説は強い (= memo §6.2.2 提案は実装可能)
- **bulk route per-event serial + 6N + 1 SQL + N tx**: 実コード一致、 memo §5.1 確定
- **failed[] semantics と 1 tx 化の trade-off**: 実コード上明確 (per-event tx + try/catch + failed.push)
- **同 card 複数 events 順序保証**: per-event serial + Dexie read order に依存。 strict には **未保証 + 未テスト**
- **dashboard 反映 timing**: PullTrigger は layout mount で fire-and-forget、 flush 成功で server 更新 → pull で Dexie 上書き → dashboard 表示更新の経路は実装的に成立。 失敗時の挙動は実機未検証
- **memo §2 観測値**: stg 実機観察に依拠、 repo 内に一次ログ未存在 (= Step 3a 未着手と裏腹)
- **既存テスト**: 単独 invoke / 失敗分岐 / payload は厚い、 同時 invoke / 順序 / TTL / pagehide は **未テスト**
- **一時計測 commit 8417e83**: stg 反映済、 実走 + revert いずれも未着手

---

## 11. 論点 (修正案は決めない、 OT 判断材料)

| # | 論点 | A 案 | B 案 | 備考 |
|---|---|---|---|---|
| A | 問題 2 / 問題 3 の着手順 | 問題 2 (in-flight guard) → 問題 3 (bulk refactor) (= memo §10.2 推奨) | 問題 3 を先行 (= server 改善で client 並走を許容)、 問題 2 は後 | memo は B 推奨理由として「POST 数正規化で baseline 計測しやすい」 を挙げる |
| B | 問題 2 の Map 配置 | `lib/sync/review-events.ts` module-level singleton (memo §6.2.2 案) | flushPendingEvents の caller (SessionRunner) 側 ref で保持 | singleton は SPA 全体で共有、 caller 側保持は scope 限定だが 3 経路を 1 つの ref に集約する手間 |
| C | 同 card 複数 events 順序保証の test | bulk route.test.ts に統合 unit test 追加 | submit-review-tx を direct call する order test 追加 + payload 順序保証は flushPendingEvents test に追加 | 仕様 (案 B 採用済 §3 closure log) を test で固定する必要、 着手 sprint で議論 |
| D | `getPendingAnswerEvents` の sessionId 必須化 | memo §6.2.3 通り必須化 (signature 変更、 caller 1 + test 2 修正) | optional 維持、 全件 pull は別 helper に分離 (例: `getAllPendingAnswerEvents`) | callers 影響は小さい (実コード grep 確認済)、 ただし global flush trigger (online 復活等) が将来必要なら optional 維持が無難 |
| E | 1 tx 化 と failed[] semantics | 全件 atomic (案 a: 1 件失敗で全 rollback、 failed[] 廃止) | per-event tx 維持で bulk insert/update のみ抽出 (案 c) | client 側 retry の挙動が変わる (case a: 1 件 fail で N 件再送、 case c: 1 件 fail のみ再送)。 memo §8.5 で 3 案提示 |
| F | Step 3a timing 取得の前提 | 問題 2 着手前に取る (= baseline) | 問題 2 fix 後の正常 size payload で取る (memo §10.2 暗黙) | 問題 1 fix で payload 正常 size 既に回復、 問題 2 は POST 数を絞るが 1 POST あたりの size は不変 → どちらでも timing 取得は意味あり、 ただし測定対象が変わる |
| G | 一時計測 8417e83 の revert タイミング | 問題 3 refactor 開始時に revert (= refactor で経路自体が変わる、 計測仕込みも作り直し) | Step 3a 計測完了次第 即 revert (= 投資 memo §10.4 想定) | 単独 push 中なので長期残置は production 反映の事故源、 早期 revert 推奨 |

---

## 12. 次手候補

調査 only / 修正案未確定の縛りに従い、 次手は OT の論点判断後に確定するが、 候補としては以下が考えられる (= 修正案ではなく「方向性メニュー」):

1. **論点 A / E / F 確定** → 問題 2 spec を起草、 brainstorming skill フルフロー
2. **論点 D / C の test 整備** を問題 2 spec 内で同時カバー (順序保証 test を追加すれば LocalSync MVP 着手前の guard にもなる)
3. **Step 3a Server-Timing 取得** (cache-fix-roadmap §4.5 未実施) を問題 2 着手と独立 / 並行で実施、 取得後 8417e83 を revert (論点 G)
4. **問題 3 refactor は問題 2 / Step 3a 計測完了後** (= 投資 memo §10.2 推奨順 B → A → C → D を踏襲する場合)

---

## 13. 主要 file 一覧 (実コード確認済、 投資 memo §9.1 と一致)

| 役割 | path |
|---|---|
| sessionId 採番 + Dexie session 行作成 + SessionRunner mount | `app/(app)/app/study/smart/_components/study-session-host.tsx` |
| FSRS / 通常モード UI + 3 flush 経路 + dashboard nav race gate | `app/(app)/app/study/smart/_components/session-runner.tsx` |
| Dexie write helper (record / get / count / flush / mark / complete / abandon) | `lib/sync/review-events.ts` |
| Dexie schema (study_sessions / answer_events 他 6 store + study_days v2 mirror) | `lib/client-db.ts` |
| Server bulk endpoint (auth / zod / session upsert / per-event tx loop / failed[]) | `app/api/review-events/bulk/route.ts` |
| per-event FSRS / cards UPDATE / reviews INSERT / study_days UPSERT | `lib/cards/submit-review-tx.ts` |
| layout 共通 pull trigger | `app/(app)/app/_components/pull-trigger.tsx` (mount される場所: `app/(app)/app/layout.tsx`) |

---

## 14. 出力済 commit

- 本 survey 開始前に `aea5e9c docs(perf): bulk flush latency investigation memo (claude.ai 起票) を commit [no-review]` で投資 memo を repo に正式記録済
- 本 survey 自体 (= 本 file) は OT 提示後の判断で commit 予定
