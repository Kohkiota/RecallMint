# 問題 3 (bulk refactor) sync layer pre-investigation

日付: 2026-05-28
phase: pre-investigation (調査のみ、実装変更なし)
目的: server bulk endpoint を「per-event serial → 1 tx + in-memory FSRS replay」に
畳む refactor を設計する前提として、 sync layer 全体を end-to-end で精査し、 bulk 化
で壊してはいけない不変条件を確定する。

> 本 doc の所見は全て実コード行を引用する。 推測には「(推測)」と明記する。

## touch される file 一覧 (本 refactor の影響面)

| 層 | file | 役割 |
| --- | --- | --- |
| server route | `app/api/review-events/bulk/route.ts` | bulk receiver (本体改修対象) |
| server tx | `lib/cards/submit-review-tx.ts` | FSRS 1 件適用の純関数 (replay 化対象) |
| server action | `app/(app)/app/study/smart/_actions/submit-review.ts` | 旧単発経路 (現在 client 未使用、 submitReviewTx の別 caller) |
| schema | `lib/db/schema.ts` | answer_events / cards / reviews / study_days / study_sessions |
| client flush | `lib/sync/review-events.ts` | Dexie write + flush + in-flight guard |
| client schema | `lib/client-db.ts` | Dexie store 定義 + row 型 |
| client UI | `app/(app)/app/study/smart/_components/session-runner.tsx` | record トリガー / flush トリガー |
| 既存 bulk insert 前例 | `app/(app)/app/upload/_actions/process.ts:530-546` | OCR cards bulk INSERT + exam.card_count 同 tx |

検証 test (全 42 件 pass、 後述「実機検証」参照):
`lib/sync/review-events.test.ts` / `lib/cards/submit-review-tx.sequential.test.ts` /
`app/api/review-events/bulk/route.test.ts`

---

## 軸 1: server bulk route

### payload 形 (`route.ts:54-83`)

```ts
const sessionSchema = z.object({
  session_id: z.uuid(),
  exam_id: z.uuid().optional(),
  mode: z.enum(['smart', 'custom']),
  card_ids: z.array(z.uuid()),
  started_at: z.iso.datetime(),
  completed_at: z.iso.datetime().optional(),
  status: z.enum(['active', 'completed', 'abandoned']),
})
const eventSchema = z.object({
  event_id: z.uuid(),
  card_id: z.uuid(),
  selected_answer_ids: z.array(z.string()),
  is_correct: z.boolean(),
  answered_at: z.iso.datetime(),
  elapsed_ms: z.number().int().nonnegative().optional(),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
})
const payloadSchema = z.object({
  session: sessionSchema,
  events: z.array(eventSchema).max(1000),
})
```

- events 上限 1000 (`.max(1000)`)。 超過は 400 invalid_payload。
- `rating` 未指定時の derive は handler 側 (`route.ts:222`): `ev.rating ?? (ev.is_correct ? 3 : 1)`。

### tx 境界 — **session upsert は tx 外、 events は event ごと独立 tx** (request 全体 tx ではない)

session upsert は単発 statement (`route.ts:148-181`、 db.transaction の外):

```ts
await measure('session-upsert', async () => db
  .insert(studySessions)
  .values({ sessionId: session.session_id, userId: user.id, ... status: session.status })
  .onConflictDoUpdate({
    target: studySessions.sessionId,
    setWhere: eq(studySessions.userId, user.id),   // C-1 tenant 分離
    set: { completedAt: ..., status: session.status },  // I-1 card_ids は上書きしない
  }))
```

events ループは event ごとに `db.transaction()` を張る (`route.ts:195-229`):

```ts
for (const [i, ev] of events.entries()) {
  try {
    await measure(`event-${i}-tx`, async () => db.transaction(async (tx) => {
      const inserted = await ... tx.insert(answerEvents).values({...})
        .onConflictDoNothing({ target: answerEvents.eventId })
        .returning({ id: answerEvents.id })
      if (inserted.length === 0) return            // ← 重複は skip
      const rating: RatingInt = ev.rating ?? (ev.is_correct ? 3 : 1)
      await ... submitReviewTx(tx, { userId: user.id, cardId: ev.card_id, rating, now: new Date(ev.answered_at) }, ...)
    }))
  } catch (err) {
    failed.push(ev.event_id)                       // ← 個別失敗は他を巻き込まない
  }
}
```

→ **1 event = 1 transaction**。 answer_events INSERT と submitReviewTx (cards/reviews/
study_days) はその event tx 内で atomic。 event 間は別 tx。

### partial failure (`route.ts:230-242, 254`)

- 1 event の tx が throw → `failed[]` に event_id を積み、 ループ継続。
- 最終 `Response.json({ ok: true, failed }, { status: 200 })`。 **200 + failed 配列**で返す。
- session upsert 自体が throw → 500 `session_upsert_failed` (`route.ts:182-190`)、 events は未着手。

---

## 軸 2 【最重要】: submitReviewTx 本体 + 二重適用の現防御

### 二重適用の現防御 = answer_events UNIQUE + ON CONFLICT DO NOTHING + RETURNING 0 件 skip

**防御は submitReviewTx の中ではなく、 route の event tx の中にある。** `route.ts:201-217`:

```ts
const inserted = await ... tx
  .insert(answerEvents)
  .values({ eventId: ev.event_id, sessionId: ..., cardId: ev.card_id, userId: user.id, ... })
  .onConflictDoNothing({ target: answerEvents.eventId })
  .returning({ id: answerEvents.id })

// 重複 event_id (= 既に処理済 / 並列再送) は FSRS 再適用しない。
if (inserted.length === 0) return
```

裏付け:
- `answer_events.event_id` は **UNIQUE** (`schema.ts:563`): `eventId: uuid('event_id').notNull().unique()`。
- 同 event_id 再送 → ON CONFLICT DO NOTHING で INSERT が no-op → `returning()` が 0 行 →
  `if (inserted.length === 0) return` で submitReviewTx を呼ばずに event tx を抜ける。
- runtime 観測: `route.test.ts:355-368`「重複 event_id → FSRS 適用 skip、 200」が
  `submitReviewTxCalls` 0 件を assert (pass)。

→ **冪等性の単位は event_id。** retry で同一 event_id が再来しても FSRS 状態は二度動かない。
これは「event_id ごとに 1 回だけ FSRS 適用」を保証する。 別 event_id (= 再レート) は
別物として必ず適用される (軸 3 参照)。

### submitReviewTx の全 sub-op (`submit-review-tx.ts`)

| # | op | SQL 種別 | 行 |
| --- | --- | --- | --- |
| 1 | select-cards | owner-scoped SELECT (FSRS 列 + streak 列) | 51-71 |
| 2 | (in-memory) | DB row → ts-fsrs Card 変換 → `rate(fsrsCard, rating, now)` | 81-97 |
| 3 | update-cards | UPDATE cards SET (FSRS 全列 + answered + last_correct + current_streak) | 101-119 |
| 4 | insert-reviews | INSERT reviews (append-only) | 122-127 |
| 5 | select-distinct | raw `sql` COUNT(DISTINCT card_id) FROM reviews (当日 JST) | 135-139 |
| 6 | upsert-study-days | INSERT ... ON CONFLICT DO UPDATE study_days | 142-158 |

FSRS read→compute→write の核 (`submit-review-tx.ts:96-119`):

```ts
const result = rate(fsrsCard, rating, now)
const next = result.card                 // 更新後の Card state
const correct = rating >= 2
await ... tx.update(cards).set({
  due: next.due, stability: next.stability, difficulty: next.difficulty,
  elapsedDays: next.elapsed_days, scheduledDays: next.scheduled_days,
  learningSteps: next.learning_steps, reps: next.reps, lapses: next.lapses,
  state: next.state, lastReview: next.last_review ?? now,
  answered: true, lastCorrect: correct,
  currentStreak: correct ? card.currentStreak + 1 : 0,   // ← read 値 +1 / 0 リセット
}).where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
```

study_days upsert の増分式 (`submit-review-tx.ts:142-158`):

```ts
.values({ userId, day, reviewCount: 1, correctCount: correct ? 1 : 0, distinctCardCount: distinct })
.onConflictDoUpdate({ target: [studyDays.userId, studyDays.day], set: {
  reviewCount: sql`${studyDays.reviewCount} + 1`,                 // ← event 1 件で +1
  correctCount: sql`${studyDays.correctCount} + ${correct ? 1 : 0}`,
  distinctCardCount: distinct,                                    // ← 毎回 reviews 再集計で上書き
}})
```

### **状態依存性 (replay 化の核心)**

`rate()` は **stateful**: 各 rating は「現在の card 状態」から stability/difficulty/reps/
state を 1 段進める。 現 serial loop は event N で card を SELECT → UPDATE するため、
同 card の event N+1 は **N の UPDATE 結果を読む**。 つまり同一 card への複数 event は
「直列に畳まれた状態遷移」になる。

runtime 観測 (`submit-review-tx.sequential.test.ts`、 実 ts-fsrs で stateful tx mock):
- ケース A (`:113-156`): Hard→Good→Easy で `reps` が apply 数分 increment (`finalReps - initialReps === 3`)、
  `currentStreak` 0→1→2→3 単調増加、 各 due が各 now より将来。
- ケース B (`:161-203`): Good→Again→Good で streak 1→0→1、 `reps` は incorrect 含め 3 増加。

→ **「最後の rating だけ 1 回適用」では不正解。** 同 card に複数 event があるとき、
in-memory replay は event を順に畳み、 各 rate() の出力を次の入力に渡す必要がある。
reps / lapses / streak は適用回数に依存する。

---

## 軸 3 【最重要】: client flush — 再レート event の end-to-end ライフサイクル

### 再レートは「新規 event_id の別 row」として積まれる (上書きではない)

`recordAnswerEvent` は常に `.add()` で、 event_id 未指定なら `newId()` (= `crypto.randomUUID()`)
を採番する (`review-events.ts:32-34, 121-137`):

```ts
export function newId(): string { return crypto.randomUUID() }
...
export async function recordAnswerEvent(input: RecordAnswerEventInput): Promise<ClientAnswerEvent> {
  const row: ClientAnswerEvent = {
    event_id: input.event_id ?? newId(),   // ← 未指定なら毎回新規採番
    ...
    answered_at: input.answered_at ?? new Date().toISOString(),
    sync_status: 'pending',
  }
  await getClientDb().answer_events.add(row)   // ← update でなく add (新 row)
  return row
}
```

UI 側で再レートが record を再発火する経路 (`session-runner.tsx:242-304`、 `runSubmit`):

```ts
const isFirstSubmit = !submittedCardIds.has(cardId)   // ← tally 二重加算防止用
...
if (isFirstSubmit) { setTally(...); setSubmittedCardIds(...) }
setLastRating(rating)
onAfter()
void (async () => {
  try {
    await recordAnswerEvent({ session_id: sessionId, card_id: cardId, ..., rating })  // ← isFirstSubmit gate の外
    const pending = await countPendingAnswerEvents(sessionId)
    if (pending >= FLUSH_THRESHOLD) { await flushPendingEvents(sessionId) }
  } catch {}
})()
```

**`recordAnswerEvent` は `isFirstSubmit` gate の外にある** (`:278-287`)。 よって リトライ
(`handleRetry` → 再回答 → 「次へ」) や 前へ戻り後の再回答で `runSubmit` が再実行されると、
tally は据え置き (`isFirstSubmit === false`) だが **answer_events には新 event_id の row が必ず増える**。

註: 同一 card 表示中の rate 連打は record しない。 FSRS モードの `handleRateFsrs`
(`:337-354`) は state 更新のみで Dexie write せず、 実 record は judged+rated の「次へ」/
「前へ」で 1 件発火 (rate-then-confirm)。 → 連打 = last write wins (1 件)、 再回答 (リトライ/
前へ) = 別 event (複数件)。

### threshold カウントへの影響 (`review-events.ts:139-163`)

```ts
export async function getPendingAnswerEvents(sessionId?: string): Promise<ClientAnswerEvent[]> {
  const collection = getClientDb().answer_events.where('sync_status').equals('pending')
  const rows = await collection.toArray()
  return sessionId === undefined ? rows : rows.filter((r) => r.session_id === sessionId)
}
export async function countPendingAnswerEvents(sessionId?: string): Promise<number> {
  return (await getPendingAnswerEvents(sessionId)).length
}
```

→ 再レートで増えた row も pending として数えられ、 `FLUSH_THRESHOLD = 5`
(`session-runner.tsx:76`) のカウントに寄与する。

### in-flight guard は event_id 粒度 (`review-events.ts:182, 260-279, 341-346`)

```ts
export const inFlightEventIds = new Set<string>()
...
const targets = pendingAll.filter((e) => !inFlightEventIds.has(e.event_id))   // event_id 単位除外
if (pendingAll.length > 0 && targets.length === 0) { return {... attempted: 0 ...} }
for (const e of targets) { inFlightEventIds.add(e.event_id) }                 // 掴む
try { ... POST ... } finally {
  for (const e of targets) { inFlightEventIds.delete(e.event_id) }            // 必ず解放
}
```

→ 再レートで増えた新 event_id は別 target として扱われ、 in-flight 中でも次回 flush で
再 pickup される。 経路 1 (threshold flush) と経路 2 (`flushAllPendingEvents` → session 別
`flushPendingEvents`) は同じ `inFlightEventIds` Set を共有するため、 同 event_id の二重送信を
排除する。

runtime 観測 (`review-events.test.ts:496-692`):
- (a) 同 session 2nd invoke は in-flight 中なら POST skip (`skipClient.calls` 0 件)。
- (b) 別 session は互いにブロックしない (各 1 POST)。
- (c) POST reject でも finally で Set から除去、 再 pickup 可。
- (d) 部分 in-flight: event [1..3] を Set に seed → flush は [4..5] のみ送信、 [1..3] は据え置き。

### 戻り順は **answered_at 明示 sort ではなく Dexie index 順 (= local_id 昇順)**

`getPendingAnswerEvents` は `.where('sync_status').equals('pending').toArray()` で取得し、
**answered_at による orderBy を一切持たない** (grep 確認: `lib/sync` に orderBy/sort なし)。
Dexie の secondary-index `.equals()` は同値 entry を PK (= `++local_id` auto-increment) 昇順
で返すため、 挿入順 = local_id 昇順 = (通常 clock 単調なら) answered_at 昇順。

runtime 観測 (`review-events.test.ts:157-242`「戻り順保証」): 同一 card に t1<t2<t3 で 3 件
record → 戻り配列が ev1,ev2,ev3 順、 `local_id` 厳密昇順、 `answered_at` も昇順を assert (pass)。

→ **replay 順序の真実 source は payload 配列順 (= client の local_id 昇順)。** server は
answered_at で sort し直していない (軸 6 参照)。

---

## 軸 4: DB schema (`lib/db/schema.ts`)

### answer_events (`:559-593`)

```ts
export const answerEvents = pgTable('answer_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().unique(),                         // ← 冪等化キー (UNIQUE)
  sessionId: uuid('session_id').references(() => studySessions.sessionId, { onDelete: 'set null' }),
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  selectedAnswerIds: jsonb('selected_answer_ids').notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
  isCorrect: boolean('is_correct').notNull(),
  answeredAt: timestamp('answered_at', { withTimezone: true }).notNull(),
  elapsedMs: integer('elapsed_ms'),
  syncStatus: text('sync_status').$type<'synced'>().notNull().default('synced'),  // server 側は 'synced' 固定
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('answer_events_user_idx').on(t.userId, t.answeredAt),
  index('answer_events_card_idx').on(t.cardId, t.answeredAt),
  index('answer_events_session_idx').on(t.sessionId),
])
```

註: payload には `rating` があるが answer_events table には rating 列がない。 rating は
submitReviewTx 経由で reviews 表にのみ残る (answer_events は選択肢生ログ)。

### cards FSRS 列 (`:247-326` 抜粋)

```ts
answered: boolean('answered').notNull().default(false),
lastCorrect: boolean('last_correct'),                  // NULL = 未回答
currentStreak: integer('current_streak').notNull().default(0),
due: timestamp('due', { withTimezone: true }).notNull().defaultNow(),
stability: real('stability').notNull().default(0),
difficulty: real('difficulty').notNull().default(0),
elapsedDays: integer('elapsed_days').notNull().default(0),
scheduledDays: integer('scheduled_days').notNull().default(0),
reps: integer('reps').notNull().default(0),
lapses: integer('lapses').notNull().default(0),
state: integer('state').$type<0|1|2|3>().notNull().default(0),
learningSteps: integer('learning_steps').notNull().default(0),
lastReview: timestamp('last_review', { withTimezone: true }),
```

owner-scope index: `cards_due_idx` on `(userId, due)` (`:317`)。 bulk UPDATE で id IN (...)
を引く場合 PK 直引きで十分。

### reviews (append-only, `:116-136`)

```ts
id: uuid('id').primaryKey().defaultRandom(),
userId / cardId (FK cascade),
rating: integer('rating').$type<1|2|3|4>().notNull(),
reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
// index: (user_id, reviewed_at) / (card_id, reviewed_at)
```

→ event 1 件 = reviews 1 行。 N events = N 行 (UNIQUE 制約なし、 純 append)。

### study_days (複合 PK, `:439-451`)

```ts
{ userId (FK cascade), day: date('day', {mode:'string'}), reviewCount, correctCount, distinctCardCount }
primaryKey({ columns: [t.userId, t.day] })
```

### study_sessions (`:516-551`)

```ts
sessionId: uuid('session_id').primaryKey(),     // client uuidv4 採番
userId (FK cascade), examId (FK set null), mode, cardIds: jsonb, query: jsonb,
startedAt (notNull), completedAt, status: 'active'|'completed'|'abandoned',
createdAt, updatedAt ($onUpdate)
```

bulk で touch する table: study_sessions (upsert) / answer_events (insert) / cards (update) /
reviews (insert) / study_days (upsert)。

---

## 軸 5: IDB (Dexie) schema (`lib/client-db.ts:187-204`)

```ts
this.version(1).stores({
  exams: 'id, user_id, updated_at, content_version',
  cards: 'id, exam_id, user_id, due, updated_at, content_version, sync_status',
  user_settings: 'user_id',
  study_sessions: 'session_id, exam_id, mode, status, sync_status',
  answer_events: '++local_id, event_id, session_id, card_id, sync_status',   // ← PK=local_id auto-inc
  card_mutations: '++local_id, mutation_id, card_id, sync_status',
  sync_meta: 'key',
})
this.version(2).stores({ study_days: '[user_id+day], user_id, day' })
```

answer_events outbox の所見:
- PK = `++local_id` (auto-increment)。 `event_id` は **index だが UNIQUE ではない**
  (`&event_id` ではない)。 → Dexie は event_id 一意性を強制しない。 server 側 (answer_events.eventId
  UNIQUE) が冪等化を担保。 再レートは新 event_id を生むため衝突しない。
- `sync_status` は index 列。 `synced_at` 列は **存在しない** (型 `ClientAnswerEvent`
  `:128-140` に sync 時刻列なし、 `last_attempted_at?` は型にあるが書き込みコードなし)。
  sync 化は `markAnswerEventsSynced` (`review-events.ts:165-171`) が `sync_status: 'synced'` に
  modify するのみ。
- event_id 生成箇所: `newId()` (`review-events.ts:32-34`)。 再レートで row が「増える」
  (上書きではない) — 軸 3 参照。

session store: `study_sessions` PK = `session_id` (string)。 cards mirror: `cards` PK = `id`。
study_days mirror (v2): 複合 PK `[user_id+day]`、 server PK 構造と一致。

---

## 軸 6: contract / 結合点

### client が入れる項目 vs server が導出する項目

| 項目 | client (payload) | server 導出 |
| --- | --- | --- |
| session.* | client が真実 source (`review-events.ts:282-291`) | upsert で受領、 updated_at は $onUpdate |
| event.event_id / card_id / selected_answer_ids / is_correct / answered_at / elapsed_ms / rating | client (`:294-302`) | — |
| answer_events.user_id | — | server (`route.ts:206` user.id) |
| answer_events.session_id | — | server (`route.ts:204` payload session.session_id) |
| FSRS rating (未指定時) | optional | server derive `is_correct ? 3 : 1` (`route.ts:222`) |
| cards FSRS 次状態 / reviews 行 / study_days 集計 | — | server (submitReviewTx) |

→ client は「何が起きたか (生ログ + rating)」を送り、 server が「FSRS 状態遷移」を導出する。
この境界は refactor 後も維持すべき。

### answered_at 昇順保証がどこで担保されるか

**明示的な sort はどこにもない。** 担保は 2 段の暗黙順序:
1. client: `getPendingAnswerEvents` が Dexie index 順 = local_id 昇順で返す (軸 3)、 payload の
   `targets.map(...)` (`review-events.ts:294`) がその順序を保持。
2. server: `for (const [i, ev] of events.entries())` (`route.ts:195`) が payload 配列順で
   submitReviewTx を呼ぶ。 **server は answered_at で並べ替えない。**

runtime 観測 (`route.test.ts:483-537` F3): 同 card を t1,t3、 別 card を t2 に挟んだ 3 event で
submitReviewTx が配列順 (t1→t2→t3) に呼ばれることを assert (pass)。

→ refactor 後の in-memory replay は **payload 配列順で畳む**こと。 もし「server 側で
answered_at sort」に変えるなら client/server の前提が一致するか要確認 (現状は配列順信頼)。

### 問題 2 の in-flight guard が server 側挙動に影響しないこと

`inFlightEventIds` は client module scope の Set (`review-events.ts:179-182`、 IDB 非保存)。
server は payload しか見ず、 in-flight 概念を持たない。 同 event_id が万一二重 POST されても、
server は answer_events UNIQUE + ON CONFLICT DO NOTHING で 2 回目を FSRS skip する (軸 2)。
→ in-flight guard は client 側最適化、 server idempotency が最終防壁。 独立。

---

## 軸 7: Drizzle capability (drizzle-orm 0.45.2)

確認: `package.json` `"drizzle-orm": "^0.45.2"` / 実体 `node_modules/.../package.json` = `0.45.2`。

- **bulk INSERT**: native 対応。 前例 `process.ts:531-534`:
  ```ts
  const inserted = await tx.insert(cards).values(cardRows).returning({ id: cards.id, title: cards.title })
  ```
  → reviews の N 行 bulk insert / answer_events bulk insert は `.values(array)` で書ける。
- **INSERT ... ON CONFLICT DO NOTHING ... RETURNING**: 対応 (route.ts で使用中)。 batch insert +
  returning で「実際に insert された event_id 集合」を取得し、 その分だけ FSRS 適用、 という
  冪等化を 1 statement に畳める。
- **UPDATE ... FROM (subquery)**: `PgUpdate.from(source)` が存在
  (`node_modules/drizzle-orm/pg-core/query-builders/update.js:52-60`)、 source に Subquery を
  受ける (`getTableLikeFields` が `is(table, Subquery)` を分岐, `:64-65`)。 → `UPDATE cards SET ...
  FROM (subquery) WHERE ...` は書ける。
- **VALUES tuple list の first-class builder は無い**。 per-row 異なる値で 1 文 bulk UPDATE
  (`UPDATE cards ... FROM (VALUES (id1,stab1,...),(id2,...)) AS v(...)`) を書くには **`sql` raw で
  VALUES 句を組む**必要がある (型キャスト `::uuid` / `::real` / `::int` を tuple 内に明示)。
- 退避案: 1 tx 内で **card ごとに個別 UPDATE を N 回**発行 (現状 submitReviewTx の update-cards を
  card 単位に集約) でも「1 tx」目標は満たせる (round trip は N、 ただし serial loop の
  per-event tx commit N 回は消える)。 raw `sql` VALUES は最適化として後段で検討可。

---

## 実機検証 (runtime-observed evidence)

### 状況と判断

local dev server 未起動 / repo に stg URL 記載なし (`.env.local` の NEXT_PUBLIC_APP_URL は
localhost) / smart 復習の browser 検証には Clerk auth + seed 済 cards + 実 bulk endpoint への
書き込み (DB 副作用) が必要。 → 「Dexie に別 row が増えるか」「payload に別 event が乗るか」
「経路 1↔2 の event_id 単位 dedup」は **既存 test が fake-indexeddb (実 Dexie) + 実 route
制御フローで決定的に observe 済**のため、 これを観測値として採用した (browser での手動 IDB
dump / Network dump はこれらの確認的再現にすぎない)。

### 観測結果 (`npx vitest run` 3 file = 42 tests pass)

```
Test Files  3 passed (3)
      Tests  42 passed (42)
```

| 検証項目 | observe した test | 結果 |
| --- | --- | --- |
| 同 card 再レートで event_id 別 row が増える | review-events.test.ts:157-211 (3 件別 row, local_id 厳密昇順) | ✅ |
| 戻り順 = 投入順 = local_id 昇順 = answered_at 昇順 | review-events.test.ts:162-210 | ✅ |
| 各 event が payload に別 entry として乗る | review-events.test.ts:319-327 / 441-481 | ✅ |
| 経路 1↔2 dedup が event_id 単位 | review-events.test.ts:496-692 (a)-(d) | ✅ |
| server が payload 配列順で apply (同 card 複数) | route.test.ts:483-537 (F3) | ✅ |
| 二重適用防御 (重複 event_id → FSRS skip) | route.test.ts:355-368 | ✅ |
| 同 card 順次 apply の FSRS 累積 (reps/streak) | submit-review-tx.sequential.test.ts 全 | ✅ |
| partial failure 隔離 (1 bad card → failed[] のみ) | route.test.ts:370-404 | ✅ |

### 残存 OT-dependency (browser でしか採れない確認)

以下は code + test で決定的に確定済だが、 厳密な end-to-end 物証 (実 IndexedDB dump / 実
Network payload / 実並走 flush タイミング) が要れば OT 環境での実走が必要:
- 確認 URL: stg deployment (URL 未共有) の `/app/study/smart`
- 手順: FSRS モードで 1 card を回答 → リトライ → 再回答 → 「次へ」を threshold 件数分
- 期待: IndexedDB `recallmint.answer_events` に再レート分が別 local_id/event_id で増、
  bulk POST payload.events に別 event_id、 POST 回数と event_id 集合が in-flight dedup と一致
- mobile 要否: 不要 (挙動は viewport 非依存)

---

## bulk 化で壊してはいけない不変条件 (まとめ)

1. **冪等性の単位は event_id**。 同一 event_id の再送は FSRS を二度適用しない。
   現実装は `answer_events.event_id` UNIQUE + ON CONFLICT DO NOTHING + RETURNING 0 件 →
   submitReviewTx skip。 refactor 後も「実際に新規 insert された event_id の分だけ FSRS 適用」を
   担保すること (batch INSERT ... ON CONFLICT DO NOTHING RETURNING の戻り集合で gating)。

2. **同一 card への複数 event は payload 配列順で直列に畳む**。 `rate()` は stateful で
   reps/lapses/state/streak/stability が適用回数と順序に依存する。 「最後の rating を 1 回
   適用」は誤り。 in-memory replay は card ごとに event を順に fold し、 各 rate() の出力を
   次の入力にすること。

3. **replay 順 = payload 配列順 (= client local_id 昇順)**。 server は answered_at で sort し
   直していない。 in-memory 化で card ごとに group するなら、 group 内の event 順を payload
   配列順のまま保つこと (answered_at 再 sort に変えるなら client 前提との一致を別途確認)。

4. **reviews は event 1 件 = 1 行の append**。 N events → N reviews 行。 UNIQUE 制約なし。
   bulk 化でも「適用された event 数 = insert する reviews 行数」を保つこと。

5. **study_days.reviewCount は適用 event 数だけ増える** (`+1` per event)、 correctCount は
   correct event 数だけ増える、 distinctCardCount は当日 reviews の DISTINCT card_id 再集計。
   1 tx に畳むなら、 全 reviews insert 後に distinct を 1 回再集計 → 最終値は現実装と一致するが、
   reviewCount/correctCount の増分は「適用 event 数 / correct 数」を正確に積むこと
   (重複 skip した event はカウントしない)。

6. **currentStreak は『その card の最終 event』の correct 連鎖で決まる**。 card ごとに event を
   順に畳んだ結果 (correct 連続で +1、 incorrect で 0) を書く。 replay 中に逐次更新すること。

7. **partial failure 隔離**: 1 event (例: card 削除済) の失敗が他 event を巻き込まない。
   現実装は per-event tx で隔離 + `failed[]` 返却。 **1 tx 化すると 1 件の失敗で全 rollback** に
   なり semantics が変わる。 refactor では (a) bad event を事前に弾いて残りを 1 tx で適用し
   failed[] を維持するか、 (b) 全失敗許容に倒すか、 を OT と決める要あり。 client は
   `response.body.failed` を見て該当 event のみ pending 維持 (`review-events.ts:318-332`) する
   ため、 **`{ ok: true, failed: string[] }` の応答契約は維持必須**。

8. **session upsert の不変条件**: tenant 分離 `setWhere = user_id` (cross-tenant write 防止) /
   `card_ids` は initial insert のみで conflict 上書きしない / status・completed_at は最新値で
   上書き。 session upsert 失敗は 500 (events 未処理)。 これらを維持。

9. **応答契約 `200 + { ok: true, failed: [] }`**。 client の sync_status 遷移
   (failed event のみ pending 維持、 全成功で session を synced) がこの形に依存
   (`review-events.ts:306-332`)。 status code / body 形を変えないこと。

10. **owner-scope (user_id) 絞り込み**を全 SQL で維持 (CLAUDE.md Clerk 4)。 select-cards /
    update-cards は `WHERE id = ? AND user_id = ?`、 reviews/study_days/answer_events も user_id 付き。

11. **in-flight guard / client 側は触らない前提**: server idempotency が最終防壁。 server は
    payload のみで完結し、 client の in-flight Set に依存しない (軸 6)。 この独立性を崩さない。
