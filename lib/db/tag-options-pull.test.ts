// tag-options-pull mapper test (Tag-1)。
// pure な toClientTagOption mapper のみ verify (DB query 部分は route 統合 test 側で
// mock 化するためここでは扱わない)。

import { describe, it, expect } from 'vitest'
import { toClientTagOption } from './tag-options-pull'
import type { tagOptions } from './schema'

type TagOptionRow = typeof tagOptions.$inferSelect

function fakeRow(overrides?: Partial<TagOptionRow>): TagOptionRow {
  return {
    id: 'opt-1',
    userId: 'user-1',
    categoryId: 'cat-1',
    name: '循環器',
    color: null,
    sortKey: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    ...overrides,
  } as TagOptionRow
}

describe('toClientTagOption', () => {
  it('Date 系を ISO8601 文字列化、 camelCase → snake_case', () => {
    const out = toClientTagOption(fakeRow())
    expect(out.id).toBe('opt-1')
    expect(out.user_id).toBe('user-1')
    expect(out.category_id).toBe('cat-1')
    expect(out.name).toBe('循環器')
    expect(out.color).toBeNull()
    expect(out.sort_key).toBeNull()
    expect(out.created_at).toBe('2026-06-01T00:00:00.000Z')
    expect(out.updated_at).toBe('2026-06-02T00:00:00.000Z')
  })

  it('color / sort_key 非 null を保持', () => {
    const out = toClientTagOption(
      fakeRow({ color: '#0000ff', sortKey: 'B002' }),
    )
    expect(out.color).toBe('#0000ff')
    expect(out.sort_key).toBe('B002')
  })
})
