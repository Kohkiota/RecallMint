// @vitest-environment jsdom
// InlineCardList client component の test。 試験詳細 page の card 一覧描画 +
// 各 card の inline 編集 cell (sort_key / title / question / explanation / memo)
// + 各 option の inline 編集 row (id / text / is_correct / explanation) が含まれる。
// 「編集」 ボタンは廃止。
//
// 個別 InlineTextField / InlineOptionRow は別 test で網羅、 本 test は一覧結合
// (描画 / memo section 存在 / 編集ボタン不在 / option inline 編集 cell 存在) を
// 見る。 server action は mock。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react'
import type { ExamDetailCard } from '@/lib/exams/list'

vi.mock('../_actions/update-card-field', () => ({
  updateCardField: vi.fn(),
}))

const { mockCreateCard, mockDeleteCard, mockRouterRefresh } = vi.hoisted(() => ({
  mockCreateCard: vi.fn(),
  mockDeleteCard: vi.fn(),
  mockRouterRefresh: vi.fn(),
}))

vi.mock('../_actions/create-card', () => ({
  createCard: mockCreateCard,
}))

vi.mock('../_actions/delete-card', () => ({
  deleteCard: mockDeleteCard,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
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
  mockCreateCard.mockResolvedValue({ ok: true, data: { cardId: 'card-new' } })
  mockDeleteCard.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('InlineCardList', () => {
  it('card 一覧を描画 (title / questionText / option / explanation / memo)', () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    expect(screen.getByText('問1')).toBeInTheDocument()
    expect(screen.getByText('問2')).toBeInTheDocument()
    expect(screen.getByText('問題文 1')).toBeInTheDocument()
    expect(screen.getByText('問題文 2')).toBeInTheDocument()
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.getByText('解説 1')).toBeInTheDocument()
    expect(screen.getByText('メモ 1')).toBeInTheDocument()
  })

  it('「編集」 ボタン (Link to /app/cards/:id) は DOM に存在しない', () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    expect(
      screen.queryByRole('link', { name: '編集' }),
    ).not.toBeInTheDocument()
    // button 形式でも検出されない
    expect(
      screen.queryByRole('button', { name: '編集' }),
    ).not.toBeInTheDocument()
  })

  it('memo section が null card にも placeholder で表示される', () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    // card-2 は memo null → placeholder「メモ (クリックで追加)」 を表示
    expect(screen.getByText('メモ (クリックで追加)')).toBeInTheDocument()
  })

  it('null sortKey / null explanationText の card も描画される (display 用 cell)', () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    // 2 件目の card label が描画されているか
    expect(screen.getByText('問2')).toBeInTheDocument()
    // explanation null → 解説 cell も placeholder 表示 (クリックで追加 等)
    // card-level explanation + option-level explanation 共通 placeholder のため
    // 複数件 hit を許容 (card-2 card 解説 + 各 option 未設定解説)。
    expect(
      screen.getAllByText('解説 (クリックで追加)').length,
    ).toBeGreaterThan(0)
  })

  it('inline 編集対象 cell (sort_key / title / question / explanation / memo + option 3 cell × N) を button として持つ', () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    // card-1: 5 card cells + 2 options × 3 option cell (id/text/explanation) = 11
    // card-2: 5 card cells + 1 option × 3 = 8
    // 合計 19
    const editButtons = screen
      .getAllByRole('button')
      .filter((b) => /編集$/.test(b.getAttribute('aria-label') ?? ''))
    expect(editButtons.length).toBe(19)
  })

  it('option は inline 編集化されている (本文 / 解説 / id が click 可能)', () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    // option の本文 / id / 解説 は inline 編集 cell として描画
    expect(screen.getByText('A 理由', { exact: false })).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' }).length,
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByRole('button', { name: '選択肢 id 編集' }).length,
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByRole('button', { name: '選択肢 解説 編集' }).length,
    ).toBeGreaterThan(0)
  })

  it('option ごとに is_correct checkbox が描画される (card-1 の正解 option は checked)', () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // card-1: 2 options + card-2: 1 option = 3
    expect(checkboxes.length).toBe(3)
    // checked は 2 件 (card-1 の A、 card-2 の A、 いずれも正解)
    expect(checkboxes.filter((c) => c.checked).length).toBe(2)
  })

  it('空 cards でも crash しない (card 0 件 + 「＋ カードを追加」 のみ)', () => {
    render(<InlineCardList cards={[]} examId="exam-1" />)
    // card 由来の inline 編集 cell / checkbox は無いが crash しない。
    // 「＋ カードを追加」 button のみ存在する。
    expect(
      screen
        .queryAllByRole('button')
        .filter((b) => /編集$/.test(b.getAttribute('aria-label') ?? '')),
    ).toHaveLength(0)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(
      screen.getByRole('button', { name: '＋ カードを追加' }),
    ).toBeInTheDocument()
  })

  // ---------------------------------------------------------------------------
  // S2.0b-3: 選択肢ヘッダ横に正解サマリ表示
  // ---------------------------------------------------------------------------

  it('正解サマリ: 正解 1 件の card で 「○ 正解: <id>」 形式で表示される', () => {
    // card-1 は正解 1 件 (id='a')、 card-2 も正解 1 件 (id='a')
    render(<InlineCardList cards={cards} examId="exam-1" />)
    const summaries = screen.getAllByText('○ 正解: a')
    // 2 card 両方で表示されるはず
    expect(summaries.length).toBe(2)
  })

  it('正解サマリ: 複数正解の card で 「○ 正解: a, b」 のように id を join 表示', () => {
    const multiCorrect: ExamDetailCard[] = [
      {
        id: 'card-x',
        title: '問X',
        sortKey: null,
        questionText: '問題文 X',
        options: [
          { id: 'a', text: 'A', is_correct: true },
          { id: 'b', text: 'B', is_correct: true },
          { id: 'c', text: 'C', is_correct: false },
          { id: 'd', text: 'D', is_correct: true },
        ],
        explanationText: null,
        memo: null,
      },
    ]
    render(<InlineCardList cards={multiCorrect} examId="exam-1" />)
    expect(screen.getByText('○ 正解: a, b, d')).toBeInTheDocument()
  })

  it('正解サマリ: 正解 0 件の card ではサマリ要素自体が非表示', () => {
    const noCorrect: ExamDetailCard[] = [
      {
        id: 'card-y',
        title: '問Y',
        sortKey: null,
        questionText: '問題文 Y',
        options: [
          { id: 'a', text: 'A', is_correct: false },
          { id: 'b', text: 'B', is_correct: false },
        ],
        explanationText: null,
        memo: null,
      },
    ]
    render(<InlineCardList cards={noCorrect} examId="exam-1" />)
    // 「○ 正解:」 を含むテキストが存在しないこと
    expect(screen.queryByText(/正解:/)).not.toBeInTheDocument()
  })

  it('正解サマリ: emerald 系の font-medium クラスを持つ (text-emerald-700 + font-medium)', () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    const summary = screen.getAllByText('○ 正解: a')[0]!
    expect(summary.className).toMatch(/text-emerald-700/)
    expect(summary.className).toMatch(/font-medium/)
    expect(summary.className).toMatch(/text-base/)
  })

  // ---------------------------------------------------------------------------
  // S-delete: per-card 削除導線 (Task 5)
  // ---------------------------------------------------------------------------

  it('各 card に「削除」ボタンが描画される (2 cards → 2 個)', () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    expect(deleteButtons.length).toBe(2)
  })

  it('「削除」ボタン click → confirm フェーズに遷移し「削除する」「キャンセル」が表示される', async () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    fireEvent.click(deleteButtons[0]!)
    expect(await screen.findByRole('button', { name: '削除する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument()
  })

  it('「削除する」click → deleteCard(card.id) が呼ばれる', async () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    fireEvent.click(deleteButtons[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(mockDeleteCard).toHaveBeenCalledWith('card-1')
    })
  })

  it('deleteCard 成功 → router.refresh() が呼ばれる', async () => {
    mockDeleteCard.mockResolvedValueOnce({ ok: true })
    render(<InlineCardList cards={cards} examId="exam-1" />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    fireEvent.click(deleteButtons[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalled()
    })
  })

  it('deleteCard 失敗 → inline error 表示、 router.refresh() しない', async () => {
    mockDeleteCard.mockResolvedValueOnce({
      ok: false,
      error: 'カードの削除に失敗しました。',
    })
    render(<InlineCardList cards={cards} examId="exam-1" />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    fireEvent.click(deleteButtons[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))
    expect(
      await screen.findByText('カードの削除に失敗しました。'),
    ).toBeInTheDocument()
    expect(mockRouterRefresh).not.toHaveBeenCalled()
  })

  it('空 cards では「削除」ボタンが存在しない', () => {
    render(<InlineCardList cards={[]} examId="exam-1" />)
    expect(screen.queryAllByRole('button', { name: '削除' })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Bug A fix: 0 cards の時も「＋ カードを追加」 + empty-state hint を表示する
// ---------------------------------------------------------------------------
describe('InlineCardList 0-card empty state', () => {
  it('cards=[] で「＋ カードを追加」 button と empty-state hint が両方表示される', () => {
    render(<InlineCardList cards={[]} examId="exam-1" />)
    // 「＋ カードを追加」 button は常に表示されなければならない
    expect(
      screen.getByRole('button', { name: '＋ カードを追加' }),
    ).toBeInTheDocument()
    // empty-state hint: 「まだカードがありません」 メッセージ
    expect(
      screen.getByText(/まだカードがありません/),
    ).toBeInTheDocument()
    // empty-state hint: 「アップロードから追加」 link (href /app/upload)
    const uploadLink = screen.getByRole('link', { name: 'アップロードから追加' })
    expect(uploadLink).toBeInTheDocument()
    expect(uploadLink).toHaveAttribute('href', '/app/upload')
  })
})

describe('InlineCardList「＋ カードを追加」 (S2.0b)', () => {
  it('button click → createCard(examId) 呼出 + 成功で router.refresh()', async () => {
    render(<InlineCardList cards={cards} examId="exam-1" />)
    fireEvent.click(screen.getByRole('button', { name: '＋ カードを追加' }))
    await waitFor(() => {
      expect(mockCreateCard).toHaveBeenCalledWith('exam-1')
    })
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalled()
    })
  })

  it('createCard 失敗 → inline error 表示、 router.refresh() しない', async () => {
    mockCreateCard.mockResolvedValueOnce({
      ok: false,
      error: 'カードの追加に失敗しました。',
    })
    render(<InlineCardList cards={cards} examId="exam-1" />)
    fireEvent.click(screen.getByRole('button', { name: '＋ カードを追加' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'カードの追加に失敗しました。',
    )
    expect(mockRouterRefresh).not.toHaveBeenCalled()
  })

  it('追加後 refresh で新 card が list に現れたら、 その問題文 cell のみ auto-edit (mount 即 textbox)', async () => {
    // 実際の page では createCard 成功 → newCardId state set → router.refresh() で
    // server component 再実行 → 新 card を含む cards prop で再描画される。 test では
    // refresh を新 card 追加 rerender で模す。 新 card の問題文 cell が mount 時に
    // autoEditOnMount=true で edit mode になる (既存 card は display のまま)。
    const newCard: ExamDetailCard = {
      id: 'card-new',
      title: '新規カード 3',
      sortKey: '3',
      questionText: '(問題文を入力してください)',
      options: [{ id: '1', text: '(選択肢1)', is_correct: false }],
      explanationText: null,
      memo: null,
    }
    mockCreateCard.mockResolvedValueOnce({
      ok: true,
      data: { cardId: 'card-new' },
    })
    // refresh が呼ばれたら新 card を cards に足して rerender (server 再 fetch を模す)
    const { rerender } = render(
      <InlineCardList cards={cards} examId="exam-1" />,
    )
    mockRouterRefresh.mockImplementation(() => {
      rerender(
        <InlineCardList cards={[...cards, newCard]} examId="exam-1" />,
      )
    })
    fireEvent.click(screen.getByRole('button', { name: '＋ カードを追加' }))
    // refresh 後、 新 card の問題文 cell のみ textbox (auto-edit)。 既存 2 card は display。
    await waitFor(() => {
      expect(
        screen.getAllByRole('textbox', { name: '問題文 編集' }),
      ).toHaveLength(1)
    })
  })
})
