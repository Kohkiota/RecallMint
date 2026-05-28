# 問題 3 bulk refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development または superpowers:executing-plans でタスク単位に実装。 各タスクは TDD (test 先行) + 完了で commit。 step は checkbox 追跡。

**Goal:** `/api/review-events/bulk` の event 処理を「per-event tx (N×35 RTT)」→「1 tx + in-memory FSRS replay + bulk SQL」へ畳み、 N=5 で ~16s→~3.2s を狙う。

**Architecture:** FSRS 純計算コア `replayCard` を DB 非依存で抽出。 route は (Phase0) session upsert を tx 外維持 → (Phase1) distinct card_id を owner-scope SELECT IN で取得し orphan を `failed[]` 除外 → (Phase2) 1 tx 内で answer_events bulk INSERT ... ON CONFLICT DO NOTHING RETURNING → 新規分のみ payload 順 replay gating → card ごと `replayCard` fold → reviews bulk INSERT → cards VALUES 単一 UPDATE → study_days JST day group upsert。

**Tech Stack:** Next.js route handler (nodejs runtime) / Drizzle 0.45.2 (bulk INSERT・ON CONFLICT DO NOTHING RETURNING・UPDATE FROM(subquery) native、 VALUES tuple のみ raw `sql`) / ts-fsrs `rate()` / Vitest (実 DB 不可、 mock) / zod。

**Ground truth:** spec `docs/superpowers/sessions/2026-05-28-problem3-bulk-refactor-spec.md` + pre-investigation `…-problem3-sync-layer-pre-investigation.md` (touch file・現挙動・不変条件 11 件、 実コード行付き)。

---

## 全体ルール (各タスク共通、 冒頭一度のみ)

- **絶対ルール**: owner-scope (`WHERE user_id = me`) を全 SQL 維持 (CLAUDE.md Clerk 4) / DB schema 変更ゼロ (migration なし) / API payload 契約不変 (client 非 touch) / 応答契約 `200 + { ok: true, failed: string[] }` 死守。
- **冪等性**: 単位は `event_id`。 新規 insert 分のみ apply。 再送済みは apply せず **failed にも入れない** (成功扱い)。 payload 内重複は初回のみ。
- **順序**: 同カード複数 event は **payload 配列順**で直列 fold。 `answered_at` で sort しない。 `rate()` の `now` = `event.answered_at`。
- **失敗隔離**: orphan card (owner-scope SELECT に無い) のみ事前除外で `failed[]`。 tx 途中の非予測エラーは全 rollback → applicable 全件を `failed[]`。
- **scope 外** (触らない): client flush / in-flight guard / 旧単発経路 `submit-review.ts` + `submitReviewTx` (据え置き、 後述 Task 1 註) / DB schema / C2 / outbox rename / TTL drop / region / after 計測。
- **TEMP-MEASURE**: 既存 timing 計測 (`measure` helper / `timings` / request marker、 production 非出力) は撤去せず、 per-event 名 → **per-phase 名** (`select-cards` / `insert-events` / `replay` / `insert-reviews` / `update-cards` / `study-days` / `total`) に付け替えて存続。 after 計測 task で使う。
- **コミット規律**: feat commit は `requesting-code-review` skill canonical 経路 (Task 6) 通過後に `[reviewed]`。 TDD: test 先行で fail 確認 → 最小実装 → green → commit。

---

## File Structure

| file | 操作 | 責務 |
|---|---|---|
| `lib/cards/replay-card.ts` | Create | DB 非依存の純 FSRS replay コア。 現状態 + 順序付き events → 最終 cards 状態 + review 行 |
| `lib/cards/replay-card.test.ts` | Create | replay コアの invariant test (sequential semantics 移植) |
| `app/api/review-events/bulk/route.ts` | Modify | per-event tx loop を `processSession()` (Phase0/1/2) に置換 |
| `app/api/review-events/bulk/route.test.ts` | Modify | per-event 呼出回数/順序 assert を DB 結果ベースへ書換 + 新規 test (spec §5) |
| `lib/cards/submit-review-tx.ts` | Delete (Task 2) | route 移行後に完全 dead 化 (bulk 専用と確定済 / 撤去調査 d97f29a)。 撤去 |
| `lib/cards/submit-review-tx.test.ts` | Delete (Task 2) | submitReviewTx 撤去に伴い削除 |
| `lib/cards/submit-review-tx.sequential.test.ts` | Delete (Task 2) | semantics を Task 1 で replay-card.test.ts に統合後に削除 |

**撤去順序厳守 (guard が一瞬も空かない)**: Task1 で replay-card.test.ts に sequential semantics 移植・green → Task2 で route を replayCard に結線・bulk 正常系 green → **その後に** submitReviewTx + sequential.test.ts + submit-review-tx.test.ts を撤去。

---

### Task 1: 純 FSRS replay コア `replayCard` 抽出

**Files:** Create `lib/cards/replay-card.ts` / Test `lib/cards/replay-card.test.ts`

- **目的**: bulk replay (と将来のローカル FSRS) が共有する DB 非依存の計算口。 入力 = card の現 FSRS 状態 (cards 列の subset: due/stability/difficulty/elapsedDays/scheduledDays/reps/lapses/state/learningSteps/lastReview/currentStreak) + 同カードの順序付き events (`{ rating: RatingInt; answeredAt: Date }[]`)。 出力 = `{ final, reviews }`。 `final` = 書き戻す cards 列 (上記 FSRS 列 + `answered:true` + `lastCorrect` + `currentStreak`)、 `reviews` = event ごと `{ rating, reviewedAt: answeredAt }[]` (適用数 = 行数)。
- **制約**: `@/lib/fsrs` の `rate(card, rating, now)` を使い events を **fold** (各 step の出力を次の入力に)。 `now = event.answeredAt`。 `correct = rating >= 2`。 `currentStreak = correct ? prev+1 : 0`。 `lastReview = next.last_review ?? answeredAt`。 DB op・I/O を一切含めない純関数。 ts-fsrs Card の snake_case ⇄ DB camelCase 変換は `submit-review-tx.ts:81-95,101-118` と同一規則。 旧 `submitReviewTx` の compute と挙動完全一致 (= sequential.test.ts が通る semantics)。
- **完了条件**: `replay-card.test.ts` が **invariant check** で通過 — (A) Hard→Good→Easy: reps が apply 数分 increment / streak 0→1→2→3 単調増加 / 各 due > 各 answeredAt、 (B) Good→Again→Good: streak 1→0→1 / reps は incorrect 含め 3 増加、 (C) events 空 → final == 初期状態 (no-op) かつ reviews=[]。 期待値 hard-code 回避 (ts-fsrs version up 耐性)。 `pnpm test replay-card` green + Critical 0 + [reviewed]。

**註 (撤去調査 d97f29a 反映)**: 旧単発 `submitReview` action は撤去済、 `submitReviewTx` は bulk route 専用と確定。 Task 2 で route を `replayCard` に移行後 submitReviewTx は完全 dead 化するため **Task 2 最終 step で撤去**する。 `sequential.test.ts` の semantics (Hard→Good→Easy / Good→Again→Good) は本 Task で `replay-card.test.ts` に統合し、 `replayCard` を FSRS compute の **単一 guard** とする (二重 guard 据え置き案は撤回)。

---

### Task 2: bulk handler を `processSession()` に再構築 (Phase 0/1/2)

**Files:** Modify `app/api/review-events/bulk/route.ts`

- **目的**: `route.ts:195-242` の per-event tx loop を撤去し、 1 session を処理する内部関数 `processSession(db, user, session, events) → { failed: string[] }` に切り出す (将来 C2 拡張点。 今回 payload は 1 session のまま、 POST handler が 1 回呼ぶ)。 Phase 0: session upsert を **events tx の外**で現状の onConflictDoUpdate (`setWhere = user_id` / `card_ids` 非上書き / status・completed_at 上書き) のまま維持、 失敗時は handler が 500 `session_upsert_failed`。 Phase 1 (tx 内): payload events から distinct card_id を集め `SELECT … FROM cards WHERE userId = me AND id IN (...)`、 返らない card_id の event を `failed[]` へ、 残り = `applicableEvents` (payload 配列順保持)。 Phase 2 (同 tx 内): ①answer_events bulk `INSERT … ON CONFLICT DO NOTHING RETURNING eventId` → `insertedEventIds:Set`、 ②`applicableEvents` を payload 順走査し `event_id ∈ insertedEventIds ∧ consumedSet 未消費` だけ採用 (`consumedSet` に add) = `eventsToApply`、 ③`eventsToApply` を card_id ごと group (group 内 payload 順) し各 card は Phase1 の現状態起点に `replayCard` で fold、 ④reviews bulk INSERT (適用 event 数 = 行数)、 ⑤cards 書き戻し (Task 4)、 ⑥study_days (Task 3)。
- **制約**: Phase 1/2 全体を **単一 `db.transaction`**。 SELECT IN は owner-scope (削除済・他人 card を同時に弾く)。 FK は最後の砦として残すが事前除外で発火させない。 tx 内で非予測エラー throw → tx 全 rollback → handler は `failed[] = orphanFailed ∪ applicableEvents の event_id 全件` で **200** 返却 (500 にしない、 client 丸ごと retry × event_id 冪等が安全網)。 再送済み event (insertedEventIds に無い) は `eventsToApply` から外れるが `failed[]` に入れない。 `submitReviewTx` import を route から削除。 TEMP-MEASURE は per-phase 名で存続 (全体ルール参照)。
- **完了条件**: route の bulk 正常系が DB 結果ベースで green (reviews/cards/study_days bulk SQL 結線)。 **その green を確認した後の最終 step** で route の `submitReviewTx` import 削除 + `lib/cards/submit-review-tx.ts` + `submit-review-tx.test.ts` + `submit-review-tx.sequential.test.ts` を撤去 (撤去後に `pnpm typecheck` + 全 test green 再確認)。 cards 書き戻しは本 task では **card 単位 UPDATE × N (同 tx 内)** 安全版で先に動かし Task 4 で VALUES 化。 Critical 0 + [reviewed]。

---

### Task 3: study_days を JST day group で集計 upsert

**Files:** Modify `app/api/review-events/bulk/route.ts` (Phase 2 ⑥)

- **目的**: `eventsToApply` を `todayInJst(answeredAt)` の day ごとに group。 day ごとに「適用 event 数」と「correct(rating>=2) 数」を集計。 reviews INSERT 完了後に day ごと `SELECT COUNT(DISTINCT card_id) FROM reviews WHERE user_id = me AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date = day` を再集計し、 `study_days` を day ごと upsert (`reviewCount += その day の適用数` / `correctCount += correct 数` / `distinctCardCount = 再集計値`)。
- **制約**: `submit-review-tx.ts:135-158` の SQL 規則 (raw `sql` parameterized、 `::uuid`/`::date` cast、 `AT TIME ZONE 'Asia/Tokyo'`) を踏襲。 owner-scope 維持。 reviews INSERT より後に再集計 (今回分を含むため)。 増分は `sql\`${col} + n\`` で。 単一 event 時も既存挙動 (reviewCount+1) と一致すること。
- **完了条件**: Task 5 の study_days test (単日 / 複数 day group / 同カード複数 event で distinct は 1) が green。 Critical 0 + [reviewed]。

---

### Task 4: cards 書き戻しを VALUES 単一 UPDATE 化

**Files:** Modify `app/api/review-events/bulk/route.ts` (Phase 2 ⑤)

- **目的**: Task 2 の card 単位 UPDATE × N を `UPDATE cards SET due=v.due, stability=v.stability, … FROM (VALUES (...),(...)) AS v(id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, learning_steps, last_review, answered, last_correct, current_streak) WHERE cards.id = v.id AND cards.user_id = me` の単一文に畳む。 各 card の `replayCard.final` を 1 tuple に。
- **制約**: raw は **`sql` / `sql.join` で parameterized 構成、 文字列連結禁止**。 各 column の型 cast 明示 (`::uuid` / `::timestamptz` / `::real` / `::int` / `::boolean`)。 owner-scope (`cards.user_id = me`) を JOIN 条件に必須。 Drizzle `update().set().from(sql\`(VALUES …) AS v(…)\`).where(…)` 経路を使用 (0.45.2 native、 pre-investigation 軸 7)。 **fallback (Task 2 の card 単位 UPDATE × N) は技術的に不可能な事実が出たときのみ**: raw sql の parameterize が `sql`/`sql.join` で安全に組めない / 型 cast が DB で通らない / `update().from(sql\`VALUES…\`)` が実際に動かない。 「面倒・複雑・脆そう」は fallback 理由にしない (fallback は 1 tx 目標は満たすが ~2.6s 残る安全版)。
- **完了条件**: Task 5 の「VALUES UPDATE が card ごと別状態を正しく書く」test が green (異なる FSRS 状態の複数 card が各々正しい行に書かれる)。 raw SQL の parameterize を review で確認。 `pnpm typecheck` pass + Critical 0 + [reviewed]。

---

### Task 5: route.test.ts 書き換え + 新規 test (spec §5)

**Files:** Modify `app/api/review-events/bulk/route.test.ts`

- **目的**: 内部実装が per-event → bulk に変わるため、 `submitReviewTx` 呼出回数/順序を assert する既存 test (`route.test.ts` 正常系・rating derive・重複・partial failure・F3 順序) を **DB 結果ベース** (fake tx に渡る bulk INSERT values / cards UPDATE tuple / reviews 行 / study_days upsert 引数) の assert に書き換え (挙動維持なので期待結果は同じ)。 新規 test を追加: orphan card → `failed[]` で他は適用 / payload 内重複 event_id → 1 回のみ apply / 再送済み event_id (insertedEventIds に無い) → 適用せず failed にも入れず / 同カード複数 event の payload 配列順 fold / study_days 多 day group / VALUES UPDATE の card 別状態 / 注入エラーで全 rollback → applicable 全件 failed[] / 応答契約 `200 + { ok, failed }`。
- **制約**: 実 DB 禁止 (CLAUDE.md AI/テスト方針)、 `getDb` / `getCurrentUser` mock + fake tx で bulk chain (`insert().values().onConflictDoNothing().returning()` / `update().set().from().where()` / `insert(reviews).values()` / study_days upsert / `select().from().where()` for SELECT IN) を再現。 `replayCard` は **mock しない** (純関数、 実 ts-fsrs で fold 検証)。 zod fixture は v4 `z.uuid()` 通過 format 維持。
- **完了条件**: spec §5 の全 test 項目が存在し green。 既存 test の意図 (tenant 分離 setWhere / card_ids 非上書き / 空 flush / events 1001 件 400 / 401・400 系) は維持。 Critical 0 + [reviewed]。

---

### Task 6: 全体検証 + code review

**Files:** なし (検証 + review)

- **目的**: `pnpm typecheck` + `pnpm test` (全 suite) green を確認し、 feat 変更を `requesting-code-review` skill canonical 経路 (skill template + general-purpose subagent + 厳格 prompt、 template 改変なし) に通す。
- **制約**: review 経路の省略・自由形式 review・軽量 agent 投げ捨て禁止 (CLAUDE.md Review 必須経路)。 commit 直前に review ログ 4 点 (経路 / 結果 Critical N・Important N・Minor N / 残す Important + 理由 / [reviewed] 宣言) を chat 明示。 本 refactor は決済・認証・削除・外部副作用のいずれにも非該当のため review pass で `[reviewed]` 付与可 (裏取り対象外)。
- **完了条件**: 全 test green + typecheck pass + review Critical 0 (Important は OT 判断) + 全 feat commit に `[reviewed]` tag + `.claude/hooks/check-review.sh` block なし。

---

## Self-Review (spec 突合)

- **spec §2 処理フロー**: Phase0=Task2 / Phase1=Task2 / Phase2 ①②③=Task2・④=Task2・⑤=Task4・⑥=Task3 → 網羅。
- **spec §3 不変条件 11 件**: 1(event_id 冪等)=Task2②、 2(orphan failed)=Task2 Phase1、 3(全 rollback→failed 全件)=Task2 制約、 4(payload 順 fold)=Task1+Task2③、 5(answered_at sort しない)=全体ルール、 6(reviews 1 件 1 行)=Task1+Task2④、 7(study_days)=Task3、 8(now=answered_at)=Task1、 9(owner-scope)=全体ルール、 10(session tx 外)=Task2 Phase0、 11(client 非依存)=scope 外 → 網羅。
- **spec §4 実装メモ**: replayCard 抽出=Task1 / VALUES UPDATE + fallback=Task4 / Drizzle capability=Task4 / 1-session 関数化=Task2 → 網羅。
- **spec §5 テスト**: 純 replay=Task1 / bulk handler 各項=Task5 / 既存書換=Task5 → 網羅。
- **DRY**: submitReviewTx 撤去 (Task 2) により FSRS compute は `replayCard` の単一 source、 重複なし (旧「二重 guard で重複担保」案は撤回)。
- **placeholder scan**: TODO/TBD なし。 型名 (`replayCard` / `final` / `reviews` / `eventsToApply` / `insertedEventIds` / `consumedSet` / `processSession`) は Task 1↔2↔5 で一貫。
