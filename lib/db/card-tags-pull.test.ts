// card-tags-pull mapper test (Tag-2b)。
// pure な toClientCardTag mapper のみ verify (DB query 部分は route 統合 test 側で
// mock 化するためここでは扱わない)。 Date → ISO8601 文字列 / camelCase → snake_case。

import { describe, it, expect } from 'vitest'
import { toClientCardTag } from './card-tags-pull'
import type { cardTags } from './schema'

type CardTagRow = typeof cardTags.$inferSelect

function fakeRow(overrides?: Partial<CardTagRow>): CardTagRow {
  return {
    cardId: 'card-1',
    optionId: 'opt-1',
    userId: 'user-1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  } as CardTagRow
}

describe('toClientCardTag', () => {
  it('Date 系を ISO8601 文字列化、 camelCase → snake_case', () => {
    const out = toClientCardTag(fakeRow())
    expect(out.card_id).toBe('card-1')
    expect(out.option_id).toBe('opt-1')
    expect(out.user_id).toBe('user-1')
    expect(out.created_at).toBe('2026-06-01T00:00:00.000Z')
  })

  it('別 createdAt も ISO8601 で正しく出力される', () => {
    const out = toClientCardTag(
      fakeRow({ createdAt: new Date('2026-06-15T12:34:56.789Z') }),
    )
    expect(out.created_at).toBe('2026-06-15T12:34:56.789Z')
  })
})
