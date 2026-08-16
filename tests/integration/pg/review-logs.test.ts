// R0 (ReviewLog 持続化) Task 4: review_logs ingest の behavioral 実証。
//
// 実 PG でしか出ない性質だけをここに置く: 適用 1 event → 実 DB 行のちょうど 1 行 +
// 17 列写像 / 冪等再送での行数不変 / applied=false 3 経路での log 0 行 / 同一 tx 内
// 複数 event の before/after 連鎖 / 表の schema contract(PK+FK2+CHECK3)/ 失敗注入時の
// tx 全体 rollback / DB 複合 FK を張らない代わりの帰属整合 2 保証。純関数の fold 規則
// (planFold / foldSession の適用判定・skip 分類・appliedLogs 契約)は unit 側
// (session-aggregate.test.ts)の担当で、ここでは重複させない。
//
// 刺激 = processAnswerEvents (内部で withTenantTx = app role + tenant context)。
// 観測 = owner 接続 (getFixtureOwnerDb / RLS bypass)。作法は
// answer-events-serialization.test.ts と同型 (H1 規約: afterAll で closeDb() +
// closeFixtureOwnerDb()、truncate→reseed の beforeEach)。
//
// ①(全 17 列写像)の「before/after」ground truth は、production と同じ純関数
// (`replayCard`)を同じ入力(実際に seed された cards 行)で直接呼んで得る。FSRS の
// 数値そのものの正しさは ts-fsrs 自体 + unit 側が担保済みで、ここでの主張は
// 「production の tx が書き込んだ行が、同一入力での純関数の出力と一致する」
// (= 永続化パイプラインが値を落とさず・歪めずに運ぶ)という写像の主張に限る。
import { randomUUID } from 'node:crypto'

import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { replayCard, type ReplayCardState } from '@/lib/cards/replay-card'
import { closeDb } from '@/lib/db'
import { answerEvents, cards, reviewLogs, studyDays, type User } from '@/lib/db/schema'
import { processAnswerEvents } from '@/lib/reviews/ingest-review-events'
import type { AnswerEventWire } from '@/lib/sync/shared/answer-event-schema'

import {
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
  type TenantFixture,
} from './setup/fixture'

// fixture が seed 済みの day (2026-07-18) を避けた test 用の時刻 (answer-events-
// serialization.test.ts と同じ回避理由)。
const RECEIVED_AT = new Date('2026-10-01T00:00:00.000Z')
const T1 = new Date('2026-08-20T01:00:00.000Z')
const T2 = new Date('2026-08-20T02:00:00.000Z')
const T3 = new Date('2026-08-20T03:00:00.000Z')
const SESSION_ID = '33333333-3333-4333-a333-333333333333'

let fixture: TenantFixture
let userA: User

beforeEach(async () => {
  await truncateAllUserTables()
  fixture = await seedTwoTenants()
  userA = { id: fixture.a.userId } as User
})

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEvent(
  cardId: string,
  answeredAt: Date,
  overrides: Partial<AnswerEventWire> = {},
): AnswerEventWire {
  return {
    event_id: randomUUID(),
    card_id: cardId,
    session_id: SESSION_ID,
    selected_answer_ids: ['a'],
    is_correct: true,
    rating: 3,
    answered_at: answeredAt.toISOString(),
    ...overrides,
  }
}

function readCard(cardId: string) {
  return getFixtureOwnerDb()
    .select()
    .from(cards)
    .where(eq(cards.id, cardId))
    .then((rows) => rows[0]!)
}

function readEvent(eventId: string) {
  return getFixtureOwnerDb()
    .select()
    .from(answerEvents)
    .where(eq(answerEvents.eventId, eventId))
    .then((rows) => rows[0] ?? null)
}

function readStudyDays(userId: string) {
  return getFixtureOwnerDb()
    .select()
    .from(studyDays)
    .where(eq(studyDays.userId, userId))
    .orderBy(studyDays.day)
}

function readReviewLog(eventId: string) {
  return getFixtureOwnerDb()
    .select()
    .from(reviewLogs)
    .where(eq(reviewLogs.eventId, eventId))
    .then((rows) => rows[0] ?? null)
}

function readReviewLogsByEventIds(eventIds: string[]) {
  return getFixtureOwnerDb()
    .select()
    .from(reviewLogs)
    .where(inArray(reviewLogs.eventId, eventIds))
}

async function countReviewLogsFor(eventId: string): Promise<number> {
  return (await readReviewLogsByEventIds([eventId])).length
}

async function countAllReviewLogs(): Promise<number> {
  const rows = await getFixtureOwnerDb().select({ eventId: reviewLogs.eventId }).from(reviewLogs)
  return rows.length
}

// cards 行 (readCard の戻り値) のうち replayCard が要求する部分集合を取り出す。
function toReplayState(card: {
  due: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  reps: number
  lapses: number
  state: 0 | 1 | 2 | 3
  learningSteps: number
  lastReview: Date | null
  answered: boolean
  lastCorrect: boolean | null
  currentStreak: number
}): ReplayCardState {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsedDays,
    scheduledDays: card.scheduledDays,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    learningSteps: card.learningSteps,
    lastReview: card.lastReview,
    answered: card.answered,
    lastCorrect: card.lastCorrect,
    currentStreak: card.currentStreak,
  }
}

// ---------------------------------------------------------------------------
// ① 適用 1 event = log ちょうど 1 行 + 全 17 列の写像 (spec §3.1 / §11-1)
// ---------------------------------------------------------------------------

// fix round 1 / Important #1: 新規 card + Good 1 回目だと stability/difficulty/
// elapsed_days/last_elapsed_days/scheduled_days/learning_steps の 6 列が全て 0 に
// 揃い、production の手書き写像ブロック (ingest-review-events.ts) がこの 6 列内で
// 隣接フィールドを取り違えても (例 stabilityBefore↔difficultyBefore、
// elapsedDays↔scheduledDays) 両辺 0 == 0 で test が素通りする (reviewer 実測)。
// これを避けるため、card を「既に 1 回 review 済みで数日空いた」状態に明示 seed し、
// 6 列を互いに区別可能な非ゼロ値にする (ts-fsrs の rate() は log.state/stability/
// difficulty/scheduled_days/learning_steps を入力 Card の値をそのまま verbatim
// コピーする — buildLog() 実装 (ts-fsrs dist/index.cjs) で実測確認済み。elapsed_days
// のみ (answeredAt - card.last_review) の日数差から都度再計算される)。
const SEEDED_LAST_REVIEW = new Date('2026-08-10T00:00:00.000Z')
const SEEDED_DUE = new Date('2026-08-31T00:00:00.000Z')
const ITEM1_ANSWERED_AT = new Date('2026-08-25T00:00:00.000Z') // lastReview + 15日

describe('① 適用 1 event の永続化 (17 列写像)', () => {
  it('ちょうど 1 行、かつ before/rate 出力/after/review/created_at/帰属列が全て一致する', async () => {
    // 「既に 1 回 review 済みで数日空いた」card 状態を明示 seed する (退化 0 回避)。
    await getFixtureOwnerDb()
      .update(cards)
      .set({
        state: 2,
        due: SEEDED_DUE,
        stability: 12.34,
        difficulty: 5.67,
        elapsedDays: 9,
        scheduledDays: 21,
        learningSteps: 3,
        reps: 3,
        lapses: 0,
        lastReview: SEEDED_LAST_REVIEW,
        answered: true,
        lastCorrect: true,
        currentStreak: 2,
      })
      .where(eq(cards.id, fixture.a.cardId))

    const beforeCard = await readCard(fixture.a.cardId)
    const initial = toReplayState(beforeCard)
    const totalBefore = await countAllReviewLogs()

    const ev = makeEvent(fixture.a.cardId, ITEM1_ANSWERED_AT, { rating: 3, is_correct: true })
    const res = await processAnswerEvents(userA, [ev], RECEIVED_AT)
    expect(res.failed).toEqual([])

    const totalAfter = await countAllReviewLogs()
    expect(totalAfter - totalBefore).toBe(1)

    const rows = await readReviewLogsByEventIds([ev.event_id])
    expect(rows).toHaveLength(1)
    const row = rows[0]!

    const appliedEvent = (await readEvent(ev.event_id))!
    expect(appliedEvent.applied).toBe(true)

    // 帰属 3 列 = event 値。
    expect(row.eventId).toBe(ev.event_id)
    expect(row.userId).toBe(fixture.a.userId)
    expect(row.cardId).toBe(fixture.a.cardId)
    expect(row.rating).toBe(3)

    // production と同じ純関数を同じ入力で呼んだ ground truth (before/after 双方の
    // 比較元として使う)。
    const { logs, state: afterState } = replayCard(initial, [
      { rating: 3, isCorrect: true, answeredAt: appliedEvent.answeredAt },
    ])
    const expectedLog = logs[0]!

    // before 4 値 = seed した cards 値。state/stability/difficulty は card の値を
    // verbatim コピーするため initial と直接比較する。due だけは ts-fsrs の
    // buildLog() 実装が `last_review || due` を返す仕様(last_review 設定時は
    // last_review を優先する)ため、initial.due でなく expectedLog.due と比較する
    // (lastReview が null だった旧シナリオでは due = card.due に一致していたため
    // この差異が隠れていた)。
    expect(row.stateBefore).toBe(initial.state)
    expect(row.dueBefore.getTime()).toBe(expectedLog.due.getTime())
    expect(row.stabilityBefore).toBe(initial.stability)
    expect(row.difficultyBefore).toBe(initial.difficulty)

    // deprecated 2 列 + scheduled_days + learning_steps = rate() 出力。
    expect(row.elapsedDays).toBe(expectedLog.elapsed_days)
    expect(row.lastElapsedDays).toBe(expectedLog.last_elapsed_days)
    expect(row.scheduledDays).toBe(expectedLog.scheduled_days)
    expect(row.learningSteps).toBe(expectedLog.learning_steps)

    // 非退化ガード (fix round 1 / Important #1): 上記 6 列が互いに異なる値であること
    // を明示 assert する。seed が将来 initialFsrsState 相当に戻る等で退化したら、
    // ここで先に fail して気付けるようにする (隣接列入替を素通りさせない検出力の保証)。
    const sixCols = [
      row.stabilityBefore,
      row.difficultyBefore,
      row.elapsedDays,
      row.lastElapsedDays,
      row.scheduledDays,
      row.learningSteps,
    ]
    expect(new Set(sixCols).size, '6 列は互いに異なる値であること (非退化)').toBe(
      sixCols.length,
    )
    expect(row.elapsedDays).not.toBe(0)
    expect(row.lastElapsedDays).not.toBe(0)
    expect(row.scheduledDays).not.toBe(0)
    expect(row.learningSteps).not.toBe(0)
    expect(row.stabilityBefore).not.toBe(row.difficultyBefore)

    // review = clamp 済 answered_at (answer_events.answered_at が権威的な clamp 結果)。
    expect(row.review.getTime()).toBe(appliedEvent.answeredAt.getTime())

    // after 3 値 = 適用後 cards 行 (= 同じ純関数呼出しの戻り state)。
    expect(row.stateAfter).toBe(afterState.state)
    expect(row.stabilityAfter).toBe(afterState.stability)
    expect(row.difficultyAfter).toBe(afterState.difficulty)

    // created_at = answer_events.created_at と同一時刻源。
    expect(row.createdAt.getTime()).toBe(appliedEvent.createdAt.getTime())
  })
})

// ---------------------------------------------------------------------------
// ② 冪等: 同一 payload 再送 → 行数不変 (spec §4 / §11-2)
// ---------------------------------------------------------------------------

describe('② 冪等: 同一 payload 再送', () => {
  it('行数が不変 (23505 も発火しない)', async () => {
    const ev = makeEvent(fixture.a.cardId, T1)

    const res1 = await processAnswerEvents(userA, [ev], RECEIVED_AT)
    expect(res1.failed).toEqual([])
    expect(await countReviewLogsFor(ev.event_id)).toBe(1)

    const laterReceivedAt = new Date(RECEIVED_AT.getTime() + 3_600_000)
    const res2 = await processAnswerEvents(userA, [ev], laterReceivedAt)
    expect(res2.failed).toEqual([])
    expect(await countReviewLogsFor(ev.event_id)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ③ applied=false の 3 経路 → log 0 行 (spec §2 / §11-3)
// ---------------------------------------------------------------------------

describe('③ applied=false の 3 経路 → log 0 行', () => {
  it('(a) card_not_locked: card 不在 event', async () => {
    const ghostCardId = randomUUID()
    const ev = makeEvent(ghostCardId, T1)

    const res = await processAnswerEvents(userA, [ev], RECEIVED_AT)

    expect(res.failed).toEqual([])
    expect((await readEvent(ev.event_id))!.applied).toBe(false)
    expect(await countReviewLogsFor(ev.event_id)).toBe(0)
  })

  it('(b) unknown_option: card の options に無い id を選択', async () => {
    const ev = makeEvent(fixture.a.cardId, T1, { selected_answer_ids: ['does-not-exist'] })

    const res = await processAnswerEvents(userA, [ev], RECEIVED_AT)

    expect(res.failed).toEqual([])
    expect((await readEvent(ev.event_id))!.applied).toBe(false)
    expect(await countReviewLogsFor(ev.event_id)).toBe(0)
  })

  it('(c) 順序ガード skip: 適用済み card への厳密に古い event の遅着', async () => {
    await processAnswerEvents(userA, [makeEvent(fixture.a.cardId, T2)], RECEIVED_AT)
    const stale = makeEvent(fixture.a.cardId, T1)

    const res = await processAnswerEvents(userA, [stale], RECEIVED_AT)

    expect(res.failed).toEqual([])
    expect((await readEvent(stale.event_id))!.applied).toBe(false)
    expect(await countReviewLogsFor(stale.event_id)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ④ 同 card 複数 event 1 payload → event ごと 1 行 + before/after 連鎖 (spec §11-4)
// ---------------------------------------------------------------------------

describe('④ 同 card 複数 event の連鎖', () => {
  it('event ごとに 1 行、row n の after = row n+1 の before', async () => {
    const e1 = makeEvent(fixture.a.cardId, T1, { rating: 3 })
    const e2 = makeEvent(fixture.a.cardId, T2, { rating: 1 })
    const e3 = makeEvent(fixture.a.cardId, T3, { rating: 4 })

    // payload 順をあえて時系列と変える (per-card sort が効くことの副次確認)。
    const res = await processAnswerEvents(userA, [e3, e1, e2], RECEIVED_AT)
    expect(res.failed).toEqual([])

    const eventIds = [e1.event_id, e2.event_id, e3.event_id]
    const rowsByEventId = new Map(
      (await readReviewLogsByEventIds(eventIds)).map((r) => [r.eventId, r]),
    )
    expect(rowsByEventId.size).toBe(3)
    const [r1, r2, r3] = eventIds.map((id) => rowsByEventId.get(id)!)

    expect(r1!.stateAfter).toBe(r2!.stateBefore)
    expect(r1!.stabilityAfter).toBe(r2!.stabilityBefore)
    expect(r1!.difficultyAfter).toBe(r2!.difficultyBefore)

    expect(r2!.stateAfter).toBe(r3!.stateBefore)
    expect(r2!.stabilityAfter).toBe(r3!.stabilityBefore)
    expect(r2!.difficultyAfter).toBe(r3!.difficultyBefore)
  })
})

// ---------------------------------------------------------------------------
// ⑤ schema contract readback (spec §11-5)
// ---------------------------------------------------------------------------

describe('⑤ schema contract: review_logs を実 PG から readback', () => {
  it('制約は PK(event_id) + FK 2 本(CASCADE) + CHECK 3 本で、定義文まで一致する', async () => {
    // contype を p/f/c に絞る: PG18 は NOT NULL を pg_constraint(contype='n') にも
    // 記録するため、絞らないと PG bump だけで偽 red になる (answer-events-
    // serialization.test.ts と同じ注意書き。devcontainer は PG17.10)。
    const rows = await getFixtureOwnerDb().execute<{
      conname: string
      contype: string
      def: string
    }>(sql`
      SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'review_logs'::regclass AND contype IN ('p', 'f', 'c')
      ORDER BY conname
    `)

    // 名前だけでなく定義文まで pin する — 名前を保ったまま述語が緩む書き換え
    // (例 state_after の上限が消える) を名前集合では検出できないため。
    expect(rows.map((r) => [r.conname, r.def])).toEqual([
      [
        'review_logs_event_id_answer_events_event_id_fk',
        'FOREIGN KEY (event_id) REFERENCES answer_events(event_id) ON DELETE CASCADE',
      ],
      ['review_logs_pkey', 'PRIMARY KEY (event_id)'],
      ['review_logs_rating_range', 'CHECK (((rating >= 1) AND (rating <= 4)))'],
      [
        'review_logs_state_after_range',
        'CHECK (((state_after >= 0) AND (state_after <= 3)))',
      ],
      [
        'review_logs_state_before_range',
        'CHECK (((state_before >= 0) AND (state_before <= 3)))',
      ],
      [
        'review_logs_user_id_users_id_fk',
        'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      ],
    ])
    expect(rows.filter((r) => r.contype === 'f')).toHaveLength(2)
    expect(rows.filter((r) => r.contype === 'c')).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// ⑥ 失敗注入 rollback: review_logs 書込失敗が手順 4〜8 全体を rollback する
// (spec §6 / §11 該当項目 — 同一 tx 性の実 PG 実証。unit の tx-identity pin (Task 3)
// を補完する)
// ---------------------------------------------------------------------------

describe('⑥ 失敗注入: review_logs 書込失敗 → tx 全体 rollback', () => {
  it('answer_events 0 行 / cards 不変 / study_days 不変', async () => {
    const beforeCard = await readCard(fixture.a.cardId)
    const beforeStudyDays = await readStudyDays(fixture.a.userId)
    const ev = makeEvent(fixture.a.cardId, T1)

    // self-healing (fix round 1 / Minor #2): プロセスが途中 kill (timeout/OOM/Ctrl-C)
    // されて finally の DROP が走らなかった場合、共有 devcontainer PG に
    // tmp_reject_all が残留し以後の review_logs 全 INSERT を巻き添えにする。
    // ADD の直前に IF EXISTS DROP を置いて自己修復させる。
    await getFixtureOwnerDb().execute(
      sql`ALTER TABLE review_logs DROP CONSTRAINT IF EXISTS tmp_reject_all`,
    )
    // NOT VALID でも新規 INSERT には効く (既存行は検証しない・新規行は検証する)。
    await getFixtureOwnerDb().execute(
      sql`ALTER TABLE review_logs ADD CONSTRAINT tmp_reject_all CHECK (false) NOT VALID`,
    )
    try {
      await expect(processAnswerEvents(userA, [ev], RECEIVED_AT)).rejects.toThrow()
    } finally {
      await getFixtureOwnerDb().execute(
        sql`ALTER TABLE review_logs DROP CONSTRAINT tmp_reject_all`,
      )
    }

    // 手順 4 (answer_events INSERT) から手順 8 (study_days 再集計) までが同一 tx で
    // 丸ごと rollback している = 「applied ⟺ log が存在する」の原子性 (spec §6) の実証。
    expect(await readEvent(ev.event_id)).toBeNull()
    expect(await readCard(fixture.a.cardId)).toEqual(beforeCard)
    expect(await readStudyDays(fixture.a.userId)).toEqual(beforeStudyDays)
  })
})

// ---------------------------------------------------------------------------
// ⑦ 帰属整合の代替保証 (DB に複合 FK を張らない代わりの test 保証・spec §3.1)
// ---------------------------------------------------------------------------

describe('⑦ 帰属整合の代替保証', () => {
  it('(a) 他 tenant 所有の event_id を含む payload → failed[] ∧ review_logs に行が生まれない', async () => {
    const [bEvent] = await getFixtureOwnerDb()
      .select()
      .from(answerEvents)
      .where(eq(answerEvents.userId, fixture.b.userId))
    const before = bEvent!
    const beforeLog = await readReviewLog(before.eventId)
    expect(beforeLog).not.toBeNull() // fixture が B の decoy log を 1 行 seed 済み

    // A が B の event_id を送る (event_id は PK = 全 tenant 横断 UNIQUE なので
    // ON CONFLICT DO NOTHING で非新規になり、own-scope 所有権検証で failed)。
    const collide = makeEvent(fixture.a.cardId, T1, { event_id: before.eventId })
    const res = await processAnswerEvents(userA, [collide], RECEIVED_AT)

    expect(res.failed).toEqual([before.eventId])
    // B の既存 log 行が変更も複製もされていない (insertAnswerEvents で非新規 →
    // newRows に入らない → fold されない → review_logs 書込を一切試みない)。
    expect(await readReviewLog(before.eventId)).toEqual(beforeLog)
  })

  it('(b) 挿入された全 log 行の user_id は参照先 answer_events.user_id と一致する', async () => {
    const e1 = makeEvent(fixture.a.cardId, T1)
    const e2 = makeEvent(fixture.a.cardId, T2)

    const res = await processAnswerEvents(userA, [e1, e2], RECEIVED_AT)
    expect(res.failed).toEqual([])

    const eventIds = [e1.event_id, e2.event_id]
    const logRows = await readReviewLogsByEventIds(eventIds)
    expect(logRows).toHaveLength(2)

    const eventRows = await getFixtureOwnerDb()
      .select({ eventId: answerEvents.eventId, userId: answerEvents.userId })
      .from(answerEvents)
      .where(inArray(answerEvents.eventId, eventIds))
    const eventUserById = new Map(eventRows.map((r) => [r.eventId, r.userId]))

    expect(logRows.length).toBeGreaterThan(0)
    for (const log of logRows) {
      expect(log.userId).toBe(eventUserById.get(log.eventId))
    }
  })
})
