// tag-categories-pull mapper test (Tag-1)。
// pure な toClientTagCategory mapper のみ verify (DB query 部分は route 統合 test 側で
// mock 化するためここでは扱わない)。 Date → ISO8601 文字列 / select_type narrow / null 系。

import { describe, it, expect } from 'vitest'
import { toClientTagCategory } from './tag-categories-pull'
import type { tagCategories } from './schema'

type TagCategoryRow = typeof tagCategories.$inferSelect

function fakeRow(overrides?: Partial<TagCategoryRow>): TagCategoryRow {
  return {
    id: 'cat-1',
    userId: 'user-1',
    name: '分野',
    selectType: 'multi',
    color: null,
    sortKey: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    ...overrides,
  } as TagCategoryRow
}

describe('toClientTagCategory', () => {
  it('Date 系を ISO8601 文字列化、 camelCase → snake_case', () => {
    const out = toClientTagCategory(fakeRow())
    expect(out.id).toBe('cat-1')
    expect(out.user_id).toBe('user-1')
    expect(out.name).toBe('分野')
    expect(out.select_type).toBe('multi')
    expect(out.color).toBeNull()
    expect(out.sort_key).toBeNull()
    expect(out.created_at).toBe('2026-06-01T00:00:00.000Z')
    expect(out.updated_at).toBe('2026-06-02T00:00:00.000Z')
  })

  it('select_type=single も narrow できる', () => {
    const out = toClientTagCategory(fakeRow({ selectType: 'single' }))
    expect(out.select_type).toBe('single')
  })

  it('color / sort_key 非 null を保持', () => {
    const out = toClientTagCategory(
      fakeRow({ color: '#ff0000', sortKey: 'A001' }),
    )
    expect(out.color).toBe('#ff0000')
    expect(out.sort_key).toBe('A001')
  })
})
