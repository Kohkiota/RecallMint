// @vitest-environment jsdom
// CardTagCategoryRow: 1 カテゴリの見出し + 型アイコン + pill 群 + 「+ 追加」 dropdown
// 統合 component の test。 optimistic 更新 logic (whole-set 構築 + IDB put/delete +
// enqueue + flush) を pin する。 dropdown 内部の挙動は Task 1 の test で固定済みのため
// 本 test は CardTagCategoryRow がそれを正しく組み立てているかに集中する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

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

import { CardTagCategoryRow } from './card-tag-category-row'

const multiCategory: ClientTagCategory = {
  id: 'cat-multi',
  user_id: 'user-1',
  name: '分野',
  select_type: 'multi',
  color: null,
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
}

const singleCategory: ClientTagCategory = {
  id: 'cat-single',
  user_id: 'user-1',
  name: '難易度',
  select_type: 'single',
  color: null,
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
}

const opt = (
  id: string,
  categoryId: string,
  name: string,
  color: string | null = null,
): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id: categoryId,
  name,
  color,
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
})

function openMenu() {
  const trigger = screen.getByRole('button', { name: 'タグ追加' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
}

beforeEach(async () => {
  vi.clearAllMocks()
  const db = getClientDb()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

describe('CardTagCategoryRow — 見出し + 型アイコン', () => {
  it('category.name を見出しに表示する', () => {
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={multiCategory}
        categoryOptions={[]}
        assignedOptionIds={[]}
        allAssignedOptionIds={[]}
      />,
    )
    expect(screen.getByText('分野')).toBeInTheDocument()
  })

  it('multi カテゴリでは CheckSquare icon (aria-label="タイプ: multi") を表示', () => {
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={multiCategory}
        categoryOptions={[]}
        assignedOptionIds={[]}
        allAssignedOptionIds={[]}
      />,
    )
    expect(
      screen.getByLabelText('タイプ: multi'),
    ).toBeInTheDocument()
  })

  it('single カテゴリでは Circle icon (aria-label="タイプ: single") を表示', () => {
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={singleCategory}
        categoryOptions={[]}
        assignedOptionIds={[]}
        allAssignedOptionIds={[]}
      />,
    )
    expect(
      screen.getByLabelText('タイプ: single'),
    ).toBeInTheDocument()
  })
})

describe('CardTagCategoryRow — pill 群表示', () => {
  it('assignedOptionIds に対応する pill が描画される', () => {
    const options = [
      opt('o1', 'cat-multi', '循環器'),
      opt('o2', 'cat-multi', '腎'),
      opt('o3', 'cat-multi', '呼吸器'),
    ]
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={multiCategory}
        categoryOptions={options}
        assignedOptionIds={['o1', 'o2']}
        allAssignedOptionIds={['o1', 'o2']}
      />,
    )
    // 付与済の 2 つは pill として表示、 未付与の o3 は pill としては出ない
    expect(screen.getByText('循環器')).toBeInTheDocument()
    expect(screen.getByText('腎')).toBeInTheDocument()
    // 「タグ削除: 呼吸器」 button は (pill 内の × button) 存在しない
    expect(
      screen.queryByRole('button', { name: 'タグ削除: 呼吸器' }),
    ).not.toBeInTheDocument()
  })

  it('「+ 追加」 (タグ追加) trigger を表示する', () => {
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={multiCategory}
        categoryOptions={[opt('o1', 'cat-multi', '循環器')]}
        assignedOptionIds={[]}
        allAssignedOptionIds={[]}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'タグ追加' }),
    ).toBeInTheDocument()
  })
})

describe('CardTagCategoryRow — multi toggle (add 経路)', () => {
  it('未付与 option click で IDB put + enqueue (whole-set に option_id 追加)', async () => {
    const options = [opt('o1', 'cat-multi', '循環器')]
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={multiCategory}
        categoryOptions={options}
        assignedOptionIds={[]}
        allAssignedOptionIds={[]}
      />,
    )
    openMenu()
    const item = await screen.findByRole('menuitem', { name: /循環器/ })
    fireEvent.click(item)

    const db = getClientDb()
    await waitFor(async () => {
      const row = await db.card_tags.get(['card-1', 'o1'])
      expect(row).toBeTruthy()
    })

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: 'card-1',
        op: 'update_field',
        patch: { field: 'tag_option_ids', value: ['o1'] },
      })
    })
    await waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })
})

describe('CardTagCategoryRow — multi toggle (remove 経路)', () => {
  it('付与済 option を click → IDB delete + enqueue (whole-set から削除)', async () => {
    const db = getClientDb()
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'o1',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })

    const options = [opt('o1', 'cat-multi', '循環器')]
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={multiCategory}
        categoryOptions={options}
        assignedOptionIds={['o1']}
        allAssignedOptionIds={['o1']}
      />,
    )
    openMenu()
    const item = await screen.findByRole('menuitem', { name: /循環器/ })
    fireEvent.click(item)

    await waitFor(async () => {
      const row = await db.card_tags.get(['card-1', 'o1'])
      expect(row).toBeUndefined()
    })

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: 'card-1',
        op: 'update_field',
        patch: { field: 'tag_option_ids', value: [] },
      })
    })
  })
})

describe('CardTagCategoryRow — single radio 的挙動', () => {
  it('別 option click で 同カテゴリ既存 option を自動 delete + 新 option を put', async () => {
    const db = getClientDb()
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'oA',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })

    const options = [
      opt('oA', 'cat-single', '高'),
      opt('oB', 'cat-single', '中'),
    ]
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={singleCategory}
        categoryOptions={options}
        assignedOptionIds={['oA']}
        allAssignedOptionIds={['oA']}
      />,
    )
    openMenu()
    // 中 (oB) を click → oA が外れて oB が付く
    const item = await screen.findByRole('menuitem', { name: /中/ })
    fireEvent.click(item)

    await waitFor(async () => {
      const rowA = await db.card_tags.get(['card-1', 'oA'])
      const rowB = await db.card_tags.get(['card-1', 'oB'])
      expect(rowA).toBeUndefined()
      expect(rowB).toBeTruthy()
    })

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: 'card-1',
        op: 'update_field',
        patch: { field: 'tag_option_ids', value: ['oB'] },
      })
    })
  })

  it('同 option 再 click → 同カテゴリ既存 clear + 再 add せず 0 個に戻る', async () => {
    const db = getClientDb()
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'oA',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })

    const options = [opt('oA', 'cat-single', '高')]
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={singleCategory}
        categoryOptions={options}
        assignedOptionIds={['oA']}
        allAssignedOptionIds={['oA']}
      />,
    )
    openMenu()
    const item = await screen.findByRole('menuitem', { name: /高/ })
    fireEvent.click(item)

    await waitFor(async () => {
      const rowA = await db.card_tags.get(['card-1', 'oA'])
      expect(rowA).toBeUndefined()
    })
    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: 'card-1',
        op: 'update_field',
        patch: { field: 'tag_option_ids', value: [] },
      })
    })
  })
})

describe('CardTagCategoryRow — pill × click で remove', () => {
  it('pill × click で IDB delete + enqueue', async () => {
    const db = getClientDb()
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'o1',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })

    const options = [opt('o1', 'cat-multi', '循環器')]
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={multiCategory}
        categoryOptions={options}
        assignedOptionIds={['o1']}
        allAssignedOptionIds={['o1']}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'タグ削除: 循環器' }),
    )

    await waitFor(async () => {
      const row = await db.card_tags.get(['card-1', 'o1'])
      expect(row).toBeUndefined()
    })
    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: 'card-1',
        op: 'update_field',
        patch: { field: 'tag_option_ids', value: [] },
      })
    })
  })
})

describe('CardTagCategoryRow — 他カテゴリのタグを誤って落とさない', () => {
  it('multi の自カテゴリ toggle で他カテゴリの option_id は whole-set に維持される', async () => {
    // allAssignedOptionIds = [A, B, C]、 A だけが自カテゴリ、 B/C は他カテゴリ。
    const db = getClientDb()
    // B/C は他カテゴリの card_tags として既に存在する想定だが、 本 row の操作対象は
    // A のみ (toggle で A を外す) なので B/C 行は触らない。
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'A',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'B',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'C',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })

    const options = [opt('A', 'cat-multi', 'A 名')]
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={multiCategory}
        categoryOptions={options}
        assignedOptionIds={['A']}
        allAssignedOptionIds={['A', 'B', 'C']}
      />,
    )

    // A を toggle off
    fireEvent.click(screen.getByRole('button', { name: 'タグ削除: A 名' }))

    // IDB の B / C row は touch されない
    await waitFor(async () => {
      const rowA = await db.card_tags.get(['card-1', 'A'])
      expect(rowA).toBeUndefined()
    })
    const rowB = await db.card_tags.get(['card-1', 'B'])
    const rowC = await db.card_tags.get(['card-1', 'C'])
    expect(rowB).toBeTruthy()
    expect(rowC).toBeTruthy()

    // enqueue の whole-set には B / C が残る
    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalled()
    })
    const call = mockEnqueue.mock.calls[0]?.[0] as {
      patch: { value: string[] }
    }
    const sent = new Set(call.patch.value)
    expect(sent.has('A')).toBe(false)
    expect(sent.has('B')).toBe(true)
    expect(sent.has('C')).toBe(true)
  })

  it('single の自カテゴリ radio 切替で他カテゴリの option_id は whole-set に維持される', async () => {
    // allAssignedOptionIds = [oA (single 自カテゴリ), X (他カテゴリ)]
    // oA → oB に切替 (同カテゴリ): X は残るべき
    const db = getClientDb()
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'oA',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'X',
      user_id: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
    })

    const options = [
      opt('oA', 'cat-single', '高'),
      opt('oB', 'cat-single', '中'),
    ]
    render(
      <CardTagCategoryRow
        cardId="card-1"
        category={singleCategory}
        categoryOptions={options}
        assignedOptionIds={['oA']}
        allAssignedOptionIds={['oA', 'X']}
      />,
    )
    openMenu()
    const item = await screen.findByRole('menuitem', { name: /中/ })
    fireEvent.click(item)

    await waitFor(async () => {
      const rowB = await db.card_tags.get(['card-1', 'oB'])
      expect(rowB).toBeTruthy()
    })
    const rowX = await db.card_tags.get(['card-1', 'X'])
    expect(rowX).toBeTruthy()

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalled()
    })
    const call = mockEnqueue.mock.calls[0]?.[0] as {
      patch: { value: string[] }
    }
    const sent = new Set(call.patch.value)
    expect(sent.has('oA')).toBe(false)
    expect(sent.has('oB')).toBe(true)
    expect(sent.has('X')).toBe(true)
  })
})
