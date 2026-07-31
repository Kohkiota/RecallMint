import { describe, it, expect } from 'vitest'
import {
  toCropRect,
  padAndClampBox2d,
  mapNormalizedBoxToPixels,
  type Box2d,
} from './crop-geometry'

describe('mapNormalizedBoxToPixels (裏取り核心式・軸別独立・padding/丸めなし)', () => {
  it('裏取り代表例(spec §4.1): [211,298,362,729] @ 1653x2339 -> x=[492.6,1205.0] / y=[493.5,846.7]', () => {
    const box2d: Box2d = [211, 298, 362, 729]
    const { xMinPx, yMinPx, xMaxPx, yMaxPx } = mapNormalizedBoxToPixels(
      box2d,
      1653,
      2339,
    )
    expect(xMinPx).toBeCloseTo(492.594, 3)
    expect(xMaxPx).toBeCloseTo(1205.037, 3)
    expect(yMinPx).toBeCloseTo(493.529, 3)
    expect(yMaxPx).toBeCloseTo(846.718, 3)
    // spec 記載の丸め表示(小数第 1 位)とも一致することを確認
    expect(Number(xMinPx.toFixed(1))).toBe(492.6)
    expect(Number(xMaxPx.toFixed(1))).toBe(1205.0)
    expect(Number(yMinPx.toFixed(1))).toBe(493.5)
    expect(Number(yMaxPx.toFixed(1))).toBe(846.7)
    // 最終 toCropRect が行う floor/ceil を素通しした場合の整数(この関数自体は丸めない)
    expect(Math.floor(xMinPx)).toBe(492)
    expect(Math.ceil(xMaxPx)).toBe(1206)
    expect(Math.floor(yMinPx)).toBe(493)
    expect(Math.ceil(yMaxPx)).toBe(847)
  })

  it('軸独立性(非正方形画像で単一 scale 仮定と結果が食い違う)', () => {
    // 単一 scale(例えば常に width を使う)なら x/y の px 化が同じ比率になるはずだが、
    // 縦横比が大きく異なる画像では decodedWidth と decodedHeight が別々に効くため
    // 結果が乖離する。box は x/y とも同じ正規化値(200-800)を使い、画像だけ非正方形にする。
    const box2d: Box2d = [200, 200, 800, 800]
    const { xMinPx, yMinPx, xMaxPx, yMaxPx } = mapNormalizedBoxToPixels(
      box2d,
      2000, // decodedWidth
      100, // decodedHeight (極端に非正方形)
    )
    expect(xMinPx).toBe(400) // 200/1000 * 2000
    expect(xMaxPx).toBe(1600) // 800/1000 * 2000
    expect(yMinPx).toBe(20) // 200/1000 * 100
    expect(yMaxPx).toBe(80) // 800/1000 * 100
    // 単一 scale 仮定(例えば width 基準)だと yMinPx は 400 になってしまうはずだが違う
    expect(yMinPx).not.toBe(xMinPx)
  })
})

describe('padAndClampBox2d (±60 padding -> clamp[0,1000])', () => {
  it('中央付近の box は padding のみで clamp は無効', () => {
    const box2d: Box2d = [300, 300, 700, 700]
    expect(padAndClampBox2d(box2d)).toEqual([240, 240, 760, 760])
  })

  it('端に寄った box は padding 後に負/超過し 0/1000 へ clamp される', () => {
    const box2d: Box2d = [10, 20, 990, 980]
    // pad: [10-60, 20-60, 990+60, 980+60] = [-50, -40, 1050, 1040]
    expect(padAndClampBox2d(box2d)).toEqual([0, 0, 1000, 1000])
  })

  it('ちょうど境界(0 or 1000)に接する box も clamp で範囲内に収まる', () => {
    const box2d: Box2d = [0, 0, 1000, 1000]
    expect(padAndClampBox2d(box2d)).toEqual([0, 0, 1000, 1000])
  })
})

describe('toCropRect (floor/ceil・整数出力)', () => {
  it('小数 px を生む box で left/top は floor・right/bottom は ceil', () => {
    // decodedWidth/Height を素数寄りにして端数を作る。padding を無効化するため
    // box を画像中心付近の十分内側(pad 後も clamp 不発)に置く。
    const box2d: Box2d = [300, 300, 700, 700]
    const rect = toCropRect(box2d, 1001, 1001)
    expect(rect).not.toBeNull()
    // clampedBbox = [240,240,760,760] (中心付近なので clamp 不発)
    // xMinPx = 240/1000*1001 = 240.24 -> floor 240
    // xMaxPx = 760/1000*1001 = 760.76 -> ceil 761
    expect(rect!.left).toBe(240)
    expect(rect!.top).toBe(240)
    expect(rect!.clampedBbox).toEqual([240, 240, 760, 760])
    const expectedRight = Math.ceil((760 / 1000) * 1001)
    const expectedBottom = Math.ceil((760 / 1000) * 1001)
    expect(rect!.cropW).toBe(expectedRight - rect!.left)
    expect(rect!.cropH).toBe(expectedBottom - rect!.top)
    // 整数であることの確認(小数 px が残っていない)
    expect(Number.isInteger(rect!.left)).toBe(true)
    expect(Number.isInteger(rect!.top)).toBe(true)
    expect(Number.isInteger(rect!.cropW)).toBe(true)
    expect(Number.isInteger(rect!.cropH)).toBe(true)
  })

  it('裏取り代表例に padding を乗せても整数 crop rect が導出できる', () => {
    const box2d: Box2d = [211, 298, 362, 729]
    const rect = toCropRect(box2d, 1653, 2339)
    expect(rect).not.toBeNull()
    // clampedBbox = [211-60,298-60,362+60,729+60] = [151,238,422,789] (clamp 不発)
    expect(rect!.clampedBbox).toEqual([151, 238, 422, 789])
    expect(rect!.origBbox).toEqual(box2d)
    expect(rect!.paddingPct).toBe(0.06)
    expect(Number.isInteger(rect!.left)).toBe(true)
    expect(Number.isInteger(rect!.top)).toBe(true)
    expect(Number.isInteger(rect!.cropW)).toBe(true)
    expect(Number.isInteger(rect!.cropH)).toBe(true)
  })
})

describe('toCropRect padding + clamp (端の box は 0/1000 に clamp、負や超過にならない)', () => {
  it('画像端に密着した box は clamp により left=0/top=0 になる', () => {
    const box2d: Box2d = [10, 10, 200, 200]
    const rect = toCropRect(box2d, 1000, 1000)
    expect(rect).not.toBeNull()
    // clampedBbox = [max(10-60,0), max(10-60,0), 260, 260] = [0,0,260,260]
    expect(rect!.clampedBbox).toEqual([0, 0, 260, 260])
    expect(rect!.left).toBe(0)
    expect(rect!.top).toBe(0)
  })

  it('画像端(右下)に密着した box は clamp により right/bottom が画像寸法を超えない', () => {
    const box2d: Box2d = [800, 800, 990, 990]
    const rect = toCropRect(box2d, 1000, 2000)
    expect(rect).not.toBeNull()
    // clampedBbox = [740,740, min(1050,1000)=1000, min(1050,1000)=1000]
    expect(rect!.clampedBbox).toEqual([740, 740, 1000, 1000])
    // xMaxPx = 1000/1000*1000 = 1000, yMaxPx = 1000/1000*2000 = 2000 (画像境界ぴったり)
    expect(rect!.left + rect!.cropW).toBe(1000)
    expect(rect!.top + rect!.cropH).toBe(2000)
  })
})

describe('toCropRect 退化 -> null', () => {
  it('逆転 box(x_max < x_min)は null', () => {
    const box2d: Box2d = [300, 700, 600, 200] // x_max(200) < x_min(700)
    expect(toCropRect(box2d, 1000, 1000)).toBeNull()
  })

  it('生 box がゼロ幅(x_min===x_max)でも padding(±60)が非退化幅を作るため null にならない(対照)', () => {
    // 退化判定は「(clamped) box」に対して行う(spec §7.1 step 6)。padding は最小・零
    // 幅の生検出を救済する目的も兼ねるため、[0,1000] 内のゼロ幅入力は原則 clamp 後に
    // 正の面積を持つ — 「zero-area box」を退化 null にするのは、生座標そのものが
    // [0,1000] の範囲外まで踏み出していて pad+clamp が両端を同一境界に押し込める場合のみ
    // (下 2 件のテスト)。
    const box2d: Box2d = [300, 500, 600, 500]
    const rect = toCropRect(box2d, 1000, 1000)
    expect(rect).not.toBeNull()
    expect(rect!.cropW).toBeGreaterThan(0)
  })

  it('clamp 後に厳密な等号でゼロ面積になる box(境界一致・逆転ではない)は null', () => {
    // x_min===x_max===1060(範囲外)にすると、pad 後 x_min'=1000(ちょうど)・
    // x_max'=1120->clamp 1000 で、両端が「同一点」に一致する(逆転 x_max<x_min ではなく
    // 厳密な等号 x_max'===x_min')。degenerate 判定が `<` でなく `<=`(コード上は
    // `!(a>b)`)である境界ケースを踏む。
    const box2d: Box2d = [500, 1060, 600, 1060]
    const rect = toCropRect(box2d, 1000, 1000)
    expect(rect).toBeNull()
  })

  it('画像端に密着した box(padding 後も clamp 後に正の面積が残る)は退化しない(対照)', () => {
    const box2d: Box2d = [995, 995, 999, 999]
    // pad: [935,935,1059,1059] -> clamp [935,935,1000,1000] -> まだ正の面積
    expect(toCropRect(box2d, 1000, 1000)).not.toBeNull()
  })

  it('clamp によって潰れる box(範囲外[0,1000]座標が pad+clamp で同一点に収束)は null', () => {
    // x 軸が丸ごと 1000 超(呼び出し側の契約違反だが「範囲外は clamp で緩やかに処理」
    // という spec §4.4 の方針を満たす): pad 後も両端とも 1000 に clamp され x 幅が消える。
    // 単調な clamp が「厳密不等号の入力」を「同一出力」に潰せるのは、両端が同じ側の
    // 境界を超えている場合のみ(x_min-60>=1000 かつ x_max+60>=1000)。
    const box2d: Box2d = [500, 1060, 600, 1200]
    const rect = toCropRect(box2d, 1000, 1000)
    expect(rect).toBeNull()
  })

  it('下側も同様: x 軸が丸ごと 0 未満なら pad+clamp で両端とも 0 に収束し null', () => {
    const box2d: Box2d = [500, -300, 600, -100]
    expect(toCropRect(box2d, 1000, 1000)).toBeNull()
  })

  it('非有限入力(NaN)は例外を投げず null を返す(呼び出し側の契約違反だが、投げるより null を優先)', () => {
    const box2d: Box2d = [NaN, 300, 600, 700]
    expect(() => toCropRect(box2d, 1000, 1000)).not.toThrow()
    expect(toCropRect(box2d, 1000, 1000)).toBeNull()
  })

  it('非有限入力(Infinity)が退化(逆転)を引き起こす場合も null', () => {
    // xMin=Infinity は clamp で 1000 に張り付き、xMax(300+pad=360)を上回るため逆転する。
    // (Infinity 単体は clamp で有限の境界値に収束しうるため、常に null になるとは限らない
    // — ここは「clamp の結果として退化する」具体例。呼び出し側は本来これを渡さない。)
    const box2d: Box2d = [300, Infinity, 700, 300]
    expect(toCropRect(box2d, 1000, 1000)).toBeNull()
  })

  it('decodedWidth/decodedHeight が 0(呼び出し側契約違反)でも null(NaN/Infinity 混入結果を返さない)', () => {
    const box2d: Box2d = [300, 300, 700, 700]
    expect(toCropRect(box2d, 0, 1000)).toBeNull()
    expect(toCropRect(box2d, 1000, 0)).toBeNull()
  })
})

describe('audit metadata (T10 が provenance として消費する形)', () => {
  it('origBbox は入力そのまま・paddingPct=0.06・clampedBbox は padding+clamp 後の 0-1000 box', () => {
    const box2d: Box2d = [211, 298, 362, 729]
    const rect = toCropRect(box2d, 1653, 2339)
    expect(rect).not.toBeNull()
    expect(rect!.origBbox).toEqual([211, 298, 362, 729])
    expect(rect!.paddingPct).toBe(0.06)
    expect(rect!.clampedBbox).toEqual([151, 238, 422, 789])
    expect(rect).toHaveProperty('left')
    expect(rect).toHaveProperty('top')
    expect(rect).toHaveProperty('cropW')
    expect(rect).toHaveProperty('cropH')
  })

  it('cropW/cropH は left/top + 幅/高さで right/bottom を再構成できる', () => {
    const box2d: Box2d = [300, 300, 700, 700]
    const rect = toCropRect(box2d, 1000, 1000)
    expect(rect).not.toBeNull()
    // clampedBbox = [240,240,760,760] -> px は 1:1 (decoded=1000)
    expect(rect!.left).toBe(240)
    expect(rect!.top).toBe(240)
    expect(rect!.cropW).toBe(760 - 240)
    expect(rect!.cropH).toBe(760 - 240)
  })
})
