# stg 5 画面 perf 計測 (local-first 全量 prefetch 判断のための事前計測)

- 起票日: 2026-05-26
- 計測環境: stg.recallmint.nekotest.net / 認証済 Chrome profile / DevTools MCP (chrome-devtools) / throttling なし / 5/26 時点の dev container WSL2 → Vercel stg
- 対象 user の Dexie 状態 (計測開始時点): exams=4 / cards=28 / user_settings=0 / study_sessions=9 / answer_events=10 / card_mutations=0 / sync_meta=2
- stg deployment: dpl_H6rFBpZ7CvhxQ6cj84Bwiqq1mZ2r (revert `6758b2f` は未 push、 stg は overlay 撤回前か Link 状態 deploy だが計測上影響なし)

## A. 画面別計測 (reload trace、 warm cache)

| 画面 | doc TTFB | doc stream | DOM interactive | LCP | CLS | post-doc API (longest) | 体感終端 |
|---|---|---|---|---|---|---|---|
| `/app` | 9 ms | **1678 ms** | 1682 ms | **1854 ms** | 0.00 | `/api/dashboard/stats` 2087ms | ~2100 ms |
| `/app/exams` | 9 ms | 893 ms | 899 ms | 1011 ms | 0.01 | (なし) | ~1000 ms |
| `/app/exams/[id]` | 9 ms | **1416 ms** | 1434 ms | 1494 ms | 0.00 | (なし) | ~1500 ms |
| `/app/study/smart` | 9 ms | 1123 ms | 1131 ms | 1203 ms | 0.01 | (なし) | ~1200 ms |
| `/app/upload` | 8 ms | 1129 ms | 1177 ms | 1213 ms | 0.01 | (なし) | ~1200 ms |

**観察 1: TTFB が常に 8-11ms** = Vercel edge が response の初期バイト (Suspense boundary 構造 / shell HTML) を ~10ms で返している。 つまり「サーバが応答するまで待っている時間」 は問題ではない。

**観察 2: doc stream が 0.9-1.7s** = Server Component の `await` 全部解決して RSC body を流し終わるまでの時間。 これが純粋に「Server Component + Neon DB query」 の所要時間。

**観察 3: LCP ≈ doc stream + 50-100ms** = JS hydration overhead。 hydration 自体は軽い。

**観察 4: `/app` のみ post-doc client API (3 本並走) が ~2s** で、 user 体感の「2 秒」 は doc stream (1.7s) **+** client API (2s) の **後者が支配**。 LCP は 1.8s だが「13 問 / 4 日」 等の数値が出るまでは更に ~200ms 待ち、 結果として認識的に "完了" は 2 秒台前半。

## A2. /app の post-doc API 内訳 (= 「2 秒問題」 の真因)

| request | duration | TTFB | transfer | decoded | 何をしている |
|---|---|---|---|---|---|
| `/api/dashboard/stats` | **2087 ms** | 2085 ms | 338 B | 32 B (空っぽ等) | streak.ts の 2 SELECT (today count + streak) |
| `/api/cards/pull` | **2044 ms** | 2040 ms | 8.7 KB | 52 KB | `getAllCardsForUser` (全 cards SELECT、 28 行) |
| `/api/exams/pull` | **1947 ms** | 1944 ms | 694 B | 1.2 KB | 全 exams SELECT (4 行) |

3 endpoint とも **TTFB ≒ duration**、 download 自体は 数 ms。 つまり server-side が 2 秒占有。
3 本は **並走** している (LCP 後 ~50ms で 3 本同時発射、 client fetch の Promise.all 的挙動) のに、 すべて約 2 秒で揃って戻る = **server side compute が各 connection で個別に 2s 食っている**。

→ **強く Neon cold start (serverless Postgres の scale-from-zero) 疑い**:
- stg は traffic が少なく頻繁に compute が cold (Neon scale-to-zero, 5 分 idle で suspend)
- 1 request 1 connection で wake-up → 2s 程度 plate cost (Neon の知られたコールド挙動と一致)
- 3 本並走で「同時 3 connection wake-up」 → 各 2s に揃う

production traffic 増で connection pool warm 化されれば自然解消。 stg では構造的に避けにくい。

## B. Server Component が発行する DB query (file 読み合わせ)

| 画面 | 発行 query | 並列? | 備考 |
|---|---|---|---|
| `/app` `page.tsx` | (1) `getCurrentUser()` → users SELECT (2) `cards count() where userId AND due<=now` (3) (client) `<DashboardStats/>` mount → /api/dashboard/stats | 1→2 直列 / 3 は post-hydration | dueCount は CTA enable 用に SSR に残置 (S-perf-2 T4 で stats 撤去済) |
| `/app/exams` `page.tsx` | (1) `getCurrentUser()` (2) `Promise.all([getActiveExamsWithCardCount, getExamStatusMap])` | 2 は並列 (👍) | `getActiveExamsWithCardCount` は exams SELECT + cards count GROUP BY exam_id、 status は source_documents SELECT |
| `/app/exams/[id]` | (1) `getCurrentUser()` (2) `getExamByIdForUser` (3) `getCardsForExam` | **(2)→(3) 直列** | 改善余地: Promise.all で並列化可能 (notFound 判定があるが、 cards も先取得しても影響軽微) |
| `/app/study/smart` | (1) `getCurrentUser()` (2) `userSettings SELECT` (3) `try getSessionCards()` | 直列だが (3) は try/catch (S-local-4) | client 側 StudySessionHost が Dexie 優先で読むので server cards=[] でも OK |
| `/app/upload` | (1) `getCurrentUser()` (2) `hasActiveProcessingUpload` (3) (in-flight なしのときのみ) `Promise.all([getActiveExamsForUser, getCurrentMonthOcrPages])` | (3) は並列 | in-flight 案内表示時は (3) skip |

**N+1 疑い**: 上記の `getActiveExamsWithCardCount` (`lib/exams/list.ts:50, 124` 周辺) と `getExamStatusMap` (source_documents SELECT 1 件 / 全 exam) を要 spot check。 今回の計測 (4 exams) では実害目立たないが、 exams 数が増えると顕在化。

**Neon 接続コスト**: `lib/db/index.ts` は `@neondatabase/serverless` の HTTP driver と推測 (要確認)、 pool は serverless function 起動ごと freshly created で warm 状態維持なし。 stg traffic 少で compute が cold だと TLS handshake + connect + query で ~1.5-2s plate cost。

## C. Client side

**JS bundle (初回 / cached 後)**:
- 主要 chunks (decoded): `2579-*.js` 173 KB / `6157-*.js` 121 KB / `5805-*.js` `6498-*.js` 等
- Clerk: clerk-js + ui.browser.js + 8 つの ui chunk (~10 ファイル、 lazy load 含む)
- 2 回目以降の navigation: chunks ほぼ 304 / cache hit (各 <50ms)、 hydration overhead は LCP - doc stream = 50-150ms 程度

**hydration**: 計測した 5 画面とも DOM interactive が doc stream の +10-50ms 以内、 hydration 軽い。

## D. Dexie (IDB) 現状の活用

**現在 mirror されている table (`lib/client-db.ts`)**:

| table | schema | 現在の状態 | source of truth |
|---|---|---|---|
| `exams` | server pull cache | 4 rows | server |
| `cards` | server pull cache | 28 rows | server |
| `user_settings` | 1 row / user | **0 rows (未配線)** | server |
| `study_sessions` | client 採番 | 9 rows | client |
| `answer_events` | 演習中の insert | 10 rows | client (bulk push) |
| `card_mutations` | inline 編集 patch | 0 rows (未配線) | client (bulk push) |
| `sync_meta` | sync state KV | 2 entries | mixed |

**Dexie write 配線済 (= mirror 更新がされている)**:
- `/app` mount で `PullTrigger` → `/api/cards/pull` + `/api/exams/pull` (S-local-2 Phase α、 fire-and-forget)
- `/app/study/smart` (とその開始画面) で `createStudySession` / `recordAnswerEvent` / `flushPendingEvents`

**Dexie read 配線済 (= server SELECT を Dexie で代替している)**:
- **`/app/study/smart` の StudySessionHost のみ** (S-local-3、 hybrid: Dexie 優先 + server fallback)

**Dexie read 未配線 (= mirror あるのに server を読んでいる)**:
- `/app` (dueCount を server SELECT)
- `/app/exams` (exams を server SSR)
- `/app/exams/[id]` (exam + cards を server SSR)
- `/app/upload` (existing exams を server SSR)
- `/app` の `DashboardStats` (today count + streak を server で集計)

## 最も効果の高い改善候補 Top 3 (数値根拠つき)

**前提**: stg では Neon cold start ~2s / 個 query が plate cost。 production traffic 増では自然減るが、 stg / 低 traffic 帯ではこれが恒常的に出る。

### 1. `/app` の dueCount を Dexie projection 化 + cards/exams pull の rate-limit

- 現状: `/app` doc stream 1678ms、 そのうち `count() where due<=now` が 1 SELECT (~1500ms cold)
- 提案: cards 全件 (28 行) は既に Dexie にあるため、 client side で `count(due <= now)` を即計算。 server SSR から dueCount SELECT を撤去し、 CTA は dueCount={null} で render → mount 後に client が Dexie 由来値で書き換え (skeleton 100ms 程度)
- 同 mount で /api/cards/pull / /api/exams/pull を発射するが、 `sync_meta.last_pull_at < N 分前` のみ実行する rate-limit を入れて毎回 reload で叩かない
- 削減見込: **/app の doc stream 1678ms → ~500ms (Clerk users SELECT のみ残)**
- 副作用: 初回 visit (Dexie 空) の体感劣化を避けるため、 Dexie 空 → null skeleton → background pull 完了で更新、 という二段表示が必要

### 2. `/app/exams` と `/app/exams/[id]` を Dexie 優先 + server fallback

- 現状: doc stream 893ms (exams 一覧) + 1416ms (詳細、 2 serial query)
- 提案: smart session で既に確立した hybrid pattern (StudySessionHost) を一覧 / 詳細にも展開
  - `/app/exams`: page.tsx は exams=[] で render し、 client が Dexie 4 rows を読んで表示 (Dexie 空のみ server fallback)
  - `/app/exams/[id]`: 同様、 exam + cards を Dexie で引く (cards 28 件は exam_id index で filter)
- 削減見込: **doc stream 0.9-1.4s → 0.05-0.15s**, **LCP 1.0-1.5s → 0.2-0.3s**
- ただし mutations (S2.0b の inline 編集) は引き続き Drizzle 直書きなので、 編集後の最新値反映は `card_mutations` bulk push 配線 (現状 0 rows = 未配線) と組み合わせる必要あり。 短期は revalidate + Dexie 再 pull pattern で逃げられる

### 3. `/api/dashboard/stats` を撤廃し client 集計に切替

- 現状: client fetch 2087ms (TTFB 2085ms = 純 server compute)
- 提案: `answer_events` table (Dexie、 sync 済 + pending を OR で union) と JST day 計算で today count を client 算出。 streak も answer_events から計算可能 (sync 済 events で日次 distinct list を構築)
- 削減見込: **DashboardStats の埋まりまで 2s → 即時 (Dexie read 数 ms)**
- ただし `lib/db/streak.ts` server logic の port が必要 + edge case (削除済 card の events / 別端末で同 day に学習した分) の整合性検証が要る。 localdb-inventory メモでは「distinct 集計が難しい」 と評価されていたが、 cards 全件 mirror が前提なら client 完結可能

### Top 3 を合算した /app 体感削減

| 状態 | doc stream | post-doc API 待ち | 体感終端 |
|---|---|---|---|
| 現状 | 1678 ms | 2087 ms | ~2100 ms |
| Top1 (dueCount Dexie + pull rate-limit) のみ | ~500 ms | 2087 ms (DashboardStats 残) | ~2100 ms |
| Top1 + Top3 (stats も Dexie) | ~500 ms | 即時 | **~600 ms** |
| Top1 + Top3 + ServiceWorker (doc cache) | ~50 ms (cache hit) | 即時 | **~150 ms (目標 300ms 内)** |

## IDB プリフェッチで代替できる server fetch 一覧

すでに mirror があり、 read 側を切り替えるだけで Dexie で完結する fetch:

- `/app` `count(due<=now)` → cards.due field client filter
- `/app` `/api/cards/pull` 毎 reload → rate-limit 化
- `/app` `/api/exams/pull` 毎 reload → 同
- `/app` `/api/dashboard/stats` → answer_events 集計
- `/app/exams` `getActiveExamsWithCardCount` → exams + cards.exam_id GROUP BY (client)
- `/app/exams` `getExamStatusMap` → **NG**: source_documents は Dexie に mirror なし、 status polling は別経路 (要追加か polling 維持)
- `/app/exams/[id]` `getExamByIdForUser` → exams.id query
- `/app/exams/[id]` `getCardsForExam` → cards.exam_id query
- `/app/study/smart` cards → **既に切替済** (S-local-3)
- `/app/upload` `getActiveExamsForUser` → exams query
- `/app/upload` `hasActiveProcessingUpload` → **NG**: source_documents 状態、 mirror なし
- `/app/upload` `getCurrentMonthOcrPages` → **NG**: ai_usage 系、 mirror なし

→ 「Dexie に既に乗っている exams / cards / user_settings / answer_events」 は **すべて** 即時 client read に切替可能。
→ 「Dexie に乗っていない source_documents / ai_usage / streak の中間表現」 は別途 mirror table 追加が必要。

## 実装しないと達成できない部分 (アーキ上の制約)

1. **Neon cold start (per-query ~2s)**: serverless Postgres の scale-from-zero 構造的特性。 client read を Dexie に倒せば server 経由経路が減り、 cold start に晒される頻度自体が下がる (= 構造的緩和)。 完全消去には Vercel cron による pinger 等の warm-up が必要だが、 traffic ある production では自然消滅
2. **初回 navigation の Clerk 認証**: SSR の `getCurrentUser()` で users 行 SELECT 1 件が常に発生 (Neon cold 時 +2s 寄与)。 Clerk JWT のみで判定 (users 行 SELECT 撤去) する path もあるが、 plan 列等の取得で結局必要 → users 行 cache or middleware 内 JWT decode + 必要時 lazy load 等で短縮可
3. **真の offline / route precache**: doc stream 自体を skip するには Service Worker + app shell precache が必要 (S-local-1 design Phase ε)。 これは別 sprint で扱う領域
4. **Dexie 空時の初回 visit**: 全 mirror 戦略採用後も、 1 回目の login 直後は Dexie 空 → 必ず server fetch。 PWA install 時に hydrate しておく + skeleton UI で許容、 という設計判断が要る
