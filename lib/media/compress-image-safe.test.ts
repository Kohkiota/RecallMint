// compress-image-safe test (画像圧縮 iOS/WebKit 修正 spec Task 3)。
//
// vitest env は node のため canvas/HTMLImageElement は動かない (vitest.config.ts)。
// `computeScale` / `chooseOutputFormat` は純関数として直接 unit する。 `canEncodeWebp`
// は `document.createElement('canvas')` を stub して分岐を検証する (afterEach で復元)。
// `compressImageSafe` の実 decode/draw/encode は downstream の smoke で担保する
// (image-validation.test.ts と同方針・brief 記載の許容)。

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  computeScale,
  chooseOutputFormat,
  MAX_EDGE,
  MAX_PIXELS,
} from '@/lib/media/compress-image-safe'

// ---- computeScale (pure) ----

describe('computeScale', () => {
  it('長辺が MAX_EDGE を超える正方形 → 両辺とも MAX_EDGE に縮小', () => {
    const r = computeScale(4000, 4000)
    // sqrt(MAX_PIXELS/(4000*4000)) = sqrt(4e6/1.6e7) = 0.5 → MAX_EDGE/4000=0.512 より小さい
    // ので pixel budget が支配的
    const expectedScale = Math.sqrt(MAX_PIXELS / (4000 * 4000))
    expect(r.outW).toBe(Math.round(4000 * expectedScale))
    expect(r.outH).toBe(Math.round(4000 * expectedScale))
  })

  it('極端に横長 (幅のみ MAX_EDGE 超) → MAX_EDGE/srcW が支配的でも pixel budget が優先されうる', () => {
    const srcW = 10000
    const srcH = 100
    const r = computeScale(srcW, srcH)
    const expectedScale = Math.min(
      1,
      MAX_EDGE / srcW,
      MAX_EDGE / srcH,
      Math.sqrt(MAX_PIXELS / (srcW * srcH)),
    )
    expect(r.outW).toBe(Math.max(1, Math.round(srcW * expectedScale)))
    expect(r.outH).toBe(Math.max(1, Math.round(srcH * expectedScale)))
    // 幅が縦よりずっと大きいので MAX_EDGE/srcW (0.2048) が最も厳しい制約のはず
    expect(expectedScale).toBeCloseTo(MAX_EDGE / srcW, 10)
  })

  it('極端に縦長 (高さのみ MAX_EDGE 超) → MAX_EDGE/srcH が支配的', () => {
    const srcW = 100
    const srcH = 10000
    const r = computeScale(srcW, srcH)
    const expectedScale = MAX_EDGE / srcH
    expect(r.outW).toBe(Math.max(1, Math.round(srcW * expectedScale)))
    expect(r.outH).toBe(Math.max(1, Math.round(srcH * expectedScale)))
  })

  it('巨大画像 (MAX_PIXELS 超 かつ MAX_EDGE 超) → 両制約のうち最も厳しい scale が採用される', () => {
    const srcW = 8000
    const srcH = 6000
    const r = computeScale(srcW, srcH)
    expect(r.outW * r.outH).toBeLessThanOrEqual(MAX_PIXELS * 1.01) // round 誤差許容
    expect(r.outW).toBeLessThanOrEqual(MAX_EDGE)
    expect(r.outH).toBeLessThanOrEqual(MAX_EDGE)
  })

  it('小さい画像 (両制約とも余裕) → upscale せず scale は 1 (原寸のまま)', () => {
    const r = computeScale(400, 300)
    expect(r.outW).toBe(400)
    expect(r.outH).toBe(300)
  })

  it('正方形 (制約内) → 原寸のまま', () => {
    const r = computeScale(1000, 1000)
    expect(r.outW).toBe(1000)
    expect(r.outH).toBe(1000)
  })

  it('1px 画像 → 1px のまま (0 にならない)', () => {
    const r = computeScale(1, 1)
    expect(r.outW).toBe(1)
    expect(r.outH).toBe(1)
  })

  it('round→0 防止: 極端な比率で理論上 0px になりうる辺でも max(1,...) で ≥1px 保証', () => {
    // srcH が極端に小さく scale*srcH が 0.5 未満になるケース (round すると 0)
    const srcW = 4_000_000
    const srcH = 1
    const r = computeScale(srcW, srcH)
    expect(r.outW).toBeGreaterThanOrEqual(1)
    expect(r.outH).toBeGreaterThanOrEqual(1)
  })

  it('MAX_EDGE ちょうどの正方形 (境界) → scale=1 で原寸維持', () => {
    const r = computeScale(MAX_EDGE, MAX_EDGE)
    // sqrt(MAX_PIXELS/(MAX_EDGE^2)) = sqrt(4e6/4194304) < 1 なので pixel budget により縮小されうる
    const expectedScale = Math.min(1, Math.sqrt(MAX_PIXELS / (MAX_EDGE * MAX_EDGE)))
    expect(r.outW).toBe(Math.max(1, Math.round(MAX_EDGE * expectedScale)))
    expect(r.outH).toBe(Math.max(1, Math.round(MAX_EDGE * expectedScale)))
  })
})

// ---- chooseOutputFormat (pure) ----

describe('chooseOutputFormat', () => {
  it('canWebp=true, hasAlpha=true → WebP (白塗りなし)', () => {
    const f = chooseOutputFormat(true, true)
    expect(f.type).toBe('image/webp')
    expect(f.whiteFill).toBe(false)
    expect(f.quality).toBeDefined()
  })

  it('canWebp=true, hasAlpha=false → WebP (白塗りなし)', () => {
    const f = chooseOutputFormat(true, false)
    expect(f.type).toBe('image/webp')
    expect(f.whiteFill).toBe(false)
  })

  it('canWebp=false, hasAlpha=true → PNG (白塗りなし・alpha 保持)', () => {
    const f = chooseOutputFormat(false, true)
    expect(f.type).toBe('image/png')
    expect(f.whiteFill).toBe(false)
  })

  it('canWebp=false, hasAlpha=false → JPEG (白塗りあり。白塗りが発生する唯一のケース)', () => {
    const f = chooseOutputFormat(false, false)
    expect(f.type).toBe('image/jpeg')
    expect(f.whiteFill).toBe(true)
    expect(f.quality).toBeDefined()
  })

  it('白塗り (whiteFill:true) は JPEG のケースのみで発生する', () => {
    const combos: Array<[boolean, boolean]> = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ]
    for (const [canWebp, hasAlpha] of combos) {
      const f = chooseOutputFormat(canWebp, hasAlpha)
      if (f.whiteFill) {
        expect(f.type).toBe('image/jpeg')
      }
    }
  })
})

// ---- canEncodeWebp (document.createElement stub) ----
//
// モジュールレベルで memoize されるため、 各 it 内で dynamic import + vi.resetModules
// する (stub ごとに fresh cache で判定させる)。

describe('canEncodeWebp', () => {
  // node env には document が存在しない (image-validation.test.ts と同前提)。
  // webkit-detect.test.ts の navigator stub と同型で globalThis.document 自体を
  // definePropety で差し替え、 afterEach で元の状態 (= 未定義) に戻す。
  const originalDocument = (globalThis as { document?: unknown }).document

  afterEach(() => {
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document
    } else {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        configurable: true,
        writable: true,
      })
    }
  })

  function stubDocument(createElement: (tag: string) => unknown): void {
    Object.defineProperty(globalThis, 'document', {
      value: { createElement },
      configurable: true,
      writable: true,
    })
  }

  function stubCanvas(toDataURLResult: string | (() => string)): void {
    stubDocument((tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected tag: ${tag}`)
      return {
        width: 0,
        height: 0,
        toDataURL: () => {
          if (typeof toDataURLResult === 'function') return toDataURLResult()
          return toDataURLResult
        },
      }
    })
  }

  it("toDataURL が 'data:image/webp' で始まる → true", async () => {
    stubCanvas('data:image/webp;base64,AAAA')
    const mod = await freshImport()
    expect(mod.canEncodeWebp()).toBe(true)
  })

  it("toDataURL が 'data:image/png' (webp 非対応 silent fallback) → false", async () => {
    stubCanvas('data:image/png;base64,AAAA')
    const mod = await freshImport()
    expect(mod.canEncodeWebp()).toBe(false)
  })

  it('createElement が例外を投げる → false', async () => {
    stubDocument(() => {
      throw new Error('boom')
    })
    const mod = await freshImport()
    expect(mod.canEncodeWebp()).toBe(false)
  })

  it('memoize: 2 回目の呼び出しは createElement を再実行しない', async () => {
    let calls = 0
    stubDocument(() => {
      calls++
      return { width: 0, height: 0, toDataURL: () => 'data:image/webp;base64,AAAA' }
    })
    const mod = await freshImport()
    mod.canEncodeWebp()
    mod.canEncodeWebp()
    expect(calls).toBe(1)
  })
})

// モジュールキャッシュをリセットして再 import する (webpSupportCache を各 test で独立させる)。
async function freshImport(): Promise<typeof import('@/lib/media/compress-image-safe')> {
  vi.resetModules()
  return import('@/lib/media/compress-image-safe')
}
