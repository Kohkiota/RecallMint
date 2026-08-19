// @vitest-environment jsdom
// WidgetCard: slot ({ header, metric, delta?, action?, children? }) の描画と、
// heading が h2 に固定されていること (ページ h1 の下の一貫階層 — spec §12) を検証する。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { WidgetCard } from './widget-card'

afterEach(() => {
  cleanup()
})

describe('WidgetCard', () => {
  it('header を描画する', () => {
    render(<WidgetCard header="今日の復習" metric="12" />)
    expect(screen.getByText('今日の復習')).toBeInTheDocument()
  })

  it('header の heading level は 2 に固定される', () => {
    render(<WidgetCard header="今日の復習" metric="12" />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('今日の復習')
  })

  it('metric を描画する', () => {
    render(<WidgetCard header="今日の復習" metric="12" />)
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('delta を描画する', () => {
    render(<WidgetCard header="今日の復習" metric="12" delta="+3" />)
    expect(screen.getByText('+3')).toBeInTheDocument()
  })

  it('delta が 0 でも描画する (truthiness で畳まない)', () => {
    // 増減なしは正当な表示内容。 0 は falsy だが空ではない。
    render(<WidgetCard header="今日の復習" metric="12" delta={0} />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('delta 未指定なら delta の span を出さない', () => {
    // 上の pin を「常に描画する」で満たす退行を排除する (metric だけが残ること)。
    const { container } = render(<WidgetCard header="今日の復習" metric="12" />)
    expect(container.querySelectorAll('span')).toHaveLength(1)
  })

  it('action を描画する', () => {
    render(
      <WidgetCard header="今日の復習" metric="12" action={<button>復習する</button>} />,
    )
    expect(screen.getByRole('button', { name: '復習する' })).toBeInTheDocument()
  })

  it('children を描画する', () => {
    render(
      <WidgetCard header="今日の復習" metric="12">
        <p>内訳</p>
      </WidgetCard>,
    )
    expect(screen.getByText('内訳')).toBeInTheDocument()
  })
})
