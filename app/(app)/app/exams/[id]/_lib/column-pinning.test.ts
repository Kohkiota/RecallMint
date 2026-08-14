// @vitest-environment jsdom
// column-pinning.test.ts — S5-1 unit test。
// examCardTableColumns を import する column-pinning.ts 経由で React component が
// 連鎖するため jsdom 環境を指定(card-filter-predicates 等の純 node _lib と異なる)。
//
// 完了条件 (a)(b):
// (a) computePinnedLeft: 通常 / null / 未知 id / 最終列
// (b) derivePinnedBoundary: 通常 / 空 / select 単独 / undefined / 往復同一性

import { describe, it, expect, vi } from 'vitest'
// column-pinning.ts → exam-card-table-columns.ts → inline-card-list.tsx →
// card-editor-fields.tsx → card-image-gallery.tsx が '../_actions/asset-actions' (server
// action) を import する。 実 module は lib/storage/r2.ts の R2_* env fail-fast を経由し、
// vitest.setup.ts は R2_* を供給しないため未 mock だと module load 時に throw する
// (画像フェーズ A Task 10)。 本 test は pinning 純ロジックのみ検証するため最小 stub。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: vi.fn(async () => null),
}))

import { computePinnedLeft, derivePinnedBoundary } from './column-pinning'

// brief §完了条件 (a) で定義された期待 id 一覧(列順の確認に使用)
const ALL_IDS = [
  'select',
  'title',
  'question_label',
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
      'question_label',
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
