# RecallMint localDB 化 棚卸し (S-local-2 まで完了時点)

- 作成日: 2026-05-26
- 種別: session log / inventory snapshot
- 対象 commit: `f06df0a feat(local-first): S-local-2 Phase α cards / exams pull MVP (Dexie read-only mirror) [reviewed]`
- 直前関連 commit: `44b0a24` (S-cache-3.1 race fix) / `c270010` (S-local-1 design) / `53cd12a` (S-cache close)
- 関連 spec: `docs/superpowers/specs/2026-05-26-s-local-1-design.md`
- 関連 plan: `docs/superpowers/plans/2026-05-26-s-local-2-cards-pull-mvp.md`

---

## A. 一言結論

**localDB 化は「event capture (answer_events / study_sessions) + cards/exams mirror write」 まで完了。 mirror の read 元 (演習読取 / due 判定 / dashboard dueCount) と user_settings / card_mutations はまだ server authoritative。 offline 演習成立には「smart session の cards を Dexie 由来に切替」 が次の一歩。**

---

## B. 完了済み一覧

| 領域 | localDB 化の状態 | 証拠 | stg 確認 |
|------|----------------|------|---------|
| **answer_events event capture** | ✅ 完全配線 (write→read→flush) | `lib/sync/review-events.ts:117-282` / `session-runner.tsx:262-289` 回答 click で Dexie 即時 add → 5 件 or 完了で `flushPendingEvents` | S-cache-3.1 smoke で IDB に events 確認、 bulk POST 200 |
| **answer_events idempotency** | ✅ 完成 | `event_id` UUID + server `INSERT ... ON CONFLICT DO NOTHING` (`app/api/review-events/bulk/route.ts:91-227`) | 二重 flush で副作用ゼロを stg で観察 |
| **answer_events silent retry** | ✅ 完成 | `flushPendingEvents` 失敗時 sync_status 不変 → 次トリガで再送 (`review-events.ts:246-282`) | vitest `review-events.test.ts` で 6 case cover |
| **study_sessions write/read** | ✅ 完全配線 | `createStudySession` (`review-events.ts:45-63`) ← `StudySessionHost` (Block A 調査 L42-47) で mount 時呼出。 `getStudySession` は flush 時 sessionId lookup (L211) | smart smoke で session_id 採番動作確認 |
| **S-cache-3.1 await navigation** | ✅ M4 race 解消 | `session-runner.tsx:333-369` 完了画面 click で `await flushPendingEvents` 後に `router.push('/app')`、 失敗時 warning state | S-cache-3.1 stg smoke で dueCount 4→1 (−3)、 reqid=126 (flush) → reqid=127 (navigate) 順序確認済 |
| **cards Dexie mirror (write)** | ✅ 完成 (read は未配線) | `lib/sync/cards.ts:54-77` で `clear + bulkPut + sync_meta.put` atomic transaction。 `lib/db/cards-pull.ts:18-58` の pure mapper + Drizzle SELECT | S-local-2 smoke で **IDB cards 24 行** 保存確認、 `/api/cards/pull` 200 |
| **exams Dexie mirror (write)** | ✅ 完成 (read は未配線) | `lib/sync/exams.ts:42-65` 同 pattern。 `lib/db/exams-pull.ts` | smoke で **IDB exams 3 行** 保存確認、 card_count 合計 24 で cards と整合、 `/api/exams/pull` 200 |
| **sync_meta accessor** | ✅ 完成 (UI 利用は test のみ) | `lib/sync/sync-meta.ts:14-33` で `SYNC_META_KEYS` 定数 + type-safe get/set | smoke で `last_card_pull_at` `last_exam_pull_at` ISO8601 が IDB 保存、 reload で値更新 (`03:05:11` → `03:05:46`) |
| **PullTrigger (dashboard mount)** | ✅ 完成 | `app/(app)/app/_components/pull-trigger.tsx:14-27` useEffect で 2 helper fire-and-forget、 silent retry。 `app/(app)/app/page.tsx:32` で `<PullTrigger />` 配置 | smoke で reload ごとに `/api/cards/pull` `/api/exams/pull` 各 200、 idempotent |
| **dashboard race-free (3 値)** | ✅ S-cache-3.1 効果 | dueCount は server SSR (`page.tsx:19-23`)、 stats は client fetch (`DashboardStats.tsx:36-41`)。 await flush で SSR/fetch は post-flush DB を読む | smoke で表示値が即時反映 |

---

## C. 未完了一覧

| 領域 | まだ server 依存の内容 | なぜ未完了か | 次に必要な作業 |
|------|--------------------|-------------|-------------|
| **smart session cards 選定** | `app/(app)/app/study/smart/page.tsx:31` で `getSessionCards(user.id, sessionLimit)` (Drizzle SELECT)、 Dexie cards は touch されない | S-local-2 (Phase α) は cards write のみ、 read 切替は Phase β 範囲外と spec 明示 | session-runner / 親 host が Dexie cards から read するよう切替 |
| **dashboard dueCount** | `page.tsx:19-23` で `db.select({c: count()}).from(cards).where(due<=now)` (server SSR) | S-cache-3.2 で「local projection しない」 を OT 確定 (cards local pull + FSRS due 判定 client 化が前提) | cards local read + FSRS client が揃ってから (Phase δ) |
| **dashboard todayCardCount / streak** | `/api/dashboard/stats` (`route.ts:50-52`) で `getReviewStatsForUser` → server `study_days.distinct_card_count` | distinct 集計は全 today reviews 必要、 client 完結が難しい | server authoritative 維持 (S-local-1 design §5 で確定) |
| **FSRS due 判定** | server `submit-review-tx.ts:80` の `rate(card, rating, now)` 一箇所のみ。 client は計算しない | ts-fsrs client bundle 未追加。 Phase β で導入 (S-local-1 §5) | ts-fsrs client port + scheduler 共有 (Phase β) |
| **user_settings Dexie 化** | `lib/sessions/save-fsrs-mode.ts` で Drizzle UPSERT のみ。 `client-db.ts:102-108` の `user_settings` schema は定義のみ、 write/read ゼロ | smart session が server-fetched settings で動作中、 Dexie 化の差し迫った価値なし | offline 演習で fsrs_mode 参照が必要になった時に配線 (Phase γ 以降) |
| **card_mutations Dexie 化** | `client-db.ts:144-152` の schema 定義のみ、 write/read ゼロ。 inline 編集 (S2.0b) は Drizzle 直書き | bulk push endpoint も未実装 | S2.1 系か独立 sprint で `/api/card-mutations/bulk` + Dexie write 配線 |
| **cards Dexie の read 元配線** | mirror に書かれているが、 SessionRunner / dashboard / 試験一覧 いずれも server 由来 | S-local-2 は write のみ (mirror 立ち上げ目的) | smart session で `cards` props を Dexie 由来にする (Phase β、 S-local-3 候補) |
| **exams Dexie の read 元配線** | 同上 (試験一覧 `/app/exams` は server fetch) | 同上 | 試験一覧 page で Dexie exams 由来表示 (Phase β subset) |
| **sync_meta read** | `lib/sync/sync-meta.ts:22-25` の `getSyncMeta` は test 内のみ | Δ pull 未実装で stale 判定 use case がまだない | Δ pull (since cursor) 実装時に活用 (Phase β 以降) |
| **起動 / 復帰 / online トリガ** | `PullTrigger` は dashboard mount のみ | scope 制御で dashboard mount に絞った | visibilitychange / online event / app entry での pull 追加 (別 sprint) |
| **真の offline 演習成立** | browser → Vercel reach 不能では `/app/study/smart` の RSC / document fetch 自体が失敗、 Service Worker / app shell precache なし | S-local-4 で server reach 後の `getSessionCards()` failure fallback のみ達成 (= offline 演習 MVP の前段)。 真の offline navigation は RSC fetch を要するため未達 | Phase ε (Service Worker / app shell precache / route precache / mounted-page 内 client-only session 開始導線 等の中から選択、 別 sprint) |

---

## D. データフロー図 (現状、 2026-05-26 時点)

### D-1. 回答イベント flow (✅ 完全 localDB 化)

```
[user click 回答 → 次へ]
   ↓ optimistic state 更新 (tally / submittedCardIds)
   ↓ session-runner.tsx:264-271 recordAnswerEvent()
        → Dexie answer_events.add (sync_status='pending', event_id=uuid)
   ↓ session-runner.tsx:272-275 countPendingAnswerEvents()
   ↓ pending >= 5 ?
      → Yes: flushPendingEvents() → POST /api/review-events/bulk
   ↓ 次 card or finished

[finished phase]
   ↓ session-runner.tsx:295-305 useEffect
   ↓ completeStudySession() → Dexie study_sessions.update status='completed'
   ↓ flushPendingEvents() (background)

[user click ダッシュボードへ]
   ↓ session-runner.tsx:347-367 onClick(async)  ← S-cache-3.1
   ↓ await flushPendingEvents()  ← race gate
   ↓ 成功: router.push('/app')
   ↓ 失敗: warning UI (再 click で flush せず直接 push)

[server side bulk]
   POST /api/review-events/bulk (route.ts:91-227)
   ↓ Clerk auth → tenant
   ↓ per-event tx with event_id ON CONFLICT DO NOTHING
   ↓ submitReviewTx → cards/reviews/study_days 更新
   ↓ failedEventIds[] で部分失敗対応
```

### D-2. cards / exams pull flow (✅ write 完成、 read 未配線)

```
[/app navigate (dashboard mount)]
   ↓ Server: page.tsx で dueCount SELECT (cards table、 server fetch)
   ↓ HTML stream
   ↓
[Client mount]
   ↓ <PullTrigger />.useEffect (pull-trigger.tsx:18-25)
   ↓ void pullAllCards()
   ↓ void pullAllExams()  ← 並列 fire-and-forget
        ↓
        GET /api/cards/pull → cards-pull.ts:53-58 で getAllCardsForUser
        GET /api/exams/pull → exams-pull.ts:25-29 で getAllExamsForUser
        ↓
        sync/cards.ts:70-76 transaction:
          db.cards.clear()
          db.cards.bulkPut(rows)
          db.sync_meta.put({ key: 'last_card_pull_at', value: now })
        sync/exams.ts:57-63 同 pattern (last_exam_pull_at)

[reload]
   ↓ 同 flow が再実行 (idempotent: 同じ id で replace)

[失敗時]
   ↓ silent return、 Dexie / sync_meta 不変
   ↓ 次トリガ (dashboard 再 mount) で再試行
```

**読み取り元: 現状ゼロ** (UI / smart session いずれも Dexie cards / exams を read しない)

### D-3. dashboard flow (✅ race-free、 server authoritative)

```
[click ダッシュボードへ から /app へ navigate]
   ↓ Server: page.tsx Server Component
        getCurrentUser() (Clerk + users SELECT)
        SELECT count() FROM cards WHERE user_id=? AND due<=now()
        → dueCount = N
   ↓ HTML stream with <DashboardStats /> + <DashboardActions dueCount={N} /> + <PullTrigger />
   ↓
[Client mount]
   ↓ <DashboardActions> dueCount で CTA enable/disable
   ↓ <DashboardStats> useEffect → GET /api/dashboard/stats
       → server getReviewStatsForUser → { todayCardCount, streak }
       → skeleton → 値表示
   ↓ <PullTrigger> useEffect → cards/exams pull (D-2)

[S-cache-3.1 効果]
   await flush 後に /app navigate なので、 page.tsx SELECT と /api/dashboard/stats は
   いずれも post-flush の DB を読む → race-free
```

### D-4. smart session flow (❌ cards は server fetch のまま)

```
[/app/study/smart navigate]
   ↓ Server: page.tsx (study/smart/page.tsx)
        getCurrentUser()
        SELECT user_settings (sessionLimit, fsrsMode)  ← Drizzle
        getSessionCards(user.id, sessionLimit)  ← Drizzle SELECT FROM cards WHERE due<=now ORDER BY due LIMIT N
   ↓ HTML stream with <StudySessionHost cards={...} fsrsMode={...} mode="smart" />
   ↓
[Client mount (StudySessionHost)]
   ↓ useEffect (mount 1 回)
   ↓ session_id = uuid (client 採番)
   ↓ createStudySession({ session_id, mode, card_ids })  ← Dexie study_sessions.add
   ↓ <SessionRunner cards={cards} fsrsMode={fsrsMode} sessionId={sessionId} />

[Session 中]
   ↓ cards は props (server 由来)、 Dexie cards table は触らない
   ↓ 回答 → Dexie answer_events.add (D-1)
   ↓ flush → bulk POST (D-1)

[offline で /app/study/smart に入った場合]
   ↓ getSessionCards() で network error → server render fail
   ↓ session 開始不可 (break point)
```

---

## E. localDB 化の到達率 (主観評価)

| 領域 | 到達率 | 根拠 |
|------|------|------|
| **answer events** | **~95%** | event capture / Dexie write / idempotent flush / silent retry / await navigation 完成。 残り 5% = 起動 / 復帰 / online 復活トリガ未配線、 onError logging |
| **cards / exams mirror** | **~70%** | write 完成 (S-local-2 で stg 実証)、 sync_meta cursor 記録済。 残り 30% = Δ pull (since cursor 利用) / 起動以外トリガ / 読み取り元配線 |
| **smart session read path** | **~5%** | cards は server fetch、 Dexie cards table は read 元として 0% 利用。 session 作成 (Dexie write) は完成 (= 5%) |
| **dashboard projection** | **~10%** | dueCount は server SSR (race-free だが Dexie 由来ではない)、 stats は client fetch (server 由来)。 PullTrigger 配置済が「画面 Dexie 由来」 ではない (= 10%) |
| **offline exercise MVP** | **~15%** | 回答記録は offline OK (Dexie 即時 write + 復帰で flush)、 完了画面 navigation も warning フローで dead-end 回避。 ただし session 開始時に cards 取得が server 必須 → MVP 不成立 (= 15%) |

---

## F. 次にやるべきこと (S-local-3 推奨)

**S-local-3 = Phase β: smart session の cards を Dexie 由来 read に切替**

### 推奨理由

1. **offline 演習成立への直接の道**。 cards local read が揃えば、 session 開始の break point (D-4 図) が解消し、 真の offline 演習 MVP に大きく近づく
2. **S-local-2 で書いた cards mirror が初めて「読まれる」**。 write-only 状態を解消し、 mirror 価値を回収できる
3. **dueCount local projection (Phase δ) の前提**。 cards local + due field 比較で client side の due 計算が成立し、 S-cache-3.2 で見送った dueCount local projection の足場が整う
4. **FSRS client 計算は本 sprint で不要**。 cards local read だけでは server-authoritative FSRS 更新を維持できる (回答 → answer_events → server flush → server FSRS 計算 → 次 pull で mirror 更新)
5. **段階分け spec (S-local-1 design §8.2 Phase β) と整合**

### S-local-3 スコープ案 (確定 spec は別途 drafting)

含める:
- `app/(app)/app/study/smart/page.tsx` の `getSessionCards()` を client 側で `db.cards` 由来に置換 (or server で軽 SSR + client が Dexie 由来 cards で上書き)
- session 開始時に Dexie cards が空 / stale なら同期 pull を kick (= S-local-2 PullTrigger の延長)
- session-runner に渡る cards の型一致確認 (server `Card[]` ↔ Dexie `ClientCard[]` の field 差分対応)

含めない (= Phase γ 以降):
- FSRS due 判定の client 化 (server で submit-review-tx 維持)
- dueCount の local projection
- offline 完全成立 (server flush 経路の retry / online 検知の強化、 cards stale 警告 UI 等)
- Service Worker
- 画像 cache
- マルチデバイス sync UX

### 代替案 (棄却理由)

- **S-local-3 = Δ pull (since cursor 利用)**: S-local-2 で書いた full snapshot で性能上問題なし、 急がない
- **S-local-3 = FSRS client 計算 PoC**: 読み取り元配線がない状態で client FSRS を入れても活用箇所なし
- **S-local-3 = card_mutations bulk push**: 価値はあるが inline 編集経路 (S2.0b) で server 直書きが既に機能している、 緊急性低
- **S-local-3 = user_settings Dexie 化**: smart session が server fsrsMode で動いている、 緊急性低

---

## 客観証拠インデックス

### file path / 行番号

- Dexie schema: `lib/client-db.ts:24-186` (全 7 table 定義)
- sync helper (events): `lib/sync/review-events.ts:117-282` (recordAnswerEvent / flushPendingEvents 等)
- sync helper (cards): `lib/sync/cards.ts:54-77` (pullAllCards transaction)
- sync helper (exams): `lib/sync/exams.ts:42-65` (pullAllExams)
- sync helper (meta): `lib/sync/sync-meta.ts:14-33` (SYNC_META_KEYS / get / set)
- mapper (cards): `lib/db/cards-pull.ts:18-58` (toClientCard pure + getAllCardsForUser)
- mapper (exams): `lib/db/exams-pull.ts:13-29` (toClientExam pure + getAllExamsForUser)
- server endpoint (cards): `app/api/cards/pull/route.ts:18-48`
- server endpoint (exams): `app/api/exams/pull/route.ts:13-43`
- server endpoint (bulk): `app/api/review-events/bulk/route.ts:91-227`
- server endpoint (stats): `app/api/dashboard/stats/route.ts:22-57`
- PullTrigger: `app/(app)/app/_components/pull-trigger.tsx:14-27`
- Dashboard page: `app/(app)/app/page.tsx:14-46` (server SSR で dueCount + PullTrigger 配置)
- DashboardStats: `app/(app)/app/_components/dashboard-stats.tsx:29-118` (client fetch)
- DashboardActions: `app/(app)/app/_components/dashboard-actions.tsx:6-38` (dueCount を CTA に)
- Smart page: `app/(app)/app/study/smart/page.tsx:23-51` (server fetch cards / settings)
- StudySessionHost: `_components/study-session-host.tsx:42-69` (Dexie session 作成 + SessionRunner)
- SessionRunner: `app/(app)/app/study/smart/_components/session-runner.tsx:262-369` (event capture + 完了画面 await)
- Server FSRS: `lib/cards/submit-review-tx.ts:80` (rate 呼出)

### test 件数

- vitest 全体: 76 file / 785/785 PASS (`pnpm test`)
- review-events.test.ts: pattern 元、 多数 case
- session-runner.test.tsx: 62 case (S-cache-3.1 含む)
- cards-pull.test.ts: 3 case (mapper)
- exams-pull.test.ts: 3 case (mapper)
- sync-meta.test.ts: 5 case
- cards.test.ts (sync helper): 6 case
- exams.test.ts (sync helper): 6 case
- /api/cards/pull/route.test.ts: 6 case
- /api/exams/pull/route.test.ts: 6 case
- pull-trigger.test.tsx: 3 case

### stg smoke 証跡

- S-cache-3.1 stg smoke (2026-05-26): dueCount 4→1 (−3) 確認、 Network reqid=126 (bulk POST) → reqid=127 (RSC navigate) 順序確認、 console error なし (本変更起因)
- S-local-2 stg smoke (2026-05-26): deploy `dpl_ELwHs47gAf8QK77BDiVQL3d2DMT2` 反映確認、 `/api/cards/pull` `/api/exams/pull` 各 200、 **IDB cards 24 行 / exams 3 行 (card_count 合計 24 で整合)**、 sync_meta `last_card_pull_at` `last_exam_pull_at` ISO8601 保存、 reload で値更新 (`03:05:11` → `03:05:46`)、 単一 user_id (`f9e725e7-...`) で tenant isolation 確認

### commit hash

- `44b0a24`: S-cache-3.1 完了画面 navigation await (M4 race 解消)
- `53cd12a`: S-cache series close (docs)
- `c270010`: S-local-1 design / investigation (docs)
- `f06df0a`: S-local-2 Phase α cards/exams pull MVP

---

## 関連 doc

- design: `docs/superpowers/specs/2026-05-26-s-local-1-design.md`
- investigation: `docs/superpowers/specs/2026-05-26-s-local-1-investigation.md`
- plan: `docs/superpowers/plans/2026-05-26-s-local-2-cards-pull-mvp.md`
- S-cache close: `docs/superpowers/sessions/2026-05-26-s-cache-series-close.md`
- S-cache-3.1 spec: `docs/superpowers/specs/2026-05-26-s-cache-3-design.md`
- tech-spec local-first: `docs/02-tech-spec.md` §13.14 / §14 (§14.11 MVP 採用)
