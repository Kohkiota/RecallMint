// computeFold の unit test(spec §3.1/§3.3 / Task 2 brief・保証増 = red 検証必須)。
//
// 二項 OR 閾値の各枝を個別に pin する: ① は px 下駄枝のみで、② は比率枝のみで
// fold=true になるよう capPx を変えて分離している(片枝を neuter すると対応 test が RED)。
// renderedHeightPx = renderedWidthPx * naturalHeight / naturalWidth なので、
// naturalWidth === renderedWidthPx にして naturalHeight をそのまま renderedHeightPx に使う。

import { describe, it, expect } from 'vitest'
import { computeFold } from '@/lib/media/compute-fold'

describe('computeFold', () => {
  it('① px 下駄枝の分離: capPx=400 absMarginPx=48 ratio=1.15(px 閾値 448 < 比率閾値 460)・renderedHeightPx=455 → px 枝のみで fold=true', () => {
    const { fold } = computeFold({
      naturalWidth: 100,
      naturalHeight: 455,
      renderedWidthPx: 100,
      capPx: 400,
      absMarginPx: 48,
      ratio: 1.15,
    })
    // 455 > 448(A 真)/ 455 < 460(B 偽)→ px 下駄枝のみで成立。
    expect(fold).toBe(true)
  })

  it('② 比率枝の分離: capPx=200 absMarginPx=48 ratio=1.15(比率閾値 230 < px 閾値 248)・renderedHeightPx=240 → 比率枝のみで fold=true', () => {
    const { fold } = computeFold({
      naturalWidth: 100,
      naturalHeight: 240,
      renderedWidthPx: 100,
      capPx: 200,
      absMarginPx: 48,
      ratio: 1.15,
    })
    // 240 < 248(A 偽)/ 240 > 230(B 真)→ 比率枝のみで成立(小 viewport で比率が先に効く)。
    expect(fold).toBe(true)
  })

  it('③ 両枝未満は畳まない(数 px 超過を畳まない): capPx=400・renderedHeightPx=410 → fold=false', () => {
    const { fold } = computeFold({
      naturalWidth: 100,
      naturalHeight: 410,
      renderedWidthPx: 100,
      capPx: 400,
      absMarginPx: 48,
      ratio: 1.15,
    })
    // 410 < 448(A 偽)/ 410 < 460(B 偽)。
    expect(fold).toBe(false)
  })

  it('④ clip: renderedHeightPx > capPx → cappedHeightPx === capPx', () => {
    const { cappedHeightPx } = computeFold({
      naturalWidth: 100,
      naturalHeight: 455,
      renderedWidthPx: 100,
      capPx: 400,
      absMarginPx: 48,
      ratio: 1.15,
    })
    expect(cappedHeightPx).toBe(400)
  })

  it('④ clip: renderedHeightPx < capPx → cappedHeightPx === renderedHeightPx', () => {
    const { cappedHeightPx } = computeFold({
      naturalWidth: 100,
      naturalHeight: 300,
      renderedWidthPx: 100,
      capPx: 400,
      absMarginPx: 48,
      ratio: 1.15,
    })
    expect(cappedHeightPx).toBe(300)
  })
})
