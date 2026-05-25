// @vitest-environment jsdom
// `InlineOptionList` の Optimistic UI + debounce + 1 並列 + checkbox 個別 inFlight
// 仕様 (spec §3.3 / §3.5 / §5.1) を fake timer で検証。 基本動作 (render / edit) は
// inline-option-row.test.tsx 担当、 本 file は debounce / queue / rollback /
// checkbox 個別 disable / StrictMode regression / cross-row checkbox race 専用。
//
// S2.0b-2 follow-up fix で options state を per-card 親 `InlineOptionList` に lift up
// し、 cross-row checkbox race を構造的に解消した (旧実装は row 毎 allOptionsRef の
// snapshot ずれで 「複数 checkbox 連続 ON で最後の 1 つだけ ON になる」 bug)。

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

import { InlineOptionList } from './inline-option-row'
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

function renderList(all: CardOption[] = baseOptions) {
  return render(<InlineOptionList cardId="card-1" options={all} />)
}

function startTextEdit(newValue: string, rowIdx = 0) {
  const buttons = screen.getAllByRole('button', { name: '選択肢 本文 編集' })
  fireEvent.click(buttons[rowIdx]!)
  const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
  fireEvent.change(ta, { target: { value: newValue } })
  return ta
}

function startExplanationEdit(newValue: string, rowIdx = 0) {
  const buttons = screen.getAllByRole('button', { name: '選択肢 解説 編集' })
  fireEvent.click(buttons[rowIdx]!)
  const ta = screen.getByRole('textbox', { name: '選択肢 解説 編集' })
  fireEvent.change(ta, { target: { value: newValue } })
  return ta
}

describe('InlineOptionList debounce / queue / optimistic / checkbox 個別 inFlight', () => {
  it('text cell blur → 500ms 経過前は updateCardField 呼ばれない', async () => {
    renderList()
    const ta = startTextEdit('選択肢A 改')
    fireEvent.blur(ta)

    await act(async () => {
      vi.advanceTimersByTime(499)
    })
    expect(updateCardField).not.toHaveBeenCalled()
  })

  it('text cell blur → 500ms 経過で updateCardField 呼ばれる (Optimistic UI: display 即時新値)', async () => {
    renderList()
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
    renderList()
    // 1. text を編集して blur (debounce 500ms 待ち中)
    const ta = startTextEdit('選択肢A 改')
    fireEvent.blur(ta)
    // debounce 中なので 250ms 経過しただけ
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(updateCardField).not.toHaveBeenCalled()

    // 2. 同 row の checkbox click (= 即時 send、 text 新値も同梱されるはず)
    const checkbox = screen.getAllByRole('checkbox')[0]!
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

    renderList()
    const checkbox = screen.getAllByRole('checkbox')[0]! as HTMLInputElement
    fireEvent.click(checkbox)
    await flushPromises()

    // checkbox は disabled
    expect(checkbox).toBeDisabled()

    // 同 row の text cell は edit 可能 (D 仕様)
    const textButtons = screen.getAllByRole('button', { name: '選択肢 本文 編集' })
    fireEvent.click(textButtons[0]!)
    expect(
      screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
    ).toBeInTheDocument()

    // 解除
    await act(async () => {
      resolveCheckbox({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()
    expect(checkbox).not.toBeDisabled()
  })

  it('text 送信中に同 row 別 cell blur → 共有 queue で 1 並列、 完走後に最新 snapshot で再送信', async () => {
    let resolveFirst!: (v: { ok: true } | { ok: false; error: string }) => void
    vi.mocked(updateCardField)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res
          }),
      )
      .mockResolvedValueOnce({ ok: true })

    renderList()
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

  it('失敗時 全 row rollback (text + is_correct 含む) + error 表示', async () => {
    vi.mocked(updateCardField).mockResolvedValueOnce({
      ok: false,
      error: '保存に失敗しました',
    })

    renderList()

    // text を編集 (= optimistic で options[0].text 変化) して blur
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

    renderList()
    const checkbox = screen.getAllByRole('checkbox')[0]! as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    await flushPromises()

    // server resolve 待ちで失敗 → rollback
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
        <InlineOptionList cardId="card-1" options={baseOptions} />
      </StrictMode>,
    )

    const textButtons = screen.getAllByRole('button', { name: '選択肢 本文 編集' })
    fireEvent.click(textButtons[0]!)
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

    renderList()

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
    //    旧/単純実装は「値が serverCommitted と一致」 で short-circuit して
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

    // 3. 1 回目 (= "B") 解決 → queue 消化で 2 回目 send (revert 値 "選択肢A")
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

  // -------------------------------------------------------------------------
  // S2.0b-2 follow-up fix: cross-row checkbox race regression test
  // (旧実装で row 毎 allOptionsRef の snapshot ずれにより、 連続 ON 操作で
  //  「最後の 1 つだけ ON」 になる bug が発生していた)
  // -------------------------------------------------------------------------

  it('cross-row checkbox 連打: 3 option を順次 ON にすると最終送信 payload が (a:true, b:true, c:true) で累積する (= 旧 bug の regression guard)', async () => {
    // 3 option 全て is_correct=false 初期化、 1 個目の送信を hold した状態で
    // 2 個目 / 3 個目を連打。 旧実装は各 row の allOptionsRef が stale で他 row の
    // 楽観値を見落とすため、 最後の click が前の click を上書きして 「最後の 1 つだけ
    // ON」 になっていた。 修正実装は per-card 親 InlineOptionList が options state を
    // 共有するため、 各 send 構築時に累積した最新 snapshot を payload に積む。
    const threeOptions: CardOption[] = [
      { id: 'a', text: 'A', is_correct: false },
      { id: 'b', text: 'B', is_correct: false },
      { id: 'c', text: 'C', is_correct: false },
    ]

    // 1 個目の send を hold (= queue 経由で 2 個目以降が queue に積まれる状況を再現)
    let resolveFirst!: (v: { ok: true } | { ok: false; error: string }) => void
    vi.mocked(updateCardField)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res
          }),
      )
      .mockResolvedValue({ ok: true })

    render(<InlineOptionList cardId="card-1" options={threeOptions} />)

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]

    // a を ON (= 1 個目の send、 hold される)
    fireEvent.click(checkboxes[0]!)
    await flushPromises()
    expect(updateCardField).toHaveBeenCalledTimes(1)
    expect(updateCardField).toHaveBeenNthCalledWith(1, 'card-1', 'options', [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B', isCorrect: false },
      { id: 'c', text: 'C', isCorrect: false },
    ])

    // b を ON (= queue 入り、 旧実装は b の allOptionsRef が [a:false, b:false, c:false]
    // で stale なため、 送信 payload で a が false になり server 上書きされていた)
    fireEvent.click(checkboxes[1]!)
    await flushPromises()
    // c を ON (= queue 上書き、 同様に旧実装は a/b を false 化していた)
    fireEvent.click(checkboxes[2]!)
    await flushPromises()

    // queue は深さ 1 で上書き運用なので、 1 個目 resolve 後に最後の payload が送信される
    // (b は c によって上書きされる挙動だが、 修正実装では a:true / b:true は state に
    //  累積済のため最終 payload は a:true / b:true / c:true)
    await act(async () => {
      resolveFirst({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()

    // 2 個目 (= queue 消化分): a/b/c 全て true で累積された最新 snapshot
    expect(updateCardField).toHaveBeenCalledTimes(2)
    expect(updateCardField).toHaveBeenNthCalledWith(2, 'card-1', 'options', [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B', isCorrect: true },
      { id: 'c', text: 'C', isCorrect: true },
    ])

    // UI 表示: 3 checkbox 全て ON
    expect(checkboxes[0]!.checked).toBe(true)
    expect(checkboxes[1]!.checked).toBe(true)
    expect(checkboxes[2]!.checked).toBe(true)
  })

  it('cross-row checkbox 連打: server 失敗時は全 row rollback (= 楽観値全 clear、 旧 bug の延長線上で起きうる 「一部だけ ON のまま」 を防ぐ)', async () => {
    const threeOptions: CardOption[] = [
      { id: 'a', text: 'A', is_correct: false },
      { id: 'b', text: 'B', is_correct: false },
      { id: 'c', text: 'C', is_correct: false },
    ]

    let resolveFirst!: (v: { ok: true } | { ok: false; error: string }) => void
    vi.mocked(updateCardField)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res
          }),
      )
      .mockResolvedValueOnce({ ok: false, error: 'queue 失敗' })

    render(<InlineOptionList cardId="card-1" options={threeOptions} />)
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]

    fireEvent.click(checkboxes[0]!)
    await flushPromises()
    fireEvent.click(checkboxes[1]!)
    await flushPromises()
    fireEvent.click(checkboxes[2]!)
    await flushPromises()

    // 1 個目を成功 resolve → serverCommittedRef は [a:true, b:false, c:false] に更新
    await act(async () => {
      resolveFirst({ ok: true })
      await Promise.resolve()
    })
    await flushPromises()

    // queue 消化分 (= 累積 a:true,b:true,c:true) が失敗 → 全 row rollback
    expect(screen.getByRole('alert')).toHaveTextContent('queue 失敗')
    expect(checkboxes[0]!.checked).toBe(true) // serverCommittedRef は a:true で確定済
    expect(checkboxes[1]!.checked).toBe(false) // rollback
    expect(checkboxes[2]!.checked).toBe(false) // rollback
  })

  // -------------------------------------------------------------------------
  // S2.0b-3 follow-up fix: 連続追加 2 つ目が消える bug の regression guard
  // (useEffect([serverOptions]) を merge 戦略に変更し、 別 row の send 成功
  //  + revalidate で local ghost が evict される旧 bug を構造解消)
  // -------------------------------------------------------------------------

  it('連続追加: c に text 入力 → blur → d 追加 → 500ms 経過で c-valid send 完了 → revalidate (props 更新) でも d-ghost が消えない (merge 戦略 regression)', async () => {
    const { rerender } = renderList()

    // 1. 「+ 追加」 で c-ghost 追加 (auto-edit on mount)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await flushPromises()
    expect(screen.getByText('c')).toBeInTheDocument()

    // 2. c に 'hello' 入力 + blur (scheduleSend で 500ms timer 起動)
    const ta1 = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    fireEvent.change(ta1, { target: { value: 'hello' } })
    fireEvent.blur(ta1)
    await flushPromises()

    // 3. すぐに「+ 追加」 で d-ghost 追加
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await flushPromises()
    expect(screen.getByText('d')).toBeInTheDocument()
    // 4 件: a / b / c (hello) / d-ghost
    expect(screen.getByText('選択肢 (4 件)')).toBeInTheDocument()

    // 4. 500ms 経過 → c-valid send 発火 + 完了
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()
    // server payload は [a, b, c-with-hello] (d-ghost は filter で除外)
    expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
      { id: 'a', text: '選択肢A', isCorrect: false, explanation: 'A 理由' },
      { id: 'b', text: '選択肢B', isCorrect: false },
      { id: 'c', text: 'hello', isCorrect: false },
    ])

    // 5. 親 revalidate を simulate: serverOptions prop を server 確定値で再 render
    const newServerOptions: CardOption[] = [
      { id: 'a', text: '選択肢A', is_correct: false, explanation: 'A 理由' },
      { id: 'b', text: '選択肢B', is_correct: false },
      { id: 'c', text: 'hello', is_correct: false },
    ]
    rerender(
      <InlineOptionList cardId="card-1" options={newServerOptions} />,
    )
    await flushPromises()

    // 6. 旧実装 (一括 setOptions(serverOptions)) ではここで d-ghost が evict されて
    //    「選択肢 (3 件)」 になっていた。 merge 戦略では d-ghost が末尾に保持されて
    //    「選択肢 (4 件)」 のまま、 c (hello 反映済) も d (ghost のまま) も残る。
    expect(screen.getByText('選択肢 (4 件)')).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument() // c 昇格済
    expect(screen.getByText('d')).toBeInTheDocument() // d-ghost 残存

    // 7. d-ghost の存在を id 表示で再確認 (4 row 全部 list 内に居る)
    const idButtons = screen.getAllByRole('button', { name: '選択肢 id 編集' })
    // a / b / c の 3 + d の id cell (d は edit mode の text cell を持つが id cell は
    // display 状態のため idButtons に含まれる)
    expect(idButtons.length).toBe(4)
  })

  it('merge 戦略: serverCommittedRef は merged ではなく server 確定値のみを保持 (= rollback target が ghost 含まないこと)', async () => {
    const { rerender } = renderList()
    // c-ghost 追加 (auto-edit)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await flushPromises()

    // 親 revalidate を simulate (server 側は a, b のまま不変、 c は ghost で未送信)
    rerender(<InlineOptionList cardId="card-1" options={baseOptions} />)
    await flushPromises()

    // 4 件は残らないが、 c-ghost は merge で保持される (server に id 'c' なし → ghost)
    expect(screen.getByText('選択肢 (3 件)')).toBeInTheDocument()
    expect(screen.getByText('c')).toBeInTheDocument()

    // 次に c に text 入力 + blur で valid 化 → send
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    fireEvent.change(ta, { target: { value: 'cテキスト' } })
    fireEvent.blur(ta)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await flushPromises()

    // server payload は a, b, c (c が valid 化されて 3 件全部含まれる、 ghost なし)
    expect(updateCardField).toHaveBeenCalledWith('card-1', 'options', [
      { id: 'a', text: '選択肢A', isCorrect: false, explanation: 'A 理由' },
      { id: 'b', text: '選択肢B', isCorrect: false },
      { id: 'c', text: 'cテキスト', isCorrect: false },
    ])
    // = serverCommittedRef が a, b (ghost 含まず) の状態から差分なく付加された確認
    // (もし serverCommittedRef に c-ghost を含めていたら shallowEqual 判定で skip され
    //  send されない可能性があった)
  })
})
