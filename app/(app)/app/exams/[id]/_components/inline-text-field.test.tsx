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

})
