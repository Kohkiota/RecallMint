// tag UI 用 12 色 palette + 「色なし」 (null) の class mapping helper。
// DB には色名文字列のみ保存し、 UI 側で Tailwind class に解決する設計のため、
// 不明色 (palette 削除後など) は中立 grey に fallback する不変条件を test で固定する。

import { describe, it, expect } from 'vitest'

import {
  TAG_COLOR_NAMES,
  COLOR_TO_CLASS,
  COLOR_NULL_CLASS,
  colorToClass,
} from './color-palette'

describe('TAG_COLOR_NAMES', () => {
  it('は 12 色を持つ', () => {
    expect(TAG_COLOR_NAMES).toHaveLength(12)
  })
})

describe('COLOR_TO_CLASS', () => {
  it('全 12 色 key を持ち、 各 value に bg- / text- / border- を含む', () => {
    for (const name of TAG_COLOR_NAMES) {
      const cls = COLOR_TO_CLASS[name]
      expect(cls, `missing class for ${name}`).toBeTruthy()
      // 動的構成 (`bg-${color}-100`) は purge で消えるため、 固定文字列で 3 utility を含む
      expect(cls).toMatch(/\bbg-/)
      expect(cls).toMatch(/\btext-/)
      expect(cls).toMatch(/\bborder-/)
    }
  })
})

describe('colorToClass', () => {
  it("'red' は red 系 class を返す", () => {
    expect(colorToClass('red')).toBe(COLOR_TO_CLASS.red)
  })

  it('null は COLOR_NULL_CLASS を返す', () => {
    expect(colorToClass(null)).toBe(COLOR_NULL_CLASS)
  })

  it('未知の色名は COLOR_NULL_CLASS に fallback する', () => {
    expect(colorToClass('unknown')).toBe(COLOR_NULL_CLASS)
  })

  it('undefined は COLOR_NULL_CLASS を返す', () => {
    expect(colorToClass(undefined)).toBe(COLOR_NULL_CLASS)
  })
})
