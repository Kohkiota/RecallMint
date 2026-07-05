// @vitest-environment jsdom
// column-pinning.test.ts — S5-1 unit test。
// examCardTableColumns を import する column-pinning.ts 経由で React component が
// 連鎖するため jsdom 環境を指定(card-filter-predicates 等の純 node _lib と異なる)。
//
// 完了条件 (a)(b):
// (a) computePinnedLeft: 通常 / null / 未知 id / 最終列
// (b) derivePinnedBoundary: 通常 / 空 / select 単独 / undefined / 往復同一性

import { describe, it, expect } from 'vitest'
import { computePinnedLeft, derivePinnedBoundary } from './column-pinning'

// brief §完了条件 (a) で定義された期待 id 一覧(列順の確認に使用)
const ALL_IDS = [
  'select',
  'title',
  'sort_key',
  'question',
  'options',
  'tags',
  'explanation_text',
  'memo',
  'lastCorrect',
  'currentStreak',
  'lastReview',
]

// ---------------------------------------------------------------------------
// (a) computePinnedLeft
// ---------------------------------------------------------------------------

describe('computePinnedLeft', () => {
  it("'tags' → select〜tags の 6 id", () => {
    expect(computePinnedLeft('tags')).toEqual([
      'select',
      'title',
      'sort_key',
      'question',
      'options',
      'tags',
    ])
  })

  it("'title' → ['select','title']", () => {
    expect(computePinnedLeft('title')).toEqual(['select', 'title'])
  })

  it('null → []', () => {
    expect(computePinnedLeft(null)).toEqual([])
  })

  it("未知 id 'nonexistent' → []", () => {
    expect(computePinnedLeft('nonexistent')).toEqual([])
  })

  it("最終列 'lastReview' → 全 11 id", () => {
    expect(computePinnedLeft('lastReview')).toEqual(ALL_IDS)
  })

  // select 自身を boundary に指定した場合 — ['select'] を返す(駆動経路は menu 経由で
  // 発生しないが computePinnedLeft の一般動作として仕様通りに返す)。
  it("'select' → ['select']", () => {
    expect(computePinnedLeft('select')).toEqual(['select'])
  })
})

// ---------------------------------------------------------------------------
// (b) derivePinnedBoundary
// ---------------------------------------------------------------------------

describe('derivePinnedBoundary', () => {
  it("{left: ['select','title'], right: []} → 'title'", () => {
    expect(derivePinnedBoundary({ left: ['select', 'title'], right: [] })).toBe('title')
  })

  it('{left: [], right: []} → null', () => {
    expect(derivePinnedBoundary({ left: [], right: [] })).toBeNull()
  })

  it("{left: ['select'], right: []} → null (末尾 'select')", () => {
    expect(derivePinnedBoundary({ left: ['select'], right: [] })).toBeNull()
  })

  it('left: undefined → null', () => {
    expect(derivePinnedBoundary({ right: [] })).toBeNull()
  })

  // 往復同一性: 'select' は derivePinnedBoundary が null を返す列(末尾 select → null ルール)
  // のため除外。それ以外の全列は computePinnedLeft → derivePinnedBoundary が恒等。
  it('往復同一性: select を除く全列 id で computePinnedLeft→derivePinnedBoundary が恒等', () => {
    const testIds = ALL_IDS.filter((id) => id !== 'select')
    for (const id of testIds) {
      const pinned = computePinnedLeft(id)
      const boundary = derivePinnedBoundary({ left: pinned, right: [] })
      expect(boundary, `id=${id} の往復`).toBe(id)
    }
  })
})
