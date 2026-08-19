// quick-preset-selection の unit test(design doc §7 / 定義 doc W5 の契約 pin)。
//
// 本 file が pin するのは「preset ごとの母集合述語・並び順・cap 計算・10分の件数
// 計算・origin 導出」であって、Dexie からの読み方は `get-quick-preset-cards.test.ts`
// (I/O 層)が担当する。

import { describe, it, expect } from 'vitest'
import {
  ESTIMATE_DEFAULT_MS,
  QUICK_PRESET_N,
} from '@/lib/dashboard/domain/metric-constants'
import {
  deriveQuickOrigin,
  effectivePresetCount,
  isQuickPreset,
  quickOrderKindFor,
  selectQuickPresetPopulation,
  sortQuickCandidates,
  tenMinCount,
  type QuickPresetCard,
} from './quick-preset-selection'

// JST 2026-08-18 12:00。今日の JST 範囲 = [2026-08-17T15:00Z, 2026-08-18T15:00Z)。
const NOW = new Date('2026-08-18T03:00:00.000Z')
const YESTERDAY = '2026-08-17T03:00:00.000Z'
const TODAY_EARLY = '2026-08-18T00:00:00.000Z'
const TODAY_LATE = '2026-08-18T09:00:00.000Z'

const EXAM = 'exam-1'
const OTHER_EXAM = 'exam-2'

function card(id: string, overrides: Partial<QuickPresetCard> = {}): QuickPresetCard {
  return {
    id,
    exam_id: EXAM,
    state: 2,
    due: YESTERDAY,
    base_order: 1024,
    first_reviewed_at: null,
    stability: 30, // S_MATURE(21)以上 = 定着(既定は「苦手」判定に影響させない)
    lapses: 0,
    answered: true,
    last_correct: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// isQuickPreset
// ---------------------------------------------------------------------------

describe('isQuickPreset', () => {
  it('4 値はすべて true', () => {
    expect(isQuickPreset('mistakes')).toBe(true)
    expect(isQuickPreset('unanswered')).toBe(true)
    expect(isQuickPreset('weak')).toBe(true)
    expect(isQuickPreset('ten_min')).toBe(true)
  })

  it('未知値・空文字は false', () => {
    expect(isQuickPreset('')).toBe(false)
    expect(isQuickPreset('custom')).toBe(false)
    expect(isQuickPreset('mistake')).toBe(false) // typo
  })
})

// ---------------------------------------------------------------------------
// selectQuickPresetPopulation — 母集合述語(定義 doc §4-E/F/H)
// ---------------------------------------------------------------------------

describe('selectQuickPresetPopulation — mistakes(§4-E)', () => {
  it('answered=true && last_correct=false のみ', () => {
    const cards = [
      card('mistake', { answered: true, last_correct: false }),
      card('correct', { answered: true, last_correct: true }),
      card('unanswered', { answered: false, last_correct: null }),
    ]
    const out = selectQuickPresetPopulation({
      cards,
      examId: EXAM,
      preset: 'mistakes',
      dailyNewTarget: null,
      now: NOW,
    })
    expect(out.map((c) => c.id)).toEqual(['mistake'])
  })

  it('last_correct が undefined(Dexie 実体の optional 欠落)でも例外なく除外される', () => {
    const cards = [card('no-last-correct', { answered: true, last_correct: undefined })]
    const out = selectQuickPresetPopulation({
      cards,
      examId: EXAM,
      preset: 'mistakes',
      dailyNewTarget: null,
      now: NOW,
    })
    expect(out).toEqual([])
  })

  it('選択試験外のカードは含まれない', () => {
    const cards = [
      card('mine', { exam_id: EXAM, answered: true, last_correct: false }),
      card('other', { exam_id: OTHER_EXAM, answered: true, last_correct: false }),
    ]
    const out = selectQuickPresetPopulation({
      cards,
      examId: EXAM,
      preset: 'mistakes',
      dailyNewTarget: null,
      now: NOW,
    })
    expect(out.map((c) => c.id)).toEqual(['mine'])
  })
})

describe('selectQuickPresetPopulation — unanswered(§4-F)', () => {
  it('answered=false のみ', () => {
    const cards = [
      card('un', { answered: false, last_correct: null }),
      card('answered', { answered: true, last_correct: true }),
    ]
    const out = selectQuickPresetPopulation({
      cards,
      examId: EXAM,
      preset: 'unanswered',
      dailyNewTarget: null,
      now: NOW,
    })
    expect(out.map((c) => c.id)).toEqual(['un'])
  })
})

describe('selectQuickPresetPopulation — weak(§4-H)', () => {
  it('lapses >= 2 && !定着 のみ', () => {
    const cards = [
      card('weak', { lapses: 2, state: 1, stability: 5 }),
      card('lapses-but-mature', { lapses: 5, state: 2, stability: 30 }),
      card('lapses-1', { lapses: 1, state: 1, stability: 5 }),
    ]
    const out = selectQuickPresetPopulation({
      cards,
      examId: EXAM,
      preset: 'weak',
      dailyNewTarget: null,
      now: NOW,
    })
    expect(out.map((c) => c.id)).toEqual(['weak'])
  })
})

describe('selectQuickPresetPopulation — ten_min(母集合 = W2 の n+k)', () => {
  it('selectSessionPool の pool をそのまま母集合として使う(new は base_order 経由で k 件まで)', () => {
    const cards = [
      card('review-later-today', { state: 2, due: TODAY_LATE }),
      card('new-a', { state: 0, base_order: 1024, due: YESTERDAY }),
      card('new-b', { state: 0, base_order: 2048, due: YESTERDAY }),
      card('other-exam-review', { exam_id: OTHER_EXAM, state: 2, due: TODAY_EARLY }),
    ]
    const out = selectQuickPresetPopulation({
      cards,
      examId: EXAM,
      preset: 'ten_min',
      dailyNewTarget: null, // DAILY_NEW_DEFAULT(20)が採用される
      now: NOW,
    })
    expect(out.map((c) => c.id).sort()).toEqual(
      ['review-later-today', 'new-a', 'new-b'].sort(),
    )
  })

  it('dailyNewTarget=0 → 新規部が 0 件(既存 k の意味論そのまま)', () => {
    const cards = [card('new-a', { state: 0 })]
    const out = selectQuickPresetPopulation({
      cards,
      examId: EXAM,
      preset: 'ten_min',
      dailyNewTarget: 0,
      now: NOW,
    })
    expect(out).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 並び順(§4 W5「選出規則」)
// ---------------------------------------------------------------------------

describe('quickOrderKindFor', () => {
  it('unanswered のみ base_order、他は due', () => {
    expect(quickOrderKindFor('unanswered')).toBe('base_order')
    expect(quickOrderKindFor('mistakes')).toBe('due')
    expect(quickOrderKindFor('weak')).toBe('due')
    expect(quickOrderKindFor('ten_min')).toBe('due')
  })
})

describe('sortQuickCandidates — due ASC + id tiebreak', () => {
  it('due 昇順、同値は id 昇順', () => {
    const cards = [
      card('b', { due: TODAY_EARLY }),
      card('a', { due: TODAY_EARLY }), // due 同値 → id tiebreak
      card('z', { due: YESTERDAY }),
    ]
    const out = sortQuickCandidates('due', cards)
    expect(out.map((c) => c.id)).toEqual(['z', 'a', 'b'])
  })

  it('入力配列を破壊しない', () => {
    const cards = [card('b', { due: TODAY_EARLY }), card('a', { due: YESTERDAY })]
    const original = [...cards]
    sortQuickCandidates('due', cards)
    expect(cards).toEqual(original)
  })
})

describe('sortQuickCandidates — base_order ASC + id tiebreak(未出題専用)', () => {
  it('base_order 昇順、同値は id 昇順', () => {
    const cards = [
      card('b', { base_order: 100 }),
      card('a', { base_order: 100 }),
      card('z', { base_order: 50 }),
    ]
    const out = sortQuickCandidates('base_order', cards)
    expect(out.map((c) => c.id)).toEqual(['z', 'a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// effectivePresetCount(cap 優先規則)
// ---------------------------------------------------------------------------

describe('effectivePresetCount', () => {
  it('sessionLimit=null(上限なし)→ defaultCount をそのまま使う', () => {
    expect(effectivePresetCount(QUICK_PRESET_N, null)).toBe(QUICK_PRESET_N)
  })

  it('sessionLimit が defaultCount より小さい → sessionLimit が勝つ', () => {
    expect(effectivePresetCount(QUICK_PRESET_N, 5)).toBe(5)
  })

  it('sessionLimit が defaultCount 以上 → defaultCount のまま(制限しない)', () => {
    expect(effectivePresetCount(QUICK_PRESET_N, 20)).toBe(QUICK_PRESET_N)
    expect(effectivePresetCount(QUICK_PRESET_N, QUICK_PRESET_N)).toBe(QUICK_PRESET_N)
  })
})

// ---------------------------------------------------------------------------
// tenMinCount(定義 doc §4-N + W5「10分」)
// ---------------------------------------------------------------------------

describe('tenMinCount', () => {
  it('通常の中央値(30秒)→ floor(600000/30000) = 20', () => {
    expect(tenMinCount(30_000)).toBe(20)
  })

  it('既定値(標本 0 件・20秒)→ floor(600000/20000) = 30', () => {
    expect(tenMinCount(ESTIMATE_DEFAULT_MS)).toBe(30)
  })

  it('1 問 10 分超の遅い中央値でも 0 にならず 1 になる(max(1, …)の床)', () => {
    expect(tenMinCount(700_000)).toBe(1)
  })

  it('ちょうど 600,000ms の中央値 → 1', () => {
    expect(tenMinCount(600_000)).toBe(1)
  })

  it('600,000 の丁度割り切れない境界(floor の切り捨てを確認)', () => {
    // 600000 / 100000 = 6 ちょうど
    expect(tenMinCount(100_000)).toBe(6)
    // 600000 / 100001 は 6 未満(floor で 5)
    expect(tenMinCount(100_001)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// deriveQuickOrigin(§11.1 の preset ↔ origin 1:1 対応)
// ---------------------------------------------------------------------------

describe('deriveQuickOrigin', () => {
  it('preset ごとに 1:1 対応する origin を返す', () => {
    expect(deriveQuickOrigin('mistakes')).toBe('home_quick_mistakes')
    expect(deriveQuickOrigin('unanswered')).toBe('home_quick_unanswered')
    expect(deriveQuickOrigin('weak')).toBe('home_quick_weak')
    expect(deriveQuickOrigin('ten_min')).toBe('home_quick_10min')
  })
})
