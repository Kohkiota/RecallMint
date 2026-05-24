// `nextOptionId` 純粋関数の単体 test。 元は card-editor.test.tsx 内に同居していたが、
// 共通 util への切り出し (S2.0b-3) に伴い本 file に移動。 caller は
// `app/(app)/app/cards/[id]/_components/card-editor.tsx` (旧来) と
// `app/(app)/app/exams/[id]/_components/inline-option-row.tsx` (S2.0b-3 新規)。

import { describe, it, expect } from 'vitest'
import { nextOptionId } from './next-option-id'

describe('nextOptionId', () => {
  it('英字のみ → 次の英字', () => {
    expect(nextOptionId(['a', 'b', 'c'])).toBe('d')
  })

  it('数字のみ → 最大値 + 1', () => {
    expect(nextOptionId(['1', '2', '3'])).toBe('4')
  })

  it('英字が z まで埋まったら opt-N に fallback', () => {
    const az = Array.from({ length: 26 }, (_, i) =>
      String.fromCharCode(97 + i),
    )
    expect(nextOptionId(az)).toBe('opt-1')
  })

  it('空 / 混在は opt-N、 既存 opt-N とは衝突しない', () => {
    expect(nextOptionId([])).toBe('opt-1')
    expect(nextOptionId(['a', '1'])).toBe('opt-1')
    expect(nextOptionId(['opt-1', 'x'])).toBe('opt-2')
  })
})
