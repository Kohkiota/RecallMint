# cache 制御 / auth / IDB 配線の包括 audit (local-first 化前の影響範囲洗い出し)

- 起票日: 2026-05-26
- 種別: investigation / audit
- 計測前提: 直前 commit `6758b2f` (= overlay 撤回後) 時点の codebase。 計測実測値は `2026-05-26-stg-perf-measurement-pre-local-first.md` を参照
- 目的: 「IDB プリフェッチ + local-first 読み出し」 への移行を検討する前に、 (1) server を叩く全経路、 (2) 認証で発生する DB cost、 (3) cache 制御の現状、 (4) IDB を読んでいる箇所と読んでいない箇所 を網羅し、 移行設計の影響範囲を確定する

---

## §1. cache 制御の全箇所

### 1.1 `revalidatePath` を発火している server action (= 次 navigation で server fetch を強制)

| ファイル | 行 | 対象 path | scope | 残置理由 |
|---|---|---|---|---|
| `app/(app)/app/cards/[id]/_actions/update-card.ts` | 59 | `/app/exams/${row.examId}` | cross-page | 編集完了 → 詳細遷移先で fresh data を保証 |
| `app/(app)/app/cards/[id]/_actions/delete-card.ts` | 56 | `/app/exams/${examId}` | cross-page | 削除完了 → 一覧遷移先で削除済 card 非表示を保証 |
| `app/(app)/app/exams/[id]/_actions/update-card-field.ts` | 159 | `/app/cards/${cardId}` | cross-page | 詳細 inline edit → editor 遷移先で fresh data 保証 |
| `app/(app)/app/exams/_actions/delete-exam.ts` | 31 | `/app/upload` | cross-page | exam 削除後 upload 画面の「existingExams」 を fresh に |
| `app/(app)/app/upload/_actions/process.ts` | 122 | `/app/upload` | self | (upload 後の form 再 render 用) |
| `app/(app)/app/upload/_actions/process.ts` | 123 | `/app` | cross-page | upload で増えた cards を dashboard dueCount に反映 |

### 1.2 過去に `revalidatePath` を撤去した箇所 (S-cache-2a / S-perf-2 で整理)

同 path への revalidate は Next.js 15 default `staleTimes.dynamic = 0` と client 側 `router.refresh()` で重複するため redundant 判定で撤去:

- `save-fsrs-mode.ts` / `save-session-limit.ts` / `update-card.ts` (self path) / `update-card-field.ts` (self path) / `delete-exam.ts` (self path)
- `submit-review.ts` の `revalidatePath('/app')` (S2.0b-2 fix で dashboard 反映漏れ対策に入れていたが M4 race 原因と判明し撤回)

### 1.3 API route の `Cache-Control: no-store` 一覧

すべて polling / mutation 系で stale 禁止目的:

| API | 用途 | no-store 理由 |
|---|---|---|
| `/api/dashboard/stats` | dashboard 統計 polling | fresh 必須 |
| `/api/cards/pull` | Dexie pull (全 cards 全量) | stale 不可 |
| `/api/exams/pull` | Dexie pull (全 exams) | 同 |
| `/api/exams/status` | OCR 状況 polling | 同 |
| `/api/me/deletion-status` | アカウント削除 polling | 同 |
| `/api/review-events/bulk` | answer_events bulk push | mutation、 server 応答 freshness 必須 |

### 1.4 client fetch の `cache: 'no-store'` 一覧

| 呼出元 | endpoint |
|---|---|
| `DashboardStats` (`dashboard-stats.tsx:40`) | `/api/dashboard/stats` |
| `delete-button.tsx:98` | `/api/me/deletion-status` |
| `exam-status-live.tsx:70` | `/api/exams/status` |
| `pullAllCards` / `pullAllExams` (`lib/sync/cards.ts` / `lib/sync/exams.ts`) | `/api/cards/pull` / `/api/exams/pull` (fetch options は別個確認要だが no-store 想定) |

### 1.5 `next/cache` / `unstable_cache` / `force-dynamic` 等

- `unstable_cache` 使用: **なし** (全 SSR は per-request fresh)
- `export const dynamic = 'force-dynamic'`: **なし** (default で fresh)
- `export const revalidate`: **なし**
- Next.js Data Cache (fetch revalidate 指定): **なし** (Drizzle 直接呼出のみで fetch 介さない)

→ 現状 **server cache 機構は実質ゼロ**、 全 page が毎 navigation で Neon SELECT を fresh 実行している。 これが計測で全画面 doc stream 0.9-1.7s の根本構造。

### 1.6 `router.refresh()` を呼ぶ箇所 (= 上記 revalidate と連動して再 SSR)

| ファイル | trigger |
|---|---|
| `delete-exam-button.tsx:39` | delete-exam server action 成功時 |
| `exam-status-live.tsx:80` | OCR processing → completed/failed 遷移検知時 |
| `fsrs-mode-form.tsx:31` | save-fsrs-mode 成功時 |
| `session-limit-form.tsx` (推測同行) | save-session-limit 成功時 |

`router.push` も `/app/cards/[id]/_components/{delete-card-button,card-editor}.tsx` / `upload-form.tsx` 等で使用、 これは navigation 自体を発生させるので新 page の SSR をトリガする。

---

## §2. 認証 (Clerk + users SELECT) で発生する DB cost

### 2.1 `getCurrentUser()` の構造 (`lib/auth/ensure-user.ts`)

```
1. clerkMiddleware 経由で session cookie 確認 (middleware.ts、 /app(.*) protect)
2. auth() → userId を decode (network なし、 local JWT decode)
3. db.select().from(users).where(clerkId = userId).limit(1)   ← Neon SELECT 1 件
4. React.cache() で同 RSC render tree 内 dedupe (layout + page 共有)
```

- `React.cache()` の効果: 1 request 内では layout の getCurrentUser と page の getCurrentUser が 1 回の users SELECT に統合 (Phase 1 G-5-1 で導入済)
- 効果境界: **request scope のみ**。 navigation 毎、 server action 毎、 API route 毎に独立して 1 回ずつ users SELECT は走る

### 2.2 `getCurrentUser()` を呼ぶ全箇所

**Server Component (page.tsx + layout.tsx)** — navigation 毎に layout 1 回 + page 1 回呼出 (cache dedupe で 1 SELECT に統合):

- `app/(app)/app/layout.tsx:28` — **/app 配下 全 navigation の共通 path**
- `app/(app)/app/page.tsx:16`
- `app/(app)/app/exams/page.tsx:25`
- `app/(app)/app/exams/[id]/page.tsx:23`
- `app/(app)/app/study/smart/page.tsx:15`
- `app/(app)/app/upload/page.tsx:28`
- `app/(app)/app/upload/result/[sourceDocumentId]/page.tsx:22`
- `app/(app)/app/cards/[id]/page.tsx:16`
- `app/(app)/app/upgrade/page.tsx:6`
- `app/(app)/app/settings/page.tsx:21`
- (marketing) `app/(marketing)/page.tsx:15`, `pricing/page.tsx:14`

**Server Actions** — invocation 毎に独立 SELECT:

- `settings/_actions/save-fsrs-mode.ts:18`
- `settings/_actions/save-session-limit.ts:10`
- `settings/actions.ts:8`
- `upgrade/actions.ts:12`
- `exams/_actions/delete-exam.ts:36`
- `exams/[id]/_actions/update-card-field.ts:135` ← **inline 編集の毎 500ms debounce 後の各 cell 単位**
- `cards/[id]/_actions/delete-card.ts:17`
- `cards/[id]/_actions/update-card.ts:19`
- `study/smart/_actions/submit-review.ts:34` (現在は bulk API 経由で不使用扱い、 ただし import は残存)
- `upload/_actions/process.ts:130`

**API routes** — request 毎に独立 SELECT:

- `/api/dashboard/stats` (page 毎の polling-like 1 回)
- `/api/cards/pull` (PullTrigger 毎)
- `/api/exams/pull` (PullTrigger 毎)
- `/api/exams/status` (5s polling、 processing 中)
- `/api/review-events/bulk` (flush 毎)

**直接 `auth()` 呼出 (users SELECT skip 系)**:

- `app/(marketing)/contact/actions.ts:44` のみ。 contact フォームで userId が取れたら attach、 取れなくても DB insert 続行 (users 行不要)

### 2.3 認証 cost の navigation 別積算 (= 各 navigation で発生する users SELECT 回数)

| シナリオ | users SELECT 回数 |
|---|---|
| `/app` 単発 navigation (RSC) | 1 (layout + page で dedupe) |
| `/app` の DashboardStats client fetch | +1 (API route 内 getCurrentUser) |
| `/app` の PullTrigger 2 本 fire-and-forget | +2 (各 pull endpoint 内) |
| `/app` の status polling は不発火 | +0 |
| **`/app` 1 visit 合計** | **4 users SELECT** |
| `/app/exams` 単発 navigation | 1 |
| `/app/exams/[id]` inline 編集 1 cell (500ms debounce 後) | +1 (per action) |
| `/app/study/smart` mount + answer_events flush 1 回 | 1 + 1 (bulk API) |

→ **「/app に navigate するだけで Neon に users SELECT を 4 回飛ばしている」**。 cold start 時はこれが直列的に sequential ではなく parallel に起き、 各 ~2s 食う (計測 §A2 で観察済 — `/api/dashboard/stats` 2087ms / `/api/cards/pull` 2044ms / `/api/exams/pull` 1947ms はそれぞれ users SELECT + 本 query を含む)

### 2.4 認証 cost 削減の余地

- (A) users 行を **request 跨ぎ cache** する — Next.js 15 の `unstable_cache` か Vercel edge KV / Upstash 等。 plan / billingInterval / deletedAt が頻繁に変わらない前提なら 60s 程度の cache でも実害なし
- (B) Clerk JWT の **private metadata** に plan / billingInterval / deletedAt / DB user.id を入れて users SELECT 自体撤去
- (C) middleware で 1 回だけ users SELECT し、 Cookie / Header に attach (RSC で読む)
- いずれも実装コスト中程度、 全 navigation の baseline cost を削れる効果は大きい

---

## §3. IDB (Dexie) を使わず毎回 server を叩く箇所

### 3.1 「現在 Dexie に乗っているデータ」 vs 「server から読んでいる経路」

#### Dexie 状態 (stg user 計測時):
- `exams`: 4 rows (mirror)
- `cards`: 28 rows (mirror)
- `user_settings`: **0 rows (write 未配線)**
- `study_sessions`: 9 rows (client 採番)
- `answer_events`: 10 rows (client write)
- `card_mutations`: **0 rows (write 未配線)**
- `sync_meta`: 2 entries

#### 「mirror あるのに server を読んでいる」 全箇所:

| 場所 | server から取得しているデータ | Dexie 該当 table | 切替容易度 |
|---|---|---|---|
| `/app` page.tsx | `cards.count() where due<=now` (dueCount) | `cards` (28 行、 due field 持つ) | 容易 — client filter 数 ms |
| `/app/exams` page.tsx | `getActiveExamsWithCardCount()` (exams + cards count GROUP BY) | `exams` + `cards.exam_id` | 容易 — Dexie aggregation |
| `/app/exams/[id]` page.tsx | `getExamByIdForUser` + `getCardsForExam` (serial 2 SELECT) | `exams.id` + `cards.where(exam_id)` | 容易 — Dexie idx 引き |
| `/app/study/smart` page.tsx | `userSettings SELECT` (sessionLimit / fsrsMode) | `user_settings` (mirror あるが **未配線で 0 rows**) | 設定 sync 配線が要る |
| `/app/study/smart` page.tsx | `getSessionCards()` | **既に S-local-3 で hybrid 化済** | — |
| `/app/upload` page.tsx | `getActiveExamsForUser()` | `exams` | 容易 |
| `/app/cards/[id]` page.tsx | `getCardForEdit()` (cards.id) | `cards.id` | 容易 |
| `/api/dashboard/stats` | streak.ts の 2 SELECT (today count + streak) | `answer_events` で再構築可能 | 中 (JST day 集計の port が必要) |

#### 「mirror 無く、 server だけで読まれている」 path (= 別途 mirror table 追加が必要):

| 場所 | データ | 追加が必要な mirror |
|---|---|---|
| `/app/exams` | `getExamStatusMap()` (sourceDocuments status) | `source_documents` table の Dexie 化 |
| `/app/upload` | `hasActiveProcessingUpload()` (sourceDocuments) | 同上 |
| `/app/upload` | `getCurrentMonthOcrPages()` (ai_usage 系) | `ai_usage` table の Dexie 化 (頻度低、 mirror 価値疑問) |
| `/app/exams` の status polling | `/api/exams/status` 5s 間隔 | `source_documents` mirror + push notification or visibilitychange トリガで polling 化 |

### 3.2 client が server を叩く path (mutation / fetch)

| 経路 | 種別 | 頻度 | Dexie 経由化の余地 |
|---|---|---|---|
| `PullTrigger` → `/api/cards/pull` | client fetch | dashboard mount 毎 | rate-limit + sync_meta.last_pull_at で skip 可 |
| `PullTrigger` → `/api/exams/pull` | client fetch | 同 | 同 |
| `DashboardStats` → `/api/dashboard/stats` | client fetch | dashboard mount 毎 | Dexie answer_events 集計で消去可能 |
| `exam-status-live` → `/api/exams/status` | client fetch (5s polling) | processing 中のみ | source_documents mirror があれば不要 |
| `delete-button` → `/api/me/deletion-status` | client fetch (3s polling) | アカウント削除中のみ | low priority、 mirror 不要 |
| `flushPendingEvents` → `/api/review-events/bulk` | client fetch | 5 件 or session 終了 or 30s timer | mutation push、 不可避 |
| inline 編集 cell → `update-card-field` server action | server action (500ms debounce) | **編集中の毎 cell 毎** | `card_mutations` Dexie write + bulk push 配線で消去可能 |
| `update-card` / `delete-card` server action | mutation | 編集 page 保存 / 削除時 | `card_mutations` Dexie + bulk push で server reach 遅延化可 |
| `delete-exam` server action | mutation | exam 削除時 | 同 (新 table が要る、 exam_mutations なし) |
| `save-fsrs-mode` / `save-session-limit` server action | mutation | 設定保存時 | `user_settings` Dexie write 配線で local 反映即時化 |
| `process` server action (upload) | mutation (OCR kickoff) | upload click | 不可避 (server-side OCR 処理開始) |

### 3.3 inline 編集 (`update-card-field`) の特殊性

- `/app/exams/[id]` の各 cell が 500ms debounce 後に server action を呼ぶ (500ms debounce は `inline-text-field.tsx:164`、 `inline-option-row.tsx:143` で実装)
- 1 edit = 1 server action = 1 users SELECT + 1 cards UPDATE
- `card_mutations` table が schema 定義のみで write 未配線 = Dexie 経由化されていない
- 編集中の体感が rough、 cold 時は debounce 後 500ms 待ち + Neon 1-2s で**最大 2.5s の latency**
- これを `card_mutations` bulk push 化すれば: Dexie write 5ms + Optimistic UI 即時反映 + 後で bulk push (現状の answer_events と同 pattern)

### 3.4 `router.refresh()` → server SSR 再実行のチェーン

mutation 後の `router.refresh()` が server SSR を再度トリガし、 また Neon に問い合わせている: 

- `delete-exam-button` → refresh → `/app/exams` SSR (exams + status query)
- `fsrs-mode-form` → refresh → `/app/settings` SSR (userSettings query)
- `exam-status-live` の processing → completed 検知 → refresh → `/app/exams` SSR
- inline 編集は router.refresh 不要 (Next.js 15 default staleTimes.dynamic=0 で次 navigation 時 fresh)

→ Dexie source-of-truth 化が進めば `router.refresh()` は不要、 client state 更新だけで済む (= server reach ゼロ化への道筋)

### 3.5 IDB 経路を実際に使っている画面 (現状)

- **/app/study/smart** のみ (StudySessionHost が S-local-3 hybrid: Dexie 優先 + server fallback)
- それ以外は **全て server から fresh fetch** = mirror あるのに使っていない

---

## §4. middleware / runtime / edge 設定

### 4.1 middleware (`middleware.ts`)

- `clerkMiddleware` で `/app(.*)` のみ protect (`auth.protect()` 呼出)
- `/api/*` は middleware に通っているが、 protection なし (各 route 内で `getCurrentUser()` 呼出)
- matcher は静的アセット (\.html?, \.css, \.js, 画像 / フォント等) を除外
- `contentSecurityPolicy: {}` で Clerk default CSP を採用
- **edge runtime** (Clerk middleware は edge で動く)
- 副作用: 全 navigation で middleware 経由 JWT decode (network なし、 ms 単位)

### 4.2 API route の runtime

- `runtime = 'nodejs'` を明示している route: `/api/cards/pull`, `/api/dashboard/stats` (他は default)
- `getDb()` (Neon + drizzle) は node runtime 想定 (HTTP driver か Direct connection か要確認)

### 4.3 layout.tsx (`/app/layout.tsx`)

- `getCurrentUser()` を await
- `user === null` → SyncingPage を render (webhook race の transitional UI)
- `user.deletedAt` → /sign-out-deleted に redirect
- 通常時 → `<AppHeader />` + children

→ **全 /app 配下 navigation で layout の users SELECT が 1 回必ず走る**。 layout users SELECT 撤去 (= JWT private metadata 化 or middleware で前置 cache) が baseline 性能の根本改善路

---

## §5. クロスリファレンス: 「server reach の構造的累積」

`/app` を 1 回開いただけで発生する server reach (cold 時の合計コスト):

```
[1] middleware: clerkMiddleware JWT decode (ms 単位)
[2] layout SSR: users SELECT (Neon cold +2s)
[3] page SSR: cards.count(due<=now) (同一 RSC 内 [2] と dedupe で 1 SELECT 追加)
[4] post-hydration: PullTrigger → /api/cards/pull (users SELECT + cards SELECT、 cold +2s)
[5] post-hydration: PullTrigger → /api/exams/pull (users SELECT + exams SELECT、 cold +2s)
[6] post-hydration: DashboardStats → /api/dashboard/stats (users SELECT + streak 2 SELECT、 cold +2s)
```

**並列度**: [4][5][6] は client 側 fetch なので parallel に発射。 ただし Neon は同 user に対する複数 connection を別々の compute で warm-up することがあり、 結果的に **3 本とも 2s** という計測値になる。

**[2] と [3] は同 RSC で dedupe される** (React.cache) ため、 doc stream の 1678ms は **1 users SELECT + 1 cards SELECT (sequential、 Drizzle await 直列)** の総和。

**theorectical floor**: middleware は ms 単位、 [2] のみ Neon 1 回、 [3]-[6] を全て Dexie 化したら、 doc stream は ~800ms (cold users SELECT のみ) に落ちる。 + [2] も撤去 (JWT private metadata 化) すれば doc stream ~50ms (edge cache hit)。

---

## §6. 改善候補の優先度マッピング

| 改善 | 影響範囲 | 推定削減 | 実装コスト | 依存 |
|---|---|---|---|---|
| **layout users SELECT 撤去 (JWT 化 or cache 化)** | **全 navigation** | -1500-2000ms cold | 中 (Clerk JWT claim 設定 / users cache 導入) | Clerk dashboard 操作要 |
| dashboard dueCount を Dexie projection | /app | doc stream -1000ms | 小 | cards mirror 既存 |
| /app/exams + detail を Dexie hybrid | /app/exams 系 | doc stream -800-1300ms | 小 | exams mirror 既存 |
| /api/dashboard/stats を client 集計 | /app | client fetch -2000ms | 中 (streak.ts client port) | answer_events mirror 既存 |
| PullTrigger を rate-limit 化 | /app | client fetch -2 本 | 小 | sync_meta 既存 |
| inline 編集を card_mutations Dexie 化 | /app/exams/[id] 編集 | 編集 latency -2s | 中 | card_mutations 配線 + bulk push API 新規 |
| user_settings の Dexie 配線 | /app/study/smart 起動 + /app | -1 SELECT (cold +2s) | 小 | mirror 自体は schema 済 |
| source_documents の Dexie mirror 化 | /app/exams + /app/upload + status polling | 多経路で -1 SELECT | 中 | 新 mirror table + pull endpoint |
| Service Worker (app shell precache) | 全 navigation の document | -doc stream ほぼ全部 | 大 | 別 sprint (Phase ε) |
| Neon warm-up pinger (Vercel cron) | cold start 全般 | 全 query -1-2s cold | 小 | 応急処置、 production traffic 増で不要化 |

---

## §7. local-first 全量プリフェッチ判断材料

### 「IDB 全量プリフェッチ + local-first」 で達成可能になること:

- /app の doc stream を 1678ms → ~50ms (cache hit)、 LCP 1854ms → ~200ms
- /app/exams の LCP を 1011ms → ~200ms (4 exams ÷ Dexie read 数 ms + render)
- /app/exams/[id] の LCP を 1494ms → ~200ms
- /app/study/smart は既に達成 (S-local-3)
- /app/upload は exams 一覧部分のみ Dexie 化可能、 source_documents は別 mirror 要

### 達成できない / コストが残る部分:

- middleware の Clerk JWT decode (ms 単位、 無視可)
- 初回 visit (Dexie 空) は必ず server fetch → skeleton 必須
- mutation (server action) 発火 → server reach は不可避 (ただし Optimistic UI + Dexie write で体感 0ms 化可能)
- OCR / 課金系の API は server-only (アーキ制約)
- 設定変更 (Clerk dashboard) を要する layout users SELECT 撤去は実装難易度中

### 期待値:

- **2 回目以降 navigation: 300ms 内達成** は十分視野 (Top 改善 §6 上 4 件で /app 体感 ~600ms、 + SW で ~150ms)
- **初回 navigation**: skeleton + background fetch で目視 ~600ms、 完了 ~2s (現状と同程度) は許容範囲

---

## §8. 補足: ファイル別 server reach マトリクス (1 シート版)

| 画面 / endpoint | middleware | layout user SELECT | page query | post-hydration fetch | mutation server action |
|---|---|---|---|---|---|
| `/app` | ◯ | users (cached with page) | cards.count(due) | stats + cards pull + exams pull | — |
| `/app/exams` | ◯ | users | exams + cards count GROUP BY + sourceDocuments | (条件付) status polling | delete-exam |
| `/app/exams/[id]` | ◯ | users | exam + cards (serial) | — | update-card-field (debounce 500ms / cell) |
| `/app/study/smart` | ◯ | users | userSettings + getSessionCards | answer_events bulk flush | (submit-review は新経路で未使用) |
| `/app/upload` | ◯ | users | sourceDocuments status + (条件付) exams + ai_usage | — | process |
| `/app/cards/[id]` | ◯ | users | cards.id | — | update-card / delete-card |
| `/app/settings` | ◯ | users | userSettings | (条件付) deletion polling | save-fsrs-mode / save-session-limit / 他 |
| `/app/upgrade` | ◯ | users | — | — | upgrade actions |

`/app` だけ post-hydration で 3 本も client fetch が走るのが目立つ。 これは「dashboard だけが PullTrigger + DashboardStats の 2 つの 'mount 後に fetch する' client component を抱えている」 構造のため。
