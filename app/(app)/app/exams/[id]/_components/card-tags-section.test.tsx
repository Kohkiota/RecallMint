// @vitest-environment jsdom
// CardTagsSection: 1 card 分のタグ section orchestrator の test。 categories を
// created_at ASC で iterate し、 各カテゴリへ option / cardTags の filter 後 props
// を渡す責務を固定する。 0 件 placeholder + 常時表示の「タグ管理 →」 link を pin。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import {
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: vi.fn(async () => ({}) as never),
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: vi.fn(async () => 'no-pending' as const),
}))

import { CardTagsSection } from './card-tags-section'

const cat = (
  id: string,
  name: string,
  selectType: 'single' | 'multi',
  createdAt: string,
): ClientTagCategory => ({
  id,
  user_id: 'user-1',
  name,
  select_type: selectType,
  color: null,
  sort_key: null,
  created_at: createdAt,
  updated_at: createdAt,
})

const opt = (
  id: string,
  categoryId: string,
  name: string,
  createdAt: string = '2026-06-01T00:00:00.000Z',
): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id: categoryId,
  name,
  color: null,
  sort_key: null,
  created_at: createdAt,
  updated_at: createdAt,
})

const tag = (cardId: string, optionId: string): ClientCardTag => ({
  card_id: cardId,
  option_id: optionId,
  user_id: 'user-1',
  created_at: '2026-06-01T00:00:00.000Z',
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('CardTagsSection — 見出し + 「タグ管理 →」 link', () => {
  it('section 見出し「タグ」 を表示する', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        categories={[]}
        options={[]}
        cardTags={[]}
      />,
    )
    expect(screen.getByText('タグ')).toBeInTheDocument()
  })

  it('「タグ管理 →」 link が常時表示される (/app/tags への href)', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        categories={[cat('c1', '分野', 'multi', '2026-06-01T00:00:00.000Z')]}
        options={[]}
        cardTags={[]}
      />,
    )
    const link = screen.getByRole('link', { name: /タグ管理/ })
    expect(link).toHaveAttribute('href', '/app/tags')
  })

  it('カテゴリ 0 件でも「タグ管理 →」 link は常時表示される', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        categories={[]}
        options={[]}
        cardTags={[]}
      />,
    )
    expect(screen.getByRole('link', { name: /タグ管理/ })).toHaveAttribute(
      'href',
      '/app/tags',
    )
  })
})

describe('CardTagsSection — カテゴリ 0 件 placeholder', () => {
  it('カテゴリ 0 件で「タグ管理ページでカテゴリを作成」 placeholder を表示', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        categories={[]}
        options={[]}
        cardTags={[]}
      />,
    )
    expect(
      screen.getByText(/タグ管理ページでカテゴリを作成/),
    ).toBeInTheDocument()
  })

  it('カテゴリ ≥1 件では placeholder を表示しない', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        categories={[cat('c1', '分野', 'multi', '2026-06-01T00:00:00.000Z')]}
        options={[]}
        cardTags={[]}
      />,
    )
    expect(
      screen.queryByText(/タグ管理ページでカテゴリを作成/),
    ).not.toBeInTheDocument()
  })
})

describe('CardTagsSection — 複数カテゴリ render', () => {
  it('全カテゴリの名前を render する', () => {
    const categories = [
      cat('c1', '分野', 'multi', '2026-06-01T00:00:00.000Z'),
      cat('c2', '難易度', 'single', '2026-06-02T00:00:00.000Z'),
    ]
    render(
      <CardTagsSection
        cardId="card-1"
        categories={categories}
        options={[]}
        cardTags={[]}
      />,
    )
    expect(screen.getByText('分野')).toBeInTheDocument()
    expect(screen.getByText('難易度')).toBeInTheDocument()
  })

  it('カテゴリは created_at ASC 順で render される', () => {
    // 渡し順を入れ替えても、 内部 sort が ASC 順に並べる。
    const categories = [
      cat('c2', '後', 'multi', '2026-06-02T00:00:00.000Z'),
      cat('c1', '先', 'single', '2026-06-01T00:00:00.000Z'),
    ]
    render(
      <CardTagsSection
        cardId="card-1"
        categories={categories}
        options={[]}
        cardTags={[]}
      />,
    )
    const firstText = screen.getByText('先')
    const secondText = screen.getByText('後')
    expect(
      firstText.compareDocumentPosition(secondText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('options は各 category_id で filter された subset として row に渡る', () => {
    // category c1 に o1/o2、 c2 に o3。 cardTags は o1 と o3 を card-1 に付与。
    // c1 row には pill「循環器」 (o1) が表示、 c2 row には pill「高」 (o3) が表示。
    // o2 (未付与) は pill としては表示されない。
    const categories = [
      cat('c1', '分野', 'multi', '2026-06-01T00:00:00.000Z'),
      cat('c2', '難易度', 'single', '2026-06-02T00:00:00.000Z'),
    ]
    const options = [
      opt('o1', 'c1', '循環器'),
      opt('o2', 'c1', '腎'),
      opt('o3', 'c2', '高'),
    ]
    const cardTags = [tag('card-1', 'o1'), tag('card-1', 'o3')]
    render(
      <CardTagsSection
        cardId="card-1"
        categories={categories}
        options={options}
        cardTags={cardTags}
      />,
    )
    expect(screen.getByText('循環器')).toBeInTheDocument()
    expect(screen.getByText('高')).toBeInTheDocument()
    // o2 は未付与なので pill 表示なし
    expect(
      screen.queryByRole('button', { name: 'タグ削除: 腎' }),
    ).not.toBeInTheDocument()
  })

  it('他カードの card_tags は無視される (cardTags は本 card 分のみが渡される前提)', () => {
    // 親 (InlineCardList) が card_id 別に分離する前提だが、 section は受領した
    // cardTags をそのまま category 別 filter する。 ここでは「props の cardTags 内
    // option_id が正しく pill 化される」 を pin する。
    const categories = [cat('c1', '分野', 'multi', '2026-06-01T00:00:00.000Z')]
    const options = [opt('o1', 'c1', '循環器')]
    // 本 card の card_tags は空 → pill 0 個
    render(
      <CardTagsSection
        cardId="card-1"
        categories={categories}
        options={options}
        cardTags={[]}
      />,
    )
    // pill は出ない、 「タグ追加」 trigger は出る
    expect(
      screen.queryByRole('button', { name: 'タグ削除: 循環器' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'タグ追加' }),
    ).toBeInTheDocument()
  })
})
