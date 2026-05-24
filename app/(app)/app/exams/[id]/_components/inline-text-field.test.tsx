// @vitest-environment jsdom
// InlineTextField client component の test。 試験詳細 page (/app/exams/[id]) の
// inline 編集 cell。 click で edit、 blur で server action 呼出、 値変更なしは
// server 呼ばず display 復帰、 失敗時は edit 維持 + error 表示。
//
// server action は mock (update-card-field)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../_actions/update-card-field', () => ({
  updateCardField: vi.fn(),
}))

import { InlineTextField } from './inline-text-field'
import { updateCardField } from '../_actions/update-card-field'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(updateCardField).mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('InlineTextField (single-line)', () => {
  it('display モード: initialValue を rendering', () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="問題タイトル"
        ariaLabel="title 編集"
      />,
    )
    expect(screen.getByText('問題タイトル')).toBeInTheDocument()
    // 初期は input ではなく display 要素
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('null initialValue: placeholder を表示', () => {
    render(
      <InlineTextField
        cardId="card-1"
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
        cardId="card-1"
        field="title"
        initialValue="問題タイトル"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input).toHaveValue('問題タイトル')
    // jsdom auto-focus check
    expect(document.activeElement).toBe(input)
  })

  it('値変更 + blur → updateCardField が field + 新値で呼ばれる', async () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '新タイトル' } })
    fireEvent.blur(input)
    await vi.waitFor(() => {
      expect(updateCardField).toHaveBeenCalledWith(
        'card-1',
        'title',
        '新タイトル',
      )
    })
  })

  it('値変更 + blur 成功 → display mode 復帰、 新値で render', async () => {
    render(
      <InlineTextField
        cardId="card-1"
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
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })
    expect(screen.getByText('新タイトル')).toBeInTheDocument()
  })

  it('値変更 + blur 失敗 → display mode で旧値 + role="alert" で error 表示 (rollback)', async () => {
    vi.mocked(updateCardField).mockResolvedValue({
      ok: false,
      error: 'タイトルは必須です',
    })
    render(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '' },
    })
    fireEvent.blur(screen.getByRole('textbox'))
    // Optimistic UI: blur 直後は display + 楽観値 (= '')、 server 解決後に
    // 旧値 '旧' に rollback + error 表示
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'タイトルは必須です',
    )
    // display mode (edit には戻らない)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    // 旧値が表示されている
    expect(screen.getByText('旧')).toBeInTheDocument()
  })

  it('値変更なし + blur → server 呼ばれない、 display mode 復帰', async () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    // 何も変更せず blur
    fireEvent.blur(screen.getByRole('textbox'))
    await vi.waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })
    expect(updateCardField).not.toHaveBeenCalled()
  })

  it('null initial: edit mode で空 input、 同じく空のまま blur → server 呼ばれない', async () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="memo"
        initialValue={null}
        ariaLabel="memo 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'memo 編集' }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea).toHaveValue('')
    fireEvent.blur(textarea)
    await vi.waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })
    expect(updateCardField).not.toHaveBeenCalled()
  })

  it('null initial → 値入力 + blur → server に新値で呼出', async () => {
    render(
      <InlineTextField
        cardId="card-1"
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
      expect(updateCardField).toHaveBeenCalledWith('card-1', 'memo', '初メモ')
    })
  })

  it('multiline=false: input を render', () => {
    render(
      <InlineTextField
        cardId="card-1"
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
        cardId="card-1"
        field="question_text"
        initialValue="q"
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA')
  })

  it('edit mode 中 aria-label が input/textarea に付与される', () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="t"
        ariaLabel="title 編集"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'aria-label',
      'title 編集',
    )
  })

  it('display mode の button が tap target を確保 (min-h クラス)', () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="t"
        ariaLabel="title 編集"
      />,
    )
    const btn = screen.getByRole('button', { name: 'title 編集' })
    // tap target 44px 目安 (min-h-11 = 44px Tailwind)
    expect(btn.className).toMatch(/min-h-11/)
  })

  // ---------------------------------------------------------------------------
  // S2.0b-2 follow-up: auto-resize + display/edit 寸法一致 regression
  // (textarea の rows 固定値撤回、 useLayoutEffect で scrollHeight に追従、
  //  display と edit で box 寸法 [p-2 / rounded-md / min-h-11 / 1px border] 一致)
  // ---------------------------------------------------------------------------

  it('multiline=true: textarea に rows attribute が無い (rows 固定値を使わない仕様)', () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="question_text"
        initialValue="q"
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    // rows={4} 等の固定 attribute は **設定しない** こと (auto-resize 担当に委譲)
    expect(ta.hasAttribute('rows')).toBe(false)
  })

  it('multiline=true: textarea に resize-none + overflow-hidden が付き、 手動 resize ハンドルと scrollbar が抑止される', () => {
    render(
      <InlineTextField
        cardId="card-1"
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

  it('multiline=true: textarea mount 時に useLayoutEffect で style.height が auto → scrollHeight 経由で inline 設定される (jsdom では scrollHeight=0 で min-h-11 が下限)', () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="question_text"
        initialValue="複数行\nテキスト"
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    // useLayoutEffect が走った証拠: style.height が inline 設定されている
    // (jsdom の scrollHeight は 0 で 'auto' → '0px' に設定されるが、 CSS min-h-11 が
    //  下限として効くため visible height は 44px 以上が保証される)
    expect(ta.style.height).not.toBe('')
  })

  it('multiline=true: 入力 (value 変化) で style.height が再計算される (useLayoutEffect が [editing, value] に追従)', () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="question_text"
        initialValue="短い"
        ariaLabel="question 編集"
        multiline
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'question 編集' }))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    // mount 時に assign された inline height を意図的に clear して、 value 変化に
    // 連動した useLayoutEffect 再実行で再 assign されることを確実に検出できるよう
    // にする。 これにより本 test は dep array から `value` を抜いた regression を
    // 確実に fail させる (jsdom scrollHeight=0 でも空文字 → '0px' への再 assign は
    // 区別可能、 review Minor #1 fix)。
    ta.style.height = ''
    expect(ta.style.height).toBe('')

    // 改行を含む長い文字列に変更 → useLayoutEffect 再 run で height 再 assign
    fireEvent.change(ta, {
      target: { value: '長い\n複数行\nテキスト\n四行目\n五行目' },
    })

    // 再 assign 後は inline height が再び設定されている (jsdom 上では '0px' だが、
    // 空文字でないことが「useLayoutEffect が走った」 ことの唯一の証跡)。
    expect(ta.style.height).not.toBe('')
    // 形式の sanity check (px 単位)
    expect(ta.style.height).toMatch(/px$/)
  })

  it('display / edit 共通: box 寸法を揃える chrome (min-h-11 + p-2 + rounded-md) が両モードに付与される', () => {
    render(
      <InlineTextField
        cardId="card-1"
        field="question_text"
        initialValue="q"
        ariaLabel="question 編集"
        multiline
      />,
    )
    // display
    const btn = screen.getByRole('button', { name: 'question 編集' })
    expect(btn.className).toMatch(/min-h-11/)
    expect(btn.className).toMatch(/\bp-2\b/)
    expect(btn.className).toMatch(/rounded-md/)
    // display は textarea の 1px border 分を border-transparent で予約
    expect(btn.className).toMatch(/border-transparent/)

    // edit
    fireEvent.click(btn)
    const ta = screen.getByRole('textbox')
    expect(ta.className).toMatch(/min-h-11/)
    expect(ta.className).toMatch(/\bp-2\b/)
    expect(ta.className).toMatch(/rounded-md/)
  })

  it('display / edit 共通: displayClassName が両モードに伝搬する (font / 色を揃えるため)', () => {
    render(
      <InlineTextField
        cardId="card-1"
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
