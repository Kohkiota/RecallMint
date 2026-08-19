// @vitest-environment jsdom
// WeakTags(W4)— v1 で唯一の L3。取得失敗 / 候補 0 / 遅着応答の 3 つを**別状態**として
// 扱えているかが本 file の主眼(§3.8 の 4 状態区別・適用対象は W4 の 1 箇所)。
//
// 特に重要(spec §9.2-3): sign-up race の 200 応答には echo が載らない。「400 だけが
// 不正 exam_id の信号」と思うと、その応答を「候補 0」として黙って空表示してしまう。
// 描画条件は **echo 2 本の一致**であることを pin する。

import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

import { WeakTags } from './weak-tags'

const USER = 'user-1'
const EXAM = '11111111-2222-3333-4444-555555555555'
const EXAM2 = '22222222-3333-4444-5555-666666666666'

const ROWS = [
  {
    option_id: 'opt-1',
    name: '仕訳',
    category_name: '論点',
    review_accuracy: 48,
    card_count: 22,
  },
  {
    option_id: 'opt-2',
    name: '連結',
    category_name: '論点',
    review_accuracy: 55,
    card_count: 14,
  },
]

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WeakTags — 正常応答', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      jsonResponse({ owner_user_id: USER, exam_id: EXAM, weak_tags: ROWS }),
    )
  })

  it('選択試験の exam_id で summary を叩く', async () => {
    render(<WeakTags userId={USER} examId={EXAM} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/stats/summary?exam_id=${EXAM}`)
  })

  it('タグ名・カテゴリ名・復習正答率・対象問数を出す', async () => {
    render(<WeakTags userId={USER} examId={EXAM} />)
    const row = await screen.findByTestId('weak-tag-opt-1')
    expect(row).toHaveTextContent('仕訳')
    expect(row).toHaveTextContent('論点')
    expect(row).toHaveTextContent('48%')
    expect(row).toHaveTextContent('22問')
  })

  it('行ごとに「この分野を 10 問」を tag 単独入口として出す(preset を付けない)', async () => {
    render(<WeakTags userId={USER} examId={EXAM} />)
    const row = await screen.findByTestId('weak-tag-opt-1')
    const link = row.querySelector('a')
    expect(link).toHaveAttribute('href', `/app/study/quick?exam=${EXAM}&tag=opt-1`)
  })

  it('診断文を 1 行添える', async () => {
    render(<WeakTags userId={USER} examId={EXAM} />)
    await screen.findByTestId('weak-tag-opt-1')
    expect(screen.getByTestId('weak-tags-lead')).toBeInTheDocument()
  })
})

describe('WeakTags — 候補 0(空)と 取得失敗 を区別する(§3.8)', () => {
  it('候補 0 はウィジェットごと非表示(失敗文言を出さない)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ owner_user_id: USER, exam_id: EXAM, weak_tags: [] }),
    )
    const { container } = render(<WeakTags userId={USER} examId={EXAM} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull()
  })

  it('fetch が失敗したら失敗と分かる表示にする', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    render(<WeakTags userId={USER} examId={EXAM} />)
    expect(await screen.findByText('読み込めませんでした')).toBeInTheDocument()
  })

  it('HTTP エラーも失敗表示', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'internal' }, 500))
    render(<WeakTags userId={USER} examId={EXAM} />)
    expect(await screen.findByText('読み込めませんでした')).toBeInTheDocument()
  })

  it('echo 不在の 200(sign-up race)は「候補 0」ではなく失敗として扱う', async () => {
    // spec §9.2-3: withReadOnlyAuth の静的 emptyBody は owner/exam echo を載せない。
    // これを空扱いすると「苦手タグが無い」と誤って断定してしまう。
    fetchMock.mockResolvedValue(jsonResponse({ weak_tags: [] }))
    render(<WeakTags userId={USER} examId={EXAM} />)
    expect(await screen.findByText('読み込めませんでした')).toBeInTheDocument()
  })

  it('owner echo が別 user なら描画しない', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ owner_user_id: 'user-2', exam_id: EXAM, weak_tags: ROWS }),
    )
    render(<WeakTags userId={USER} examId={EXAM} />)
    expect(await screen.findByText('読み込めませんでした')).toBeInTheDocument()
    expect(screen.queryByTestId('weak-tag-opt-1')).toBeNull()
  })

  it('schema に合わない応答は「候補 0」でなく失敗', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ owner_user_id: USER, exam_id: EXAM, weak_tags: 'nope' }),
    )
    render(<WeakTags userId={USER} examId={EXAM} />)
    expect(await screen.findByText('読み込めませんでした')).toBeInTheDocument()
  })
})

describe('WeakTags — 試験切替の遅着応答(§4 W4 の fetch race)', () => {
  it('別試験の exam_id echo を持つ応答は捨てる(失敗にもしない)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        owner_user_id: USER,
        exam_id: '99999999-9999-9999-9999-999999999999',
        weak_tags: ROWS,
      }),
    )
    const { container } = render(<WeakTags userId={USER} examId={EXAM} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(screen.queryByTestId('weak-tag-opt-1')).toBeNull()
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull()
  })

  it('unmount 時に in-flight の fetch を abort する', async () => {
    let capturedSignal: AbortSignal | undefined
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      return new Promise(() => {}) // 解決しない = in-flight のまま
    })
    const { unmount } = render(<WeakTags userId={USER} examId={EXAM} />)
    await waitFor(() => expect(capturedSignal).toBeDefined())
    expect(capturedSignal?.aborted).toBe(false)
    unmount()
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('abort による reject を失敗表示にしない(切替後に前の試験の失敗が出ない)', async () => {
    // 「abort は正常経路」の guard を消すと、切替前の fetch の AbortError が
    // 後から failed を書き込み、新しい試験の読み込み中に失敗文言が出てしまう。
    const OTHER = '99999999-9999-9999-9999-999999999999'
    let rejectFirst: ((e: Error) => void) | undefined
    fetchMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectFirst = reject)),
    )
    fetchMock.mockImplementation(() => new Promise(() => {}))

    const { rerender } = render(<WeakTags userId={USER} examId={EXAM} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    rerender(<WeakTags userId={USER} examId={OTHER} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const abortError = new Error('The operation was aborted.')
    abortError.name = 'AbortError'
    rejectFirst?.(abortError)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull()
  })

  it('試験が切り替わったら前の fetch を abort して新しい exam_id で取り直す', async () => {
    const signals: AbortSignal[] = []
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal)
      return new Promise(() => {})
    })
    const OTHER = '99999999-9999-9999-9999-999999999999'
    const { rerender } = render(<WeakTags userId={USER} examId={EXAM} />)
    await waitFor(() => expect(signals).toHaveLength(1))
    rerender(<WeakTags userId={USER} examId={OTHER} />)
    await waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/stats/summary?exam_id=${OTHER}`)
  })
})

describe('WeakTags — abort の扱い', () => {
  // 「abort を失敗表示にしない」は不在の主張。 試験切替で観測しようとすると、
  // 鍵 (userId|examId) の不一致が先に stale を捨ててしまい、 guard を消しても
  // test が通る (= pin が空振りする)。 検出力があるのは **同じ鍵のまま abort が
  // 起きる経路** = StrictMode の二重 mount (本番も reactStrictMode: true)。
  it('StrictMode の二重 mount で abort された 1 本目を失敗表示にしない', async () => {
    let rejectFirst: ((e: Error) => void) | undefined
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject
        }),
    )
    // 2 本目は解決させない (1 本目の abort だけを観測するため)。
    fetchMock.mockImplementation(() => new Promise(() => {}))

    render(
      <StrictMode>
        <WeakTags userId={USER} examId={EXAM} />
      </StrictMode>,
    )
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2))

    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    rejectFirst?.(abortError)
    await new Promise((r) => setTimeout(r, 20))

    expect(screen.queryByText(/読み込めませんでした/)).toBeNull()
  })

  it('検出器: 同じ経路で abort でない reject なら失敗表示になる', async () => {
    // 上の「出ない」が「そもそも何も描画されない配線」で通っていないことの対照。
    fetchMock.mockRejectedValue(new Error('network down'))
    render(<WeakTags userId={USER} examId={EXAM} />)
    expect(await screen.findByText(/読み込めませんでした/)).toBeInTheDocument()
  })
})

describe('WeakTags — 遅着応答が新しい結果を消さない', () => {
  it('試験切替後に前の試験の echo 無し 200 が遅着しても、新しい試験の結果を保つ', async () => {
    let resolveFirst: ((r: Response) => void) | undefined
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve
        }),
    )
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ owner_user_id: USER, exam_id: EXAM2, weak_tags: ROWS }),
    )

    const view = render(<WeakTags userId={USER} examId={EXAM} />)
    view.rerender(<WeakTags userId={USER} examId={EXAM2} />)
    expect(await screen.findByText('仕訳')).toBeInTheDocument()

    // sign-up race 形の echo 無し 200 (= 照合不能ゆえ本来は失敗扱いになる応答) が、
    // 切替後に遅れて着く。 これで新しい結果が消えてはならない。
    resolveFirst?.(jsonResponse({ weak_tags: [] }))
    await new Promise((r) => setTimeout(r, 20))

    expect(screen.getByText('仕訳')).toBeInTheDocument()
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull()
  })
})
