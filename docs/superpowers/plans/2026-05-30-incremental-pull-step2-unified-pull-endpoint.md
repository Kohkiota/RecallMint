# 増分 pull Step 2「統合 /api/pull 新設 (サーバー単体)」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ストリーム別 `?since` を受ける統合 `GET /api/pull` を新設し、cards delta + exams delta + tombstone delta + ストリーム別 next-cursor 3 本を 1 round-trip で返す。client は載せ替えず旧 endpoint を使い続けるため、本 step はサーバー単体で正しさを検証する。

**Architecture:** 既存 `getAllCardsForUser`/`getAllExamsForUser` (戻り `ClientCard[]`/`ClientExam[]`、旧 route が使用中) は**変更しない**。新たに `{rows, maxUpdatedAt}` を返す delta 関数 3 本 (cards/exams/tombstone) を足し、新 route がそれらを組み立てる。inclusive (`>=`)、`since` 未指定は全件、next-cursor は返却行の max(対象列、0 件 null)。schema 変更なし。

**Tech Stack:** Next.js 15 App Router (`app/api/pull/route.ts`), Drizzle ORM (`and`/`eq`/`gte`), Postgres, zod (ISO 検証), Vitest (mock unit)。

**位置づけ (spec 整合):** 確定 spec `docs/superpowers/specs/2026-05-29-incremental-pull-design.md` §2.1-2.3 / §6 step 2。本 step は **step 3 (client 切替) の前提**を作る。新旧 endpoint を一時併存させ (旧は §6 step 7 で廃止)、新 endpoint の正しさを client 切替と分離して確認する。

---

## 全体制約 (各タスク共通、冒頭一度のみ)

- **TDD**: 失敗 test 先行 → fail 確認 → 最小実装 → green → review → commit。
- **unit 方針**: 実 DB は叩かない。
  - DB 入口 (delta 関数) の unit: **getDb を mock** して canned rows を返し、`{rows (mapper 適用済), maxUpdatedAt}` の
    **max 算出・0 件 null・since 指定時のみ `gte` 条件付与** を検証 (step 1 と同じ getDb mock 方針)。
    実 `>=` フィルタの DB 挙動は stg smoke で裏取り。
  - route の unit: **delta 関数 3 本 + `getCurrentUser` を mock** (既存 `app/api/cards/pull/route.test.ts` と同方式) し、
    `?since` 3 本の parse / 欠落・不正 fallback / `user.id` 渡し (owner-scope) / レスポンス組み立て / cursors を検証。
- **旧 endpoint・既存関数を壊さない**: `getAllCardsForUser`/`getAllExamsForUser`/旧 3 route は touch しない。新関数追加のみ。
- **schema 不変**。tombstones table (`lib/db/schema.ts:631-649`: `entityType 'exam'|'card'` / `entityId` / `deletedAt` / `userId`) を読むだけ。
- **since の WHERE 構築**: drizzle の `and(cond, undefined)` 依存を避け、**条件配列**で組む
  (`const conds = [eq(...)]; if (since) conds.push(gte(...)); .where(and(...conds))`。`study-days-pull.ts` の `and(eq,gte)` に倣う)。
- **param 命名**: spec §2.1 どおり snake_case `since_cards` / `since_exams` / `since_tombstone`
  (既存 query param は `deletion-status` の `userId` のみ camelCase。本 endpoint は spec 準拠で snake、軽微不整合は許容)。
- **auth**: 旧 pull route と同型 — `runtime='nodejs'`、`getCurrentUser()` → `UnauthenticatedError` は 401、user 未 sync は 200 空、
  例外は 500、`Cache-Control: no-store` (`app/api/cards/pull/route.ts` 踏襲)。
- **review/commit 規律**: feat は `superpowers:requesting-code-review` 必須経路。本 step は読み取り endpoint (削除/決済/外部副作用なし、
  auth は標準 `getCurrentUser` 流用で middleware 不変) のため通常 review。step 1 の運用に合わせ **review pass → `[no-review]` commit →
  endpoint 直叩き stg smoke → `[reviewed]` amend** とする (OT 確認)。
- test 実行: `pnpm test <path>`。単体名指定は `pnpm exec vitest run <path> -t "<name>"`。

---

## File Structure

| 変更/新規 file | 責務 |
|---|---|
| Create `lib/db/max-iso.ts` | `maxIso(values: string[]): string | null` — ISO8601 文字列配列の最大 (lexicographic = 時系列)、空配列 null。3 delta 共有 |
| Create `lib/db/tombstones-pull.ts` | `ClientTombstone` 型 + `toClientTombstone` mapper + `getTombstonesDelta(userId, since?)` |
| Modify `lib/db/cards-pull.ts` | `getCardsDelta(userId, since?)` を追加 (既存 `toClientCard`/`getAllCardsForUser` は不変) |
| Modify `lib/db/exams-pull.ts` | `getExamsDelta(userId, since?)` を追加 (既存 `toClientExam`/`getAllExamsForUser` は不変) |
| Create `app/api/pull/route.ts` | `GET` — 3 `?since` 受領 + ISO 検証 + 3 delta 呼出 + 統合レスポンス組み立て |
| + 各 `*.test.ts` | 上記それぞれの unit |

**型の所在**: `ClientTombstone = { entity_type: 'exam'|'card'; entity_id: string; deleted_at: string }` は `tombstones-pull.ts` で定義・export (step 3 client は route の JSON から受けるため import 不要、必要なら type-only import)。delta 戻り型は各 file でローカル定義 (`{ rows: ClientCard[]; maxUpdatedAt: string | null }` 等)。

---

## Task 1: `maxIso` 共有ヘルパ

**Files:** Create `lib/db/max-iso.ts` / Test `lib/db/max-iso.test.ts`

**目的**: 返却行から next-cursor (対象列の最大 ISO 文字列) を算出する pure helper。**制約**: 純関数・依存なし。
**完了条件**: 下記 test green + review。

- [ ] **Step 1: 失敗 test** — `maxIso([])` → `null`、`maxIso(['2026-05-02T00:00:00.000Z','2026-05-01T...','2026-05-03T...'])` → 最大値、単一要素はその値。
- [ ] **Step 2: red** — `pnpm exec vitest run lib/db/max-iso.test.ts` → FAIL (未実装)。
- [ ] **Step 3: 実装** — `export function maxIso(values: string[]): string | null { let m: string | null = null; for (const v of values) if (m === null || v > m) m = v; return m }` (ISO8601 は文字列比較で時系列正しい)。
- [ ] **Step 4: green** — 同 test PASS。
- [ ] **Step 5: commit** — `feat(db): pull cursor 用 maxIso helper` + `[no-review]`。

---

## Task 2: tombstone DB 入口 (`tombstones-pull.ts`)

**Files:** Create `lib/db/tombstones-pull.ts` / Test `lib/db/tombstones-pull.test.ts`

**目的**: `getTombstonesDelta(userId, since?)` が `WHERE user_id [AND deleted_at >= since]` の tombstone 行を
`{ rows: ClientTombstone[], maxDeletedAt: string | null }` で返す。**制約**: 条件配列で since 分岐、`toClientTombstone` で
`{entity_type, entity_id, deleted_at(ISO)}` に変換、cursor は `maxIso(rows.map(r=>r.deleted_at))`。
**完了条件**: getDb mock unit green + review。

- [ ] **Step 1: 失敗 test** — `vi.mock('@/lib/db', ...)` で getDb を mock し `db.select().from().where()` が canned 2 行 (deletedAt 異なる) を返すよう構成。`drizzle-orm` は `{ ...real, gte: spy, eq: spy }` 部分 mock (delete-exam.test.ts の eq spy 方式に倣う)。検証: (a) rows が `toClientTombstone` 適用済 (entity_type/entity_id/deleted_at ISO)、(b) `maxDeletedAt` = 2 行の最大、(c) `since` 指定時 `gte(tombstones.deletedAt, since)` が呼ばれる / 未指定時 `gte` 不呼出、(d) `eq(tombstones.userId, userId)` 必須。0 行 → `maxDeletedAt=null`。
- [ ] **Step 2: red** — `pnpm exec vitest run lib/db/tombstones-pull.test.ts` → FAIL。
- [ ] **Step 3: 実装** — `toClientTombstone(row)` + `getTombstonesDelta`:
  ```ts
  export type ClientTombstone = { entity_type: 'exam' | 'card'; entity_id: string; deleted_at: string }
  export async function getTombstonesDelta(userId: string, since?: Date):
    Promise<{ rows: ClientTombstone[]; maxDeletedAt: string | null }> {
    const db = getDb()
    const conds = [eq(tombstones.userId, userId)]
    if (since) conds.push(gte(tombstones.deletedAt, since))
    const raw = await db.select().from(tombstones).where(and(...conds))
    const rows = raw.map(toClientTombstone)
    return { rows, maxDeletedAt: maxIso(rows.map((r) => r.deleted_at)) }
  }
  ```
- [ ] **Step 4: green** — 同 test PASS。
- [ ] **Step 5: commit** — `feat(db): tombstone delta DB 入口 (getTombstonesDelta + ClientTombstone)` + `[no-review]`。

---

## Task 3: cards delta DB 入口 (`getCardsDelta`)

**Files:** Modify `lib/db/cards-pull.ts` / Test `lib/db/cards-delta.test.ts` (新規; 既存 `cards-pull.test.ts` は mapper 専用のため別 file)

**目的**: `getCardsDelta(userId, since?)` → `{ rows: ClientCard[]; maxUpdatedAt: string | null }`。既存 `toClientCard` 再利用。
**制約**: `getAllCardsForUser` は不変、since は条件配列で `gte(cards.updatedAt, since)`、cursor は `maxIso(rows.map(r=>r.updated_at))`。
**完了条件**: getDb mock unit green + 既存 `cards-pull.test.ts` (mapper) 不変通過 + review。

- [ ] **Step 1: 失敗 test** — Task 2 と同方式の getDb/drizzle mock。canned 2 行 (updatedAt 異なる) → `{rows (toClientCard 済), maxUpdatedAt=最大}`、`since` 指定時 `gte(cards.updatedAt, since)` 呼出 / 未指定不呼出、`eq(cards.userId,userId)` 必須、0 行 null。
- [ ] **Step 2: red** — `pnpm exec vitest run lib/db/cards-delta.test.ts` → FAIL。
- [ ] **Step 3: 実装** — `cards-pull.ts` に追加 (既存 import の `eq` に `and, gte` を補い、`maxIso` を import):
  ```ts
  export async function getCardsDelta(userId: string, since?: Date):
    Promise<{ rows: ClientCard[]; maxUpdatedAt: string | null }> {
    const db = getDb()
    const conds = [eq(cards.userId, userId)]
    if (since) conds.push(gte(cards.updatedAt, since))
    const rows = (await db.select().from(cards).where(and(...conds))).map(toClientCard)
    return { rows, maxUpdatedAt: maxIso(rows.map((r) => r.updated_at)) }
  }
  ```
- [ ] **Step 4: green** — 同 test + `pnpm test lib/db/cards-pull.test.ts` PASS。
- [ ] **Step 5: commit** — `feat(db): cards delta DB 入口 (getCardsDelta)` + `[no-review]`。

---

## Task 4: exams delta DB 入口 (`getExamsDelta`)

**Files:** Modify `lib/db/exams-pull.ts` / Test `lib/db/exams-delta.test.ts` (新規)

**目的**: `getExamsDelta(userId, since?)` → `{ rows: ClientExam[]; maxUpdatedAt: string | null }`。既存 `toClientExam` 再利用。
**制約**: `getAllExamsForUser` は不変、`gte(exams.updatedAt, since)`、cursor は `maxIso(rows.map(r=>r.updated_at))`。
**完了条件**: getDb mock unit green + 既存 `exams-pull.test.ts` 不変通過 + review。

- [ ] **Step 1: 失敗 test** — Task 3 と同方式。canned 行で rows(toClientExam 済)/maxUpdatedAt/since gte/eq(userId)/0 件 null を検証。
- [ ] **Step 2: red** — `pnpm exec vitest run lib/db/exams-delta.test.ts` → FAIL。
- [ ] **Step 3: 実装** — `exams-pull.ts` に追加 (import に `and, eq, gte` + `maxIso`; 構造は Task 3 と同形で table=`exams`、列=`exams.updatedAt`、mapper=`toClientExam`)。
- [ ] **Step 4: green** — 同 test + `pnpm test lib/db/exams-pull.test.ts` PASS。
- [ ] **Step 5: commit** — `feat(db): exams delta DB 入口 (getExamsDelta)` + `[no-review]`。

---

## Task 5: 統合 `GET /api/pull` route

**Files:** Create `app/api/pull/route.ts` / Test `app/api/pull/route.test.ts`

**目的**: 3 `?since` を受け、3 delta を呼び、統合レスポンスを返す。**制約**: ISO 不正/欠落は当該ストリームのみ全件 fallback、
`user.id` を 3 delta に渡す (owner-scope)、レスポンスは下記単一形、auth/Cache-Control は旧 pull route 踏襲。
**完了条件**: route unit green (delta 関数 mock) + review。

- [ ] **Step 1: 失敗 test** — `app/api/cards/pull/route.test.ts` の構造を踏襲。`getCurrentUser` と 3 delta 関数 (`getCardsDelta`/`getExamsDelta`/`getTombstonesDelta`) を mock。検証:
  - auth: `UnauthenticatedError`→401 / user=null→200 空 (`{cards:[],exams:[],tombstones:[],cursors:{cards:null,exams:null,tombstone:null}}`) / delta throw→500。
  - `?since_cards`/`?since_exams`/`?since_tombstone` を渡すと各 delta が `(user.id, new Date(その値))` で呼ばれる (owner-scope = user.id 固定)。
  - param 欠落・ISO 不正 (`?since_cards=bad`) → 当該 delta は `since=undefined` で呼ばれる (全件 fallback)。3 ストリーム独立。
  - レスポンス: `cards`/`exams`/`tombstones` が各 delta の `rows`、`cursors` が `{cards: deltaC.maxUpdatedAt, exams: deltaE.maxUpdatedAt, tombstone: deltaT.maxDeletedAt}`。
  - `Cache-Control: no-store` ヘッダ。
- [ ] **Step 2: red** — `pnpm exec vitest run app/api/pull/route.test.ts` → FAIL (route 未作成)。
- [ ] **Step 3: 実装** — `route.ts` (要点):
  - `runtime='nodejs'`、`const headers = { 'Cache-Control': 'no-store' }`。
  - `getCurrentUser()` を旧 route と同じ try/catch (401/500)、`!user` → 200 空 (cursors 全 null)。
  - `parseSince(raw: string | null): Date | undefined` — zod `z.iso.datetime()` (bulk route 踏襲) で安全 parse、失敗/null は `undefined`。
  - `const u = new URL(req.url).searchParams`; 3 本を `parseSince(u.get('since_cards'))` 等で取得。
  - `const [c, e, t] = await Promise.all([getCardsDelta(user.id, sc), getExamsDelta(user.id, se), getTombstonesDelta(user.id, st)])`。
  - `Response.json({ cards: c.rows, exams: e.rows, tombstones: t.rows, cursors: { cards: c.maxUpdatedAt, exams: e.maxUpdatedAt, tombstone: t.maxDeletedAt } }, { status: 200, headers })`。
  - 例外は旧 route 同様 `logger.warn` + 500。
- [ ] **Step 4: green** — `pnpm test app/api/pull/route.test.ts` PASS。
- [ ] **Step 5: commit** — `feat(api): 統合 GET /api/pull (cards/exams/tombstone delta + ストリーム別 cursor)` + `[no-review]`。

---

## この step 単体の stg smoke (endpoint 直叩き、client 非経由)

client を載せ替えないため UI 経路が無い → **認証済 staging ブラウザ (OT hand-off セッション、step 1 と同じ) の devtools から
`fetch('/api/pull?...')` を直叩き**し、JSON を読む。step 1 同様 `.env.local`＝staging DB で DB 直読み (read-only) 交差確認。
各観点で取得 JSON と DB クエリ結果を証跡化 (reqid / レスポンス body / DB 行)。

1. **全件 (since なし)**: `fetch('/api/pull')` → `cards`/`exams`/`tombstones` がその user の全件、`cursors.{cards,exams,tombstone}` が各 max (データありなら非 null)。DB の `count`/`max(updated_at)`/`max(deleted_at)` と一致。
2. **差分 (since あり)**: `?since_cards=<中間時刻>` → `updated_at >= since` の cards のみ返る (件数が全件未満)。DB の `count where updated_at >= since` と一致。
3. **inclusive 境界**: ある card の `updated_at` を `since_cards` に渡す → **その行が含まれる** (`>=`)。`since = その値 + 1ms` → 除外される。
4. **0 件 cursor 据え置き**: `?since_cards=<未来時刻>` → `cards:[]` かつ `cursors.cards = null`。
5. **tombstone ストリーム**: `?since_tombstone=<中間>` → `deleted_at >= since` の tombstone のみ、各行に `entity_type`('exam'|'card')/`entity_id`/`deleted_at`。`cursors.tombstone` = max。
6. **3 ストリーム独立**: `since_cards` のみ指定 → exams/tombstones は全件・cursor 非 null (cards のみ絞られる)。
7. **owner-scope**: 返却 cards/exams の `user_id` が全てテスト user。DB で返却 entity_id が当該 user の tombstone であることを確認。(真のクロステナントは 2nd account が要るため OT 判断 — 下記 §未確定 U2。)
8. **旧 endpoint 非破壊**: `fetch('/api/cards/pull')`/`/api/exams/pull`/`/api/study-days/pull` が従来どおり `{...,now}` を返す (client がまだ使用中)。

全観点 PASS で 5 commit (Task1-5) を `[reviewed]` へ amend (step 1 と同手順)。FAIL は amend せず症状/原因報告で停止。

---

## Self-Review (spec 整合)

- spec §2.1 (3 `?since`・inclusive・欠落 fallback) → Task 5 (parse/fallback) + Task 2-4 (gte)。§2.2 (DB入口 `{rows,maxUpdatedAt}`・max・0件 null・wall-clock now 不使用) → Task 1 (maxIso) + Task 2-4。§2.3 (tombstone 1 ストリーム同梱) → Task 2 + Task 5。統合レスポンス形 (cards/exams/tombstones/cursors) → Task 5。
- 旧 endpoint 併存 (§6: step 7 で廃止) → 既存関数/route 不変、新関数のみ追加で担保。
- placeholder なし。型整合: `getCardsDelta`/`getExamsDelta` は `{rows,maxUpdatedAt}`、`getTombstonesDelta` は `{rows,maxDeletedAt}`、route の `cursors` は `{cards,exams,tombstone}` で一貫。

---

## 実装前に確認・判断が要る点 (実コード再確認で判明)

- **U1 (戻り型変更は旧 endpoint を壊すため新関数で分離 — 確定)**: 既存 `getAllCardsForUser`/`getAllExamsForUser` は `ClientCard[]`/`ClientExam[]` を返し旧 route が直接使う。spec A の `{rows, maxUpdatedAt}` を満たすため**既存関数のシグネチャは変えず新 `getCardsDelta`/`getExamsDelta` を追加**する方針で plan 確定 (旧 route 無改修)。spec との食い違いではなく、spec §6「新旧併存」と整合する実装判断。
- **U2 (owner-scope の真のクロステナント検証)**: smoke は単一テスト account のため「他 user データ混入なし」を直接は exercise できない。owner-scope は code/unit (`eq(userId)` + route の `user.id` 渡し) で担保、smoke は「返却が当該 user の全データと一致」まで。厳密なクロステナント test に 2nd account を使うかは OT 判断 (既定: unit + 単一 account smoke で可とする)。
- **U3 (param 命名)**: spec §2.1 の snake_case (`since_cards` 等) を採用。既存唯一の query param は `userId` (camelCase) で不整合があるが、本 endpoint は spec 準拠とする (軽微、OT 認識のみ)。
- **U4 (gte の bind 型)**: `gte(col, since)` に `Date` を渡す (route で `new Date(検証済 ISO)`)。Drizzle #5789 は `sql\`${date}\`` template 限定で、query builder の parameterized bind は対象外 (step 1 review で確認済) のため安全。
