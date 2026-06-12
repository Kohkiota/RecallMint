import { describe, it, expect } from 'vitest'
import { cardIdsSchema, selectedAnswerIdsSchema } from './review-session-bounds'

// uuid 生成 helper — crypto.randomUUID は Node 24 / ブラウザ双方で v4 を返す。
function uuid(): string {
  return crypto.randomUUID()
}

describe('cardIdsSchema', () => {
  it('case 1: 2000 件 (cap) で parse 成功', () => {
    const ids = Array.from({ length: 2000 }, () => uuid())
    const result = cardIdsSchema.safeParse(ids)
    expect(result.success).toBe(true)
  })

  it('case 2: 2001 件 (cap +1) で reject', () => {
    const ids = Array.from({ length: 2001 }, () => uuid())
    const result = cardIdsSchema.safeParse(ids)
    expect(result.success).toBe(false)
  })

  it('case 5 (段 2): item が valid uuid で parse 成功', () => {
    const result = cardIdsSchema.safeParse([uuid()])
    expect(result.success).toBe(true)
  })

  it('case 6 (段 2): item が non-uuid string で reject', () => {
    const result = cardIdsSchema.safeParse(['not-a-uuid'])
    expect(result.success).toBe(false)
  })
})

describe('selectedAnswerIdsSchema', () => {
  it('case 3: 50 件 (cap) で parse 成功', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `opt-${i}`)
    const result = selectedAnswerIdsSchema.safeParse(ids)
    expect(result.success).toBe(true)
  })

  it('case 4: 51 件 (cap +1) で reject', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `opt-${i}`)
    const result = selectedAnswerIdsSchema.safeParse(ids)
    expect(result.success).toBe(false)
  })

  it('case 7 (段 2): item が non-empty string で parse 成功', () => {
    const result = selectedAnswerIdsSchema.safeParse(['opt-x'])
    expect(result.success).toBe(true)
  })

  it('case 8 (段 2): item が empty string で reject (.min(1) 効果)', () => {
    const result = selectedAnswerIdsSchema.safeParse([''])
    expect(result.success).toBe(false)
  })
})
