// @vitest-environment jsdom
// QuickPractice(W5)— 5 ボタン。母集合 0 は **disable**(非表示にしない・定義 doc W5)。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { QuickPractice } from './quick-practice'

const EXAM = '11111111-2222-3333-4444-555555555555'

afterEach(() => {
  cleanup()
})

function renderW5(overrides: Partial<React.ComponentProps<typeof QuickPractice>> = {}) {
  return render(
    <QuickPractice
      examId={EXAM}
      mistakeCards={12}
      unansweredCards={40}
      weakCards={3}
      tenMinCards={24}
      {...overrides}
    />,
  )
}

describe('QuickPractice', () => {
  it('4 preset は選択試験付きの quick route へ遷移する', () => {
    renderW5()
    const base = `/app/study/quick?exam=${EXAM}&preset=`
    expect(screen.getByRole('link', { name: /間違い/ })).toHaveAttribute(
      'href',
      `${base}mistakes`,
    )
    expect(screen.getByRole('link', { name: /未出題/ })).toHaveAttribute(
      'href',
      `${base}unanswered`,
    )
    expect(screen.getByRole('link', { name: /苦手/ })).toHaveAttribute(
      'href',
      `${base}weak`,
    )
    expect(screen.getByRole('link', { name: /10分/ })).toHaveAttribute(
      'href',
      `${base}ten_min`,
    )
  })

  it('母集合の件数をボタンに出す', () => {
    renderW5()
    expect(screen.getByRole('link', { name: /間違い/ })).toHaveTextContent('12')
    expect(screen.getByRole('link', { name: /苦手/ })).toHaveTextContent('3')
  })

  it('母集合 0 の preset は disable(リンクにしない・非表示にもしない)', () => {
    renderW5({ weakCards: 0 })
    expect(screen.queryByRole('link', { name: /苦手/ })).toBeNull()
    expect(screen.getByRole('button', { name: /苦手/ })).toBeDisabled()
  })

  it('検出器: 同じ fixture で件数だけ戻すとリンクに戻る', () => {
    renderW5({ weakCards: 1 })
    expect(screen.getByRole('link', { name: /苦手/ })).toBeInTheDocument()
  })

  it('カスタム演習は母集合に依らず常に遷移できる', () => {
    renderW5({ mistakeCards: 0, unansweredCards: 0, weakCards: 0, tenMinCards: 0 })
    expect(screen.getByRole('link', { name: 'カスタム' })).toHaveAttribute(
      'href',
      '/app/study/custom',
    )
  })

  it('W2 の副導線が指すアンカーを持つ', () => {
    const { container } = renderW5()
    expect(container.querySelector('#quick-practice')).not.toBeNull()
  })
})
