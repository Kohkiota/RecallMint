# 増分 pull Step 3「client 切替 (統合 endpoint 参照 + 増分 merge)」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** client の cards/exams pull を旧 `cards/pull`・`exams/pull` (全置換 clear+bulkPut) から step 2 の統合 `GET /api/pull` 参照の**増分 merge** に切替える。1 本の orchestrator が cursor を読み `?since` で叩き、返却 delta を bulkPut upsert + tombstone bulkDelete + cursor 更新を 1 tx で適用する。

**Architecture:** 新 `lib/sync/pull.ts` の `pullDelta` が cursor 3 本 (cards/exams/tombstone) を `sync_meta` から read → 統合 endpoint を 1 回叩く → `db.transaction('rw', cards, exams, sync_meta)` で merge upsert + tombstone bulkDelete + cursor write (null は据え置き) を atomic 適用。失敗時は tx 前に return し Dexie/sync_meta を touch しない。study_days は増分化せず旧 `study-days/pull` 並走 (別 helper・別 tx)。旧 `pullAllCards`/`pullAllExams` helper は撤去。

**Tech Stack:** Dexie (IndexedDB), TypeScript, Vitest + fake-indexeddb (実 Dexie + DI client mock)。

**位置づけ (spec 整合):** 確定 spec `docs/superpowers/specs/2026-05-29-incremental-pull-design.md` §3.1-3.2 / §6 step 3。本 step で **全件 pull → 増分 pull が成立**し、§8-4「全置換の暗黙削除を失う代わりに tombstone 反映が必須セット」を実装する (clear() 撤去で暗黙削除を失い、tombstone bulkDelete で削除反映を回復)。step 2 の `/api/pull` を初めて client が使う。exams mirror の UI 参照 (useLiveQuery) は step 6、本 step は mirror 更新ロジックのみ。

---

## 全体制約 (各タスク共通、冒頭一度のみ)

- **TDD**: 失敗 test 先行 → fail 確認 → 最小実装 → green → review → commit。
- **unit 方針**: `lib/sync/cards.test.ts` を手本に **fake-indexeddb で実 Dexie を動かし、DI client mock で統合レスポンスを制御**。増分 merge / tombstone bulkDelete / cursor read-write / 0 件据え置き / 1 tx 失敗時不変性を検証。実 endpoint 挙動は stg smoke で裏取り (step 2 で endpoint 自体は検証済)。
- **失敗時不変性 (最重要・現状踏襲)**: network throw / non-2xx / body shape 不正のいずれも、**tx を開く前に `{ok:false}` return** し Dexie cards/exams/sync_meta を一切 touch しない (`sync/cards.ts` の不変性をそのまま踏襲)。
- **1 tx atomicity**: merge upsert + tombstone bulkDelete + cursor 更新を `db.transaction('rw', db.cards, db.exams, db.sync_meta, ...)` 1 つに包む。study_days は含めない (別 endpoint・別 helper・別 tx)。
- **cursor 更新は null skip**: 統合レスポンス `cursors.{cards,exams,tombstone}` が null (= 0 件) のストリームは `sync_meta` を更新せず据え置く。非 null のみ `put`。
- **snake_case param**: `since_cards` / `since_exams` / `since_tombstone` (step 2 endpoint と一致)。cursor 未取得 (undefined) のストリームは param を付けない (= サーバー側全件 fallback)。
- **pending 概念なし (確認済・スコープ外)**: cards mirror への client 書込は pull 以外ゼロ (inline 編集は server action 直行で IDB 非経由)。よって増分 merge での「未送信編集の上書き防止」は本 step 不要 (spec §3 の pending 対策は将来 client 編集導入時)。
- **review/commit 規律**: feat は `superpowers:requesting-code-review` 必須経路。読み込み側 mirror 更新で削除/決済/外部副作用 category 非該当 → 通常 review。step 1/2 運用に合わせ **review pass → `[no-review]` commit → UI 経由 stg smoke → `[reviewed]` amend**。dead code 撤去 (Task 3) は `refactor(_)` 実装ロジック変更なしで `[no-review]` 据置可。
- test 実行: `pnpm test <path>`。

---

## File Structure

| 変更/新規/削除 | 責務 |
|---|---|
| Create `lib/sync/pull.ts` | `pullDelta(client?)` orchestrator + DI client + `PullResponse` 型。cursor read → 統合 endpoint → 1 tx merge/bulkDelete/cursor write |
| Modify `lib/sync/sync-meta.ts` | `SYNC_META_KEYS` に `lastTombstonePullAt: 'last_tombstone_pull_at'` 追加 |
| Modify `app/(app)/app/_components/pull-trigger.tsx` | `pullAllCards()+pullAllExams()` を `pullDelta()` に置換、`pullAllStudyDays()` は据置 (並走) |
| Modify `app/(app)/app/_components/pull-trigger.test.tsx` | 期待を `pullDelta` + `pullAllStudyDays` 呼出に変更 |
| Delete `lib/sync/cards.ts` + `cards.test.ts` / `lib/sync/exams.ts` + `exams.test.ts` | `pullAllCards`/`pullAllExams` は orchestrator に統合され dead (pull-trigger 切替後に撤去) |

**型の所在**: `PullResponse` (= `{ cards: ClientCard[]; exams: ClientExam[]; tombstones: { entity_type: 'exam'|'card'; entity_id: string; deleted_at: string }[]; cursors: { cards: string|null; exams: string|null; tombstone: string|null } }`) は `lib/sync/pull.ts` に inline 定義 (JSON 契約が client/server 境界。server module `tombstones-pull.ts` の `ClientTombstone` を type-import しても良いが、client/server 疎結合のため inline を既定とする)。

---

## Task 1: 増分 merge orchestrator `pullDelta`

**Files:** Create `lib/sync/pull.ts` / Modify `lib/sync/sync-meta.ts` (`:12-17` の `SYNC_META_KEYS`) / Test `lib/sync/pull.test.ts`

**目的**: cursor を読み統合 endpoint を叩き、delta を 1 tx で merge/delete/cursor 更新する中核。**制約**: 失敗時不変性・null skip・1 tx・pending なし (上記全体制約)。`getSyncMeta`/`setSyncMeta` (string 専用、`sync-meta.ts`) を流用。**完了条件**: 下記 test green + review。

**実装の骨子** (実コードは TDD で生成、設計判断のみ記録):
- `SYNC_META_KEYS` に `lastTombstonePullAt: 'last_tombstone_pull_at'` 追加。既存 `lastCardPullAt`/`lastExamPullAt` を cursor として再利用 (意味が「pull 時刻」→「max(updated_at) cursor」へ変わる。**U1 移行リスク参照**)。
- cursor read: `getSyncMeta(lastCardPullAt|lastExamPullAt|lastTombstonePullAt)` → `URLSearchParams` に存在分のみ `since_cards`/`since_exams`/`since_tombstone` を set → `/api/pull[?...]`。
- DI client (`sync/cards.ts` の `PullApiClient` 同型、body=`PullResponse|null`)。throw/非 ok/body 不正 → tx 前 return `{ok:false}`。
- 1 tx (`'rw', db.cards, db.exams, db.sync_meta`):
  - `cards.length` あれば `db.cards.bulkPut(cards)`、`exams.length` あれば `db.exams.bulkPut(exams)` (id upsert、clear なし)。
  - tombstones を `entity_type` で分け `db.cards.bulkDelete(cardIds)` / `db.exams.bulkDelete(examIds)` (mirror 不在 id は Dexie no-op)。
  - cursors: 非 null のみ `db.sync_meta.put({key, value})` (cards→lastCardPullAt / exams→lastExamPullAt / tombstone→lastTombstonePullAt)。null は skip。

- [ ] **Step 1: 失敗 test 群を書く** (`pull.test.ts`、fake-indexeddb + DI client mock。`sync/cards.test.ts` の `fakeClientCard`/`mockClient`/`beforeEach clear` を流用):
  1. **増分 merge upsert**: 既存 cards `[old-1, old-2]` + レスポンス cards `[old-1(更新), new-3]` → mirror = `{old-1(更新値), old-2(残存), new-3}` (clear されない = old-2 が消えない)。exams 同様。
  2. **tombstone bulkDelete**: 既存 cards `[c1,c2]` exams `[e1]` + tombstones `[{card,c2},{exam,e1}]` → mirror cards=`[c1]`、exams=`[]`。
  3. **cursor read → ?since**: sync_meta に 3 cursor を put 済の状態で `pullDelta` → mock client.get が `/api/pull?since_cards=..&since_exams=..&since_tombstone=..` で呼ばれる (`expect(client.get).toHaveBeenCalledWith(期待 path)`)。cursor 無し時は param 無し path。
  4. **cursor write (非 null)**: レスポンス cursors 3 本非 null → 各 sync_meta key が更新される (`getSyncMeta` で確認)。
  5. **cursor 据え置き (null)**: 既存 cursor を put 済 + レスポンス cursors.cards=null → lastCardPullAt は**旧値のまま** (上書きされない)。
  6. **失敗時不変性**: 既存 cards/sync_meta あり + (a) client throw / (b) status 500 body null / (c) body shape 不正 (cards 非 array 等) → `{ok:false}`、cards/exams/sync_meta 全て不変。
  7. **0 件全 null**: 空 delta + cursors 全 null → mirror 不変・cursor 不変・`{ok:true}`。
- [ ] **Step 2: red** — `pnpm exec vitest run lib/sync/pull.test.ts` → FAIL (未実装)。
- [ ] **Step 3: 実装** — `sync-meta.ts` に key 追加 + `lib/sync/pull.ts` に上記骨子を実装。
- [ ] **Step 4: green** — `pnpm test lib/sync/pull.test.ts` 全 PASS。`pnpm exec tsc --noEmit` 本 file エラーなし。
- [ ] **Step 5: commit** — `feat(sync): 統合 /api/pull 参照の増分 merge orchestrator pullDelta (cursor read/write + tombstone bulkDelete + 1 tx)` + `[no-review]`。

---

## Task 2: pull-trigger を orchestrator へ配線

**Files:** Modify `app/(app)/app/_components/pull-trigger.tsx` / Test `app/(app)/app/_components/pull-trigger.test.tsx`

**目的**: layout mount 時に `pullDelta()` (cards/exams/tombstone) + `pullAllStudyDays()` (旧経路並走) を fire-and-forget。**制約**: 失敗 silent (現状踏襲)、study_days は別 helper のまま並走。**完了条件**: test green + review。

- [ ] **Step 1: 失敗 test** — `pull-trigger.test.tsx` の期待を変更。`@/lib/sync/pull` の `pullDelta` と `@/lib/sync/study-days` の `pullAllStudyDays` を mock し、mount で両方が 1 回ずつ呼ばれることを assert。旧 `pullAllCards`/`pullAllExams` は呼ばれない (import も消える)。
- [ ] **Step 2: red** — `pnpm exec vitest run "app/(app)/app/_components/pull-trigger.test.tsx"` → FAIL。
- [ ] **Step 3: 実装** — `pull-trigger.tsx` の import を `pullAllCards`/`pullAllExams` から `pullDelta` (`@/lib/sync/pull`) に置換、`useEffect` 内を `void pullDelta().catch(()=>{})` + `void pullAllStudyDays().catch(()=>{})` に。コメントを増分 pull に更新。
- [ ] **Step 4: green** — 同 test PASS。`pnpm exec tsc --noEmit` エラーなし。
- [ ] **Step 5: commit** — `feat(sync): pull-trigger を増分 orchestrator + study_days 並走に切替` + `[no-review]`。

---

## Task 3: 旧 pull helper (cards/exams) 撤去

**Files:** Delete `lib/sync/cards.ts` / `lib/sync/cards.test.ts` / `lib/sync/exams.ts` / `lib/sync/exams.test.ts`

**目的**: Task 2 で参照を失った旧 helper を撤去 (dead code 残置回避)。**制約**: 撤去前に grep で他 importer ゼロを確認。`study-days.ts` は残す。旧 API route (`/api/cards/pull`・`/api/exams/pull`) は step 7 で廃止のため**本 step では残す** (client 不使用の server endpoint として一時残置)。**完了条件**: build/test green。

- [ ] **Step 1: 参照ゼロ確認** — `grep -rn "pullAllCards\|pullAllExams\|from '@/lib/sync/cards'\|from '@/lib/sync/exams'" app lib components | grep -v ".test."` が空 (Task 2 後)。
- [ ] **Step 2: 削除** — 4 file を `git rm`。
- [ ] **Step 3: green** — `pnpm test` 全体 + `pnpm exec tsc --noEmit` でエラー・未解決 import が無いこと。
- [ ] **Step 4: commit** — `refactor(sync): orchestrator 統合で不要化した旧 pullAllCards/pullAllExams helper を撤去` + `[no-review]` (実装ロジック変更なし)。

---

## この step 単体の stg smoke (UI 経由、client mirror 挙動が初めて変わる段)

認証済 staging ブラウザ (step 1/2 と同じ) で UI 操作 + DevTools (Network `/api/pull` reqid・IDB cards/sync_meta) + `.env.local`＝staging DB 直読みで検証。

1. **増分 pull で mirror 更新**: card を 1 つ inline 編集 → reload (pull 発火) → IDB cards の当該行が更新値、dashboard dueCount 等が反映。
2. **tombstone 経由の削除反映 (§8-4 核心)**: mirror にある card を削除 → reload → IDB cards から当該 id が消える (clear() を失った代わりに tombstone bulkDelete が効く)。exam 削除も同様に IDB exams から消える。
3. **dashboard dueCount live 反映**: 復習 push 後 (pull-back は step 5、ここでは reload pull) → dueCount が useLiveQuery で更新。
4. **2 回目以降 pull が差分のみ**: 1 回目 (cursor 無し) は `/api/pull` が全件 (cards 52 等)、2 回目 reload は `?since_cards=..` 付きで件数が差分のみ (全件でない) を Network で確認。
5. **study_days 旧経路で従来どおり**: `/api/study-days/pull` が引き続き呼ばれ `{studyDays,now}` を返し、streak/todayCount が機能。
6. **cursor 前進 + 取りこぼさない**: IDB sync_meta の `last_card_pull_at`/`last_exam_pull_at`/`last_tombstone_pull_at` が DB-clock max に前進。再 pull で `?since` が前回 cursor に一致し、境界行 (inclusive) を取りこぼさない。

全 6 観点 PASS で 3 commit を `[reviewed]` へ amend (step 1/2 と同手順 filter-branch)。FAIL は amend せず報告で停止。

---

## Self-Review (spec 整合)

- §3.1 (cursor read 新設・3 本独立・tombstone key 追加) → Task 1。§3.2 (clear 撤去→upsert・tombstone bulkDelete・1 tx・失敗時不変性・null 据え置き・validation 差替) → Task 1。pull-trigger 配線 + study_days 並走 → Task 2。§8-4 (暗黙削除→tombstone 反映) → Task 1 (bulkDelete) + stg smoke 観点2。
- placeholder なし。型整合: `PullResponse.cursors.{cards,exams,tombstone}` / `SYNC_META_KEYS.{lastCardPullAt,lastExamPullAt,lastTombstonePullAt}` を Task 1-2 で一貫使用。

---

## 実装前に確認・判断が要る点 (実コード再確認で判明)

- **U1 (移行リスク・要 OT 判断)**: 既存ユーザーの `sync_meta.last_card_pull_at`/`last_exam_pull_at` は**旧 pull が書いた App クロック wall-clock の「pull 時刻」**。step 3 後これを cursor (inclusive since) として使うと、初回 pullDelta で「旧 pull の query→stamp 間 (~ms) に作成され snapshot に載らず updated_at < stamp の行」を取りこぼし得る (narrow window、以後その行が編集/復習されれば self-heal)。**現方針 (key 再利用) はこの一回限りの narrow miss を許容**。回避策: (a) 許容 (推奨度中・最小変更) / (b) **新 cursor key 名に変更** (旧 key 無視→初回は全件 pull→以後 DB-clock cursor、推奨・clean) / (c) 初回 deploy 時に旧 cursor key を一度 clear するワンタイム migration。**OT 判断**: 本 plan は spec/指示どおり (a) key 再利用で記述。clean を優先するなら (b) に差替 (Task 1 の key 定義のみ変更、波及小)。
- **U2 (旧 API route の残置)**: 本 step で client は `/api/cards/pull`・`/api/exams/pull` を使わなくなるが、route 自体は step 7 で廃止予定のため**残す** (即時削除しない)。rollback 容易性のためで spec §6 と整合。`/api/study-days/pull` は恒久使用。
- **U3 (削除は全て tombstone を書く前提)**: clear() 撤去後、mirror からの削除反映は tombstone のみ。現状 card/exam の物理削除経路は `delete-card.ts`/`delete-exam.ts` (どちらも tombstone INSERT) と exam 削除の FK CASCADE (delete-exam が配下 card tombstone を網羅 INSERT 済) のみで、**tombstone なしの削除経路は無い**ことを確認済。将来 tombstone を書かない削除を足すと mirror が stale 化するため、その不変条件を plan に明記 (新削除経路は必ず tombstone を書く)。
- **U4 (ClientTombstone 型の重複)**: `PullResponse.tombstones` の要素型は server `tombstones-pull.ts` の `ClientTombstone` と同形。inline 定義 (client/server 疎結合) を既定とするが、DRY を優先するなら `import type { ClientTombstone }` でも可 (tombstones-pull は server-only 無しのため type-only import 安全)。軽微、OT 認識のみ。
- spec との食い違い: なし (U1 は spec「key 意味変更」の実装上の移行注意で、方針自体は spec と整合)。
