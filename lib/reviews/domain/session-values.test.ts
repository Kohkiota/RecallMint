import { describe, it, expect } from 'vitest'
import { canApplyStatusWrite, type SessionStatus } from './session-values'

// 遷移規則の正 = brief 参照事実 A / spec §3.1・§6.1。
// fresh insert (行なし) は遷移概念なしゆえ関数の対象外 (規則は conflict 時のみ)。
// 下記 9 組 (#2-#10) を機械列挙して現行遷移規則を pin する。
describe('canApplyStatusWrite', () => {
  const cases: Array<{
    n: number
    current: SessionStatus
    incoming: SessionStatus
    expected: boolean
  }> = [
    { n: 2, current: 'active', incoming: 'active', expected: true },
    { n: 3, current: 'active', incoming: 'completed', expected: true },
    { n: 4, current: 'active', incoming: 'abandoned', expected: true },
    { n: 5, current: 'completed', incoming: 'completed', expected: true },
    { n: 6, current: 'completed', incoming: 'active', expected: false },
    { n: 7, current: 'completed', incoming: 'abandoned', expected: false },
    { n: 8, current: 'abandoned', incoming: 'abandoned', expected: true },
    { n: 9, current: 'abandoned', incoming: 'active', expected: false },
    { n: 10, current: 'abandoned', incoming: 'completed', expected: false },
  ]

  for (const { n, current, incoming, expected } of cases) {
    it(`#${n} ${current} → ${incoming} = ${expected}`, () => {
      expect(canApplyStatusWrite(current, incoming)).toBe(expected)
    })
  }

  it('active からはあらゆる incoming を許可する (前進・abandoned 化・active 再送)', () => {
    const all: SessionStatus[] = ['active', 'completed', 'abandoned']
    for (const incoming of all) {
      expect(canApplyStatusWrite('active', incoming)).toBe(true)
    }
  })

  it('terminal からは同一 status のみ許可する (冪等再送のみ true)', () => {
    const terminals: SessionStatus[] = ['completed', 'abandoned']
    const all: SessionStatus[] = ['active', 'completed', 'abandoned']
    for (const current of terminals) {
      for (const incoming of all) {
        expect(canApplyStatusWrite(current, incoming)).toBe(incoming === current)
      }
    }
  })
})
