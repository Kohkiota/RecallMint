// self-host した browser-image-compression が package 版と一致することを pin する drift
// guard (画像フェーズ A / spec §4)。 CSP 最小権限のため jsDelivr でなく public/vendor/ の
// 自前配置を圧縮 worker が importScripts する。 package を bump したのに public/vendor/ を
// 更新し忘れると worker が旧版 lib を読み、 圧縮挙動が silent に乖離する。 本 test が CI で
// 検知する (worker は byte 単位で dist と同一である必要がある)。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('vendored browser-image-compression drift guard (spec §4)', () => {
  it('public/vendor/browser-image-compression.js が node_modules の dist と byte 一致する', () => {
    const distPath = resolve(
      process.cwd(),
      'node_modules/browser-image-compression/dist/browser-image-compression.js',
    )
    const vendorPath = resolve(
      process.cwd(),
      'public/vendor/browser-image-compression.js',
    )
    const dist = readFileSync(distPath)
    const vendored = readFileSync(vendorPath)
    // 不一致 = package を bump したのに re-vendor し忘れ → 再 cp して更新すること。
    expect(vendored.equals(dist)).toBe(true)
  })
})
