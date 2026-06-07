// @vitest-environment jsdom
// CardTagEditFields: rename input + color picker + delete button + inline error の
// 各シナリオを pin する unit test。
// ファイル作成理由: Tag-4c-1 Task 2 にて新規追加された編集フィールド sub-component のテスト。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import { type TagColorName } from '@/lib/tags/color-palette'
import { CardTagEditFields } from './card-tag-edit-fields'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// fixture defaults
// ---------------------------------------------------------------------------

type ImpactCount = { optionCount?: number; cardCount: number }

type FieldProps = {
  kind: 'category' | 'option'
  name: string
  color: string | null
  onRename: (next: string) => Promise<void>
  onColorChange: (next: TagColorName | null) => Promise<void>
  onDelete: () => Promise<void>
  countImpact: () => Promise<ImpactCount>
  errorMessage: string | null
}

function makeProps(overrides?: Partial<FieldProps>): FieldProps {
  return {
    kind: 'category',
    name: '分野',
    color: null,
    onRename: vi.fn().mockResolvedValue(undefined) as (next: string) => Promise<void>,
    onColorChange: vi.fn().mockResolvedValue(undefined) as (next: TagColorName | null) => Promise<void>,
    onDelete: vi.fn().mockResolvedValue(undefined) as () => Promise<void>,
    countImpact: vi.fn().mockResolvedValue({ optionCount: 3, cardCount: 5 }) as () => Promise<ImpactCount>,
    errorMessage: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. rename input に初期 name が表示される
// ---------------------------------------------------------------------------

describe('CardTagEditFields — rename input 初期値', () => {
  it('category kind, name="分野" → input の value が "分野"', () => {
    const props = makeProps()
    render(<CardTagEditFields {...props} />)
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' })
    expect(input).toBeInTheDocument()
    expect((input as HTMLInputElement).value).toBe('分野')
  })

  it('option kind の input aria-label が "option名 編集"', () => {
    const props = makeProps({ kind: 'option', name: '循環器' })
    render(<CardTagEditFields {...props} />)
    const input = screen.getByRole('textbox', { name: 'option名 編集' })
    expect((input as HTMLInputElement).value).toBe('循環器')
  })
})

// ---------------------------------------------------------------------------
// 2. Enter → onRename が呼ばれる
// ---------------------------------------------------------------------------

describe('CardTagEditFields — Enter で onRename', () => {
  it('input の値を変更して Enter → onRename が trimmed 値で呼ばれる', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const props = makeProps({ onRename })
    render(<CardTagEditFields {...props} />)
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' })

    fireEvent.change(input, { target: { value: '分野2' } })
    // jsdom では keyDown が実際に blur を起こさないため、
    // Enter → 実装内の e.target.blur() → handleBlur の流れを再現するため
    // 明示的に blur も fire する。
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    // Enter → blur → onRename
    await waitFor(() => {
      expect(onRename).toHaveBeenCalledTimes(1)
      expect(onRename).toHaveBeenCalledWith('分野2')
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Blur → onRename が呼ばれる
// ---------------------------------------------------------------------------

describe('CardTagEditFields — Blur で onRename', () => {
  it('input の値を変更して blur → onRename が呼ばれる', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const props = makeProps({ onRename })
    render(<CardTagEditFields {...props} />)
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' })

    fireEvent.change(input, { target: { value: '分野3' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledTimes(1)
      expect(onRename).toHaveBeenCalledWith('分野3')
    })
  })
})

// ---------------------------------------------------------------------------
// 4. 空文字で blur → onRename が呼ばれない (short-circuit)
// ---------------------------------------------------------------------------

describe('CardTagEditFields — 空 short-circuit', () => {
  it('input を空にして blur → onRename が呼ばれない', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const props = makeProps({ onRename })
    render(<CardTagEditFields {...props} />)
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' })

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    // 少し待っても呼ばれない
    await new Promise((r) => setTimeout(r, 50))
    expect(onRename).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 5. 同値で blur → onRename が呼ばれない (short-circuit)
// ---------------------------------------------------------------------------

describe('CardTagEditFields — 同値 short-circuit', () => {
  it('値を変更せず blur → onRename が呼ばれない', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const props = makeProps({ onRename })
    render(<CardTagEditFields {...props} />)
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' })

    // 同じ値のまま blur
    fireEvent.blur(input)

    await new Promise((r) => setTimeout(r, 50))
    expect(onRename).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 6. trim されて onRename が呼ばれる
// ---------------------------------------------------------------------------

describe('CardTagEditFields — trim', () => {
  it('前後スペース付きで blur → trimmed 値で onRename が呼ばれる', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const props = makeProps({ onRename })
    render(<CardTagEditFields {...props} />)
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' })

    fireEvent.change(input, { target: { value: '  分野4  ' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith('分野4')
    })
  })
})

// ---------------------------------------------------------------------------
// 7. Esc → input の値が元に戻り、 Esc イベントが親に bubble する
// ---------------------------------------------------------------------------

describe('CardTagEditFields — Esc 挙動', () => {
  it('input 値変更後 Esc → 値が元に戻り、 onRename は呼ばれず、 React synthetic keydown bubble (Radix onEscapeKeyDown contract は Task 3/4 integration test で担保)', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const parentKeyDown = vi.fn()
    const props = makeProps({ onRename })

    render(
      <div onKeyDown={parentKeyDown}>
        <CardTagEditFields {...props} />
      </div>,
    )
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' })

    // 値を変更してから Esc
    fireEvent.change(input, { target: { value: '違う値' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    // input 値が元に戻る
    expect((input as HTMLInputElement).value).toBe('分野')

    // onRename は呼ばれない (blur は short-circuit)
    await new Promise((r) => setTimeout(r, 50))
    expect(onRename).not.toHaveBeenCalled()

    // React synthetic bubble のみ検証 (Radix onEscapeKeyDown contract は Task 3/4 integration test で担保)
    expect(parentKeyDown).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const escEvent = (parentKeyDown.mock.calls as any[][]).find(
      (call) => (call[0] as React.KeyboardEvent).key === 'Escape',
    )
    expect(escEvent).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 8. color picker trigger 描画 / 色選択 → onColorChange 呼出
// ---------------------------------------------------------------------------

describe('CardTagEditFields — color picker', () => {
  it('色変更 button が aria-label="色を変更" で描画される', () => {
    const props = makeProps({ color: 'red' })
    render(<CardTagEditFields {...props} />)
    expect(screen.getByRole('button', { name: '色を変更' })).toBeInTheDocument()
  })

  it('色 pill button を click すると color picker が開く', () => {
    const props = makeProps()
    render(<CardTagEditFields {...props} />)
    const colorBtn = screen.getByRole('button', { name: '色を変更' })
    fireEvent.click(colorBtn)
    // ColorPalettePopover の grid が表示される
    expect(screen.getByRole('group', { name: 'タグの色を選択' })).toBeInTheDocument()
  })

  it('色セルを click すると onColorChange がその色名で呼ばれる', async () => {
    const onColorChange = vi.fn().mockResolvedValue(undefined)
    const props = makeProps({ onColorChange })
    render(<CardTagEditFields {...props} />)

    // picker を開く
    fireEvent.click(screen.getByRole('button', { name: '色を変更' }))
    // "red" セルを click
    const redCell = screen.getByRole('button', { name: '色: red' })
    fireEvent.click(redCell)

    await waitFor(() => {
      expect(onColorChange).toHaveBeenCalledTimes(1)
      expect(onColorChange).toHaveBeenCalledWith('red')
    })
  })

  it('「色なし」 セルを click すると onColorChange(null) が呼ばれる', async () => {
    const onColorChange = vi.fn().mockResolvedValue(undefined)
    const props = makeProps({ color: 'blue', onColorChange })
    render(<CardTagEditFields {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '色を変更' }))
    const noColorCell = screen.getByRole('button', { name: '色なし' })
    fireEvent.click(noColorCell)

    await waitFor(() => {
      expect(onColorChange).toHaveBeenCalledWith(null)
    })
  })
})

// ---------------------------------------------------------------------------
// 9. errorMessage の表示
// ---------------------------------------------------------------------------

describe('CardTagEditFields — errorMessage 表示', () => {
  it('errorMessage が非 null のとき role="alert" の p タグが表示される', () => {
    const props = makeProps({ errorMessage: '削除に失敗しました' })
    render(<CardTagEditFields {...props} />)
    const alert = screen.getByRole('alert')
    expect(alert).toBeInTheDocument()
    expect(alert.textContent).toBe('削除に失敗しました')
  })

  it('errorMessage が null のとき alert は表示されない', () => {
    const props = makeProps({ errorMessage: null })
    render(<CardTagEditFields {...props} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 10. delete button が描画され、 click で countImpact が呼ばれて dialog が開く (kind='category')
// ---------------------------------------------------------------------------

describe('CardTagEditFields — delete button → dialog open (kind=category)', () => {
  it('Trash アイコン付きの「削除」 button が描画される', () => {
    const props = makeProps({ kind: 'category' })
    render(<CardTagEditFields {...props} />)
    // aria-label か text で確認
    expect(screen.getByRole('button', { name: /削除/ })).toBeInTheDocument()
  })

  it('kind=category: 削除 button を click すると countImpact が呼ばれ DeleteConfirmDialog が開く', async () => {
    const countImpact = vi.fn().mockResolvedValue({ optionCount: 3, cardCount: 5 })
    const props = makeProps({ kind: 'category', countImpact })
    render(<CardTagEditFields {...props} />)

    const deleteBtn = screen.getByRole('button', { name: /削除/ })
    fireEvent.click(deleteBtn)

    await waitFor(() => {
      expect(countImpact).toHaveBeenCalledTimes(1)
    })

    // ConfirmDialog (portal) が開いている → title が見える
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
  })

  // Fix A-3: option 削除は即削除 (dialog なし)
  it('Fix A-3: kind=option で削除 button click → onDelete 直接呼出 + DeleteConfirmDialog mount されない + countImpact 呼ばれない', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const countImpact = vi.fn().mockResolvedValue({ cardCount: 0 })
    const props = makeProps({ kind: 'option', onDelete, countImpact })
    render(<CardTagEditFields {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /削除/ }))

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledTimes(1)
    })

    // countImpact は呼ばれない
    expect(countImpact).not.toHaveBeenCalled()

    // DeleteConfirmDialog は mount されない (dialog ロールがない)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 11. confirm → onDelete が呼ばれる (kind='category')
// ---------------------------------------------------------------------------

describe('CardTagEditFields — confirm → onDelete', () => {
  it('kind=category: 「削除する」 を click すると onDelete が 1 回呼ばれる', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const countImpact = vi.fn().mockResolvedValue({ optionCount: 2, cardCount: 4 })
    const props = makeProps({ kind: 'category', onDelete, countImpact })
    render(<CardTagEditFields {...props} />)

    // dialog を開く
    fireEvent.click(screen.getByRole('button', { name: /削除/ }))
    await waitFor(() => screen.getByRole('dialog'))

    // 確定
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledTimes(1)
    })
  })
})

// ---------------------------------------------------------------------------
// 12. cancel → onDelete は呼ばれない (kind='category')
// ---------------------------------------------------------------------------

describe('CardTagEditFields — cancel → no-op', () => {
  it('kind=category: 「キャンセル」 を click すると dialog が閉じ onDelete は呼ばれない', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const countImpact = vi.fn().mockResolvedValue({ optionCount: 1, cardCount: 2 })
    const props = makeProps({ kind: 'category', onDelete, countImpact })
    render(<CardTagEditFields {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /削除/ }))
    await waitFor(() => screen.getByRole('dialog'))

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))

    // dialog が閉じる
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(onDelete).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 13. kind='category' → childOptionCount が dialog に反映される
// ---------------------------------------------------------------------------

describe('CardTagEditFields — category kind の dialog 文言', () => {
  it('countImpact={optionCount:5, cardCount:10} → dialog に option 5 件 と card 10 件 が含まれる', async () => {
    const countImpact = vi.fn().mockResolvedValue({ optionCount: 5, cardCount: 10 }) as () => Promise<ImpactCount>
    const props = makeProps({ kind: 'category', name: '分野', countImpact })
    render(<CardTagEditFields {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /削除/ }))
    await waitFor(() => screen.getByRole('dialog'))

    // DeleteConfirmDialog category 文言: 「配下の option N 件、 紐付き card M 件」
    const desc = screen.getByRole('dialog')
    expect(desc.textContent).toContain('option 5 件')
    expect(desc.textContent).toContain('card 10 件')
  })
})

// ---------------------------------------------------------------------------
// 14. Fix A-3: kind='option' → DeleteConfirmDialog は mount されない (即削除)
// ---------------------------------------------------------------------------

describe('CardTagEditFields — Fix A-3: option kind は dialog なし', () => {
  it('kind=option: 削除 button click で DeleteConfirmDialog は mount されず onDelete が直接呼ばれる', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const countImpact = vi.fn().mockResolvedValue({ cardCount: 7 }) as () => Promise<ImpactCount>
    const props = makeProps({ kind: 'option', name: '循環器', onDelete, countImpact })
    render(<CardTagEditFields {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /削除/ }))

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledTimes(1)
    })
    // dialog は mount されない
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // countImpact は呼ばれない
    expect(countImpact).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 15. countImpact reject → countError 表示 + DeleteConfirmDialog 開かない + onDelete 呼ばれない
// ---------------------------------------------------------------------------

describe('CardTagEditFields — countImpact 失敗時の inline error (kind=category)', () => {
  it('kind=category: countImpact が reject → inline error 表示 + dialog は開かない + onDelete は呼ばれない', async () => {
    const countImpact = vi.fn().mockRejectedValue(new Error('network error'))
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const props = makeProps({ kind: 'category', countImpact, onDelete })
    render(<CardTagEditFields {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /削除/ }))

    // inline error が表示される
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(screen.getByRole('alert').textContent).toBe('削除前の件数取得に失敗しました')

    // dialog は開かない
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // onDelete は呼ばれない
    expect(onDelete).not.toHaveBeenCalled()
  })
})
