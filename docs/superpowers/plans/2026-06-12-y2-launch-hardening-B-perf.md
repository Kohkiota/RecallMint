# Sprint Y-2 Sub-plan B: performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (本 sprint の既定実装方式、 CLAUDE.md 明示) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** audit §10.3 (b) の P1 perf 7 件 (#1a / #1b / #1c / #1d / #1e / #2 / #7) + 軽微 2 件 H7 (`/app/tags` 初期遅延切り分け) を 8 task で消化、 Y-2 最大リスク #1b (per-mutation tx 並列化) を spec §3.2 順序保証契約付きで安全に通す。

**Architecture:** 案 = H7 切り分け調査 (T-B1) を先発、 結果次第で #1c-#1e (T-B4 / T-B5 / T-B6) と合流可。 SQL/Dexie 系は before/after の **EXPLAIN ANALYZE + 実 row count** を session log に貼付。 #1b は順序保証契約 + 順序破壊 regression test 必須、 entity key (`(entity_type, entity_id)`) 内逐次 / 独立 key 間並列の選択並列化。 #7 OCR semaphore は独立並走。

**Spec:** `docs/superpowers/specs/2026-06-12-y2-launch-hardening-design.md` §3 (Sub-plan B) が正本。 §3.2 が #1b 順序保証契約の正本。

**Tech Stack:** Next.js 16 / TS strict / Drizzle / Dexie / PostgreSQL / vitest / pnpm 10。

---

## 全体ルール (各 task 冒頭で参照、 個別 task で再掲しない)

1. **TDD**: 各 task は test 先行。 既存 test を壊さない。
2. **計測契約**: SQL/Dexie 系の改善は **before/after の EXPLAIN ANALYZE (server) or DevTools Performance (client) + 実 row count** を session log に貼付。 性能改善幅は実数で記録 (相対 % / 「速くなった」 等の主観表記禁止)。
3. **CLAUDE.md 絶対ルール**: Stripe / Clerk / AI 既知 + sprint 完了 gate (whole-repo `pnpm lint --max-warnings=0` exit 0) + commit `[reviewed]` tag。
4. **review 経路**: 各 task PR 直前 `superpowers:requesting-code-review` skill canonical (改変禁止)。
5. **#1b 順序保証契約** (Y-2 最大リスク、 spec §3.2): 「同一 entity key (`(entity_type, entity_id)`) 内は順序維持、 独立 key 間のみ並列」。 cascade delete (tag_category delete → 配下 option / card_tags) と dependent multi-mutation (Grid-2 対象) は entity key 境界外、 T-B3 stop checkpoint で OT 判断仰ぐ。 順序破壊 regression test (= 違反 path で `throw new Error('ordering violated')`) を必ず含む。
6. **stop checkpoint** (OT 裁定 2026-06-12 反映、 すべて解除済): ~~T-B1~~ (H7 切り分け結果 → (ii) 独立 T-B1' 採用、 残 ordering = T-B2 → T-B3 (stop) → T-B4 → T-B1' → T-B5 → T-B6 → T-B7 → T-B8 で OT 確定 2026-06-12)、 ~~T-B3 #1b entity key 境界 + 着手承認~~ (最狭 entity key + cascade/dependent 逐次 fallback で OT 一括承認時に確定、 実装内は self-check のみ)。 ただし **T-B3 は最大リスク task のため、 実装着手直前に OT へ再確認を入れる** (push しない / 順序保証契約の self-check 結果を chat 報告) — これは旧 stop の継続ではなく実装規律。
7. **spec 凍結**: 実装フェーズで spec 書き換えない (H7 結果が perf 同根なら spec §3.1 H7 内訳を「sub-plan B 内併合」 に更新、 それ以外は spec 不変)。
8. **Next 設定 file gate** (T-A4 fix 反映、 CLAUDE.md §Sprint 完了 gate と整合): `proxy.ts` / `next.config.*` / matcher 関連 file を触る task は per-task gate に `pnpm build` 必須 (vitest / typecheck / lint は path-to-regexp 制約を検出不能、 T-A4 元 45a74cf で Vercel build error 発生、 6f82025 で hotfix)。

**File Structure** (新規 / 主要 modify):
- 新規 `lib/sync/server/group-mutations-by-entity-key.ts` (T-B3、 #1b)
- 新規 `lib/ocr/semaphore.ts` (T-B8、 #7)
- 新規 session log: `docs/superpowers/sessions/2026-06-12-y2-tags-perf-investigation.md` (T-B1、 H7)
- modify: `app/api/review-events/bulk/route.ts` (T-B2、 #1a)
- modify: `app/api/entity-mutations/bulk/route.ts` (T-B3、 #1b)
- modify: 試験一覧 useLiveQuery 経路 (T-B4、 #1c、 grep で特定)
- modify: `app/(app)/app/tags/_components/category-list.tsx` (T-B1'、 H7 (ii) per-option N+1 解消)
- modify: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` (T-B5、 #1d)
- modify: dashboard-actions 経路 (T-B6、 #1e、 grep で特定)
- modify: get-dexie-session-cards 経路 (T-B7、 #2、 grep で特定)
- modify: `lib/ai/clients/gemini.ts` + OCR 呼出 path (T-B8、 #7)

---

### Task T-B1: H7 `/app/tags` 初期遅延 切り分け調査 (先発、 投資対効果判断)

**Files:**
- Read-only investigation (code 変更なし)
- Create: `docs/superpowers/sessions/2026-06-12-y2-tags-perf-investigation.md`

- [ ] **目的**: T2b で async RSC 化した `tags/page.tsx` の初期表示遅延 (軽微 2、 OT 報告) を Lighthouse + DevTools MCP / Playwright で計測、 (a) server roundtrip / (b) Dexie 初回 fetch / (c) SSR rendering の 3 要因を分離 (spec §3.1 H7)。
- [ ] **制約**: code 変更なし、 stg 実走のみ。 計測値は 3 回平均 (FCP / LCP / TBT / TTI)、 同時に Network waterfall + Performance trace + Dexie initial query 数を取得。 比較対象 = Y-1 prod 反映前 (`/app/exams` 等) の同 metric。
- [ ] **完了条件**: 切り分け結果 (a / b / c のどの要因が dominant) を session log に記載 (実数値 + screenshot + trace 保存 path)、 fix 位置を OT 提案: (i) perf 同根なら T-B4 / T-B5 / T-B6 / T-B7 群に併合 / (ii) 軽ければ独立 Task T-B1' (本 plan 末尾追加) / (iii) 重ければ Y-3 繰越提案。 **stop checkpoint**: OT 判断後に Sub-plan B の残り ordering 確定。 → **完了 2026-06-12** (session log commit `19a3978`、 dominant = (b) Dexie per-option N+1 ~95%、 OT 裁定 = **(ii) 独立 T-B1' 採用 (本 plan 内、 T-B5 直前に挿入)**)。

---

### Task T-B2: #1a review-events/bulk study_days SQL N+1 解消

**Files:**
- Modify: `app/api/review-events/bulk/route.ts` + 既存 test

- [ ] **目的**: session 終了時の study_days per-card UPSERT を per-session 1 文集約 (audit §10.3 (b) #1 of 5)。
- [ ] **制約**: SQL は `INSERT ... ON CONFLICT (date) DO UPDATE SET count = study_days.count + EXCLUDED.count` 1 文集約、 COALESCE / SUM で連続 increment。 集計値の意味論不変 (date 軸 / count / streak 計算前提)。
- [ ] **完了条件**: 計測: 50 card session で SQL 実行回数 50 → 1 を session log に貼付 (before/after `EXPLAIN ANALYZE` 結果)。 既存 review-events bulk test 全 pass + study_days 集計値 regression test 1 case。 Critical 0、 [reviewed]。

---

### Task T-B3: #1b entity-mutations/bulk per-mutation tx 順序保証付き選択並列化 (Y-2 最大リスク)

**Files:**
- Create: `lib/sync/server/group-mutations-by-entity-key.ts` + test
- Modify: `app/api/entity-mutations/bulk/route.ts` + 既存 test

- [ ] **目的**: bulk 内 mutations を `(entity_type, entity_id)` で grouping、 同一 key 内は順序維持、 独立 key 間のみ `Promise.allSettled` で並列化 (spec §3.2、 audit §10.3 (b) #1 of 5)。
- [ ] **制約** (OT 裁定 2026-06-12 反映): **spec §3.2 順序保証契約**準拠 (全体ルール 5 参照)。 **entity key 境界 = 「同一 `(entity_type, entity_id)` のみ」 の最狭定義 + cascade delete / dependent multi-mutation は entity key 境界外で逐次 fallback (Grid-2 対象 = 本 sprint で並列化しない) = OT 承認済 (2026-06-12)**。 response の mutation_id 順は維持 (= 入力順正規化)。 wire format / `{ok, applied, failed}` 形不変。
- [ ] **完了条件**: helper test 4 case (同一 key 内逐次 / 独立 key 間並列 / 順序破壊 regression = 同一 key を意図的 parallel した path で `throw` 検知 / cascade-like 入力 = 逐次 fallback)。 既存 bulk route test 全 pass + 並列計測 (10 独立 key 入力で逐次 vs 並列の wall-clock 比較を session log)。 **(旧 OT 判断 stop = 解除済、 OT 一括承認時に entity key 境界確定。 実装内では spec §3.2 と突合する self-check のみ)**。

---

### Task T-B4: #1c exam-list-live materialize 回避 (案 b、 spec 2026-06-13 反映)

**Files:**
- Modify: `app/(app)/app/exams/_components/exam-list-live.tsx` + `app/(app)/app/exams/_components/exam-list-live.test.tsx`
- Modify: `lib/client-db.ts` (Dexie v6 で `cards` table に compound index `[user_id+exam_id]` 追加、 純粋追加 / 既存データ保持)
- Reference: `docs/superpowers/specs/2026-06-13-y2-t-b4-design.md` (本 task の方針確定 spec)

- [ ] **目的**: exam-list-live の per-exam 集計を `db.cards.where('user_id').toArray()` (cards ~2k 件以上を JS object 化) → `Promise.all(activeExams.map(e => db.cards.where('[user_id+exam_id]').equals([userId, e.id]).count()))` に置換し、 materialize 0 を構造保証する (spec §2.1 / §2.4 = Dexie native `IDBIndex.count(IDBKeyRange)` 経路、 row 本体 fetch なし)。 旧 plan の subset 化前提 (archived exam の cards 除外) は spec §1.2 確認結果 (archive 軸が運用上機能してない、 archived_at SET write 経路 0 件) で破棄。
- [ ] **制約**: Dexie v6 で `cards` に compound index `[user_id+exam_id]` を追加 (旧 plan の「新規 migration 不要」 制約は spec §1.2 で解除済、 ユーザー 0 / DB 破棄可前提)。 過去 v2 / v4 / v5 と同形の純粋 index 追加 (store drop なし、 既存データ保持、 upgrade callback 不要)。 owner isolation (test #6) は index 構造 (`.equals([userId, examId])` の第 1 要素 fix で他 user の cards に index 経路で到達不能) で担保し、 client 防御層は撤去せず強化。 `exams.cardCount` 非読の設計判断は維持 (spec §1.4、 local-first / optimistic mutation の整合性が背景)。 useLiveQuery subscription 契約は維持 (cards table を触る事実は変わらないため、 server pull / optimistic mutation 双方で自動再描画)。 server 側 (Drizzle/Postgres) 対応は不要 (spec §1.4 + Step 0 確認結果: `getActiveExamsWithCardCount` 撤去済、 `/app/exams` 表示 path に per-exam 集計 SELECT は存在しない)。
- [ ] **完了条件**: ① per-exam materialize 0 の構造保証 = regression test 1 件 (spy で `db.cards.where('[user_id+exam_id]').equals` の呼出回数 = active exam 件数 / 旧経路 `db.cards.where('user_id').equals(userId).toArray()` の呼出 = 0 を assert、 旧経路復活検知)。 ② 既存 exam-list-live test 6 件全 pass (test #6 owner isolation を index 構造で満たす)。 ③ stg 実機 DevTools Performance で `/app/exams` の dexie_render_attr が計測可能な幅で改善 (実数値 + T-B1 比較 + materialized row 数を session log に貼付。 計測 fixture = T-B1 seed runbook `docs/superpowers/sessions/2026-06-12-y2-b1-seed-runbook.md` 流用 + exam 数を 3 → 100 規模に拡張)。 ④ **exam 数拡張 fixture で候補 (a) (`where('[user_id+exam_id]').between([U,MIN],[U,MAX]).keys()` + JS Map 集計) との実測比較**を同 session log に貼付し、 100 exam 規模で (b) が依然優位であることを確認 (逆転していたら本 task 内で (a) へ切替、 spec §2.5 / §7-3 の余地反映)。 ⑤ **per-task gate** = whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` + `pnpm test` + **`pnpm build`** 全 exit 0 (Dexie schema 変更を build が検出経路。 vitest / typecheck は IDB schema 変更を検出不能、 ブラウザ実走 = stg build で表面化、 CLAUDE.md sprint 完了 gate + Next 設定 file gate の趣旨を本 task に適用)。 ⑥ Critical 0、 [reviewed] (UI 微調整 / 認証・決済・削除・外部副作用に該当しないため、 review pass 後即 [reviewed] 付与の通常経路)。

---

### Task T-B1': H7 (ii) `/app/tags` per-option N+1 解消 (T-B1 結果反映、 T-B5 直前挿入)

**Files:**
- Modify: `app/(app)/app/tags/_components/category-list.tsx` + 関連 component test

- [ ] **目的**: T-B1 で確定した dominant 要因 (b) Dexie per-option N+1 (`category-list.tsx:127-148` の `db.card_tags.count()` × options 数) を解消、 `/app/tags` text_appeared を baseline 4,830 ms → **< 1,500 ms (3x 改善)** に持っていく (T-B1 session log `2026-06-12-y2-tags-perf-investigation.md` 参照、 spec §3.1 H7 (ii) 経路)。
- [ ] **制約**: per-option `db.card_tags.count()` × N を `db.card_tags.where('option_id').anyOf(allOptionIds).toArray()` 単一 query + JS reduce で `optionId → count` の hash 集計に置換 (T-B5 と同形 anyOf precedent、 helper 抽出はしない = T-B5 と同じ inline 形)。 useLiveQuery subscription 契約は維持 (server pull 書込で自動再描画)。 memoize key = `categories.flatMap(c => c.options).map(o => o.id).sort().join(',')` 等の安定 key。 Grid-1 で正規化予定の旨は comment 1 行で明示。
- [ ] **完了条件**: stg 同 fixture (= T-B1 seed runbook `2026-06-12-y2-b1-seed-runbook.md` 再利用) で before/after の text_appeared / Dexie query 数を計測 (per-option count() N+1 → anyOf 1 query)、 **< 1,500 ms 達成**を session log に貼付。 既存 category-list test 全 pass + per-option N+1 regression test 1 case (`db.card_tags.count` 呼出回数 ≤ 1 を assert、 N+1 復活検知)。 Critical 0、 [reviewed]。

---

### Task T-B5: #1d inline-card-list 全 card_tags → page subset + memoize

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` + 関連 test

- [ ] **目的**: inline-card-list の `card_tags` query を `card_id IN (current page)` に絞り + memoize、 全 card_tags scan を回避 (audit §10.3 (b) #1 of 5)。
- [ ] **制約**: page 表示の tag 挙動不変。 memoize key = `cards.map(c => c.id).sort().join(',')` 等の安定 key。 Dexie の `where('card_id').anyOf(...)` 経由 (Y-1 #3 同形、 Grid-1 合流前なので暫定形、 Grid-1 で正規化予定の comment 1 行)。
- [ ] **完了条件**: 50 card / 200 card_tags fixture で query 行読み数を before/after で計測 (全 scan → page subset)。 既存 inline-card-list test 全 pass。 Critical 0、 [reviewed]。

---

### Task T-B6: #1e dashboard-actions 全 cards → `[user_id+due]` index 使用

**Files:**
- Modify: dashboard-actions 経路 (grep `dashboard-actions\|dashboardActions` で特定) + Dexie schema 確認

- [ ] **目的**: dashboard の card count を既存 `[user_id+due]` compound index 経由 query に置換、 高速化 (audit §10.3 (b) #1 of 5)。
- [ ] **制約**: index は既存 (stg Dexie schema v50 確認、 Y-1 smoke 時の DB version)、 新規 migration なし。 dashboard 表示挙動不変。 query = `db.cards.where('[user_id+due]').between([userId, MIN_DATE], [userId, MAX_DATE])` 形。
- [ ] **完了条件**: dashboard load 時の Dexie query 経路を before/after で確認 (全 cards scan 0 件、 `[user_id+due]` between 経路 1 件、 DevTools Performance で確認)。 既存 dashboard test 全 pass。 Critical 0、 [reviewed]。

---

### Task T-B7: #2 get-dexie-session-cards 全 cards → index 利用

**Files:**
- Modify: get-dexie-session-cards 経路 (grep `get-dexie-session-cards\|getDexieSessionCards` で特定) + 既存 test

- [ ] **目的**: 学習 session 開始時の全 cards fetch を `[user_id+due]` index 経由に集約 (audit §10.3 (b) #2、 T-B6 と同 index hit)。
- [ ] **制約**: T-B6 と同 index 使用、 session card 選定 logic 不変。 between 範囲 = `due <= now` (期限到来分のみ)。
- [ ] **完了条件**: session 開始時の Dexie scan 範囲を before/after で計測 (全 cards → due 範囲のみ)。 既存 session test 全 pass。 Critical 0、 [reviewed]。

---

### Task T-B8: #7 OCR backoff worst-case ~660s への semaphore concurrency limit

**Files:**
- Create: `lib/ocr/semaphore.ts` + test
- Modify: `lib/ai/clients/gemini.ts` / OCR 呼出 path (process.ts 等)

- [ ] **目的**: service-wide で OCR 同時実行を制限する semaphore 導入、 worst-case ~660s への concurrency 圧迫を解消 (audit §10.3 (b) #7)。
- [ ] **制約** (OT 裁定 2026-06-12 反映): **N=2 で OT 承認済 (運用 tuning 範疇、 spec §7-6)**。 Gemini 2.5 Flash free tier RPM ~60 / 平均ペイロード ~1MB / OCR 単発 ~5s から算出。 突破時は queue (FIFO)。 timeout = backoff worst-case 660s 内 (queue 待機含めて全 request が timeout 範囲)。 N 値の最終調整は実装後 stg 計測で運用 tuning (本 sprint test では fixture 値 2 で固定)。
- [ ] **完了条件**: semaphore helper test 4 case (N=2 内 pass / N+1 = queue / queue cancel / timeout 超過 = reject)。 既存 OCR test 全 pass + worst-case backoff 経路 mock test 1 case。 Critical 0、 [reviewed]。

---

## Self-Review (spec 突合 + placeholder + 型一貫性)

1. **Spec 突合**: spec §3 (Sub-plan B) 8 item (H7 / #1a / #1b / #1c / #1d / #1e / #2 / #7) すべて T-B1 〜 T-B8 に 1:1 マッピング。 取り残し 0。 **T-B1' は T-B1 結果反映の追加 task (spec §3.1 H7 (ii) 経路、 OT 裁定 2026-06-12)、 spec 1:1 マッピング外の派生実装 (spec 変更不要、 H7 fix の現実化)**。
2. **Placeholder scan**: TBD / TODO / 「適宜」 無し。 stop checkpoint 2 件 (T-B1 H7 結果 / T-B3 #1b entity key 境界) を明示。 grep で特定する file path は task 着手時に確定 (file 名 placeholder ではなく「grep 経路明示」 として運用)。
3. **型一貫性**: helper signature (`groupMutationsByEntityKey` / `OcrSemaphore` 内 `acquire` / `release`) 統一。 spec §3.2 で定義した entity key 概念は T-B3 で唯一参照、 他 task 流用なし。

self-review pass。

---

## 行数報告

CLAUDE.md sprint 規律: plan 完成時点で最終行数を報告すること。 本 plan 最終行数は file 保存後 `wc -l` で確定、 commit message 末尾に明記。

---

## Execution Handoff

本 plan は Y-2 sprint の **3 plan 起草の Sub-plan B (第 2 弾)**。 Sub-plan C (config-header-cleanup) 起草完了後、 OT review gate に 3 plan 一括提示 (OT 指示: 個別提示 = 往復 3 回回避)。

CLAUDE.md 既定 = `superpowers:subagent-driven-development` (本 sprint も既定方式)。 OT 一括 review 承認後、 T-B1 (H7 切り分け先発) → OT 判断 → 残り ordering 確定 → T-B2 以降実装開始。

**残り実装 ordering 確定 (OT 裁定 2026-06-12 反映)**: T-B2 → T-B3 (実装着手直前に OT 再確認、 push しない) → T-B4 → T-B1' → T-B5 → T-B6 → T-B7 → T-B8。 T-B3 を先発させない (最大リスク task を先発させる積極理由なし、 serial baseline 取得済で後置しても腐らない、 T-B5 と隣接で T-B1' が anyOf precedent を踏む形)。
