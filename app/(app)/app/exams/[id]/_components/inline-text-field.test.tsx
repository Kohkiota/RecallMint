// @vitest-environment jsdom
// InlineTextField client component の test (Stage 4 / Task 4.2 cutover 後)。
// blur (commit) で mirror 直書き (Dexie cards.update) + outbox enqueue
// (enqueueEntityMutation, op='update_field')、 500ms debounce 後に
// runGuardedEntityMutationFlush で drain。 値変更なしは commit skip。 dirty-guard:
// 編集中は外部 prop で value を上書きしない / idle 時は prop 変化で display 更新。
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock、 mirror write は
// fake-indexeddb の実 Dexie で assert する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { getClientDb } from '@/lib/client-db'

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

import { InlineTextField } from './inline-text-field'

const CARD_ID = '11111111-1111-4111-8111-111111111111'

// 各 test の前に cards mirror を clear し、 対象 card の base 行を 1 件 seed する
// (mirror update の前提として行が存在している必要がある)。
async function seedCard(fields: Partial<Record<string, unknown>> = {}) {
  const db = getClientDb()
  await db.cards.put({
    id: CARD_ID,
    user_id: 'user-1',
    exam_id: 'exam-1',
    title: '',
    sort_key: null,
    question_text: '',
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
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
    ...fields,
  } as never)
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useRealTimers()
  await getClientDb().cards.clear()
  await seedCard()
})

afterEach(() => {
  cleanup()
})

describe('InlineTextField — render / edit 基本', () => {
  it('display モード: initialValue を rendering', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="問題タイトル"
        ariaLabel="title 編集"
      />,
    )
    expect(screen.getByText('問題タイトル')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('null initialValue: placeholder を表示', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="sort_key"
        initialValue={null}
        ariaLabel="ソートキー 編集"
        placeholder="(クリックで追加)"
      />,
    )
    expect(screen.getByText('(クリックで追加)')).toBeInTheDocument()
  })

  it('click で edit mode、 input が auto-focus + 初期値セット', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="問題タイトル"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input).toHaveValue('問題タイトル')
    expect(document.activeElement).toBe(input)
  })

  it('multiline=false: input を render', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="t"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    expect(screen.getByRole('textbox').tagName).toBe('INPUT')
  })

  it('multiline=true: textarea を render', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="question_text"
        initialValue="q"
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA')
  })

  it('edit mode 中 aria-label が input に付与される', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="t"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-label', 'title 編集')
  })

  it('display mode の button が tap target を確保 (min-h-11)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="t"
        ariaLabel="title 編集"
      />,
    )
    expect(
      screen.getByRole('button', { name: 'title 編集' }).className,
    ).toMatch(/min-h-11/)
  })
})

describe('InlineTextField — mirror write + outbox enqueue (Task 4.2)', () => {
  it('値変更 + blur → mirror に patch が書かれる', async () => {
    await seedCard({ title: '旧' })
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '新タイトル' },
    })
    fireEvent.blur(screen.getByRole('textbox'))

    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.title).toBe('新タイトル')
    })
  })

  it('値変更 + blur → enqueueEntityMutation が update_field / field / value で呼ばれる', async () => {
    await seedCard({ title: '旧' })
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '新タイトル' },
    })
    fireEvent.blur(screen.getByRole('textbox'))

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: { field: 'title', value: '新タイトル' },
      })
    })
  })

  it('値変更 + blur → 楽観表示で display が新値に即時反映 (mirror lag を埋める)', async () => {
    await seedCard({ title: '旧' })
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '新タイトル' },
    })
    fireEvent.blur(screen.getByRole('textbox'))
    // blur 直後 (mirror/live 反映前) でも display は楽観値
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('新タイトル')).toBeInTheDocument()
  })

  it('値変更なし + blur → mirror write も enqueue もされない、 display 復帰', async () => {
    await seedCard({ title: '旧' })
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    fireEvent.blur(screen.getByRole('textbox'))
    await vi.waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
    // mirror は触られていない
    const row = await getClientDb().cards.get(CARD_ID)
    expect(row?.title).toBe('旧')
  })

  it('null initial → 空のまま blur → enqueue されない', async () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="memo"
        initialValue={null}
        ariaLabel="memo 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'memo 編集' }))
    fireEvent.blur(screen.getByRole('textbox'))
    await vi.waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('nullable field を空にして blur → mirror に null が書かれる (server 正規化と一致)', async () => {
    await seedCard({ memo: '旧メモ' })
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="memo"
        initialValue="旧メモ"
        ariaLabel="memo 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'memo 編集' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    fireEvent.blur(screen.getByRole('textbox'))

    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.memo).toBeNull()
    })
    // enqueue には raw '' が渡る (server 側 buildSetClause が '' → null 正規化する)。
    expect(mockEnqueue).toHaveBeenCalledWith({
      entity_type: 'card', entity_id: CARD_ID,
      op: 'update_field',
      patch: { field: 'memo', value: '' },
    })
  })

  it('non-nullable field (title) は空でも mirror に空文字を書く (null 化しない)', async () => {
    await seedCard({ title: '旧' })
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    fireEvent.blur(screen.getByRole('textbox'))

    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.title).toBe('')
    })
  })

  it('null initial → 値入力 + blur → enqueue に新値 (memo field)', async () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="memo"
        initialValue={null}
        ariaLabel="memo 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'memo 編集' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '初メモ' },
    })
    fireEvent.blur(screen.getByRole('textbox'))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: { field: 'memo', value: '初メモ' },
      })
    })
  })
})

describe('InlineTextField — auto-resize regression (S2.0b-2)', () => {
  it('multiline=true: textarea に rows attribute が無い', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="question_text"
        initialValue="q"
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(ta.hasAttribute('rows')).toBe(false)
  })

  it('multiline=true: resize-none + overflow-hidden が付く', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="question_text"
        initialValue="q"
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(ta.className).toMatch(/resize-none/)
    expect(ta.className).toMatch(/overflow-hidden/)
  })

  it('multiline=true: mount 時に useLayoutEffect で style.height が inline 設定される', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="question_text"
        initialValue="複数行"
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(ta.style.height).not.toBe('')
  })

  it('multiline=true: value 変化で style.height が再 assign される ([editing, value] dep lock)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="question_text"
        initialValue="短い"
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    ta.style.height = ''
    expect(ta.style.height).toBe('')
    fireEvent.change(ta, {
      target: { value: '長い\n複数行\nテキスト' },
    })
    expect(ta.style.height).not.toBe('')
    expect(ta.style.height).toMatch(/px$/)
  })

  it('display / edit 共通 chrome (min-h-11 + p-2 + rounded-md + border-transparent + md responsive)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="question_text"
        initialValue="q"
        ariaLabel="question 編集"
        multiline
      />,
    )
    const btn = screen.getByRole('button', { name: 'question 編集' })
    expect(btn.className).toMatch(/min-h-11/)
    expect(btn.className).toMatch(/\bp-2\b/)
    expect(btn.className).toMatch(/rounded-md/)
    expect(btn.className).toMatch(/border-transparent/)
    expect(btn.className).toMatch(/md:min-h-8/)
    expect(btn.className).toMatch(/md:py-1/)
    fireEvent.click(btn)
    const ta = screen.getByRole('textbox')
    expect(ta.className).toMatch(/min-h-11/)
    expect(ta.className).toMatch(/\bp-2\b/)
    expect(ta.className).toMatch(/rounded-md/)
    expect(ta.className).toMatch(/md:min-h-8/)
    expect(ta.className).toMatch(/md:py-1/)
  })

  it('displayClassName が両モードに伝搬する', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="title"
        initialValue="t"
        ariaLabel="title 編集"
        displayClassName="text-sm font-medium text-slate-900"
      />,
    )
    const btn = screen.getByRole('button', { name: 'title 編集' })
    expect(btn.className).toMatch(/text-sm/)
    expect(btn.className).toMatch(/font-medium/)
    expect(btn.className).toMatch(/text-slate-900/)
    fireEvent.click(btn)
    const input = screen.getByRole('textbox')
    expect(input.className).toMatch(/text-sm/)
    expect(input.className).toMatch(/font-medium/)
    expect(input.className).toMatch(/text-slate-900/)
  })
})

describe('InlineTextField — autoEditOnMount (S2.0b 「+ カードを追加」用)', () => {
  it('autoEditOnMount: mount 時点で edit mode (textbox + auto-focus)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="question_text"
        initialValue="(問題文を入力してください)"
        ariaLabel="問題文 編集"
        multiline
        autoEditOnMount
      />,
    )
    const input = screen.getByRole('textbox', { name: '問題文 編集' })
    expect(input).toBeInTheDocument()
    expect(document.activeElement).toBe(input)
  })

  it('autoEditOnMount 省略: 通常通り display mode で mount', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="question_text"
        initialValue="本文"
        ariaLabel="問題文 編集"
        multiline
      />,
    )
    expect(
      screen.queryByRole('textbox', { name: '問題文 編集' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('本文')).toBeInTheDocument()
  })

  it('one-shot: blur で display に戻った後、 prop が true のままでも再 edit しない', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="question_text"
        initialValue="本文"
        ariaLabel="問題文 編集"
        multiline
        autoEditOnMount
      />,
    )
    const input = screen.getByRole('textbox', { name: '問題文 編集' })
    fireEvent.blur(input)
    expect(
      screen.queryByRole('textbox', { name: '問題文 編集' }),
    ).not.toBeInTheDocument()
  })
})

describe('InlineTextField — 末尾改行の display 補正 (<br>)', () => {
  it('末尾改行ありの値は display に <br> を 1 つ補い、 textContent は値そのまま', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="memo"
        initialValue={'あ\n\n'}
        ariaLabel="メモ 編集"
        multiline
      />,
    )
    const disp = screen.getByRole('button', { name: 'メモ 編集' })
    // pre-wrap が落とす末尾 1 行を <br> 1 個で補う (末尾改行数 N に依らず常に 1 個)。
    expect(disp.querySelectorAll('br')).toHaveLength(1)
    // コピー (textContent) は改行込みの値そのまま (<br> は寄与しない)。
    expect(disp.textContent).toBe('あ\n\n')
  })

  it('内部改行のみ (末尾が非改行) は <br> を足さない', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="memo"
        initialValue={'あ\nい'}
        ariaLabel="メモ 編集"
        multiline
      />,
    )
    const disp = screen.getByRole('button', { name: 'メモ 編集' })
    expect(disp.querySelectorAll('br')).toHaveLength(0)
    expect(disp.textContent).toBe('あ\nい')
  })

  it('単一末尾改行 (あ\\n) も <br> 1 個で補う (N=1)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="memo"
        initialValue={'あ\n'}
        ariaLabel="メモ 編集"
        multiline
      />,
    )
    const disp = screen.getByRole('button', { name: 'メモ 編集' })
    expect(disp.querySelectorAll('br')).toHaveLength(1)
    expect(disp.textContent).toBe('あ\n')
  })

  it('改行のみ (\\n) は空扱いせず display + <br> を出す', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        field="memo"
        initialValue={'\n'}
        ariaLabel="メモ 編集"
        multiline
      />,
    )
    // length===0 でないため placeholder ではなく値表示 (button) + <br> 補正。
    const disp = screen.getByRole('button', { name: 'メモ 編集' })
    expect(disp.querySelectorAll('br')).toHaveLength(1)
    expect(disp.textContent).toBe('\n')
  })
})
