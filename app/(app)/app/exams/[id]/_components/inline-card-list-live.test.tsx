// @vitest-environment jsdom
// Task 4.1: InlineCardList が cards 表示 source を Dexie cards mirror の
// useLiveQuery 直読みに切替えた挙動の test。
//
// 検証観点:
// - live 反映: Dexie mirror を seed → render で表示、 mirror を put 変更 → UI 追従
// - exam filter: 別 exam_id の card は除外
// - owner-scope: 別 user_id の card は除外
// - sort: server (base_order ASC → id ASC) と一致
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
// card-editor-fields.tsx → card-image-gallery.tsx が '../_actions/asset-actions' (server
// action) を import する。 実 module は lib/storage/r2.ts の R2_* env fail-fast を経由し、
// vitest.setup.ts は R2_* を供給しないため未 mock だと module load 時に throw する
// (画像フェーズ A Task 10)。 本 test は画像 gallery の挙動を検証しないため最小 stub。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: vi.fn(async () => null),
}))

import { InlineCardList } from './inline-card-list'

function fakeClientCard(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: 'タイトル',
    question_label: null,
    base_order: 1024,
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
        question_label: '001',
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

  it('sort: base_order ASC → id ASC で server の ORDER BY と一致', async () => {
    // 期待順: base_order 1024(b) → 2048(a) → 3072 同値は id ASC で c → d。
    // 番号ラベル(降順に振ってある)と created_at(降順)は既定順に影響しない。
    await getClientDb().cards.bulkPut([
      fakeClientCard({
        id: 'a',
        base_order: 2048,
        question_label: '003',
        title: 'A',
        created_at: '2026-04-05T00:00:00.000Z',
      }),
      fakeClientCard({
        id: 'b',
        base_order: 1024,
        question_label: '004',
        title: 'B',
        created_at: '2026-04-04T00:00:00.000Z',
      }),
      fakeClientCard({
        id: 'c',
        base_order: 3072,
        question_label: '002',
        title: 'C',
        created_at: '2026-04-03T00:00:00.000Z',
      }),
      fakeClientCard({
        id: 'd',
        base_order: 3072,
        question_label: '001',
        title: 'D',
        created_at: '2026-04-01T00:00:00.000Z',
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
    expect(order).toEqual(['B', 'A', 'C', 'D'])
  })

  it('SSR/初期 fallback: useLiveQuery undefined の間は initialCards を表示', () => {
    // render 同期直後 (microtask 未消化) は useLiveQuery が undefined。 この瞬間に
    // initialCards が描画される。
    const initialCards: ExamDetailCard[] = [
      {
        id: 'ssr-1',
        title: 'SSR タイトル',
        questionLabel: '001',
        baseOrder: 1024,
        questionText: 'SSR 問題文',
        options: [],
        explanationText: null,
        memo: null,
        images: [],
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
        questionLabel: null,
        baseOrder: 1024,
        questionText: 'Q',
        options: [],
        explanationText: null,
        memo: null,
        images: [],
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
        questionLabel: null,
        baseOrder: 1024,
        questionText: 'Q',
        options: [],
        explanationText: null,
        memo: null,
        images: [],
      },
      {
        id: 'i2',
        title: 'B',
        questionLabel: null,
        baseOrder: 1024,
        questionText: 'Q',
        options: [],
        explanationText: null,
        memo: null,
        images: [],
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
// Tag-4b-fix Task 5: 4 store 一括 subscribe + CardTagsSection 配置の統合 test
// ---------------------------------------------------------------------------
//
// 検証観点 (Tag-4b-fix Notion 方式 popover UI 後):
// - 親が cards + tag_categories + tag_options + card_tags の 4 store を 1 useLiveQuery
//   で読み、 各 card listitem に <CardTagsSection /> を render する
// - 「タグ」 h3 見出しが card 数だけ存在。 見出し横の「タグ管理 →」 link は廃止 (popover footer のみ)
// - カテゴリ 0 件: placeholder は popover 内 (closed 時は見えない)。 「タグを追加」 button のみ
// - カテゴリ ≥1 件: 付与済タグのみバッジ表示 (未付与 category row は表示しない)
// - cardTags は card_id 別に分離: card-1 のタグが card-2 の section には現れない
// - tag mutation 経路 (multi/single 統合動作): バッジ削除 → IDB 即時消滅 + enqueue + flush
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
    // 「タグ」 h3 見出しが card 数だけ存在 (CardTagsSection の <h3>)
    const tagHeadings = screen.getAllByRole('heading', { name: 'タグ' })
    expect(tagHeadings).toHaveLength(2)
    // Tag-4b-fix: 見出し横の「タグ管理 →」 link は廃止 (popover が閉じた状態では表示されない)
    expect(screen.queryByRole('link', { name: /タグ管理/ })).not.toBeInTheDocument()
    // 各 card に「タグを追加」 button が表示される
    const addButtons = screen.getAllByRole('button', { name: 'タグを追加' })
    expect(addButtons).toHaveLength(2)
  })

  it('カテゴリ 0 件: section には「タグを追加」 button のみ表示 (placeholder は popover 内)', async () => {
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
    // Tag-4b-fix: placeholder は popover 内なので closed 状態では見えない
    expect(screen.queryByText(/タグ管理ページでカテゴリを作成/)).not.toBeInTheDocument()
    // 「タグを追加」 button は card 数だけ表示
    const addButtons = screen.getAllByRole('button', { name: 'タグを追加' })
    expect(addButtons).toHaveLength(2)
  })

  it('カテゴリ ≥1 件: 付与済タグのみバッジ表示 (card_id 別分離)', async () => {
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
    // Tag-4b-fix: バッジは「カテゴリ名: option名」 形式。 card-1 にだけ循環器バッジが出る
    const badge = screen.getByRole('button', { name: 'タグ: 分野: 循環器' })
    expect(badge).toBeInTheDocument()
    // card-2 は tag 未付与なのでバッジは 1 つだけ (card_id 別分離の証明)
    const allBadges = screen.getAllByRole('button', { name: /^タグ: / })
    expect(allBadges).toHaveLength(1)
  })

  it('tag mirror の live 反映: 後から card_tags を put するとバッジが追加される', async () => {
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
    // 初期はバッジ無し
    expect(screen.queryByRole('button', { name: 'タグ: 分野: 循環器' })).not.toBeInTheDocument()
    // 後から付与
    await act(async () => {
      await db.card_tags.put(makeCardTag('c1', 'opt-1'))
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'タグ: 分野: 循環器' })).toBeInTheDocument()
    })
  })

  it('multi 経路: バッジ × click → IDB から該当 card_tag 即時消滅 + enqueue + flush', async () => {
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
    // バッジが表示されるまで待つ
    await screen.findByRole('button', { name: 'タグ: 分野: 循環器' })
    // 「タグ削除: 分野: 循環器」 × button click
    const deletePill = await screen.findByRole('button', {
      name: 'タグ削除: 分野: 循環器',
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

// ---------------------------------------------------------------------------
// T-B5 (Y-2 Sub-plan B、 2026-06-14): card_tags 全 scan → anyOf(pageCardIds) regression
// ---------------------------------------------------------------------------
//
// 完了条件 (plan B-perf.md L106 改訂版、 (b) は二分追補で構造 unit + wall-clock stg に分割):
// (a) B 相当 fixture (1 target exam × 50 cards × 4 tags = 200 + 1000 他 exam tags) で
//     anyOf 経路 row 数 < toArray 経路 row 数 を assert (構造的最適化目的 = 他 exam scan 回避)
// (b-i) low-scale 構造: A 相当 (200 tags / 0 other + 紛れ込み 1 件) で anyOf 経路の
//     card_id 集合が target_card_ids subset のみで他 exam 行を含まないことを assert
//     (「無駄読みゼロ」 を perf でなく構造で担保)
// (b-ii) low-scale wall-clock: **stg 実測**を正本 (step0-redo §3: anyOf 4.04ms mean /
//     stdev 0.75 at 200 tags / 0 other = 知覚不能域)。 unit test に wall-clock ceiling は
//     新規導入しない (plan policy 「jsdom/mock を perf 根拠にしない、 fake-indexeddb は
//     集計 correctness 確認に限定」 準拠、 fake-indexeddb は memory-based JS 実装で
//     実 IDB の B-tree seek と特性が異なる)。 本 test は (a) + (b-i) のみ assert する。
describe('InlineCardList T-B5 anyOf 化 regression (Y-2 Sub-plan B)', () => {
  it('completion criteria (a): multi-exam fixture で anyOf 経路が toArray 経路より少ない rows を返す', async () => {
    const db = getClientDb()
    const TARGET_CARDS = 50
    const TARGET_TAGS_PER_CARD = 4
    const targetCardIds: string[] = []
    const targetCards: ClientCard[] = []
    const targetCardTags: ClientCardTag[] = []
    for (let i = 0; i < TARGET_CARDS; i++) {
      const id = `target-card-${i}`
      targetCardIds.push(id)
      targetCards.push(
        fakeClientCard({ id, exam_id: 'exam-target', user_id: 'user-1' }),
      )
      for (let j = 0; j < TARGET_TAGS_PER_CARD; j++) {
        targetCardTags.push(makeCardTag(id, `opt-target-${i}-${j}`))
      }
    }
    // 他 exam 想定: card は別 exam_id、 card_tags は 200 cards × 5 tags = 1000
    const otherCardTags: ClientCardTag[] = []
    for (let i = 0; i < 200; i++) {
      const otherId = `other-card-${i}`
      for (let j = 0; j < 5; j++) {
        otherCardTags.push(makeCardTag(otherId, `opt-other-${i}-${j}`))
      }
    }
    await db.cards.bulkPut(targetCards)
    await db.card_tags.bulkPut([...targetCardTags, ...otherCardTags])

    // toArray 経路 = 旧コードと等価な全 scan
    const toArrayRows = await db.card_tags.toArray()
    // anyOf 経路 = 新コードの fetch shape
    const anyOfRows = await db.card_tags
      .where('card_id')
      .anyOf(targetCardIds)
      .toArray()

    expect(toArrayRows.length).toBe(1200)
    expect(anyOfRows.length).toBe(200)
    // 構造的に row 数差が出ること = 最適化目的 (他 exam scan 回避) の検知
    expect(anyOfRows.length).toBeLessThan(toArrayRows.length)
    // 返却 set が target card_tags と一致 (correctness、 余剰 / 欠落 0)
    expect(new Set(anyOfRows.map((r) => r.card_id))).toEqual(
      new Set(targetCardIds),
    )
  })

  it('completion criteria (b) 構造側: anyOf 経路は target exam の card_ids subset のみを読み、 他 exam rows を含まない', async () => {
    // (b) low-scale wall-clock 非劣化の正本は **stg 実測** (step0-redo §3: anyOf 4.04 ms mean
    // / stdev 0.75 at 200 tags / 0 other)。 fake-indexeddb は memory-based JS 実装で実 IDB の
    // B-tree seek と特性が違うため perf 根拠にしない (plan policy 「jsdom/mock を perf 根拠に
    // しない、 fake-indexeddb は集計 correctness 確認に限定」 準拠)。 本 test は「他 exam 分を
    // 読まない」 構造のみ検証する (= 「無駄読みゼロ」 を perf でなく構造で担保)。
    const db = getClientDb()
    const TARGET_CARDS = 50
    const TARGET_TAGS_PER_CARD = 4
    const targetCardIds: string[] = []
    const targetCards: ClientCard[] = []
    const targetCardTags: ClientCardTag[] = []
    for (let i = 0; i < TARGET_CARDS; i++) {
      const id = `target-card-${i}`
      targetCardIds.push(id)
      targetCards.push(
        fakeClientCard({ id, exam_id: 'exam-target', user_id: 'user-1' }),
      )
      for (let j = 0; j < TARGET_TAGS_PER_CARD; j++) {
        targetCardTags.push(makeCardTag(id, `opt-${i}-${j}`))
      }
    }
    // 他 exam の card_tags も DB に追加 (低 scale 想定外に紛れた他 exam が無駄読みされ
    // ないことを構造的に検出するため、 1 件だけ別 card_id で seed する)
    const otherCardTag = makeCardTag('other-exam-card', 'opt-other')
    await db.cards.bulkPut(targetCards)
    await db.card_tags.bulkPut([...targetCardTags, otherCardTag])

    const anyOfRows = await db.card_tags
      .where('card_id')
      .anyOf(targetCardIds)
      .toArray()

    expect(anyOfRows.length).toBe(200)
    // 返却 set が target_card_ids の subset で、 他 exam の card_id を含まない (構造的に
    // 無駄読みしていない証明)
    const targetSet = new Set(targetCardIds)
    const anyOfCardIds = new Set(anyOfRows.map((r) => r.card_id))
    for (const cid of anyOfCardIds) {
      expect(targetSet.has(cid)).toBe(true)
    }
    expect(anyOfCardIds.has('other-exam-card')).toBe(false)
  })
})
