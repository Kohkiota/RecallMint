# ②-4b §2: 退会時 `src/{userId}/` prefix purge 実装 plan(r2 = cross-check 統合後)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 退会 webhook で `src/{internalUserId}/` を**予算付き** best-effort purge する。

**Architecture:** spec = `docs/superpowers/specs/2026-08-09-ocr-2-4b-s2-deletion-src-purge-design.md`
(OT 裁定 7 点反映済・**凍結**。task の判断が spec と食い違ったら実装せず停止)。
`lib/storage/r2.ts` に bounded listing core + timeout 上書きを足し、`handle-clerk-event.ts` の
**外周 `finally`** に purge を置く。台帳 catalog は **2 entry** 追加。

**Tech Stack:** Next.js Server(webhook route)/ Vitest(全 mock・**時刻は注入**)。

## Global Constraints(全 task 共通)

- TDD: 各 pin は red(fail 確認)→ green。**gate ごとに個別変異**(まとめて壊さない)。
- migration / schema / env 追加なし。R2 実呼出なし。**DB 呼出を増やさない**。
- 不変条件(spec §4・全 8 項): ① purge は throw しない(`finally` 内ゆえ構造的必須)
  ② 到達保証は**外周 finally**(「後置だから走る」ではない)③ prefix は `src/{internalUserId}/`
  (末尾スラッシュ)④ DB 呼出を増やさない ⑤ 予算の原点は `POST()` 冒頭・打ち切りは必ず台帳 1 行
  (silent truncation 禁止)⑥ 既存呼出元の挙動不変 ⑦ 記帳失敗が削除の forward progress を止めない
  ⑧ DELETE 直前に prefix 再検証(二重関門)。
- **時間依存 test は時刻注入で書く**(実 sleep 禁止)。
- feat commit は canonical review + Codex(`codex-review.sh`)pass 後に `[reviewed]`。commit 直前宣言 4 点。
- 簡潔性規律: 新 helper は plan 記載分のみ。scope 外に触らない。

---

### Task 1: `lib/storage/r2.ts` — bounded listing + timeout 上書き

**Files:**
- Modify: `lib/storage/r2.ts` / `lib/storage/r2.test.ts`

**Interfaces(Task 2 が依存):**
- `export async function listObjectsBounded(prefix: string, maxPages: number, opts?: { timeoutMs?: number }): Promise<{ keys: string[]; truncated: boolean }>`
- `export async function listObjects(prefix: string): Promise<string[]>`(**既存 signature 維持**)
- `export async function deleteObject(objectKey: string, opts?: { timeoutMs?: number }): Promise<{ ok: boolean; status: number | null }>`(**既存呼出 3 箇所は無改変**)

**目的:** spec §3.2。既存 `listObjects`(`r2.ts:314-364`)の pagination loop を bounded core へ移し、
`listObjects` は `listObjectsBounded(prefix, MAX_LIST_PAGES)` に委譲して truncated なら
**従来と同一文言で throw**。bounded は maxPages 到達時に throw せず `{ truncated: true }` を返す。
`opts.timeoutMs` は各 page / DELETE の `AbortSignal.timeout` に反映(既定は現行定数)。
`maxPages` は**正の整数以外を fail-fast reject**。`getObject` の既存 `{ timeoutMs }` idiom に倣う。

**制約:** 既存 throw 契約 4 種(`!res.ok` / malformed root / malformed IsTruncated / token 非前進)を
bounded 側に保持し**文言を変えない**(既存 test が regex で pin)。`scripts/gc-src-prefix.ts`(2 箇所)/
`finalize-pdf-source.ts` / `upload-pipeline.ts` / `gc-image-assets.ts` の既存呼出は無改変で通ること。

**完了条件:** 新規 pin = ① maxPages 到達で throw せず `{ truncated: true }` + 収集済み keys
② 同条件で `listObjects` は従来どおり throw かつ**文言同一** ③ `maxPages` 不正値
(`0` / `-1` / `1.5` / `NaN` / `Infinity`)を reject ④ 境界 `maxPages=1` × IsTruncated true/false
⑤ `timeoutMs` 上書きが listing / `deleteObject` の signal に反映。
既存 pin(r2.test.ts:336-441)が**無改変で green**。
`pnpm vitest run lib/storage/r2.test.ts scripts/gc-src-prefix.test.ts` 全 pass。
red は ①②③⑤を個別変異で。

---

### Task 2: 退会 purge 本体 + 台帳 catalog 2 entry + `handlerStart` 伝播

**Files:**
- Modify: `app/api/webhooks/clerk/route.ts` / `app/api/webhooks/clerk/route.test.ts`
- Modify: `lib/clerk/handle-clerk-event.ts`
- Modify: `lib/integration-failures.ts` / `lib/integration-failures.test.ts`

**Interfaces(Task 1 を消費):** `listObjectsBounded` / `deleteObject(key, { timeoutMs })`。
**新 export**: `export async function purgeSourcePrefix(internalUserId: string, purgeDeadline: number, now?: () => number): Promise<void>`
(時刻注入のため named export。`clerkUserId` は**受け取らない** — データ最小化)。

**目的:** spec §3.1〜§3.3 の写像。

**実装(この範囲のみ):**
1. **`handlerStart` 伝播**: `route.ts` の `POST()` 冒頭で `const handlerStart = Date.now()` →
   `handleEvent(evt, handlerStart)` → `handleUserDeleted(clerkUserId, handlerStart)`。
   **必須引数**(optional + 既定値にしない)。既存 test の呼出は compiler が漏れを検出する。
2. 定数 7 本(値と根拠コメントは spec §3.2 の表どおり): `HANDLER_BUDGET_MS=50_000` /
   `SRC_PURGE_BUDGET_MS=20_000` / `SRC_PURGE_MAX_LIST_PAGES=2` / `SRC_PURGE_DELETE_CHUNK=20` /
   `SRC_PURGE_MIN_SLICE_MS=2_000` / `SRC_PURGE_TAIL_RESERVE_MS=4_000` / `SRC_PURGE_MAX_FAILURE_ROWS=20`
3. **外周 `finally`**: `internalUserId` 確定後の本体(Stripe ループ + DB tx)を `try` に包み、
   `finally` で `purgeSourcePrefix(internalUserId, purgeDeadline)` を呼ぶ。
   `purgeDeadline = Math.min(purgeStart + SRC_PURGE_BUDGET_MS, handlerStart + HANDLER_BUDGET_MS)`。
   早期 return(bootstrap 0 行)は **try の外**。
4. `purgeSourcePrefix` 本体 = spec §3.2 の 1〜5(work deadline = `purgeDeadline - TAIL_RESERVE`/
   `listObjectsBounded(prefix, MAX_LIST_PAGES, { timeoutMs: min(既定, 残予算) })` /
   chunk ごとに残予算評価 + **prefix 再検証** + `deleteObject(k, { timeoutMs: min(既定, 残予算) })` /
   打ち切りは incomplete 行 1 本 / **各記帳を個別 try/catch** / 全体 try/catch で never-throw)。
5. catalog 2 entry(spec §3.3 の 4 軸そのまま)+ 既存様式のコメント。
   `failureCode: 'incomplete'` は新設値(`text` 列ゆえ migration 不要)。

**制約:** DB 呼出を増やさない(既存 Group I invariant test の `update×1 / delete×10` 件数 pin 不変)。
`route.test.ts` に `@/lib/storage/r2` の mock 追加が必須(module load 時 env fail-fast 対策)。

**完了条件:** spec §5 の pin を red→green。要点 =
**B/C が throw しても purge が走る**(`recordFailure` を throw させる変異で red)/
上限 4 系統(`list_truncated` / 20 件ちょうど = 個別 20 行 / 21 件以上 = 個別 19 + incomplete 1 /
`no_budget`)/ **deadline 打ち切りが `external_api_error` で記録されない** /
記帳 throw 後も後続 DELETE が続く / prefix 外 key を `deleteObject` しない /
`timeoutMs` が `min(既定, 残予算)` になっている。
catalog 件数 pin 12→14 + 4 軸 pin 2 本。既存 pin(Group I / 件数 / 200 返却)全 green。

---

### Task 3: docs — architecture.md の DELETE 経路列挙に退会 purge を追記

**Files:**
- Modify: `docs/architecture.md`(source 行 1 箇所)

**目的:** 経路列挙(完了通知 reject / pipeline 出口 / §1 staging 削除)に **退会 prefix purge** を
**適用範囲を同じ文に置いて**追加する。同じ文に必ず含める限定:
① 上限打ち切り・失敗分は §3/lifecycle が受け皿 ② **listing は snapshot ではない**(pagination 中 /
LIST 後 DELETE 前の PUT は取り漏らす)③ **assets 実体は GC lane に残る**(「退会で R2 が消える」と
読ませない・spec §7.1)。証明列に Task 1/2 の test を追加。

**完了条件:** 行の主張と実装が一致。`docs(architecture)` + `[no-review]` commit。

---

## Sprint 完了 gate(Task 3 の後・報告 chat に各 1 行明記)

- whole-repo `pnpm lint`(--max-warnings=0)exit 0 / `pnpm typecheck` 0 / `pnpm build` 0
- `pnpm test` 全 green / `pnpm test:iso` green / `pnpm run audit`(既知の無関係 advisory は
  結果をそのまま報告し OT 判断に回す)
- whole-branch canonical review(範囲 = §2 の全 commit)

## 完了後(OT へ渡す)

- OT push → stg smoke は **spec §8.1 の手順**(CC が sentinel userId 照合 gate を通してから
  OT が Clerk dashboard で退会)。0 件でない場合は **§8.3 の切り分け**に従い、即「実装不良」と断じない。
- **既存 sentinel 2 本は 8/11 まで不可触。**
- 台帳確認(`service='r2'` かつ `workflow='user_deletion'` の行が無いこと)は OT 照会。
