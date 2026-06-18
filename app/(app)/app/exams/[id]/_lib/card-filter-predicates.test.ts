// card-filter-predicates unit test (Grid-2 T3)。
// 純関数 3 種の評価ロジックを検証する (副作用なし、 環境非依存 = node 環境で OK)。

import { describe, it, expect } from 'vitest'
import {
  matchesTagFilter,
  matchesAnswerState,
  matchesStreakFilter,
  type TagFilterValue,
  type StreakFilterValue,
} from './card-filter-predicates'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tag(catId: string, optId: string) {
  return { category: { id: catId }, option: { id: optId } }
}

// ===========================================================================
// case 1: tag カテゴリ内 OR
// ===========================================================================

describe('matchesTagFilter — カテゴリ内 OR', () => {
  const filter: TagFilterValue = { catA: ['o1', 'o2'] }

  it('o1 を持つ row は pass', () => {
    expect(matchesTagFilter([tag('catA', 'o1')], filter)).toBe(true)
  })

  it('o2 を持つ row は pass', () => {
    expect(matchesTagFilter([tag('catA', 'o2')], filter)).toBe(true)
  })

  it('o1/o2 どちらも持たない row は fail', () => {
    expect(matchesTagFilter([tag('catA', 'o3')], filter)).toBe(false)
  })

  it('別カテゴリの o1 (catB) は fail (category id も一致が必要)', () => {
    expect(matchesTagFilter([tag('catB', 'o1')], filter)).toBe(false)
  })
})

// ===========================================================================
// case 2: tag カテゴリ間 AND
// ===========================================================================

describe('matchesTagFilter — カテゴリ間 AND', () => {
  const filter: TagFilterValue = { catA: ['o1'], catB: ['o3'] }

  it('o1 かつ o3 を両方持つ row のみ pass', () => {
    expect(matchesTagFilter([tag('catA', 'o1'), tag('catB', 'o3')], filter)).toBe(true)
  })

  it('o1 のみ (o3 なし) は fail', () => {
    expect(matchesTagFilter([tag('catA', 'o1')], filter)).toBe(false)
  })

  it('o3 のみ (o1 なし) は fail', () => {
    expect(matchesTagFilter([tag('catB', 'o3')], filter)).toBe(false)
  })
})

// ===========================================================================
// case 2b: 空配列 / 空 filter は絞り込みなし
// ===========================================================================

describe('matchesTagFilter — 空は絞り込みなし', () => {
  it('空 filter は常に pass', () => {
    expect(matchesTagFilter([], {})).toBe(true)
    expect(matchesTagFilter([tag('catA', 'o1')], {})).toBe(true)
  })

  it('空配列カテゴリは pass (絞り込みに数えない)', () => {
    const filter: TagFilterValue = { catA: [] }
    expect(matchesTagFilter([], filter)).toBe(true)
    expect(matchesTagFilter([tag('catB', 'o9')], filter)).toBe(true)
  })

  it('非空カテゴリと空カテゴリの混在 = 非空のみ評価', () => {
    const filter: TagFilterValue = { catA: ['o1'], catB: [] }
    expect(matchesTagFilter([tag('catA', 'o1')], filter)).toBe(true)
    expect(matchesTagFilter([tag('catC', 'o5')], filter)).toBe(false)
  })
})

// ===========================================================================
// case 3: 回答状態 4 値
// ===========================================================================

describe('matchesAnswerState — 4 値', () => {
  it('all は常に true', () => {
    expect(matchesAnswerState({ answered: false, last_correct: null }, 'all')).toBe(true)
    expect(matchesAnswerState({ answered: true, last_correct: true }, 'all')).toBe(true)
  })

  it('unanswered は answered===false のみ', () => {
    expect(matchesAnswerState({ answered: false, last_correct: null }, 'unanswered')).toBe(true)
    expect(matchesAnswerState({ answered: true, last_correct: true }, 'unanswered')).toBe(false)
  })

  it('correct は last_correct===true のみ', () => {
    expect(matchesAnswerState({ answered: true, last_correct: true }, 'correct')).toBe(true)
    expect(matchesAnswerState({ answered: true, last_correct: false }, 'correct')).toBe(false)
    expect(matchesAnswerState({ answered: false, last_correct: null }, 'correct')).toBe(false)
  })

  it('incorrect は last_correct===false のみ', () => {
    expect(matchesAnswerState({ answered: true, last_correct: false }, 'incorrect')).toBe(true)
    expect(matchesAnswerState({ answered: true, last_correct: true }, 'incorrect')).toBe(false)
    expect(matchesAnswerState({ answered: false, last_correct: null }, 'incorrect')).toBe(false)
  })

  it('last_correct が undefined のとき correct/incorrect は false', () => {
    expect(matchesAnswerState({ answered: true }, 'correct')).toBe(false)
    expect(matchesAnswerState({ answered: true }, 'incorrect')).toBe(false)
  })
})

// ===========================================================================
// case 4: 数値比較
// ===========================================================================

describe('matchesStreakFilter — 数値比較', () => {
  it('lte: value=3 で 0,3 が pass、 4,5 が fail', () => {
    const filter: StreakFilterValue = { op: 'lte', value: 3 }
    expect(matchesStreakFilter(0, filter)).toBe(true)
    expect(matchesStreakFilter(3, filter)).toBe(true)
    expect(matchesStreakFilter(4, filter)).toBe(false)
    expect(matchesStreakFilter(5, filter)).toBe(false)
  })

  it('gte: value=3 で 3,4 が pass、 0,2 が fail', () => {
    const filter: StreakFilterValue = { op: 'gte', value: 3 }
    expect(matchesStreakFilter(3, filter)).toBe(true)
    expect(matchesStreakFilter(4, filter)).toBe(true)
    expect(matchesStreakFilter(2, filter)).toBe(false)
    expect(matchesStreakFilter(0, filter)).toBe(false)
  })

  it('eq: value=3 で 3 のみ pass', () => {
    const filter: StreakFilterValue = { op: 'eq', value: 3 }
    expect(matchesStreakFilter(3, filter)).toBe(true)
    expect(matchesStreakFilter(2, filter)).toBe(false)
    expect(matchesStreakFilter(4, filter)).toBe(false)
  })

  it('null/undefined filter は全 pass', () => {
    expect(matchesStreakFilter(99, null)).toBe(true)
    expect(matchesStreakFilter(0, undefined)).toBe(true)
  })

  it('NaN value は全 pass (未入力扱い)', () => {
    const filter: StreakFilterValue = { op: 'lte', value: NaN }
    expect(matchesStreakFilter(0, filter)).toBe(true)
    expect(matchesStreakFilter(100, filter)).toBe(true)
  })
})

// ===========================================================================
// case 5: 複合 (tag AND 回答状態) を組合せた row 集合
// ===========================================================================

describe('複合フィルタ (tag かつ 回答状態)', () => {
  type Row = {
    tags: Array<{ category: { id: string }; option: { id: string } }>
    card: { answered: boolean; last_correct?: boolean | null }
  }

  const rows: Row[] = [
    { tags: [tag('catA', 'o1')], card: { answered: true, last_correct: true } }, // pass
    { tags: [tag('catA', 'o1')], card: { answered: true, last_correct: false } }, // tag pass / state fail
    { tags: [tag('catA', 'o2')], card: { answered: true, last_correct: true } }, // tag fail / state pass
    { tags: [tag('catA', 'o1')], card: { answered: false, last_correct: null } }, // tag pass / state fail
  ]

  it('tag {catA:[o1]} かつ correct = 先頭 row のみ pass', () => {
    const tagFilter: TagFilterValue = { catA: ['o1'] }
    const passed = rows.filter(
      (r) => matchesTagFilter(r.tags, tagFilter) && matchesAnswerState(r.card, 'correct'),
    )
    expect(passed).toHaveLength(1)
    expect(passed[0]).toBe(rows[0])
  })
})
