// @vitest-environment node
// S2b-1: computeCollapsed 純関数の単体テスト。
// jsdom は scroll 計算不可のため、閾値/hysteresis/guard ロジックを純関数に切り出して直接 test する。
// これが「境界振動バグ」への唯一の unit-level ガード。

import { describe, it, expect, vi } from 'vitest'
// card-editor-fields.tsx → card-image-gallery.tsx が '../_actions/asset-actions' (server
// action) を import する。 実 module は lib/storage/r2.ts の R2_* env fail-fast を経由し、
// vitest.setup.ts は R2_* を供給しないため未 mock だと module load 時に throw する
// (画像フェーズ A Task 10)。 本 test は computeCollapsed 純関数のみ検証するため最小 stub。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: vi.fn(async () => null),
}))

import { computeCollapsed } from './exam-card-table'

// ---------------------------------------------------------------------------
// 引数の意味:
//   scrollTop       — コンテナの現在スクロール量
//   scrollHeight    — コンテナの全スクロール高さ
//   clientHeight    — コンテナの表示高さ
//   middleBandHeight — collapse 対象の帯高合計(chrome + condBarWrapper の実測)
//   current         — 現在の collapsed boolean
//
// 期待動作:
//   scrollTop < 8            → false (expand)
//   scrollTop > 24 AND guard → true  (collapse)
//   それ以外                 → current (hysteresis zone)
//
//   guard = scrollHeight - clientHeight - middleBandHeight >= 8
// ---------------------------------------------------------------------------

describe('computeCollapsed — expand (scrollTop < 8)', () => {
  it('scrollTop=0, current=false → false', () => {
    expect(computeCollapsed(0, 500, 300, 100, false)).toBe(false)
  })

  it('scrollTop=7, current=false → false', () => {
    expect(computeCollapsed(7, 500, 300, 100, false)).toBe(false)
  })

  it('scrollTop=0, current=true → false (scroll top で必ず展開)', () => {
    expect(computeCollapsed(0, 500, 300, 100, true)).toBe(false)
  })

  it('scrollTop=7.9, current=true → false', () => {
    expect(computeCollapsed(7.9, 500, 300, 100, true)).toBe(false)
  })
})

describe('computeCollapsed — collapse (scrollTop > 24 AND guard 通過)', () => {
  it('scrollTop=25, guard 十分: scrollHeight=500, clientHeight=300, middleBandHeight=100 → true', () => {
    // guard: 500 - 300 - 100 = 100 >= 8 → true
    expect(computeCollapsed(25, 500, 300, 100, false)).toBe(true)
  })

  it('scrollTop=100, guard 十分 → true', () => {
    expect(computeCollapsed(100, 1000, 400, 80, false)).toBe(true)
  })

  it('current=true で scrollTop > 24, guard 通過 → true (維持)', () => {
    expect(computeCollapsed(50, 500, 300, 100, true)).toBe(true)
  })
})

describe('computeCollapsed — guard failure (短コンテンツ防止)', () => {
  it('scrollTop=30, guard 不足: 200 - 150 - 80 = -30 < 8 → false (guard で阻止)', () => {
    // guard: 200 - 150 - 80 = -30 < 8 → collapse 禁止 → current を返す
    expect(computeCollapsed(30, 200, 150, 80, false)).toBe(false)
  })

  it('scrollTop=30, guard ギリギリ不足: 200 - 150 - 48 = 2 < 8 → false', () => {
    expect(computeCollapsed(30, 200, 150, 48, false)).toBe(false)
  })

  it('scrollTop=30, guard ちょうど 8: 200 - 150 - 42 = 8 >= 8 → true (境界)', () => {
    expect(computeCollapsed(30, 200, 150, 42, false)).toBe(true)
  })

  it('guard 不足でも current=true なら true を維持する(guard は collapse 遷移のみに作用)', () => {
    // current=true (already collapsed) → guard 不足でも return current = true
    // expand は scrollTop < 8 でのみ発生
    expect(computeCollapsed(30, 200, 150, 80, true)).toBe(true)
  })
})

describe('computeCollapsed — hysteresis zone (8 <= scrollTop <= 24)', () => {
  it('scrollTop=8, current=false → false (zone 内で変化なし)', () => {
    expect(computeCollapsed(8, 500, 300, 100, false)).toBe(false)
  })

  it('scrollTop=24, current=false → false (zone 上限)', () => {
    expect(computeCollapsed(24, 500, 300, 100, false)).toBe(false)
  })

  it('scrollTop=16, current=true → true (zone 内で collapse 維持)', () => {
    expect(computeCollapsed(16, 500, 300, 100, true)).toBe(true)
  })

  it('scrollTop=8, current=true → true (zone 下端で collapse 維持)', () => {
    expect(computeCollapsed(8, 500, 300, 100, true)).toBe(true)
  })

  it('scrollTop=24, current=true → true (zone 上端で collapse 維持)', () => {
    expect(computeCollapsed(24, 500, 300, 100, true)).toBe(true)
  })
})

describe('computeCollapsed — 境界値(exactly 8 / exactly 24 / exactly 25)', () => {
  it('scrollTop=7.99... < 8 → false (expand 領域)', () => {
    expect(computeCollapsed(7.999, 500, 300, 100, true)).toBe(false)
  })

  it('scrollTop=8 → hysteresis (current を維持)', () => {
    // 8 は expand 条件外(< 8 ではない)、collapse 条件外(> 24 ではない)
    expect(computeCollapsed(8, 500, 300, 100, true)).toBe(true)
    expect(computeCollapsed(8, 500, 300, 100, false)).toBe(false)
  })

  it('scrollTop=24 → hysteresis (current を維持)', () => {
    expect(computeCollapsed(24, 500, 300, 100, true)).toBe(true)
    expect(computeCollapsed(24, 500, 300, 100, false)).toBe(false)
  })

  it('scrollTop=24.01 > 24, guard 十分 → true (collapse 領域)', () => {
    expect(computeCollapsed(24.01, 500, 300, 100, false)).toBe(true)
  })
})
