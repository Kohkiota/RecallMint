import { describe, it, expect } from 'vitest'
import {
  aggregateHomeCards,
  type HomeAggregateCard,
} from './home-aggregate'

// now = 2026-08-19T03:00:00Z = JST 2026-08-19 12:00。today = '2026-08-19'。
const NOW = new Date('2026-08-19T03:00:00Z')
const EXAM = 'exam-1'

function card(overrides: Partial<HomeAggregateCard> = {}): HomeAggregateCard {
  return {
    exam_id: EXAM,
    state: 2,
    stability: 1,
    due: '2026-08-19T09:00:00+09:00',
    lapses: 0,
    answered: true,
    last_correct: true,
    ...overrides,
  }
}

describe('aggregateHomeCards — 3 区分(定義 doc §4-A/B/C)', () => {
  it('state=0 は未学習、state=2 かつ stability>=21 は定着、それ以外は学習中', () => {
    const agg = aggregateHomeCards({
      cards: [
        card({ state: 0, stability: 0 }),
        card({ state: 1, stability: 30 }),
        card({ state: 2, stability: 20.9 }),
        card({ state: 2, stability: 21 }),
        card({ state: 3, stability: 50 }),
      ],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.newCards).toBe(1)
    expect(agg.learningCards).toBe(3)
    expect(agg.matureCards).toBe(1)
    expect(agg.totalCards).toBe(5)
  })

  it('他試験のカードは選択試験の集計に入らない', () => {
    const agg = aggregateHomeCards({
      cards: [card({ state: 0 }), card({ exam_id: 'exam-2', state: 0 })],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.totalCards).toBe(1)
    expect(agg.newCards).toBe(1)
  })
})

describe('aggregateHomeCards — n / m(定義 doc §5 W2・§4-D)', () => {
  it('n = state!==0 かつ due < 今日の終わり。23:59 は入り翌 0:00 は入らない', () => {
    const agg = aggregateHomeCards({
      cards: [
        card({ due: '2026-08-19T23:59:59+09:00' }),
        card({ due: '2026-08-20T00:00:00+09:00' }),
      ],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.reviewDueToday).toBe(1)
  })

  it('未学習(state=0)は due が今日でも n に入らない', () => {
    const agg = aggregateHomeCards({
      cards: [card({ state: 0, due: '2026-08-19T09:00:00+09:00' })],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.reviewDueToday).toBe(0)
  })

  it('m = 持ち越し。今日の開始ちょうどは持ち越しに含めない', () => {
    const agg = aggregateHomeCards({
      cards: [
        card({ due: '2026-08-18T23:59:59+09:00' }),
        card({ due: '2026-08-19T00:00:00+09:00' }),
        card({ state: 0, due: '2026-08-01T00:00:00+09:00' }),
      ],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.carryover).toBe(1)
  })

  it('m は n の内数(持ち越しは n にも数える)', () => {
    const agg = aggregateHomeCards({
      cards: [card({ due: '2026-08-10T09:00:00+09:00' })],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.carryover).toBe(1)
    expect(agg.reviewDueToday).toBe(1)
  })
})

describe('aggregateHomeCards — W6 今後 7 日(定義 doc §5 W6)', () => {
  it('7 本を返し、今日のバーは持ち越しを合算する(= n と一致)', () => {
    const agg = aggregateHomeCards({
      cards: [
        card({ due: '2026-08-10T09:00:00+09:00' }), // 持ち越し
        card({ due: '2026-08-19T22:00:00+09:00' }), // 今日
        card({ due: '2026-08-20T09:00:00+09:00' }), // 明日
        card({ due: '2026-08-25T09:00:00+09:00' }), // 6 日後
        card({ due: '2026-08-26T09:00:00+09:00' }), // 7 日後 = 範囲外
      ],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.forecast).toHaveLength(7)
    expect(agg.forecast[0]).toBe(2)
    expect(agg.forecast[0]).toBe(agg.reviewDueToday)
    expect(agg.forecast[1]).toBe(1)
    expect(agg.forecast[6]).toBe(1)
    expect(agg.forecast.reduce((a, b) => a + b, 0)).toBe(4)
  })

  it('未学習は今日のバーに入らない(R-5: 新規は生成時点で即 due)', () => {
    const agg = aggregateHomeCards({
      cards: [
        card({ state: 0, due: '2026-08-19T09:00:00+09:00' }),
        card({ state: 0, due: '2026-08-01T09:00:00+09:00' }),
      ],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.forecast[0]).toBe(0)
    expect(agg.forecastPopulation).toBe(0)
  })

  it('forecastPopulation = state!==0 のカード数(全 7 バー 0 でも母集合は非 0)', () => {
    const agg = aggregateHomeCards({
      cards: [card({ due: '2026-09-30T09:00:00+09:00' })],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.forecastPopulation).toBe(1)
    expect(agg.forecast.every((v) => v === 0)).toBe(true)
  })
})

describe('aggregateHomeCards — W5 母集合(定義 doc §5 W5)', () => {
  it('間違い / 未出題 / 苦手 をそれぞれ数える', () => {
    const agg = aggregateHomeCards({
      cards: [
        card({ answered: true, last_correct: false }),
        card({ answered: false, last_correct: null, state: 0 }),
        card({ state: 2, stability: 5, lapses: 2 }),
        card({ state: 2, stability: 50, lapses: 9 }), // 定着は苦手にしない
      ],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.mistakeCards).toBe(1)
    expect(agg.unansweredCards).toBe(1)
    expect(agg.weakCards).toBe(1)
  })

  it('last_correct 欠落は「間違い」にしない', () => {
    const agg = aggregateHomeCards({
      cards: [card({ answered: true, last_correct: undefined })],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.mistakeCards).toBe(0)
  })
})

describe('aggregateHomeCards — 他試験 1 行(spec §3.1)', () => {
  it('選択試験以外の n を合計する', () => {
    const agg = aggregateHomeCards({
      cards: [
        card({ due: '2026-08-19T09:00:00+09:00' }),
        card({ exam_id: 'exam-2', due: '2026-08-19T09:00:00+09:00' }),
        card({ exam_id: 'exam-3', due: '2026-08-10T09:00:00+09:00' }),
        card({ exam_id: 'exam-3', due: '2026-08-25T09:00:00+09:00' }), // 今日以降
        card({ exam_id: 'exam-3', state: 0, due: '2026-08-19T09:00:00+09:00' }),
      ],
      examId: EXAM,
      now: NOW,
    })
    expect(agg.otherExamsReviewDueToday).toBe(2)
  })
})
