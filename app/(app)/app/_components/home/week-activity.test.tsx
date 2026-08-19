// @vitest-environment jsdom
// WeekActivity(W7)— 今週(全試験)。delta の非表示条件(§4-Q)と、全試験である
// ことの明記(OT 裁定 2)、61 日頭打ち表記(pin 12)を pin する。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { WeekActivity } from './week-activity'

afterEach(() => {
  cleanup()
})

function renderW7(overrides: Partial<React.ComponentProps<typeof WeekActivity>> = {}) {
  return render(
    <WeekActivity
      answers={132}
      studyDays={4}
      delta={18}
      streak={7}
      todayCardCount={23}
      {...overrides}
    />,
  )
}

describe('WeekActivity', () => {
  it('全試験の値であることを見出しに書く', () => {
    renderW7()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      '今週（全試験）',
    )
  })

  it('回答数・学習日数・連続日数・今日の学習量を出す', () => {
    renderW7()
    expect(screen.getByTestId('week-answers')).toHaveTextContent('132')
    expect(screen.getByTestId('week-study-days')).toHaveTextContent('4 日')
    expect(screen.getByTestId('week-streak')).toHaveTextContent('7 日')
    expect(screen.getByTestId('week-today')).toHaveTextContent('23')
  })

  it('delta は符号付きで、同期間比であることを添える', () => {
    renderW7()
    expect(screen.getByTestId('week-delta')).toHaveTextContent('+18')
    expect(screen.getByTestId('week-delta')).toHaveTextContent('先週同期間比')
  })

  it('delta が 0 なら ±0 を出す(非表示にしない)', () => {
    renderW7({ delta: 0 })
    expect(screen.getByTestId('week-delta')).toHaveTextContent('±0')
  })

  it('delta が負なら符号を付けて出す', () => {
    renderW7({ delta: -4 })
    expect(screen.getByTestId('week-delta')).toHaveTextContent('-4')
  })

  it('delta が null なら delta を一切出さない(月曜 / 先週同期間に行なし)', () => {
    renderW7({ delta: null })
    expect(screen.queryByTestId('week-delta')).toBeNull()
    expect(screen.queryByText(/先週同期間比/)).toBeNull()
  })

  it('連続日数が window 上限に達したら「61 日以上」と表記する', () => {
    renderW7({ streak: 61 })
    expect(screen.getByTestId('week-streak')).toHaveTextContent('61 日以上')
  })
})
