// @vitest-environment jsdom
// InlineOptionRow の Optimistic UI + debounce + row 共有 1 並列 + checkbox 個別
// inFlight 仕様 (spec §3.3 / §3.5 / §5.1) を fake timer で検証する。 既存
// inline-option-row.test.tsx は real timer 維持の基本動作担当、 本 file は
// debounce / queue / rollback / checkbox 個別 disable / StrictMode regression
// 専用 (G-1 boilerplate 局所化)。 InlineTextField の T2 流儀 (mountedRef setup
// reset + revert-during-inflight queue) を踏襲。

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
import type { CardOption } from '@/lib/db/schema'

vi.mock('../_actions/update-card-field', () => ({
  updateCardField: vi.fn(),
}))

import { InlineOptionRow } from './inline-option-row'
import { updateCardField } from '../_actions/update-card-field'

const baseOptions: CardOption[] = [
  { id: 'a', text: '選択肢A', is_correct: false, explanation: 'A 理由' },
  { id: 'b', text: '選択肢B', is_correct: false },
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(updateCardField).mockReset()
  vi.mocked(updateCardField).mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

function renderRow(option: CardOption = baseOptions[0]!, all: CardOption[] = baseOptions, index = 0) {
  return render(
    <InlineOptionRow
      cardId="card-1"
      option={option}
      allOptions={all}
      optionIndex={index}
    />,
  )
}

function startTextEdit(newValue: string) {
  fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
  const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
  fireEvent.change(ta, { target: { value: newValue } })
  return ta
}

function startExplanationEdit(newValue: string) {
  fireEvent.click(screen.getByRole('button', { name: '選択肢 解説 編集' }))
  const ta = screen.getByRole('textbox', { name: '選択肢 解説 編集' })
  fireEvent.change(ta, { target: { value: newValue } })
  return ta
}

describe('InlineOptionRow debounce / queue / optimistic / checkbox 個別 inFlight', () => {
  it('text cell blur → 500ms 経過前は updateCardField 呼ばれない', async () => {
    renderRow()
    const ta = startTextEdit('選択肢A 改')
    fireEvent.blur(ta)

    await act(async () => {
      vi.advanceTimersByTime(499)
    })
    expect(updateCardField).not.toHaveBeenCalled()
  })

  it('text cell blur → 500ms 経過で updateCardField 呼ばれる (Optimistic UI: display 即時新値)', async () => {
    renderRow()
    const ta = startTextEdit('選択肢A 改')
    fireEvent.blur(ta)

    // Optimistic UI: blur 直後 display 新値、 input は消える
    expect(screen.queryByRole('textbox', { name: '選択肢 本文 編集' })).not.toBeInTheDocument()
    expect(screen.getByText('選択肢A 改')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
      { id: 'a', text: '選択肢A 改', isCorrect: false, explanation: 'A 理由' },
      { id: 'b', text: '選択肢B', isCorrect: false },
    ])
  })

  it('text 編集中に checkbox click → debounce timer cancel + checkbox 送信に text 新値同梱', async () => {
    renderRow()
    // 1. text を編集して blur (debounce 500ms 待ち中)
    const ta = startTextEdit('選択肢A 改')
    fireEvent.blur(ta)
    // debounce 中なので 250ms 経過しただけ
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(updateCardField).not.toHaveBeenCalled()

    // 2. checkbox click (= 即時 send、 text 新値も同梱されるはず)
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    await flushPromises()

    // 1 回のみ呼出 (text 用 debounce timer は cancel されている)
    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
      { id: 'a', text: '選択肢A 改', isCorrect: true, explanation: 'A 理由' },
      { id: 'b', text: '選択肢B', isCorrect: false },
    ])

    // 残った debounce 時間が経過してももう呼ばれない (cancel 確認)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    expect(updateCardField).toHaveBeenCalledTimes(1)
  })

  it('checkbox 送信中 (inFlight=true): 該当 checkbox のみ disabled、 text/explanation cell は edit 可能', async () => {
    let resolveCheckbox!: (v: { ok: true } | { ok: false; error: string }) => void
    vi.mocked(updateCardField).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveCheckbox = res
        }),
    )

    renderRow()
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(checkbox)
    await flushPromises()

    // checkbox は disabled
    expect(checkbox).toBeDisabled()

    // text cell は edit 可能 (D 仕様)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    expect(
      screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
    ).toBeInTheDocument()

    // explanation cell も edit 可能
    fireEvent.click(screen.getByRole('button', { name: '選択肢 解説 編集' }))
    expect(
      screen.getByRole('textbox', { name: '選択肢 解説 編集' }),
    ).toBeInTheDocument()

    // 解除
    await act(async () => {
      resolveCheckbox({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()
    expect(checkbox).not.toBeDisabled()
  })

  it('text 送信中に他 cell blur → row 共有 queue で 1 並列、 完走後に最新 snapshot で再送信', async () => {
    let resolveFirst!: (v: { ok: true } | { ok: false; error: string }) => void
    vi.mocked(updateCardField)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res
          }),
      )
      .mockResolvedValueOnce({ ok: true })

    renderRow()
    // 1. text 編集 + blur + 500ms 経過 → text send 開始 (inFlight=true)
    const ta = startTextEdit('text 一')
    fireEvent.blur(ta)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(updateCardField).toHaveBeenNthCalledWith(1, 'card-1', 'options', [
      { id: 'a', text: 'text 一', isCorrect: false, explanation: 'A 理由' },
      { id: 'b', text: '選択肢B', isCorrect: false },
    ])

    // 2. inFlight 中に explanation 編集 + blur (= queue 入り)
    const explTa = startExplanationEdit('expl 二')
    fireEvent.blur(explTa)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // queue 中なので 2 回目はまだ呼ばれない
    expect(updateCardField).toHaveBeenCalledTimes(1)

    // 3. 1 回目完了 → queue 消化で 2 回目 send (text + explanation 両方の最新 snapshot)
    await act(async () => {
      resolveFirst({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()

    expect(updateCardField).toHaveBeenCalledTimes(2)
    expect(updateCardField).toHaveBeenNthCalledWith(2, 'card-1', 'options', [
      { id: 'a', text: 'text 一', isCorrect: false, explanation: 'expl 二' },
      { id: 'b', text: '選択肢B', isCorrect: false },
    ])
  })

  it('失敗時 row 全体 rollback (text + is_correct も含む) + error 表示', async () => {
    vi.mocked(updateCardField).mockResolvedValueOnce({
      ok: false,
      error: '保存に失敗しました',
    })

    renderRow()

    // text を編集 (= optimistic で committed.text 変化) して blur
    const ta = startTextEdit('text 失敗値')
    fireEvent.blur(ta)

    // Optimistic 反映: display は新値
    expect(screen.getByText('text 失敗値')).toBeInTheDocument()

    // debounce 経過 → send → 失敗
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // text rollback (旧値 '選択肢A' に戻る)
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.queryByText('text 失敗値')).not.toBeInTheDocument()

    // error 表示
    expect(screen.getByRole('alert')).toHaveTextContent('保存に失敗しました')
  })

  it('checkbox 失敗時 is_correct を rollback (false に戻る) + error 表示', async () => {
    vi.mocked(updateCardField).mockResolvedValueOnce({
      ok: false,
      error: 'チェック保存失敗',
    })

    renderRow()
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    await flushPromises()

    // server resolve 待ちで失敗 → rollback
    // (mockResolvedValueOnce は同期 resolve なので flushPromises で進む)
    expect(checkbox.checked).toBe(false)
    expect(screen.getByRole('alert')).toHaveTextContent('チェック保存失敗')
  })

  it('Strict Mode 下でも 失敗 → rollback + error が表示される (必須 #3 regression)', async () => {
    vi.mocked(updateCardField).mockResolvedValueOnce({
      ok: false,
      error: 'fail',
    })

    render(
      <StrictMode>
        <InlineOptionRow
          cardId="card-1"
          option={baseOptions[0]!}
          allOptions={baseOptions}
          optionIndex={0}
        />
      </StrictMode>,
    )

    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    fireEvent.change(ta, { target: { value: '楽観値' } })
    fireEvent.blur(ta)

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // mountedRef が setup で reset されていれば rollback + error が表示される
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('fail')
  })

  it('in-flight send 中に serverCommitted と shallowEqual な next で再 blur → 完走後に queue 再送信 (必須 #3 regression)', async () => {
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

    renderRow()

    // 1. text を "B" に → blur → 500ms → send inflight (serverCommitted は元値のまま)
    const ta1 = startTextEdit('B')
    fireEvent.blur(ta1)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(updateCardField).toHaveBeenNthCalledWith(1, 'card-1', 'options', [
      { id: 'a', text: 'B', isCorrect: false, explanation: 'A 理由' },
      { id: 'b', text: '選択肢B', isCorrect: false },
    ])

    // 2. inflight 中に text を元の '選択肢A' に revert + blur
    //    旧実装/単純実装は「値が serverCommitted と一致」 で short-circuit して
    //    revert が server に伝わらない。 修正実装は inFlight or queue 中なら
    //    一致してても scheduleSend して queue に入れる。
    const ta2 = startTextEdit('選択肢A')
    fireEvent.blur(ta2)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // queue 中なのでまだ 2 回目は呼ばれていない
    expect(updateCardField).toHaveBeenCalledTimes(1)

    // 3. 1 回目 (= "B") 解決 → queue 消化で 2 回目 send が呼ばれる (revert 値 "選択肢A")
    await act(async () => {
      resolveFirst({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()

    expect(updateCardField).toHaveBeenCalledTimes(2)
    expect(updateCardField).toHaveBeenNthCalledWith(2, 'card-1', 'options', [
      { id: 'a', text: '選択肢A', isCorrect: false, explanation: 'A 理由' },
      { id: 'b', text: '選択肢B', isCorrect: false },
    ])

    // 4. 2 回目解決後 display は revert 値 "選択肢A" のまま
    await act(async () => {
      resolveSecond({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
  })
})
