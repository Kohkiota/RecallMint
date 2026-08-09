# ②-4b §2: 退会時 `src/{userId}/` prefix purge 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 退会 webhook で `src/{internalUserId}/` を上限付き best-effort purge する。

**Architecture:** spec = `docs/superpowers/specs/2026-08-09-ocr-2-4b-s2-deletion-src-purge-design.md`
(OT 裁定 3 点反映済・**凍結**。task の判断が spec と食い違ったら実装せず停止)。
`lib/storage/r2.ts` に bounded listing core を切り出し、`handle-clerk-event.ts` の DB tx の**後ろ**に
purge を 1 本足す。台帳 catalog 1 entry 追加。

**Tech Stack:** Next.js Server(webhook route)/ zod 不使用(入力は内部 uuid のみ)/ Vitest(全 mock)。

## Global Constraints(全 task 共通)

- TDD: 各 pin は red(fail 確認)→ green。**gate ごとに個別変異**(まとめて壊さない)。
- migration / schema / env 追加なし。R2 実呼出なし。**DB 呼出を増やさない**。
- 不変条件(spec §4): ① purge は throw しない ② DB scrub の成否に依存しない ③ prefix は
  `src/{internalUserId}/`(末尾スラッシュ)④ DB 呼出を増やさない ⑤ 有限時間で終わり打ち切りは
  必ず台帳 1 行(silent truncation 禁止)⑥ `listObjects` 既存呼出元の挙動不変。
- 時間依存 test は**時刻注入**で書く(実 sleep 禁止)。
- feat commit は canonical review + Codex(`codex-review.sh`)pass 後に `[reviewed]`。commit 直前宣言 4 点。
- 簡潔性規律: 新 helper は plan 記載分のみ。scope 外に触らない。

---

### Task 1: `listObjectsBounded` の切り出し(`listObjects` の契約は不変)

**Files:**
- Modify: `lib/storage/r2.ts`
- Modify: `lib/storage/r2.test.ts`

**Interfaces(Task 2 が依存):**
- `export async function listObjectsBounded(prefix: string, maxPages: number): Promise<{ keys: string[]; truncated: boolean }>`
- `export async function listObjects(prefix: string): Promise<string[]>`(**既存 signature 維持**)

**目的:** spec §3.2。既存 `listObjects`(`r2.ts:314-364`)の pagination loop を bounded core へ移し、
`listObjects` は `listObjectsBounded(prefix, MAX_LIST_PAGES)` に委譲して **truncated なら従来と同一
文言で throw** する。bounded は maxPages 到達時に **throw せず** 収集済み keys と `truncated: true` を返す。

**制約:** 既存の throw 契約 4 種(`!res.ok` / malformed root / malformed IsTruncated / token 非前進)は
**bounded 側に保持**し、文言も変えない(既存 test が文言 regex で pin している)。
呼出元 `scripts/gc-src-prefix.ts`(2 箇所)は**無改変で通ること**。

**完了条件:** 新規 pin = ① maxPages 到達で `{ truncated: true }` + 収集済み keys を返す(throw しない)
② 同条件で `listObjects` は従来どおり throw ③ bounded で truncated=false の通常系。
既存 `listObjects` の全 pin(r2.test.ts:336-441)が**無改変で green**。
`pnpm vitest run lib/storage/r2.test.ts scripts/gc-src-prefix.test.ts` 全 pass。
red 検証は ①②を個別に(委譲を消す / throw を消す の 2 変異)。

---

### Task 2: 退会 purge 本体 + 台帳 catalog

**Files:**
- Modify: `lib/clerk/handle-clerk-event.ts`
- Modify: `lib/integration-failures.ts` / `lib/integration-failures.test.ts`
- Modify: `app/api/webhooks/clerk/route.test.ts`

**Interfaces(Task 1 を消費):** `listObjectsBounded(prefix, maxPages)` / `deleteObject(key)`(never-throw・404=成功系)。

**目的:** spec §3.1〜§3.3。`handleUserDeleted` の `runTransactionWithRetry` 呼出(`:204-248`)の
**直後**に purge を 1 行追加し、実体は同 file の private 関数に置く。

**実装(spec の写像・この範囲のみ):**
1. 定数 4 本(値と根拠コメントは spec §3.2 の表どおり):
   `SRC_PURGE_BUDGET_MS=20_000` / `SRC_PURGE_MAX_LIST_PAGES=2` / `SRC_PURGE_DELETE_CHUNK=20` /
   `SRC_PURGE_MAX_FAILURE_ROWS=20`
2. private `async function purgeSourcePrefix(internalUserId, clerkUserId, now = () => Date.now())`:
   - `const deadline = now() + SRC_PURGE_BUDGET_MS`
   - `listObjectsBounded(\`src/${internalUserId}/\`, SRC_PURGE_MAX_LIST_PAGES)` →
     `truncated` なら台帳 `phase:'list_truncated'` 1 行を書いてから続行
   - keys を `SRC_PURGE_DELETE_CHUNK` ごとに `Promise.all(chunk.map(deleteObject))`。
     **各 chunk の開始前に `now() > deadline` を判定**し、超過なら `phase:'deadline'` +
     `{ deleted, remaining }` 1 行を書いて打ち切り
   - 失敗 key は 1 件 1 行(`{ userId, objectKey, status }`)。**19 行まで**。20 件目以降が残る場合は
     20 行目を `{ userId, truncated: true, remainingFailures }` の打ち切り行にする
   - **全体を try/catch**。listing throw は `phase:'list'` + `errorMessage` 1 行にして飲む。
     台帳呼出自体の throw も飲む(`logger.error`・`deleteSourceKeys` idiom)。**throw しない契約**
3. catalog に `r2_deletion_src_delete`(`r2` / `object.delete` / `user_deletion` /
   `external_api_error`)+ 既存 entry 様式のコメント(workflow 軸で他 3 つの `object.delete` と区別)

**制約:** DB 呼出を増やさない(既存 Group I invariant test の `update×1 / delete×10` 件数 pin を動かさない)。
`internalUserId` 未解決の early return(`:104-114`)配下では purge を呼ばない。

**完了条件:** spec §5 の pin を red→green。特に **DB tx 失敗(recordFailure 経路)でも purge が走る**
(不変条件 2)と **上限 3 系統**(list_truncated / 20 行打ち切り / deadline)。時刻は注入で制御。
catalog 件数 pin 12→13 + 4 軸 pin 1 本。既存 pin(Group I 集合 / 件数 / 200 返却)全 green。

---

### Task 3: docs — architecture.md の DELETE 経路列挙に退会 purge を追記

**Files:**
- Modify: `docs/architecture.md`(source 行 1 箇所)

**目的:** 経路列挙(完了通知 reject / pipeline 出口 / §1 staging 削除)に **退会 prefix purge** を
**適用範囲を同じ文に置いて**追加(上限打ち切り・失敗分は §3/lifecycle が受け皿)。
証明列に Task 1/2 の test を追加。**assets 実体は GC lane に残る非対称**を同じ文で明示し、
「退会で R2 が消える」と読めないようにする(spec §7.1)。

**完了条件:** 行の主張と実装が一致。`docs(architecture)` + `[no-review]` commit。

---

## Sprint 完了 gate(Task 3 の後・報告 chat に各 1 行明記)

- whole-repo `pnpm lint`(--max-warnings=0)exit 0 / `pnpm typecheck` 0 / `pnpm build` 0
- `pnpm test` 全 green / `pnpm test:iso` green / `pnpm run audit`(既知の無関係 advisory は
  結果をそのまま報告し OT 判断に回す)
- whole-branch canonical review(範囲 = §2 の全 commit)

## 完了後(OT へ渡す)

- OT push → stg smoke は **spec §8.1 の手順**(CC が sentinel userId 照合 gate を通してから
  OT が Clerk dashboard で退会)。**既存 sentinel 2 本は 8/11 まで不可触。**
- 台帳確認(`service='r2'` かつ `workflow='user_deletion'` の行が無いこと)は OT 照会。
