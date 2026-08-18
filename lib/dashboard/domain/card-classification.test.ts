// card-classification pin。定義 doc §4-A/B/C(3 区分 MECE)+ §4-D(復習の持ち越し・
// pin 4)+ §4-H(苦手カード・pin 10/16)を verify する。

import { describe, expect, it } from 'vitest'
import { jstDayRange, todayInJst } from '@/lib/jst'
import {
  classifyCard,
  isCarryover,
  isCarryoverAt,
  isMistake,
  isUnanswered,
  isWeak,
  type CardClassificationInput,
} from './card-classification'

function card(
  overrides: Partial<CardClassificationInput> = {},
): CardClassificationInput {
  return {
    state: 0,
    stability: 0,
    due: new Date('2026-08-01T00:00:00Z'),
    lapses: 0,
    answered: false,
    last_correct: null,
    ...overrides,
  }
}

describe('classifyCard (3 区分 MECE)', () => {
  it('state=0 は new', () => {
    expect(classifyCard(card({ state: 0, stability: 999 }))).toBe('new')
  })
  it('state=1 (Learning) は learning', () => {
    expect(classifyCard(card({ state: 1, stability: 0 }))).toBe('learning')
  })
  it('state=3 (Relearning) は stability によらず learning', () => {
    expect(classifyCard(card({ state: 3, stability: 999 }))).toBe('learning')
  })
  it('state=2 (Review) かつ stability < S_MATURE(21) は learning', () => {
    expect(classifyCard(card({ state: 2, stability: 20.999 }))).toBe(
      'learning',
    )
  })
  it('state=2 かつ stability = S_MATURE(21) ちょうどは mature(>= 境界)', () => {
    expect(classifyCard(card({ state: 2, stability: 21 }))).toBe('mature')
  })
  it('state=2 かつ stability > S_MATURE は mature', () => {
    expect(classifyCard(card({ state: 2, stability: 100 }))).toBe('mature')
  })
})

describe('isCarryover (定義 doc §4-D・pin 4)', () => {
  const now = new Date('2026-08-18T12:00:00+09:00') // JST 2026-08-18 12:00
  const todayStartJst = new Date('2026-08-18T00:00:00+09:00')

  it('pin 4: 未学習(state=0)は due がどれだけ過去でも持ち越しに入らない', () => {
    expect(
      isCarryover(
        card({ state: 0, due: new Date('2000-01-01T00:00:00Z') }),
        now,
      ),
    ).toBe(false)
  })

  it('state !== 0 かつ due が今日の開始より過去なら持ち越し', () => {
    expect(
      isCarryover(
        card({ state: 2, due: new Date('2026-08-17T23:59:59+09:00') }),
        now,
      ),
    ).toBe(true)
  })

  it('境界: due === 今日の開始ちょうどは持ち越しに含めない(厳密 <)', () => {
    expect(isCarryover(card({ state: 2, due: todayStartJst }), now)).toBe(
      false,
    )
  })

  it('due が今日の開始より後(未来)は持ち越しでない', () => {
    expect(
      isCarryover(
        card({ state: 1, due: new Date('2026-08-18T00:00:01+09:00') }),
        now,
      ),
    ).toBe(false)
  })

  it('due が ISO 文字列(Dexie の表現)でも Date と同じ結果になる', () => {
    expect(
      isCarryover(card({ state: 2, due: '2026-08-17T23:59:59+09:00' }), now),
    ).toBe(true)
  })

  it('fix round 1/5 M-4: isCarryoverAt(事前計算 boundary 版)は isCarryover(now 版)と同じ結果', () => {
    // 呼び出し元がループ外で 1 度だけ boundary を計算する想定(T11 の per-card 走査想定)。
    const todayStart = jstDayRange(todayInJst(now)).startAt
    const overdue = card({ state: 2, due: new Date('2026-08-17T23:59:59+09:00') })
    const notOverdueNew = card({ state: 0, due: new Date('2000-01-01T00:00:00Z') })
    expect(isCarryoverAt(overdue, todayStart)).toBe(isCarryover(overdue, now))
    expect(isCarryoverAt(notOverdueNew, todayStart)).toBe(
      isCarryover(notOverdueNew, now),
    )
    expect(isCarryoverAt(overdue, todayStart)).toBe(true)
    expect(isCarryoverAt(notOverdueNew, todayStart)).toBe(false)
  })
})

describe('isMistake / isUnanswered (定義 doc §4-E/§4-F)', () => {
  it('answered かつ last_correct=false は間違い', () => {
    expect(isMistake(card({ answered: true, last_correct: false }))).toBe(
      true,
    )
  })
  it('answered かつ last_correct=true は間違いでない', () => {
    expect(isMistake(card({ answered: true, last_correct: true }))).toBe(
      false,
    )
  })
  it('未回答は間違いでない(未出題)', () => {
    expect(
      isMistake(card({ answered: false, last_correct: null })),
    ).toBe(false)
    expect(isUnanswered(card({ answered: false }))).toBe(true)
    expect(isUnanswered(card({ answered: true }))).toBe(false)
  })
})

describe('isWeak (定義 doc §4-H・pin 10/16)', () => {
  it('pin 10: Review 到達・未定着(stability < S_MATURE)・lapses >= 2 は苦手', () => {
    expect(
      isWeak(card({ state: 2, stability: 10, lapses: 2 })),
    ).toBe(true)
  })

  it('pin 10: lapses < 2 は苦手でない', () => {
    expect(
      isWeak(card({ state: 2, stability: 10, lapses: 1 })),
    ).toBe(false)
  })

  it('pin 16: 定着カード(stability >= S_MATURE)は lapses が高くても苦手でない(!定着)', () => {
    expect(
      isWeak(card({ state: 2, stability: 50, lapses: 10 })),
    ).toBe(false)
  })

  it('lapses = 0 は苦手でない(境界)', () => {
    expect(isWeak(card({ state: 2, stability: 10, lapses: 0 }))).toBe(false)
  })
})
