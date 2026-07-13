// image-validation test (画像圧縮 iOS/WebKit 修正 spec Task 2)。
//
// vitest env は node (vitest.config.ts) のため canvas/HTMLImageElement は動かない。
// 判定ロジック (evaluateValidity) と metrics 算出 (computeSampleMetrics/computeMae) は
// 純関数として合成 RGBA データで直接 unit する。 誤検知回避が本タスクの目的ゆえ
// 「正当な低分散画像は pass する」テストを最重要に置く。
// magic-byte 判定は Node の Blob.slice().arrayBuffer() で node-testable。

import { describe, it, expect } from 'vitest'
import {
  computeSampleMetrics,
  computeMae,
  evaluateValidity,
  validateImageStructure,
  VALIDATE_SAMPLE,
  OPAQUE_IN_MIN,
  OPAQUE_OUT_MAX,
  VAR_IN_MIN,
  VAR_OUT_MAX,
  MAE_MAX,
  type SampleMetrics,
} from '@/lib/media/image-validation'

// ---- 合成 RGBA 生成 helper ----

/** 単色 (opaque) の width×height RGBA を生成する。 */
function solidRgba(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    data[o] = r
    data[o + 1] = g
    data[o + 2] = b
    data[o + 3] = a
  }
  return data
}

/** 全ピクセル透明 (a=0) の RGBA を生成する。 */
function transparentRgba(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4)
}

/** 決定的な疑似ランダム輝度で高分散パターンを生成する (写真/線画相当)。 */
function noisyRgba(width: number, height: number, seed = 1): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  let s = seed
  for (let i = 0; i < width * height; i++) {
    // xorshift 的な単純決定的擬似乱数 (test 再現性のため Math.random 不使用)
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const v = s % 256
    const o = i * 4
    data[o] = v
    data[o + 1] = (v * 3) % 256
    data[o + 2] = (v * 7) % 256
    data[o + 3] = 255
  }
  return data
}

/** チェッカーボード状の 2 値パターン (線画/手書きメモ相当・低〜中分散)。 */
function checkerRgba(width: number, height: number, lo: number, hi: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const o = i * 4
      const v = (x + y) % 8 === 0 ? hi : lo
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return data
}

const SIZE = VALIDATE_SAMPLE

// ---- computeSampleMetrics (pure) ----

describe('computeSampleMetrics', () => {
  it('全白 opaque → opaqueRatio=1, meanLuma=255, lumaVar=0', () => {
    const m = computeSampleMetrics(solidRgba(SIZE, SIZE, 255, 255, 255), SIZE, SIZE)
    expect(m.opaqueRatio).toBe(1)
    expect(m.meanLuma).toBeCloseTo(255, 5)
    expect(m.lumaVar).toBeCloseTo(0, 5)
    expect(m.edgeEnergy).toBe(0)
  })

  it('単色背景 (中間色) → lumaVar=0, edgeEnergy=0', () => {
    const m = computeSampleMetrics(solidRgba(SIZE, SIZE, 128, 130, 132), SIZE, SIZE)
    expect(m.lumaVar).toBeCloseTo(0, 5)
    expect(m.edgeEnergy).toBe(0)
  })

  it('全透明 → opaqueRatio=0', () => {
    const m = computeSampleMetrics(transparentRgba(SIZE, SIZE), SIZE, SIZE)
    expect(m.opaqueRatio).toBe(0)
  })

  it('高分散ノイズ → lumaVar が閾値 (VAR_IN_MIN=100) を超える', () => {
    const m = computeSampleMetrics(noisyRgba(SIZE, SIZE), SIZE, SIZE)
    expect(m.lumaVar).toBeGreaterThan(VAR_IN_MIN)
    expect(m.edgeEnergy).toBeGreaterThan(0)
  })

  it('チェッカーボード (線画相当) → edgeEnergy > 0 で分散も出る', () => {
    const m = computeSampleMetrics(checkerRgba(SIZE, SIZE, 20, 220), SIZE, SIZE)
    expect(m.edgeEnergy).toBeGreaterThan(0)
    expect(m.lumaVar).toBeGreaterThan(0)
  })

  it('width×height=0 → 全指標 0 (0 除算しない)', () => {
    const m = computeSampleMetrics(new Uint8ClampedArray(0), 0, 0)
    expect(m).toEqual({ opaqueRatio: 0, meanLuma: 0, lumaVar: 0, edgeEnergy: 0 })
  })
})

// ---- computeMae (pure) ----

describe('computeMae', () => {
  it('同一画像 → mae=0', () => {
    const a = noisyRgba(SIZE, SIZE)
    const b = noisyRgba(SIZE, SIZE)
    expect(computeMae(a, b)).toBe(0)
  })

  it('全白 vs 全黒 → mae=255', () => {
    const white = solidRgba(SIZE, SIZE, 255, 255, 255)
    const black = solidRgba(SIZE, SIZE, 0, 0, 0)
    expect(computeMae(white, black)).toBeCloseTo(255, 5)
  })

  it('高分散 vs 単色 (塗り潰し) → mae が閾値 (MAE_MAX=40) を超える', () => {
    const input = noisyRgba(SIZE, SIZE)
    const output = solidRgba(SIZE, SIZE, 128, 128, 128)
    expect(computeMae(input, output)).toBeGreaterThan(MAE_MAX)
  })

  it('長さ0 → mae=0', () => {
    expect(computeMae(new Uint8ClampedArray(0), new Uint8ClampedArray(0))).toBe(0)
  })
})

// ---- evaluateValidity (pure・誤検知回避が最重要) ----

function metrics(partial: Partial<SampleMetrics>): SampleMetrics {
  return { opaqueRatio: 1, meanLuma: 128, lumaVar: 0, edgeEnergy: 0, ...partial }
}

describe('evaluateValidity — 誤検知回避 (正当な低分散画像は必ず pass)', () => {
  it('全白画像 (入力・出力とも opaqueRatio=1, lumaVar=0) → ok', () => {
    const white = metrics({ opaqueRatio: 1, lumaVar: 0, meanLuma: 255 })
    const r = evaluateValidity({ ok: true }, white, white, 0)
    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
  })

  it('単色背景 (入出力とも lumaVar 低) → ok', () => {
    const solid = metrics({ opaqueRatio: 1, lumaVar: 2, meanLuma: 100 })
    const r = evaluateValidity({ ok: true }, solid, solid, 1)
    expect(r.ok).toBe(true)
  })

  it('小アイコン (低分散・opaqueRatio 高いが入力分散が閾値未満) → ok', () => {
    const inM = metrics({ opaqueRatio: 0.9, lumaVar: 50, meanLuma: 180 })
    const outM = metrics({ opaqueRatio: 0.88, lumaVar: 45, meanLuma: 178 })
    const r = evaluateValidity({ ok: true }, inM, outM, 5)
    expect(r.ok).toBe(true)
  })

  it('黒板写真 (暗い・分散が低め) → ok', () => {
    const inM = metrics({ opaqueRatio: 1, lumaVar: 80, meanLuma: 40 })
    const outM = metrics({ opaqueRatio: 1, lumaVar: 60, meanLuma: 42 })
    const r = evaluateValidity({ ok: true }, inM, outM, 10)
    expect(r.ok).toBe(true)
  })

  it('線画 (高コントラストだが局所的・圧縮でも保持) → ok', () => {
    const inM = metrics({ opaqueRatio: 1, lumaVar: 500, meanLuma: 200 })
    const outM = metrics({ opaqueRatio: 1, lumaVar: 480, meanLuma: 198 })
    const r = evaluateValidity({ ok: true }, inM, outM, 8)
    expect(r.ok).toBe(true)
  })

  it('手書きメモ (紙地に薄い線・分散小さめ) → ok', () => {
    const inM = metrics({ opaqueRatio: 1, lumaVar: 30, meanLuma: 230 })
    const outM = metrics({ opaqueRatio: 1, lumaVar: 25, meanLuma: 228 })
    const r = evaluateValidity({ ok: true }, inM, outM, 6)
    expect(r.ok).toBe(true)
  })

  it('透過 PNG (入力・出力とも透明維持) → opaque_collapse が誤発火しない', () => {
    // 入力側が opaqueRatio<=OPAQUE_IN_MIN のため前提が不成立 = collapse gate 通過
    const inM = metrics({ opaqueRatio: 0.3, lumaVar: 20, meanLuma: 200 })
    const outM = metrics({ opaqueRatio: 0.28, lumaVar: 18, meanLuma: 198 })
    const r = evaluateValidity({ ok: true }, inM, outM, 3)
    expect(r.ok).toBe(true)
  })

  it('高分散写真だが圧縮による軽微な mae のみ (mae <= MAE_MAX) → ok', () => {
    const inM = metrics({ opaqueRatio: 1, lumaVar: 300, meanLuma: 120 })
    const outM = metrics({ opaqueRatio: 1, lumaVar: 280, meanLuma: 118 })
    const r = evaluateValidity({ ok: true }, inM, outM, 15)
    expect(r.ok).toBe(true)
  })
})

describe('evaluateValidity — reject (破滅的崩壊のみ)', () => {
  it('構造 fail → reject (reason は structural の reason を継承)', () => {
    const m = metrics({})
    const r = evaluateValidity({ ok: false, reason: 'decode_failed' }, m, m, 0)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('decode_failed')
  })

  it('構造 fail で reason 未指定 → structural_invalid にフォールバック', () => {
    const m = metrics({})
    const r = evaluateValidity({ ok: false }, m, m, 0)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('structural_invalid')
  })

  it('空/塗り潰し出力 (入力分散大 → 出力分散ほぼ0 かつ mae 大) → flat_collapse', () => {
    const inM = metrics({ opaqueRatio: 1, lumaVar: VAR_IN_MIN + 50, meanLuma: 120 })
    const outM = metrics({ opaqueRatio: 1, lumaVar: VAR_OUT_MAX - 1, meanLuma: 200 })
    const r = evaluateValidity({ ok: true }, inM, outM, MAE_MAX + 10)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('flat_collapse')
  })

  it('透過崩壊 (入力 opaque 高 → 出力ほぼ全透明) → opaque_collapse', () => {
    const inM = metrics({ opaqueRatio: OPAQUE_IN_MIN + 0.3, lumaVar: 10, meanLuma: 100 })
    const outM = metrics({ opaqueRatio: OPAQUE_OUT_MAX / 2, lumaVar: 10, meanLuma: 100 })
    const r = evaluateValidity({ ok: true }, inM, outM, 0)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('opaque_collapse')
  })

  it('opaque_collapse は flat_collapse より先に判定される (両条件成立時)', () => {
    const inM = metrics({ opaqueRatio: 1, lumaVar: VAR_IN_MIN + 50, meanLuma: 120 })
    const outM = metrics({ opaqueRatio: 0, lumaVar: 0, meanLuma: 0 })
    const r = evaluateValidity({ ok: true }, inM, outM, MAE_MAX + 10)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('opaque_collapse')
  })

  it('境界: opaqueRatio がちょうど閾値 (境界値は非成立=strict inequality) → ok', () => {
    const inM = metrics({ opaqueRatio: OPAQUE_IN_MIN, lumaVar: 10, meanLuma: 100 })
    const outM = metrics({ opaqueRatio: OPAQUE_OUT_MAX, lumaVar: 10, meanLuma: 100 })
    const r = evaluateValidity({ ok: true }, inM, outM, 0)
    expect(r.ok).toBe(true)
  })
})

// ---- magic-byte / blob.type helper ----

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0]
function webpMagic(): number[] {
  // RIFF....WEBP (bytes 4-7 は file size で判定に無関係)
  return [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]
}

function magicBlob(bytes: number[], type: string, extraSize = 100): Blob {
  const body = new Uint8Array(bytes.length + extraSize)
  body.set(bytes, 0)
  return new Blob([body], { type })
}

// ---- validateImageStructure (structural — node-testable via Blob) ----

describe('validateImageStructure — 構造 fail 系', () => {
  it('null blob → empty_blob', async () => {
    const r = await validateImageStructure(null)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('empty_blob')
  })

  it('size=0 の空 blob → empty_blob', async () => {
    const r = await validateImageStructure(new Blob([], { type: 'image/png' }))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('empty_blob')
  })

  it('極小 blob (size>0 だが magic に満たない) → magic_mismatch', async () => {
    const r = await validateImageStructure(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('magic_mismatch')
  })

  it('blob.type が空文字 → invalid_type', async () => {
    const r = await validateImageStructure(magicBlob(PNG_MAGIC, ''))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('invalid_type')
  })

  it('blob.type がallowlist外 (image/gif) → invalid_type', async () => {
    const r = await validateImageStructure(magicBlob(PNG_MAGIC, 'image/gif'))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('invalid_type')
  })

  it('magic≠type (PNG bytes を image/webp と主張) → magic_mismatch', async () => {
    const r = await validateImageStructure(magicBlob(PNG_MAGIC, 'image/webp'))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('magic_mismatch')
  })

  it('magic≠type (JPEG bytes を image/png と主張) → magic_mismatch', async () => {
    const r = await validateImageStructure(magicBlob(JPEG_MAGIC, 'image/png'))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('magic_mismatch')
  })

  it('WEBP magic + image/webp type は magic 判定を通過する (decode は node で失敗 → decode_failed)', async () => {
    // Node に real HTMLImageElement は無いため decode 自体は失敗するが、
    // magic/type 一致が正しく判定されている (invalid_type/magic_mismatch にならない) ことを確認する。
    const r = await validateImageStructure(magicBlob(webpMagic(), 'image/webp'))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('decode_failed')
  })

  it('decode 失敗パス (magic/type 一致だが実 decode 不能な壊れた bytes) → decode_failed', async () => {
    const r = await validateImageStructure(magicBlob(PNG_MAGIC, 'image/png'))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('decode_failed')
  })
})
