# S-local-2 cards pull MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RecallMint の cards / exams を server から Dexie に full snapshot で
pull する read-only mirror 基盤を立ち上げ、 dashboard mount 時に 1 回 background
で pull が走る状態にする。

**Architecture:** 2 新規 GET endpoint (`/api/cards/pull` `/api/exams/pull`) + 2
client sync helper (`lib/sync/cards.ts` `lib/sync/exams.ts`) + sync_meta accessor
(`lib/sync/sync-meta.ts`) + dashboard mount kick `<PullTrigger />`。 既存 Dexie
schema / `lib/sync/review-events.ts` pattern を流用、 schema 変更なし。

**Tech Stack:** Next.js 15 Route Handlers / Drizzle / Neon / Clerk / Dexie 4.4.2 /
Vitest + fake-indexeddb + @testing-library/react / TS strict

---

## Plan-wide rules + 設計方針

詳細根拠は `docs/superpowers/specs/2026-05-26-s-local-1-design.md`:

- **全件 full snapshot mirror** (per-exam / Δ pull は Phase β 以降)
- **read-only mirror**: client は cards.* を直接 mutate しない
- **silent retry**: 失敗時 console / UI 出力なし、 次トリガで再試行 (= exponential
  backoff なし、 既存 review-events と同方針)
- **trigger**: dashboard (`/app`) mount 時 1 回のみ (起動 / 復帰 / online 等は別 sprint)
- **UI なし**: pull 中 spinner / toast / skeleton を作らない
- **sync_meta cursor**: `last_card_pull_at` / `last_exam_pull_at` を ISO8601 で
  記録 (Phase α では記録のみ、 Δ pull の since として使うのは Phase β 以降)
- **Clerk auth 必須 / tenant isolation (`WHERE user_id`) / Cache-Control: no-store**
  を全 API route で適用
- **commit 規律**: 本 plan は executing-plans 経由で 1 commit (plan + 実装 + test)
  に集約。 `superpowers:requesting-code-review` skill (general-purpose subagent、
  template 改変なし) で formal review → Critical 0 / Important 0 → `[reviewed]` tag

## ファイル構成

新規: `app/api/cards/pull/route.ts(+test)` / `app/api/exams/pull/route.ts(+test)` /
`lib/sync/cards.ts(+test)` / `lib/sync/exams.ts(+test)` /
`lib/sync/sync-meta.ts(+test)` / `app/(app)/app/_components/pull-trigger.tsx(+test)`

修正: `app/(app)/app/page.tsx` (1 行追加で `<PullTrigger />` 配置)

---

## Task 1: sync_meta accessor

**Files:** Create `lib/sync/sync-meta.ts` + `lib/sync/sync-meta.test.ts`

**目的:** Dexie `sync_meta` table への type-safe read/write。 key 文字列タイポ防止。

**制約:**
- key 定数 export: `SYNC_META_KEYS = { lastCardPullAt: 'last_card_pull_at', lastExamPullAt: 'last_exam_pull_at' }`
- value は string only (ISO8601 用途)
- export: `getSyncMeta(key) → Promise<string | undefined>` / `setSyncMeta(key, value) → Promise<void>`
- `lib/client-db.ts` schema は変更しない

**完了条件:** vitest 4-5 case (初期 undefined / set→get / 上書き / unknown key
は型エラーで block)、 typecheck clean、 test 全通過、 review Critical 0

---

## Task 2: GET /api/cards/pull endpoint

**Files:** Create `app/api/cards/pull/route.ts` + `route.test.ts`

**目的:** user の全 cards を full snapshot で返却。

**制約:**
- Clerk `getCurrentUser()` で 401 / 500 ハンドル (`/api/dashboard/stats` と同 pattern)
- `WHERE user_id = ?` で tenant 絞り込み
- response shape: `{ cards: ClientCardRow[], now: string }` (now = ISO8601)
- ClientCardRow は Dexie `ClientCard` 型と field 名 (snake_case) / 型を一致、 Date 系
  (`due` / `last_review` / `created_at` / `updated_at`) は ISO8601 文字列に変換
- `since` query param は受信のみ、 ロジック無視 (Phase β placeholder)
- runtime: nodejs、 全 response に `Cache-Control: no-store`

**完了条件:** vitest 5-7 case (auth 401 / 0 件 / N 件 / 他 user 不含 / Date 文字列
/ since 無視で全件)、 build / test 通過、 review Critical 0

---

## Task 3: GET /api/exams/pull endpoint

**Files:** Create `app/api/exams/pull/route.ts` + `route.test.ts`

**目的:** user の全 exams を full snapshot で返却。 cards.exam_id 参照解決用。

**制約:**
- Task 2 と完全同 pattern (auth / tenant / Cache-Control / runtime / 全 case)
- response shape: `{ exams: ClientExamRow[], now: string }`
- archived 含めて全件返す (client filter は別 sprint)
- ClientExamRow は Dexie `ClientExam` 型と一致

**完了条件:** vitest 5-7 case (Task 2 同等)、 build / test 通過、 review Critical 0

---

## Task 4: lib/sync/cards.ts pull helper

**Files:** Create `lib/sync/cards.ts` + `cards.test.ts`

**目的:** server `/api/cards/pull` → Dexie `cards` table を atomic replace。
成功時のみ sync_meta update。

**制約:**
- `BulkApiClient` 同様の `PullApiClient` interface を定義し test では mock を注入
- 成功時: Dexie `cards.clear() + bulkPut(rows)` を **transaction 内で実行** + `setSyncMeta('last_card_pull_at', body.now)`
- 失敗時 (network throw / non-2xx / parse error): silent return、 Dexie / sync_meta 不変
- export: `pullAllCards(client?: PullApiClient): Promise<{ ok: boolean; count: number }>`
- console / UI 出力なし

**完了条件:** vitest 5-7 case (fake-indexeddb + mock client、 空→1 件 / 2 件→3 件で
replace / HTTP 500 / network throw / 0 件 pull)、 review Critical 0

---

## Task 5: lib/sync/exams.ts pull helper

**Files:** Create `lib/sync/exams.ts` + `exams.test.ts`

**目的:** Task 4 の exams 版。

**制約:** Task 4 と同 pattern、 sync_meta key は `last_exam_pull_at`、 export は
`pullAllExams(client?)`。

**完了条件:** Task 4 と同等 vitest 5-7 case、 review Critical 0

---

## Task 6: PullTrigger client component

**Files:** Create `app/(app)/app/_components/pull-trigger.tsx` + `pull-trigger.test.tsx`、
Modify `app/(app)/app/page.tsx` (1 行追加)

**目的:** dashboard mount 時に cards + exams pull を fire-and-forget で kick off。

**制約:**
- `'use client'` + useEffect(deps=[]) で mount 1 回
- `void Promise.all([pullAllCards(), pullAllExams()])` で並列、 await しない
- `return null` (UI なし)
- 失敗は silent (try/catch なし or catch して握り潰し)
- StrictMode 二重 mount 対策不要 (server 冪等 + Dexie replace で副作用なし)
- `page.tsx` への配置: import 追加 + JSX 内に `<PullTrigger />` を 1 箇所

**完了条件:** vitest RTL 3 case (mount で 2 helper 呼出 / UI 非表示 / 失敗で throw
しない)、 typecheck / test 通過、 review Critical 0

---

## Task 7: stg smoke 手順 (commit なし)

**Files:** なし

**目的:** OT 実機検証手順を提示。

**手順:** stg login → `/app` → DevTools Application → IndexedDB → `recall-mint` で
(1) `cards` table に全 cards 行 / (2) `exams` table に全 exams 行 / (3) `sync_meta`
に `last_card_pull_at` / `last_exam_pull_at` の ISO 文字列、 (4) Network panel で
`GET /api/cards/pull` `GET /api/exams/pull` 各 200、 (5) reload で同 state (idempotent)。

**完了条件:** OT 実機 smoke PASS

---

## やらないこと

session-runner local 切替 / FSRS client 化 / dueCount local projection / Δ pull
cursor 利用 / pull UI feedback / exponential backoff / `card_mutations` bulk push /
offline 演習成立 / Service Worker / 画像 cache / conflict resolution 本実装 /
マルチデバイス UX / `user_settings` pull / 起動・復帰・online 等 dashboard mount 以外
のトリガ / properties 特別扱い (jsonb で cards に含めて pull 済) / ts-fsrs client
bundle 化。

## Plan 完了基準

Task 1-6 が typecheck clean / test 全通過 / review Critical 0 / Important 0 で
`[reviewed]` tag 付き 1 commit に集約 (plan + 実装 + test)。 Task 7 は別途 stg deploy 後 OT 実機 smoke。

## 分量

S-local-2 plan: ~165 行 / 上限 250 (前版 286 → -120 行圧縮、 内容方針維持)

## 関連 doc

design: `docs/superpowers/specs/2026-05-26-s-local-1-design.md` / investigation:
`docs/superpowers/specs/2026-05-26-s-local-1-investigation.md` / S-cache close:
`docs/superpowers/sessions/2026-05-26-s-cache-series-close.md` / tech-spec §14 (MVP
採用) / 既存: `lib/client-db.ts` `lib/sync/review-events.ts`
