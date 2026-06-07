// @vitest-environment jsdom
// 色 palette popover。 trigger click → popover open → cell click で
// onChange(color | null) callback の検証を中心に。 radix Popover は portal
// 描画のため、 screen.getByRole で document 全体から探す。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import { ColorPalettePopover } from './color-palette-popover'
import { TAG_COLOR_NAMES } from '@/lib/tags/color-palette'

afterEach(() => {
  cleanup()
})

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: 'open palette' }))
}

describe('ColorPalettePopover', () => {
  it('trigger click 後に 13 cell (12 色 + 色なし) を表示する', () => {
    render(
      <ColorPalettePopover value={null} onChange={vi.fn()}>
        <button>open palette</button>
      </ColorPalettePopover>,
    )
    openPopover()
    // 12 色 cell
    for (const name of TAG_COLOR_NAMES) {
      expect(
        screen.getByRole('button', { name: new RegExp(`色: ${name}`) }),
      ).toBeInTheDocument()
    }
    // 「色なし」 cell
    expect(
      screen.getByRole('button', { name: /色なし/ }),
    ).toBeInTheDocument()
  })

  it("色 cell click で onChange(name) を呼ぶ", () => {
    const onChange = vi.fn()
    render(
      <ColorPalettePopover value={null} onChange={onChange}>
        <button>open palette</button>
      </ColorPalettePopover>,
    )
    openPopover()
    fireEvent.click(screen.getByRole('button', { name: /色: red/ }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('red')
  })

  it('色なし cell click で onChange(null) を呼ぶ', () => {
    const onChange = vi.fn()
    render(
      <ColorPalettePopover value="red" onChange={onChange}>
        <button>open palette</button>
      </ColorPalettePopover>,
    )
    openPopover()
    fireEvent.click(screen.getByRole('button', { name: /色なし/ }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('現在 value の cell に aria-pressed=true が付く', () => {
    render(
      <ColorPalettePopover value="blue" onChange={vi.fn()}>
        <button>open palette</button>
      </ColorPalettePopover>,
    )
    openPopover()
    const selected = screen.getByRole('button', { name: /色: blue/ })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    const other = screen.getByRole('button', { name: /色: red/ })
    expect(other).toHaveAttribute('aria-pressed', 'false')
  })
})
