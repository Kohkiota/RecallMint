// @vitest-environment jsdom
// Task 4.1: InlineCardList が cards 表示 source を Dexie cards mirror の
// useLiveQuery 直読みに切替えた挙動の test。
//
// 検証観点:
// - live 反映: Dexie mirror を seed → render で表示、 mirror を put 変更 → UI 追従
// - exam filter: 別 exam_id の card は除外
// - owner-scope: 別 user_id の card は除外
// - sort: server (sort_key ASC NULLS LAST → created_at ASC) と一致
// - SSR / 初期 fallback: useLiveQuery が undefined の間は initialCards を表示し、
//   resolve 後は Dexie mirror が単一の真実 (initialCards に在って mirror に無い
//   card は resolve 後に消える = length===0 永続 fallback でないことの証明)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react'
import {
  getClientDb,
  type ClientCard,
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'
import type { ExamDetailCard } from '@/lib/exams/list'

// 本 test は表示 source (Dexie mirror live-read) のみ検証、 編集経路は別 test で
// 網羅。 InlineCardList とその子は server action / pull / next/navigation を
// 一切 import しないため (Task 4.x local-first cutover 済)、 mock は不要。
//
// Tag-4b Task 3 で tag mutation 経路 (enqueue / flush) も配線するため、 sync 層は
// spy mock する (実 mutation を outbox に積まずに UI assertion のみ検証)。
const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/sync/entity-mutations')
  >('@/lib/sync/entity-mutations')
  return {
    ...actual,
    enqueueEntityMutation: mockEnqueue,
  }
})
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { InlineCardList } from './inline-card-list'

function fakeClientCard(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: 'タイトル',
    sort_key: null,
    question_text: '問題文',
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
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
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  const db = getClientDb()
  await db.cards.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

// Tag-4b Task 3 fixture: tag mirror seed 用 factory。
const TAG_USER_ID = 'user-1'

function makeCategory(
  id: string,
  name: string,
  selectType: 'single' | 'multi',
  createdAt: string,
): ClientTagCategory {
  return {
    id,
    user_id: TAG_USER_ID,
    name,
    select_type: selectType,
    color: null,
    sort_key: null,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function makeOption(
  id: string,
  categoryId: string,
  name: string,
  createdAt = '2026-06-01T00:00:00.000Z',
): ClientTagOption {
  return {
    id,
    user_id: TAG_USER_ID,
    category_id: categoryId,
    name,
    color: null,
    sort_key: null,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function makeCardTag(cardId: string, optionId: string): ClientCardTag {
  return {
    card_id: cardId,
    option_id: optionId,
    user_id: TAG_USER_ID,
    created_at: '2026-06-01T00:00:00.000Z',
  }
}

describe('InlineCardList Dexie live-read (Task 4.1)', () => {
  it('mirror を seed → title / 問題文 が表示される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({
        id: 'c1',
        title: '問1',
        question_text: '問題文 1',
        sort_key: '001',
      }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('問1')).toBeInTheDocument()
      expect(screen.getByText('問題文 1')).toBeInTheDocument()
    })
  })

  it('mirror の変化が live 反映される (put で title 変更 → UI 追従)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', title: '旧タイトル', question_text: 'Q1' }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('旧タイトル')).toBeInTheDocument()
    })
    await act(async () => {
      await getClientDb().cards.put(
        fakeClientCard({ id: 'c1', title: '新タイトル', question_text: 'Q1' }),
      )
    })
    await waitFor(() => {
      expect(screen.getByText('新タイトル')).toBeInTheDocument()
    })
    expect(screen.queryByText('旧タイトル')).not.toBeInTheDocument()
  })

  it('exam filter: 別 exam_id の card は除外される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', exam_id: 'exam-1', title: '対象 card' }),
      fakeClientCard({ id: 'c2', exam_id: 'exam-OTHER', title: '別試験 card' }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('対象 card')).toBeInTheDocument()
    })
    expect(screen.queryByText('別試験 card')).not.toBeInTheDocument()
  })

  it('owner-scope: 別 user_id の card は除外される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', user_id: 'user-1', title: '自分の card' }),
      fakeClientCard({ id: 'c2', user_id: 'user-OTHER', title: '他人の card' }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('自分の card')).toBeInTheDocument()
    })
    expect(screen.queryByText('他人の card')).not.toBeInTheDocument()
  })

  it('sort: sort_key ASC NULLS LAST → created_at ASC で server と一致', async () => {
    // 期待順: sort_key='001'(b) → sort_key='002'(a) → sort_key=null は末尾、
    //         null 同士は created_at ASC で d → c
    await getClientDb().cards.bulkPut([
      fakeClientCard({
        id: 'a',
        sort_key: '002',
        title: 'A',
        created_at: '2026-04-01T00:00:00.000Z',
      }),
      fakeClientCard({
        id: 'b',
        sort_key: '001',
        title: 'B',
        created_at: '2026-04-01T00:00:00.000Z',
      }),
      fakeClientCard({
        id: 'c',
        sort_key: null,
        title: 'C',
        created_at: '2026-04-05T00:00:00.000Z',
      }),
      fakeClientCard({
        id: 'd',
        sort_key: null,
        title: 'D',
        created_at: '2026-04-03T00:00:00.000Z',
      }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('A')).toBeInTheDocument()
    })
    // title cell は aria-label「タイトル 編集」 の button。 DOM 出現順を取り出す。
    const titleCells = screen.getAllByRole('button', { name: 'タイトル 編集' })
    const order = titleCells.map((el) => el.textContent)
    expect(order).toEqual(['B', 'A', 'D', 'C'])
  })

  it('SSR/初期 fallback: useLiveQuery undefined の間は initialCards を表示', () => {
    // render 同期直後 (microtask 未消化) は useLiveQuery が undefined。 この瞬間に
    // initialCards が描画される。
    const initialCards: ExamDetailCard[] = [
      {
        id: 'ssr-1',
        title: 'SSR タイトル',
        sortKey: '001',
        questionText: 'SSR 問題文',
        options: [],
        explanationText: null,
        memo: null,
      },
    ]
    render(
      <InlineCardList
        initialCards={initialCards}
        examId="exam-1"
        userId="user-1"
      />,
    )
    // 同期直後: live query 未解決のため initialCards が見える
    expect(screen.getByText('SSR タイトル')).toBeInTheDocument()
  })

  it('resolve 後は Dexie が単一の真実: initialCards に在り mirror に無い card は消える', async () => {
    // mirror は空。 initialCards に 1 件。 resolve 後 mirror=[] を信頼するため、
    // length===0 でも server fallback せず、 initialCards の card は消える。
    const initialCards: ExamDetailCard[] = [
      {
        id: 'stale-1',
        title: 'server 残存 card',
        sortKey: null,
        questionText: 'Q',
        options: [],
        explanationText: null,
        memo: null,
      },
    ]
    render(
      <InlineCardList
        initialCards={initialCards}
        examId="exam-1"
        userId="user-1"
      />,
    )
    // 初期は表示
    expect(screen.getByText('server 残存 card')).toBeInTheDocument()
    // mirror 空が resolve すると消える (永続 fallback でないことの証明)
    await waitFor(() => {
      expect(screen.queryByText('server 残存 card')).not.toBeInTheDocument()
    })
    // 0 件 empty-state hint が出る
    expect(screen.getByText(/まだカードがありません/)).toBeInTheDocument()
  })
})

// 論点B: 見出し「カード (N 件)」を InlineCardList 内に lift し、リスト本体と同じ
// live `cards` 配列の length で算出する。追加/削除直後も即時整合する (旧 SSR
// cards.length 由来の stale を解消)。第 2 query を持たないため double-count しない。
describe('InlineCardList 見出し件数 live 化 (論点B)', () => {
  it('見出しが mirror の live 件数を反映する', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', exam_id: 'exam-1', title: '問1' }),
      fakeClientCard({ id: 'c2', exam_id: 'exam-1', title: '問2' }),
    ])
    render(<InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />)
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'カード (2 件)' }),
      ).toBeInTheDocument()
    })
  })

  it('mirror への add / remove で見出し件数が live 更新される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', exam_id: 'exam-1', title: '問1' }),
    ])
    render(<InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />)
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'カード (1 件)' }),
      ).toBeInTheDocument()
    })
    // 追加
    await act(async () => {
      await getClientDb().cards.put(
        fakeClientCard({ id: 'c2', exam_id: 'exam-1', title: '問2' }),
      )
    })
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'カード (2 件)' }),
      ).toBeInTheDocument()
    })
    // 削除
    await act(async () => {
      await getClientDb().cards.delete('c1')
    })
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'カード (1 件)' }),
      ).toBeInTheDocument()
    })
  })

  it('live 解決前 (undefined 期間) は initialCards 件数を見出しに使う', async () => {
    // mirror 空。initialCards に 2 件 → 初期 render で見出しは 2 件。
    const initialCards: ExamDetailCard[] = [
      {
        id: 'i1',
        title: 'A',
        sortKey: null,
        questionText: 'Q',
        options: [],
        explanationText: null,
        memo: null,
      },
      {
        id: 'i2',
        title: 'B',
        sortKey: null,
        questionText: 'Q',
        options: [],
        explanationText: null,
        memo: null,
      },
    ]
    render(
      <InlineCardList
        initialCards={initialCards}
        examId="exam-1"
        userId="user-1"
      />,
    )
    // 初期 (live undefined) は initialCards.length=2
    expect(
      screen.getByRole('heading', { name: 'カード (2 件)' }),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tag-4b Task 3: 4 store 一括 subscribe + CardTagsSection 配置の統合 test
// ---------------------------------------------------------------------------
//
// 検証観点:
// - 親が cards + tag_categories + tag_options + card_tags の 4 store を 1 useLiveQuery
//   で読み、 各 card listitem に <CardTagsSection /> を render する
// - カテゴリ 0 件: 全 card の section で「タグ管理ページでカテゴリを作成」 placeholder
// - カテゴリ ≥1 件: 各 card に カテゴリ名 + 付与済 pill が描画される
// - cardTags は card_id 別に分離: card-1 のタグが card-2 の section には現れない
// - tag mutation 経路 (multi/single 統合動作): pill 削除 → IDB 即時消滅 + enqueue + flush
describe('InlineCardList Tag-4b 統合 (Task 3 — 4 store + CardTagsSection)', () => {
  it('各 card listitem の title 行下に「タグ」 section が描画される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', exam_id: 'exam-1', title: '問1' }),
      fakeClientCard({ id: 'c2', exam_id: 'exam-1', title: '問2' }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('問1')).toBeInTheDocument()
      expect(screen.getByText('問2')).toBeInTheDocument()
    })
    // 「タグ」 見出しが card 数だけ存在 (CardTagsSection の <h3>)
    const tagHeadings = screen.getAllByRole('heading', { name: 'タグ' })
    expect(tagHeadings).toHaveLength(2)
    // 「タグ管理 →」 link は card ごとに 1 つ表示される (常時表示)
    const tagsLinks = screen.getAllByRole('link', { name: /タグ管理/ })
    expect(tagsLinks).toHaveLength(2)
    expect(tagsLinks[0]).toHaveAttribute('href', '/app/tags')
  })

  it('カテゴリ 0 件: 全 card の section に placeholder が表示される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', exam_id: 'exam-1', title: '問1' }),
      fakeClientCard({ id: 'c2', exam_id: 'exam-1', title: '問2' }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('問1')).toBeInTheDocument()
    })
    // 各 card の section に placeholder
    const placeholders = screen.getAllByText(
      /タグ管理ページでカテゴリを作成/,
    )
    expect(placeholders).toHaveLength(2)
  })

  it('カテゴリ ≥1 件: 各 card に カテゴリ名 + 付与 pill が描画される (card_id 別分離)', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeClientCard({ id: 'c1', exam_id: 'exam-1', title: '問1' }),
      fakeClientCard({ id: 'c2', exam_id: 'exam-1', title: '問2' }),
    ])
    await db.tag_categories.bulkPut([
      makeCategory('cat-1', '分野', 'multi', '2026-06-01T00:00:00.000Z'),
    ])
    await db.tag_options.bulkPut([
      makeOption('opt-1', 'cat-1', '循環器'),
      makeOption('opt-2', 'cat-1', '腎'),
    ])
    // card-1 だけに opt-1 (循環器) を付与、 card-2 には何も付与しない
    await db.card_tags.bulkPut([makeCardTag('c1', 'opt-1')])

    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('問1')).toBeInTheDocument()
    })
    // カテゴリ名「分野」 は card 数だけ表示 (各 row に見出し)
    const sectionNames = screen.getAllByText('分野')
    expect(sectionNames.length).toBeGreaterThanOrEqual(2)
    // card-1 にだけ 循環器 pill が出る (card_id 別分離の証明)
    const pills = screen.getAllByText('循環器')
    expect(pills).toHaveLength(1)
  })

  it('tag mirror の live 反映: 後から card_tags を put すると pill が追加される', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeClientCard({ id: 'c1', exam_id: 'exam-1', title: '問1' }),
    ])
    await db.tag_categories.bulkPut([
      makeCategory('cat-1', '分野', 'multi', '2026-06-01T00:00:00.000Z'),
    ])
    await db.tag_options.bulkPut([makeOption('opt-1', 'cat-1', '循環器')])

    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('問1')).toBeInTheDocument()
    })
    // 初期は pill 無し
    expect(screen.queryByText('循環器')).not.toBeInTheDocument()
    // 後から付与
    await act(async () => {
      await db.card_tags.put(makeCardTag('c1', 'opt-1'))
    })
    await waitFor(() => {
      expect(screen.getByText('循環器')).toBeInTheDocument()
    })
  })

  it('multi 経路: pill の「タグ削除」 click → IDB から該当 card_tag 即時消滅 + enqueue + flush', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeClientCard({ id: 'c1', exam_id: 'exam-1', title: '問1' }),
    ])
    await db.tag_categories.bulkPut([
      makeCategory('cat-1', '分野', 'multi', '2026-06-01T00:00:00.000Z'),
    ])
    await db.tag_options.bulkPut([
      makeOption('opt-1', 'cat-1', '循環器'),
      makeOption('opt-2', 'cat-1', '腎'),
    ])
    await db.card_tags.bulkPut([
      makeCardTag('c1', 'opt-1'),
      makeCardTag('c1', 'opt-2'),
    ])

    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await screen.findByText('循環器')
    // 「タグ削除: 循環器」 button click
    const deletePill = await screen.findByRole('button', {
      name: 'タグ削除: 循環器',
    })
    fireEvent.click(deletePill)

    // IDB から該当 card_tag のみ消滅 (opt-2 は残る)
    await waitFor(async () => {
      expect(await db.card_tags.get(['c1', 'opt-1'])).toBeUndefined()
    })
    expect(await db.card_tags.get(['c1', 'opt-2'])).toBeDefined()
    // enqueue + flush 発火
    expect(mockEnqueue).toHaveBeenCalled()
    expect(mockFlush).toHaveBeenCalled()
  })
})
