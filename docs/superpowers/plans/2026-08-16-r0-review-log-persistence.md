# R0: ReviewLog 持続化 実装 plan(r3 — **確定**。OT 承認 2026-08-16 + 裁定 3 点の確定文言を Task 5 に反映)

> r3 = OT 承認(2026-08-16)時の裁定 3 点確定: ① 欠損窓 = **条件付き受容**(coverage 契約を session doc に明記)② provenance = **列なし確定**(再裁定トリガー文言を session doc に記載)③ 監視 = **follow-up 化**(claude.ai todo 起票文を session doc へ転記 + 起票済みを完了条件に)。適用順は spec / plan 記載どおり migrate → policies enable → code deploy。**spec は凍結のまま**(いずれも記録粒度の確定で仕様変更なし)。

> Codex raw = `docs/codex/2026-08-16-plan-r0-review-log-persistence.md`(独立 14 / 抜け 16 / リスク 7)。採否 = **採用 5**(抜け 4/8 相当の失敗注入 rollback iso = Task 4 ⑥ / 抜け 5 全 17 列写像 pin = Task 4 ① / 抜け 11 migration meta 成果物 + R0 外差分ゼロ確認 / 抜け 13 fixture 意味整合 / 抜け 15 「4 file」誤記修正)・**部分採用 7**(独立 6/抜け 2 RLS 窓 = 受容根拠を Task 1 に明文化(空表 + 旧 code 無参照 + wave1 同型)/ 独立 7/抜け 8 = SQLSTATE 分類と回復経路を現物確認し Task 3 に事実明記(23514/23502→400・23505→503・client は pending 保全で修正 deploy 後自然回復 — `classify-bulk-error.ts:60-66,107`)/ 独立 12/抜け 10 性能測定の決定化 = Task 5 / 抜け 16 red 変異の記録様式 = Task 5 / 独立 14 並列配列契約 = JSDoc + test pin(構造変更は caller 1 で YAGNI)/ 抜け 14 全参照追随確認 = Task 2 完了条件 / 独立 3/抜け 6 provenance = 列で持たず復元根拠を session doc 記録(OT 裁定 ii))・**不採用 4**(独立 2/抜け 3 帰属整合の DB 保証 = UNIQUE 追加が answer_events 不触の確定決定 1 に抵触・単一 writer + 同一 tx 写像 + iso 全列 pin で受容し残余リスク記録 / 独立 4/抜け 7 同時刻総順序 = 現用途(per-event 遷移)に不要・YAGNI・残余リスク記録 / 独立 10 数値域 CHECK = spec §3.2 裁定済 / 独立 11・13/抜け 9・12 運用面(backup/監視/anti-join 監査/disable 検証)= R0 scope 外・follow-up は claude.ai todo)。**OT 裁定持ち 3 点は plan 提示 chat の論点参照**(deploy/rollback 欠損窓の受容 / provenance 列なし確認 / 監視系 follow-up 化)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 凍結 spec(`docs/superpowers/specs/2026-08-16-r0-review-log-persistence-design.md`)を、常時 green の 5 task で実装する — ts-fsrs ReviewLog を server 新表 `review_logs` へ同一 tx で蓄積開始(消費 UI なし)。

**Architecture:** 下層から積む — ① DB 層一式(表 + migration + RLS + iso 期待カタログ、Task 1)② pure 層で log 回収(replayCard / foldSession、Task 2)③ infra + orchestrator 配線(insertReviewLogs + ingest 手順 7.5、Task 3)④ iso behavioral 実証(Task 4)⑤ 性能再計測 + 完了 gate(Task 5)。**wire / client(Dexie 含む)/ answer_events 契約 / route は全 task 不触**。Task 2 完了時点は「log を集めるが書き手なし」の過渡 dead 値(additive・挙動不変)— 意図的で、Task 3 が消費者。

**Tech Stack:** Drizzle + PostgreSQL(Supabase)/ ts-fsrs 5.4.1(pin 不変・追加 package なし)/ Vitest unit + 実 PG iso(`pnpm test:iso`)。

**Spec:** `docs/superpowers/specs/2026-08-16-r0-review-log-persistence-design.md`(**凍結** — §12 の 4 裁定込み。列定義は §3.1 の対応表が正本)

## Global Constraints(全 task に適用)

- spec は凍結。仕様判断が必要になったら停止して OT 相談。
- **Sprint A 凍結契約 不触**(spec §2): 冪等 2 段 / `>=` 順序ガード / FOR UPDATE / 全受理設計。answer_events・wire schema・client の変更ゼロ。
- **feat task(1〜3)** = canonical review(`superpowers:requesting-code-review` 既定経路・template 改変なし)+ Codex(`scripts/ai/codex-review.sh <topic>`)並列 → 未解決 Critical 0・Important 0 → `[reviewed]` commit。implementer subagent は commit しない(working tree で返し、controller が review pass 後に commit)。`--no-verify` 全面禁止。
- **test-only task(4)** = 保証の増 → **red 検証必須**(gate を個別に変異・commit message に「red 検証」記録行)+ 簡易 review(Codex 可)→ `[reviewed]`。
- 新規 assertion はすべて red 検証(Task 2〜4 の各 test 節に変異を明記)。
- migration / policy の適用は local iso(global-setup が毎 run 適用)のみ。**stg / prod への適用は OT**(deploy 順: migrate → policies enable(同一メンテ窓)→ code。spec §7)。
- 完了 gate(Task 5): whole-repo `pnpm lint --max-warnings=0` / `pnpm test:iso` / `pnpm run audit` 全 exit 0。依存・Next 設定・lockfile は不触(追加 gate 非該当)。
- 命名: 列は spec §3.1 の snake_case を Drizzle camelCase で(`stateBefore` 等)。CHECK 名 = `review_logs_rating_range` / `review_logs_state_before_range` / `review_logs_state_after_range`。

---

### Task 1: DB 層一式 — `review_logs` 表 + migration 0039 + RLS + iso 期待カタログ

**Files:** Modify: `lib/db/schema.ts` / `tests/integration/pg/setup/completeness.ts` / `tests/integration/pg/setup/fixture.ts` / `tests/integration/pg/setup/global-setup.ts` / `scripts/verify-rls-state.ts` / `tests/integration/pg/rls-drift.test.ts` / `drizzle/migrations/meta/`(journal + snapshot — generate が自動更新)。Create: `drizzle/migrations/0039_r0_review_logs.sql`(drizzle-kit generate)/ `db/policies/r0-review-logs-enable.sql` / `db/policies/r0-review-logs-disable.sql`

- 目的: 新表がインフラ層で完全に存在する状態を 1 commit で作る(**分割しない** — schema 追加の瞬間に completeness 三者一致 19 pin が red になり、RLS 未適用の中間は isolation 検査と矛盾する。常時 green の最小単位がこの一式)。
  - `schema.ts`: `export const reviewLogs = pgTable('review_logs', ...)` — spec §3.1 の 17 列(PK `event_id` FK→`answerEvents.eventId` CASCADE / `user_id` FK→users CASCADE / `card_id` FK なし / before 5 値 / deprecated 2 列 / scheduled_days / learning_steps / review / after 3 値 / created_at)+ CHECK 3 本。**index 追加ゼロ**(PK のみ — 最初の消費者 Dash-3 の spec で追加)。表 comment に「applied event と 1:1 / 書込は ingest 手順 7.5 のみ / plain INSERT(23505 = fold 二重適用バグの loud 検出)」を記す。
  - migration: `drizzle-kit generate --name=r0_review_logs` で 0039 生成(0036〜0038 未 push スタックの後続)。手書き SQL 追記なし(RLS は入れない — spec §12-1 裁定)。
  - policy 対 file: wave1 の共通形を踏襲(`ENABLE ROW LEVEL SECURITY` + `DROP POLICY IF EXISTS` + `CREATE POLICY review_logs_tenant FOR ALL TO recallmint_app USING = WITH CHECK = user_id = (SELECT app_current_user_id())`、`SET lock_timeout = '5s'`、冪等)。grants 変更なし(`ALTER DEFAULT PRIVILEGES` が自動被覆)。
  - `global-setup.ts`: 適用列の末尾(ocr-2-4a-enable の後)に enable file を登録。
  - `completeness.ts`: `EXPECTED_USER_ID_TABLES` に `'review_logs'`(19→20。truncate / ALL_TABLES は派生で自動追随)。
  - `fixture.ts`: `seedTenant` の tier3 で answer_events の `eventId` を変数化し、review_logs 1 行を追加。**親 event と意味整合させる**(Codex 抜け 13 採用): 親は applied=true・rating/card_id/user_id/時刻を review_logs 行と一致させ、before = `initialFsrsState` 相当 / after = 1 回適用後として自然な合法値。fixture-completeness の A/B 行存在 assert の餌。
  - **RLS 窓の受容根拠**(Codex 独立 6/抜け 2 部分採用): migrate 後〜policy enable 前の窓は「表が空(code deploy 前で writer 不在)+ 旧 code に参照ゼロ + 同一メンテ窓連続適用」の 3 条件で露出実体なし — wave1 が 0035 で確立した既存受容 class と同型。iso は global-setup が毎 run 連続適用するため窓が存在しない。
  - `verify-rls-state.ts`: `COMMON_FORM_RLS_TABLES` に `'review_logs'` 追加(→ EXPECTED_RLS_TABLES 19 / EXPECTED_POLICIES 21 / EXPECTED_GRANTS 自動)。`rls-drift.test.ts:84-86` の件数 assert を 19 / 5 / 21 へ追随。
- 制約: 既存 19 表の定義・既存 policy file は不触。`answer_events` 側 schema 変更なし(FK は review_logs 側からのみ)。
- 完了条件: `pnpm test:iso` 全 green(fixture-completeness 三者一致 20 / rls-drift カタログ突合 / isolation・rls 系の自動被覆で新表も検査対象化)+ **生成 migration に R0 外差分ゼロ**(generate 前に schema.ts ↔ 0038 の整合を `drizzle-kit check` or 生成 SQL diff 目視で確認 — 0036〜0038 未 push スタックへの混入防止。Codex 抜け 11 採用)+ `pnpm lint` / `pnpm typecheck` + canonical/Codex Crit0・Imp0 → `[reviewed]`。commit `feat(db): review_logs 表 + RLS + iso カタログ(R0 Task 1)`。

### Task 2: pure 層 — replayCard の log 回収 + foldSession の appliedLogs

**Files:** Modify: `lib/cards/replay-card.ts` / `lib/reviews/domain/session-aggregate.ts`。Test: `lib/cards/replay-card.test.ts` / `lib/reviews/domain/session-aggregate.test.ts`

**Interfaces(Produces):**
- `replayCard(initial: ReplayCardState, events: ReplayEvent[]): { state: ReplayCardState; logs: FsrsReviewLog[] }`(`import type { ReviewLog as FsrsReviewLog } from 'ts-fsrs'` — type import のみで pure 維持。logs は events と同 index 1:1)
- `session-aggregate.ts` export: `type AppliedReviewLog = { eventId: string; cardId: string; log: FsrsReviewLog; after: { state: 0 | 1 | 2 | 3; stability: number; difficulty: number } }`
- `foldSession(...): { finalStates; appliedEventIds; appliedLogs: AppliedReviewLog[] }`(既存 2 戻り値は不変)

- 目的: 現在捨てている `rate(...).log` を pure 層で回収する(spec §5-1/2)。replayCard は `RecordLogItem` から `.card` に加え `.log` を集め、foldSession は適用直後の `current`(= after)と併せて event 1:1 の `appliedLogs` を構築。skip(順序ガード / plan 段階 skip)は現行どおり何にも入らない。**`logs[i]` は `events[i]` に対応(同 index 1:1)の契約を JSDoc に明記**し test ① が pin(Codex 独立 14 部分採用 — 一体型への構造変更は caller 1 で YAGNI)。
- 制約: fold の計算・順序・`>=` ガードは不変(appliedEventIds / finalStates の値が変わらないこと)。消費者はまだ居ない(Task 3)— 過渡 dead 値は Global 記載どおり意図的。ts-fsrs の runtime import を増やさない(既存 `rate` 経由のみ)。
- test: replay-card — ① logs.length === events.length ② `logs[i].review` = `events[i].answeredAt` ③ 空 events → `{ state: initial コピー, logs: [] }` ④ log の before 値(state/stability/difficulty)= 適用前 state。session-aggregate — ⑤ appliedLogs の eventId 集合 = appliedEventIds ⑥ skip event(card_not_locked / unknown_option / 順序ガード)は appliedLogs に出ない ⑦ 同 card 複数 event で `logs[n].after` = `logs[n+1].log` の before 値(連鎖)。**red 検証**(個別変異): (a) `.log` を捨て空配列を返す変異 → ①② fail (b) appliedLogs を plan.groups 全 event から構築する変異 → ⑥ fail。
- 完了条件: 対象 unit green + **`rg replayCard` / `rg foldSession` 全参照(test 含む)の追随確認**(Codex 抜け 14 採用)+ lint / typecheck + canonical/Codex Crit0・Imp0 → `[reviewed]`。commit `feat(reviews): replayCard/foldSession で ReviewLog を回収(R0 Task 2・書込は Task 3)`(red 検証 記録行付き)。

### Task 3: infra + orchestrator — insertReviewLogs + ingest 手順 7.5

**Files:** Modify: `lib/reviews/session-repository.ts` / `lib/reviews/ingest-review-events.ts`。Test: 既存 unit 構造に追随(`lib/reviews/session-repository.test.ts` ほか ingest 経路の既存 test file)

**Interfaces(Consumes/Produces):**
- Consumes: Task 2 の `AppliedReviewLog`。
- Produces: `insertReviewLogs(tx: SessionExecutor, rows: ReviewLogInsertRow[]): Promise<void>` — `ReviewLogInsertRow` = spec §3.1 全列の camelCase 型(`eventId / userId / cardId / rating / stateBefore / dueBefore / stabilityBefore / difficultyBefore / elapsedDays / lastElapsedDays / scheduledDays / learningSteps / review / stateAfter / stabilityAfter / difficultyAfter / createdAt`)。

- 目的: bulk INSERT **1 statement**(≤1000 行 / flush)を repository に置き、ingest の `markApplied`(手順 7)直後・`recomputeStudyDays`(手順 8)の前で呼ぶ。row 構築は orchestrator 側 — `appliedLogs` に `userId = user.id` / `createdAt = receivedAt` を展開し、`log` の 10 field と `after` 3 値を列へ写像。**plain INSERT**(onConflict なし — 23505 は fold 二重適用バグの loud 検出。spec §4)。rows 空(全 skip)なら早期 return で statement を発行しない。
- 制約: 同一 `withTenantTx` 内(spec §6 — 失敗は tx ごと rollback、新しい catch を足さない)。既存手順 1〜9 の順序・SQL は不変。`insertAnswerEvents` / `markApplied` / `recomputeStudyDays` は不触。**失敗時の分類と回復経路(現物確認済・Codex 独立 7/抜け 8)**: review_logs 起因の 23514/23502 は `classify-bulk-error.ts:60-66` で permanent-4xx → 400、23505 は default transient → 503。**いずれも client は当該 event を terminal 化せず pending 保全**(`review-events.ts` の failed 化は 200 応答の failed[] のみ)— ingest は停止するが修正 deploy 後に pending が自然 flush で回復。新規対応コード不要(既存クラスに乗る事実の確認)。
- test: ① rows → 単一 insert 呼出(bulk)で全列が写像される(repository unit)② rows 空 → statement 不発行 ③ **同一 tx 性 pin** — ingest 経路の unit で `insertReviewLogs` が `withTenantTx` callback に渡された **同一の tx オブジェクト**で呼ばれることを assert(既存 route.test の mock 様式に揃える)。**red 検証**(個別変異): (c) `insertReviewLogs` 呼出を tx 外(別接続 / `getDb()` 直)へ移す変異 → ③ fail。
- 完了条件: 対象 unit green + lint / typecheck + canonical/Codex Crit0・Imp0 → `[reviewed]`。commit `feat(reviews): applied event の ReviewLog を同一 tx で review_logs へ永続化(R0 Task 3)`(red 検証 記録行付き)。

### Task 4: iso behavioral 実証 — `review-logs.test.ts`

**Files:** Create: `tests/integration/pg/review-logs.test.ts`。Modify: `tests/integration/pg/COVERAGE.md`

- 目的: spec §11 iso 5 項を実 PG で pin する。刺激 = `processAnswerEvents`(withTenantTx 経由)/ 観測 = owner 接続(answer-events-serialization と同作法。H1 規約: afterAll で closeDb + closeFixtureOwnerDb)。
  - ① 適用 1 event = log **ちょうど 1 行**、かつ **全 17 列の写像を pin**(Codex 独立 9/抜け 5 採用): before 5 値(state/due/stability/difficulty)= seed した cards 値 / deprecated 2 列 + scheduled_days + learning_steps = rate() 出力 / after 3 値 = 適用後 cards 行 / `review` = clamp 済 answered_at / `created_at` = 応答 receivedAt(= answer_events.created_at と一致)/ `rating`・`card_id`・`user_id` = event 値。timestamptz 比較は ms 精度(epoch ms)で行う。
  - ② 同一 payload 再送 → 行数不変(冪等)。
  - ③ applied=false の 3 経路(card_not_locked / unknown_option / `>=` 順序ガード skip)→ log 0 行。
  - ④ 同 card 複数 event 1 payload → event ごと 1 行 + before/after 連鎖(row n の after = row n+1 の before)。
  - ⑤ schema contract readback: PK + FK 2 本(CASCADE 込み)+ CHECK 3 本を pg_constraint(contype p/f/c 絞り — PG18 の contype='n' 偽 red 回避は answer-events-serialization の既存注意書きどおり)で定義文まで pin。
  - ⑦ **帰属整合の代替保証**(Task 1 で canonical・Codex が独立収束した Important の吸収・SDD Ruling R7。DB の複合 FK は `answer_events` への UNIQUE 追加を要し凍結契約に抵触するため、**test を代替の保証**とする): (a) 他 tenant 所有の `event_id` を含む payload → 当該 event は `insertAnswerEvents` の onConflict で非新規 → failed[] 扱い、かつ **review_logs に行が生まれない**(構造的不可達の pin)。(b) **挿入された全 log 行について `review_logs.user_id` = 参照先 `answer_events.user_id`**(帰属一致の invariant pin)。
  - ⑥ **失敗注入 rollback**(Codex 独立 8/抜け 4 採用): owner 接続で `ALTER TABLE review_logs ADD CONSTRAINT tmp_reject_all CHECK (false) NOT VALID` を一時付与(NOT VALID でも新規 INSERT には効く)→ `processAnswerEvents` が throw → **answer_events 0 行・cards 不変・study_days 不変**(= 手順 4〜8 全体の rollback)を owner readback で assert → 制約 drop(finally)。同一 tx 性の実 PG 実証で、unit の tx-identity pin(Task 3 ③)を補完する。
- 制約: 純関数の fold 規則は unit 側(Task 2)の担当 — ここでは重複させない(実 PG でしか出ない性質のみ)。fixture の seed 行には依存せず test 内で自前 seed(truncate→reseed の既存 beforeEach 作法)。
- **red 検証**(個別変異・commit message に記録): (d) ingest の `insertReviewLogs` 呼出を削除 → ① fail (e) rows を appliedLogs でなく `newRows` 全件から構築する変異 → ③ fail。
- 完了条件: `pnpm test:iso` 全 green + 簡易 review(Codex で「①〜⑤の主張が pin 内容と一致するか」観点)→ `[reviewed]`。commit `test(iso): review_logs の 1:1 / 冪等 / applied=false / 連鎖 / readback を pin(R0 Task 4)`(「red 検証」記録行付き)。

### Task 5: 性能再計測 + session doc + sprint 完了 gate

**Files:** Create: `docs/superpowers/sessions/2026-08-16-r0-review-log-persistence.md`

- 目的: 締めの検証と記録。
  - 性能: Sprint A §6.1 と同一ハーネス(1000 event / 10 card / JST 3 day・**全件 applied 構成固定**・`processAnswerEvents` のみ計測・local PG)で再計測。**warm-up 1 回 + 本計測 5 回、中央値を代表値**とし(Codex 独立 12/抜け 10 部分採用)、110ms 基準比 **+20%(≈132ms)以内**を確認。超過時は chat 報告(gate 化しない)。計測 script は scratch(repo に残さない)— 手順と実測値を session doc に記す。
  - Group invariant: clerk `route.test.ts` の削除網羅性 invariant が**無変更で green**(= review_logs の Group II 自動判定の実証)を確認し記録。
  - sprint 完了 gate: whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm test:iso` / `pnpm run audit` 全 exit 0。
  - session doc(**OT 裁定 3 点は下記の確定文言をそのまま記載する**):
    - 実測値(中央値 + 5 回の生値)/ **red 変異 5 種(a〜e)を「変異内容・対象 test・期待した失敗・実結果」の 4 項で記録**(Codex 抜け 16 部分採用・Sprint A §6.2 の様式)/ Group II 実証。
    - **① 欠損窓 coverage 契約(OT 裁定・条件付き受容)**: 「code rollback が発生した場合は欠損期間(deploy 時刻範囲)を session doc / ops 記録に残し、Dash-3 以降の L4 消費はその期間を除外または注記する」。**初回 deploy 窓はユーザー 0 で空集合**。
    - **② provenance 再裁定トリガー(OT 裁定・列なし確定)**: 「ts-fsrs(現 5.4.1 exact pin)の version bump または既定パラメタ変更を行う場合、変更 code の deploy 前に provenance の要否を再裁定し、必要な識別情報を rollout に先行して導入する(rolling 混在窓では行単位の version が事後復元不能のため)」。
    - **③ 監視 follow-up 起票文(OT 裁定・claude.ai todo へ)**: 「review_logs の anti-join 整合監査(applied=true AND NOT EXISTS log)と review_logs 起因 ingest エラーの識別 alert を、Dash-3 か運用 sprint で設計する」— **全文を session doc に転記し、claude.ai todo へ起票済みであることを完了条件に含める**(chat 報告に全文を出す)。
    - 残余リスク(帰属列は単一 writer の app 写像を信頼・DB 保証なし / 同時刻 event の総適用順序は非保存)/ 残余(stg・prod 適用は OT — migrate → policies enable → code deploy の順)。
- 制約: 実装変更なし(検証と docs のみ)。gate fail 時は該当 task に戻る(cover up 禁止)。
- 完了条件: gate 3 種 exit 0 + session doc commit(`docs(sessions): ... [no-review]`)→ stop checkpoint 報告(「whole-repo lint exit 0 確認済 / test:iso green 確認済 / pnpm run audit exit 0 確認済」を 1 行ずつ明記)。push は OT。

---

## 完了の全体像

- 成果物: migration 0039(+ meta)/ policy 対 file / 実装 5 file(schema・replay-card・session-aggregate・session-repository・ingest)/ iso 新 file 1 + カタログ 4 file 更新 / session doc。
- 検証: unit(Task 2・3)+ iso 6 項(Task 4 — 失敗注入 rollback 込み)+ red 変異 5 種(a〜e)+ 性能再計測 + 完了 gate 3 種。
- stg 反映は 0036〜0038 スタックと合流して OT 判断(spec §7 の deploy 順)。
