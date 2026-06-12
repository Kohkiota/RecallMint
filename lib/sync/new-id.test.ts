// new-id helper の smoke test。 entity-mutations.ts / review-events.ts の旧 inline 実装を
// 1 経路に集約したもの。 v4 UUID 形式と uniqueness のみ検証 (詳細な分布検証は不要)。

import { describe, it, expect } from 'vitest'
import { newId } from './new-id'

describe('newId', () => {
  it('v4 UUID 形式の文字列を返す', () => {
    const id = newId()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('毎回異なる値を返す', () => {
    const a = newId()
    const b = newId()
    expect(a).not.toBe(b)
  })
})
