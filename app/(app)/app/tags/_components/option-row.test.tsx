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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'option 削除' }),
    ).toBeInTheDocument()
  })

  it('pen icon button (aria-label="編集") が render される (rename の明示 trigger)', () => {
    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument()
  })

  it('editing=true 時は pen icon button が非表示 (input のみ)', () => {
    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    // pen icon button は消える
    expect(
      screen.queryByRole('button', { name: '編集' }),
    ).not.toBeInTheDocument()
    // input のみ表示
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})

describe('OptionRow — onDelete callback', () => {
  it('削除 button click で onDelete(option) が呼ばれる', () => {
    const onDelete = vi.fn()
    render(
      <OptionRow
        userId={USER_ID}
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
  it('pen icon click で edit mode に入り input に現値がセットされる', () => {
    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input).toHaveValue('高')
  })

  it('値変更 + blur で update_field mutation を enqueue + drain', async () => {
    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '最高' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        user_id: USER_ID,
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
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.blur(input)

    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
  })

  it('空文字確定では enqueue しない (元値復元)', async () => {
    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
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
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
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
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
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
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
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
        userId={USER_ID}
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
        user_id: USER_ID,
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
        userId={USER_ID}
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
        user_id: USER_ID,
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        user_id: USER_ID,
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
        userId={USER_ID}
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
        userId={USER_ID}
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

describe('OptionRow — optimistic IDB update', () => {
  it('rename 確定で IDB tag_options.update が name + updated_at を bump', async () => {
    const db = getClientDb()
    await db.tag_options.put(baseOption)

    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '最高' } })
    fireEvent.blur(input)

    await waitFor(async () => {
      const row = await db.tag_options.get(baseOption.id)
      expect(row?.name).toBe('最高')
    })
    const row = await db.tag_options.get(baseOption.id)
    expect(row?.updated_at).not.toBe(baseOption.updated_at)
  })

  it('rename: IDB update が enqueueEntityMutation より先に呼ばれる (発行順序)', async () => {
    const db = getClientDb()
    await db.tag_options.put(baseOption)
    const updateSpy = vi.spyOn(db.tag_options, 'update')

    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '最高' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalled()
    })
    const updateOrder = updateSpy.mock.invocationCallOrder[0]
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(enqueueOrder)
    updateSpy.mockRestore()
  })

  it('color 変更で IDB row.color が即時反映 (palette popover 経由)', async () => {
    const db = getClientDb()
    await db.tag_options.put(baseOption)

    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 色を変更' }))
    const blueCell = await screen.findByRole('button', { name: /色: blue/ })
    fireEvent.click(blueCell)

    await waitFor(async () => {
      const row = await db.tag_options.get(baseOption.id)
      expect(row?.color).toBe('blue')
    })
  })

  it('color 変更: IDB update が enqueue より先 (発行順序)', async () => {
    const db = getClientDb()
    await db.tag_options.put(baseOption)
    const updateSpy = vi.spyOn(db.tag_options, 'update')

    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 色を変更' }))
    const blueCell = await screen.findByRole('button', { name: /色: blue/ })
    fireEvent.click(blueCell)

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalled()
    })
    const updateOrder = updateSpy.mock.invocationCallOrder[0]
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(enqueueOrder)
    updateSpy.mockRestore()
  })

  it('カテゴリ移動で IDB row.category_id が即時反映', async () => {
    const db = getClientDb()
    await db.tag_options.put(baseOption)

    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ変更' }))
    const item = await screen.findByRole('menuitem', { name: '難易度' })
    fireEvent.click(item)

    await waitFor(async () => {
      const row = await db.tag_options.get(baseOption.id)
      expect(row?.category_id).toBe('cat-b')
    })
  })

  it('カテゴリ移動: IDB update が enqueue より先 (発行順序)', async () => {
    const db = getClientDb()
    await db.tag_options.put(baseOption)
    const updateSpy = vi.spyOn(db.tag_options, 'update')

    render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ変更' }))
    const item = await screen.findByRole('menuitem', { name: '難易度' })
    fireEvent.click(item)

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalled()
    })
    const updateOrder = updateSpy.mock.invocationCallOrder[0]
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(enqueueOrder)
    updateSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 状態遷移 pin (波2 ESLint C1: set-state-in-effect → prev-render pattern refactor の
// 挙動保存証明)。 b02c072 hook regression pin と同形、 fix 前後で両方 pass する観点で
// 「編集中の prop 変化は local state を保護」 「非編集中の prop 変化は local state へ
// 同期」 を rerender 経路で踏む。
// ---------------------------------------------------------------------------

describe('OptionRow — 外部 prop 遷移と editing 状態の保護 (波2 C1 pin)', () => {
  it('editing=true (編集中) で option.name が外部変化しても input の value は保護される', () => {
    const { rerender } = render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('高')
    fireEvent.change(input, { target: { value: 'ユーザ編集中' } })
    expect(input.value).toBe('ユーザ編集中')
    rerender(
      <OptionRow
        userId={USER_ID}
        option={{ ...baseOption, name: '外部更新' }}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    const inputAfter = screen.getByRole('textbox') as HTMLInputElement
    expect(inputAfter.value).toBe('ユーザ編集中')
  })

  it('editing=false (非編集) で option.name が外部変化したら display は新値に同期する', () => {
    const { rerender } = render(
      <OptionRow
        userId={USER_ID}
        option={baseOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('高')).toBeInTheDocument()
    rerender(
      <OptionRow
        userId={USER_ID}
        option={{ ...baseOption, name: '外部更新' }}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('外部更新')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const inputAfter = screen.getByRole('textbox') as HTMLInputElement
    expect(inputAfter.value).toBe('外部更新')
  })
})

// ---------------------------------------------------------------------------
// owner は認証主体の 1 本 (Sprint B・描画中の行の user_id を拾わない)
// 理由は category-row.test.tsx の同名 describe を参照 (行 owner 名義にすると owner の
// session 経由で編集が着地し、 server の認可境界を迂回する)。
// ---------------------------------------------------------------------------

describe('OptionRow — outbox owner / flush とも認証主体 (option.user_id を拾わない)', () => {
  const FOREIGN_OWNER = 'other-user'

  it('別 owner の行を rename → outbox も drain も認証主体名義で走る', async () => {
    const foreignOption: ClientTagOption = { ...baseOption, user_id: FOREIGN_OWNER }
    render(
      <OptionRow
        userId={USER_ID}
        option={foreignOption}
        allCategories={[categoryA, categoryB]}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '最高' } })
    fireEvent.blur(input)

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: USER_ID, entity_id: baseOption.id }),
      )
    })
    expect(mockEnqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ user_id: FOREIGN_OWNER }),
    )

    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalledWith(USER_ID)
    })
    expect(mockFlush).not.toHaveBeenCalledWith(FOREIGN_OWNER)
  })
})
