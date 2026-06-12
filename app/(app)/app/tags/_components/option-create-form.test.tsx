// @vitest-environment jsdom
// OptionCreateForm client component の test。
// - name input + color picker (ColorPalettePopover) + 「追加」 button
// - 空 name で button disabled
// - UNIQUE 事前チェック (existingNames に同名あり → 「同名が既に存在します」 + submit 抑止)
// - submit → 新 id 採番 + enqueueEntityMutation (op='create', patch:{category_id, name, color})
//   + runGuardedEntityMutationFlush + form reset
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。
// newId は実 UUID を返す mock。 existingNames は親 (OptionList) が useLiveQuery で
// 解決して props で渡すため、 本 test では string[] を直接渡す。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react'

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

import { OptionCreateForm } from './option-create-form'

const CAT_ID = 'cat-a'
// Sync-fix-1 T2b: form は server で解決した userId を props で受ける。 旧版の
// `user_id: ''` placeholder は撤去、 mirror row + 失敗時の rollback で USER_ID が保持される。
const USER_ID = 'user-1'

beforeEach(async () => {
  vi.clearAllMocks()
  mockNewId.mockImplementation(() => realNewId.current())
  const db = getClientDb()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

describe('OptionCreateForm — 表示 / 入力', () => {
  it('name input + color 選択 button + 「追加」 button を render', () => {
    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'option 名' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'option 色を選択' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'option 追加' })).toBeInTheDocument()
  })

  it('name 空で 「追加」 button が disabled', () => {
    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    expect(screen.getByRole('button', { name: 'option 追加' })).toBeDisabled()
  })

  it('whitespace のみの name で 「追加」 button が disabled', () => {
    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '   ' },
    })
    expect(screen.getByRole('button', { name: 'option 追加' })).toBeDisabled()
  })

  it('name 入力で button enabled', () => {
    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '高' },
    })
    expect(screen.getByRole('button', { name: 'option 追加' })).not.toBeDisabled()
  })
})

describe('OptionCreateForm — UNIQUE 事前チェック', () => {
  it('existingNames に同名 → 「同名が既に存在します」 表示 + submit 不可', async () => {
    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={['高', '低']}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '高' },
    })

    await screen.findByText(/同名が既に存在します/)
    // submit (button click) しても enqueue されない
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))
    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('UNIQUE 違反 message は trim 後で判定する (前後 whitespace は揃える)', async () => {
    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={['高']}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '  高  ' },
    })
    await screen.findByText(/同名が既に存在します/)
  })

  it('UNIQUE クリアの name (existingNames に無し) で error 非表示 + submit OK', async () => {
    const FIXED_ID = '11111111-1111-4111-8111-111111111111'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={['低']}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '高' },
    })
    expect(screen.queryByText(/同名が既に存在します/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalled()
    })
  })
})

describe('OptionCreateForm — submit', () => {
  it('submit → enqueueEntityMutation (tag_option / create, patch.category_id + name + sort_key) を発行 + drain', async () => {
    const FIXED_ID = '22222222-2222-4222-8222-222222222222'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '高' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    // existingSortKeys 未指定 → 起点 '0' で末尾採番 (Tag-4c-2b §4.7)
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_option',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { category_id: CAT_ID, name: '高', color: null, sort_key: '0' },
      })
    })
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('submit で patch.name は trim される', async () => {
    const FIXED_ID = '33333333-3333-4333-8333-333333333333'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '  高  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_option',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { category_id: CAT_ID, name: '高', color: null, sort_key: '0' },
      })
    })
  })

  it('color を選択した後の submit → patch.color に色名が乗る', async () => {
    const FIXED_ID = '44444444-4444-4444-8444-444444444444'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    // color picker を開いて 'red' を選択
    fireEvent.click(screen.getByRole('button', { name: 'option 色を選択' }))
    const redCell = await screen.findByRole('button', { name: /色: red/ })
    fireEvent.click(redCell)

    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '高' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_option',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { category_id: CAT_ID, name: '高', color: 'red', sort_key: '0' },
      })
    })
  })

  // Tag-4c-2b §4.7: existingSortKeys を受け取って末尾採番される
  it('existingSortKeys を受け取り max(Number(v))+1 で sort_key を採番する', async () => {
    const FIXED_ID = '99999999-9999-4abc-8abc-999999999999'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
        existingSortKeys={['0', '1', '2']}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: 'タグ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_option',
        entity_id: FIXED_ID,
        op: 'create',
        patch: {
          category_id: CAT_ID,
          name: 'タグ',
          color: null,
          sort_key: '3',
        },
      })
    })

    // IDB put の sort_key も '3' (mirror と patch を同値で揃える)
    const row = await getClientDb().tag_options.get(FIXED_ID)
    expect(row?.sort_key).toBe('3')
  })

  it('existingSortKeys に null + 数値混在: 数値のみで max + 1', async () => {
    const FIXED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
        existingSortKeys={['0', null, '10', undefined, '2']}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: 'タグ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    // 有効数値は 0, 10, 2 → max = 10 → '11'
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({ sort_key: '11' }),
        }),
      )
    })
  })

  it('submit 後 form reset (name クリア + color null に戻る)', async () => {
    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    const nameInput = screen.getByRole('textbox', {
      name: 'option 名',
    }) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '高' } })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalled()
    })
    expect(nameInput.value).toBe('')
  })

  it('form submit (Enter) でも作成できる', async () => {
    const FIXED_ID = '55555555-5555-4555-8555-555555555555'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    const { container } = render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '高' },
    })
    const form = container.querySelector('form')!
    fireEvent.submit(form)

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_option',
        entity_id: FIXED_ID,
        op: 'create',
        patch: { category_id: CAT_ID, name: '高', color: null, sort_key: '0' },
      })
    })
  })
})

describe('OptionCreateForm — optimistic IDB put', () => {
  it('submit で IDB tag_options に新行が即時 put される (UI 即反映の保証)', async () => {
    const FIXED_ID = '66666666-6666-4666-8666-666666666666'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '高' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    await waitFor(async () => {
      const row = await getClientDb().tag_options.get(FIXED_ID)
      expect(row).toBeDefined()
    })
    const row = await getClientDb().tag_options.get(FIXED_ID)
    expect(row).toMatchObject({
      id: FIXED_ID,
      // Sync-fix-1 T2b: server で解決した USER_ID が mirror row に保持される
      // (旧版の `user_id: ''` placeholder は撤去)。
      user_id: USER_ID,
      category_id: CAT_ID,
      name: '高',
      color: null,
      // existingSortKeys 未指定 → 起点 '0' で末尾採番 (Tag-4c-2b §4.7)
      sort_key: '0',
    })
    expect(typeof row!.created_at).toBe('string')
    expect(typeof row!.updated_at).toBe('string')
    expect(row!.created_at).toBe(row!.updated_at)
  })

  it('IDB add が enqueueEntityMutation より先に呼ばれる (発行順序)', async () => {
    const FIXED_ID = '77777777-7777-4777-8777-777777777777'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    // Sync-fix-1 T2b: helper (`runOptimisticCreate`) は mirror に `add` で挿入する
    // (UUID 新規採番なので collision は実質発生せず、 万一の collision は throw → tx rollback)。
    const db = getClientDb()
    const addSpy = vi.spyOn(db.tag_options, 'add')

    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '高' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    await waitFor(() => {
      expect(addSpy).toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalled()
    })
    const addOrder = addSpy.mock.invocationCallOrder[0]
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0]
    expect(addOrder).toBeLessThan(enqueueOrder)
    addSpy.mockRestore()
  })

  it('color 選択ありの submit で IDB row.color に色名が反映', async () => {
    const FIXED_ID = '88888888-8888-4888-8888-888888888888'
    mockNewId.mockImplementationOnce(() => FIXED_ID)

    render(
      <OptionCreateForm
        userId={USER_ID}
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 色を選択' }))
    const redCell = await screen.findByRole('button', { name: /色: red/ })
    fireEvent.click(redCell)

    fireEvent.change(screen.getByRole('textbox', { name: 'option 名' }), {
      target: { value: '高' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    await waitFor(async () => {
      const row = await getClientDb().tag_options.get(FIXED_ID)
      expect(row?.color).toBe('red')
    })
  })
})

// Sync-fix-1 T2b: helper (`runOptimisticCreate`) は `userId === ''` で console.error +
// 早期 throw する fail-fast contract。 form は handleSubmit 内で `void runOptimisticCreate`
// しており caller try/catch は無いが、 helper の throw は void で握りつぶされ console.error
// は残る → form の reset は同期で進行する設計を pin する。
describe('OptionCreateForm — userId="" fail-fast (sync-fix-1 T2b)', () => {
  it('userId="" で console.error が出る (helper fail-fast) が UI は reset で進行する', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <OptionCreateForm
        userId=""
        activeCategoryId={CAT_ID}
        existingNames={[]}
      />,
    )
    const nameInput = screen.getByRole('textbox', {
      name: 'option 名',
    }) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '高' } })
    fireEvent.click(screen.getByRole('button', { name: 'option 追加' }))

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        '[optimistic-create] empty user_id, aborting create',
      )
    })
    // form reset は helper await の前に sync で発火する設計のため進行する
    expect(nameInput.value).toBe('')
    // mirror は書かれない (helper が tx を張る前に throw)
    expect(mockEnqueue).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})
