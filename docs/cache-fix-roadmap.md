# RecallMint cache-fix ロードマップ

- 起票日: 2026-05-27
- 最終更新: 2026-05-27 (LocalSync MVP 設計議論完了)
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
| **PullTrigger を dashboard mount で fire**        | `app/(app)/app/_components/pull-trigger.tsx:14-34`、 `app/(app)/app/page.tsx:24` で `<PullTrigger />` 配置                                                                          | dashboard 訪問時に cards / exams / study_days を background pull            |
| **S-local-4: server fetch fail でも render 継続** | `app/(app)/app/study/smart/page.tsx:33-38` (catch 内 `serverCards = []`)、 host 側で empty UI 一元化                                                                                | offline / server 5xx 耐性                                                   |
| **`<Link>` prefetch={false} (S-perf-1)**          | `app/(app)/app/_components/app-header.tsx` 全 nav link に `prefetch={false}` 適用済                                                                                                 | header nav 経由の RSC 9 並走を撤廃                                          |

---

## 3. 🔜 Sprint Pre-investigation (LocalSync MVP の前提確認、 即実施)

LocalSync MVP の spec 確定前に Claude Code に調査させる項目。 commit なし、 session log のみ。

**未対応タスク:**

- [ ] `study_sessions` の flush 実装状況確認 (既存 `/api/review-events/bulk` で session upsert 完結してるか)
- [ ] 演習中の cards/options が IDB に確実に snapshot 保存されているか (React state による事実上 snapshot の構造確認)
- [ ] Clerk `revokeSession()` の即時性確認 (Context7 経由で公式 doc / JWT verification 挙動)

> 完了基準: session log 1 本 (`docs/superpowers/sessions/YYYY-MM-DD-localsync-pre-investigation.md`) に調査結果記載。

---

## 4. 🔜 Sprint Small Fix (LocalSync と並行可、 即実施)

LocalSync MVP に着手する前に消化できる小タスク群。 各々独立、 並行進行可。

### ④-1. PullTrigger 全ページ配備 (page → layout 移動)

**問題:** PullTrigger は `/app` (dashboard) にしかなく、 `/app/study/smart` に直接アクセスすると IDB が空のまま演習開始。

**verify:** `app/(app)/app/page.tsx:24` のみに `<PullTrigger />` 配置、 `app/(app)/app/layout.tsx` には配置なし。

**未対応タスク:**

- [ ] `app/(app)/app/layout.tsx` に `<PullTrigger />` を移動 (`/app` 配下全ページで発火)
- [ ] `app/(app)/app/page.tsx` から `<PullTrigger />` を削除

> ※ rate-limit (TTL 5 分 skip) は LocalSync MVP の trigger 設計に内包するため、 ここでは単純移動のみ。

### ④-2. `<Link prefetch={false}>` 漏れ調査 + 追加

**問題:** `app-header.tsx` は S-perf-1 で対応済だが、 他に prefetch=true のままの link が残存している可能性。

**未対応タスク:**

- [ ] footer / 法的 link (`/terms` / `/privacy` / `/legal` / `/contact`) の `<Link>` 確認
- [ ] `/app/exams` の試験リスト link (`/app/exams/[id]` への遷移) 確認
- [ ] dashboard CTA (`dashboard-actions.tsx`) 確認
- [ ] 漏れがあれば `prefetch={false}` 追加

### ④-3. `/app/cards/[id]` 廃止判断

**問題:** 個別 card 編集 page (`/app/cards/[id]`) への到達経路が現状 UI に存在しないため、 不要なら削除。

**未対応タスク:**

- [ ] grep で `href="/app/cards/` / `router.push('/app/cards/` を全 component / page に対して検索
- [ ] `app/(app)/app/cards/[id]/_actions/update-card.ts` / `delete-card.ts` の参照元確認 (`/app/exams/[id]` の inline 編集が依存していないか確認、 依存ありなら別 path に移管 or 削除対象から除外)
- [ ] 経路ゼロ + 参照ゼロなら `app/(app)/app/cards/` 配下全削除 + 関連 test 削除
- [ ] LocalSync MVP の spec から `/app/cards/[id]` 抑制対象を除外 (削除した場合)

### ④-4. `notifyOps` Not Found エラー修正 (小)

**問題:** 手動削除したユーザーに Stripe webhook が `updateUserMetadata()` を呼んで Not Found エラー。

**verify:** `lib/auth/clerk-metadata.ts:38-51` の try/catch は **error 区別なし** で全て `ok:false + notifyOps` (404 silent skip 不在)。 caller は Stripe webhook (`app/api/webhooks/stripe/route.ts:230 / 260 / 294`)。

**未対応タスク:**

- [ ] `lib/auth/clerk-metadata.ts` の catch で Clerk 404 (`status === 404` or `clerkError === 'resource_not_found'`) を判定し silent skip に変更 (notifyOps fire しない)

---

## 4.5 🔬 Step 3a / 3b — bulk endpoint root cause 切り分け + FSRS rate 確定タイミング修正 (LocalSync MVP の前提整備)

(2026-05-27 追加。 LocalSync MVP は card_mutations bulk push を新設する pattern
で `/api/review-events/bulk` と同型のため、 既存 bulk の遅延要因を確定してから
設計する。)

### Step 3a: `/api/review-events/bulk` TTFB 10.7s root cause 切り分け (進行中)

- **観測**: stg で TTFB 10,733 ms (body 1ms)、 finished phase 直後の background
  flush で発生。 詳細は session log 計測予定
- **着手**: timing log を一時 inject + Server-Timing header 経由で per-op
  duration を取得する計測。 commit `8417e83 chore(perf): bulk endpoint 一時
  timing log (TEMP-MEASURE) [no-review]` で実装、 origin/develop 反映済 (Vercel
  stg auto deploy 反映済)
- **未実施**: Playwright で 1 session 流して Server-Timing 取得 + 連続 invoke で
  cold/warm 差観察 + EXPLAIN ANALYZE (dev DB 代替)
- **計測完了後**: 別 commit で timing log を **必ず revert** (stg / production
  をクリーンに戻す)

### Step 3b (NEW): FSRS rate 確定タイミング修正 (致命的バグ修正)

- **観測**: session-runner.tsx で FSRS rate click ごとに `recordAnswerEvent` を
  fire-and-forget で発火 → rate 連打 = events 累積 → bulk POST に連打回数分の
  events が乗る → server per-event serial transaction で TTFB が膨らむ
- **影響**: client tally は 1 card 1 加算固定 (`submittedCardIds` Set で重複
  防止) だが、 server reviews / study_days / cards.current_streak に **連打回数
  分の累積**が発生。 1 card 1 操作の UX 期待と不整合
- **OT 期待仕様**: rate click は state 更新のみ、 「次へ」 / 「前へ」 を押した
  時点で **最後の rate 値で 1 件だけ submit**
- **未着手**: 仕様変更 + 既累積データの整合性 (= reviews / study_days の過剰行を
  どう扱うか) を含むため、 spec → plan → execute の正規 flow で着手予定

### 進行順序 (2026-05-27 OT 議論結果)

1. ④-2 prefetch={false} を origin/main に ff merge + push (= Step 2 完全 close)
2. Step 3b (FSRS rate 確定タイミング修正) を先行 — events 累積を源流で解消すれば
   bulk 内容が正常 size に戻り、 Step 3a 計測のノイズが減る
3. Step 3a 計測再開 (timing log で per-op 計測 + EXPLAIN ANALYZE) — Step 3b 後
   の正常 size payload で server-side 遅延要因を確定
4. Step 3a で root cause 確定後、 LocalSync MVP (§5) の card_mutations bulk
   push を同じ pattern で設計

### push 反映 record (2026-05-27)

- origin/develop = `8417e83`、 Step 2 ④-2 + 前後計測 session log + Step 3a
  timing log まで stg に反映
- origin/main = `dfe20fa`、 Step 2 のうち ④-1 / ④-3 / ④-4 + smoke session log
  まで反映。 **④-2 はまだ main 未反映** (= OT 手動 ff merge + push 待ち)
- Step 3a の timing log (`8417e83`) は **production には絶対 deploy しない**
  方針、 計測完了後に revert commit を立てて origin/develop に push、 main 反映前
  に revert を取り込む

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

### 5.2 verify (現状の実装状態)

- Dexie schema (`lib/client-db.ts:144-152` の `ClientCardMutation` 型 + `:196` の store 定義 `card_mutations: '++local_id, mutation_id, card_id, sync_status'`) **定義済**
- `lib/sync/` 配下に `card-mutations.ts` 不在 (`cards.ts` / `exams.ts` / `study-days.ts` / `review-events.ts` / `sync-meta.ts` のみ)
- `app/api/card-mutations/` ディレクトリ不在 (`api/` 直下に `cards / exams / dashboard / me / review-events / study-days / webhooks` のみ)
- server schema にも `card_mutations` table なし (`lib/db/schema.ts` で確認、 §13.14 設計のみ)
- inline 編集 component (`update-card-field.ts` / `update-card.ts`) は Drizzle 直 UPDATE

### 5.3 未対応タスク

- [ ] **server schema migration**: `card_mutations` table 追加 (`mutation_id text UNIQUE`、 `user_id`、 `card_id`、 `type ('update'|'delete')`、 `patch jsonb`、 `client_edited_at`、 `server_received_at`、 index 数本)
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
| card_mutations | Dexie schema 定義済 / write 未配線 / bulk push API 未実装 | `lib/client-db.ts:196`、 `app/api/card-mutations/` 不在              |
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

---

## 10. 進行順序

```
Sprint Pre-investigation (study_sessions / cards snapshot 確認 / Clerk revokeSession 調査)
    ↓
Sprint Small Fix (並行 4 タスク: PullTrigger 配備 / prefetch 漏れ / cards/[id] 廃止 / notifyOps 404)
    ↓
LocalSync MVP (card_mutations bulk push + Δ pull + 5 trigger + 編集画面 pull 抑制)
    ↓
Sprint ⑤ (Clerk revokeSession 調査 → layout deletedAt 撤去判断、 別軸で慎重に)
    ↓
Sprint ⑥⑦ (source_documents / upload_records / user_settings mirror)
```

Sprint Small Fix と LocalSync MVP は依存関係薄いので、 Sprint Small Fix の一部 (notifyOps 404 / prefetch 漏れ) は LocalSync MVP と並行可。

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
