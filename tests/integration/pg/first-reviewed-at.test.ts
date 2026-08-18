// Dash-1 Home v1 Task 3: cards.first_reviewed_at の書込契約 (spec §8.3) の behavioral 実証。
//
// 契約: fold は増分適用 (現 DB 行からの fold・全履歴 replay ではない) であり、
// `initial.state === 0 && final.state !== 0` の遷移が起きたときだけ、その遷移を起こした
// 最初の applied event の answered_at (clamp 済) で 1 回設定し、以後書き換えない。
//
// ここに置くのは実 PG round-trip でしか出ない性質だけ:
//   ① 初回 flush で書かれ、後続 flush で不変 (増分 fold が DB 現在値を引き継ぐこと)
//   ② 遅延到着した過去 event が順序ガードで skip され、DB 値が動かないこと
//   ③ 設定済み card への後続 flush が null 上書きしない
//      (lockCardReplayStates の明示 SELECT 列 + applyCardFinalStates の COALESCE の
//       二層 defense-in-depth を end-to-end で通す)
//   ④ COALESCE 層**単独**の detector (①〜③ は二層 OR のため単独変異で red にならない)
// 純関数側の遷移規則 (0→非 0 で設定 / 非遷移で不変 / 先着固定) は unit
// (lib/cards/replay-card.test.ts) の担当で、ここでは重複させない。
//
// **検出力の分担 (完全性の主張はここに閉じる)**:
//   - fold の先着固定 (`??`)        → unit `replay-card.test.ts`
//   - SELECT 列の脱落               → unit `session-repository.test.ts` の列集合 pin
//   - ingest の写像 (row → state)   → 下記 ④ ではなく **detector 不在**
//     (SELECT が健在なら列集合 pin は green、COALESCE が吸収するので iso も green。
//      TypeScript strict が強制するのは field の**存在**であって**値**ではない。
//      ④ が入ったことで「両層同時breach」だけは塞がるが、写像単独の regression を
//      名指しで落とす test は無い — task-3-report.md §9-M1 に記録)
//   - COALESCE の脱落               → 下記 ④
//
// 刺激 = processAnswerEvents (内部で withTenantTx = app role + tenant context)。
// 観測 = owner 接続 (getFixtureOwnerDb / RLS bypass)。作法は review-logs.test.ts と同型。
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import type { ReplayCardState } from '@/lib/cards/replay-card'
import { closeDb } from '@/lib/db'
import { answerEvents, cards, type User } from '@/lib/db/schema'
import { processAnswerEvents } from '@/lib/reviews/ingest-review-events'
import { applyCardFinalStates } from '@/lib/reviews/session-repository'
import type { AnswerEventWire } from '@/lib/sync/shared/answer-event-schema'

import { asTenant } from './setup/as-tenant'
import {
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
  type TenantFixture,
} from './setup/fixture'

// fixture が seed 済みの day (2026-07-18) を避けた test 用の時刻 (review-logs.test.ts と
// 同じ回避理由)。RECEIVED_AT は全 event より十分未来 = clamp が発火しない
// (clamp の挙動自体は answer-events-serialization.test.ts の担当)。
const RECEIVED_AT = new Date('2026-10-01T00:00:00.000Z')
const T1 = new Date('2026-08-20T01:00:00.000Z')
const T2 = new Date('2026-08-20T02:00:00.000Z')
const T3 = new Date('2026-08-20T03:00:00.000Z')
const T4 = new Date('2026-08-20T04:00:00.000Z')
const SESSION_ID = '44444444-4444-4444-a444-444444444444'

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
    .then((rows) => rows[0]!)
}

/** 既に 1 回 review 済み (非 New) の card 状態を明示 seed する。 */
function seedReviewedCard(firstReviewedAt: Date | null) {
  return getFixtureOwnerDb()
    .update(cards)
    .set({
      state: 2,
      due: new Date('2026-09-01T00:00:00.000Z'),
      stability: 12.34,
      difficulty: 5.67,
      elapsedDays: 9,
      scheduledDays: 21,
      learningSteps: 0,
      reps: 3,
      lapses: 0,
      lastReview: T1,
      firstReviewedAt,
      answered: true,
      lastCorrect: true,
      currentStreak: 2,
    })
    .where(eq(cards.id, fixture.a.cardId))
}

// ---------------------------------------------------------------------------
// ① 初回 flush で書かれ、後続 flush で不変
// ---------------------------------------------------------------------------

describe('① 初回適用で書かれ、2 回目以降の flush で変わらない', () => {
  it('flush1 が遷移 event の answered_at を書き、flush2 (より新しい applied event) で不変', async () => {
    const before = await readCard(fixture.a.cardId)
    // 前提ガード: fixture card は New (state 0) かつ未設定。
    expect(before.state).toBe(0)
    expect(before.firstReviewedAt).toBeNull()

    const e1 = makeEvent(fixture.a.cardId, T2)
    expect((await processAnswerEvents(userA, [e1], RECEIVED_AT)).failed).toEqual([])

    const afterFirst = await readCard(fixture.a.cardId)
    const storedE1 = await readEvent(e1.event_id)
    expect(storedE1.applied).toBe(true)
    // 遷移が実際に起きたことを確認 (退化していれば以下の assert が空振りする)。
    expect(afterFirst.state).not.toBe(0)
    // 値 = 遷移を起こした event の answered_at (answer_events 行が clamp の権威)。
    expect(afterFirst.firstReviewedAt?.getTime()).toBe(storedE1.answeredAt.getTime())
    expect(afterFirst.firstReviewedAt?.getTime()).toBe(T2.getTime())

    const e2 = makeEvent(fixture.a.cardId, T3)
    expect((await processAnswerEvents(userA, [e2], RECEIVED_AT)).failed).toEqual([])

    const afterSecond = await readCard(fixture.a.cardId)
    // card 行自体は更新されている (= UPDATE が走った上で当該列だけ据置)。
    expect((await readEvent(e2.event_id)).applied).toBe(true)
    expect(afterSecond.reps).toBeGreaterThan(afterFirst.reps)
    expect(afterSecond.firstReviewedAt?.getTime()).toBe(T2.getTime())
    expect(afterSecond.firstReviewedAt?.getTime()).not.toBe(T3.getTime())
  })
})

// ---------------------------------------------------------------------------
// ② 遅延到着した過去 event が順序ガードで skip され、DB 値が動かない
//
// **この describe が実証する範囲を狭く言う**: ここで値を保っているのは fold の先着固定
// (`??`) ではなく **COALESCE** である (fold の `??` を外す変異でもこの test は green の
// まま = 実測済み)。fold 自身の先着固定は unit `replay-card.test.ts` が唯一の pin。
// ここでの主張は「過去 event は applied=false に落ち、同 payload の新 event で card 行が
// UPDATE されても DB 上の first_reviewed_at は動かない」に限る。
// ---------------------------------------------------------------------------

describe('② 遅延到着した過去 event が順序ガードで skip され DB 値が動かない', () => {
  it('過去 event は applied=false に落ち、同 payload の新 event 適用でも DB 値は初回のまま', async () => {
    const first = makeEvent(fixture.a.cardId, T2)
    expect((await processAnswerEvents(userA, [first], RECEIVED_AT)).failed).toEqual([])
    const afterFirst = await readCard(fixture.a.cardId)
    expect(afterFirst.firstReviewedAt?.getTime()).toBe(T2.getTime())

    // 遅延到着: T1 (初回より過去) と T4 (新しい) を 1 payload で。card 行が実際に
    // UPDATE される状況 (T4 適用) を作ることで、UPDATE 経路を通した上での不変を見る
    // (この不変を担っているのは COALESCE — describe 冒頭のコメント参照)。
    const stale = makeEvent(fixture.a.cardId, T1)
    const fresh = makeEvent(fixture.a.cardId, T4)
    expect(
      (await processAnswerEvents(userA, [stale, fresh], RECEIVED_AT)).failed,
    ).toEqual([])

    expect((await readEvent(stale.event_id)).applied).toBe(false) // 順序ガード skip
    expect((await readEvent(fresh.event_id)).applied).toBe(true)

    const afterSecond = await readCard(fixture.a.cardId)
    expect(afterSecond.reps).toBeGreaterThan(afterFirst.reps) // UPDATE は走った
    expect(afterSecond.firstReviewedAt?.getTime()).toBe(T2.getTime())
    expect(afterSecond.firstReviewedAt?.getTime()).not.toBe(T1.getTime()) // 遡及修正しない
    expect(afterSecond.firstReviewedAt?.getTime()).not.toBe(T4.getTime())
  })

  it('遷移していない適用 (既に非 New かつ未設定の既存行) では値が湧かない', async () => {
    // migration 前の既存行 = backfill せず null 据置 (spec §8.3)。非 New card への
    // 通常の復習では「初見を学習した瞬間」が存在しないため、書いてはいけない。
    await seedReviewedCard(null)

    const ev = makeEvent(fixture.a.cardId, T4)
    expect((await processAnswerEvents(userA, [ev], RECEIVED_AT)).failed).toEqual([])

    const after = await readCard(fixture.a.cardId)
    expect((await readEvent(ev.event_id)).applied).toBe(true) // 適用はされている
    expect(after.firstReviewedAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ③ 設定済み card への後続 flush が null 上書きしない
//    (SELECT 列 + COALESCE の二層を end-to-end で通す)
// ---------------------------------------------------------------------------

describe('③ 設定済み card への後続 flush が null 上書きしない', () => {
  it('非 New かつ設定済みの card に applied event を流しても値が消えない', async () => {
    const alreadySet = new Date('2026-08-01T00:00:00.000Z')
    await seedReviewedCard(alreadySet)
    const before = await readCard(fixture.a.cardId)
    // 前提ガード: 非 New (= fold は遷移を起こさない = v 側は値を持たない構図) かつ設定済み。
    expect(before.state).not.toBe(0)
    expect(before.firstReviewedAt?.getTime()).toBe(alreadySet.getTime())

    const ev = makeEvent(fixture.a.cardId, T4)
    expect((await processAnswerEvents(userA, [ev], RECEIVED_AT)).failed).toEqual([])

    const after = await readCard(fixture.a.cardId)
    expect((await readEvent(ev.event_id)).applied).toBe(true)
    // card 行は確かに UPDATE されている = 「UPDATE が走らなかったから値が残った」
    // という退化ではない。
    expect(after.reps).toBeGreaterThan(before.reps)
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
    expect(after.firstReviewedAt).not.toBeNull()
    expect(after.firstReviewedAt?.getTime()).toBe(alreadySet.getTime())
  })
})

// ---------------------------------------------------------------------------
// ④ COALESCE 層 **単独** の detector
//
// ①〜③ は「SELECT 列 + ingest 写像」と「COALESCE」の**論理和**で守られているため、
// どちらか一方だけを外しても観測差が出ない (= 単独変異で red にならない)。COALESCE の
// 職責は「将来 SELECT 規律が破られたときに first_reviewed_at を守る」ことなので、
// それを外した瞬間に落ちる test が無いと「全 test green の dead weight」として削除され、
// **是正経路も backfill も無い**列を守る最後の層が消える。
//
// そこで processAnswerEvents を経由せず applyCardFinalStates を **直接**刺激する
// (write-isolation.test.ts の asTenant + 直呼び + owner readback の既存 idiom)。この経路は
// lockCardReplayStates も ingest 写像も fold も通らないため、firstReviewedAt: null を
// 積んだ finalStates に対して**残る防御は COALESCE だけ**になる。
// ---------------------------------------------------------------------------

describe('④ COALESCE 単独 detector: finalStates が null でも既存値を消さない', () => {
  it('applyCardFinalStates 直呼び (fold / SELECT を迂回) で first_reviewed_at が保たれる', async () => {
    const alreadySet = new Date('2026-08-01T00:00:00.000Z')
    await seedReviewedCard(alreadySet)
    const before = await readCard(fixture.a.cardId)
    expect(before.firstReviewedAt?.getTime()).toBe(alreadySet.getTime())

    // fold が「この card は未 review」と誤認した場合に相当する finalStates。
    // reps は seed 値 (3) と必ず異なる値にする — 非退化ガードの比較対象。
    const finalState: ReplayCardState = {
      due: new Date('2030-01-01T00:00:00.000Z'),
      stability: 9.5,
      difficulty: 4.25,
      elapsedDays: 10,
      scheduledDays: 20,
      reps: 9,
      lapses: 1,
      state: 2,
      learningSteps: 0,
      lastReview: T4,
      firstReviewedAt: null,
      answered: true,
      lastCorrect: true,
      currentStreak: 5,
    }
    expect(finalState.reps).not.toBe(before.reps)

    await asTenant(fixture.a.userId, (tx) =>
      applyCardFinalStates(tx, fixture.a.userId, new Map([[fixture.a.cardId, finalState]])),
    )

    const after = await readCard(fixture.a.cardId)
    // 非退化ガード: 同じ VALUES 行の別列が実際に書き換わっている = UPDATE は 1 行に
    // マッチした。これが無いと「0 行 match で何も起きなかった」でも test が通ってしまう。
    expect(after.reps).toBe(9)
    expect(after.firstReviewedAt).not.toBeNull()
    expect(after.firstReviewedAt?.getTime()).toBe(alreadySet.getTime())
  })
})
