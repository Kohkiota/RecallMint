// @vitest-environment jsdom
// tag manager 専用の削除確認 modal。 既存 ConfirmDialog の薄いラッパーであるため
// modal 機構そのものの a11y は ConfirmDialog 側 test に委ね、 ここでは文言生成
// (childOptionCount / cardCount / 100+ 省略) を中心に固定する。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import { DeleteConfirmDialog } from './delete-confirm-dialog'

afterEach(() => {
  cleanup()
})

describe('DeleteConfirmDialog (category)', () => {
  it('カテゴリ削除文言に option 数 / card 数を含む', () => {
    render(
      <DeleteConfirmDialog
        open
        targetKind="category"
        targetName="重要度"
        childOptionCount={3}
        cardCount={5}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    // title
    expect(
      screen.getByText(/カテゴリ.*重要度.*削除しますか/),
    ).toBeInTheDocument()
    // description に option 3 件 + card 5 件
    expect(
      screen.getByText(/配下の option 3 件.*紐付き card 5 件/),
    ).toBeInTheDocument()
  })

  it('cardCount >= 100 は 100+ で表示する', () => {
    render(
      <DeleteConfirmDialog
        open
        targetKind="category"
        targetName="X"
        childOptionCount={150}
        cardCount={200}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(
      screen.getByText(/配下の option 100\+ 件.*紐付き card 100\+ 件/),
    ).toBeInTheDocument()
  })
})

describe('DeleteConfirmDialog (option)', () => {
  it('option 削除文言に card 数を含む', () => {
    render(
      <DeleteConfirmDialog
        open
        targetKind="option"
        targetName="高"
        cardCount={2}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(
      screen.getByText(/option.*高.*削除しますか/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/2 件の card に紐付いています/),
    ).toBeInTheDocument()
  })

  it('cardCount >= 100 は 100+ で表示する', () => {
    render(
      <DeleteConfirmDialog
        open
        targetKind="option"
        targetName="Y"
        cardCount={500}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(
      screen.getByText(/100\+ 件の card に紐付いています/),
    ).toBeInTheDocument()
  })
})

describe('DeleteConfirmDialog interactions', () => {
  it('「削除する」 click で onConfirm を呼ぶ', () => {
    const onConfirm = vi.fn()
    render(
      <DeleteConfirmDialog
        open
        targetKind="option"
        targetName="X"
        cardCount={1}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('「キャンセル」 click で onCancel を呼ぶ', () => {
    const onCancel = vi.fn()
    render(
      <DeleteConfirmDialog
        open
        targetKind="option"
        targetName="X"
        cardCount={1}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('open=false では何も描画しない', () => {
    const { container } = render(
      <DeleteConfirmDialog
        open={false}
        targetKind="option"
        targetName="X"
        cardCount={1}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
