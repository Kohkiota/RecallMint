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
