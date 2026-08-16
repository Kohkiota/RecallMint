// session-aggregate (pure domain) の unit test。
// pin する不変条件:
//   - planFold: A-2 (option 実在) と card ロックの降格判定 + per-card の answered_at 昇順
//     stable sort (同時刻は入力順)
//   - foldSession: 順序ガード `>=` (同時刻は適用 / 厳密に古いものだけ skip)
//   - foldSession: 全 skip の card は finalStates に載らない

import { describe, it, expect } from 'vitest'
import type { ReplayCardState } from '@/lib/cards/replay-card'
import {
  buildCardOptionIndex,
  foldSession,
  planFold,
  type FoldEvent,
} from './session-aggregate'

const CARD_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const CARD_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'

function makeEvent(overrides: Partial<FoldEvent> & { eventId: string }): FoldEvent {
  return {
    cardId: CARD_A,
    selectedAnswerIds: ['a'],
    isCorrect: true,
    rating: 3,
    answeredAt: new Date('2026-05-25T10:00:00.000Z'),
    ...overrides,
  }
}

function makeCardState(overrides: Partial<ReplayCardState> = {}): ReplayCardState {
  return {
    due: new Date('2026-05-25T00:00:00.000Z'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    ...overrides,
  }
}

const OPTION_INDEX = new Map([
  [CARD_A, new Set(['a', 'b'])],
  [CARD_B, new Set(['a', 'b'])],
])
const LOCKED = new Set([CARD_A, CARD_B])

// ---------------------------------------------------------------------------
// buildCardOptionIndex
// ---------------------------------------------------------------------------

describe('buildCardOptionIndex', () => {
  it('options 配列の id を Set 化する', () => {
    const index = buildCardOptionIndex([
      { id: CARD_A, options: [{ id: 'a' }, { id: 'b' }] },
    ])
    expect([...index.get(CARD_A)!]).toEqual(['a', 'b'])
  })

  it('options が非配列 / 壊れ要素なら空 Set・要素単位で握り潰す (fail-closed)', () => {
    const index = buildCardOptionIndex([
      { id: CARD_A, options: 'broken' },
      { id: CARD_B, options: [null, { id: 42 }, { text: 'no id' }, { id: 'b' }] },
    ])
    expect(index.get(CARD_A)!.size).toBe(0)
    expect([...index.get(CARD_B)!]).toEqual(['b'])
  })
})

// ---------------------------------------------------------------------------
// planFold
// ---------------------------------------------------------------------------

describe('planFold', () => {
  it('ロックされていない card の event は card_not_locked で降格する', () => {
    const orphan = makeEvent({ eventId: 'e1', cardId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc' })
    const plan = planFold([orphan], LOCKED, OPTION_INDEX)

    expect(plan.groups.size).toBe(0)
    expect(plan.skipped).toEqual([
      { eventId: 'e1', cardId: orphan.cardId, reason: 'card_not_locked' },
    ])
  })

  it('card の options に無い id が混ざる event は unknown_option で降格する (A-2)', () => {
    const bad = makeEvent({ eventId: 'e1', selectedAnswerIds: ['a', 'zzz'] })
    const good = makeEvent({ eventId: 'e2', selectedAnswerIds: ['a', 'b'] })
    const plan = planFold([bad, good], LOCKED, OPTION_INDEX)

    expect(plan.skipped).toEqual([
      { eventId: 'e1', cardId: CARD_A, reason: 'unknown_option' },
    ])
    expect(plan.groups.get(CARD_A)!.map((e) => e.eventId)).toEqual(['e2'])
  })

  it('selected_answer_ids が空なら A-2 は pass する', () => {
    const plan = planFold(
      [makeEvent({ eventId: 'e1', selectedAnswerIds: [] })],
      LOCKED,
      OPTION_INDEX,
    )
    expect(plan.skipped).toEqual([])
    expect(plan.groups.get(CARD_A)!.map((e) => e.eventId)).toEqual(['e1'])
  })

  it('per-card group は answered_at 昇順に並ぶ (入力順が逆でも)', () => {
    const late = makeEvent({ eventId: 'late', answeredAt: new Date('2026-05-25T12:00:00.000Z') })
    const early = makeEvent({ eventId: 'early', answeredAt: new Date('2026-05-25T09:00:00.000Z') })
    const plan = planFold([late, early], LOCKED, OPTION_INDEX)

    expect(plan.groups.get(CARD_A)!.map((e) => e.eventId)).toEqual(['early', 'late'])
  })

  it('同時刻の tie は入力 (payload) 順を保つ = stable sort', () => {
    const at = new Date('2026-05-25T10:00:00.000Z')
    const plan = planFold(
      [
        makeEvent({ eventId: 'first', answeredAt: at }),
        makeEvent({ eventId: 'second', answeredAt: at }),
        makeEvent({ eventId: 'third', answeredAt: at }),
      ],
      LOCKED,
      OPTION_INDEX,
    )
    expect(plan.groups.get(CARD_A)!.map((e) => e.eventId)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('card ごとに独立した group になる', () => {
    const plan = planFold(
      [
        makeEvent({ eventId: 'a1', cardId: CARD_A }),
        makeEvent({ eventId: 'b1', cardId: CARD_B }),
        makeEvent({ eventId: 'a2', cardId: CARD_A }),
      ],
      LOCKED,
      OPTION_INDEX,
    )
    expect(plan.groups.get(CARD_A)!.map((e) => e.eventId)).toEqual(['a1', 'a2'])
    expect(plan.groups.get(CARD_B)!.map((e) => e.eventId)).toEqual(['b1'])
  })
})

// ---------------------------------------------------------------------------
// foldSession — 順序ガード
// ---------------------------------------------------------------------------

describe('foldSession 順序ガード', () => {
  it('lastReview=null の card は必ず適用する', () => {
    const plan = planFold([makeEvent({ eventId: 'e1' })], LOCKED, OPTION_INDEX)
    const states = new Map([[CARD_A, makeCardState({ lastReview: null })]])

    const { finalStates, appliedEventIds } = foldSession(states, plan)

    expect([...appliedEventIds]).toEqual(['e1'])
    expect(finalStates.get(CARD_A)!.reps).toBe(1)
  })

  it('lastReview より厳密に古い event は skip され card state は不変', () => {
    const plan = planFold(
      [makeEvent({ eventId: 'stale', answeredAt: new Date('2026-05-25T08:00:00.000Z') })],
      LOCKED,
      OPTION_INDEX,
    )
    const states = new Map([
      [CARD_A, makeCardState({ lastReview: new Date('2026-05-25T10:00:00.000Z'), reps: 4 })],
    ])

    const { finalStates, appliedEventIds } = foldSession(states, plan)

    expect(appliedEventIds.size).toBe(0)
    // 全 skip の card は UPDATE 対象にしない
    expect(finalStates.has(CARD_A)).toBe(false)
  })

  it('lastReview と同時刻の event は適用する (境界は >=)', () => {
    const at = new Date('2026-05-25T10:00:00.000Z')
    const plan = planFold([makeEvent({ eventId: 'tie', answeredAt: at })], LOCKED, OPTION_INDEX)
    const states = new Map([[CARD_A, makeCardState({ lastReview: at, reps: 4 })]])

    const { finalStates, appliedEventIds } = foldSession(states, plan)

    expect([...appliedEventIds]).toEqual(['tie'])
    expect(finalStates.get(CARD_A)!.reps).toBe(5)
  })

  it('新旧混在は sort 後に先頭の古い分だけ落ち、残りは全て適用される', () => {
    const plan = planFold(
      [
        makeEvent({ eventId: 'new', answeredAt: new Date('2026-05-25T12:00:00.000Z') }),
        makeEvent({ eventId: 'stale', answeredAt: new Date('2026-05-25T08:00:00.000Z') }),
        makeEvent({ eventId: 'mid', answeredAt: new Date('2026-05-25T11:00:00.000Z') }),
      ],
      LOCKED,
      OPTION_INDEX,
    )
    const states = new Map([
      [CARD_A, makeCardState({ lastReview: new Date('2026-05-25T10:00:00.000Z'), reps: 1 })],
    ])

    const { finalStates, appliedEventIds } = foldSession(states, plan)

    expect([...appliedEventIds].sort()).toEqual(['mid', 'new'])
    expect(finalStates.get(CARD_A)!.reps).toBe(3)
    // 最終 lastReview は最も新しい適用 event
    expect(finalStates.get(CARD_A)!.lastReview).toEqual(new Date('2026-05-25T12:00:00.000Z'))
  })

  it('統計列は is_correct から導出される (rating とは独立)', () => {
    const plan = planFold(
      [makeEvent({ eventId: 'e1', rating: 3, isCorrect: false })],
      LOCKED,
      OPTION_INDEX,
    )
    const states = new Map([[CARD_A, makeCardState({ currentStreak: 3, lastCorrect: true })]])

    const { finalStates } = foldSession(states, plan)

    expect(finalStates.get(CARD_A)!.lastCorrect).toBe(false)
    expect(finalStates.get(CARD_A)!.currentStreak).toBe(0)
  })

  it('card ごとに独立して fold する', () => {
    const plan = planFold(
      [
        makeEvent({ eventId: 'a1', cardId: CARD_A }),
        makeEvent({ eventId: 'a2', cardId: CARD_A, answeredAt: new Date('2026-05-25T11:00:00.000Z') }),
        makeEvent({ eventId: 'b1', cardId: CARD_B }),
      ],
      LOCKED,
      OPTION_INDEX,
    )
    const states = new Map([
      [CARD_A, makeCardState()],
      [CARD_B, makeCardState()],
    ])

    const { finalStates, appliedEventIds } = foldSession(states, plan)

    expect(appliedEventIds.size).toBe(3)
    expect(finalStates.get(CARD_A)!.reps).toBe(2)
    expect(finalStates.get(CARD_B)!.reps).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// foldSession — appliedLogs (R0 Task 2: review_logs 永続化向けの log 回収 pin)
// ---------------------------------------------------------------------------

describe('foldSession: appliedLogs (R0 Task 2)', () => {
  it('⑤ appliedLogs の eventId 集合は appliedEventIds と一致する', () => {
    const plan = planFold(
      [
        makeEvent({ eventId: 'a1', cardId: CARD_A }),
        makeEvent({
          eventId: 'a2',
          cardId: CARD_A,
          answeredAt: new Date('2026-05-25T11:00:00.000Z'),
        }),
        makeEvent({ eventId: 'b1', cardId: CARD_B }),
      ],
      LOCKED,
      OPTION_INDEX,
    )
    const states = new Map([
      [CARD_A, makeCardState()],
      [CARD_B, makeCardState()],
    ])

    const { appliedEventIds, appliedLogs } = foldSession(states, plan)

    expect(appliedLogs.length).toBe(appliedEventIds.size)
    expect(new Set(appliedLogs.map((l) => l.eventId))).toEqual(appliedEventIds)
  })

  it('⑥ skip された event (card_not_locked / unknown_option / 順序ガード) は appliedLogs に出ない', () => {
    const orphanCardId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
    const plan = planFold(
      [
        makeEvent({ eventId: 'orphan', cardId: orphanCardId }), // card_not_locked
        makeEvent({ eventId: 'bad-option', selectedAnswerIds: ['zzz'] }), // unknown_option (A-2)
        makeEvent({ eventId: 'stale', answeredAt: new Date('2026-05-25T08:00:00.000Z') }), // 順序ガード skip (foldSession 側)
        makeEvent({ eventId: 'ok', answeredAt: new Date('2026-05-25T11:00:00.000Z') }),
      ],
      LOCKED,
      OPTION_INDEX,
    )
    // 前提: planFold 側の降格が想定どおりであることを確認
    expect(plan.skipped.map((s) => s.eventId).sort()).toEqual(['bad-option', 'orphan'])

    const states = new Map([
      [CARD_A, makeCardState({ lastReview: new Date('2026-05-25T10:00:00.000Z') })],
    ])

    const { appliedEventIds, appliedLogs } = foldSession(states, plan)

    expect([...appliedEventIds]).toEqual(['ok'])
    expect(appliedLogs.map((l) => l.eventId)).toEqual(['ok'])
  })

  it('⑦ 同 card 複数 event の連鎖: appliedLogs[n].after は appliedLogs[n+1].log の before 値と一致する', () => {
    const plan = planFold(
      [
        makeEvent({ eventId: 'e1', answeredAt: new Date('2026-05-25T10:00:00.000Z') }),
        makeEvent({ eventId: 'e2', answeredAt: new Date('2026-05-25T11:00:00.000Z') }),
        makeEvent({ eventId: 'e3', answeredAt: new Date('2026-05-25T12:00:00.000Z') }),
      ],
      LOCKED,
      OPTION_INDEX,
    )
    const states = new Map([[CARD_A, makeCardState()]])

    const { appliedLogs } = foldSession(states, plan)

    expect(appliedLogs.length).toBe(3)
    for (let i = 0; i < appliedLogs.length - 1; i++) {
      expect(appliedLogs[i].after.state).toBe(appliedLogs[i + 1].log.state)
      expect(appliedLogs[i].after.stability).toBe(appliedLogs[i + 1].log.stability)
      expect(appliedLogs[i].after.difficulty).toBe(appliedLogs[i + 1].log.difficulty)
    }
  })
})

// ---------------------------------------------------------------------------
// foldSession — dueBefore (R0 r2 Critical fix: log.due は「適用前 due」ではなく
// 「前回 review 時刻」を返す — ts-fsrs buildLog() の `due: last_review || due`
// 実装起因。dueBefore は fold が退避する真の「適用前 due」で、log.due とは別物
// であることを pin する。spec 2026-08-16-r0-review-log-persistence-design.md §3.1
// r2 訂正 / §12-5)。
// ---------------------------------------------------------------------------

describe('foldSession: dueBefore (R0 r2 Critical fix)', () => {
  // due と lastReview を意図的に別値にする (両者が同値だと以下の pin が空振りする —
  // pin ②③ が「たまたま一致」で偽陽性 pass しないためのシナリオ設計)。
  const CARD_DUE = new Date('2026-05-20T00:00:00.000Z')
  const CARD_LAST_REVIEW = new Date('2026-05-15T00:00:00.000Z')

  it('① 前提ガード: シナリオの due と lastReview が異なる (退化していないこと)', () => {
    expect(CARD_DUE.getTime()).not.toBe(CARD_LAST_REVIEW.getTime())
  })

  it('② ts-fsrs 自体の挙動 pin: log.due は due でなく lastReview を返す (last_review||due)', () => {
    const plan = planFold([makeEvent({ eventId: 'e1' })], LOCKED, OPTION_INDEX)
    const states = new Map([
      [
        CARD_A,
        makeCardState({
          due: CARD_DUE,
          lastReview: CARD_LAST_REVIEW,
          state: 2,
          stability: 5,
          difficulty: 5,
          reps: 2,
          scheduledDays: 5,
          elapsedDays: 5,
        }),
      ],
    ])

    const { appliedLogs } = foldSession(states, plan)

    expect(appliedLogs).toHaveLength(1)
    expect(appliedLogs[0]!.log.due.getTime()).toBe(CARD_LAST_REVIEW.getTime())
  })

  it('④ dueBefore は log.due と異なり、真の適用前 due (fold が退避した card.due) と一致する', () => {
    const plan = planFold([makeEvent({ eventId: 'e1' })], LOCKED, OPTION_INDEX)
    const states = new Map([
      [
        CARD_A,
        makeCardState({
          due: CARD_DUE,
          lastReview: CARD_LAST_REVIEW,
          state: 2,
          stability: 5,
          difficulty: 5,
          reps: 2,
          scheduledDays: 5,
          elapsedDays: 5,
        }),
      ],
    ])

    const { appliedLogs } = foldSession(states, plan)

    expect(appliedLogs).toHaveLength(1)
    expect(appliedLogs[0]!.dueBefore.getTime()).toBe(CARD_DUE.getTime())
    expect(appliedLogs[0]!.dueBefore.getTime()).not.toBe(appliedLogs[0]!.log.due.getTime())
  })
})
