# Sprint Y-2 Sub-plan C: config / header / cleanup / docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (本 sprint の既定実装方式、 CLAUDE.md 明示) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** audit §10.3 (b) + §10.4 + 軽微 1 + OT 追加の config / header / docs 系 6 item (H2 / H3 / H6 / #8 / Perm / #10d) を独立 task で消化、 OT 判断 stop (#8 content_version 用途決定) と 2 段確定 (H3 段 1/2) を明示管理。

**Architecture:** 案 = 完全独立な 6 item を単独 task として並走、 helper 抽出は H6 (`LOG_LEVEL` 判定) と H3 (zod max 制約 → 後段 item format schema) のみ。 H3 は spec §10.3 SELECT 文に基づく OT 実行結果待ちで段 2 が発火、 Sub-plan A と並走可。 #8 OT 判断 stop 中も他 task が並走可。 Perm の directive list 確定は stg gate (spec §10.2) 経由。

**Spec:** `docs/superpowers/specs/2026-06-12-y2-launch-hardening-design.md` §4 (Sub-plan C) が正本。 §10.2 が Perm の default candidate + stg gate 4 step 運用の正本、 §10.3 が H3 段 2 SELECT 文の正本。

**Tech Stack:** Next.js 16 (App Router) / TS strict / Drizzle / zod / vitest / pnpm 10。

---

## 全体ルール (各 task 冒頭で参照、 個別 task で再掲しない)

1. **TDD**: 各 task は test 先行。 既存 test を壊さない。
2. **設定変更の wire 影響なし契約**: outbox cap 延長 (H2) / log level filter (H6) / zod bound (H3) は client 既存挙動に regression を起こさない (cap 30d 延長 = 既存 24h 内 pending は影響なし、 LOG_LEVEL filter = production の info 抑止のみ、 zod max = 既存 範囲内入力は通る)。
3. **CLAUDE.md 絶対ルール**: Stripe / Clerk / AI 既知 + sprint 完了 gate (whole-repo `pnpm lint --max-warnings=0` exit 0) + commit `[reviewed]` tag。 docs 系 (T-C5 #10d) は `[no-review]` 可。
4. **review 経路**: code 系 task PR 直前 `superpowers:requesting-code-review` skill canonical (改変禁止)。
5. **stop checkpoint** 2 件: T-C4 (#8 content_version 用途決定、 OT 判断要)、 T-C2 段 2 (H3、 OT SELECT 結果受領待ち)。
6. **spec 凍結**: 実装フェーズで spec 書き換えない (Perm directive list は spec §10.2 stg gate で確定、 H3 段 2 item format は OT 結果で確定、 いずれも spec 内 follow-up 手順に沿う)。

**File Structure** (新規 / 主要 modify):
- 新規 `lib/validation/review-session-bounds.ts` (T-C2、 H3 段 1)
- 新規 `lib/logger/level-filter.ts` (T-C3、 H6) — `lib/logger.ts` に method 追記でも可、 caller 単体で完結する場合は別 file 不要
- 新規 `docs/ops/webhook-runbook.md` (T-C5、 #10d)
- 新規 session log: `docs/superpowers/sessions/2026-06-12-y2-content-version-usage.md` (T-C4、 #8 用途決定材料)
- modify: `lib/sync/entity-mutation-flush.ts` 等 outbox 24h cap 経路 (T-C1、 H2)
- modify: `lib/logger.ts` (T-C3、 H6 = 既存 emit() に level filter 追加)
- modify: `app/api/review-events/bulk/route.ts` 内 embed zod schema (T-C2、 H3 段 1。 server-side schema は route file 内 inline 定義、 別 file 化されていない、 実在 file 確認済 2026-06-12)
- modify: `next.config.js` or `next.config.ts` (T-C6、 Perm headers())
- modify: `.env.example` (T-C3 で `LOG_LEVEL=` 追記、 CLAUDE.md §環境変数 同 commit 規律)

---

### Task T-C1: H2 outbox cap 24h → 30d **延長** (隔離機構維持)

**Files:**
- Modify: `lib/sync/entity-mutation-flush.ts` 等 outbox 24h cap 経路 (grep `24h\|24 *\* *60\|86400\|24h 自動 failed` で特定) + 既存 test

- [ ] **目的**: entity-mutation-flush-trigger の自動 failed 隔離 timeout を **24h → 30d に延長** (audit §10.3 (b) #4)。 **隔離機構は維持** (30d 超は将来 ops 通知の打鍵点として温存)、 「撤去」 ではない。
- [ ] **制約**: 既存 cap 定数を 24h → 30d (= `30 * 24 * 60 * 60 * 1000` ms or 同等) のみ変更、 隔離分岐 (`sync_status = 'failed'` 遷移経路) は不変。 commit message に「30d 延長 (隔離機構維持、 30d 超は将来 ops 通知の打鍵点として温存)」 を 1 行明記、 spec OT 修正 3 反映の trace 残す。
- [ ] **完了条件**: cap 定数の値 grep 確認 (24h 関連 magic number 全削除、 30d 定数 1 件のみ残置)。 既存 outbox flush test 全 pass + 30d 経過 case 1 件 (mock 時刻で `now - 31d` の pending = failed 遷移確認)。 Critical 0、 [reviewed]。

---

### Task T-C2: H3 session.card_ids max 2000 + selected_answer_ids max 50 (**段 1 = zod max**)

**Files:**
- Create: `lib/validation/review-session-bounds.ts` + test
- Modify: `app/api/review-events/bulk/route.ts` 内 embed zod schema (server-side schema は route file 内 inline 定義) + 既存 test

- [ ] **目的**: `study_sessions.card_ids` / `answer_events.selected_answer_ids` に zod max 制約のみ追加 (audit §10.3 (b) #12 段 1、 spec §10.3 物理確認済の実 table 名)。 item format (UUID / 順序 / 重複) は spec §10.3 SELECT 結果待ち = **段 2 で別 commit**。
- [ ] **制約**: 段 1 = zod `.array(z.unknown()).max(2000)` (card_ids) / `.max(50)` (selected_answer_ids) のみ。 段 2 は OT が Supabase dashboard で SELECT 実行 → 結果 chat 貼付 → CC が item format (`z.uuid()` array / 順序 array / 重複可否) を schema 化 → 同 file 修正で別 commit (T-C2-stage2)。 段 1 と段 2 は別 commit、 段 1 だけで完結可。
- [ ] **完了条件 (段 1)**: helper test 4 case (card_ids 2000 件 pass / 2001 件 fail / selected_answer_ids 50 件 pass / 51 件 fail)。 既存 review-events bulk test 全 pass。 Critical 0、 [reviewed]。 **stop checkpoint**: 段 1 commit 後、 chat に 「段 2 は OT SELECT 結果待ち、 Sub-plan A 並走中」 と報告、 OT 結果受領で段 2 着手。

---

### Task T-C3: H6 prod console info level → warn 以上に絞る (`LOG_LEVEL` env)

**Files:**
- Modify: `lib/logger.ts` + 既存 test (`lib/logger.test.ts`)
- Modify: `.env.example` (`LOG_LEVEL=info` 追記、 同 commit、 CLAUDE.md §環境変数)

- [ ] **目的**: `lib/logger.ts` に `LOG_LEVEL` env 判定を追加、 `emit()` 内で level filter (default = `info`、 production = `warn`)。 軽微 1 (OT 報告 prod console flush.kick info 出力過多) を解消。
- [ ] **制約**: env tier 判定: production (`VERCEL_ENV === 'production'`) で env 未指定なら `warn` default、 非 production は `info` default。 明示 `LOG_LEVEL=info` で production でも info 出力を許可可 (debug 経路)。 既存 `logger.info / warn / error / warnFromError` API 不変、 emit() 内側に level filter 1 段追加のみ。 Sentry-swap-ready interface (Y-1 既存) 維持。
- [ ] **完了条件**: `lib/logger.test.ts` に level filter case 4 追加 (prod default = warn 以上のみ / prod LOG_LEVEL=info = info 出力 / dev default = info 以上 / dev LOG_LEVEL=warn = info 抑止)。 既存 logger test 全 pass。 Critical 0、 [reviewed]。

---

### Task T-C4: #8 content_version 用途決定 (**OT 判断 stop**)

**Files:**
- Read-only investigation + 判断後の修正
- Create: `docs/superpowers/sessions/2026-06-12-y2-content-version-usage.md` (調査結果)

- [ ] **目的**: 現状 schema / drizzle / Dexie 内の `content_version` 利用箇所を grep 整理 → (a) 廃止 / (b) versioning gate として実装 を OT 判断 (audit §10.3 (b) #8)。
- [ ] **制約**: **OT 判断 stop**。 CC は調査のみ (1 page session log で grep 結果 + 各 callsite の役割推定 + Phase 4 roadmap 内位置付け確認) を spec §11 risks 4 のとおり実施、 chat に「(a) 廃止 / (b) 採用 / (c) Y-3 繰越」 の 3 案を提案 → OT 判断後に実装。 採用 (b) なら本 sprint 内 fix、 廃止 (a) なら本 sprint 内 remove (call site 全削除 + schema migration なし = TS 側のみ削除)、 (c) なら本 task のみ Y-3 繰越 (sub-plan C 内残 5 task 続行可)。
- [ ] **完了条件**: 調査 session log 1 page (grep 結果 + callsite 数 + 推定用途 + Phase 4 roadmap 確認)。 OT 判断後の実装 (採用 / 廃止) または繰越判定。 Critical 0、 [reviewed] (採用 / 廃止 commit)、 [no-review] (調査 session log commit)。 **(c) Y-3 繰越判定時 (OT 裁定 2026-06-12 反映): 本 task のみ Y-3 へ、 sub-plan C は残 5 task (T-C1 / T-C2 / T-C3 / T-C5 / T-C6) で完了可。 sprint 完了報告 + audit 突合表に「#8 = Y-3 繰越 (OT 判断、 2026-06-12)」 を明記、 帰属 trace を残す**。

---

### Task T-C5: #10d webhook runbook 整備 (docs)

**Files:**
- Create: `docs/ops/webhook-runbook.md`

- [ ] **目的**: Stripe / Clerk webhook の「stuck 検知 → 手動 retry 経路」 docs を集約 (audit §10.4 #10、 Y-2 格上げ)。 future: dashboard URL + 定期 job (cron 候補) も含む。
- [ ] **制約**: docs のみ (code 変更なし)。 内容は: Stripe Dashboard webhook 監視 URL / Clerk Dashboard webhook 監視 URL / stuck 検知の signal (`stripe_events.status = 'pending'` 経過時間 > 1h、 `clerk webhook log` 配信失敗連続 3 回) / 手動 retry 手順 (Dashboard の resend button or stripe-cli `stripe events resend`) / 定期 job 候補 (毎時 cron で stripe_events status 集計 → ops 通知)。 §10.2 / §10.3 (b) #20 (stripe_events processed_at/status 列) は Y-3 繰越のため、 本 docs では「Y-3 で stripe_events.processed_at 追加後に定期 job を実装」 と前提明記。
- [ ] **完了条件**: docs file 新設、 OT review (内容妥当性 = Stripe / Clerk Dashboard URL 正確性 + 手順現実性) で承認。 Critical 0、 [no-review] (docs commit、 CLAUDE.md §確定 docs 規律)。

---

### Task T-C6: Perm Permissions-Policy header (audit 外、 OT 追加)

**Files:**
- Modify: `next.config.js` (or `next.config.ts`、 grep で特定) + 既存 headers() 関連 test

- [ ] **目的**: HTTP `Permissions-Policy` header 追加、 spec §10.2 の default candidate (22 directive deny + `fullscreen=(self)`) を実装 (OT 追加、 audit 外)。
- [ ] **制約**: directive list は spec §10.2 完了結果 (Stripe redirect mode 確認 / Clerk passkey 未使用 確認) に基づく default candidate を使用、 記憶ベース固定禁止。 `next.config.js` の `headers()` 内に全 path matcher で directive 設定。 既存 CSP / X-Frame-Options 等 header 設定は不変。 **stg gate 4 step (spec §10.2)** で directive 確定: ① stg deploy ② DevTools MCP / Playwright で `/app/upgrade` Stripe redirect + Clerk sign-in/up + `/app` 主要 page + **`/app/upload` OCR upload (ファイル選択経路) 含む** 巡回 ③ console / Network response header / browser security warnings の violation 0 件確認 ④ 検出時は該当 directive を `self` 緩和 + 再 gate。
- [ ] **完了条件**: `next.config.js` に `Permissions-Policy` header 追加 (default candidate)。 既存 next.config test 全 pass。 stg gate 4 step 実走で violation 0 件確認 (session log に capture)。 Critical 0、 [reviewed]。

---

## Self-Review (spec 突合 + placeholder + 型一貫性)

1. **Spec 突合**: spec §4 (Sub-plan C) 6 item (H2 / H3 / H6 / #8 / Perm / #10d) すべて T-C1 〜 T-C6 に 1:1 マッピング。 取り残し 0。 H3 は段 1 (T-C2) + 段 2 (T-C2-stage2、 別 commit) の 2 commit 構造を明示。
2. **Placeholder scan**: TBD / TODO / 「適宜」 無し。 stop checkpoint 2 件 (T-C2 段 2 = OT SELECT 結果待ち / T-C4 #8 = OT 判断) を明示。 grep で特定する file path は task 着手時に確定 (file 名 placeholder ではなく「grep 経路明示」 として運用)。
3. **型一貫性**: helper signature (`reviewSessionBoundsSchema` の field 名 = `cardIdsSchema` / `selectedAnswerIdsSchema`、 logger level filter は既存 emit() 内に閉じる) 統一。

self-review pass。

---

## 行数報告

CLAUDE.md sprint 規律: plan 完成時点で最終行数を報告すること。 本 plan 最終行数は file 保存後 `wc -l` で確定、 commit message 末尾に明記。

---

## Execution Handoff

本 plan は Y-2 sprint の **3 plan 起草の Sub-plan C (第 3 弾 = 最終)**。 起草完了で **3 plan 揃って OT review gate に一括提示** (OT 指示: 個別提示 = 往復 3 回回避)。

CLAUDE.md 既定 = `superpowers:subagent-driven-development` (本 sprint も既定方式)。 OT 一括 review 承認後、 Sub-plan A T-A1 から実装開始、 Sub-plan B (T-B1 H7 先発) / Sub-plan C 並走可能 (Sub-plan 間依存なし = spec §3 / §4 / §2 で確認済)。
