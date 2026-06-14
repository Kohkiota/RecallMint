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

### Task T-B1': `/app/tags` per-option N+1 解消 → **[closed]** (2026-06-13、 直す対象なし)

**結論**: per-option N+1 は **`/app/tags` 初回表示経路に存在しない** (削除フロー click 時のみ)。 再計測で T-B1 値 4,830 ms が再現せず (264 ms = 18x 速い、 longtask 0 件)。 4,830 ms は **seed 投入直後 pull drain 中の useLiveQuery 多重 re-fire による計測アーティファクト**確定 (実コード変更 0 で 18x 改善 = 真の遅延ではない)。 直すべき遅延が存在しないため close (Y-3 繰越なし、 将来やる宿題ではない)。

詳細: `docs/superpowers/sessions/2026-06-13-y2-t-b1p-investigation.md` (前提崩壊 + 再計測結果 + 仮説評価)、 `docs/superpowers/sessions/2026-06-12-y2-tags-perf-investigation.md` 末尾 (計測 protocol の教訓)。

**spec への影響**: spec §3.1 H7 (ii) は本 task で消化扱い (= 「pull drain 中のアーティファクトであることを実証して close」 で hardening 趣旨を満たす)。 spec 書き換え不要。

---

### Task T-B5: #1d inline-card-list 全 card_tags → page subset (memoize 不採用、 2026-06-14 改訂)

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` + 関連 test

- [ ] **目的**: inline-card-list の `card_tags` query を `card_id IN (current page)` に絞り、 全 card_tags scan を回避 (audit §10.3 (b) #1 of 5)。 multi-exam 想定で他 exam の card_tags scan 抑止を主目的とする。
- [ ] **制約**: page 表示の tag 挙動不変 (描画 pill 集合 + 件数表示の一致)。 Dexie の `where('card_id').anyOf(...)` 経由 (Y-1 #3 同形、 Grid-1 合流前なので暫定形、 Grid-1 で正規化予定の comment 1 行)。 **memoize は不採用** (Step 0 再調査で fetch memoize 実装が card_tags 変化を取りこぼし stale bug 源となること、 また audit 原文に「memoize」 の語がなく spec 起草時に regroup 対策として角度違いで足された hint であることを確認、 詳細 `docs/superpowers/sessions/2026-06-14-y2-t-b5-step0-redo.md` §2c)。 tag_categories / tag_options の全 scan / regroup 抑止 / 仮想化は本 task scope 外 (T-B5b 別起票、 後述)。
- [ ] **完了条件** (unit test と stg 実測に二分):
   - (a) **B 相当 (1 target exam × 50 cards × 4 tags = 200 target_rows + 1000 他 exam tags = 1200 total)** で `anyOf fetch row 数 < toArray fetch row 数` を unit test で assert (fake-indexeddb で旧 code 相当の toArray() と新 code 相当の anyOf() を並べ、 row 数差で最適化目的 = 他 exam scan 回避を構造的に検知)
   - (b) **low-scale 非劣化 (A 相当、 50 cards × 4 tags = 200 tags、 他 exam tags 0)** = 二分:
       - **(b-i) 構造**: anyOf 経路が返す rows の card_id 集合が target exam の card_ids subset と一致 (他 exam card_id を含まない) を **unit test** で assert。 「無駄読みゼロ」 を perf でなく構造で担保
       - **(b-ii) wall-clock**: stg 実機計測を正本 (`docs/superpowers/sessions/2026-06-14-y2-t-b5-step0-redo.md` §3: anyOf 4.04 ms mean / stdev 0.75 at 200 tags / 0 other = 知覚不能域)。 unit test に wall-clock ceiling は新規導入しない (plan policy 「jsdom/mock を perf 根拠にしない、 fake-indexeddb は集計 correctness 確認に限定」 準拠、 fake-indexeddb は memory-based JS 実装で実 IDB の B-tree seek と特性が異なる)
   - 既存 inline-card-list test 全 pass、 per-task gate (lint / typecheck / build / test) 全 exit 0、 Critical 0、 [reviewed]。

**完了条件改訂の経緯 (2026-06-14)**:
- **初版改訂**: 旧 fixture (50 card / 200 card_tags、 single-exam) は **anyOf の最適化目的 (他 exam scan 回避) を mis-model** していた (Step 0 再調査 §3 で確認、 旧 fixture では anyOf が 2.5x 遅い結果になる)。 test が落ちたから fixture を変えたのではなく、 **completion criteria の mis-spec 是正** = OT chat 承認 (2026-06-14)。 元 fixture は spec 起草時の規模感推定で書かれており、 計測 protocol (Step 0 教訓 = 単一 fixture を多角的に分離して計測) を踏襲する形に揃えた。
- **追補**: 初版で (b) を wall-clock < 5 ms の unit test assert としたが、 fake-indexeddb は memory-based JS 実装で anyOf cursor walk が実 IDB の B-tree seek より遅く、 unit test 上で 26 ms に達した (実装本体の問題ではなく env 特性差)。 plan policy `jsdom/mock を perf 根拠にしない` と衝突するため (b) を構造側 (b-i) と wall-clock 側 (b-ii) に二分し、 wall-clock は stg 実測正本 + session log 参照に振り、 unit test では「他 exam 分を読まない」 構造のみ検証する形に確定 (OT chat 承認 2026-06-14)。

---

### Task T-B5b: inline-card-list render / regroup / subscription の cost 軸 (T-B5 派生、 2026-06-14 起票)

**Files:**
- Investigate / modify: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` (L88-130 useLiveQuery callback + L270 付近 `cards.map(card => <li>)` 全 card 一括描画)
- Investigate: `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (pill 描画コスト軸)

- [ ] **目的**: T-B5 で card_tags **fetch** 側 (全 scan → page subset) は抑止済。 残る (i) tag 更新ごとの `tagsByCardId` Map **regroup** コスト (audit codex L25 「更新ごとに全 tag relation を regroup する」 未解決部分)、 (ii) `cards.map(...)` での全 card **render** (仮想化なし)、 (iii) tag master と per-card relation の **subscription 統合**で他 exam の card_tags 変化でも本 page callback が再 fire する over-subscription を解消、 を扱う。
- [ ] **背景** (根拠付き): `docs/superpowers/sessions/2026-06-14-y2-t-b5-step0-redo.md` §4.3 / §5c より、 card_tags fetch を anyOf で抑止しても scenario C/D (他 exam tag 5k-20k、 1-5 年 power user 想定) で React render が page 支配項になりうる (本 sprint では未測定、 stg multi-exam seed 必要)。 audit codex L25 サブ提案「subscription 分離も検討」 は T-B5 で採用せず本 task に振り戻し。
- [ ] **方針候補** (未確定、 Step 0 で確定):
   - (a) **仮想化** (`react-window` / `@tanstack/react-virtual` 等): 全 card 一括描画を viewport 制限に。 inline-card-list の現コメント (L143-168) で「将来仮想化導入時に consume 経路復活が必要」 と既に予告。
   - (b) **subscription 分離**: cards / tag マスタ (categories + options) / card_tags の 3 group を別 useLiveQuery に。 tag マスタ更新 (rare) が card_tags 経路と独立して再 fire するように。
   - (c) **`tagsByCardId` Map 構築の useMemo 化** (key = cardTags ref + cards id 集合)。
   - これらは plan T-B5 の memoize 不採用とは別軸 (T-B5 は **fetch memoize** の話、 本 task は **post-fetch assembly / render** の話)。
- [ ] **Step 0** (本 task 内、 着手 1 段目): stg に multi-exam fixture (B 相当: 5 exam × 50 card × 4 tag = 200 + 1000 他、 fixture spec は T-B1 seed runbook の multi-exam 拡張) を seed し、 inline-card-list の **page-level wall-clock** (React render + regroup) を Performance API で計測。 fetch ≪ render なら仮想化優先、 fetch ≈ render なら subscription 分離優先、 と Step 0 結果で方針確定。
- [ ] **制約**: T-B5 の anyOf 化を retain (上位構造として変更しない)。 card_tags の subscription 範囲を狭めても useLiveQuery 契約 (= 描画と mirror の整合) を崩さない。 Grid-1 (テーブル化) 合流前の暫定形は許容、 Grid-1 で再評価される comment 1 行。
- [ ] **完了条件**: **未確定** (Step 0 計測結果から方針 a/b/c 決定後に定義)。 暫定枠 = page-level wall-clock の before/after を session log に貼付 + 既存 inline-card-list test 全 pass + per-task gate 全 exit 0 + Critical 0 + [reviewed]。
- [ ] **状態**: 未着手。 T-B5 (= 5db89d6 [reviewed]) と独立 scope、 ordering の T-B5 → T-B6 → T-B7 → T-B8 は変更しない。 T-B5b は Sub-plan B 末尾 (T-B8 後) もしくは Y-3 繰越とするかは Step 0 結果で OT 判断。

**起票根拠**: review 中 forward-looking note (canonical review 2026-06-14、 commit 5db89d6 review subagent) で「T-B5b が subscription 分離を実装するなら本 task の equivalence comment (L96-98) を再検証推奨」、 + Step 0 再調査 §6 「card_tags fetch 支配性 = callback 内 99% / page-level 未測定」 を受けて起票。

---

### Task T-B6: #1e dashboard-actions 全 cards → `[user_id+due]` index 使用

**Files:**
- Modify: dashboard-actions 経路 (grep `dashboard-actions\|dashboardActions` で特定) + Dexie schema 確認

- [ ] **目的**: dashboard の card count を `[user_id+due]` compound index 経由 query に置換、 高速化 (audit §10.3 (b) #1 of 5)。
- [ ] **制約 (2026-06-14 改訂、 Step 0 §3 + §補 を反映)**: **plan 初稿 L147 の「index は既存 (stg Dexie schema v50 / Y-1)」 は事実誤認** (Step 0 で `lib/client-db.ts:282-294` 確認、 現 v6 schema に `[user_id+due]` 未定義、 Y-1 履歴にも追加痕跡なし、 詳細 `docs/superpowers/sessions/2026-06-14-y2-t-b6-step0.md` §3)。 **旧制約「新規 migration なし」 を撤回し、 schema v7 で compound index `[user_id+due]` を新規追加** する (cards table、 列順 `[user_id, due]` = 等価条件 → 範囲条件、 v2 / v4 / v5 / v6 と同形の純粋 index 追加、 store drop なし、 upgrade callback 不要、 既存データ保持)。 T-B7 (plan L152-159) が同 `[user_id+due]` を流用予定のため、 T-B6 で v7 を立て T-B7 が乗る順序 (v7 = T-B6/T-B7 共用 migration、 1 migration で 2 task 解消)。 dashboard 表示挙動不変。 query = `db.cards.where('[user_id+due]').between([userId, '0'], [userId, nowIso], true, true).count()` 形 (`nowIso = (now ?? new Date()).toISOString()` を query 内部で都度評価。 `.count()` 採用 = row 本体 fetch なしで `.length` semantics と等価。 lower bound `'0'` は ISO8601 (`'0001-...'` 以上) より lex で小さい正当な下限、 upper bound `nowIso` を **明示的に inclusive** にして元コードの `due <= nowIso` と等価にする。 **Dexie `.between(lower, upper, includeLower=true, includeUpper=false)` の default は `includeUpper=false` = upper exclusive のため、 等価には第 4 引数 `true` で `includeUpper=true` を明示する必要あり** (詳細 + 全境界 probe 表 = sessions/2026-06-14-y2-t-b6-step0.md §補-E、 当初 plan で「default upperOpen=false で等価」 と書いた箇所は事実誤認だった件の是正)。 due 欠損行は schema NOT NULL + 全 write path ISO 由来で構造的に発生しえないため fixture に混ぜない、 詳細 §補-D)。
- [ ] **完了条件 (2026-06-14 改訂、 T-B5 と同型で二分)**: (a) large/multi-exam fixture で index 経路 `.count()` の dueCount が全 scan 経路 `filter().length` と完全一致 + index 経路 < 全 scan 経路 (構造改善)。 fixture は valid ISO の正常データのみ (欠損行は §補-D で非論点確定のため混ぜない)。 (b-i) tenant isolation 構造 unit test: index 経路が他 user の due row を読まない (count に含めない) を assert。 (b-ii) low-scale wall-clock 非劣化 stg 計測: compound index 追加で書き込み/小規模 query が有意劣化しないことを stg 実測で確認し session log 参照 (wall-clock は jsdom/fake-indexeddb で assert しない = T-B5 precedent。 理由: jsdom/fake-indexeddb は IDB B-tree 内部 cost を再現しない実装で、 wall-clock 比は環境依存 noise になり regression test として無意味)。 既存 dashboard test 全 pass。 Critical 0、 [reviewed]。

---

### Task T-B7: #2 get-dexie-session-cards 全 cards → index 利用 (2026-06-14 完了条件改訂、 T-B5/T-B6 precedent 二分化適用)

**Files:**
- Modify: `lib/cards/get-dexie-session-cards.ts` + `lib/cards/get-dexie-session-cards.test.ts`
- Reference: `docs/superpowers/sessions/2026-06-14-y2-t-b7-step0.md` (本 task の前提検証 + Step 0 findings)

- [ ] **目的**: 学習 session 開始時の全 cards fetch を `[user_id+due]` index 経由に集約 (audit §10.3 (b) #2、 T-B6 で導入済 v7 index 流用)。 power user (2k+ cards) で旧の全 user cards body materialize + JS filter/sort/slice → index range cursor + .limit(N) body fetch 最大 N 件 に置換。
- [ ] **制約 (2026-06-14 改訂、 Step 0 反映)**: T-B6 で導入済 v7 `[user_id+due]` compound index を流用 (本 task で schema 変更なし)、 session card 選定 logic 不変 (関数シグネチャ `getDueCardsFromDexie(userId, limit, now?)` / 呼出元 `study-session-host.tsx:62` / 戻り型 `Promise<Card[]>` / `toCard` mapper 経由 不変)。 query = `db.cards.where('[user_id+due]').between([userId, '0'], [userId, nowIso], true, true).limit(limit).toArray()` 形。 第 4 引数 `true` (includeUpper) は必須 (Dexie `.between(lower, upper, includeLower=true, includeUpper=false)` の default は `includeUpper=false` = upper exclusive で `due == nowIso` ぴったり card を session から落とす real bug、 T-B6 §補-E.3 罠 + dashboard-actions.tsx:50 と同文面)。 `.sortBy()` は呼ばない (compound index 順で due ASC 構造的成立、 sortBy は内部で全件 materialize → JS sort で index 利点を消す)。 lower bound `'0'` は ISO8601 lex 下限 (dashboard-actions.tsx:50 と同文面)。 旧 JS chain (filter + sort + slice) は完全撤去。 sort 安定性差 (旧 JS comparator は engine 依存 vs 新 index 順は `(user_id, due, primary key)` lex 順で安定) は session 開始順が UI に出ないため影響無視可。
- [ ] **完了条件 (2026-06-14 改訂、 T-B5/T-B6 と同型で二分)**:
   - (a) **境界 regression test** (最優先・correctness): `due == nowIso` ぴったり card を結果に含むことを assert (第 4 引数 true 漏らしたら fail する固定 regression、 T-B6 §補-E.3 罠を本 task でも守る)
   - (b-i) **構造改善 unit test**: `vi.spyOn(db.cards, 'where')` で `[user_id+due]` index 経路の呼出 1 回 / 旧 `where('user_id')` 経路の呼出 0 回を assert (T-B4/T-B6 precedent と同 pattern、 dashboard-actions.test.tsx の `as unknown as unknown[][]` type workaround 流用)
   - (b-ii) **tenant isolation 構造 unit test**: 別 user の due card が混ざらない (第 1 要素 user_id equals fix の構造保証、 旧 test #6 と意図的に重複させて新経路でも独立 case で守る)
   - (c) **既存 test 7 件 全 pass** (同 due 複数 card の id 順 assert なしのため byte-identical で互換、 sort 安定性差は assert 範囲外につき影響なし)
   - (d) **wall-clock は jsdom/fake-indexeddb で assert しない** (T-B5/T-B6 precedent と policy 共通、 wall-clock は stg 実測が正本)。 低 scale 非劣化は構造で保証 (新は body fetch が strictly 少 + JS sort/filter なし → 旧より strictly 軽い)。 高 scale 改善は index access pattern からの reasoning + T-B6 §4c bench (`.count()` 経路) からの定性援用 (本 task は `.toArray()` で body fetch 次元が異なるが、 limit(20) 上限と user 全 cards 級 fetch の比で改善幅は T-B6 より大の見込み)。 多 scale bench は gate に不要、 audit 数字要件があれば 2k card 一点 seed → 計測 (min/max/median/mean/stdev、 isolated IDB、 stg 無改変、 計測後 deleteDatabase) → cleanup
   - (e) **per-task gate**: whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` + `pnpm build` + `pnpm test` 全 exit 0 (Dexie schema 不変につき build は念のため、 必須項目に含める)
   - (f) **review 経路**: `superpowers:requesting-code-review` skill canonical (改変なし) + `superpowers:subagent-driven-development` 既定 spec compliance reviewer (二段、 独立検証)、 Critical 0、 [reviewed] (UI 微調整 / 認証・決済・削除・外部副作用に該当しないため、 review pass 後即 [reviewed] 付与の通常経路)

---

### Task T-B8: #7 OCR backoff worst-case ~660s への semaphore concurrency limit

**(2026-06-14 確定: 不実装・受容、 audit §8.3 / §10.3 (b) #7 close note 参照)** — Step 0 fact-finding で「有料 Gemini tier の RPM 余裕 + GEMINI_DAILY_LIMIT 日次 cap (prod fail-fast 配備済) + 429 即 throw (粘らず「混み合っています」 表示、 データ破損 / 他 user 波及なし) で実害抑制 + in-process semaphore は Vercel auto-scale 下で service-wide にならない (effective = N × instances)」 を確認、 将来バズ規模で 429 が実問題化した時の cross-instance lock (Redis 等) で再検討と受容判定 = OT 確定。 以下の実装方針は経緯として残置 (削除しない)。

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
