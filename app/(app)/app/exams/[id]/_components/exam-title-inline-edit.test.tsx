// @vitest-environment jsdom
// ExamTitleInlineEdit の test (Grid-3 §6.2)。
// - 表示 (h1 + className) / click → input / Enter・blur commit / Escape cancel /
//   失敗時 inline error / commit 中 disabled / 成功時の router.refresh + runGuardedPull。
// - race guard を 2 本 pin する:
//   ① Enter → blur の二重発火でも renameExam は 1 回だけ
//   ② trim 後の値が未変更なら renameExam を呼ばない (no-op)
// - renameExam (server action) / runGuardedPull / useRouter は spy mock。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react'

const { mockRenameExam, mockRunGuardedPull, mockRouterRefresh } = vi.hoisted(
  () => ({
    mockRenameExam: vi.fn(),
    mockRunGuardedPull: vi.fn().mockResolvedValue('ran'),
    mockRouterRefresh: vi.fn(),
  }),
)

vi.mock('@/app/(app)/app/exams/_actions/rename-exam', () => ({
  renameExam: mockRenameExam,
}))

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}))

import { ExamTitleInlineEdit } from './exam-title-inline-edit'

const EXAM_ID = 'exam-1'

function renderTitle(name = '基本情報試験') {
  return render(
    <ExamTitleInlineEdit examId={EXAM_ID} examName={name} variant="card" />,
  )
}

// 表示中の title を click して edit mode に入り、 input を返す。
function openEditor(name = '基本情報試験'): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name }))
  return screen.getByRole('textbox', { name: '試験名 編集' }) as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRenameExam.mockResolvedValue({ ok: true })
  mockRunGuardedPull.mockResolvedValue('ran')
})

afterEach(() => {
  cleanup()
})

describe('ExamTitleInlineEdit — 表示', () => {
  it('variant=card: h1 heading として試験名を描画 (置換前の text-2xl font-bold)', () => {
    renderTitle()
    const heading = screen.getByRole('heading', { name: '基本情報試験' })
    expect(heading.tagName).toBe('H1')
    expect(heading.className).toContain('text-2xl')
    expect(heading.className).toContain('font-bold')
    // 初期状態では input は無い
    expect(
      screen.queryByRole('textbox', { name: '試験名 編集' }),
    ).not.toBeInTheDocument()
  })

  it('variant=card は truncate しない (長い試験名は従来どおり折り返す)', () => {
    render(
      <ExamTitleInlineEdit
        examId={EXAM_ID}
        examName={'長い試験名'.repeat(20)}
        variant="card"
      />,
    )
    const heading = screen.getByRole('heading')
    expect(heading.className).not.toContain('truncate')
    // clip の実体は click target 側の class ゆえそちらも見る
    expect(heading.querySelector('button')?.className).not.toContain('truncate')
  })

  it('variant=compact は truncate する (置換前の truncate text-base font-bold)', () => {
    render(
      <ExamTitleInlineEdit
        examId={EXAM_ID}
        examName="基本情報試験"
        variant="compact"
      />,
    )
    const heading = screen.getByRole('heading', { name: '基本情報試験' })
    expect(heading.className).toContain('truncate')
    expect(heading.className).toContain('text-base')
    expect(heading.className).toContain('font-bold')
    expect(heading.querySelector('button')?.className).toContain('truncate')
  })

  it('title 属性は試験名そのもの (truncate 時に hover で全文が読める)', () => {
    renderTitle()
    const trigger = screen.getByRole('button', { name: '基本情報試験' })
    expect(trigger).toHaveAttribute('title', '基本情報試験')
    // 操作説明は accessible name を上書きしない形 (aria-describedby) で供給する
    const describedBy = trigger.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      '編集',
    )
  })

  it('click → input 化し、 現在名が初期値になる。 編集中も h1 は残る', () => {
    renderTitle()
    const input = openEditor()
    expect(input.value).toBe('基本情報試験')
    // 編集中に heading が消えない (card view ではページ唯一の h1)
    const heading = screen.getByRole('heading')
    expect(heading.tagName).toBe('H1')
    expect(heading.contains(input)).toBe(true)
  })
})

describe('ExamTitleInlineEdit — commit', () => {
  it('Enter → renameExam(examId, trim 済 name) + router.refresh + runGuardedPull(exam-rename)', async () => {
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '  応用情報試験  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mockRenameExam).toHaveBeenCalledWith(EXAM_ID, '応用情報試験')
    })
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1)
    })
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'exam-rename' })

    // 表示は commit 成功値 (trim 済) に更新される (prop は未更新のまま)
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '応用情報試験' }),
      ).toBeInTheDocument()
    })
  })

  it('blur → commit される', async () => {
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '応用情報試験' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockRenameExam).toHaveBeenCalledWith(EXAM_ID, '応用情報試験')
    })
  })

  it('commit 中は input が disabled', async () => {
    let resolveRename: (v: { ok: true }) => void = () => {}
    mockRenameExam.mockReturnValueOnce(
      new Promise<{ ok: true }>((resolve) => {
        resolveRename = resolve
      }),
    )
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '応用情報試験' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: '試験名 編集' }),
      ).toBeDisabled()
    })

    resolveRename({ ok: true })
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '応用情報試験' }),
      ).toBeInTheDocument()
    })
  })
})

describe('ExamTitleInlineEdit — race guard', () => {
  it('Enter → blur の二重発火でも renameExam は 1 回だけ (commit 中 flag)', async () => {
    // 未解決 promise で commit を in-flight のまま保持し、 その間に blur を撃つ。
    let resolveRename: (v: { ok: true }) => void = () => {}
    mockRenameExam.mockReturnValueOnce(
      new Promise<{ ok: true }>((resolve) => {
        resolveRename = resolve
      }),
    )
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '応用情報試験' } })

    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    resolveRename({ ok: true })
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '応用情報試験' }),
      ).toBeInTheDocument()
    })

    expect(mockRenameExam).toHaveBeenCalledTimes(1)
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
  })

  // probe P1: I-1 が塞いだ「render commit 前の窓」を直接 pin する。
  // action 解決後に **act() を挟まず microtask だけ drain** すると、 React 19 は default
  // lane の render を MessageChannel task に載せるため setEditing(false) はまだ反映されず、
  // input は前 render の commit closure (旧 displayName) を抱えたまま mount されている。
  // = 実ブラウザで user input event が届きうる窓そのもの。
  // 成功 path で committingRef を解放すると、 この blur が guard ①②③ を全部通り抜けて
  // 2 回目の renameExam / router.refresh を撃つ。
  it('probe P1: 成功 render が commit される前の窓に blur が来ても再送しない', async () => {
    let resolveRename: (v: { ok: true }) => void = () => {}
    mockRenameExam.mockReturnValueOnce(
      new Promise<{ ok: true }>((resolve) => {
        resolveRename = resolve
      }),
    )
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '応用情報試験' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // act() を挟まない: commit() の継続 (setEditing(false) 等) は走るが React の
    // re-render は commit されない。
    resolveRename({ ok: true })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // 窓が実在することの確認 (ここが false なら probe は vacuous)
    expect(input).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: '試験名 編集' }),
    ).toBe(input)

    fireEvent.blur(input)

    expect(mockRenameExam).toHaveBeenCalledTimes(1)
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
  })

  // probe P2: guard ① の解放点 (startEdit) が失われると
  // 「一度改名に成功したらそのページ session 中は二度と改名できない」 silent failure になる。
  it('probe P2: 改名成功後に再度改名できる (startEdit が in-flight guard を解放する)', async () => {
    renderTitle()
    fireEvent.change(openEditor(), { target: { value: '応用情報試験' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: '試験名 編集' }), {
      key: 'Enter',
    })
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '応用情報試験' }),
      ).toBeInTheDocument()
    })
    expect(mockRenameExam).toHaveBeenCalledTimes(1)

    // 2 回目の改名 (値を変えて commit)
    fireEvent.change(openEditor('応用情報試験'), {
      target: { value: '高度試験' },
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: '試験名 編集' }), {
      key: 'Enter',
    })

    await waitFor(() => {
      expect(mockRenameExam).toHaveBeenCalledTimes(2)
    })
    expect(mockRenameExam).toHaveBeenLastCalledWith(EXAM_ID, '高度試験')
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '高度試験' }),
      ).toBeInTheDocument()
    })
  })

  it('commit 成功後に再度開いて blur → commit 値が新しい基準なので no-op', async () => {
    // 「表示は commit 成功値 (trim 済)」が displayName にも反映されている証拠:
    // 再編集して何もせず blur すると未変更扱いになり action が再送されない。
    renderTitle()
    fireEvent.change(openEditor(), { target: { value: '  応用情報試験  ' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: '試験名 編集' }), {
      key: 'Enter',
    })

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '応用情報試験' }),
      ).toBeInTheDocument()
    })
    expect(mockRenameExam).toHaveBeenCalledTimes(1)

    // 再度 click → 何も変えずに blur
    fireEvent.blur(openEditor('応用情報試験'))
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '応用情報試験' }),
      ).toBeInTheDocument()
    })
    expect(mockRenameExam).toHaveBeenCalledTimes(1)
  })

  it('未変更のまま blur → renameExam を呼ばず表示に戻る (no-op)', async () => {
    renderTitle()
    const input = openEditor()
    fireEvent.blur(input)

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '基本情報試験' }),
      ).toBeInTheDocument()
    })
    expect(mockRenameExam).not.toHaveBeenCalled()
    expect(mockRouterRefresh).not.toHaveBeenCalled()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
  })

  it('前後 空白だけ足して Enter → trim 後が同値なので no-op', async () => {
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '  基本情報試験  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '基本情報試験' }),
      ).toBeInTheDocument()
    })
    expect(mockRenameExam).not.toHaveBeenCalled()
  })
})

describe('ExamTitleInlineEdit — cancel / error', () => {
  it('Escape → 編集を破棄し renameExam を呼ばない', async () => {
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '別の名前' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '基本情報試験' }),
      ).toBeInTheDocument()
    })
    expect(mockRenameExam).not.toHaveBeenCalled()
  })

  it('失敗 → role="alert" に error を inline 表示し編集モードを継続、 表示名は元のまま', async () => {
    mockRenameExam.mockResolvedValueOnce({
      ok: false,
      error: '試験が見つかりませんでした。画面を再読み込みしてください。',
    })
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '応用情報試験' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      '試験が見つかりませんでした。画面を再読み込みしてください。',
    )
    // 編集モード継続 (input が残る) + 成功副作用は起きない
    expect(
      screen.getByRole('textbox', { name: '試験名 編集' }),
    ).toBeInTheDocument()
    expect(mockRouterRefresh).not.toHaveBeenCalled()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    // error は aria-describedby で input に結ばれる (create-exam-form.tsx と同型)
    const editing = screen.getByRole('textbox', { name: '試験名 編集' })
    expect(editing).toHaveAttribute('aria-describedby', alert.id)
    expect(editing).toHaveAttribute('aria-invalid', 'true')

    // 表示名は commit されていない: Escape で編集を捨てると元の名前に戻る
    fireEvent.keyDown(editing, { key: 'Escape' })
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '基本情報試験' }),
      ).toBeInTheDocument()
    })
  })

  it('action が reject → unhandled にせず inline error に落とし、 入力を保持して編集継続', async () => {
    mockRenameExam.mockRejectedValueOnce(new Error('offline'))
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '応用情報試験' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      '試験名の変更に失敗しました。しばらくしてから再度お試しください。',
    )
    // 編集モード継続 + 入力テキスト保持 (打ち直しさせない)
    const editing = screen.getByRole('textbox', {
      name: '試験名 編集',
    }) as HTMLInputElement
    expect(editing.value).toBe('応用情報試験')
    expect(editing).not.toBeDisabled()
    // 成功副作用は起きない
    expect(mockRouterRefresh).not.toHaveBeenCalled()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    // 表示名は commit されていない (Escape で元の名前に戻る)
    fireEvent.keyDown(editing, { key: 'Escape' })
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '基本情報試験' }),
      ).toBeInTheDocument()
    })
  })

  it('失敗後に同じ値で blur しても再送しない (恒久失敗の往復抑止)', async () => {
    mockRenameExam.mockResolvedValueOnce({ ok: false, error: '試験名は必須です' })
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '応用情報試験' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByRole('alert')
    expect(mockRenameExam).toHaveBeenCalledTimes(1)

    // 値を変えずに blur → 2 回目は送らない (error は出したまま)
    fireEvent.blur(screen.getByRole('textbox', { name: '試験名 編集' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(mockRenameExam).toHaveBeenCalledTimes(1)

    // 値を変えれば送れる (抑止が恒久化していないこと)
    fireEvent.change(screen.getByRole('textbox', { name: '試験名 編集' }), {
      target: { value: '応用情報試験2' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '試験名 編集' }))
    await waitFor(() => {
      expect(mockRenameExam).toHaveBeenCalledTimes(2)
    })
    expect(mockRenameExam).toHaveBeenLastCalledWith(EXAM_ID, '応用情報試験2')
  })

  it('失敗して編集モードに留まったら input に focus が戻る (disabled で外れた focus の復帰)', async () => {
    let resolveRename: (v: { ok: false; error: string }) => void = () => {}
    mockRenameExam.mockReturnValueOnce(
      new Promise<{ ok: false; error: string }>((resolve) => {
        resolveRename = resolve
      }),
    )
    // 実ブラウザは disabled 化で focus を外す。 jsdom の blur() は disabled 要素で
    // no-op なので、 focus 移動先の要素を同居させて明示的に focus を奪う。
    render(
      <>
        <ExamTitleInlineEdit
          examId={EXAM_ID}
          examName="基本情報試験"
          variant="card"
        />
        <button data-testid="elsewhere" />
      </>,
    )
    const input = openEditor()
    fireEvent.change(input, { target: { value: '応用情報試験' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: '試験名 編集' })).toBeDisabled()
    })
    screen.getByTestId('elsewhere').focus()
    expect(document.activeElement).not.toBe(
      screen.getByRole('textbox', { name: '試験名 編集' }),
    )

    resolveRename({ ok: false, error: '試験名は必須です' })
    await screen.findByRole('alert')
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: '試験名 編集' }),
      )
    })
  })

  it('入力を変えると error は消える', async () => {
    mockRenameExam.mockResolvedValueOnce({ ok: false, error: '試験名は必須です' })
    renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '応用情報試験' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByRole('alert')

    fireEvent.change(
      screen.getByRole('textbox', { name: '試験名 編集' }),
      { target: { value: '応用情報試験2' } },
    )
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})

describe('ExamTitleInlineEdit — prop 同期', () => {
  it('非編集中に examName prop が変わったら表示が追従する', () => {
    const { rerender } = renderTitle()
    expect(
      screen.getByRole('heading', { name: '基本情報試験' }),
    ).toBeInTheDocument()

    rerender(
      <ExamTitleInlineEdit
        examId={EXAM_ID}
        examName="他端末で改名された名前"
        variant="card"
      />,
    )
    expect(
      screen.getByRole('heading', { name: '他端末で改名された名前' }),
    ).toBeInTheDocument()
  })

  it('編集中は examName prop の変化で入力値を上書きしない', () => {
    const { rerender } = renderTitle()
    const input = openEditor()
    fireEvent.change(input, { target: { value: '入力途中' } })

    rerender(
      <ExamTitleInlineEdit
        examId={EXAM_ID}
        examName="他端末で改名された名前"
        variant="card"
      />,
    )
    expect(
      (screen.getByRole('textbox', { name: '試験名 編集' }) as HTMLInputElement)
        .value,
    ).toBe('入力途中')
  })
})
