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
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

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

beforeEach(() => {
  vi.clearAllMocks()
  mockNewId.mockImplementation(() => realNewId.current())
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
  it('submit → enqueueEntityMutation を tag_category / create で発行 + drain', async () => {
    const FIXED_ID = '12345678-1234-4abc-8abc-1234567890ab'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(<CategoryCreateForm />)
    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '重要度' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_category',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { name: '重要度', select_type: 'multi' },
      })
    })
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('select_type=single で submit → patch.select_type=single', async () => {
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
        patch: { name: '優先度', select_type: 'single' },
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
        patch: { name: 'カテゴリ', select_type: 'multi' },
      })
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
        patch: { name: '重要度', select_type: 'multi' },
      })
    })
  })
})
