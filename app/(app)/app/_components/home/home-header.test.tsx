// @vitest-environment jsdom
// HomeHeader(W1)— 試験名 + 切替 + 他試験 1 行(spec §4 / §3.1)。
// 「あと◯日」は exam_date が無いため描画しない(Dash-2)。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { ClientExam } from '@/lib/client-db'

import { HomeHeader } from './home-header'

function exam(id: string, name: string): ClientExam {
  return {
    id,
    user_id: 'user-1',
    name,
    content_version: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }
}

const EXAMS = [exam('exam-1', '簿記2級'), exam('exam-2', '簿記1級')]

afterEach(() => {
  cleanup()
})

describe('HomeHeader', () => {
  it('選択中の試験名を h1 に出す', () => {
    render(
      <HomeHeader
        exams={EXAMS}
        examId="exam-1"
        otherExamsReviewDueToday={0}
        onSelectExam={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('簿記2級')
  })

  it('「あと◯日」は描画しない(exam_date は Dash-2)', () => {
    render(
      <HomeHeader
        exams={EXAMS}
        examId="exam-1"
        otherExamsReviewDueToday={0}
        onSelectExam={vi.fn()}
      />,
    )
    expect(screen.queryByText(/あと/)).toBeNull()
  })

  it('切替は keyboard 操作できる combobox で、選択で callback を呼ぶ', () => {
    const onSelectExam = vi.fn()
    render(
      <HomeHeader
        exams={EXAMS}
        examId="exam-1"
        otherExamsReviewDueToday={0}
        onSelectExam={onSelectExam}
      />,
    )
    const select = screen.getByRole('combobox', { name: '試験を切り替える' })
    expect(select).toHaveValue('exam-1')
    fireEvent.change(select, { target: { value: 'exam-2' } })
    expect(onSelectExam).toHaveBeenCalledWith('exam-2')
  })

  it('試験が 1 件だけなら切替を出さない', () => {
    render(
      <HomeHeader
        exams={[EXAMS[0]]}
        examId="exam-1"
        otherExamsReviewDueToday={0}
        onSelectExam={vi.fn()}
      />,
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('簿記2級')
  })

  it('他の試験に復習があれば件数を 1 行で出す', () => {
    render(
      <HomeHeader
        exams={EXAMS}
        examId="exam-1"
        otherExamsReviewDueToday={12}
        onSelectExam={vi.fn()}
      />,
    )
    expect(screen.getByTestId('other-exams')).toHaveTextContent('他の試験: 復習 12 件')
  })

  it('他の試験が 0 件なら行ごと出さない', () => {
    render(
      <HomeHeader
        exams={EXAMS}
        examId="exam-1"
        otherExamsReviewDueToday={0}
        onSelectExam={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('other-exams')).toBeNull()
  })

  it('他の試験の行を押すと切替へフォーカスが移る', () => {
    render(
      <HomeHeader
        exams={EXAMS}
        examId="exam-1"
        otherExamsReviewDueToday={12}
        onSelectExam={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('other-exams'))
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })
})

describe('HomeHeader — 他の試験行の押下可能性', () => {
  it('切替先があるときは button で、押すと select に focus が移る (showPicker 未対応環境の fallback)', () => {
    render(
      <HomeHeader
        exams={EXAMS}
        examId={EXAMS[0].id}
        otherExamsReviewDueToday={4}
        onSelectExam={vi.fn()}
      />,
    )
    const row = screen.getByTestId('other-exams')
    expect(row.tagName).toBe('BUTTON')
    fireEvent.click(row)
    // showPicker() 未実装の jsdom では focus に落ちる (fallback が効いている証拠)。
    expect(document.activeElement).toBe(
      screen.getByRole('combobox', { name: '試験を切り替える' }),
    )
  })

  it('切替先が無いときは押せる見た目にしない(死んだ click を作らない)', () => {
    render(
      <HomeHeader
        exams={[EXAMS[0]]}
        examId={EXAMS[0].id}
        otherExamsReviewDueToday={4}
        onSelectExam={vi.fn()}
      />,
    )
    const row = screen.getByTestId('other-exams')
    expect(row.tagName).not.toBe('BUTTON')
    expect(row).toHaveTextContent('他の試験: 復習 4 件')
  })
})
