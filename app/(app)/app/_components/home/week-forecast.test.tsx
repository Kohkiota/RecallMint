// @vitest-environment jsdom
// WeekForecast(W6)— 今後 7 日のミニバー。
// 集計側(持ち越し合算・母集合)の pin は home-aggregate.test.ts にあり、ここでは
// 「今日のバー内で持ち越しを色だけに頼らず区別する」(Task 10 §11.4 の制約)と
// テキスト代替の存在を pin する。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'

import { WeekForecast } from './week-forecast'

// JST 2026-08-19(水)12:00
const NOW = new Date('2026-08-19T03:00:00Z')

afterEach(() => {
  cleanup()
})

function renderW6(overrides: Partial<React.ComponentProps<typeof WeekForecast>> = {}) {
  return render(
    <WeekForecast forecast={[12, 4, 0, 7, 0, 0, 3]} carryover={5} now={NOW} {...overrides} />,
  )
}

describe('WeekForecast', () => {
  it('7 本のバーを出す', () => {
    renderW6()
    expect(screen.getAllByTestId('forecast-bar')).toHaveLength(7)
  })

  it('今日のバーは持ち越しを合算した件数で、内訳をテキストでも出す', () => {
    renderW6()
    const today = screen.getAllByTestId('forecast-bar')[0]
    expect(today).toHaveTextContent('12')
    // バー内は幅が無いので、合算の内訳はウィジェット内の注記として出す
    // (色分けだけに頼らないためのテキスト代替 — Task 10 §11.4)。
    expect(screen.getByTestId('forecast-widget')).toHaveTextContent('うち持ち越し 5 件')
  })

  it('今日のバーは持ち越し分を別セグメントに分割する(色だけに依存しない)', () => {
    renderW6()
    const today = screen.getAllByTestId('forecast-bar')[0]
    expect(within(today).getByTestId('forecast-carryover-segment')).toBeInTheDocument()
    // 他の日には持ち越しセグメントが無い(合算は今日だけ)
    const tomorrow = screen.getAllByTestId('forecast-bar')[1]
    expect(within(tomorrow).queryByTestId('forecast-carryover-segment')).toBeNull()
  })

  it('持ち越し 0 なら分割セグメントも注記も出さない', () => {
    renderW6({ carryover: 0 })
    const today = screen.getAllByTestId('forecast-bar')[0]
    expect(within(today).queryByTestId('forecast-carryover-segment')).toBeNull()
    expect(screen.getByTestId('forecast-widget')).not.toHaveTextContent('うち持ち越し')
  })

  it('各バーに日付ラベルと件数のテキスト代替を付ける', () => {
    renderW6()
    const bars = screen.getAllByTestId('forecast-bar')
    expect(bars[0]).toHaveTextContent('今日')
    expect(bars[1]).toHaveTextContent('木')
    expect(bars[3]).toHaveTextContent('土')
    expect(bars[3]).toHaveTextContent('7')
    expect(screen.getByLabelText('8月22日（土） 7 件')).toBeInTheDocument()
  })

  it('全 7 バーが 0 でも表示する(意味のある 0)', () => {
    renderW6({ forecast: [0, 0, 0, 0, 0, 0, 0], carryover: 0 })
    expect(screen.getAllByTestId('forecast-bar')).toHaveLength(7)
  })
})
