# FSRS 整合 Sprint A: answer_events 正本化 + 直列化 + 順序ガード 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。

**Goal:** 復習イベントの正本を answer_events 1 表に一本化し(reviews / study_sessions 廃止)、FOR UPDATE 直列化 + 順序ガード + clamp + 冪等 2 段検証を実装、24h drop を撤去する。

**Spec(確定・凍結・r3):** `docs/superpowers/specs/2026-08-11-fsrs-consistency-sprint-a-design.md`(以下「spec」・commit `cbb5435`)。仕様変更が必要になったら停止して OT 相談。fact-finding = `docs/audit/2026-08-11-*` 3 本。Codex spec 段階論点 = `docs/codex/2026-08-11-plan-fsrs-sprint-a-spec.md`。

## Global Constraints(全 task 共通)

- ユーザー 0・既存データ全捨て(spec §10)。互換レイヤー・backfill 禁止。
- wire / 順序 / 終端の確定値は spec §2〜§3 のとおり(順序ガード `>=` + per-card stable sort / cross-request は行ロック取得順 / clamp = parse 直後 1 回・60s 超のみ warn / 200・400・503 の 3 値 / failed[] = 衝突のみ・client は 'failed' terminal 化 / 送信前検証で形式不正隔離)。
- 正誤 2 本立て: 統計・フィルタ = is_correct / scheduling = rating(spec §6)。
- 新設・変更列の CHECK は本 sprint(rating 1-4 / state 0-3 / elapsed_ms >= 0 / answered_at <= created_at)。他表への CHECK 展開は Sprint B。
- pure domain は runtime I/O import 禁止(eslint Domain purity)。client/server 共有 invariant は 1 定義両側 import。
- TDD(red→green)。AI/外部 API なし。unit は mock、iso は実 PG17。test-only 増分は red 検証(gate 個別変異)+ 宣言 token。
- feat commit = canonical review(requesting-code-review 既定経路)+ Codex(`scripts/ai/codex-review.sh`)pass 後 `[reviewed]`。commit 直前 4 点宣言。docs commit = `[no-review]`。
- migration は `pnpm db:generate` → 手動調整 → **直後の再 generate が no-diff**(spec §9.2)。
- sprint 完了 gate: whole-repo lint 0 / `pnpm test:iso` green / `pnpm run audit` 0 / `pnpm install --frozen-lockfile` + typecheck + build 0。
- **Task 4→5 の間は client/server の wire が不整合**(旧 client × 新 server)。sprint 内で解消・中間 deploy しない。

## File Structure

- `lib/sync/shared/answer-event-schema.ts`(create): wire event zod 1 定義(server 検証 + client 送信前検証が両側 import)
- `lib/jst.ts`(modify): `jstDayRange` 追加
- `lib/cards/domain/initial-fsrs-state.ts`(create): 初期 FSRS 値 1 定義(now 注入)
- `lib/reviews/domain/streak.ts`(create): computeStreak / addDays / STREAK_WINDOW_DAYS 統合(`lib/db/streak.ts` / `lib/client/streak.ts` は I/O へ縮退)
- `lib/db/schema.ts`(modify): answerEvents 新形 / reviews・studySessions 削除 / cards 変更
- `drizzle/migrations/0034_*`(cards)/ `0035_*`(answer_events DROP→CREATE + reviews/study_sessions DROP + TRUNCATE study_days)
- `lib/reviews/ingest-review-events.ts` + `lib/reviews/session-repository.ts`(modify): 新 ingest(§2.2 の 9 手順)。`lib/reviews/domain/session-aggregate.ts`(modify): sort/gate/fold。`lib/cards/replay-card.ts`(modify): isCorrect
- `app/api/review-events/bulk/route.ts`(modify): 新 wire。Phase 0 削除
- 削除: `lib/reviews/domain/session-values.ts` / `lib/db/in-date-list.ts` / `lib/validation/review-session-bounds.ts`(bound は共有 schema へ内包)
- `lib/clerk/handle-clerk-event.ts`(modify): Group I に answer_events / reviews・study_sessions 行削除
- `db/policies/rls-p3-wave1-enable.sql`・`rls-p3-wave2-enable.sql`・`scripts/verify-rls-state.ts`・`tests/integration/pg/setup/completeness.ts`(modify)
- `lib/client-db.ts`(modify): Dexie v9。`lib/sync/review-events.ts` / `review-flush.ts` / `app/(app)/app/_components/review-flush-trigger.tsx` / `study/_components/session-launcher.tsx` / `study/smart/_components/session-runner.tsx`(modify)
- `tests/fixtures/review-events.ts`(rewrite)/ `tests/integration/pg/answer-events-serialization.test.ts`(create)
- docs: `docs/architecture.md` §1/§2/§4/証明の空白 + `docs/02-tech-spec.md` 注記 1 行

---

### Task 1: 共有 wire schema + jstDayRange(pure・additive)

**目的:** wire event の zod 1 定義と JST day 境界の 1 定義を先行整備(spec §2.1 / §5)。

**Interfaces(Produces):**
```ts
// lib/sync/shared/answer-event-schema.ts(zod v4 記法・rating 必須)
export const answerEventWireSchema = z.object({
  event_id: z.uuid(), card_id: z.uuid(), session_id: z.uuid().optional(),
  selected_answer_ids: z.array(z.string().min(1)).max(50),
  is_correct: z.boolean(), rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  answered_at: z.iso.datetime(), elapsed_ms: z.number().int().min(0).max(86_400_000).optional(),
})
export type AnswerEventWire = z.infer<typeof answerEventWireSchema>
// lib/jst.ts
export function jstDayRange(day: string): { startAt: Date; endAt: Date }  // [JST 0:00, 翌 0:00) の UTC instant
```

**制約:** additive のみ(旧コード無影響)。`selected max 50` は既存 bound の踏襲(review-session-bounds は Task 4 で削除、bound 定義はここへ内包)。共有 schema は server-only / Node 専用 import を持たない(mutation-schemas 前例踏襲・client bundle 安全 — Codex plan 指摘 16)。jstDayRange は `todayInJst` と往復整合(`todayInJst(t) === day ⟺ startAt <= t < endAt`)。

**完了条件:** unit red→green — schema(rating 欠落 reject / elapsed_ms 上限)/ jstDayRange(日跨ぎ前後 1ms・閏日 2/29・`todayInJst` 往復 property を数点 pin — spec §5)。canonical + Codex pass → `[reviewed]`。

### Task 2: initial-fsrs-state + streak 統合(pure)

**目的:** 初期 FSRS 値と streak 計算の 1 定義化(spec §7)。

**Interfaces(Produces):**
```ts
// lib/cards/domain/initial-fsrs-state.ts — ts-fsrs は import しない(client bundle 回避)
export function initialFsrsState(now: Date): {
  due: Date; stability: number; difficulty: number; elapsedDays: number; scheduledDays: number;
  reps: number; lapses: number; state: 0; learningSteps: number; lastReview: null;
  answered: false; lastCorrect: null; currentStreak: 0 }
// lib/reviews/domain/streak.ts
export const STREAK_WINDOW_DAYS = 61
export function computeStreak(activeDates: string[], today: string): number
export function addDays(ymd: string, delta: number): string
```

**制約:** streak は既存 2 実装(`lib/db/streak.ts` / `lib/client/streak.ts`)の挙動不変移設 — 両 file は import + I/O のみに縮退し、既存 test は import 先変更のみで green を維持(挙動 pin として流用)。initial-fsrs-state の server 側一致 pin: `createEmptyCard()`(ts-fsrs)との全 field 一致を **server-only の unit** で検証。生成点の差し替え(3 箇所 + fixtures/seed)は Task 3。

**完了条件:** unit red→green(一致 pin + streak 既存 test green)。whole の typecheck green。canonical + Codex pass → `[reviewed]`。

### Task 3: cards 変更(migration 0034)+ 生成点統一

**目的:** stability/difficulty → double precision・CHECK(state 0-3)・FSRS 列 default 撤去、初期値を initialFsrsState に一本化(spec §1.3 / §7.1)。

**Files:** `lib/db/schema.ts`(cards)/ migration 0034 / `lib/cards/build-new-client-card.ts` / `lib/cards/apply-card-mutation.ts`(create)/ `app/(app)/app/upload/_actions/upload-persistence.ts`(saveExtractedCards)/ `lib/reviews/session-repository.ts:146` の `::real` → `::double precision`。

**制約:** 探索 step 必須 — cards を INSERT する**全**箇所(production 3 + tests/fixtures + `scripts/seed-perf-exam.ts` + iso setup)を grep で列挙し、default 撤去後も必須列供給になるよう追随(spec §7.1)。旧 wire・旧表はこの task では触らない(green を保つ)。migration は ALTER TYPE + default DROP + CHECK 追加(手動調整後 no-diff)。

**完了条件:** `pnpm test` / `pnpm test:iso` green(既存挙動不変)。write-isolation の `toBeCloseTo(5.5)` を厳密一致 assert に更新(double 化の実証 pin・red 検証 = cast を `::real` に戻す変異で fail)。canonical + Codex pass → `[reviewed]`。

### Task 4: server 全置換 — answer_events 新形 + ingest + 退会 + RLS(migration 0035)

**目的:** spec §1.1 / §1.2 / §2 / §3(server 側)/ §5 / §6 / §8 の一括実装。**不可分の全置換**(reviews/studySessions 削除は参照コードと test を同時に書き換えないと green の中間状態が存在しない — 設計判断として記録)。

**Interfaces(Produces):**
```ts
// lib/reviews/ingest-review-events.ts
export const payloadSchema = z.object({ events: z.array(answerEventWireSchema).max(1000) })
export async function processAnswerEvents(user: User, events: AnswerEventWire[], receivedAt: Date):
  Promise<{ failed: string[] }>   // failed = 衝突(所有権 or 内容不一致)のみ。tx throw は throw を透過(route が 503)
// lib/reviews/session-repository.ts(旧 API 全削除の上で)
export function lockCardReplayStates(tx, userId, sortedCardIds)       // ORDER BY id FOR UPDATE
export async function insertAnswerEvents(tx, rows): Promise<Set<string>>  // applied=false・RETURNING 新規
export async function verifyEventCollisions(tx, userId, events, notInserted): Promise<string[]>  // §2.2-4 の 2 段検証
export async function markApplied(tx, eventIds: string[]): Promise<void>
export async function recomputeStudyDays(tx, userId, days: string[]): Promise<void>
  // day ASC 順に行確保+ロック(INSERT..ON CONFLICT DO NOTHING → SELECT..FOR UPDATE)
  // → VALUES CTE 再集計(spec §5 の SQL)→ 絶対値 UPDATE
// lib/reviews/domain/session-aggregate.ts
export function planFold(events, lockedCardIds: Set<string>, optionIndex): FoldPlan  // A-2 降格 + per-card sort
export function foldSession(cardStates, plan): { finalStates; appliedEventIds: Set<string> }  // >= gate
// lib/cards/replay-card.ts — ReplayEvent に isCorrect: boolean 追加(§6)
```

**制約:** spec §2.2 の 9 手順を順序どおり(clamp は route で receivedAt 1 回採取・60s 超 warn)。前提 = withTenantTx の既定 **READ COMMITTED**(変更しない — FOR UPDATE 待機後に最新 committed を読む根拠。Codex plan 独立 10)。**study_days の cross-card lost update 対策(Codex plan 独立 1 = 真・spec §5 の補強)**: 再集計前に day ASC 順で day 行を確保+ロック(recomputeStudyDays 内・上記 Interfaces)— 異なる card の並走 flush でも (user, day) 単位で直列化され、後続 tx の再集計 SELECT は先行 commit を見る。**event_id 衝突判定は RLS 非迂回**(Codex plan 独立 2): 非新規 ∧ own-scope SELECT に不在 = 不可視衝突(foreign)として failed[](owner 情報は知り得ない・出さない)。**内容一致の比較規約**(Codex plan 独立 8): own 既存行を SELECT し **app 層で正規化比較**(answered_at = `min(再送 raw, 既存行 created_at)` の epoch ms / selected_answer_ids = 配列順込み等値 / session_id・elapsed_ms = undefined↔NULL 正規化)。A-2 の option 読みは locked cards.options jsonb = **同一行ロックで option 編集とも直列化済み**(invariant として明記・Codex plan 独立 3 は本 repo では非問題)。applied=false / clamp / 衝突は**理由付き構造化 log**(列は増やさない — spec 裁定)。`{events: []}` は 200 no-op。tx throw は classifyBulkError で **transient→503 + Retry-After / permanent→400**(恒久バグの無限 retry を作らない — Codex plan 独立 9・spec §2.1 の 503 を既存分類器で精緻化)。deriveRating / aggregateStudyDays / planReplay / insertReviews / upsertStudyDays(旧)/ upsertSessionGuarded / session-values / in-date-list / review-session-bounds は削除。退会 handler: answer_events を Group I へ + reviews/study_sessions 行削除 + invariant test 更新。RLS: wave1 SQL の answer_events policy 再定義・reviews 削除 / wave2 から study_sessions 削除 / verify-rls-state / completeness 追随 / **grants が新表に及ぶ形式か確認**(blanket でなければ追記)。migration 0035 = DROP/CREATE answer_events + DROP 2 表 + TRUNCATE study_days(no-diff 条件)。**廃止表参照の全数ゼロ確認**: `rg 'reviews|studySessions|study_sessions'` を ts/sql/scripts 横断で実行し残参照ゼロを完了条件に(docs は Task 7・Codex plan 指摘 12)。

**完了条件:** `tests/fixtures/review-events.ts` を新 wire 前提で書き直し(fake select chain は `.orderBy().for()` 実 shape — 第 1 弾 §6.2 の地雷)、route.test / contract / domain / repository test を新仕様で red→green(clamp・`>=` gate・sort・衝突 2 段・正規化比較(missing↔NULL / ISO 表現差 / 配列順)・payload 内 duplicate 同/異内容・空 events no-op・applied・CTE 再集計・dangling insert を pin — Codex plan 指摘 6/7 反映)。既存 iso の追随(rls-wave1/wave2 該当部削除・**rls-cascade は「card cascade で answer_events が消えない」検証へ反転**)込みで `pnpm test` / `pnpm test:iso` green。canonical + Codex pass → `[reviewed]`。

### Task 5: client 全置換 — Dexie v9 + flush 一本化 + 24h 撤去 + 計測

**目的:** spec §3(client 側)/ §4 の一括実装。

**Interfaces(Produces):**
```ts
// lib/client-db.ts v9: answer_events '++local_id, &event_id, [user_id+sync_status]'(event_id は
//   unique index 化 — Codex plan 独立 7。user_id 追加・last_attempted_at 削除・rating: 1|2|3|4 必須)
//   / study_sessions: null(store 削除)
// lib/sync/review-events.ts(旧 session API 全削除)
export async function recordAnswerEvent(input: { user_id: string; session_id: string; card_id: string;
  selected_answer_ids: string[]; is_correct: boolean; rating: 1|2|3|4; elapsed_ms?: number;
  event_id?: string; answered_at?: string }): Promise<ClientAnswerEvent>
export async function flushPendingAnswerEvents(userId: string, client?: BulkApiClient): Promise<FlushResult>
```

**制約:** flush = owner-scope 選別 → **送信前検証**(answerEventWireSchema・不正は 'failed' 隔離)→ 1000 chunk 逐次(失敗で中断・spec §3)→ 200 応答で synced / failed[] は **'failed' terminal 化**。synced/failed 化は flush 開始時に閉じた userId+event_id で限定(§4.2)。3 入口(threshold / 完了 / trigger)を runGuardedFlush 経由に統一 — controller / classifyFlushResults / backoff は不変。trigger から 24h drop 撤去(`dropStalePendingAnswerEvents` / `markAnswerEventsAttempted` 削除)。SessionLauncher は採番のみ(Dexie 行なし)。SessionRunner・ReviewFlushTrigger: userId を (app) layout / page の RSC から props 供給(認証済み値・§4.6)。SessionRunner: elapsed_ms 計測(表示開始→submit の wall-clock・clip 86_400_000・不能は undefined)。

**完了条件:** sync/component test 改稿 red→green(owner-scope 選別 / 送信前検証隔離 / chunk 境界 1000/1001 と失敗中断 / failed terminal / 24h 撤去 = 時間経過で failed 化しない pin / 空 pending は POST しない / elapsed 計測)。`pnpm test` green + `pnpm build` green。canonical + Codex pass → `[reviewed]`。

### Task 6: iso 新設 — 直列化・順序ガード・衝突・schema contract(spec §9.1)

**目的:** 実 PG での behavioral 実証(本 sprint の完了条件の核)。

**Files:** `tests/integration/pg/answer-events-serialization.test.ts`(create)+ 2 接続 helper(`tests/integration/pg/setup/` に追加。app-role 接続 2 本 + 各自 tenant context)。

**制約:** **green 経路に barrier を置かない**(FOR UPDATE 有効時は 2 本目の SELECT が commit まで進めず、SELECT 完了同期は deadlock する — Codex plan 指摘 2 で r1 の barrier 案を撤回)。green = `Promise.all` で 2 flush 同時発行 → 直列化により交錯順不問で `reps=2` を assert。test list = spec §9.1 の 7 項: ①直列化 ②順序ガード 5 形(古い 1 件 / 混在 sort / 中間遅着 / 同時刻 `>=` / lastReview null)③clamp ④dangling insert ⑤衝突 3 形(他人 = **RLS 非迂回の不可視衝突判定で failed になる pin** / 自分不一致 / 正当再送一致 — clamp 済み再送含む)⑥schema contract readback(PK/CHECK/index/policy/grant)⑦CTE 集計(複数 day / 離れた 2 day で中間 day 不変)+ **⑧cross-card 同一 day 競合**(異なる 2 card を 2 接続同時 flush → `review_count=2 ∧ distinct_card_count=2`。day 行ロックの実証 — Codex plan 指摘 1)。1000 event flush の所要を計測しログ出力(gate にしない)。

**完了条件:** red 検証 = gate **個別**変異 6 種(FOR UPDATE 外し / day 行ロック外し / 順序ガード外し / clamp 外し / 所有権検証外し / 内容一致検証外し)で対応 pin が単独 fail することを実証。**並行系 2 種(FOR UPDATE / day ロック)の変異には read 直後に `pg_sleep` を併せて注入し race を決定的に**する(barrier を green に持ち込まずに red を deterministic 化)。変異は uncommitted で行い検証後 `git restore` で復元(Codex plan 指摘 18)。commit message に「red 検証」記録。`pnpm test:iso` green。簡易 review → `[reviewed]`。

### Task 7: docs 更新 + sprint 完了 gate

**目的:** spec §13 の docs 波及と全 gate 実走。

**制約:** architecture.md — §1(review-events 行: session 廃止・1 POST 化・直列化)/ §2(cascade 用語: answer_events をユーザー帰属へ・reviews 削除)/ §4(Group I に answer_events)/ 証明の空白(「並走 flush の lost update」「順序逆転」を iso で埋めた行を追加)。tech-spec: 旧 wire / reviews / study_sessions 記述節の冒頭に「2026-08-11 spec が正・本節は歴史記述」1 行のみ。session doc に実施記録 + **stg 適用 runbook**(「migration → policy/grant 再適用 → verify-rls-state を同一メンテ窓で連続実行・app deploy より先」— 無防備窓と旧 server 不整合の最小化。Codex plan 独立 13/14)。

**完了条件:** whole-repo lint 0 / **`pnpm test` green(全 unit・Codex plan 指摘 9)** / test:iso green / audit 0 / frozen-lockfile + typecheck + build 0 を実走し、報告 chat に各 1 行明記。docs commit `[no-review]`。**完了は 2 段**(Codex plan 指摘 10): 本 task で「実装完了」として Sprint 境界停止(push は OT)→ push 後 stg smoke(spec §9.3)+ RLS 実効検証 PASS で「sprint close」(別 checkpoint・OT 指示で CC 実走)。

---

## 実行順序と依存

T1 → T2 → T3(いずれも green 維持・additive 中心)→ T4(破壊的置換・server)→ T5(client 追随・T4 完了まで wire 不整合)→ T6(iso 実証)→ T7(docs + gate)。T4 が最大(不可分の設計判断は本文に記録済み)。実装セッションは各 task fresh subagent + task 間 review(SDD 既定)。
