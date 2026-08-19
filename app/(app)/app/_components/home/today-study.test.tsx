// @vitest-environment jsdom
// TodayStudy(W2)— Home の唯一の primary CTA。表示(y / n / m / k)と 4 つの状態
// (通常 / 実プール 0 / 現在の対象なし / カード 0 / 学習 0)を pin する。
//
// 「空セッションへ遷移しない」のような**不在の主張**は、その条件に到達したことを
// 観測できないと空振りする。ここでは同じ fixture の 1 変数(poolSize)だけを変えた
// 対照 render を並べ、片方でリンクが出て片方で出ないことを見る(= 条件に実際に
// 到達したことの検出器)。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'

import { TodayStudy } from './today-study'

const EXAM = '11111111-2222-3333-4444-555555555555'

function props(overrides: Partial<React.ComponentProps<typeof TodayStudy>> = {}) {
  return {
    examId: EXAM,
    totalCards: 100,
    newCards: 40,
    n: 18,
    m: 5,
    k: 6,
    poolSize: 24,
    nextAvailableAt: null,
    perCardMs: 20_000,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

describe('TodayStudy — 通常表示(定義 doc W2)', () => {
  it('y = n + k を「残り」として出す', () => {
    render(<TodayStudy {...props()} />)
    expect(screen.getByTestId('today-remaining')).toHaveTextContent('24')
  })

  it('内訳に n・m・k を出す', () => {
    render(<TodayStudy {...props()} />)
    const breakdown = screen.getByTestId('today-breakdown')
    expect(breakdown).toHaveTextContent('復習 18')
    expect(breakdown).toHaveTextContent('持ち越し 5')
    expect(breakdown).toHaveTextContent('新規 6')
  })

  it('約◯分 = 1 問あたり中央値 × y を分に切り上げる', () => {
    // 20,000ms × 24 問 = 480,000ms = 8 分
    render(<TodayStudy {...props()} />)
    expect(screen.getByText('約 8 分')).toBeInTheDocument()
  })

  it('1 分未満でも 0 分にしない(§3.10)', () => {
    render(<TodayStudy {...props({ n: 1, m: 0, k: 0, perCardMs: 1_000, poolSize: 1 })} />)
    expect(screen.getByText('約 1 分')).toBeInTheDocument()
  })

  it('CTA は選択試験 + origin=home_today でスマート復習へ遷移する', () => {
    render(<TodayStudy {...props()} />)
    expect(screen.getByRole('link', { name: '学習を始める' })).toHaveAttribute(
      'href',
      `/app/study/smart?exam=${EXAM}&origin=home_today`,
    )
  })

  it('k は残り枠であって 1 セッションで全部出るとは限らないことを注記する(§8.5)', () => {
    render(<TodayStudy {...props()} />)
    expect(screen.getByTestId('today-breakdown')).toHaveTextContent(
      /新規は残り枠/,
    )
  })
})

describe('TodayStudy — y > 0 かつ実プール 0(spec §8.5 r2 / §13.2)', () => {
  const poolEmpty = props({
    n: 3,
    m: 0,
    k: 0,
    poolSize: 0,
    nextAvailableAt: new Date('2026-08-19T12:30:00Z'), // JST 21:30
  })

  it('CTA を無効化し、スマート復習へのリンクを出さない(空セッションへ遷移しない)', () => {
    render(<TodayStudy {...poolEmpty} />)
    expect(screen.queryByRole('link', { name: '学習を始める' })).toBeNull()
    expect(
      document.querySelector('a[href^="/app/study/smart"]'),
    ).toBeNull()
    expect(screen.getByRole('button', { name: '学習を始める' })).toBeDisabled()
  })

  it('検出器: 同じ fixture で poolSize だけ 1 に戻すとリンクが出る', () => {
    // 上の「出ない」が fixture 全体の不備(例: y===0 分岐に落ちている)で通って
    // いないことを、1 変数だけ変えた対照で確かめる。
    render(<TodayStudy {...poolEmpty} poolSize={1} />)
    expect(screen.getByRole('link', { name: '学習を始める' })).toBeInTheDocument()
  })

  it('次の復習時刻を JST の時で案内する', () => {
    render(<TodayStudy {...poolEmpty} />)
    expect(
      screen.getByText('いま出題できる問題はありません。次の復習は 21 時頃です。'),
    ).toBeInTheDocument()
  })

  it('「現在の対象なし」とは別状態(y は残ったまま表示する)', () => {
    render(<TodayStudy {...poolEmpty} />)
    expect(screen.getByTestId('today-remaining')).toHaveTextContent('3')
    expect(screen.queryByText(/いま解く対象はありません/)).toBeNull()
  })
})

describe('TodayStudy — 現在の対象なし(y === 0・§5)', () => {
  it('「いま解く対象はありません」を出し、完了とは主張しない', () => {
    render(<TodayStudy {...props({ n: 0, m: 0, k: 0, poolSize: 0 })} />)
    expect(screen.getByText(/いま解く対象はありません/)).toBeInTheDocument()
    expect(screen.queryByText(/完了/)).toBeNull()
  })

  it('副導線としてさっと演習へ誘導する', () => {
    render(<TodayStudy {...props({ n: 0, m: 0, k: 0, poolSize: 0 })} />)
    expect(screen.getByRole('link', { name: 'さっと演習を選ぶ' })).toHaveAttribute(
      'href',
      '#quick-practice',
    )
  })

  it('「明日は約◯問」を出さない(定義 doc W2-e)', () => {
    render(<TodayStudy {...props({ n: 0, m: 0, k: 0, poolSize: 0 })} />)
    expect(screen.queryByText(/明日/)).toBeNull()
  })
})

describe('TodayStudy — 試験あり・カード 0(§5)', () => {
  it('問題が無いことと作成導線を出す', () => {
    render(<TodayStudy {...props({ totalCards: 0, newCards: 0, n: 0, m: 0, k: 0, poolSize: 0 })} />)
    expect(
      screen.getByText('この試験にはまだ問題がありません。'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: '画像や PDF から問題を作る' }),
    ).toHaveAttribute('href', '/app/upload')
  })
})

describe('TodayStudy — カードあり・学習 0(§5)', () => {
  it('件数 = min(QUICK_PRESET_N, k) の「最初の◯問を解く」を出す', () => {
    render(
      <TodayStudy {...props({ totalCards: 40, newCards: 40, n: 0, m: 0, k: 20, poolSize: 20 })} />,
    )
    const cta = screen.getByRole('link', { name: '最初の 10 問を解く' })
    expect(cta).toHaveAttribute(
      'href',
      `/app/study/smart?exam=${EXAM}&origin=home_today`,
    )
  })

  it('k が 10 未満なら k 件で出す', () => {
    render(
      <TodayStudy {...props({ totalCards: 40, newCards: 40, n: 0, m: 0, k: 4, poolSize: 4 })} />,
    )
    expect(screen.getByRole('link', { name: '最初の 4 問を解く' })).toBeInTheDocument()
  })

  it('未学習の総数を metric に出す', () => {
    render(
      <TodayStudy {...props({ totalCards: 40, newCards: 40, n: 0, m: 0, k: 20, poolSize: 20 })} />,
    )
    expect(within(screen.getByTestId('today-remaining')).getByText('40')).toBeInTheDocument()
  })

  it('K=0(k=0)なら「最初の◯問」を出さず「現在の対象なし」に落ちる', () => {
    render(
      <TodayStudy {...props({ totalCards: 40, newCards: 40, n: 0, m: 0, k: 0, poolSize: 0 })} />,
    )
    expect(screen.queryByText(/最初の/)).toBeNull()
    expect(screen.getByText(/いま解く対象はありません/)).toBeInTheDocument()
  })
})
