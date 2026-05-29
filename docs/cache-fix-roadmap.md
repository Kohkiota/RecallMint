# RecallMint cache-fix ロードマップ

- 起票日: 2026-05-27
- 最終更新: 2026-05-29 (問題 2/3 クローズ反映 + Small Fix ④-1〜④-4 を実コード verify 済)
- 種別: roadmap (perf / cache / local-first の進捗 + 未対応の集約)
- スコープ: dashboard 体感速度 ~2,100ms → ~100ms を目指す、 5/26 計測 (stg-perf-measurement-pre-local-first) からの差分集約
- 母艦 docs (詳細はこちら):
  - 計測: `docs/superpowers/sessions/2026-05-26-stg-perf-measurement-pre-local-first.md`
  - audit: `docs/superpowers/sessions/2026-05-26-cache-auth-idb-wiring-audit.md`
  - inventory: `docs/superpowers/sessions/2026-05-26-localdb-inventory.md`
  - local-first 母艦 design: `docs/superpowers/specs/2026-05-26-s-local-1-design.md`
  - JWT template: `docs/superpowers/sessions/2026-05-26-jwt-template-setup.md`

本 doc は「対処済 / 未対応」 を一目で見るための集約 view。 各項目末尾に **実コード verify** の出典を付ける。

---

## 1. 現状スナップショット (計測時点: 2026-05-26 stg)

| 画面               | 体感終端 | 主な原因                                                                         |
| ------------------ | -------- | -------------------------------------------------------------------------------- |
| `/app`             | ~2,100ms | dueCount SELECT + post-doc 3 本 (dashboard stats / cards pull / exams pull) 並走 |
| `/app/exams`       | ~1,000ms | exams + cards count + source_documents SELECT                                    |
| `/app/exams/[id]`  | ~1,500ms | exam + cards 直列 2 SELECT                                                       |
| `/app/study/smart` | ~1,200ms | user_settings + cards SELECT                                                     |
| `/app/upload`      | ~1,200ms | source_documents + exams + ai_usage SELECT                                       |

**真因**: IDB に cards / exams が既に入っているのに、 ページ訪問のたびに全量 Supabase に問い合わせている。

> 数値の元: `docs/superpowers/sessions/2026-05-26-stg-perf-measurement-pre-local-first.md` §A。

---

## 2. ✅ 対処済

| 内容                                              | verify (実コード)                                                                                                                                                                   | 効果                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **JWT に dbUserId / plan 同梱 (C1-C3)**           | `lib/auth/ensure-user.ts:69-82` (`getAuthContext()` 実装)、 `types/clerk.d.ts:25-32` (sessionClaims 型拡張)、 `lib/auth/clerk-metadata.ts:26-52` (`syncClerkPublicMetadata`)        | page.tsx の DB SELECT を JWT 読みに切替                                     |
| **getAuthContext() を主要 4 page に配備**         | `app/(app)/app/upload/page.tsx:33`、 `exams/page.tsx:30`、 `exams/[id]/page.tsx:26`、 `cards/[id]/page.tsx:19`                                                                      | dbUserId / plan を JWT 経由で取得、 fallback 経由で users SELECT 撤去       |
| **study_days Dexie mirror + pull endpoint**       | `lib/client-db.ts:163-169` (`ClientStudyDay` 型 + v2 store)、 `lib/sync/study-days.ts`、 `app/api/study-days/pull/route.ts`、 `lib/sync/sync-meta.ts:16` (`lastStudyDayPullAt` key) | streak / todayCount の IDB 化の前提                                         |
| **dueCount IDB 化 (server SSR SELECT 撤廃)**      | `app/(app)/app/page.tsx:6-14` のコメント「dueCount の server SSR SELECT を撤去」、 同 file に cards count SELECT 無し                                                               | `/app` の post-doc API `/api/dashboard/stats` の 2,087ms を撤廃             |
| **streak / todayCount client 集計**               | `pull-trigger.tsx:29-31` (`pullAllStudyDays`) + DashboardActions / DashboardStats が Dexie 由来 (`page.tsx:27-29` でも user.id を渡すだけ)                                          | 同上                                                                        |
| **S-local-3: smart session の Dexie 優先 read**   | `app/(app)/app/study/smart/page.tsx:33-38` (`getSessionCards()` try/catch、 throw 時 cards=[])、 `StudySessionHost` が Dexie cards mirror から read                                 | smart 復習の起動高速化、 server fail でも client で続行                     |
| **Neon driver → postgres.js (Supabase 移行)**     | `lib/db/index.ts:6` (`import { drizzle } from 'drizzle-orm/postgres-js'`)、 直近 commit `b57af4d` / `fe3a2d2` / `df163e2`                                                           | cold start ~2s 問題の根本解消 (driver 切替済、 接続先 Supabase は env 依存) |
| **PullTrigger を (app) layout mount で fire (④-1 済)** | `app/(app)/app/layout.tsx:51` で `<PullTrigger />` 配置 (page.tsx から layout へ移動済 = `/app/*` 全ページで発火)                                                                  | dashboard / smart 等 `/app/*` 全訪問で cards / exams / study_days を background pull |
| **S-local-4: server fetch fail でも render 継続** | `app/(app)/app/study/smart/page.tsx:33-38` (catch 内 `serverCards = []`)、 host 側で empty UI 一元化                                                                                | offline / server 5xx 耐性                                                   |
| **`<Link>` prefetch={false} (S-perf-1 / ④-2 済)**          | `app-header.tsx` 全 nav link + `page.tsx` / `exams/page.tsx:80` / `exams/[id]/page.tsx` / `settings/page.tsx` (法的 4 link) / `dashboard-actions.tsx:72` / `upload/page.tsx` 等に `prefetch={false}` 適用済                                                                                                 | header nav + 主要遷移 link の RSC 並走を撤廃                                          |
| **問題 2: flush 並走重複の解消 (in-flight guard)** | `lib/sync/review-events.ts` の `inFlightEventIds` Set (event_id 単位で並走 flush 除外)、 commit `5e86839 fix(study) [reviewed]` / smoke `6eb8dc9`                                  | 経路 1↔2 の二重 POST 解消 (5 events を 1 POST に集約)                       |
| **問題 3: bulk endpoint per-event tx → 単一 tx + bulk SQL** | `app/api/review-events/bulk/route.ts` (single tx + replayCard fold + cards VALUES UPDATE)、 Drizzle #5789 fix (`0e78ef0`) 含む。 closure `docs/superpowers/sessions/2026-05-29-problem3-bulk-refactor-closure.md` | smart session 完了時の bulk flush **16.7-17.4s → 4.8s** (stg smoke 確認)   |

---

## 3. 🔜 Sprint Pre-investigation (LocalSync MVP の前提確認)

**状態: 3 項目中 2 件は問題 3 で確定済 → 残は Clerk revokeSession 調査のみ (Sprint ⑤ の前段)。**

- [x] `study_sessions` の flush 実装状況確認 → **確定済**。 `/api/review-events/bulk` が session upsert (Phase 0、 tx 外) を完結。 問題 3 pre-investigation + 実 DB smoke で動作確認 (`docs/superpowers/sessions/2026-05-28-problem3-sync-layer-pre-investigation.md` 軸 1 / closure)
- [x] 演習中の cards/options snapshot → **確定済**。 `session-runner.tsx` の React state (props.cards) で事実上 snapshot 成立、 専用 IDB table 不要 (§5.1 「割り切り」 と整合)
- [ ] Clerk `revokeSession()` の即時性確認 (Context7 経由で公式 doc / JWT verification 挙動) → **未着手** (Sprint ⑤ の前段、 §6 に集約)

> 残 1 件 (Clerk) は §6 Sprint ⑤ の pre-investigation と同一。 LocalSync MVP 着手の blocker ではない。

---

## 4. ✅ Sprint Small Fix (④-1〜④-4 全完了、 2026-05-29 実コード verify 済)

LocalSync MVP の前段小タスク群。 4 件すべて実装済を grep / 実コードで確認。

### ④-1. PullTrigger 全ページ配備 → ✅ 済

`<PullTrigger />` は `app/(app)/app/layout.tsx:51` に配置 (page.tsx → layout へ移動済)。 `/app/*` 全ページ
(dashboard / smart / exams / upload 等) で mount fire = deep link / reload でも IDB pull が走る。 page.tsx 側の
配置は撤去済 (残るのは `page.tsx:15` の説明 comment のみ)。

### ④-2. `<Link prefetch={false}>` 漏れ → ✅ 済

app-header (5 nav link) に加え、 `page.tsx` / `exams/page.tsx:80` (試験リスト) / `exams/[id]/page.tsx` /
`settings/page.tsx:130-145` (法的 4 link) / `dashboard-actions.tsx:72` (CTA) / `upload/page.tsx` /
`study-session-host.tsx` 等、 roadmap で挙げた対象 link すべてに `prefetch={false}` 適用済。

### ④-3. `/app/cards/[id]` 廃止 → ✅ 済 (個別 page 撤去、 inline 編集に統合)

`app/(app)/app/cards/` ディレクトリは**存在しない** (S2.0b-1 T3 で `/app/exams/[id]` の inline 編集 cell に統合)。
`/app/cards` への live link / `router.push` はゼロ (残るのは `exams/[id]/page.tsx:14` / `update-card-field.ts:156`
の歴史 comment のみ)。 inline 編集は `update-card-field.ts:143` の Drizzle 直 UPDATE で完結し、 旧 page に非依存。

### ④-4. `notifyOps` Not Found 修正 → ✅ 済

`lib/auth/clerk-metadata.ts:53-55` で Clerk user-not-found 時は `notifyOps` を fire せず `console.debug` 1 行のみ
(silent skip)。 真の失敗時のみ `notifyOps` (`:60`)。 手動削除 user への Stripe webhook 由来の 404 spam を解消。

---

## 4.5 ✅ Step 3a / 3b — bulk endpoint root cause + FSRS rate 確定タイミング (両方クローズ済)

(2026-05-27 起票時は LocalSync MVP の前提整備として bulk 遅延要因の切り分けを予定。
2026-05-28〜29 に問題 2 / 問題 3 として独立クローズした。)

### Step 3b → ✅ 問題 2 としてクローズ (flush in-flight guard)

旧 Step 3b (FSRS rate 連打で events 累積 → bulk 肥大) は問題 2 (flush 並走重複) として
実装クローズ。 rate-then-confirm + `inFlightEventIds` の event_id 単位 guard で、 連打は state
上書きのみ・確定時に 1 件 record・並走 flush の二重送信を排除。 commit `5e86839 fix(study) [reviewed]`、
smoke `6eb8dc9`。 詳細: `docs/superpowers/sessions/2026-05-28-problem2-stg-smoke.md`。

### Step 3a → ✅ 問題 3 としてクローズ (bulk refactor)

旧 Step 3a (bulk TTFB 10-17s の root cause 切り分け) は問題 3 (bulk refactor) として完了。
per-event serial transaction × N が主因と確定 → 単一 tx + in-memory FSRS replay (`replayCard`) +
bulk SQL (cards VALUES 単一 UPDATE) に畳み、 stg smoke で **16.7-17.4s → 4.8s** (~3.5x)。
途中、 実 Postgres で Drizzle #5789 (sql template に Date を embed → postgres-js encode で TypeError)
に当たり、 観測強化 (serializeDbError) → ISO string bind 化で fix。 詳細:
`docs/superpowers/sessions/2026-05-29-problem3-bulk-refactor-closure.md`。

> TEMP-MEASURE 計測コード (per-phase timing / `BULK_FULL_PARAMS_LOG`) は性能内訳確定後に撤去予定 (問題 3 closure §6)。
> LocalSync MVP の card_mutations bulk push は本 bulk pattern (単一 tx + ON CONFLICT DO NOTHING + RETURNING 件数照合) を踏襲する。

---

## 5. 🔜 LocalSync MVP — card 編集 / 削除の local-first 化 (Phase β-1)

### 5.1 スコープ確定事項 (2026-05-27 議論結果)

**MVP の目的**: inline 編集 / card 削除の体感を ~2.5s → ~50ms にする。 LocalSync 全体の完成ではなく、 `card_mutations` に対象を絞った最小実用版。

#### MVP でやる

| 対象                          | 内容                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| card update / card delete     | IDB 即時反映 + `card_mutations` に mutation 追加 (同一 Dexie tx)                                                                                                                                  |
| bulk push API                 | `/api/card-mutations/bulk` を新設、 `review-events.ts` pattern 踏襲                                                                                                                               |
| 冪等性                        | `mutation_id = ${clientId}:${uuid}` UNIQUE + ON CONFLICT DO NOTHING                                                                                                                               |
| 状態管理                      | `pending` / `synced` / `failed` の 3 状態のみ (`syncing` 持たない)                                                                                                                                |
| trigger                       | ① 操作直後 debounce 2s push only<br>② route mount TTL 60s push→pull<br>③ visibilitychange (hidden→visible) TTL 60s push→pull<br>④ online event push→pull<br>⑤ pagehide best-effort (confirm 不要) |
| 編集画面 / 演習中の pull 抑制 | `/app/exams/[id]` + `/app/study/*` mount 中は pull 抑制 (push のみ)                                                                                                                               |
| pull 設計                     | `cards.updated_at` ベースの Δ pull (`?since=...`)、 削除は full replace で自動消去                                                                                                                |
| dirty 上書き防止              | `sync_status='pending'` の card は pull で上書きしない                                                                                                                                            |
| 競合解決                      | last-write-wins、 server 到達時刻 (Anki 方式) で比較                                                                                                                                              |
| retry                         | 5xx / network: 有限リトライ (5 回) + exponential backoff (10s → 30s → 1min → 5min → 15min)<br>4xx: 即 `failed` 隔離 (自動 retry 停止)<br>409 duplicate: synced 扱い                               |
| 古い tab 対策                 | 24h 超 pending mutation は silent drop、 その後通常 push→pull                                                                                                                                     |
| user 切替分離                 | `sync_meta.dbUserId` 照合 → 不一致なら IDB 全 clear + 再 pull                                                                                                                                     |
| 多重 flush 防止               | Web Locks API (`navigator.locks.request('localsync-flush')`)、 非対応ブラウザは UNIQUE で server 吸収                                                                                             |

#### MVP で割り切り / 見捨て

| 内容                                              | 理由                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| global seq / `MUTATION_SEQUENCE_GAP`              | stuck の危険、 mutation_id UNIQUE 冪等で十分                           |
| `sync_clients` / `sync_mutations` table           | global sequencing 不要なら不存在で OK                                  |
| unified `sync_outbox`                             | 既存 review-events.ts pattern コピーで十分、 設計変更コスト大          |
| `serverRevision` (global monotonic counter)       | row 単位 `updated_at` cursor で十分                                    |
| scope 付き pull                                   | cursor 取りこぼし事故が怖い、 table 別 cursor で十分                   |
| `exam_mutations`                                  | exam 編集頻度低、 server action 直叩き維持 (v2 で再検討)               |
| `study_sessions` 独立 flush                       | 既存 `/api/review-events/bulk` で完結 (pre-investigation で確認)       |
| `user_settings` mirror                            | 設定変更頻度極低、 別 sprint                                           |
| `source_documents` / `upload_records` mirror      | 別 sprint (⑥ で対応)                                                   |
| `plan` IDB authoritative 化                       | IDB 改ざんで free→pro 不正利用の穴、 60s ラグ許容                      |
| マルチタブ leader election / BroadcastChannel     | UNIQUE で server 吸収、 overkill                                       |
| `session_cards_snapshot` 専用 IDB table           | session-runner の React state で事実上 snapshot 機能、 新規 table 不要 |
| 演習中 5 問ごと push                              | 既存 review-events で配線済、 LocalSync は触らない                     |
| 30s 保険 interval                                 | trigger ①〜⑤ でカバー、 bookkeeping 複雑化回避                         |
| CRDT / merge UI / contentVersion OCC              | overkill、 last-write-wins で割り切り                                  |
| cards soft delete (server 側 `deleted_at` 列追加) | hard delete + pull replace で IDB から自動消去、 schema migration 不要 |
| tombstone cron                                    | soft delete しないなら不要                                             |
| exam delete の LocalSync 化                       | exam_mutations 不採用なら自動的に対象外                                |
| 演習中 pull (IDB 書きつつ session に反映しない)   | 複雑化、 演習中は push-only mode で抑制                                |
| layout `deletedAt` 撤去                           | Sprint ⑤ で別途、 LocalSync MVP の対象外                               |

### 5.2 verify (現状の実装状態、 2026-05-29 再確認)

- Dexie schema (`lib/client-db.ts` の `ClientCardMutation` 型 + `:196` の store `card_mutations: '++local_id, mutation_id, card_id, sync_status'`) **定義済**
- **server schema `card_mutations` table は存在する** — `lib/db/schema.ts:601` `cardMutations` pgTable (id / `mutation_id` UNIQUE / card_id / user_id / `patch` jsonb / edited_at / applied_at / created_at)、 migration `0012_handy_ink.sql` で適用済。 ← 5/27 時点の「table なし」 から進捗 (S-cache-0 で先打ち)
- `lib/sync/card-mutations.ts` **不在** (`cards.ts` / `exams.ts` / `study-days.ts` / `review-events.ts` / `sync-meta.ts` のみ)
- `app/api/card-mutations/bulk/route.ts` **不在** (api 直下に card-mutations dir なし)
- inline 編集 (`update-card-field.ts:143` の `.update(cards).set(...)`) は **Drizzle 直 UPDATE のまま** (Dexie 書込 + card_mutations 経路は未配線)

→ **schema (Dexie + server + migration) は scaffold 済、 sync layer (helper / bulk route / orchestrator) + inline 編集の local-first 化が未着手**。 注: 適用済 schema は `patch jsonb` のみで `type ('update'|'delete')` 列は持たない → delete の表現方法 (patch 内 flag か列追加か) は実装時に要設計。

### 5.3 未対応タスク

- [x] **server schema migration**: `card_mutations` table は migration `0012_handy_ink.sql` で適用済 (`mutation_id` UNIQUE / user_id / card_id / `patch` jsonb / edited_at / applied_at + index)。 ※ `type ('update'|'delete')` 列は未追加 — delete 表現は実装時に要設計
- [ ] **`/api/card-mutations/bulk` route 新規作成**: `app/api/review-events/bulk/route.ts` パターン参照、 ON CONFLICT DO NOTHING で冪等化、 mutation 受信時に `server_received_at = NOW()` を打刻、 cards UPDATE 0 rows affected で 4xx 返却
- [ ] **`lib/sync/card-mutations.ts` 新規作成**: `review-events.ts` パターン参照、 pending push 関数 + sync_meta cursor
- [ ] **`lib/sync/local-sync.ts` (orchestrator) 新規作成**: 5 trigger の制御 + Web Locks 排他 + 編集画面 / 演習画面の pull 抑制判定 + 24h pending silent drop
- [ ] **pull endpoint Δ pull 対応**: `/api/cards/pull` に `?since=ISO8601` 追加、 sync helper を `clear+bulkPut` → `bulkPut` 増分上書きに変更
- [ ] **inline 編集 component の Dexie 書き込み + background push 化**: `update-card-field.ts` / `update-card.ts` を Drizzle 直 UPDATE から Dexie 書き込み + card_mutations 追加に差替、 optimistic UI
- [ ] **user 切替分離**: app mount 時に `sync_meta.dbUserId` 照合、 不一致なら IDB 全 clear
- [ ] **patch 圧縮**: 同 card_id + field の最新だけ送る (debounce + 重複削除)

### 5.4 完了基準

- inline 編集 cell の体感 latency が ~2.5s → ~50ms (Dexie write のみ)
- background push が 2s debounce 後に走り、 server に到達
- マルチデバイスで pull 60s 以内に他端末の編集が反映
- offline 編集 → online 復帰時に自動 push 成功
- pending 24h 超は silent drop

---

## 6. 🔜 Sprint ⑤ — 認証コスト撤去 (LocalSync MVP とは別 sprint、 慎重に進める)

**問題:** `layout.tsx` が `getCurrentUser()` → users SELECT を全ページで実行 (deletedAt チェックのために残存)。

**verify:**

- `app/(app)/app/layout.tsx:28-38` で `getCurrentUser()` 呼出、 `if (user.deletedAt) redirect('/sign-out-deleted')`
- `lib/auth/ensure-user.ts:38-51` で DB SELECT (React.cache wrap 済だが SELECT 自体は発生)
- `app/api/webhooks/clerk/route.ts:140-235` の `handleUserDeleted` に `clerkClient.sessions.revokeSession` 呼出なし (現状 stripe cancel + soft delete のみ)

**未対応タスク (pre-investigation 必須):**

- [ ] Clerk `revokeSession()` の即時性確認 (公式 doc / Context7 経由)
- [ ] 既発行 JWT の verification 挙動を実機確認 (revoke 後の 60s window 実害測定)
- [ ] 結果に応じて: 撤去進める / 撤去保留 / 中間案 (JWT touch() で強制 refresh)
- [ ] (撤去進める場合) `user.deleted` webhook 内で `clerkClient.sessions.getSessionList({ userId, status:'active' }) → revokeSession()` を実装
- [ ] (撤去進める場合) layout.tsx の `deletedAt` チェックを削除
- [ ] (撤去進める場合) layout.tsx の `getCurrentUser()` を削除

**注意 (構造的限界、 Context7 確認済):** Clerk JWT は self-contained で revoke 不可。 revokeSession を呼んでも既発行 JWT は次の自動 refresh (~60s) まで valid。 = layout の deletedAt redirect 撤去で **最大 60s の zombie window** が再現する。 marketing/page.tsx (`:24`) と marketing/pricing/page.tsx (`:15`) の deletedAt 依存は別用途のため zombie net とは切り分け、 残置検討。

**効果:** 全ページ baseline ~2s → ~0ms (Supabase 移行で既に大半解消、 残コストは React.cache 由来の 1 SELECT/request)。

---

## 7. 🔜 新規開発タスク (LocalSync MVP 完了後)

### ⑥ source_documents / upload_records を IDB mirror 化 (未対応)

**問題:** `/app/upload` で OCR 進捗 / 今月残数を Supabase 直読みしている。

**verify:**

- `lib/client-db.ts` に `source_documents` / `upload_records` の Dexie table なし (定義されているのは exams / cards / user_settings / study_sessions / answer_events / card_mutations / sync_meta / study_days のみ)
- `app/(app)/app/upload/page.tsx:85` で `getCurrentMonthOcrPages(userId)` を server 直読み
- 集計元は `upload_records` (S1.9.1 で `ai_usage` から切替済): `lib/ai-usage-mcq.ts:1-43` のコメントで明示

**未対応タスク:**

- [ ] `source_documents` Dexie mirror + pull endpoint (OCR processing 状態の表示用、 既存 5s polling は維持して併存)
- [ ] `upload_records` Dexie mirror + pull endpoint (今月 OCR 残数 / append-only / Δ pull 向き)
- ⚠️ 集計元は `ai_usage` ではなく `upload_records` (S1.9.1 で切替済、 `lib/ai-usage-mcq.ts:3` で明示)
- ⚠️ 課金 / OCR 上限判定は **server authoritative 維持**。 IDB は表示用のみ (改ざんで quota bypass されないよう server gate 必須)

### ⑦ user_settings mirror (未対応、 優先度低)

**問題:** fsrs_mode / session_limit の取得で server SSR 経由している。

**未対応タスク:**

- [ ] `/api/user-settings/pull` 新設
- [ ] `lib/sync/user-settings.ts` 新設
- [ ] settings 画面の save action を Dexie 即時反映 + background push 化

---

## 8. IDB 配線状況メモ

### 配線済み (read 済)

| データ                              | Dexie table      | verify                            |
| ----------------------------------- | ---------------- | --------------------------------- |
| cards (due filter / exam_id filter) | `cards`          | `lib/client-db.ts:191`            |
| exams                               | `exams`          | `lib/client-db.ts:190`            |
| study_days                          | `study_days`     | `lib/client-db.ts:202` (v2 store) |
| answer_events                       | `answer_events`  | `lib/client-db.ts:195`            |
| study_sessions                      | `study_sessions` | `lib/client-db.ts:194`            |

### schema / mirror はあるが pull endpoint / write 未配線

| データ         | 状態                                                      | verify                                                               |
| -------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| card_mutations | Dexie + **server schema (migration 0012) 定義済** / sync helper・bulk route 未実装 / inline write 未配線 | `lib/client-db.ts:196`、 `lib/db/schema.ts:601`、 `app/api/card-mutations/` 不在 |
| user_settings  | pull endpoint 自体なし                                    | `lib/client-db.ts:193` (schema あり) / `app/api/user-settings/` 不在 |

### mirror 自体なし (新規開発要)

| データ           | 用途                                              | verify                                        |
| ---------------- | ------------------------------------------------- | --------------------------------------------- |
| source_documents | `/app/upload` OCR 進捗 / `/app/exams` status 表示 | Dexie に table 定義なし                       |
| upload_records   | 今月 OCR 残数 (quota) 集計                        | 同上、 `lib/ai-usage-mcq.ts` で server 直読み |

---

## 9. 体感速度の改善見込み

| マイルストーン                                                                    | 体感終端    |
| --------------------------------------------------------------------------------- | ----------- |
| 計測時点 (Neon cold start 時代、 2026-05-26)                                      | ~2,100ms    |
| 現在 (Supabase 移行 + JWT 化 + dueCount IDB 化、 2026-05-27 時点)                 | ~500ms 前後 |
| Sprint Small Fix 完了後 (PullTrigger 全ページ + prefetch 漏れ修正)                | ~400ms 前後 |
| LocalSync MVP 完了後 (card 編集 ~50ms / Δ pull / dirty 保護 / 編集画面 pull 抑制) | ~200ms 以下 |
| ⑤ layout SELECT 撤去後 (deletedAt redirect 撤去 + revokeSession)                  | ~100ms 以下 |

> 註 (2026-05-29): 上表は dashboard / page-load (体感終端) の軸。 問題 2/3 はこの page-load には直接影響しない**別軸 = 演習完了時の bulk flush latency** (`/api/review-events/bulk`) を **16.7-17.4s → 4.8s** に短縮 (問題 3、 stg cold 単発)。 演習完了 → `/app` 遷移直後の体感に効く。 page-load 数値 (~500ms 等) は再計測未実施につき 5/27 値据え置き。

---

## 10. 進行順序 (2026-05-29 更新)

```
✅ Sprint Pre-investigation (study_sessions / cards snapshot = 問題 3 で確定済、 残は Clerk revokeSession 調査のみ)
✅ Sprint Small Fix (④-1〜④-4 全完了)
✅ 問題 2 (flush in-flight guard) / 問題 3 (bulk refactor)
    ↓ ここから未着手
LocalSync MVP (card_mutations: server schema scaffold 済、 sync helper + bulk route + inline 編集 local-first 化が残)
    ↓
Sprint ⑤ (Clerk revokeSession 調査 → layout deletedAt 撤去判断、 別軸で慎重に)
    ↓
Sprint ⑥⑦ (source_documents / upload_records / user_settings mirror)
```

註: cache 領域の進行順序は本 doc。 **全 sprint 横断** (試験セット手動作成 / S2.0.5 / S2.1 / S2.0b / Pro→Standard 等) の優先順位は `docs/next-sprints-priority.md` を参照。

---

## 11. 参照ドキュメント

- 計測詳細: `docs/superpowers/sessions/2026-05-26-stg-perf-measurement-pre-local-first.md`
- cache / auth / IDB audit: `docs/superpowers/sessions/2026-05-26-cache-auth-idb-wiring-audit.md`
- IDB 配線 inventory: `docs/superpowers/sessions/2026-05-26-localdb-inventory.md`
- JWT template 設定: `docs/superpowers/sessions/2026-05-26-jwt-template-setup.md`
- S-local-1 design (Phase map): `docs/superpowers/specs/2026-05-26-s-local-1-design.md`
- S-local-2 cards pull MVP plan: `docs/superpowers/plans/2026-05-26-s-local-2-cards-pull-mvp.md`
- S-local-3 smart session local read plan: `docs/superpowers/plans/2026-05-26-s-local-3-smart-session-local-read.md`
- S-local-4 offline smart session plan: `docs/superpowers/plans/2026-05-26-s-local-4-offline-smart-session.md`
- S-cache 系列 close: `docs/superpowers/sessions/2026-05-26-s-cache-series-close.md`
- IDB schema: `lib/client-db.ts`
- PullTrigger: `app/(app)/app/_components/pull-trigger.tsx`
- sync_meta: `lib/sync/sync-meta.ts`
- review-events パターン (bulk push の参考): `lib/sync/review-events.ts` / `app/api/review-events/bulk/route.ts`
