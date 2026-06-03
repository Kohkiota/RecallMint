// @vitest-environment jsdom
// ConfirmDialog 軽量 modal の render / a11y test。world 統一の自前 modal で
// window.confirm を置き換えるため、focus / Esc / backdrop の最低限 a11y を担保する。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import { ConfirmDialog } from './confirm-dialog'

afterEach(() => {
  cleanup()
})

function renderDialog(
  props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {},
) {
  const onConfirm = props.onConfirm ?? vi.fn()
  const onCancel = props.onCancel ?? vi.fn()
  const utils = render(
    <ConfirmDialog
      open
      title="変更しますか？"
      description="確認の説明文"
      confirmLabel="変更する"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  )
  return { ...utils, onConfirm, onCancel }
}

describe('ConfirmDialog', () => {
  it('open=false では何も描画しない', () => {
    const { container } = renderDialog({ open: false })
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('open のとき title / description / confirm / cancel を表示', () => {
    renderDialog()
    expect(screen.getByText('変更しますか？')).toBeInTheDocument()
    expect(screen.getByText('確認の説明文')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '変更する' })).toBeInTheDocument()
    // cancelLabel 未指定時の default
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument()
  })

  it('role="dialog" + aria-modal が付与される', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // title / description が aria で紐付く
    expect(dialog).toHaveAttribute('aria-labelledby')
    expect(dialog).toHaveAttribute('aria-describedby')
  })

  it('confirm ボタン click で onConfirm を呼ぶ', () => {
    const { onConfirm } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '変更する' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancel ボタン click で onCancel を呼ぶ', () => {
    const { onCancel } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape キーで onCancel を呼ぶ', () => {
    const { onCancel } = renderDialog()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('backdrop click で onCancel を呼ぶ', () => {
    const { onCancel } = renderDialog()
    fireEvent.click(screen.getByTestId('confirm-dialog-backdrop'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('panel 内 click では onCancel を呼ばない', () => {
    const { onCancel } = renderDialog()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('open 時に confirm ボタンへ focus が移る', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: '変更する' })).toHaveFocus()
  })
})
