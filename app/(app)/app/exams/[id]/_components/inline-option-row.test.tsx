// @vitest-environment jsdom
// 試験詳細 page の選択肢 inline 編集 (`InlineOptionList` + 内部 `InlineOptionRow`)
// の基本動作 test。 1 option につき id / text / is_correct / explanation の 4 field
// を編集できる。 テキスト系は click → input/textarea → blur で保存、 checkbox は
// onChange で即時保存。 send / debounce / queue / rollback / cross-row race の詳細は
// inline-option-row.debounce.test.tsx に局所化。 server action は mock。
//
// S2.0b-2 follow-up 修正 (cross-row checkbox race fix) で options state を per-card
// 親 `InlineOptionList` に lift up したため、 全 test は `InlineOptionList` 経由で
// render する。 単一 option を focus する test は `options=[option]` で render し、
// 単数 / 単一 textbox のクエリが当たるようにしている。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { CardOption } from '@/lib/db/schema'

vi.mock('../_actions/update-card-field', () => ({
  updateCardField: vi.fn(),
}))

import { InlineOptionList } from './inline-option-row'
import { updateCardField } from '../_actions/update-card-field'

const baseOptions: CardOption[] = [
  { id: 'a', text: '選択肢A', is_correct: true, explanation: 'A 理由' },
  { id: 'b', text: '選択肢B', is_correct: false },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(updateCardField).mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

// 単一 option を render する helper (既存 test は単一 option を focus するため)。
function renderSingle(option: CardOption) {
  return render(
    <InlineOptionList cardId="card-1" options={[option]} />,
  )
}

describe('InlineOptionRow (via InlineOptionList)', () => {
  it('初期表示: id / text / is_correct=true checked / explanation を描画', () => {
    renderSingle(baseOptions[0]!)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.getByText('A 理由', { exact: false })).toBeInTheDocument()
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  it('is_correct=false の option は checkbox unchecked', () => {
    renderSingle(baseOptions[1]!)
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
  })

  it('explanation 未設定 → placeholder 表示', () => {
    renderSingle(baseOptions[1]!)
    expect(
      screen.getByText('解説 (クリックで追加)'),
    ).toBeInTheDocument()
  })

  it('id click → input → blur で options 配列全体を該当 index のみ書換えて送る', async () => {
    render(<InlineOptionList cardId="card-1" options={baseOptions} />)
    // 1 行目 (option a) の id を編集
    const idButtons = screen.getAllByRole('button', { name: '選択肢 id 編集' })
    fireEvent.click(idButtons[0]!)
    const input = screen.getByRole('textbox', { name: '選択肢 id 編集' })
    fireEvent.change(input, { target: { value: 'A1' } })
    fireEvent.blur(input)
    // debounce 500ms 経過待ち
    await vi.waitFor(() => {
      expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
        { id: 'A1', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
        { id: 'b', text: '選択肢B', isCorrect: false },
      ])
    })
  })

  it('text click → textarea → blur で options 配列全体を送る', async () => {
    render(<InlineOptionList cardId="card-1" options={baseOptions} />)
    const textButtons = screen.getAllByRole('button', { name: '選択肢 本文 編集' })
    fireEvent.click(textButtons[0]!)
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    fireEvent.change(ta, { target: { value: '選択肢A 改' } })
    fireEvent.blur(ta)
    await vi.waitFor(() => {
      expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
        { id: 'a', text: '選択肢A 改', isCorrect: true, explanation: 'A 理由' },
        { id: 'b', text: '選択肢B', isCorrect: false },
      ])
    })
  })

  it('explanation click → textarea → blur で options 配列全体を送る', async () => {
    render(<InlineOptionList cardId="card-1" options={baseOptions} />)
    const explButtons = screen.getAllByRole('button', { name: '選択肢 解説 編集' })
    fireEvent.click(explButtons[1]!) // option b の explanation
    const ta = screen.getByRole('textbox', { name: '選択肢 解説 編集' })
    fireEvent.change(ta, { target: { value: 'B 理由' } })
    fireEvent.blur(ta)
    await vi.waitFor(() => {
      expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
        { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
        { id: 'b', text: '選択肢B', isCorrect: false, explanation: 'B 理由' },
      ])
    })
  })

  it('explanation 既存値を空文字にして blur → payload で該当 option から explanation key が drop される (review I2)', async () => {
    render(<InlineOptionList cardId="card-1" options={baseOptions} />)
    const explButtons = screen.getAllByRole('button', { name: '選択肢 解説 編集' })
    fireEvent.click(explButtons[0]!) // option a (A 理由 を空に)
    const ta = screen.getByRole('textbox', { name: '選択肢 解説 編集' })
    fireEvent.change(ta, { target: { value: '' } })
    fireEvent.blur(ta)
    await vi.waitFor(() => {
      expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
        // option a: explanation key が **存在しない** こと (空文字を渡すと server zod は
        // optional だが、 空でも key があると jsonb が肥大化するため client 側で drop)
        { id: 'a', text: '選択肢A', isCorrect: true },
        { id: 'b', text: '選択肢B', isCorrect: false },
      ])
    })
  })

  it('is_correct checkbox change で即時 updateCardField 呼出 (blur 待たず)', async () => {
    render(<InlineOptionList cardId="card-1" options={baseOptions} />)
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[1]!) // option b を ON に
    await vi.waitFor(() => {
      expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
        { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
        { id: 'b', text: '選択肢B', isCorrect: true },
      ])
    })
  })

  it('is_correct 失敗時 inline error + checkbox 状態 rollback', async () => {
    vi.mocked(updateCardField).mockResolvedValueOnce({
      ok: false,
      error: '保存に失敗しました',
    })
    renderSingle(baseOptions[1]!)
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    // 楽観的更新で一瞬 checked になるが、 失敗後 rollback
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '保存に失敗しました',
    )
    expect(checkbox.checked).toBe(false)
  })

  it('id 値変更なし + blur → server 呼ばれない', async () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 id 編集' }))
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 id 編集' }))
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('textbox', { name: '選択肢 id 編集' }),
      ).not.toBeInTheDocument()
    })
    expect(updateCardField).not.toHaveBeenCalled()
  })

  it('text 値変更なし + blur → server 呼ばれない', async () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('textbox', { name: '選択肢 本文 編集' }),
      ).not.toBeInTheDocument()
    })
    expect(updateCardField).not.toHaveBeenCalled()
  })

  it('explanation null → 空のまま blur → server 呼ばれない', async () => {
    renderSingle(baseOptions[1]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 解説 編集' }))
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 解説 編集' }))
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('textbox', { name: '選択肢 解説 編集' }),
      ).not.toBeInTheDocument()
    })
    expect(updateCardField).not.toHaveBeenCalled()
  })

  it('checkbox 送信中は該当 checkbox のみ disabled (text/explanation cell は edit 可能)', async () => {
    // S2.0b-2 T3 仕様: row 全体 disable → checkbox 単体 disable + text/explanation
    // cell は別 field なので race にならず行内同時 edit を許容 (spec §3.3 D)。
    let resolveAction!: (v: { ok: true } | { ok: false; error: string }) => void
    vi.mocked(updateCardField).mockImplementation(
      () =>
        new Promise((res) => {
          resolveAction = res
        }),
    )
    renderSingle(baseOptions[1]!)
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(checkbox)
    // 送信中: checkbox は disabled
    expect(checkbox).toBeDisabled()
    // text / explanation cell は edit 可能 (textarea が出現する)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    expect(
      screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '選択肢 解説 編集' }))
    expect(
      screen.getByRole('textbox', { name: '選択肢 解説 編集' }),
    ).toBeInTheDocument()
    resolveAction({ ok: true })
    await vi.waitFor(() => {
      expect(checkbox).not.toBeDisabled()
    })
  })

  it('id 失敗時 display で旧値 + role="alert" で error 表示 (Optimistic UI: edit mode に戻らない)', async () => {
    // S2.0b-2 T3 仕様: 失敗時 edit mode 維持 → display で旧値 rollback + error (E-1)。
    vi.mocked(updateCardField).mockResolvedValueOnce({
      ok: false,
      error: '選択肢の id は必須です',
    })
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 id 編集' }))
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 id 編集' }), {
      target: { value: '' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 id 編集' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '選択肢の id は必須です',
    )
    // edit mode には戻らず、 display で旧 id ('a') が表示される
    expect(
      screen.queryByRole('textbox', { name: '選択肢 id 編集' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('a')).toBeInTheDocument()
  })

  it('a11y: checkbox に aria-label が付与される', () => {
    renderSingle(baseOptions[0]!)
    expect(screen.getByRole('checkbox')).toHaveAttribute(
      'aria-label',
      '選択肢 正解フラグ 編集',
    )
  })

  it('構築: 該当 index の field のみ書換、 他 option は touch しない', async () => {
    const opts: CardOption[] = [
      { id: 'a', text: 'A', is_correct: false },
      { id: 'b', text: 'B', is_correct: true, explanation: 'B 理由' },
      { id: 'c', text: 'C', is_correct: false },
    ]
    render(<InlineOptionList cardId="card-1" options={opts} />)
    const textButtons = screen.getAllByRole('button', { name: '選択肢 本文 編集' })
    fireEvent.click(textButtons[1]!) // option b
    fireEvent.change(
      screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      { target: { value: 'B 改' } },
    )
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(() => {
      expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
        { id: 'a', text: 'A', isCorrect: false },
        { id: 'b', text: 'B 改', isCorrect: true, explanation: 'B 理由' },
        { id: 'c', text: 'C', isCorrect: false },
      ])
    })
  })

  // ---------------------------------------------------------------------------
  // S2.0b-2 follow-up: auto-resize + display/edit 寸法一致 regression
  // (InlineOptionCell の 3 cell 種別 [id / text / explanation] を InlineTextField
  //  と同じ auto-resize + sharedBoxChrome に揃える、 click → 編集切替時の layout
  //  jump 解消)
  // ---------------------------------------------------------------------------

  it('text cell (multiline=true): textarea に rows attribute が無い (auto-resize 委譲)', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' }) as HTMLTextAreaElement
    expect(ta.tagName).toBe('TEXTAREA')
    expect(ta.hasAttribute('rows')).toBe(false)
  })

  it('explanation cell (multiline=true): textarea に rows attribute が無い', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 解説 編集' }))
    const ta = screen.getByRole('textbox', { name: '選択肢 解説 編集' }) as HTMLTextAreaElement
    expect(ta.tagName).toBe('TEXTAREA')
    expect(ta.hasAttribute('rows')).toBe(false)
  })

  it('id cell (multiline=false): Input element で render、 useLayoutEffect は instanceof guard で no-op', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 id 編集' }))
    const inputEl = screen.getByRole('textbox', { name: '選択肢 id 編集' })
    expect(inputEl.tagName).toBe('INPUT')
    // input には auto-resize 不要なので inline style.height は assign されない
    expect((inputEl as HTMLInputElement).style.height).toBe('')
  })

  it('text / explanation textarea に resize-none + overflow-hidden が付与され、 手動 resize handle と scrollbar が抑止される', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const taText = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    expect(taText.className).toMatch(/resize-none/)
    expect(taText.className).toMatch(/overflow-hidden/)
    fireEvent.blur(taText) // text 編集 mode を抜けてから explanation を開く
    fireEvent.click(screen.getByRole('button', { name: '選択肢 解説 編集' }))
    const taExpl = screen.getByRole('textbox', { name: '選択肢 解説 編集' })
    expect(taExpl.className).toMatch(/resize-none/)
    expect(taExpl.className).toMatch(/overflow-hidden/)
  })

  it('text cell mount 時に useLayoutEffect で style.height が inline 設定される', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' }) as HTMLTextAreaElement
    // useLayoutEffect の 'auto' → scrollHeight+'px' で inline style.height が assign される
    // (jsdom では scrollHeight=0 で '0px'、 visible height は CSS min-h-11 が下限)
    expect(ta.style.height).not.toBe('')
    expect(ta.style.height).toMatch(/px$/)
  })

  it('text cell: editValue 変化で style.height が再 assign される (useLayoutEffect の [editing, editValue] dep を lock)', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' }) as HTMLTextAreaElement
    // mount 時 height を意図的に clear して、 change で再 assign されることを必須化
    // (dep array から editValue を抜くと再 assign されない = 必ず fail する形)
    ta.style.height = ''
    expect(ta.style.height).toBe('')
    fireEvent.change(ta, { target: { value: '長い\n複数行\nテキスト' } })
    expect(ta.style.height).not.toBe('')
    expect(ta.style.height).toMatch(/px$/)
  })

  it('explanation cell: editValue 変化で style.height が再 assign される', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 解説 編集' }))
    const ta = screen.getByRole('textbox', { name: '選択肢 解説 編集' }) as HTMLTextAreaElement
    ta.style.height = ''
    expect(ta.style.height).toBe('')
    fireEvent.change(ta, { target: { value: 'a\nb\nc\nd' } })
    expect(ta.style.height).not.toBe('')
    expect(ta.style.height).toMatch(/px$/)
  })

  it('display / edit 共通: 3 cell 種別とも sharedBoxChrome (min-h-11 + p-2 + rounded-md) を持つ、 display は border-transparent 予約付き', () => {
    renderSingle(baseOptions[0]!)
    // id cell
    const idBtn = screen.getByRole('button', { name: '選択肢 id 編集' })
    expect(idBtn.className).toMatch(/min-h-11/)
    expect(idBtn.className).toMatch(/\bp-2\b/)
    expect(idBtn.className).toMatch(/rounded-md/)
    expect(idBtn.className).toMatch(/border-transparent/)
    fireEvent.click(idBtn)
    const idInput = screen.getByRole('textbox', { name: '選択肢 id 編集' })
    expect(idInput.className).toMatch(/min-h-11/)
    expect(idInput.className).toMatch(/\bp-2\b/)
    expect(idInput.className).toMatch(/rounded-md/)
    fireEvent.blur(idInput)

    // text cell
    const textBtn = screen.getByRole('button', { name: '選択肢 本文 編集' })
    expect(textBtn.className).toMatch(/min-h-11/)
    expect(textBtn.className).toMatch(/\bp-2\b/)
    expect(textBtn.className).toMatch(/rounded-md/)
    expect(textBtn.className).toMatch(/border-transparent/)
    fireEvent.click(textBtn)
    const textTa = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    expect(textTa.className).toMatch(/min-h-11/)
    expect(textTa.className).toMatch(/\bp-2\b/)
    expect(textTa.className).toMatch(/rounded-md/)
    fireEvent.blur(textTa)

    // explanation cell
    const explBtn = screen.getByRole('button', { name: '選択肢 解説 編集' })
    expect(explBtn.className).toMatch(/min-h-11/)
    expect(explBtn.className).toMatch(/\bp-2\b/)
    expect(explBtn.className).toMatch(/rounded-md/)
    expect(explBtn.className).toMatch(/border-transparent/)
    fireEvent.click(explBtn)
    const explTa = screen.getByRole('textbox', { name: '選択肢 解説 編集' })
    expect(explTa.className).toMatch(/min-h-11/)
    expect(explTa.className).toMatch(/\bp-2\b/)
    expect(explTa.className).toMatch(/rounded-md/)
  })

  it('displayClassName が両モードに伝搬する (text cell の is_correct=true は emerald 色クラスが両モードに当たる)', () => {
    // is_correct=true option を render すると、 text cell の displayClassName は
    // `text-sm font-bold text-emerald-900` (inline-option-row.tsx 内 display 切替)。
    renderSingle(baseOptions[0]!) // a: is_correct=true
    const textBtn = screen.getByRole('button', { name: '選択肢 本文 編集' })
    expect(textBtn.className).toMatch(/text-sm/)
    expect(textBtn.className).toMatch(/font-bold/)
    expect(textBtn.className).toMatch(/text-emerald-900/)
    fireEvent.click(textBtn)
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    expect(ta.className).toMatch(/text-sm/)
    expect(ta.className).toMatch(/font-bold/)
    expect(ta.className).toMatch(/text-emerald-900/)
  })

  it('id cell displayClassName (font-mono) も両モードに伝搬', () => {
    renderSingle(baseOptions[0]!)
    const idBtn = screen.getByRole('button', { name: '選択肢 id 編集' })
    expect(idBtn.className).toMatch(/font-mono/)
    expect(idBtn.className).toMatch(/text-slate-700/)
    fireEvent.click(idBtn)
    const idInput = screen.getByRole('textbox', { name: '選択肢 id 編集' })
    expect(idInput.className).toMatch(/font-mono/)
    expect(idInput.className).toMatch(/text-slate-700/)
  })
})
