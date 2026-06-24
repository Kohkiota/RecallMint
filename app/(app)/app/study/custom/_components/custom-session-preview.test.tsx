// @vitest-environment jsdom
// CustomSessionPreview (S2.3 T15) — read-only プレビューテーブルの単体テスト。
//
// 検証観点:
// 1. rows が空のとき何も描画されない (null)
// 2. 問題文 (question_text) が line-clamp で表示される
// 3. タグ option.name が pill として表示される (category.name は非表示だが aria-label に含まれる)
// 4. 連続正解数 (current_streak) が表示される
// 5. 直近正誤: true=○ / false=× / null=— が正しく表示される
// 6. タグなし → 「—」 が表示される
// 7. 編集・削除導線 (×ボタン / 編集ポップオーバー) が存在しない (read-only)
// 8. perf degrade: customLimit=null & rows>50 → 先頭 50 件 + 「他 X 件」 注記
// 9. customLimit 設定時 → 全 rows を描画 (degrade なし)

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})

import type { CardWithTags } from '@/lib/cards/join-card-tags'
import type { ClientCard, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { CustomSessionPreview } from './custom-session-preview'

// ---------------------------------------------------------------------------
// Fixture ヘルパー
// ---------------------------------------------------------------------------

function makeCard(id: string, overrides: Partial<ClientCard> = {}): ClientCard {
  return {
    id,
    user_id: 'user-1',
    exam_id: 'exam-1',
    title: `Card ${id}`,
    question_text: `Question ${id}`,
    options: [],
    correct_answer_ids: [],
    images: [],
    answered: false,
    current_streak: 0,
    last_correct: null,
    due: '2026-01-01T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    content_version: 1,
    sync_status: 'synced',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeCategory(id: string, name: string): ClientTagCategory {
  return {
    id,
    user_id: 'user-1',
    name,
    select_type: 'multi',
    color: null,
    sort_key: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function makeOption(id: string, name: string, categoryId: string): ClientTagOption {
  return {
    id,
    user_id: 'user-1',
    category_id: categoryId,
    name,
    color: null,
    sort_key: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function makeRow(
  id: string,
  overrides: Partial<ClientCard> = {},
  tags: CardWithTags['tags'] = [],
): CardWithTags {
  return { card: makeCard(id, overrides), tags }
}

const CAT = makeCategory('cat-1', '分野')
const OPT_A = makeOption('opt-1', '循環器', 'cat-1')
const OPT_B = makeOption('opt-2', '腎臓', 'cat-1')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CustomSessionPreview — 空リスト', () => {
  it('rows=[] のとき何も描画しない', () => {
    const { container } = render(
      <CustomSessionPreview rows={[]} customLimit={20} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('CustomSessionPreview — 問題文', () => {
  it('question_text が表示される', () => {
    const rows = [makeRow('c1', { question_text: '心房細動の治療は？' })]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    expect(screen.getByText('心房細動の治療は？')).toBeInTheDocument()
  })

  it('複数行の問題文が表示される', () => {
    const rows = [
      makeRow('c1', { question_text: '問題 A' }),
      makeRow('c2', { question_text: '問題 B' }),
    ]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    expect(screen.getByText('問題 A')).toBeInTheDocument()
    expect(screen.getByText('問題 B')).toBeInTheDocument()
  })
})

describe('CustomSessionPreview — タグ表示', () => {
  it('タグがある行: option.name が pill として表示される', () => {
    const rows = [
      makeRow('c1', {}, [{ category: CAT, option: OPT_A }]),
    ]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    // option.name が表示される
    expect(screen.getByText('循環器')).toBeInTheDocument()
    // aria-label には category.name も含まれる
    expect(screen.getByLabelText('タグ: 分野: 循環器')).toBeInTheDocument()
  })

  it('複数タグが同じ行に表示される', () => {
    const rows = [
      makeRow('c1', {}, [
        { category: CAT, option: OPT_A },
        { category: CAT, option: OPT_B },
      ]),
    ]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    // 1 行に 2 タグ: getAllByText で複数マッチを許容
    expect(screen.getAllByText('循環器')).toHaveLength(1)
    expect(screen.getAllByText('腎臓')).toHaveLength(1)
  })

  it('タグなし行: 「—」 が表示される', () => {
    const rows = [makeRow('c1', {}, [])]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    // タグ列の「—」を確認 (テーブルセル内)
    const cells = screen.getAllByText('—')
    // タグ列に少なくとも 1 つ存在する
    expect(cells.length).toBeGreaterThanOrEqual(1)
  })
})

describe('CustomSessionPreview — 連続正解数', () => {
  it('current_streak が表示される', () => {
    const rows = [makeRow('c1', { current_streak: 3 })]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('streak=0 が表示される', () => {
    const rows = [makeRow('c1', { current_streak: 0 })]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    // 0 を含むセルが存在する (他の列と区別するため複数の 0 が OK)
    const zeros = screen.getAllByText('0')
    expect(zeros.length).toBeGreaterThanOrEqual(1)
  })
})

describe('CustomSessionPreview — 直近正誤', () => {
  it('last_correct=true → ○ が表示される', () => {
    const rows = [makeRow('c1', { last_correct: true })]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    expect(screen.getByText('○')).toBeInTheDocument()
  })

  it('last_correct=false → × が表示される', () => {
    const rows = [makeRow('c1', { last_correct: false })]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    expect(screen.getByText('×')).toBeInTheDocument()
  })

  it('last_correct=null → — が表示される', () => {
    const rows = [makeRow('c1', { last_correct: null })]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    // タグ列の「—」と直近正誤の「—」が共存しうる
    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThanOrEqual(1)
  })
})

describe('CustomSessionPreview — read-only (編集導線なし)', () => {
  it('× ボタン / タグ削除ボタンが存在しない', () => {
    const rows = [
      makeRow('c1', {}, [{ category: CAT, option: OPT_A }]),
    ]
    render(<CustomSessionPreview rows={rows} customLimit={20} />)
    // 削除ラベルは存在しない
    expect(screen.queryByLabelText(/タグ削除/)).not.toBeInTheDocument()
    // 追加ボタン等の role=button で aria-label に「削除」「追加」「編集」が含まれるものは存在しない
    const removeButtons = screen
      .queryAllByRole('button')
      .filter((el) => /削除|追加|編集/.test(el.getAttribute('aria-label') ?? ''))
    expect(removeButtons).toHaveLength(0)
  })
})

describe('CustomSessionPreview — perf degrade', () => {
  function makeNRows(n: number): CardWithTags[] {
    return Array.from({ length: n }, (_, i) => makeRow(`c${i}`))
  }

  it('customLimit=null & rows<=50 → degrade しない (全件表示)', () => {
    const rows = makeNRows(50)
    render(<CustomSessionPreview rows={rows} customLimit={null} />)
    // 50 行すべての問題文が表示される
    expect(screen.getByText('Question c0')).toBeInTheDocument()
    expect(screen.getByText('Question c49')).toBeInTheDocument()
    // 「他 X 件」注記は表示されない
    expect(screen.queryByTestId('preview-hidden-note')).not.toBeInTheDocument()
  })

  it('customLimit=null & rows>50 → 先頭 50 件 + 「他 X 件」 注記が表示される', () => {
    const rows = makeNRows(80)
    render(<CustomSessionPreview rows={rows} customLimit={null} />)
    // c0 〜 c49 は表示される
    expect(screen.getByText('Question c0')).toBeInTheDocument()
    expect(screen.getByText('Question c49')).toBeInTheDocument()
    // c50 以降は表示されない
    expect(screen.queryByText('Question c50')).not.toBeInTheDocument()
    // 「他 X 件」 注記
    const note = screen.getByTestId('preview-hidden-note')
    expect(note).toHaveTextContent('他 30 件')
  })

  it('customLimit が設定されている場合 → degrade しない', () => {
    // 60 件でも customLimit=60 なら全件表示
    const rows = makeNRows(60)
    render(<CustomSessionPreview rows={rows} customLimit={60} />)
    expect(screen.getByText('Question c59')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-hidden-note')).not.toBeInTheDocument()
  })
})
