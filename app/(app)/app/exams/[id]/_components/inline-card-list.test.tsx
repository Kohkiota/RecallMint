// @vitest-environment jsdom
// InlineCardList client component の test。 試験詳細 page の card 一覧描画 +
// 各 card の inline 編集 cell (sort_key / title / question / explanation / memo)
// + 各 option の inline 編集 row (id / text / is_correct / explanation) が含まれる。
// 「編集」 ボタンは廃止。
//
// 個別 InlineTextField / InlineOptionRow は別 test で網羅、 本 test は一覧結合
// (描画 / memo section 存在 / 編集ボタン不在 / option inline 編集 cell 存在) を
// 見る。 server action は mock。
//
// Task 4.1: 表示 source は Dexie cards mirror の useLiveQuery 直読みに切替済。
// 本 test の描画 assertion は live query 解決後の Dexie 表示を検証するため、
// initialCards に渡す内容と同等の card を mirror に seed する (seedMirror)。
// initialCards は SSR / mirror 未 hydrate 期間の fallback 用 prop。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react'
import type { ExamDetailCard } from '@/lib/exams/list'
import { getClientDb, type ClientCard } from '@/lib/client-db'

vi.mock('../_actions/update-card-field', () => ({
  updateCardField: vi.fn(),
}))

// Task 4.3: create / delete は local-first (mirror insert/remove + outbox enqueue +
// 即時 drain)。 server action / router.refresh / runGuardedPull は廃止。
// enqueueCardMutation / runGuardedCardMutationFlush は spy mock、 mirror write は
// fake-indexeddb の実 Dexie で assert する。 newId は実装を使い (DB に実 UUID を入れる)、
// 採番値は spy で捕捉する。
const { mockEnqueue, mockFlush, mockNewId, realNewId } = vi.hoisted(() => {
  return {
    mockEnqueue: vi.fn(async () => ({}) as never),
    mockFlush: vi.fn(async () => 'no-pending' as const),
    mockNewId: vi.fn<() => string>(),
    realNewId: { current: (): string => crypto.randomUUID() },
  }
})

vi.mock('@/lib/sync/card-mutations', () => ({
  newId: mockNewId,
  enqueueCardMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/card-mutation-flush', () => ({
  runGuardedCardMutationFlush: mockFlush,
}))

import { InlineCardList } from './inline-card-list'

const TEST_USER_ID = 'user-1'
const TEST_EXAM_ID = 'exam-1'

// ExamDetailCard (server 形) を Dexie ClientCard (snake_case) に写像して mirror に
// seed する。 created_at は配列 index で単調増加させ、 server sort
// (sort_key ASC NULLS LAST → created_at ASC) 上で initialCards の並びを保つ。
function toClientCard(card: ExamDetailCard, idx: number): ClientCard {
  return {
    id: card.id,
    user_id: TEST_USER_ID,
    exam_id: TEST_EXAM_ID,
    source_document_id: null,
    title: card.title,
    sort_key: card.sortKey,
    question_text: card.questionText,
    options: card.options,
    correct_answer_ids: [],
    explanation_text: card.explanationText,
    memo: card.memo,
    images: [],
    custom_props: {},
    tags: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-04-22T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 0,
    created_at: `2026-04-${String(idx + 1).padStart(2, '0')}T00:00:00.000Z`,
    updated_at: '2026-04-30T00:00:00.000Z',
    sync_status: 'synced',
  }
}

async function seedMirror(list: ExamDetailCard[]): Promise<void> {
  await getClientDb().cards.bulkPut(list.map(toClientCard))
}

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

beforeEach(async () => {
  vi.clearAllMocks()
  // newId は実 UUID を返す (Dexie の id 列に実値が入る)。 各 test で採番値を捕捉する。
  mockNewId.mockImplementation(() => realNewId.current())
  await getClientDb().cards.clear()
  await getClientDb().card_mutations.clear()
})

afterEach(() => {
  cleanup()
})

describe('InlineCardList', () => {
  it('card 一覧を描画 (title / questionText / option / explanation / memo)', () => {
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    expect(screen.getByText('問1')).toBeInTheDocument()
    expect(screen.getByText('問2')).toBeInTheDocument()
    expect(screen.getByText('問題文 1')).toBeInTheDocument()
    expect(screen.getByText('問題文 2')).toBeInTheDocument()
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.getByText('解説 1')).toBeInTheDocument()
    expect(screen.getByText('メモ 1')).toBeInTheDocument()
  })

  it('「編集」 ボタン (Link to /app/cards/:id) は DOM に存在しない', () => {
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    expect(
      screen.queryByRole('link', { name: '編集' }),
    ).not.toBeInTheDocument()
    // button 形式でも検出されない
    expect(
      screen.queryByRole('button', { name: '編集' }),
    ).not.toBeInTheDocument()
  })

  it('memo section が null card にも placeholder で表示される', () => {
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    // card-2 は memo null → placeholder「メモ (クリックで追加)」 を表示
    expect(screen.getByText('メモ (クリックで追加)')).toBeInTheDocument()
  })

  it('null sortKey / null explanationText の card も描画される (display 用 cell)', () => {
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
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
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    // card-1: 5 card cells + 2 options × 3 option cell (id/text/explanation) = 11
    // card-2: 5 card cells + 1 option × 3 = 8
    // 合計 19
    const editButtons = screen
      .getAllByRole('button')
      .filter((b) => /編集$/.test(b.getAttribute('aria-label') ?? ''))
    expect(editButtons.length).toBe(19)
  })

  it('option は inline 編集化されている (本文 / 解説 / id が click 可能)', () => {
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
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
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // card-1: 2 options + card-2: 1 option = 3
    expect(checkboxes.length).toBe(3)
    // checked は 2 件 (card-1 の A、 card-2 の A、 いずれも正解)
    expect(checkboxes.filter((c) => c.checked).length).toBe(2)
  })

  it('空 cards でも crash しない (card 0 件 + 「＋ カードを追加」 のみ)', () => {
    render(<InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />)
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
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
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
    render(<InlineCardList initialCards={multiCorrect} examId="exam-1" userId="user-1" />)
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
    render(<InlineCardList initialCards={noCorrect} examId="exam-1" userId="user-1" />)
    // 「○ 正解:」 を含むテキストが存在しないこと
    expect(screen.queryByText(/正解:/)).not.toBeInTheDocument()
  })

  it('正解サマリ: emerald 系の font-medium クラスを持つ (text-emerald-700 + font-medium)', () => {
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    const summary = screen.getAllByText('○ 正解: a')[0]!
    expect(summary.className).toMatch(/text-emerald-700/)
    expect(summary.className).toMatch(/font-medium/)
    expect(summary.className).toMatch(/text-base/)
  })

  // ---------------------------------------------------------------------------
  // S-delete: per-card 削除導線 (Task 5)
  // ---------------------------------------------------------------------------

  it('各 card に「削除」ボタンが描画される (2 cards → 2 個)', () => {
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    expect(deleteButtons.length).toBe(2)
  })

  it('「削除」ボタン click → confirm フェーズに遷移し「削除する」「キャンセル」が表示される', async () => {
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    fireEvent.click(deleteButtons[0]!)
    expect(await screen.findByRole('button', { name: '削除する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument()
  })

  it('「削除する」click → mirror から card が remove され一覧から消える + drain', async () => {
    // 削除導線は async wait を挟むため、 live query 解決後も card が表示され続ける
    // よう mirror に seed する (initialCards は undefined 期間 fallback のみ)。
    await seedMirror(cards)
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    // card-1 が表示されているのを確認
    await screen.findByText('問1')
    const deleteButtons = await screen.findAllByRole('button', { name: '削除' })
    fireEvent.click(deleteButtons[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))
    // mirror から card-1 が消える → live query で一覧からも消える
    await waitFor(async () => {
      expect(await getClientDb().cards.get('card-1')).toBeUndefined()
    })
    await waitFor(() => {
      expect(screen.queryByText('問1')).not.toBeInTheDocument()
    })
    // 即時 drain
    await waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('空 cards では「削除」ボタンが存在しない', () => {
    render(<InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />)
    expect(screen.queryAllByRole('button', { name: '削除' })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Bug A fix: 0 cards の時も「＋ カードを追加」 + empty-state hint を表示する
// ---------------------------------------------------------------------------
describe('InlineCardList 0-card empty state', () => {
  it('cards=[] で「＋ カードを追加」 button と empty-state hint が両方表示される', () => {
    render(<InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />)
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

describe('InlineCardList「＋ カードを追加」 (Task 4.3 local-first)', () => {
  // 採番される client id を捕捉するため、 newId mock を 1 回だけ固定値にする。
  function captureNewId(id: string): void {
    mockNewId.mockImplementationOnce(() => id)
  }

  it('button click → 完全な ClientCard を mirror に insert する (content + default)', async () => {
    const NEW_ID = '99999999-9999-4999-8999-999999999999'
    captureNewId(NEW_ID)
    await seedMirror(cards)
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    await screen.findByText('問1')
    fireEvent.click(screen.getByRole('button', { name: '＋ カードを追加' }))

    await waitFor(async () => {
      expect(await getClientDb().cards.get(NEW_ID)).toBeDefined()
    })
    const inserted = (await getClientDb().cards.get(NEW_ID))!
    // content: buildEmptyCard 由来。 既存 sort_key は ['001', null] → null 除外後
    // 全数字なので max(1)+1 = '2'。 count 2 → title は「新規カード 3」。
    expect(inserted.user_id).toBe('user-1')
    expect(inserted.exam_id).toBe('exam-1')
    expect(inserted.title).toBe('新規カード 3')
    expect(inserted.sort_key).toBe('2')
    expect(inserted.question_text).toBe('(問題文を入力してください)')
    expect(inserted.options).toEqual([
      { id: '1', text: '(選択肢1)', is_correct: false },
    ])
    expect(inserted.correct_answer_ids).toEqual([])
    // default の代表値
    expect(inserted.answered).toBe(false)
    expect(inserted.state).toBe(0)
    expect(inserted.content_version).toBe(0)
    expect(inserted.images).toEqual([])
    expect(inserted.custom_props).toEqual({})
    expect(inserted.tags).toEqual([])
    expect(inserted.sync_status).toBe('pending')
  })

  it('button click → create mutation を enqueue (snake_case patch + camelCase options) + drain', async () => {
    const NEW_ID = '88888888-8888-4888-8888-888888888888'
    captureNewId(NEW_ID)
    await seedMirror(cards)
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    await screen.findByText('問1')
    fireEvent.click(screen.getByRole('button', { name: '＋ カードを追加' }))

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        card_id: NEW_ID,
        op: 'create',
        patch: {
          exam_id: 'exam-1',
          title: '新規カード 3',
          sort_key: '2',
          question_text: '(問題文を入力してください)',
          options: [{ id: '1', text: '(選択肢1)', isCorrect: false }],
          explanation_text: null,
          memo: null,
        },
      })
    })
    await waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('追加後 mirror に新 card が現れ、 その問題文 cell のみ auto-edit (mount 即 textbox)', async () => {
    // local-first: mirror insert は同期反映、 newCardId set で当該 card の問題文 cell が
    // autoEditOnMount=true で edit mode になる。 既存 2 card は display のまま。
    const NEW_ID = '77777777-7777-4777-8777-777777777777'
    captureNewId(NEW_ID)
    await seedMirror(cards)
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    await screen.findByText('問1')
    fireEvent.click(screen.getByRole('button', { name: '＋ カードを追加' }))
    // 新 card の問題文 cell のみ textbox (auto-edit)。 既存 2 card は display のまま。
    await waitFor(() => {
      expect(
        screen.getAllByRole('textbox', { name: '問題文 編集' }),
      ).toHaveLength(1)
    })
  })

  it('mirror insert が throw → inline error 表示、 enqueue / drain しない', async () => {
    const spy = vi
      .spyOn(getClientDb().cards, 'add')
      .mockRejectedValueOnce(new Error('boom'))
    render(<InlineCardList initialCards={cards} examId="exam-1" userId="user-1" />)
    fireEvent.click(screen.getByRole('button', { name: '＋ カードを追加' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'カードの追加に失敗しました。',
    )
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
