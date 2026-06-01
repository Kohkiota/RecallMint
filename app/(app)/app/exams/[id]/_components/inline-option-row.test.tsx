// @vitest-environment jsdom
// 試験詳細 page の選択肢 inline 編集 (`InlineOptionList` + 内部 `InlineOptionRow`)
// の基本動作 test (Stage 4 / Task 4.2 cutover 後)。 cell blur / checkbox toggle /
// add / delete の commit は mirror 直書き (Dexie cards.update に options +
// correct_answer_ids) + outbox enqueue (op='update_field', field='options',
// value=camelCase ZodOption[])。 ghost row (text='') は sanitize で payload から除外。
//
// enqueueCardMutation / runGuardedCardMutationFlush は spy mock、 mirror write は
// fake-indexeddb の実 Dexie で assert する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { CardOption } from '@/lib/db/schema'
import { getClientDb } from '@/lib/client-db'

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/card-mutations', () => ({
  enqueueCardMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/card-mutation-flush', () => ({
  runGuardedCardMutationFlush: mockFlush,
}))

import { InlineOptionList } from './inline-option-row'

const CARD_ID = '33333333-3333-4333-8333-333333333333'

const baseOptions: CardOption[] = [
  { id: 'a', text: '選択肢A', is_correct: true, explanation: 'A 理由' },
  { id: 'b', text: '選択肢B', is_correct: false },
]

async function seedCard(options: CardOption[]) {
  await getClientDb().cards.put({
    id: CARD_ID,
    user_id: 'user-1',
    exam_id: 'exam-1',
    title: '',
    sort_key: null,
    question_text: '',
    options,
    correct_answer_ids: options.filter((o) => o.is_correct).map((o) => o.id),
    explanation_text: null,
    memo: null,
    images: [],
    custom_props: {},
    tags: [],
    answered: false,
    current_streak: 0,
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    sync_status: 'synced',
  } as never)
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useRealTimers()
  await getClientDb().cards.clear()
})

afterEach(() => {
  cleanup()
})

function renderSingle(option: CardOption) {
  return render(<InlineOptionList cardId={CARD_ID} options={[option]} />)
}

describe('InlineOptionRow (via InlineOptionList) — 表示', () => {
  it('初期表示: id / text / is_correct=true checked / explanation を描画', () => {
    renderSingle(baseOptions[0]!)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.getByText('A 理由', { exact: false })).toBeInTheDocument()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  it('is_correct=false の option は checkbox unchecked', () => {
    renderSingle(baseOptions[1]!)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('explanation 未設定 → placeholder 表示', () => {
    renderSingle(baseOptions[1]!)
    expect(screen.getByText('解説 (クリックで追加)')).toBeInTheDocument()
  })

  it('a11y: checkbox に aria-label が付与される', () => {
    renderSingle(baseOptions[0]!)
    expect(screen.getByRole('checkbox')).toHaveAttribute(
      'aria-label',
      '選択肢 正解フラグ 編集',
    )
  })
})

describe('InlineOptionList — cell edit → mirror + enqueue', () => {
  it('id 編集 + blur → options 全体を該当 index のみ書換えて enqueue', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 id 編集' })[0]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 id 編集' }), {
      target: { value: 'A1' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 id 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        card_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'A1', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: false },
          ],
        },
      })
    })
  })

  it('text 編集 + blur → mirror cards.update に options + correct_answer_ids が書かれる', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 本文 編集' }), {
      target: { value: '選択肢A 改' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.options).toEqual([
        { id: 'a', text: '選択肢A 改', is_correct: true, explanation: 'A 理由' },
        { id: 'b', text: '選択肢B', is_correct: false },
      ])
      // correct_answer_ids は is_correct から derive して mirror に楽観反映
      expect(row?.correct_answer_ids).toEqual(['a'])
    })
  })

  it('explanation 編集 + blur → enqueue に explanation 含む', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 解説 編集' })[1]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 解説 編集' }), {
      target: { value: 'B 理由' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 解説 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        card_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: false, explanation: 'B 理由' },
          ],
        },
      })
    })
  })

  it('explanation を空文字に → enqueue payload から explanation key が drop される', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 解説 編集' })[0]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 解説 編集' }), {
      target: { value: '' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 解説 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        card_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true },
            { id: 'b', text: '選択肢B', isCorrect: false },
          ],
        },
      })
    })
  })

  it('該当 index の field のみ書換、 他 option は touch しない', async () => {
    const opts: CardOption[] = [
      { id: 'a', text: 'A', is_correct: false },
      { id: 'b', text: 'B', is_correct: true, explanation: 'B 理由' },
      { id: 'c', text: 'C', is_correct: false },
    ]
    await seedCard(opts)
    render(<InlineOptionList cardId={CARD_ID} options={opts} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[1]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 本文 編集' }), {
      target: { value: 'B 改' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        card_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: 'A', isCorrect: false },
            { id: 'b', text: 'B 改', isCorrect: true, explanation: 'B 理由' },
            { id: 'c', text: 'C', isCorrect: false },
          ],
        },
      })
    })
  })

  it('値変更なし + blur → enqueue されない', async () => {
    await seedCard([baseOptions[0]!])
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 id 編集' }))
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 id 編集' }))
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('textbox', { name: '選択肢 id 編集' }),
      ).not.toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

describe('InlineOptionList — checkbox toggle', () => {
  it('checkbox change → 即時 mirror + enqueue (blur 待たず)', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!) // option b を ON
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        card_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: true },
          ],
        },
      })
    })
  })

  it('checkbox toggle → mirror の correct_answer_ids が即時更新される', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!) // b を ON
    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.correct_answer_ids).toEqual(['a', 'b'])
    })
  })

  it('checkbox toggle → drain (flush) が即時叩かれる', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('checkbox toggle で正解サマリが即時更新 (optimistic)', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    expect(screen.getByText('○ 正解: a')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    await vi.waitFor(() => {
      expect(screen.getByText('○ 正解: a, b')).toBeInTheDocument()
    })
    expect(screen.queryByText('○ 正解: a')).not.toBeInTheDocument()
  })
})

describe('InlineOptionList — add / delete + ghost', () => {
  it('「+ 選択肢を追加」 button が list 末尾に描画される', () => {
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    expect(
      screen.getByRole('button', { name: '+ 選択肢を追加' }),
    ).toBeInTheDocument()
  })

  it('削除 button が各 option row に描画される (option 数と一致)', () => {
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    expect(screen.getAllByRole('button', { name: '選択肢を削除' }).length).toBe(2)
  })

  it('options.length === 1 → 削除 button が disabled', () => {
    renderSingle(baseOptions[0]!)
    expect(screen.getByRole('button', { name: '選択肢を削除' })).toBeDisabled()
  })

  it('「+ 追加」: 新 option が optimistic に末尾追加 + text cell が即 edit mode', async () => {
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    expect(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' }).length,
    ).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      ).toBeInTheDocument()
    })
  })

  it('「+ 追加」: 新 option の id は nextOptionId 規則 (a,b → c)', () => {
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    expect(screen.getByText('c')).toBeInTheDocument()
  })

  it('追加 click 直後は enqueue されない (text 空 ghost は sanitize で除外)', async () => {
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      ).toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('追加後 ghost に text 入力 + blur → 昇格して enqueue に new option 含む', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    const ta = await screen.findByRole('textbox', { name: '選択肢 本文 編集' })
    fireEvent.change(ta, { target: { value: '新しい選択肢' } })
    fireEvent.blur(ta)
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        card_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: false },
            { id: 'c', text: '新しい選択肢', isCorrect: false },
          ],
        },
      })
    })
  })

  it('ghost を text 入力なく blur → sanitized が server-committed と一致 → enqueue skip、 ghost は local に残る', async () => {
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    const ta = await screen.findByRole('textbox', { name: '選択肢 本文 編集' })
    fireEvent.blur(ta)
    // microtask flush しても enqueue されない
    await new Promise((r) => setTimeout(r, 50))
    expect(mockEnqueue).not.toHaveBeenCalled()
    // ghost は local state に残る (display で 'c')
    expect(screen.getByText('c')).toBeInTheDocument()
  })

  it('ghost 放置で別 row checkbox toggle → ghost 除外で別 row 変更のみ enqueue', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      ).toBeInTheDocument()
    })
    fireEvent.click(screen.getAllByRole('checkbox')[1]!) // option B を ON
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        card_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: true },
          ],
        },
      })
    })
  })

  it('削除 click → optimistic に row が消え、 filtered options を enqueue', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} options={baseOptions} />)
    expect(screen.getByText('選択肢B')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '選択肢を削除' })[1]!)
    await vi.waitFor(() => {
      expect(screen.queryByText('選択肢B')).not.toBeInTheDocument()
    })
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        card_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
          ],
        },
      })
    })
  })
})

describe('InlineOptionList — auto-resize / layout regression (S2.0b)', () => {
  it('text cell (multiline): textarea に rows attribute が無い', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', {
      name: '選択肢 本文 編集',
    }) as HTMLTextAreaElement
    expect(ta.tagName).toBe('TEXTAREA')
    expect(ta.hasAttribute('rows')).toBe(false)
  })

  it('id cell (single-line): Input element、 inline style.height は assign されない', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 id 編集' }))
    const inputEl = screen.getByRole('textbox', { name: '選択肢 id 編集' })
    expect(inputEl.tagName).toBe('INPUT')
    expect((inputEl as HTMLInputElement).style.height).toBe('')
  })

  it('text textarea に resize-none + overflow-hidden が付く', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    expect(ta.className).toMatch(/resize-none/)
    expect(ta.className).toMatch(/overflow-hidden/)
  })

  it('text cell mount 時に useLayoutEffect で style.height が inline 設定される', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', {
      name: '選択肢 本文 編集',
    }) as HTMLTextAreaElement
    expect(ta.style.height).not.toBe('')
    expect(ta.style.height).toMatch(/px$/)
  })

  it('text cell: editValue 変化で style.height が再 assign される', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', {
      name: '選択肢 本文 編集',
    }) as HTMLTextAreaElement
    ta.style.height = ''
    expect(ta.style.height).toBe('')
    fireEvent.change(ta, { target: { value: '長い\n複数行\nテキスト' } })
    expect(ta.style.height).not.toBe('')
    expect(ta.style.height).toMatch(/px$/)
  })

  it('display / edit 共通: 3 cell 種別とも sharedBoxChrome を持つ、 display は border-transparent + md responsive', () => {
    renderSingle(baseOptions[0]!)
    const idBtn = screen.getByRole('button', { name: '選択肢 id 編集' })
    expect(idBtn.className).toMatch(/min-h-11/)
    expect(idBtn.className).toMatch(/\bp-2\b/)
    expect(idBtn.className).toMatch(/rounded-md/)
    expect(idBtn.className).toMatch(/border-transparent/)
    expect(idBtn.className).toMatch(/md:min-h-8/)
    expect(idBtn.className).toMatch(/md:py-1/)
    fireEvent.click(idBtn)
    const idInput = screen.getByRole('textbox', { name: '選択肢 id 編集' })
    expect(idInput.className).toMatch(/min-h-11/)
    expect(idInput.className).toMatch(/rounded-md/)
    expect(idInput.className).toMatch(/md:min-h-8/)
    expect(idInput.className).toMatch(/md:py-1/)
  })

  it('responsive スリム化: checkbox label に md:min-h-0/md:min-w-0 が付く', () => {
    renderSingle(baseOptions[0]!)
    const checkbox = screen.getByRole('checkbox')
    const label = checkbox.closest('label')!
    expect(label.className).toMatch(/min-h-11/)
    expect(label.className).toMatch(/min-w-11/)
    expect(label.className).toMatch(/md:min-h-0/)
    expect(label.className).toMatch(/md:min-w-0/)
  })

  it('responsive スリム化: checkbox input に md:h-4/md:w-4 が付く', () => {
    renderSingle(baseOptions[0]!)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.className).toMatch(/h-6/)
    expect(checkbox.className).toMatch(/w-6/)
    expect(checkbox.className).toMatch(/md:h-4/)
    expect(checkbox.className).toMatch(/md:w-4/)
  })

  it('displayClassName が両モードに伝搬する (is_correct=true は emerald)', () => {
    renderSingle(baseOptions[0]!)
    const textBtn = screen.getByRole('button', { name: '選択肢 本文 編集' })
    expect(textBtn.className).toMatch(/font-bold/)
    expect(textBtn.className).toMatch(/text-emerald-900/)
    fireEvent.click(textBtn)
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    expect(ta.className).toMatch(/font-bold/)
    expect(ta.className).toMatch(/text-emerald-900/)
  })

  it('id cell displayClassName (font-mono) も両モードに伝搬', () => {
    renderSingle(baseOptions[0]!)
    const idBtn = screen.getByRole('button', { name: '選択肢 id 編集' })
    expect(idBtn.className).toMatch(/font-mono/)
    fireEvent.click(idBtn)
    expect(
      screen.getByRole('textbox', { name: '選択肢 id 編集' }).className,
    ).toMatch(/font-mono/)
  })

  it('grid wrapper に md:gap-1 が付く (responsive スリム化)', () => {
    const { container } = renderSingle(baseOptions[0]!)
    const grid = container.querySelector('[class*="grid-cols-"]')
    expect(grid).not.toBeNull()
    expect(grid!.className).toMatch(/md:gap-1/)
  })
})
