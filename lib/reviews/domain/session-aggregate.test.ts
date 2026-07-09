import { describe, it, expect } from 'vitest'
import type { ReplayCardState } from '@/lib/cards/replay-card'
import {
  buildCardOptionIndex,
  admitEvents,
  planReplay,
  replaySession,
  aggregateStudyDays,
  deriveRating,
  type AnswerEventInput,
} from './session-aggregate'

// ---------------------------------------------------------------------------
// factories
// ---------------------------------------------------------------------------

let _evSeq = 0

function ev(over?: Partial<AnswerEventInput>): AnswerEventInput {
  _evSeq++
  return {
    event_id: `event-${_evSeq}`,
    card_id: 'card-1',
    selected_answer_ids: ['opt-1'],
    is_correct: true,
    answered_at: '2026-07-09T01:00:00.000Z',
    ...over,
  }
}

// replayCard は本物を使う (pure sibling)。initial state は最小の有効値。
function cardState(over?: Partial<ReplayCardState>): ReplayCardState {
  return {
    due: new Date('2026-07-09T00:00:00.000Z'),
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
    ...over,
  }
}

// ---------------------------------------------------------------------------
// deriveRating (P0 §A #7 凍結契約)
// ---------------------------------------------------------------------------

describe('deriveRating', () => {
  it('rating 指定時は payload rating を優先する', () => {
    expect(deriveRating({ rating: 4, is_correct: false })).toBe(4)
    expect(deriveRating({ rating: 1, is_correct: true })).toBe(1)
  })

  it('rating 未指定なら is_correct から derive する (true→3 / false→1)', () => {
    expect(deriveRating({ is_correct: true })).toBe(3)
    expect(deriveRating({ is_correct: false })).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// buildCardOptionIndex — options jsonb 正規化 + malformed element 握り潰し
// ---------------------------------------------------------------------------

describe('buildCardOptionIndex', () => {
  it('正常な options を cardId → Set<optionId> に正規化する', () => {
    const index = buildCardOptionIndex([
      { id: 'card-1', options: [{ id: 'a' }, { id: 'b' }] },
      { id: 'card-2', options: [{ id: 'c' }] },
    ])
    expect(index.get('card-1')).toEqual(new Set(['a', 'b']))
    expect(index.get('card-2')).toEqual(new Set(['c']))
  })

  it('options が非配列/壊れ値なら空 Set にする (fail-closed・throw しない)', () => {
    const index = buildCardOptionIndex([
      { id: 'card-1', options: null },
      { id: 'card-2', options: 'nonsense' },
      { id: 'card-3', options: {} },
    ])
    expect(index.get('card-1')).toEqual(new Set())
    expect(index.get('card-2')).toEqual(new Set())
    expect(index.get('card-3')).toEqual(new Set())
  })

  it('malformed 要素 (null・id 欠落・id 非 string) を element 単位で握り潰す', () => {
    const index = buildCardOptionIndex([
      {
        id: 'card-1',
        options: [
          { id: 'a' },
          null,
          { text: 'no id' },
          { id: 123 },
          { id: 'b' },
        ],
      },
    ])
    // 健全な id のみ残る (壊れ要素は throw せず無視)
    expect(index.get('card-1')).toEqual(new Set(['a', 'b']))
  })
})

// ---------------------------------------------------------------------------
// admitEvents — orphan (#2) + A-2 存在検証 (#7)
// ---------------------------------------------------------------------------

describe('admitEvents', () => {
  it('knownCards に card_id が無い event を orphan として reject する', () => {
    const known = new Map<string, Set<string>>([['card-1', new Set(['opt-1'])]])
    const e1 = ev({ card_id: 'card-1', selected_answer_ids: ['opt-1'] })
    const orphan = ev({ card_id: 'card-X', selected_answer_ids: ['opt-1'] })
    const { applicable, rejected } = admitEvents([e1, orphan], known)
    expect(applicable).toEqual([e1])
    expect(rejected).toEqual([orphan.event_id])
  })

  it('selected に card の options に無い id が 1 つでもあれば reject する (A-2 unknown option)', () => {
    const known = new Map<string, Set<string>>([['card-1', new Set(['opt-1'])]])
    const bad = ev({ card_id: 'card-1', selected_answer_ids: ['opt-1', 'opt-2'] })
    const { applicable, rejected } = admitEvents([bad], known)
    expect(applicable).toEqual([])
    expect(rejected).toEqual([bad.event_id])
  })

  it('cross-card の option id は reject する (対象 card の Set で判定)', () => {
    const known = new Map<string, Set<string>>([
      ['card-1', new Set(['opt-1'])],
      ['card-2', new Set(['opt-2'])],
    ])
    // card-1 の event が card-2 の option を選択 → reject
    const cross = ev({ card_id: 'card-1', selected_answer_ids: ['opt-2'] })
    const { applicable, rejected } = admitEvents([cross], known)
    expect(applicable).toEqual([])
    expect(rejected).toEqual([cross.event_id])
  })

  it('multi-select で全 id が実在すれば applicable にする', () => {
    const known = new Map<string, Set<string>>([
      ['card-1', new Set(['opt-1', 'opt-2', 'opt-3'])],
    ])
    const multi = ev({
      card_id: 'card-1',
      selected_answer_ids: ['opt-1', 'opt-3'],
    })
    const { applicable, rejected } = admitEvents([multi], known)
    expect(applicable).toEqual([multi])
    expect(rejected).toEqual([])
  })

  it('空 selected は pass する (existence 検証対象なし)', () => {
    const known = new Map<string, Set<string>>([['card-1', new Set()]])
    const empty = ev({ card_id: 'card-1', selected_answer_ids: [] })
    const { applicable, rejected } = admitEvents([empty], known)
    expect(applicable).toEqual([empty])
    expect(rejected).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// planReplay — inserted gating + intra-payload dedup + payload 順 per-card group
// ---------------------------------------------------------------------------

describe('planReplay', () => {
  it('insertedEventIds に無い event を除外する (duplicate → skip)', () => {
    const a = ev({ event_id: 'e-a', card_id: 'card-1' })
    const b = ev({ event_id: 'e-b', card_id: 'card-1' })
    const inserted = new Set(['e-a']) // e-b は既処理 duplicate
    const groups = planReplay([a, b], inserted)
    expect(groups.get('card-1')).toEqual([a])
  })

  it('同 payload 内の重複 event_id は最初の出現のみ apply する (intra-payload dedup)', () => {
    const a = ev({ event_id: 'dup', card_id: 'card-1' })
    const aAgain = ev({ event_id: 'dup', card_id: 'card-1' })
    const inserted = new Set(['dup'])
    const groups = planReplay([a, aAgain], inserted)
    expect(groups.get('card-1')).toEqual([a])
  })

  it('card ごとに group 化し、group 内は payload 順を保持する', () => {
    const a1 = ev({ event_id: 'a1', card_id: 'card-1' })
    const b1 = ev({ event_id: 'b1', card_id: 'card-2' })
    const a2 = ev({ event_id: 'a2', card_id: 'card-1' })
    const inserted = new Set(['a1', 'b1', 'a2'])
    const groups = planReplay([a1, b1, a2], inserted)
    // card-1 group は payload 順 (a1 の後に a2)
    expect(groups.get('card-1')).toEqual([a1, a2])
    expect(groups.get('card-2')).toEqual([b1])
    // group Map の挿入順 = card 初出順 (card-1, card-2)
    expect([...groups.keys()]).toEqual(['card-1', 'card-2'])
  })
})

// ---------------------------------------------------------------------------
// replaySession — replayCard fold + zip
// ---------------------------------------------------------------------------

describe('replaySession', () => {
  it('cardStates を groups で fold し finalStates + reviewRows を返す', () => {
    const states = new Map<string, ReplayCardState>([
      ['card-1', cardState()],
    ])
    const groups = new Map<string, AnswerEventInput[]>([
      [
        'card-1',
        [
          ev({
            event_id: 'x1',
            card_id: 'card-1',
            rating: 3,
            answered_at: '2026-07-09T01:00:00.000Z',
          }),
        ],
      ],
    ])
    const { finalStates, reviewRows } = replaySession(states, groups)
    expect(finalStates.has('card-1')).toBe(true)
    // review が 1 行、rating は payload rating、reviewedAt は answered_at の Date
    expect(reviewRows).toHaveLength(1)
    expect(reviewRows[0].cardId).toBe('card-1')
    expect(reviewRows[0].rating).toBe(3)
    expect(reviewRows[0].reviewedAt).toEqual(
      new Date('2026-07-09T01:00:00.000Z'),
    )
    // fold で answered/reps が進む (mock echo でなく実 replay 挙動)
    expect(finalStates.get('card-1')!.answered).toBe(true)
    expect(finalStates.get('card-1')!.reps).toBeGreaterThan(0)
  })

  it('group 内 fold 順と reviewRows の zip が整合する (payload 順)', () => {
    const states = new Map<string, ReplayCardState>([['card-1', cardState()]])
    const groups = new Map<string, AnswerEventInput[]>([
      [
        'card-1',
        [
          ev({ event_id: 'r1', card_id: 'card-1', rating: 1 }),
          ev({ event_id: 'r2', card_id: 'card-1', rating: 4 }),
        ],
      ],
    ])
    const { reviewRows } = replaySession(states, groups)
    // reviewRows は group 内の payload 順で rating が並ぶ
    expect(reviewRows.map((r) => r.rating)).toEqual([1, 4])
  })

  it('rating 未指定 event は deriveRating (is_correct) で fold する', () => {
    const states = new Map<string, ReplayCardState>([['card-1', cardState()]])
    const groups = new Map<string, AnswerEventInput[]>([
      [
        'card-1',
        [ev({ event_id: 'd1', card_id: 'card-1', is_correct: false })],
      ],
    ])
    const { reviewRows } = replaySession(states, groups)
    expect(reviewRows[0].rating).toBe(1) // is_correct=false → 1
  })
})

// ---------------------------------------------------------------------------
// aggregateStudyDays — JST day 分割 + correct=rating>=2
// ---------------------------------------------------------------------------

describe('aggregateStudyDays', () => {
  it('answered_at を JST day でグループ化して total/correct を集計する', () => {
    // 2026-07-09T14:00Z = JST 2026-07-09 23:00 → day 07-09
    // 2026-07-09T15:30Z = JST 2026-07-10 00:30 → day 07-10 (JST 日跨ぎ)
    const map = aggregateStudyDays([
      ev({ answered_at: '2026-07-09T14:00:00.000Z', rating: 3 }),
      ev({ answered_at: '2026-07-09T14:30:00.000Z', rating: 1 }),
      ev({ answered_at: '2026-07-09T15:30:00.000Z', rating: 4 }),
    ])
    expect(map.get('2026-07-09')).toEqual({ total: 2, correct: 1 })
    expect(map.get('2026-07-10')).toEqual({ total: 1, correct: 1 })
  })

  it('correct は rating>=2 で数える (Again=1 は total のみ)', () => {
    const map = aggregateStudyDays([
      ev({ answered_at: '2026-07-09T01:00:00.000Z', rating: 1 }),
      ev({ answered_at: '2026-07-09T01:00:00.000Z', rating: 2 }),
    ])
    expect(map.get('2026-07-09')).toEqual({ total: 2, correct: 1 })
  })

  it('rating 未指定は deriveRating (is_correct) 経由で correct 判定する', () => {
    const map = aggregateStudyDays([
      ev({ answered_at: '2026-07-09T01:00:00.000Z', is_correct: true }),
      ev({ answered_at: '2026-07-09T01:00:00.000Z', is_correct: false }),
    ])
    // true→3 (correct)、false→1 (not correct)
    expect(map.get('2026-07-09')).toEqual({ total: 2, correct: 1 })
  })
})
