// @vitest-environment jsdom
// use-selected-exam.test — caller 側副作用(Dash-1 Home v1 Task 5)を pin する。
// resolveSelectedExam 自体の 4 段解決は selected-exam.test.ts が担う。 本 file は
// 「呼出側 1 箇所」が正しく URL / sync_meta へ適用するかだけを見る:
// - 他 query param(billing 等)を保持したまま `exam` のみ書き換える
// - stale-resolution guard(遅着した古い決定が新しい決定を上書きしない)
// - 保存不要 / URL 不要なケースで無駄な書込をしない
//
// next/navigation(router.replace)と @/lib/sync/sync-meta(getJsonSyncMeta /
// setJsonSyncMeta)を mock する。 sync-meta 側は実 Dexie を挟まず timing を
// 完全に手元で制御するため mock にする(SYNC_META_KEYS / selectedExamSchema は
// importOriginal で実物を使う — 呼出引数の pin に実 key 文字列を使うため)。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSelectedExam } from './use-selected-exam'
import * as syncMeta from '@/lib/sync/sync-meta'

// 実 next/navigation の router.replace は同期的に History API(replaceState)を
// 呼ぶ(RSC 再取得は非同期に後追いする)。 mock でも window.location を実際に更新する
// ことで、 hook 側の「実 URL を見てから書く」冪等ガード(currentExamParam)を
// 正しく再現する — mock が no-op のままだと同ガードが常に「まだ古い」と誤判定し、
// 二重書込 regression を検出できない。
const mockReplace = vi.fn((url: string) => {
  window.history.replaceState(null, '', url)
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}))

vi.mock('@/lib/sync/sync-meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync/sync-meta')>()
  return {
    ...actual,
    getJsonSyncMeta: vi.fn(),
    setJsonSyncMeta: vi.fn(),
  }
})

const mockGetJsonSyncMeta = vi.mocked(syncMeta.getJsonSyncMeta)
const mockSetJsonSyncMeta = vi.mocked(syncMeta.setJsonSyncMeta)

const USER = 'user-1'
const EXAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EXAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  mockReplace.mockClear()
  mockGetJsonSyncMeta.mockReset()
  mockSetJsonSyncMeta.mockReset()
  mockGetJsonSyncMeta.mockResolvedValue(undefined)
  mockSetJsonSyncMeta.mockResolvedValue(undefined)
  window.history.replaceState(null, '', '/app')
})

describe('useSelectedExam — URL 書換は他 query param を保持する', () => {
  it('billing 等の既存 param を保ったまま exam だけ差し替える', async () => {
    window.history.replaceState(null, '', '/app?billing=upgrade')

    renderHook(() =>
      useSelectedExam({ userId: USER, urlExamId: undefined, examIds: [EXAM_A] }),
    )

    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1))
    expect(mockReplace).toHaveBeenCalledWith('/app?billing=upgrade&exam=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  it('exam が既に URL 上で確定していれば router.replace を呼ばない(無駄書き無し)', async () => {
    window.history.replaceState(null, '', `/app?exam=${EXAM_A}&billing=new`)

    const { result } = renderHook(() =>
      useSelectedExam({ userId: USER, urlExamId: EXAM_A, examIds: [EXAM_A] }),
    )

    await waitFor(() => expect(result.current?.outcome).toBe('resolved'))
    // storeNeedsUpdate は true(未保存)なので setJsonSyncMeta は呼ばれるが、
    // urlNeedsUpdate=false なので router.replace は呼ばれない。
    await waitFor(() => expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(1))
    expect(mockReplace).not.toHaveBeenCalled()
  })
})

describe('useSelectedExam — stale-resolution guard(URL)', () => {
  it('遅着した古い決定の URL 書換は起きず、最終的に新しい決定の URL が書かれる', async () => {
    const deferredA = createDeferred<void>()
    mockSetJsonSyncMeta.mockReturnValueOnce(deferredA.promise)

    const { result, rerender } = renderHook(
      ({ examIds }: { examIds: readonly string[] }) =>
        useSelectedExam({ userId: USER, urlExamId: undefined, examIds }),
      { initialProps: { examIds: [EXAM_A] } },
    )

    await waitFor(() => expect(result.current).toMatchObject({ examId: EXAM_A }))
    // examA 用の setJsonSyncMeta 呼出は発生済みだが、まだ pending(未 resolve)。
    expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(1)
    expect(mockReplace).not.toHaveBeenCalled()

    // examA の書込が終わる前に、新しい決定(examB のみ現存)を発生させる。
    // resolution 自体は同期的に examB へ切り替わる(useMemo の再計算)。
    rerender({ examIds: [EXAM_B] })
    expect(result.current).toMatchObject({ examId: EXAM_B })

    // 書込直列化(fix round 1/5)により、examB の setJsonSyncMeta issue と URL 更新は
    // examA の書込完了を待つ — まだ発生していないはず(examA in flight のまま)。
    expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(1)
    expect(mockReplace).not.toHaveBeenCalled()

    // examA の遅着書込をようやく解決させる → 直列化キューが進み examB の書込が issue される。
    deferredA.resolve()
    await waitFor(() => expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining(EXAM_B)),
    )

    // examA 側の URL 書換は一度も起きていない(古い決定は適用直前で捨てられた)。
    expect(mockReplace).not.toHaveBeenCalledWith(expect.stringContaining(EXAM_A))
    expect(mockReplace).toHaveBeenCalledTimes(1)
  })
})

describe('useSelectedExam — 書込直列化(fix round 1/5・Codex Important 是正)', () => {
  it('先発の書込が in flight のうちに後発の決定が発行されても、後発の書込は先発の完了を待ってから issue され、最終的に永続化される値は後発になる', async () => {
    const deferredA = createDeferred<void>()
    mockSetJsonSyncMeta.mockReturnValueOnce(deferredA.promise)

    const { rerender } = renderHook(
      ({ examIds }: { examIds: readonly string[] }) =>
        useSelectedExam({ userId: USER, urlExamId: undefined, examIds }),
      { initialProps: { examIds: [EXAM_A] } },
    )

    await waitFor(() => expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(1))
    expect(mockSetJsonSyncMeta).toHaveBeenNthCalledWith(
      1,
      syncMeta.SYNC_META_KEYS.selectedExam,
      USER,
      { exam_id: EXAM_A },
      syncMeta.selectedExamSchema,
    )

    // examA がまだ in flight のうちに、examB だけが現存する新しい決定を発行する。
    rerender({ examIds: [EXAM_B] })

    // 直列化: examA の書込完了前は examB の書込がまだ issue されていない
    // (= 発行順そのものが保証される。 IndexedDB の完了順に依存しない)。
    expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(1)

    // examA の書込をようやく完了させる。
    deferredA.resolve()
    await waitFor(() => expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(2))

    // 最後(= 最終的に永続化される)の呼出が examB であることを確認する
    // (先発の examA が後発の examB を追い越して上書きすることが構造的に起きない)。
    expect(mockSetJsonSyncMeta).toHaveBeenNthCalledWith(
      2,
      syncMeta.SYNC_META_KEYS.selectedExam,
      USER,
      { exam_id: EXAM_B },
      syncMeta.selectedExamSchema,
    )
  })
})

describe('useSelectedExam — unmount 後は router.replace を呼ばない(fix round 2/5 Minor M3)', () => {
  it('直列化キューの書込みが unmount 後に完了しても、router.replace は呼ばれない', async () => {
    // 書込直列化(fix round 1/5)は await を挟むため、その待ち時間中に unmount される
    // 余地が広い。 unmount 後に run() が resume して router.replace を呼ぶと、
    // 既にユーザーが移動した別 page へ ?exam=<id> を付与し RSC 再取得を強制してしまう。
    const deferredWrite = createDeferred<void>()
    mockSetJsonSyncMeta.mockReturnValueOnce(deferredWrite.promise)

    const { unmount } = renderHook(() =>
      useSelectedExam({ userId: USER, urlExamId: undefined, examIds: [EXAM_A] }),
    )

    await waitFor(() => expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(1))
    unmount()

    // unmount 後に、in-flight だった書込みがようやく完了する。
    deferredWrite.resolve()
    await new Promise((r) => setTimeout(r, 0))

    expect(mockReplace).not.toHaveBeenCalled()
  })
})

describe('useSelectedExam — 初回読込前は undefined', () => {
  it('getJsonSyncMeta が解決するまで resolution は undefined', async () => {
    const deferred = createDeferred<syncMeta.SelectedExam | undefined>()
    mockGetJsonSyncMeta.mockReturnValueOnce(deferred.promise)

    const { result } = renderHook(() =>
      useSelectedExam({ userId: USER, urlExamId: undefined, examIds: [EXAM_A] }),
    )

    expect(result.current).toBeUndefined()
    deferred.resolve(undefined)
    await waitFor(() => expect(result.current).toBeDefined())
  })
})
