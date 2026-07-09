import { describe, it, expect } from 'vitest'
import type { SelectType } from '@/lib/tags/domain/tag-values'
import { hasSingleCategoryOverflow } from './card-tag-constraint'

const single: SelectType = 'single'
const multi: SelectType = 'multi'

describe('hasSingleCategoryOverflow', () => {
  it('single カテゴリに option 2 個 → true (違反)', () => {
    expect(
      hasSingleCategoryOverflow(
        [{ categoryId: 'c1' }, { categoryId: 'c1' }],
        [{ id: 'c1', selectType: single }],
      ),
    ).toBe(true)
  })

  it('single カテゴリに option 1 個 → false', () => {
    expect(
      hasSingleCategoryOverflow(
        [{ categoryId: 'c1' }],
        [{ id: 'c1', selectType: single }],
      ),
    ).toBe(false)
  })

  it('multi カテゴリに option N 個 → false (multi は無制限)', () => {
    expect(
      hasSingleCategoryOverflow(
        [{ categoryId: 'c1' }, { categoryId: 'c1' }, { categoryId: 'c1' }],
        [{ id: 'c1', selectType: multi }],
      ),
    ).toBe(false)
  })

  it('混在 (single-overflow + multi) → true (single 違反があれば true)', () => {
    expect(
      hasSingleCategoryOverflow(
        [
          { categoryId: 'c1' },
          { categoryId: 'c1' },
          { categoryId: 'c2' },
          { categoryId: 'c2' },
        ],
        [
          { id: 'c1', selectType: single },
          { id: 'c2', selectType: multi },
        ],
      ),
    ).toBe(true)
  })

  it('空 assigned → false', () => {
    expect(
      hasSingleCategoryOverflow([], [{ id: 'c1', selectType: single }]),
    ).toBe(false)
  })

  it('single カテゴリが categories にあるが option 0 個 → false', () => {
    expect(
      hasSingleCategoryOverflow(
        [{ categoryId: 'c2' }],
        [
          { id: 'c1', selectType: single },
          { id: 'c2', selectType: multi },
        ],
      ),
    ).toBe(false)
  })
})
