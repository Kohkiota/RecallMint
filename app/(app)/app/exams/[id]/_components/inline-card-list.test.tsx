// @vitest-environment jsdom
// InlineCardList client component の test。 試験詳細 page の card 一覧描画 +
// 各 card の inline 編集 cell (sort_key / title / question / explanation / memo)
// が含まれる。 「編集」 ボタンは廃止。
//
// 個別 InlineTextField は別 test で網羅、 本 test は一覧結合 (描画 / memo
// section 存在 / 編集ボタン不在 / option 描画維持) を見る。 server action は mock。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { ExamDetailCard } from '@/lib/exams/list'

vi.mock('../_actions/update-card-field', () => ({
  updateCardField: vi.fn(),
}))

import { InlineCardList } from './inline-card-list'

const cards: ExamDetailCard[] = [
  {
    id: 'card-1',
    title: '問1',
    sortKey: '001',
    questionText: '問題文 1',
    options: [
      { id: 'a', text: '選択肢A', is_correct: true, explanation: 'A 理由' },
      { id: 'b', text: '選択肢B', is_correct: false },
    ],
    explanationText: '解説 1',
    memo: 'メモ 1',
  },
  {
    id: 'card-2',
    title: '問2',
    sortKey: null,
    questionText: '問題文 2',
    options: [{ id: 'a', text: 'A', is_correct: true }],
    explanationText: null,
    memo: null,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('InlineCardList', () => {
  it('card 一覧を描画 (title / questionText / option / explanation / memo)', () => {
    render(<InlineCardList cards={cards} />)
    expect(screen.getByText('問1')).toBeInTheDocument()
    expect(screen.getByText('問2')).toBeInTheDocument()
    expect(screen.getByText('問題文 1')).toBeInTheDocument()
    expect(screen.getByText('問題文 2')).toBeInTheDocument()
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.getByText('解説 1')).toBeInTheDocument()
    expect(screen.getByText('メモ 1')).toBeInTheDocument()
  })

  it('「編集」 ボタン (Link to /app/cards/:id) は DOM に存在しない', () => {
    render(<InlineCardList cards={cards} />)
    expect(
      screen.queryByRole('link', { name: '編集' }),
    ).not.toBeInTheDocument()
    // button 形式でも検出されない
    expect(
      screen.queryByRole('button', { name: '編集' }),
    ).not.toBeInTheDocument()
  })

  it('memo section が null card にも placeholder で表示される', () => {
    render(<InlineCardList cards={cards} />)
    // card-2 は memo null → placeholder「メモ (クリックで追加)」 を表示
    expect(screen.getByText('メモ (クリックで追加)')).toBeInTheDocument()
  })

  it('null sortKey / null explanationText の card も描画される (display 用 cell)', () => {
    render(<InlineCardList cards={cards} />)
    // 2 件目の card label が描画されているか
    expect(screen.getByText('問2')).toBeInTheDocument()
    // explanation null → 解説 cell も placeholder 表示 (クリックで追加 等)
    expect(
      screen.getByText('解説 (クリックで追加)'),
    ).toBeInTheDocument()
  })

  it('inline 編集対象 cell (sort_key / title / question / explanation / memo) を各 card 分 button として持つ', () => {
    render(<InlineCardList cards={cards} />)
    // card-1: 5 cells (sort_key / title / question / explanation / memo) = 5 inline button
    // card-2: 5 cells (sort_key null も clickable cell)
    // aria-label に「編集」 を含む button が 10 件
    const editButtons = screen
      .getAllByRole('button')
      .filter((b) => /編集$/.test(b.getAttribute('aria-label') ?? ''))
    expect(editButtons.length).toBe(10)
  })

  it('option の正解 marker (○ / ×) と本文 / 解説は read-only で維持', () => {
    render(<InlineCardList cards={cards} />)
    expect(screen.getByText('A 理由', { exact: false })).toBeInTheDocument()
    // 正解 ○ marker
    expect(screen.getAllByText('○').length).toBeGreaterThan(0)
    expect(screen.getAllByText('×').length).toBeGreaterThan(0)
  })

  it('空 cards でも crash しない (空 list を render)', () => {
    render(<InlineCardList cards={[]} />)
    // 何も描画されないが crash しない
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
