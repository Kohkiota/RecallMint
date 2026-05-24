// @vitest-environment jsdom
// InlineTextField の Optimistic UI + debounce + queue 仕様 (spec §3.2 / §5.1) を
// fake timer で検証する。 既存 inline-text-field.test.tsx は real timer 維持の
// 基本動作担当、 本 file は debounce / queue / rollback 専用 (G-1 boilerplate 局所化)。

import { StrictMode } from 'react'
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from '@testing-library/react'

vi.mock('../_actions/update-card-field', () => ({
  updateCardField: vi.fn(),
}))

import { InlineTextField } from './inline-text-field'
import { updateCardField } from '../_actions/update-card-field'

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(updateCardField).mockReset()
  vi.mocked(updateCardField).mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// fake timer 中の Promise / microtask を消化する helper。
// vi.waitFor は timer も await できるが、 fake timer 下では advance を自分で
// 進める必要があるため、 (advance + flush) を組み合わせて使う。
async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

function renderField(initialValue: string | null = '旧') {
  return render(
    <InlineTextField
      cardId="card-1"
      field="title"
      initialValue={initialValue}
      ariaLabel="title 編集"
    />,
  )
}

function enterEditAndChange(newValue: string) {
  fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
  const input = screen.getByRole('textbox') as HTMLInputElement
  fireEvent.change(input, { target: { value: newValue } })
  return input
}

describe('InlineTextField debounce / queue / optimistic', () => {
  it('blur → 500ms 経過前は updateCardField 呼ばれない', async () => {
    renderField('旧')
    const input = enterEditAndChange('新')
    fireEvent.blur(input)

    // 499ms 経過: まだ呼ばれない
    await act(async () => {
      vi.advanceTimersByTime(499)
    })
    expect(updateCardField).not.toHaveBeenCalled()
  })

  it('blur → 500ms 経過で updateCardField 呼ばれる', async () => {
    renderField('旧')
    const input = enterEditAndChange('新')
    fireEvent.blur(input)

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(updateCardField).toHaveBeenCalledWith('card-1', 'title', '新')
  })

  it('blur → 300ms → 再 blur → 合計 800ms で 1 回のみ呼ばれる (最後の値、 debounce reset)', async () => {
    renderField('旧')
    const input = enterEditAndChange('途中')
    fireEvent.blur(input)

    // 300ms 経過後に再度編集して blur (= reset trigger)
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    // display 即時反映で input は消えているはず、 再 click で edit に入る
    const input2 = enterEditAndChange('最終')
    fireEvent.blur(input2)

    // 元 blur から 800ms (= 2 回目 blur から 500ms) で送信される
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(updateCardField).toHaveBeenCalledWith('card-1', 'title', '最終')
  })

  it('send inFlight 中に blur → 元 send 完了後に 2 回目 send が呼ばれる (queue)', async () => {
    // 1 回目は手動 resolve、 2 回目は即時 ok を返す
    let resolveFirst!: (v: { ok: true } | { ok: false; error: string }) => void
    vi.mocked(updateCardField)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res
          }),
      )
      .mockResolvedValueOnce({ ok: true })

    renderField('旧')
    const input1 = enterEditAndChange('一回目')
    fireEvent.blur(input1)

    // debounce 500ms 経過 → 1 回目 send 開始 (inFlight=true)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(updateCardField).toHaveBeenNthCalledWith(1, 'card-1', 'title', '一回目')

    // inFlight 中に 2 回目 blur (= queue 入り)
    const input2 = enterEditAndChange('二回目')
    fireEvent.blur(input2)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // queue 入りなので、 1 回目完了前は 2 回目はまだ呼ばれない
    expect(updateCardField).toHaveBeenCalledTimes(1)

    // 1 回目完了 → queue 消化で 2 回目発火
    await act(async () => {
      resolveFirst({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()

    expect(updateCardField).toHaveBeenCalledTimes(2)
    expect(updateCardField).toHaveBeenNthCalledWith(2, 'card-1', 'title', '二回目')
  })

  it('blur 直後 (server 解決前) に display = 新値、 input は消える (Optimistic UI)', async () => {
    // 解決しない promise で server 未解決状態をシミュレート
    vi.mocked(updateCardField).mockImplementation(() => new Promise(() => {}))

    renderField('旧')
    const input = enterEditAndChange('楽観値')
    fireEvent.blur(input)

    // blur 直後: input が消え、 display に新値が出ている (server 未解決でも)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('楽観値')).toBeInTheDocument()
    // server は debounce 中なのでまだ呼ばれていない
    expect(updateCardField).not.toHaveBeenCalled()
  })

  it('失敗時 display = 旧値 (rollback)、 edit mode に入らない + error 表示', async () => {
    vi.mocked(updateCardField).mockResolvedValueOnce({
      ok: false,
      error: 'タイトルは必須です',
    })

    renderField('旧')
    const input = enterEditAndChange('新')
    fireEvent.blur(input)

    // 楽観反映: display は新値
    expect(screen.getByText('新')).toBeInTheDocument()

    // debounce 経過 → send → 失敗 → rollback
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // display は旧値に戻り、 edit mode には入らない
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('旧')).toBeInTheDocument()
    // error が表示される
    expect(screen.getByRole('alert')).toHaveTextContent('タイトルは必須です')
  })

  it('Strict Mode 下でも 失敗 → rollback + error が表示される (Critical #1 regression: mountedRef 二重 effect 対応)', async () => {
    vi.mocked(updateCardField).mockResolvedValueOnce({
      ok: false,
      error: 'fail',
    })

    render(
      <StrictMode>
        <InlineTextField
          cardId="card-1"
          field="title"
          initialValue="旧"
          ariaLabel="title 編集"
        />
      </StrictMode>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新' } })
    fireEvent.blur(input)

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // StrictMode の setup → cleanup → setup で mountedRef が false 固定化していると
    // rollback 自体 skip されて display は楽観値 '新' のままになる。 reset 修正が
    // 効いていれば '旧' に rollback + error 表示される。
    expect(screen.getByText('旧')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('fail')
  })

  it('in-flight send 中に serverCommitted 値へ revert blur → 完走後に最新 revert 値で再送信 (Critical #2 regression)', async () => {
    let resolveFirst!: (v: { ok: true } | { ok: false; error: string }) => void
    let resolveSecond!: (v: { ok: true } | { ok: false; error: string }) => void
    vi.mocked(updateCardField)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveSecond = res
          }),
      )

    renderField('A')

    // 1. "B" 入力 → blur → 500ms → send("B") inflight
    const input1 = enterEditAndChange('B')
    fireEvent.blur(input1)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(updateCardField).toHaveBeenNthCalledWith(1, 'card-1', 'title', 'B')

    // 2. inflight 中に "A" (= 元 serverCommitted 値) へ revert + blur
    //    旧実装は short-circuit で何も queue せず、 send("B") 完走後 server="B" /
    //    display="A" の不整合。 修正後は queue に "A" が入り、 完走後に再送信される。
    const input2 = enterEditAndChange('A')
    fireEvent.blur(input2)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // queue 中なのでまだ 2 回目は呼ばれていない
    expect(updateCardField).toHaveBeenCalledTimes(1)

    // 3. 1 回目 (= "B") 解決 → queue 消化で 2 回目 send が呼ばれる
    await act(async () => {
      resolveFirst({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()

    expect(updateCardField).toHaveBeenCalledTimes(2)
    expect(updateCardField).toHaveBeenNthCalledWith(2, 'card-1', 'title', 'A')

    // 4. 2 回目 解決 → display は最新意図 "A" のまま
    await act(async () => {
      resolveSecond({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()
    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('editing 中に親から initialValue が変わっても committedValue / value は触らない (Important #4 guard)', () => {
    const { rerender } = render(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="旧"
        ariaLabel="title 編集"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '途中' } })

    // 親から外部更新が来ても editing 中なので保護される
    rerender(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="親更新"
        ariaLabel="title 編集"
      />,
    )

    const input2 = screen.getByRole('textbox') as HTMLInputElement
    expect(input2.value).toBe('途中')
  })

  it('inFlight 中に親から initialValue が変わっても committedValue は触らない (Important #4 guard)', async () => {
    // 解決しない promise で inflight 状態保持
    let resolveFirst!: (v: { ok: true } | { ok: false; error: string }) => void
    vi.mocked(updateCardField).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFirst = res
        }),
    )

    const { rerender } = render(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="A"
        ariaLabel="title 編集"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'title 編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'B' } })
    fireEvent.blur(input)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    // inflight 中
    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(screen.getByText('B')).toBeInTheDocument()

    // 親から initialValue="X" 外部更新が来ても inFlightRef=true なので保護
    rerender(
      <InlineTextField
        cardId="card-1"
        field="title"
        initialValue="X"
        ariaLabel="title 編集"
      />,
    )
    expect(screen.getByText('B')).toBeInTheDocument()

    // send 完走 → display は committedValue ("B") 維持
    await act(async () => {
      resolveFirst({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()
    expect(screen.getByText('B')).toBeInTheDocument()
  })

  it('失敗後の次 blur で error が消えて新 send が走る', async () => {
    vi.mocked(updateCardField)
      .mockResolvedValueOnce({ ok: false, error: 'タイトルは必須です' })
      .mockResolvedValueOnce({ ok: true })

    renderField('旧')
    const input1 = enterEditAndChange('失敗値')
    fireEvent.blur(input1)

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // 失敗後の error
    expect(screen.getByRole('alert')).toHaveTextContent('タイトルは必須です')

    // 次 blur: error クリア + 新 send
    const input2 = enterEditAndChange('成功値')
    fireEvent.blur(input2)

    // blur 直後で error は消えているはず (Optimistic clearing)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    expect(updateCardField).toHaveBeenCalledTimes(2)
    expect(updateCardField).toHaveBeenNthCalledWith(2, 'card-1', 'title', '成功値')
    // 成功後も alert なし (rollback されない)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
