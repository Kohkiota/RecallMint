// @vitest-environment jsdom
// PullTrigger client component test。 mount / visibilitychange / online トリガーで
// runGuardedPull / pullAllStudyDays が呼ばれ、 UI は表示されず、 失敗時にも
// throw / UI 影響なし、 unmount 後は listener が解除されていることを verify。
// suppress フラグ (isAmbientPullSuppressed) on の間は ambient kick が no-op になること、
// off で通常通り呼ばれること、 suppress 解除後に queue されないことも verify。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, cleanup, waitFor, screen, act } from '@testing-library/react'
import { PullSettleProvider, useFirstPullSettled } from './pull-settle-context'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// flush 注記: kick() は runGuardedPull / pullAllStudyDays を同期的に呼んでから
// void で promise を捨てるため、 mock 呼出はイベント dispatch と同 tick で確定する。
// よって waitFor は不要で、 microtask 1 回 (await Promise.resolve()) で十分。
// (kick が将来 async 化したらこの前提は崩れるので waitFor へ切替が必要)

const { mockRunGuardedPull, mockPullAllStudyDays, mockIsAmbientPullSuppressed } = vi.hoisted(
  () => ({
    mockRunGuardedPull: vi.fn(),
    mockPullAllStudyDays: vi.fn(),
    mockIsAmbientPullSuppressed: vi.fn(),
  }),
)

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))
vi.mock('@/lib/sync/study-days', () => ({
  pullAllStudyDays: mockPullAllStudyDays,
}))
vi.mock('@/lib/sync/ambient-pull-suppress', () => ({
  isAmbientPullSuppressed: mockIsAmbientPullSuppressed,
}))

import { PullTrigger } from './pull-trigger'

const USER_A = 'user-a'
const USER_B = 'user-b'

beforeEach(() => {
  vi.clearAllMocks()
  mockRunGuardedPull.mockResolvedValue('ran')
  mockPullAllStudyDays.mockResolvedValue({ ok: true, count: 0 })
  // suppress は既定 off — 通常の ambient kick が通る状態
  mockIsAmbientPullSuppressed.mockReturnValue(false)
  // jsdom default: visibilityState is 'visible'
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  // restore visibilityState to 'visible' for isolation
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  })
})

describe('PullTrigger', () => {
  it('(a) mount で runGuardedPull({ reason: "mount" }) / pullAllStudyDays(userId) が各 1 回呼ばれる', async () => {
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ userId: USER_A, reason: 'mount' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledWith(USER_A)
  })

  it('(b) visibilitychange (visible) で runGuardedPull + pullAllStudyDays が追加 kick される', async () => {
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)

    // visibilityState は既に 'visible' (beforeEach で設定済み)
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ userId: USER_A, reason: 'visibilitychange' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(2)
  })

  it('(c) visibilitychange (hidden) では追加 kick されない', async () => {
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)

    // hidden に変更して dispatch
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()

    // 追加 kick されない (mount 分のまま)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })

  it('(d) online イベントで runGuardedPull + pullAllStudyDays が追加 kick される', async () => {
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ userId: USER_A, reason: 'online' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(2)
  })

  it('(e) unmount 後は visibilitychange / online で追加 kick されない', async () => {
    const { unmount } = render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)

    unmount()

    // 前提: visibilityState は 'visible' (beforeEach)。 これがないと「hidden だから
    // kick されない」 で test が誤って pass しうるため明示確認 (listener 解除が真因)。
    expect(document.visibilityState).toBe('visible')

    // unmount 後にイベント発火
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()

    // listener が解除されているので追加 kick なし
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })

  // S-local-2 Task 4 (pin ④): effect deps が [] のままだと userId が変わっても
  // 再 kick されず、 listener が旧 userId を closure に抱えたまま残る
  // (= 次 user の pull が前 user の cursor namespace に書かれる)。
  it('(a-2) userId=A で mount → B に rerender すると B で再 kick される', async () => {
    const { rerender } = render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ userId: USER_A, reason: 'mount' })

    rerender(<PullTrigger userId={USER_B} />)
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ userId: USER_B, reason: 'mount' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(2)
    expect(mockPullAllStudyDays).toHaveBeenLastCalledWith(USER_B)
  })

  it('(a-3) 同じ userId で rerender しても再 kick されない (deps が userId 変化にのみ反応)', async () => {
    const { rerender } = render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)

    rerender(<PullTrigger userId={USER_A} />)
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
  })

  it('(a-4) userId 変化後の visibilitychange は新 userId で kick される (listener 張り替え)', async () => {
    const { rerender } = render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    rerender(<PullTrigger userId={USER_B} />)
    await Promise.resolve()
    mockRunGuardedPull.mockClear()

    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({
      userId: USER_B,
      reason: 'visibilitychange',
    })
  })

  it('(f-1) UI は何も render しない (return null)', () => {
    const { container } = render(<PullTrigger userId={USER_A} />)
    expect(container.firstChild).toBeNull()
  })

  it('(f-2) 2 helper のいずれかが reject しても throw / UI 影響なし、 他は独立に呼ばれる', async () => {
    mockRunGuardedPull.mockRejectedValueOnce(new Error('boom'))
    mockPullAllStudyDays.mockRejectedValueOnce(new Error('boom2'))
    const { container } = render(<PullTrigger userId={USER_A} />)
    // microtask 経過させて handler 内 promise を resolve させる
    await new Promise((r) => setTimeout(r, 0))
    expect(container.firstChild).toBeNull()
    // 2 helper すべて呼ばれた (= silent retry の前提: 各 helper が独立に呼ばれる)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })
})

describe('PullTrigger — suppress フラグ', () => {
  // suppress on の場合: mount / visibilitychange / online すべての ambient kick が
  // runGuardedPull / pullAllStudyDays を呼ばない。
  // suppress の対象外 (pullBack / 入口 kick による runGuardedPull 直呼び) は
  // pull.test.ts / pull-back.test.ts で担保するため、ここでは PullTrigger 経由 vs
  // 直呼びの差を pin する程度でよい。

  it('(g-1) suppress on: mount kick が runGuardedPull / pullAllStudyDays を呼ばない', async () => {
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockPullAllStudyDays).not.toHaveBeenCalled()
  })

  it('(g-2) suppress on: visibilitychange (visible) kick が呼ばない', async () => {
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockPullAllStudyDays).not.toHaveBeenCalled()
  })

  it('(g-3) suppress on: online kick が呼ばない', async () => {
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockPullAllStudyDays).not.toHaveBeenCalled()
  })

  it('(g-4) suppress on: 抑止中の visibilitychange/online は queue されない (suppress 解除後も発火しない)', async () => {
    // suppress on でイベントを発火 → suppress off に切替えてもイベントは再発火しない。
    // 「queue しない」= suppress 解除のタイミングで自動的に runGuardedPull が呼ばれないことを確認。
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()

    // suppress off に切替え (次の kick が来た場合のシミュレーション用)
    mockIsAmbientPullSuppressed.mockReturnValue(false)
    // queue 再生は起きない: await しても呼ばれない
    await new Promise((r) => setTimeout(r, 0))
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockPullAllStudyDays).not.toHaveBeenCalled()
  })

  it('(g-5) suppress off: 通常通り呼ばれる (suppress フラグが動作を壊さないことの確認)', async () => {
    // suppress off (beforeEach で mockReturnValue(false) 設定済み)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ userId: USER_A, reason: 'mount' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })

  it('(g-6) runGuardedPull 直呼びは suppress フラグに影響されない (pullBack / 入口 kick の bypass 確認)', async () => {
    // PullTrigger 経由の kick は suppress on で止まるが、
    // runGuardedPull を直接呼ぶ経路は flag を参照しないため常に実行される。
    // この test は「PullTrigger 経由 vs 直呼びの差」を pin する。
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    // PullTrigger 経由: 呼ばれない
    expect(mockRunGuardedPull).not.toHaveBeenCalled()

    // 直呼び: suppress フラグに関係なく実行される
    // (runGuardedPull は pull.ts で管理、flag は pull.ts に手を入れていない)
    void mockRunGuardedPull({ reason: 'direct' })
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'direct' })
  })
})

// ---------------------------------------------------------------------------
// settle シグナル (Dash-1 Home v1 Task 5・spec §6)
// ---------------------------------------------------------------------------
// PullSettleProvider を実際に被せ、 runGuardedPull の outcome ごとに
// firstPullSettled が正しく latch されるかを見る。 「settle とは何か」の分岐は
// PullTrigger 側の実装(inflight-skip 除外)なので、 ここで直接 pin する。

function SettledProbe() {
  const settled = useFirstPullSettled()
  return <div data-testid="settled">{String(settled)}</div>
}

describe('PullTrigger — settle シグナル', () => {
  it('settled-after-success: outcome "ran" で解決すると settled になる', async () => {
    mockRunGuardedPull.mockResolvedValue('ran')
    render(
      <PullSettleProvider>
        <PullTrigger userId={USER_A} />
        <SettledProbe />
      </PullSettleProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('settled').textContent).toBe('true'))
  })

  it('settled-after-failure: runGuardedPull が reject しても settled になる', async () => {
    mockRunGuardedPull.mockRejectedValueOnce(new Error('network'))
    render(
      <PullSettleProvider>
        <PullTrigger userId={USER_A} />
        <SettledProbe />
      </PullSettleProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('settled').textContent).toBe('true'))
  })

  it('outcome "inflight-skip" 単独では即座には settle しない(fix round 3/5: bound 内での早すぎる settle 防止)', async () => {
    // 同一タブ内の別呼出が実行中であることを意味するだけで、この呼出自身の settle
    // ではない。 ここを即 settle 扱いにすると、実データがまだ mirror に届いていない
    // うちに Home が「試験 0」等を確定判定してしまう。 fix round 3/5 より、solo な
    // inflight-skip(sibling が実際には結果を返さない場合)は bound 到達で fail-safe
    // settle するようになった(下の describe 参照) — 本 test は「即座に settle しない」
    // ことだけを固定 wait で確認する(bound に達するかどうかは別 test の責務)。
    mockRunGuardedPull.mockResolvedValue('inflight-skip')
    render(
      <PullSettleProvider>
        <PullTrigger userId={USER_A} />
        <SettledProbe />
      </PullSettleProvider>,
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByTestId('settled').textContent).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// settle シグナル: lock-busy(fix round 1/5・Codex Critical 是正)
// ---------------------------------------------------------------------------
// lock-busy = 他タブが Web Lock を保持して pull 実行中(その pull はまだ mirror に
// 書き終えていない)。 即 settle すると実データ未着のまま Home が確定判定してしまう
// (critical property)ため、 bound 付きで待ってから fail-safe settle する。
// fake timer で retry delay を制御し、 「早すぎる settle」と「一生 settle しない」の
// 両方向を個別に pin する。

describe('PullTrigger — settle シグナル: lock-busy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lock-busy は即座には settle しない(他タブの pull 未完了を早計に確定判定しない)', async () => {
    mockRunGuardedPull.mockResolvedValue('lock-busy')
    render(
      <PullSettleProvider>
        <PullTrigger userId={USER_A} />
        <SettledProbe />
      </PullSettleProvider>,
    )
    // 最初の outcome 解決分の microtask だけ進める(retry 用の setTimeout が
    // 積まれた直後の状態)。 bound にはまだ遠いので settle していないはず。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('settled').textContent).toBe('false')
  })

  it('lock-busy が続いても bound(150ms×10 ≈ 1.5s)到達で fail-safe settle する', async () => {
    mockRunGuardedPull.mockResolvedValue('lock-busy')
    render(
      <PullSettleProvider>
        <PullTrigger userId={USER_A} />
        <SettledProbe />
      </PullSettleProvider>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600)
    })
    expect(screen.getByTestId('settled').textContent).toBe('true')
  })

  it('lock-busy が bound 内で "ran" に変わればそこで settle する(fail-safe を待たない)', async () => {
    let call = 0
    mockRunGuardedPull.mockImplementation(() => {
      call += 1
      return Promise.resolve(call <= 2 ? 'lock-busy' : 'ran')
    })
    render(
      <PullSettleProvider>
        <PullTrigger userId={USER_A} />
        <SettledProbe />
      </PullSettleProvider>,
    )
    // 2 回の lock-busy(0ms + 150ms 後の retry)を経て 3 回目で 'ran' になる —
    // bound(1.5s)よりずっと早く settle するはず。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(310)
    })
    expect(screen.getByTestId('settled').textContent).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// settle シグナル: inflight-skip の bound 付き扱い(fix round 3/5・
// Codex Critical C1 残課題の是正)
// ---------------------------------------------------------------------------
// 'inflight-skip' を lock-busy と同じ bound 付き retry chain に収斂させた。
// sibling chain が実際には settle しない 2 経路(user 切替で sibling が死んだ
// fiber に属す/ runGuardedPull が AbortSignal なしで永久に解決しない)がある
// ため、'inflight-skip' も無期限待ちにできない。 lock-busy の bound test と
// 同じ形(fake timer)で「早すぎる settle」と「一生 settle しない」の両方向を
// 個別に pin する。

describe('PullTrigger — settle シグナル: inflight-skip の bound 付き扱い(fix round 3/5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('inflight-skip は即座には settle しない(sibling の完了を早計に待たずに確定判定しない)', async () => {
    mockRunGuardedPull.mockResolvedValue('inflight-skip')
    render(
      <PullSettleProvider>
        <PullTrigger userId={USER_A} />
        <SettledProbe />
      </PullSettleProvider>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('settled').textContent).toBe('false')
  })

  it('inflight-skip が続いても bound(150ms×10 ≈ 1.5s)到達で fail-safe settle する(sibling が永久に解決しない場合の救済)', async () => {
    mockRunGuardedPull.mockResolvedValue('inflight-skip')
    render(
      <PullSettleProvider>
        <PullTrigger userId={USER_A} />
        <SettledProbe />
      </PullSettleProvider>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600)
    })
    expect(screen.getByTestId('settled').textContent).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// settle シグナル: 孤児化防止(fix round 2/5・Codex Critical C1 是正)
// ---------------------------------------------------------------------------
// StrictMode の dev 二重 effect(setup→cleanup→setup)や user 切替の unmount+remount
// では、 先に issue された呼出(chain #1)が teardown された後に本物の outcome を
// 返し、 後から mount された呼出(chain #2)は 'inflight-skip' を返す
// (pullInFlight は module-scope の同期フラグなので chain #1 の呼出が終わるまで
// true のまま)。 chain #1 の遅着 outcome が cancelled で捨てられると settle が
// 孤児化する(旧実装の bug)。 StrictMode 経由と、React 内部実装に依存しない直接
// 再現の両方で pin する。

describe('PullTrigger — settle シグナル: 孤児化防止(fix round 2/5 Codex Critical C1)', () => {
  it('(StrictMode) 二重 effect でも chain #1 の遅着 outcome で settle する', async () => {
    const deferredFirst = createDeferred<string>()
    let callCount = 0
    mockRunGuardedPull.mockImplementation(() => {
      callCount += 1
      if (callCount === 1) return deferredFirst.promise
      return Promise.resolve('inflight-skip')
    })

    render(
      <StrictMode>
        <PullSettleProvider>
          <PullTrigger userId={USER_A} />
          <SettledProbe />
        </PullSettleProvider>
      </StrictMode>,
    )

    // 前提の非自明性確認: StrictMode の dev 二重 effect で実際に 2 回 kick されている
    // (前提が崩れて 1 回しか呼ばれなくなったら、この test は無意味化するので明示確認する)。
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('settled').textContent).toBe('false')

    // chain #1(setup→cleanup で teardown 済み)の呼出をようやく解決させる。
    deferredFirst.resolve('ran')
    await waitFor(() => expect(screen.getByTestId('settled').textContent).toBe('true'))
  })

  it('(直接再現) chain #1 が in-flight のまま teardown され chain #2 が inflight-skip を返しても、chain #1 の遅着 outcome で settle する', async () => {
    const deferredFirst = createDeferred<string>()
    let callCount = 0
    mockRunGuardedPull.mockImplementation(() => {
      callCount += 1
      if (callCount === 1) return deferredFirst.promise
      return Promise.resolve('inflight-skip')
    })

    function Harness({ showTrigger }: { showTrigger: boolean }) {
      return (
        <PullSettleProvider>
          {showTrigger && <PullTrigger userId={USER_A} />}
          <SettledProbe />
        </PullSettleProvider>
      )
    }

    const { rerender } = render(<Harness showTrigger={true} />)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)

    // chain #1 が in-flight のまま PullTrigger だけを teardown する(Provider は残す —
    // markFirstPullSettled の宛先が chain #1/#2 で同一であることを保証するため)。
    rerender(<Harness showTrigger={false} />)
    // chain #2: PullTrigger を再 mount して 2 回目の呼出(inflight-skip)を発生させる。
    rerender(<Harness showTrigger={true} />)

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('settled').textContent).toBe('false')

    deferredFirst.resolve('ran')
    await waitFor(() => expect(screen.getByTestId('settled').textContent).toBe('true'))
  })
})

// ---------------------------------------------------------------------------
// retry の teardown 安全性(fix round 2/5・Codex Important I1 是正)
// ---------------------------------------------------------------------------
// 予約済みの retry timer が teardown 後に発火して stale owner(userId)での pull を
// issue する経路を塞ぐ: (a) 予約済み timer は cleanup で clearTimeout する、
// (b) in-flight だった呼出が teardown 後に lock-busy で解決しても新規 retry は
// issue しない。

describe('PullTrigger — retry の teardown 安全性(fix round 2/5 Important I1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lock-busy で予約された retry timer は teardown で解除され、bound を超えて進めても新規呼出が増えない', async () => {
    mockRunGuardedPull.mockResolvedValue('lock-busy')
    const { unmount } = render(<PullTrigger userId={USER_A} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const callsBeforeUnmount = mockRunGuardedPull.mock.calls.length
    expect(callsBeforeUnmount).toBeGreaterThan(0)

    unmount()

    // bound(1.5s)を大きく超えるまで進めても、teardown 後は新規呼出が増えない
    // (予約済み timer が発火していれば増えるはず)。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(callsBeforeUnmount)
  })

  it('in-flight だった呼出が teardown 後に lock-busy で解決しても、新規 retry(stale userId での pull)を issue しない', async () => {
    const deferredFirst = createDeferred<string>()
    mockRunGuardedPull.mockReturnValueOnce(deferredFirst.promise)

    const { unmount } = render(<PullTrigger userId={USER_A} />)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)

    unmount()
    deferredFirst.resolve('lock-busy')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    // retry(2 回目の呼出)が issue されていない。
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// retry の suppress 尊重(fix round 2/5・Minor M2 是正)
// ---------------------------------------------------------------------------
// lock-busy retry ループの再突入は isAmbientPullSuppressed() を毎回再確認する
// (予約時点でなく、実際に再試行しようとする瞬間の状態を見る)。 suppress 中は
// 新規 pull を issue しないが、 無期限に停止させず fail-safe で settle する。

describe('PullTrigger — retry の suppress 尊重(fix round 2/5 Minor M2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retry 予約後に suppress が有効になったら、以後の retry を issue せず fail-safe settle する', async () => {
    mockRunGuardedPull.mockResolvedValue('lock-busy')
    render(
      <PullSettleProvider>
        <PullTrigger userId={USER_A} />
        <SettledProbe />
      </PullSettleProvider>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const callsBeforeSuppress = mockRunGuardedPull.mock.calls.length
    expect(callsBeforeSuppress).toBeGreaterThan(0)

    // 最初の retry timer が予約された直後に suppress を有効化する。
    mockIsAmbientPullSuppressed.mockReturnValue(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    // suppress 開始後は新規呼出が増えていない。
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(callsBeforeSuppress)
    // 無期限に停止させず fail-safe で settle する。
    expect(screen.getByTestId('settled').textContent).toBe('true')
  })
})
