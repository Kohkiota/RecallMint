// @vitest-environment jsdom
// CategoryCreateForm client component の test。
// - name input + select_type radio (single/multi、 default multi) + 追加 button
// - name 空で button disabled
// - submit → 新 id 採番 + enqueueEntityMutation (op='create') + runGuardedEntityMutationFlush
// - submit 後 form reset (name クリア + select_type=multi に戻る)
// - onCreated callback で新 id を親に通知 (active 切替 hook)
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。
// newId は実 UUID を返す mock (Dexie に流れる id 値が実 v4 形式)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import { getClientDb } from '@/lib/client-db'

const { mockEnqueue, mockFlush, mockNewId, realNewId } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  mockNewId: vi.fn<() => string>(),
  realNewId: { current: (): string => crypto.randomUUID() },
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  newId: mockNewId,
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { CategoryCreateForm } from './category-create-form'

beforeEach(async () => {
  vi.clearAllMocks()
  mockNewId.mockImplementation(() => realNewId.current())
  // fake-indexeddb で実 Dexie を使う → 各 test 前に Tag 系 store を clear。
  const db = getClientDb()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

describe('CategoryCreateForm — 表示 / 入力', () => {
  it('name input と select_type radio (single/multi) + 「追加」 button を render', () => {
    render(<CategoryCreateForm />)
    expect(screen.getByRole('textbox', { name: 'カテゴリ名' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'multi' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'single' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'カテゴリ追加' })).toBeInTheDocument()
  })

  it('初期状態で select_type は multi が selected', () => {
    render(<CategoryCreateForm />)
    const multi = screen.getByRole('radio', { name: 'multi' }) as HTMLInputElement
    const single = screen.getByRole('radio', { name: 'single' }) as HTMLInputElement
    expect(multi.checked).toBe(true)
    expect(single.checked).toBe(false)
  })

  it('name 空で 「追加」 button が disabled', () => {
    render(<CategoryCreateForm />)
    expect(screen.getByRole('button', { name: 'カテゴリ追加' })).toBeDisabled()
  })

  it('whitespace のみの name で 「追加」 button が disabled', () => {
    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '   ' },
    })
    expect(screen.getByRole('button', { name: 'カテゴリ追加' })).toBeDisabled()
  })

  it('name 入力で button enabled', () => {
    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '重要度' },
    })
    expect(screen.getByRole('button', { name: 'カテゴリ追加' })).not.toBeDisabled()
  })
})

describe('CategoryCreateForm — submit', () => {
  it('submit → enqueueEntityMutation を tag_category / create で発行 + drain (sort_key 末尾採番)', async () => {
    const FIXED_ID = '12345678-1234-4abc-8abc-1234567890ab'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '重要度' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    // existingSortKeys 未指定 (or 空) → 起点 '0' で末尾採番
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_category',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { name: '重要度', select_type: 'multi', sort_key: '0' },
      })
    })
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('select_type=single で submit → patch.select_type=single (sort_key も含む)', async () => {
    const FIXED_ID = '22222222-2222-4222-8222-222222222222'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '優先度' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'single' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_category',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { name: '優先度', select_type: 'single', sort_key: '0' },
      })
    })
  })

  it('submit で patch.name は trim される (前後の whitespace を削る)', async () => {
    const FIXED_ID = '33333333-3333-4333-8333-333333333333'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '  カテゴリ  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_category',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { name: 'カテゴリ', select_type: 'multi', sort_key: '0' },
      })
    })
  })

  // Tag-4c-2b §4.7: existingSortKeys を受け取って末尾採番される
  it('existingSortKeys を受け取り max(Number(v))+1 で sort_key を採番する', async () => {
    const FIXED_ID = '99999999-9999-4abc-8abc-999999999999'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <CategoryCreateForm existingSortKeys={['0', '1', '2']} />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: 'タグ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_category',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { name: 'タグ', select_type: 'multi', sort_key: '3' },
      })
    })

    // IDB put の sort_key も '3' (mirror 側にも同値が書かれる、 patch と一致)
    const row = await getClientDb().tag_categories.get(FIXED_ID)
    expect(row?.sort_key).toBe('3')
  })

  it('existingSortKeys に null + 数値混在: 数値のみで max + 1', async () => {
    const FIXED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <CategoryCreateForm existingSortKeys={['0', null, '10', undefined, '2']} />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: 'タグ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    // 有効数値は 0, 10, 2 → max = 10 → '11'
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({ sort_key: '11' }),
        }),
      )
    })
  })

  it('submit 後 form reset (name クリア + select_type=multi に戻る)', async () => {
    render(<CategoryCreateForm />)
    const nameInput = screen.getByRole('textbox', { name: 'カテゴリ名' }) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '重要度' } })
    fireEvent.click(screen.getByRole('radio', { name: 'single' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalled()
    })

    expect(nameInput.value).toBe('')
    const multi = screen.getByRole('radio', { name: 'multi' }) as HTMLInputElement
    expect(multi.checked).toBe(true)
  })

  it('onCreated callback が新 id 引数で呼ばれる', async () => {
    const FIXED_ID = '44444444-4444-4444-8444-444444444444'
    mockNewId.mockImplementationOnce(() => FIXED_ID)
    const onCreated = vi.fn()

    render(<CategoryCreateForm onCreated={onCreated} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '重要度' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await vi.waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(FIXED_ID)
    })
  })

  it('onCreated 未指定でも submit が動く (callback optional)', async () => {
    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: 'X' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalled()
    })
  })

  it('form submit (Enter) でも作成できる', async () => {
    const FIXED_ID = '55555555-5555-4555-8555-555555555555'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    const { container } = render(<CategoryCreateForm />)
    const nameInput = screen.getByRole('textbox', { name: 'カテゴリ名' })
    fireEvent.change(nameInput, { target: { value: '重要度' } })
    const form = container.querySelector('form')!
    fireEvent.submit(form)

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_category',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { name: '重要度', select_type: 'multi', sort_key: '0' },
      })
    })
  })
})

describe('CategoryCreateForm — optimistic IDB put', () => {
  it('submit で IDB tag_categories に新行が即時 put される (UI 即反映の保証)', async () => {
    const FIXED_ID = '66666666-6666-4666-8666-666666666666'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '重要度' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await waitFor(async () => {
      const row = await getClientDb().tag_categories.get(FIXED_ID)
      expect(row).toBeDefined()
    })
    const row = await getClientDb().tag_categories.get(FIXED_ID)
    expect(row).toMatchObject({
      id: FIXED_ID,
      user_id: '',
      name: '重要度',
      select_type: 'multi',
      color: null,
      // existingSortKeys 未指定 → 起点 '0' で末尾採番 (Tag-4c-2b §4.7)
      sort_key: '0',
    })
    // created_at / updated_at は ISO 文字列 (時刻揃え)
    expect(typeof row!.created_at).toBe('string')
    expect(typeof row!.updated_at).toBe('string')
    expect(row!.created_at).toBe(row!.updated_at)
  })

  it('IDB put が enqueueEntityMutation より先に呼ばれる (発行順序)', async () => {
    const FIXED_ID = '77777777-7777-4777-8777-777777777777'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    // tag_categories.put を spy 化 (Dexie 実体は残しつつ呼出時刻を取る)。
    const db = getClientDb()
    const putSpy = vi.spyOn(db.tag_categories, 'put')

    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '重要度' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await waitFor(() => {
      expect(putSpy).toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalled()
    })

    const putOrder = putSpy.mock.invocationCallOrder[0]
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0]
    expect(putOrder).toBeLessThan(enqueueOrder)
    putSpy.mockRestore()
  })

  it('select_type=single で IDB row の select_type も single', async () => {
    const FIXED_ID = '88888888-8888-4888-8888-888888888888'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '優先度' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'single' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await waitFor(async () => {
      const row = await getClientDb().tag_categories.get(FIXED_ID)
      expect(row?.select_type).toBe('single')
    })
  })
})
