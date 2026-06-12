# Sprint Y-2 Sub-plan A: route hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (本 sprint の既定実装方式、 CLAUDE.md 明示) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** audit §10.3 (b) の P1 / P2 中 route hardening 9 item (H1 / #5 / #6 / #13 / H4 / #10 / #15 / H5 / #11c) を独立 task で消化、 重要 fix 2 件 (H5 / #11c) を CLAUDE.md「重要 Fix 裏取り」 経路で安全に通す。

**Architecture:** 案 = route ごとに `transient classifier / env-aware fail-fast / payload zod / rate-limit / signed token` を独立 helper として抽出、 既存 route はその helper を呼ぶ adapter に絞る。 helper 抽出最小 (5 新規 + 1 zod schema)。 既存 wire format / response shape は不変 (status code + header + payload validation の差替えのみ)。

**Spec:** `docs/superpowers/specs/2026-06-12-y2-launch-hardening-design.md` §2 (Sub-plan A) が正本。 §10.1 で audit §10.3 (b) #9 (pull response zod) は Phase 4 既定確認のため本 plan から除外済。

**Tech Stack:** Next.js 16 (App Router) / TS strict / Drizzle / zod / vitest / pnpm 10。

---

## 全体ルール (各 task 冒頭で参照、 個別 task で再掲しない)

1. **TDD**: 各 task は test 先行。 既存 test を壊さない。
2. **wire format 不変契約** (Y-1 T5 precedent): bulk endpoint response shape (`{ok, applied, failed}`) / webhook response (200 系) / 既存 client 期待形式は不変。 status code + header + payload validation の差替えのみ。
3. **CLAUDE.md 絶対ルール**: Stripe / Clerk / AI 既知 + sprint 完了 gate (whole-repo `pnpm lint --max-warnings=0` exit 0) + commit `[reviewed]` tag。
4. **review 経路**: 各 task PR 直前 `superpowers:requesting-code-review` skill canonical (template + general-purpose subagent + 厳格 prompt、 改変禁止)。
5. **重要 fix 規律** (T-A8 H5 / T-A9 #11c): **無 tag commit で末尾集約** → OT stg 実機確認 → 未 push amend で `[reviewed]` (CLAUDE.md「重要 Fix 裏取り」、 spec §2.2 / §8)。
6. **stop checkpoint** (OT 裁定 2026-06-12 反映): ~~T-A7 rate limit 値 OT 判断~~ = **解除済** (5 req/h で OT 一括承認時に確定)、 **T-A9 末尾**は残置 (H5 + #11c の OT 実機確認待ち、 重要 fix 構造)。
7. **spec 凍結**: 実装フェーズで spec 書き換えない (仕様変更必要なら停止 → OT 相談)。
8. **Next 設定 file gate** (T-A4 fix 反映、 CLAUDE.md §Sprint 完了 gate と整合): `proxy.ts` / `next.config.*` / matcher 関連 file を触る task は per-task gate に `pnpm build` 必須 (vitest / typecheck / lint は内部 js regex で動作するため Next.js matcher (path-to-regexp) の制約を検出不能。 T-A4 元 (45a74cf) で実際に Vercel build error 発生、 6f82025 で hotfix)。

**File Structure** (新規 / 主要 modify):
- 新規 `lib/transient/classify-bulk-error.ts` (T-A1)
- 新規 `lib/env/log-gate.ts` (T-A2)
- 新規 `lib/env/webhook-secret-gate.ts` (T-A8)
- 新規 `lib/rate-limit/contact-action.ts` (T-A7)
- 新規 `lib/security/deletion-token.ts` (T-A9)
- 新規 `lib/validation/clerk-webhook.ts` (T-A6)
- modify: `app/api/{review-events,entity-mutations}/bulk/route.ts` (T-A1)
- modify: `lib/ai/clients/gemini.ts` + `app/(app)/app/upload/_actions/process.ts` (T-A2)
- modify: `lib/ai-usage-counter.ts` (T-A3)
- modify: `proxy.ts` (T-A4)
- modify: `lib/ops.ts` (T-A5)
- modify: `app/api/webhooks/clerk/route.ts` (T-A6 + T-A8)
- modify: `app/api/webhooks/stripe/route.ts` (T-A8)
- modify: `app/(marketing)/contact/actions.ts` (T-A7)
- modify: `app/api/me/deletion-status/route.ts` + 削除 status URL 生成 caller (T-A9、 grep で特定)
- modify: `.env.example` (T-A9 で `DELETION_TOKEN_SECRET=` 追記)

---

### Task T-A1: H1 bulk 2 route の transient → 503 + Retry-After

**Files:**
- Create: `lib/transient/classify-bulk-error.ts` + test
- Modify: `app/api/review-events/bulk/route.ts` / `app/api/entity-mutations/bulk/route.ts`

- [ ] **目的**: bulk 2 endpoint の transient error (DB conflict / lock timeout / connection class / Drizzle PG error code 系) を 5xx 一括 → **503 + `Retry-After` header 付与** に切替、 client retry controller の transient/permanent 分岐と整合 (audit §10.3 (b) #11)。
- [ ] **制約** (OT 裁定 2026-06-12 反映): response shape 不変。 classifier は server-only 不付 (caller は server route)。 retry 秒は固定 30s (load test 結果で後日調整可、 magic number 化せず `BULK_TRANSIENT_RETRY_SEC` 定数で固定)。 transient 判定 PG error code: `40001` (serialization failure) / `40P01` (deadlock) / `57014` (statement timeout) / **`08000` `08003` `08006` (connection exception class 08)** / **`53300` (too_many_connections)** / **`57P03` (cannot_connect_now)** + Drizzle ConnectionError。 **unknown DB error の default は transient (503) に倒す** (permanent 誤判定 = silent lost write 再来を回避、 outbox 再送収束性を壊さない設計、 spec §1.1 目的 3 整合)。 zod 等の明示 4xx (validation failure) は default transient 対象外で 400 系のまま。 列の育て方 = production logger 観測で発生 code を集計、 必要に応じて追加 (本 sprint では初期セットで開始)。
- [ ] **完了条件**: helper test 8 case (transient PG code 7 種 / Drizzle ConnectionError / permanent zod 4xx / unknown DB error = transient default 帰着)。 既存 bulk route test 全 pass + 新規 case 3 (transient = 503 + `Retry-After: 30` / 明示 permanent 4xx / unknown DB = 503 default)。 Critical 0、 [reviewed]。

---

### Task T-A2: #5 OCR_DEBUG_LOG / BULK_FULL_PARAMS_LOG production gate 二重化

**Files:**
- Create: `lib/env/log-gate.ts` + test
- Modify: `lib/ai/clients/gemini.ts` / `app/(app)/app/upload/_actions/process.ts`

- [ ] **目的**: production で uncontrolled `OCR_DEBUG_LOG=true` / `BULK_FULL_PARAMS_LOG=true` が effective にならない 2 段 gate (audit §10.3 (b) #5)。 既存 env 直 + 新 `LOG_GATE_ALLOW_PROD=true` の AND で誤設定 fail-safe。
- [ ] **制約**: helper signature = `isLogGateOpen(envKey: string): boolean`、 production (= `VERCEL_ENV === 'production'`) = `process.env[envKey] === 'true' && process.env.LOG_GATE_ALLOW_PROD === 'true'` の AND、 非 production = `process.env[envKey] === 'true'` のみ。 既存 caller の boolean 判定を helper 呼出に置換。
- [ ] **完了条件**: helper test 5 case (prod allow=true × env=true / prod allow=false × env=true / preview env=true / dev env=true / 未設定)。 既存 OCR + bulk path test 全 pass。 Critical 0、 [reviewed]。

---

### Task T-A3: #6 GEMINI_DAILY_LIMIT production fail-fast

**Files:**
- Modify: `lib/ai-usage-counter.ts` + 既存 test

- [ ] **目的**: production で `GEMINI_DAILY_LIMIT` env 欠落時 startup throw、 quota 機構の no-op を防ぐ (audit §10.3 (b) #6)。 現状 silent fallback 経路を fail-fast 化。
- [ ] **制約**: production の場合のみ throw (`VERCEL_ENV === 'production'` 判定)。 preview / dev は警告 log のみで fallback (現挙動) 維持。 throw 文言: `'GEMINI_DAILY_LIMIT must be set in production (see docs/superpowers/specs/2026-06-12-y2-launch-hardening-design.md §2.1 #6)'`。
- [ ] **完了条件**: test 3 case (prod 欠落 = throw / prod 設定済 = pass / dev 欠落 = warn pass)。 既存 quota gate 経路の挙動不変。 Critical 0、 [reviewed]。

---

### Task T-A4: #13 proxy.ts webhook bypass

**Files:**
- Modify: `proxy.ts` + 関連 test (proxy 経由 webhook hit の contract)

- [ ] **目的**: `proxy.ts` matcher から `/api/webhooks/(.*)` を除外、 webhook が Clerk auth context を要求しないことを構造保証 (audit §10.3 (b) #13)。 将来 regression を構造で防ぐ。
- [ ] **制約**: 既存 matcher の他 path (例: `/app/(.*)`) は不変、 webhook path のみ negative pattern (`createRouteMatcher` の skip list) で除外。 Clerk middleware の標準 pattern に沿う。
- [ ] **完了条件**: contract test 1 件 (webhook URL request が `auth()` context なしで 200 帰着)。 既存 proxy 関連 test 全 pass。 Critical 0、 [reviewed]。

---

### Task T-A5: H4 OPS webhook fail-fast + 代替 error sink

**Files:**
- Modify: `lib/ops.ts` + 既存 test

- [ ] **目的**: `OPS_DISCORD_WEBHOOK_URL` 未設定で production fail-fast (起動時 `lib/ops.ts` level)、 fallback = `logger.error({event: 'ops.notify.unreachable', ...})` で stderr 必須残し (audit §10.3 (b) #14)。 silent fallback で ops 通知が黙って失敗する経路を解消。
- [ ] **制約**: production = startup throw、 preview / dev = warn のみ。 fallback `logger.error` は Y-1 logger.ts の Sentry-swap-ready interface 不変。 既存 `notifyOps` signature 不変。
- [ ] **完了条件**: test 4 case (prod 欠落 = throw / prod 設定済 = notify 成功 / fetch 失敗 = logger.error fallback / dev 欠落 = warn)。 既存 `notifyOps` 呼出 path 全 pass。 Critical 0、 [reviewed]。

---

### Task T-A6: #10 webhook clerk payload zod 化

**Files:**
- Create: `lib/validation/clerk-webhook.ts` + test
- Modify: `app/api/webhooks/clerk/route.ts`

- [ ] **目的**: Clerk webhook (`user.created` / `user.deleted`) payload を zod schema で safeParse、 unknown field を ignore (Clerk schema drift 耐性、 audit §10.3 (b) #10)。
- [ ] **制約**: schema は Clerk 公式 webhook docs 準拠の最小 field set (`type`, `data.id`, `data.email_addresses`, `data.deleted_at` 等、 Y-1 T5 mutation-schemas precedent 流に shared 不付)。 既存 handler logic 不変、 受領段で `safeParse` → fail 時 200 + `logger.warn` (Clerk 再送回避)。 unknown field は `.passthrough()` 相当で ignore (drift 耐性)。
- [ ] **完了条件**: schema test 3 case (期待 shape pass / unknown field 含む pass / 必須 field 欠落 = silent + log)。 既存 webhook clerk test 全 pass。 Critical 0、 [reviewed]。

---

### Task T-A7: #15 contact rate limit

**Files:**
- Create: `lib/rate-limit/contact-action.ts` + test
- Modify: `app/(marketing)/contact/actions.ts` + 既存 test

- [ ] **目的**: contact form の Server Action に IP / userId (signed-in 時) 単位 rate limit 導入、 abuse 防止 (audit §10.3 (b) #15)。 contact は Server Action 経路 (`/api/contact` route なし)、 actions.ts 内に組込。
- [ ] **制約** (OT 裁定 2026-06-12 反映): 暫定 storage = in-memory LRU (**Vercel serverless では単一 instance 仮定不成立 = `per-warm-instance の best-effort 抑止`と性格付け**、 helper header comment 明記)。 将来差替先 (multi-instance 一貫 rate limit) = **Vercel KV / upstash/ratelimit** の TODO comment を helper header に明記、 H7 (perf 切り分け) の結果次第で sub-plan B 内併合の余地ありの脚注。 key = `IP` (anonymous) / `userId:<uuid>` (signed-in)。 **limit = 5 req/h (OT 承認済、 2026-06-12)**。 突破時は ContactSubmitResult の error variant ('rate_limited') を返す (UI 側で 「しばらくしてからもう一度」 等表示)。 **(旧 OT 判断 stop = 解除済、 OT 一括承認時に limit 値確定)**。
- [ ] **完了条件**: helper test 4 case (5 件以内 pass / 6 件目 block / 1h 経過後 reset / IP 異なれば独立)。 contact action test に rate_limited 経路 1 case 追加 + 既存 case 全 pass。 Critical 0、 [reviewed]。

---

### Task T-A8: H5 webhook secret env-aware (**重要 fix**)

**Files:**
- Create: `lib/env/webhook-secret-gate.ts` + test
- Modify: `app/api/webhooks/clerk/route.ts` / `app/api/webhooks/stripe/route.ts`

- [ ] **目的**: `STRIPE_WEBHOOK_SECRET` / `CLERK_WEBHOOK_SECRET` を **production = required (起動時 fail-fast)、 preview = warn のみ、 local = skip** に env-aware 化 (audit §10.3 (b) #17)。
- [ ] **制約**: helper = `requireWebhookSecret(envKey: string, label: string): string` (production だけ throw、 他 tier は warn fallback)。 既存 webhook signature verify 経路の secret 取得を helper 経由化。 **重要 fix 経路** (CLAUDE.md): 無 tag commit、 OT 実機確認後 amend で `[reviewed]`。 commit message に 「無 tag (重要 fix、 amend 待ち)」 を 1 行明記。
- [ ] **完了条件**: helper test 4 case (prod missing = throw / prod set = string / preview missing = warn fallback / local missing = skip)。 既存 webhook clerk/stripe test 全 pass。 **commit = 無 tag、 OT stg 実機 (実 webhook 配信) 確認待ち**。

---

### Task T-A9: #11c deletion-status nonce/signed token 化 (**重要 fix**)

**Files:**
- Create: `lib/security/deletion-token.ts` + test
- Modify: `app/api/me/deletion-status/route.ts` + token 付き URL 生成 caller (grep `deletion-status` で特定)
- Modify: `.env.example` (`DELETION_TOKEN_SECRET=` 追記、 CLAUDE.md §環境変数 同 commit 規律)

- [ ] **目的**: 削除 status 確認 URL の予測可能性排除、 server signed token (HMAC-SHA256 + ttl 24h) で query parameter 化 (audit §10.4 #11、 Y-2 格上げ)。
- [ ] **制約**: HMAC key = 新規 env `DELETION_TOKEN_SECRET` (production = required、 `requireWebhookSecret` と同 pattern)。 token format = `<user_id>.<exp_ts>.<hmac>` (base64url encoded)、 ttl 24h。 caller の URL 生成箇所を grep → helper `signDeletionToken(userId)` 経由化。 検証 = `verifyDeletionToken(token): {userId, expired}`、 token 不正 = 401、 期限切れ = 410 Gone、 他 user の token = 401 (現 session user と mismatch)。 **重要 fix 経路**: 無 tag commit + OT 実機確認後 amend。
- [ ] **完了条件**: helper test 6 case (token 生成 / 検証成功 / token 不正 401 / 期限切れ 410 / 他 user token 401 / `DELETION_TOKEN_SECRET` 欠落 prod = throw)。 既存 deletion-status route test 全 pass + 401/410 case 追加。 `.env.example` 同 commit 追記確認。 **commit = 無 tag、 OT stg 実機 (token 不正 / 期限切れ / 正規 URL) 確認待ち**。

---

### 🛑 Sub-plan A 末尾 stop checkpoint (T-A8 + T-A9 完了後)

- T-A8 H5 + T-A9 #11c が **無 tag commit 2 件** で積まれた状態。
- chat 報告: 「Sub-plan A 実装完了、 H5 + #11c は無 tag commit (SHA: <H5_SHA>, <#11c_SHA>)、 stg push + 実機確認お願い」。
- OT stg smoke 内容: ① 実 Stripe webhook 配信 → signature verify → 200 ② 実 Clerk webhook 配信 → 同上 ③ deletion-status URL を token 付きで生成 → 期待 user で開く 200 ④ token 改ざんで 401 ⑤ ttl 経過 token で 410 ⑥ `DELETION_TOKEN_SECRET` 未設定環境で startup throw 確認。
- OT 承認後、 CC が **未 push の状態で `git commit --amend`** により H5 → #11c の順で `[reviewed]` tag 追記。
- push は OT 専権 (CC は push 経路を持たない、 Y-1 規律同)。

---

## Self-Review (spec 突合 + placeholder + 型一貫性)

1. **Spec 突合**: spec §2 (Sub-plan A) 9 item (H1 / H4 / H5 / #5 / #6 / #10 / #13 / #15 / #11c) すべて T-A1 〜 T-A9 に 1:1 マッピング。 #9 は §10.1 で Phase 4 既定確認、 本 plan には含まない (取り残し 0)。
2. **Placeholder scan**: TBD / TODO / 「適宜」 無し。 各 task で完了条件 + test case 数を具体化。 OT 判断 stop は T-A7 (rate limit 値) のみ、 T-A8 / T-A9 は重要 fix stop checkpoint。
3. **型一貫性**: helper signature 名 (`classifyBulkError` / `isLogGateOpen` / `requireWebhookSecret` / `signDeletionToken` / `verifyDeletionToken` / `clerkWebhookSchema` / `rateLimitContact`) を全 task で統一。 重複・揺れなし。

self-review pass。

---

## 行数報告

CLAUDE.md sprint 規律: plan 完成時点で最終行数を報告すること。 本 plan 最終行数は file 保存後 `wc -l` で確定、 commit message 末尾に明記。

---

## Execution Handoff

本 plan は Y-2 sprint の **3 plan 起草の Sub-plan A (第 1 弾)**。 Sub-plan B (performance) / C (config-header-cleanup) 起草完了後、 OT review gate に 3 plan 一括提示 (OT 指示: 個別提示 = 往復 3 回回避)。

CLAUDE.md 既定 = `superpowers:subagent-driven-development` (本 sprint も既定方式)。 OT 一括 review 承認後、 T-A1 から実装開始。
