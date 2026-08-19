// @vitest-environment jsdom
// StateSummary(W3)— MECE な 3 状態 + 別段の横断指標(持ち越し)。
// 「同列 4 カウンタにしない」(定義 doc W3 の確定事項)を構造で pin する。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'

import { StateSummary } from './state-summary'

const EXAM = '11111111-2222-3333-4444-555555555555'

afterEach(() => {
  cleanup()
})

function renderW3(overrides: Partial<React.ComponentProps<typeof StateSummary>> = {}) {
  return render(
    <StateSummary
      examId={EXAM}
      newCards={42}
      learningCards={31}
      matureCards={18}
      carryover={5}
      {...overrides}
    />,
  )
}

describe('StateSummary', () => {
  it('3 状態を同じ行に並べる', () => {
    renderW3()
    const row = screen.getByTestId('state-counters')
    expect(within(row).getByText('未学習')).toBeInTheDocument()
    expect(within(row).getByText('学習中')).toBeInTheDocument()
    expect(within(row).getByText('定着')).toBeInTheDocument()
    expect(within(row).getByText('42')).toBeInTheDocument()
    expect(within(row).getByText('31')).toBeInTheDocument()
    expect(within(row).getByText('18')).toBeInTheDocument()
  })

  it('持ち越しは 3 カウンタと同列に置かない(別段)', () => {
    renderW3()
    const row = screen.getByTestId('state-counters')
    expect(within(row).queryByText('持ち越し')).toBeNull()
    expect(screen.getByTestId('state-carryover')).toHaveTextContent('持ち越し 5 件')
  })

  it('持ち越しの行から演習へ入れる', () => {
    renderW3()
    const carryoverRow = screen.getByTestId('state-carryover')
    expect(within(carryoverRow).getByRole('link')).toHaveAttribute(
      'href',
      `/app/study/smart?exam=${EXAM}&origin=home_today`,
    )
  })

  it('持ち越し 0 なら別段の行ごと出さない', () => {
    renderW3({ carryover: 0 })
    expect(screen.queryByTestId('state-carryover')).toBeNull()
    expect(screen.getByTestId('state-counters')).toBeInTheDocument()
  })
})
