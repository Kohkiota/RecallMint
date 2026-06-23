// join-card-tags unit test (S2.3 Task 1)。
// 純関数 joinCardTags の結合ロジックを検証する (副作用なし、 環境非依存 = node 環境で OK)。

import { describe, it, expect } from 'vitest'
import { joinCardTags } from './join-card-tags'
import type { ClientCard, ClientCardTag, ClientTagCategory, ClientTagOption } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeCard(id: string): ClientCard {
  return {
    id,
    user_id: 'u1',
    exam_id: 'e1',
    title: `Card ${id}`,
    sort_key: id,
    question_text: `Q ${id}`,
    options: [],
    correct_answer_ids: [],
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2024-01-01T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 1,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    sync_status: 'synced',
  }
}

function makeCategory(id: string): ClientTagCategory {
  return {
    id,
    user_id: 'u1',
    name: `Cat ${id}`,
    select_type: 'single',
    color: null,
    sort_key: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  }
}

function makeOption(id: string, categoryId: string): ClientTagOption {
  return {
    id,
    user_id: 'u1',
    category_id: categoryId,
    name: `Opt ${id}`,
    color: null,
    sort_key: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  }
}

function makeCardTag(cardId: string, optionId: string): ClientCardTag {
  return {
    card_id: cardId,
    option_id: optionId,
    user_id: 'u1',
    created_at: '2024-01-01T00:00:00.000Z',
  }
}

// ===========================================================================
// case 1: option 不在 → そのタグはスキップ
// ===========================================================================

describe('joinCardTags — option 不在スキップ', () => {
  it('option が options 配列に存在しない card_tag はスキップされ tags は空になる', () => {
    const cards = [makeCard('c1')]
    const cardTags = [makeCardTag('c1', 'opt-missing')]
    const categories = [makeCategory('cat1')]
    const options: ClientTagOption[] = []  // 空 = option 不在

    const result = joinCardTags(cards, cardTags, categories, options)
    expect(result).toHaveLength(1)
    expect(result[0].card.id).toBe('c1')
    expect(result[0].tags).toHaveLength(0)
  })
})

// ===========================================================================
// case 2: category 不在 → そのタグはスキップ
// ===========================================================================

describe('joinCardTags — category 不在スキップ', () => {
  it('option は存在するが category が categories 配列に存在しない card_tag はスキップされる', () => {
    const cards = [makeCard('c1')]
    const opt = makeOption('opt1', 'cat-missing')
    const cardTags = [makeCardTag('c1', 'opt1')]
    const categories: ClientTagCategory[] = []  // 空 = category 不在
    const options = [opt]

    const result = joinCardTags(cards, cardTags, categories, options)
    expect(result).toHaveLength(1)
    expect(result[0].tags).toHaveLength(0)
  })
})

// ===========================================================================
// case 3: 1 枚のカードに複数タグがグループ化される
// ===========================================================================

describe('joinCardTags — 複数タグのグルーピング', () => {
  it('1 card に 2 card_tag → tags 配列長 2 にグループ化される', () => {
    const cards = [makeCard('c1')]
    const cat = makeCategory('cat1')
    const opt1 = makeOption('opt1', 'cat1')
    const opt2 = makeOption('opt2', 'cat1')
    const cardTags = [makeCardTag('c1', 'opt1'), makeCardTag('c1', 'opt2')]
    const categories = [cat]
    const options = [opt1, opt2]

    const result = joinCardTags(cards, cardTags, categories, options)
    expect(result).toHaveLength(1)
    expect(result[0].tags).toHaveLength(2)
    expect(result[0].tags[0].category.id).toBe('cat1')
    expect(result[0].tags[0].option.id).toBe('opt1')
    expect(result[0].tags[1].option.id).toBe('opt2')
  })
})

// ===========================================================================
// case 4: 複数のカードがそれぞれ自分のタグを持つ
// ===========================================================================

describe('joinCardTags — 複数カードが各自のタグを持つ', () => {
  it('2 cards に別々の card_tag → 各カードが自分の tags のみ持つ', () => {
    const cards = [makeCard('c1'), makeCard('c2')]
    const cat = makeCategory('cat1')
    const opt1 = makeOption('opt1', 'cat1')
    const opt2 = makeOption('opt2', 'cat1')
    const cardTags = [makeCardTag('c1', 'opt1'), makeCardTag('c2', 'opt2')]
    const categories = [cat]
    const options = [opt1, opt2]

    const result = joinCardTags(cards, cardTags, categories, options)
    expect(result).toHaveLength(2)
    const r1 = result.find((r) => r.card.id === 'c1')!
    const r2 = result.find((r) => r.card.id === 'c2')!
    expect(r1.tags).toHaveLength(1)
    expect(r1.tags[0].option.id).toBe('opt1')
    expect(r2.tags).toHaveLength(1)
    expect(r2.tags[0].option.id).toBe('opt2')
  })
})

// ===========================================================================
// case 5: タグなしカード → tags は空配列
// ===========================================================================

describe('joinCardTags — タグなしカード', () => {
  it('card_tags が空でも card は tags: [] で結果に含まれる', () => {
    const cards = [makeCard('c1')]
    const result = joinCardTags(cards, [], [], [])
    expect(result).toHaveLength(1)
    expect(result[0].card.id).toBe('c1')
    expect(result[0].tags).toEqual([])
  })
})

// ===========================================================================
// case 6: 空入力 → 空結果
// ===========================================================================

describe('joinCardTags — 空入力', () => {
  it('cards が空のとき結果は []', () => {
    const result = joinCardTags([], [], [], [])
    expect(result).toEqual([])
  })
})
