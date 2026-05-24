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
})
