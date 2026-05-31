// ambient-pull-suppress のユニットテスト。
// module-scope フラグのため、テスト間の状態汚染を防ぐため afterEach で reset する。

import { describe, it, expect, afterEach } from 'vitest'
import { suppressAmbientPull, resumeAmbientPull, isAmbientPullSuppressed } from './ambient-pull-suppress'

afterEach(() => {
  // テスト間の状態汚染防止: 常に off に戻す
  resumeAmbientPull()
})

describe('ambient-pull-suppress', () => {
  it('(1) 既定値は off (false)', () => {
    expect(isAmbientPullSuppressed()).toBe(false)
  })

  it('(2) suppressAmbientPull() で true になる', () => {
    suppressAmbientPull()
    expect(isAmbientPullSuppressed()).toBe(true)
  })

  it('(3) resumeAmbientPull() で false に戻る', () => {
    suppressAmbientPull()
    expect(isAmbientPullSuppressed()).toBe(true)
    resumeAmbientPull()
    expect(isAmbientPullSuppressed()).toBe(false)
  })

  it('(4) resume を suppress なしで呼んでも false のまま (idempotent)', () => {
    expect(isAmbientPullSuppressed()).toBe(false)
    resumeAmbientPull()
    expect(isAmbientPullSuppressed()).toBe(false)
  })

  it('(5) suppress を複数回呼んでも true のまま (idempotent)', () => {
    suppressAmbientPull()
    suppressAmbientPull()
    expect(isAmbientPullSuppressed()).toBe(true)
  })
})
