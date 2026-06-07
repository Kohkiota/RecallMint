// @vitest-environment jsdom
// OptionRow client component の test。
// 1 行の option 表示 + inline rename + color pill (popover trigger) +
// カテゴリ変更 dropdown + 削除 button。 mutation patch shape の固定 +
// callback 配線 + UNIQUE 違反 (rename / カテゴリ移動) の client 事前ガード。
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。
// rename UNIQUE 事前チェック / カテゴリ移動 UNIQUE 事前チェックは IDB 直問
// (`db.tag_options.where('category_id').equals(...).filter(...).count()`)
// のため fake-indexeddb 上で実 Dexie を回す (mock せず)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react'

import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { OptionRow } from './option-row'

const USER_ID = 'user-1'

function makeCategory(
  id: string,
  name: string,
  createdAt = '2026-06-01T00:00:00.000Z',
): ClientTagCategory {
  return {
    id,
    user_id: USER_ID,
    name,
    select_type: 'multi',
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
  color: string | null = null,
): ClientTagOption {
  return {
    id,
    user_id: USER_ID,
    category_id: categoryId,
    name,
    color,
    sort_key: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  }
}

const baseOption = makeOption('opt-1', 'cat-a', '高', 'red')
const categoryA = makeCategory('cat-a', '重要度')
const categoryB = makeCategory('cat-b', '難易度')

beforeEach(async () => {
  vi.clearAllMocks()
  const db = getClientDb()
  await db.tag_options.clear()
  await db.tag_categories.clear()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

describe('OptionRow — 表示', () => {
  it('option 名を表示する', () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('高')).toBeInTheDocument()
  })

  it('color pill が render される (色変更ボタンの aria-label)', () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'option 色を変更' }),
    ).toBeInTheDocument()
  })

  it('カテゴリ変更 button が render される', () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'カテゴリ変更' }),
    ).toBeInTheDocument()
  })

  it('削除 button が render される', () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'option 削除' }),
    ).toBeInTheDocument()
  })
})

describe('OptionRow — onDelete callback', () => {
  it('削除 button click で onDelete(option) が呼ばれる', () => {
    const onDelete = vi.fn()
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={onDelete}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))
    expect(onDelete).toHaveBeenCalledWith(baseOption)
  })
})

describe('OptionRow — inline rename', () => {
  it('option 名 click で edit mode に入り input に現値がセットされる', () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 名 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input).toHaveValue('高')
  })

  it('値変更 + blur で update_field mutation を enqueue + drain', async () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 名 編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '最高' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_option',
        entity_id: 'opt-1',
        op: 'update_field',
        patch: { field: 'name', value: '最高' },
      })
    })
    await waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('値変更なし blur では enqueue / drain を呼ばない', async () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 名 編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.blur(input)

    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
  })

  it('空文字確定では enqueue しない (元値復元)', async () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 名 編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(screen.getByText('高')).toBeInTheDocument()
  })

  it('Esc でキャンセル → enqueue しない、 display 復帰 (元値表示)', async () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 名 編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '中断値' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('高')).toBeInTheDocument()
  })

  it('UNIQUE 違反 (同 category 内同名) → enqueue 抑止 + inline error 表示', async () => {
    const db = getClientDb()
    await db.tag_options.bulkPut([
      baseOption,
      makeOption('opt-2', 'cat-a', '低'),
    ])

    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 名 編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '低' } })
    fireEvent.blur(input)

    await screen.findByText(/同名が既に存在します/)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('自分自身と同名は UNIQUE 違反扱いしない (値変更なし short-circuit)', async () => {
    const db = getClientDb()
    await db.tag_options.put(baseOption)

    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 名 編集' }))
    const input = screen.getByRole('textbox')
    // 同じ名前で blur → 値変更なし short-circuit
    fireEvent.blur(input)

    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(screen.queryByText(/同名が既に存在します/)).not.toBeInTheDocument()
  })
})

describe('OptionRow — color 変更', () => {
  it('color pill click で palette popover が開き、 cell click で color update mutation を enqueue', async () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 色を変更' }))
    // popover open 後、 blue cell click
    const blueCell = await screen.findByRole('button', { name: /色: blue/ })
    fireEvent.click(blueCell)

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_option',
        entity_id: 'opt-1',
        op: 'update_field',
        patch: { field: 'color', value: 'blue' },
      })
    })
    await waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('「色なし」 cell click で color: null update mutation を enqueue', async () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 色を変更' }))
    const noneCell = await screen.findByRole('button', { name: /色なし/ })
    fireEvent.click(noneCell)

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_option',
        entity_id: 'opt-1',
        op: 'update_field',
        patch: { field: 'color', value: null },
      })
    })
  })
})

describe('OptionRow — カテゴリ変更 dropdown', () => {
  it('「カテゴリ変更」 click で dropdown が開き、 現カテゴリ以外を列挙する', async () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ変更' }))
    // 「難易度」 (cat-b) が menuitem として現れる
    await screen.findByRole('menuitem', { name: '難易度' })
    // 現カテゴリ (cat-a, '重要度') は menu に並ばない
    expect(
      screen.queryByRole('menuitem', { name: '重要度' }),
    ).not.toBeInTheDocument()
  })

  it('別カテゴリ menuitem 選択で update_field (category_id) mutation を enqueue', async () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ変更' }))
    const item = await screen.findByRole('menuitem', { name: '難易度' })
    fireEvent.click(item)

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_option',
        entity_id: 'opt-1',
        op: 'update_field',
        patch: { field: 'category_id', value: 'cat-b' },
      })
    })
    await waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('移動先で同名 option 存在 → enqueue 抑止 + inline error 表示', async () => {
    const db = getClientDb()
    await db.tag_options.bulkPut([
      baseOption,
      // cat-b に既に同名 '高' が存在 → 移動 NG
      makeOption('opt-conflict', 'cat-b', '高'),
    ])

    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ変更' }))
    const item = await screen.findByRole('menuitem', { name: '難易度' })
    fireEvent.click(item)

    await screen.findByText(/移動先に同名 option が存在します/)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('allCategories が現カテゴリ 1 件のみ → dropdown は menuitem ゼロ + 「他のカテゴリがありません」 表示', async () => {
    render(
      <OptionRow
        option={baseOption}
        allCategories={[categoryA]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ変更' }))
    await screen.findByText(/他のカテゴリがありません/)
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })
})
