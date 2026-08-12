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
const USER_ID = 'user-1'

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
  // T1b: runOptimisticUpdate 化で commit が `await db.transaction(...)` 経由になり、
  // 前 test の void 発火 transaction が次 test 開始時に未 settle で残るケースが発生する。
  // mock の `mockEnqueue` が次 test 内で stale call を記録しないよう、 mock 操作の前に
  // Dexie の cards.clear() を await して前 test の transaction を drain する。
  vi.useRealTimers()
  await getClientDb().cards.clear()
  vi.clearAllMocks()
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        user_id: USER_ID,
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
    // enqueue には raw '' が渡る (server 側 CARD_FIELD_HANDLERS[field] handler が
    // '' → null 正規化する。 lib/cards/card-field-handlers.ts 参照)。
    expect(mockEnqueue).toHaveBeenCalledWith({
      user_id: USER_ID,
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        user_id: USER_ID,
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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
        userId={USER_ID}
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

// ---------------------------------------------------------------------------
// 状態遷移 pin (波2 ESLint C1: set-state-in-effect → prev-render pattern refactor +
// refs simple 撤去 の挙動保存証明)。 dirty-guard:
//   (a) editing=true で initialValue が外部変化 → value 保護
//   (b) editing=false (idle) で initialValue が外部変化 → value 同期 (display 反映)
// b02c072 hook regression pin と同形、 fix 前後で両方 pass する観点で踏む。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edit-3 T2: cn 統一後の twMerge 上書き確認
// displayClassName に md:min-h-6 を渡すと sharedBoxChrome の md:min-h-8 が上書きされる
// ことを display/edit 両パスで確認。wrapper div でなく内側 box 要素(textarea/input/div)
// に効くことを assert。
// ---------------------------------------------------------------------------

describe('Edit-3 T2: displayClassName の md:min-h 上書き (cn 統一 + twMerge)', () => {
  it('display div(inner box): md:min-h-6 が md:min-h-8 を上書き — box 要素に効く', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="question_text"
        initialValue="テスト"
        ariaLabel="question 編集"
        multiline
        displayClassName="text-sm md:min-h-6 md:py-0.5"
      />,
    )
    const btn = screen.getByRole('button', { name: 'question 編集' })
    const classes = btn.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8') // twMerge で上書き済
  })

  it('edit textarea(inner box): md:min-h-6 が md:min-h-8 を上書き', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="question_text"
        initialValue="テスト"
        ariaLabel="question 編集"
        multiline
        displayClassName="text-sm md:min-h-6 md:py-0.5"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    const ta = screen.getByRole('textbox')
    const classes = ta.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('edit input(inner box): md:min-h-6 が md:min-h-8 を上書き', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="テスト"
        ariaLabel="title 編集"
        displayClassName="md:min-h-6 md:py-0.5"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox')
    const classes = input.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('display と edit の md:min-h が一致する (layout shift 防止)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="テスト"
        ariaLabel="title 編集"
        displayClassName="md:min-h-6 md:py-0.5"
      />,
    )
    const btn = screen.getByRole('button', { name: 'title 編集' })
    const displayClasses = btn.className.split(' ')
    fireEvent.click(btn)
    const input = screen.getByRole('textbox')
    const editClasses = input.className.split(' ')
    // display と edit で md:min-h が同値
    expect(displayClasses).toContain('md:min-h-6')
    expect(editClasses).toContain('md:min-h-6')
    // どちらも md:min-h-8 が消えている
    expect(displayClasses).not.toContain('md:min-h-8')
    expect(editClasses).not.toContain('md:min-h-8')
  })
})

describe('InlineTextField — 外部 prop 遷移と editing 状態の保護 (波2 C1 pin)', () => {
  it('editing=true (編集中) で initialValue が外部変化しても input の value は保護される', () => {
    const { rerender } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧タイトル"
        ariaLabel="title 編集"
      />,
    )
    // edit mode に入る。
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('旧タイトル')
    // user 入力で local state を更新。
    fireEvent.change(input, { target: { value: 'ユーザ編集中' } })
    expect(input.value).toBe('ユーザ編集中')
    // 外部経路 (pull-back / 別 commit) で initialValue が変化。
    rerender(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="外部更新"
        ariaLabel="title 編集"
      />,
    )
    // 編集中なので local value は保護される。
    const inputAfter = screen.getByRole('textbox') as HTMLInputElement
    expect(inputAfter.value).toBe('ユーザ編集中')
  })

  it('editing=false (idle) で initialValue が外部変化したら display は新値に同期する', () => {
    const { rerender } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧タイトル"
        ariaLabel="title 編集"
      />,
    )
    expect(screen.getByText('旧タイトル')).toBeInTheDocument()
    rerender(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="外部更新"
        ariaLabel="title 編集"
      />,
    )
    expect(screen.getByText('外部更新')).toBeInTheDocument()
    // 次回 edit 時にも input は新値が出る。
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('外部更新')
  })

  it('editing=true 中に initialValue が変化しても、 blur (editing=false 遷移) 後に local value が user typed のまま (flicker なし / 旧 deps [initialValue] 単独 invariant pin)', () => {
    // 旧 useEffect 実装の意図 = 「editing 変化単独では setValue しない」 (deps 単独 +
    // eslint-disable で意図明示)。 prev-render guard 実装でも厳密に保持する必要がある:
    // editing=true 中に外部 prop が変化 → sentinel は更新するが setValue は inner gate で
    // skip → blur (editing: true → false) 時には sentinel が既に新値に同期済なので guard
    // が走らず setValue されない = display は user 編集値のまま (flicker なし)。
    const { rerender } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="server-old"
        ariaLabel="title 編集"
      />,
    )
    // edit 開始
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('server-old')
    // user typing
    fireEvent.change(input, { target: { value: 'user-typed' } })
    expect(input.value).toBe('user-typed')
    // server pull が editing 中に来る (initialValue 変化)
    rerender(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="server-new"
        ariaLabel="title 編集"
      />,
    )
    // 編集中なので local value は保護されたまま (sentinel は新値に更新、 setValue は skip)
    const inputAfterRerender = screen.getByRole('textbox') as HTMLInputElement
    expect(inputAfterRerender.value).toBe('user-typed')
    // blur (editing: true → false)
    fireEvent.blur(inputAfterRerender)
    // display は user-typed のまま、 server-new に flicker していない。
    // (旧 deps [initialValue] 単独 + early return invariant を厳密保持)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('user-typed')).toBeInTheDocument()
    expect(screen.queryByText('server-new')).not.toBeInTheDocument()
  })

  it('値変更なし blur 判定の比較基準は最新 initialValue (refs 撤去 pin、 波2 C1)', async () => {
    // refs simple 撤去 (mirrorValueRef → initialString 直接参照) の挙動保存証明。
    // 旧実装: blur 時に value === mirrorValueRef.current を比較し、 ref は render 中に
    // initialString を毎度書き戻していたので「最新 initialValue」 が比較基準。
    // 新実装: ref を消し render scope の initialString を closure 捕捉 → 同等の挙動。
    // → 外部 prop が変わった直後の idle 状態で「新値と同値」 で blur した場合は
    //   commit (enqueue) 不要、 enqueue が呼ばれないことを pin する。
    const { rerender } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    // 外部更新 (server pull で新値 '新' に置換、 user は何も編集していない)。
    rerender(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="新"
        ariaLabel="title 編集"
      />,
    )
    // idle なので display も value も '新' に同期済。
    expect(screen.getByText('新')).toBeInTheDocument()
    // edit → 値を変えずに blur (短絡経路、 value === initialString)。
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('新')
    fireEvent.blur(input)
    // commit / enqueue / flush は呼ばれない (mirrorValueRef.current === '新' で short-circuit、
    // refs 撤去後の新実装でも render scope initialString === '新' で同等の short-circuit)。
    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
  })
})

describe('InlineTextField — commit-on-unmount (Fix-3 Imp#1)', () => {
  // NOTE: scroll-out による実際の focus tear-down / onBlur 不発は jsdom で再現不可。
  // RTL unmount() で代替し、mirror write + outbox enqueue を assert する。
  // scroll-out 実挙動の確認は実機 smoke で行う。

  it('#1 保存(核心): editing+dirty → unmount → mirror に新値 + outbox に update_field', async () => {
    await seedCard({ title: '旧' })
    const { unmount } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
        autoEditOnMount
      />,
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新タイトル' } })
    // blur させずに unmount (仮想化 scroll-out による unmount の代替)
    unmount()

    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.title).toBe('新タイトル')
    })
    expect(mockEnqueue).toHaveBeenCalledWith({
      user_id: USER_ID,
      entity_type: 'card', entity_id: CARD_ID,
      op: 'update_field',
      patch: { field: 'title', value: '新タイトル' },
    })
  })

  it('#2 guard-1(not editing): display のまま unmount → mirror/outbox 書込なし', async () => {
    await seedCard({ title: '旧' })
    const { unmount } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    unmount()

    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    const row = await getClientDb().cards.get(CARD_ID)
    expect(row?.title).toBe('旧')
  })

  it('#3 guard-2(editing but clean): editing で value 変えずに unmount → 書込なし', async () => {
    await seedCard({ title: '旧' })
    const { unmount } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
        autoEditOnMount
      />,
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('旧')
    // 値を変えずに unmount
    unmount()

    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    const row = await getClientDb().cards.get(CARD_ID)
    expect(row?.title).toBe('旧')
  })

  it('#5 blur→unmount → enqueue 1 回のみ(二重 commit なし / Codex P2 回帰ガード)', async () => {
    // jsdom/RTL は blur 後に render を flush するため「render 前 unmount」の
    // same-batch race 自体は再現しにくい。本 test は、handleBlur の latestRef 同期
    // 反映が壊れて cleanup が editing=true のまま commit を呼んだ場合に二重 enqueue
    // になることを検出する回帰ガード(Codex P2: blur→same-batch unmount 二重 commit)。
    await seedCard({ title: '旧' })
    const { unmount } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
        autoEditOnMount
      />,
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新タイトル' } })
    // blur → commit #1 (handleBlur が latestRef.editing を false に同期反映)
    fireEvent.blur(input)
    // 直後に unmount → cleanup は latestRef.editing=false を見て skip → 二重 commit なし
    unmount()

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledTimes(1)
    })
    expect(mockEnqueue).toHaveBeenCalledWith({
      user_id: USER_ID,
      entity_type: 'card', entity_id: CARD_ID,
      op: 'update_field',
      patch: { field: 'title', value: '新タイトル' },
    })
  })

  it('#4 存在 gate: カード削除後に editing+dirty で unmount → outbox enqueue されない(orphan なし) / 例外なし', async () => {
    await seedCard({ title: '旧' })
    const { unmount } = render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
        autoEditOnMount
      />,
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新タイトル' } })
    // カードを削除してから unmount (remote pull-delete による削除中 unmount の代替)
    await getClientDb().cards.delete(CARD_ID)
    // 例外が飛ばないこと
    expect(() => unmount()).not.toThrow()
    // cleanup の async 存在チェック(getClientDb().cards.get)が settle するまで待つ。
    // 同等の Dexie 操作を await することで、cleanup の .then() より後に制御が戻ることを保証する。
    await getClientDb().cards.get(CARD_ID)
    // 存在 gate が commit をスキップ → outbox への orphan enqueue なし(core assertion)。
    // この assert は存在 gate を除去すると失敗する(gate 追加前は enqueue が呼ばれる)。
    expect(mockEnqueue).not.toHaveBeenCalled()
    // 行は削除済
    const row = await getClientDb().cards.get(CARD_ID)
    expect(row).toBeUndefined()
  })
})

// Sprint T T4: display 枝の MD 表 read-only 描画。golden-first(修正2)= 差し替え前に
// 表 0 個の display DOM を snapshot(旧 DOM から生成)→ 差し替え後も diff なし green で
// 不変条件①(表 0 個 = DOM 同一)を機械証明する。表入りは意図差分で snapshot 受理。
describe('Sprint T: MD 表 read-only 描画(display 枝 A)', () => {
  // 表なし。< & > を含めて escape 挙動も golden に固定。末尾改行なし(<br> 補償を混ぜない)。
  const TABLE_FREE = '問題文の 1 行目\n2 行目 < & > 記号あり'
  // 表あり(前後に本文)。
  const WITH_TABLE = 'まえがき\n\n| 成分 | 分量 |\n|---|---|\n| A | 1 |\n\nあとがき'

  it('表 0 個: display DOM は差し替え前後で不変(golden・不変条件①)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="question_text"
        initialValue={TABLE_FREE}
        ariaLabel="question 編集"
        multiline
      />,
    )
    expect(screen.getByRole('button', { name: 'question 編集' }).innerHTML).toMatchSnapshot()
  })

  it('表入り: display DOM(golden — 差し替え後に <table> へ変わる)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="question_text"
        initialValue={WITH_TABLE}
        ariaLabel="question 編集"
        multiline
      />,
    )
    expect(screen.getByRole('button', { name: 'question 編集' }).innerHTML).toMatchSnapshot()
  })

  it('表入り: display 枝に <table> が描画される(差し替え後に PASS・前は RED)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="question_text"
        initialValue={WITH_TABLE}
        ariaLabel="question 編集"
        multiline
      />,
    )
    const display = screen.getByRole('button', { name: 'question 編集' })
    expect(display.querySelector('table')).not.toBeNull()
    // 前後の本文は保持
    expect(display.textContent).toContain('まえがき')
    expect(display.textContent).toContain('あとがき')
  })

  it('表入りでも click で edit に入ると textarea に raw MD が出る(edit 枝不変)', () => {
    render(
      <InlineTextField
        cardId={CARD_ID}
        userId={USER_ID}
        field="question_text"
        initialValue={WITH_TABLE}
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(WITH_TABLE)
  })
})
