// @vitest-environment jsdom
// exam-card-table-options-cell unit test (Edit-1 T4)。
// OptionsReadonlyCell:
//   - 各 option の text が表示される
//   - is_correct=true の option が emerald ハイライト class を持つ
//   - is_correct=false の option はハイライト class を持たない
//   - 空配列でも throw せず何も/プレースホルダを表示する

import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { render } from '@testing-library/react'
import type { ClientCardOption } from '@/lib/client-db'
import { OptionsReadonlyCell } from './exam-card-table-options-cell'

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function makeOption(overrides: Partial<ClientCardOption> & { id: string; text: string; is_correct: boolean }): ClientCardOption {
  return {
    explanation: undefined,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// case 1: option text が表示される
// ---------------------------------------------------------------------------

describe('OptionsReadonlyCell: テキスト表示', () => {
  it('各 option の text が DOM に含まれる', () => {
    const options: ClientCardOption[] = [
      makeOption({ id: 'A', text: 'りんご', is_correct: true }),
      makeOption({ id: 'B', text: 'みかん', is_correct: false }),
      makeOption({ id: 'C', text: 'ぶどう', is_correct: false }),
    ]
    const { container } = render(<OptionsReadonlyCell options={options} />)
    expect(container.textContent).toContain('りんご')
    expect(container.textContent).toContain('みかん')
    expect(container.textContent).toContain('ぶどう')
  })
})

// ---------------------------------------------------------------------------
// case 2: 正解 option に emerald ハイライト class が付く
// ---------------------------------------------------------------------------

describe('OptionsReadonlyCell: 正解ハイライト', () => {
  it('is_correct=true の li が bg-emerald-100 class を持つ', () => {
    const options: ClientCardOption[] = [
      makeOption({ id: 'A', text: '正解選択肢', is_correct: true }),
      makeOption({ id: 'B', text: '不正解選択肢', is_correct: false }),
    ]
    const { container } = render(<OptionsReadonlyCell options={options} />)
    const items = container.querySelectorAll('li')
    expect(items.length).toBe(2)

    // 正解: bg-emerald-100 を含む
    expect(items[0]!.className).toContain('bg-emerald-100')
    // 正解: border-emerald-300 も含む
    expect(items[0]!.className).toContain('border-emerald-300')
    // 正解: font-bold text-emerald-900 も含む
    expect(items[0]!.className).toContain('text-emerald-900')
    expect(items[0]!.className).toContain('font-bold')
  })

  it('is_correct=false の li は emerald ハイライト class を持たない', () => {
    const options: ClientCardOption[] = [
      makeOption({ id: 'A', text: '正解選択肢', is_correct: true }),
      makeOption({ id: 'B', text: '不正解選択肢', is_correct: false }),
    ]
    const { container } = render(<OptionsReadonlyCell options={options} />)
    const items = container.querySelectorAll('li')

    // 不正解: emerald 系 class なし
    expect(items[1]!.className).not.toContain('bg-emerald-100')
    expect(items[1]!.className).not.toContain('border-emerald-300')
    expect(items[1]!.className).not.toContain('text-emerald-900')
  })

  it('複数の正解 option が全て emerald ハイライトを持つ', () => {
    const options: ClientCardOption[] = [
      makeOption({ id: 'A', text: '正解1', is_correct: true }),
      makeOption({ id: 'B', text: '不正解', is_correct: false }),
      makeOption({ id: 'C', text: '正解2', is_correct: true }),
    ]
    const { container } = render(<OptionsReadonlyCell options={options} />)
    const items = container.querySelectorAll('li')
    expect(items.length).toBe(3)

    expect(items[0]!.className).toContain('bg-emerald-100')
    expect(items[1]!.className).not.toContain('bg-emerald-100')
    expect(items[2]!.className).toContain('bg-emerald-100')
  })
})

// ---------------------------------------------------------------------------
// case 3: 空配列で throw せず placeholder を表示する
// ---------------------------------------------------------------------------

describe('OptionsReadonlyCell: 空配列', () => {
  it('options=[] で throw せずレンダーできる', () => {
    expect(() => render(<OptionsReadonlyCell options={[]} />)).not.toThrow()
  })

  it('options=[] のとき li が存在しない', () => {
    const { container } = render(<OptionsReadonlyCell options={[]} />)
    const items = container.querySelectorAll('li')
    expect(items.length).toBe(0)
  })

  it('options=[] のとき muted placeholder が表示される', () => {
    const { container } = render(<OptionsReadonlyCell options={[]} />)
    // 「—」などのプレースホルダが含まれる
    expect(container.textContent).toMatch(/[—\-]/)
  })
})
