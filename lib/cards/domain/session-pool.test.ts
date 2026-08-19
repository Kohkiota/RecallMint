// session-pool の unit test(Dash-1 Home v1 §8.4 / §8.5 の契約 pin)。
//
// 本 file が pin するのは「どのカードがプールに入るか・どの順で並ぶか・新規を何件で
// 打ち切るか・いつ出せるようになるか」であって、呼出側の行の読み方(Dexie index /
// SQL 述語)は pin しない(それは各経路の test と同値性 test の担当)。

import { describe, it, expect } from 'vitest'
import { DAILY_NEW_DEFAULT } from '@/lib/dashboard/domain/metric-constants'
import { selectSessionPool, type SessionPoolCard } from './session-pool'

// JST 2026-08-18 12:00。今日の JST 範囲 = [2026-08-17T15:00Z, 2026-08-18T15:00Z)。
const NOW = new Date('2026-08-18T03:00:00.000Z')
const TODAY_START = '2026-08-17T15:00:00.000Z'
const TODAY_END = '2026-08-18T15:00:00.000Z'
const LATER_TODAY = '2026-08-18T09:00:00.000Z' // JST 18:00(now より後・今日のうち)
const EARLIER_TODAY = '2026-08-18T00:00:00.000Z' // JST 09:00(now より前)
const YESTERDAY = '2026-08-17T03:00:00.000Z'

const EXAM = 'exam-1'
const OTHER_EXAM = 'exam-2'

type PoolCard = SessionPoolCard & { due: string }

function card(id: string, overrides: Partial<PoolCard> = {}): PoolCard {
  return {
    id,
    exam_id: EXAM,
    state: 2,
    due: YESTERDAY,
    base_order: 1024,
    first_reviewed_at: null,
    ...overrides,
  }
}

function poolIds(
  cards: PoolCard[],
  dailyNewTarget: number | null = null,
  now: Date = NOW,
): string[] {
  return selectSessionPool({ cards, examId: EXAM, dailyNewTarget, now }).pool.map(
    (c) => c.id,
  )
}

describe('selectSessionPool — 復習部の state 別条件(§8.5)', () => {
  it('Review(state 2)の当日 later-due は前倒しで入る', () => {
    expect(poolIds([card('r', { state: 2, due: LATER_TODAY })])).toEqual(['r'])
  })

  it('Learning(state 1)の未到来 step は入らない', () => {
    expect(poolIds([card('l', { state: 1, due: LATER_TODAY })])).toEqual([])
  })

  it('Relearning(state 3)の未到来 step は入らない', () => {
    expect(poolIds([card('rl', { state: 3, due: LATER_TODAY })])).toEqual([])
  })

  it('Learning / Relearning は due <= now なら入る(境界 due == now を含む)', () => {
    const cards = [
      card('l-now', { state: 1, due: NOW.toISOString() }),
      card('rl-past', { state: 3, due: EARLIER_TODAY }),
    ]
    expect(poolIds(cards).sort()).toEqual(['l-now', 'rl-past'])
  })

  it('Review の due が今日の終わり(JST 翌 0:00)ちょうど以降なら入らない', () => {
    const cards = [
      card('in', { state: 2, due: '2026-08-18T14:59:59.999Z' }),
      card('out', { state: 2, due: TODAY_END }),
    ]
    expect(poolIds(cards)).toEqual(['in'])
  })

  it('復習部は due ASC・同 due は id ASC で並ぶ', () => {
    const cards = [
      card('c', { state: 2, due: LATER_TODAY }),
      card('b', { state: 2, due: YESTERDAY }),
      card('a', { state: 2, due: YESTERDAY }),
    ]
    expect(poolIds(cards)).toEqual(['a', 'b', 'c'])
  })

  it('due / first_reviewed_at は Date 表現でも ISO 文字列と同じ結果になる', () => {
    const asDate: SessionPoolCard[] = [
      { ...card('r', { state: 2 }), due: new Date(LATER_TODAY) },
      { ...card('l', { state: 1 }), due: new Date(LATER_TODAY) },
    ]
    const result = selectSessionPool({
      cards: asDate,
      examId: EXAM,
      dailyNewTarget: null,
      now: NOW,
    })
    expect(result.pool.map((c) => c.id)).toEqual(['r'])
  })
})

describe('selectSessionPool — 新規部(§8.4 / daily-new-limit)', () => {
  const newCards = [
    card('n3', { state: 0, base_order: 3072 }),
    card('n1', { state: 0, base_order: 1024 }),
    card('n2', { state: 0, base_order: 2048 }),
  ]

  it('新規は base_order ASC で k 件のみ入る(k+1 件目は入らない)', () => {
    expect(poolIds(newCards, 2)).toEqual(['n1', 'n2'])
  })

  it('同 base_order は id ASC で決定的に並ぶ', () => {
    const ties = [
      card('nb', { state: 0, base_order: 1024 }),
      card('na', { state: 0, base_order: 1024 }),
    ]
    expect(poolIds(ties, 2)).toEqual(['na', 'nb'])
  })

  it('K = 0 なら新規は 1 件も入らない', () => {
    expect(poolIds(newCards, 0)).toEqual([])
  })

  it('K = null は DAILY_NEW_DEFAULT に追従する', () => {
    const many = Array.from({ length: DAILY_NEW_DEFAULT + 1 }, (_, i) =>
      card(`n${String(i).padStart(2, '0')}`, {
        state: 0,
        base_order: (i + 1) * 1024,
      }),
    )
    expect(poolIds(many, null)).toHaveLength(DAILY_NEW_DEFAULT)
  })

  it('u(当日導入)は当日分だけ枠を消費する — 昨日導入は消費しない', () => {
    const cards = [
      ...newCards,
      // 今日導入 = 1 件(残り枠 K−u = 1)
      card('today', { state: 1, due: YESTERDAY, first_reviewed_at: EARLIER_TODAY }),
      // 昨日導入 = 枠を消費しない
      card('yday', { state: 2, due: YESTERDAY, first_reviewed_at: YESTERDAY }),
    ]
    const ids = poolIds(cards, 2)
    expect(ids.filter((id) => id.startsWith('n'))).toEqual(['n1'])
  })

  it('u が K 以上なら残り枠は 0 に clamp される(負にならない)', () => {
    const cards = [
      ...newCards,
      card('i1', { state: 2, first_reviewed_at: EARLIER_TODAY }),
      card('i2', { state: 2, first_reviewed_at: EARLIER_TODAY }),
      card('i3', { state: 2, first_reviewed_at: EARLIER_TODAY }),
    ]
    const ids = poolIds(cards, 2)
    expect(ids.filter((id) => id.startsWith('n'))).toEqual([])
  })

  it('first_reviewed_at の日界は今日の開始ちょうどを含み、今日の終わりを含まない', () => {
    const cards = [
      ...newCards,
      card('start', { state: 2, first_reviewed_at: TODAY_START }),
      card('end', { state: 2, first_reviewed_at: TODAY_END }),
    ]
    // 今日導入は 'start' の 1 件のみ → 残り枠 2−1 = 1
    expect(poolIds(cards, 2).filter((id) => id.startsWith('n'))).toEqual(['n1'])
  })

  it('復習部が先・新規部が後の連結順になる', () => {
    const cards = [
      card('n1', { state: 0, base_order: 1024 }),
      card('r1', { state: 2, due: YESTERDAY }),
    ]
    expect(poolIds(cards, 5)).toEqual(['r1', 'n1'])
  })
})

describe('selectSessionPool — 件数の戻り値(W2 と同じ値を 1 回の呼出で返す)', () => {
  it('reviewCount / newCount は復習部・新規部の件数と一致する', () => {
    const cards = [
      card('r1', { state: 2, due: YESTERDAY }),
      card('r2', { state: 2, due: LATER_TODAY }),
      card('n1', { state: 0, base_order: 1024 }),
      card('n2', { state: 0, base_order: 2048 }),
    ]
    const result = selectSessionPool({
      cards,
      examId: EXAM,
      dailyNewTarget: 1,
      now: NOW,
    })
    expect(result.reviewCount).toBe(2)
    expect(result.newCount).toBe(1)
    expect(result.pool).toHaveLength(3)
  })
})

describe('selectSessionPool — nextAvailableAt(§8.5 r2)', () => {
  it('未到来の Learning / Relearning のうち最小 due を返す', () => {
    const cards = [
      card('l-late', { state: 1, due: '2026-08-18T10:00:00.000Z' }),
      card('l-soon', { state: 3, due: '2026-08-18T04:00:00.000Z' }),
      card('l-ready', { state: 1, due: EARLIER_TODAY }),
    ]
    const result = selectSessionPool({
      cards,
      examId: EXAM,
      dailyNewTarget: 0,
      now: NOW,
    })
    expect(result.pool.map((c) => c.id)).toEqual(['l-ready'])
    expect(result.nextAvailableAt?.toISOString()).toBe('2026-08-18T04:00:00.000Z')
  })

  it('未到来の短期 step が無ければ null', () => {
    const cards = [
      card('r-later', { state: 2, due: LATER_TODAY }),
      card('l-ready', { state: 1, due: EARLIER_TODAY }),
      card('n1', { state: 0 }),
    ]
    const result = selectSessionPool({
      cards,
      examId: EXAM,
      dailyNewTarget: 5,
      now: NOW,
    })
    expect(result.nextAvailableAt).toBeNull()
  })

  it('翌日以降 due の Review は nextAvailableAt に含めない(今日の対象ではない)', () => {
    const cards = [card('r-tomorrow', { state: 2, due: TODAY_END })]
    const result = selectSessionPool({
      cards,
      examId: EXAM,
      dailyNewTarget: 0,
      now: NOW,
    })
    expect(result.pool).toEqual([])
    expect(result.nextAvailableAt).toBeNull()
  })
})

describe('selectSessionPool — 試験スコープ(§8.5)', () => {
  it('別試験の due card はプールにも件数にも入らない', () => {
    const cards = [
      card('mine', { state: 2, due: YESTERDAY }),
      card('other-review', { exam_id: OTHER_EXAM, state: 2, due: YESTERDAY }),
      card('other-new', { exam_id: OTHER_EXAM, state: 0, base_order: 1 }),
    ]
    const result = selectSessionPool({
      cards,
      examId: EXAM,
      dailyNewTarget: 5,
      now: NOW,
    })
    expect(result.pool.map((c) => c.id)).toEqual(['mine'])
    expect(result.reviewCount).toBe(1)
    expect(result.newCount).toBe(0)
  })

  it('別試験の未到来 Learning は nextAvailableAt を動かさない', () => {
    const cards = [
      card('other-l', {
        exam_id: OTHER_EXAM,
        state: 1,
        due: '2026-08-18T04:00:00.000Z',
      }),
      card('mine-l', { state: 1, due: '2026-08-18T10:00:00.000Z' }),
    ]
    const result = selectSessionPool({
      cards,
      examId: EXAM,
      dailyNewTarget: 0,
      now: NOW,
    })
    expect(result.nextAvailableAt?.toISOString()).toBe('2026-08-18T10:00:00.000Z')
  })

  it('別試験の当日導入は当試験の枠を消費しない', () => {
    const cards = [
      card('n1', { state: 0, base_order: 1024 }),
      card('other-introduced', {
        exam_id: OTHER_EXAM,
        state: 2,
        first_reviewed_at: EARLIER_TODAY,
      }),
    ]
    expect(poolIds(cards, 1)).toEqual(['n1'])
  })
})
