// @vitest-environment jsdom
// exam-status-live.tsx の test。 OCR 完了遷移 (processing → completed) 時に
// runGuardedPull({reason:'ocr-complete'}) が呼ばれることを検証する。
// fake timer で POLL_INTERVAL_MS (5000ms) を進めて polling を 1 周させる。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

const { mockRunGuardedPull } = vi.hoisted(() => ({
  mockRunGuardedPull: vi.fn().mockResolvedValue('ran'),
}))

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))

const { mockRouterRefresh } = vi.hoisted(() => ({
  mockRouterRefresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}))

import { ExamStatusProvider } from './exam-status-live'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('ExamStatusProvider OCR 完了遷移', () => {
  it(
    'processing → completed 遷移で runGuardedPull({reason:"ocr-complete"}) と router.refresh() が呼ばれる',
    async () => {
      // 1回目: processing 継続、2回目: processing 消滅 (= completed)
      let fetchCallCount = 0
      global.fetch = vi.fn().mockImplementation(() => {
        fetchCallCount++
        const body =
          fetchCallCount === 1
            ? { statuses: { 'exam-x': 'processing' } }
            : { statuses: {} } // processing 消滅 → hasCompletion=true

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(body),
        })
      })

      // initialStatuses に processing 行あり → 5s interval polling 開始
      render(
        <ExamStatusProvider initialStatuses={{ 'exam-x': 'processing' }}>
          <div data-testid="child">ok</div>
        </ExamStatusProvider>,
      )

      expect(screen.getByTestId('child')).toBeInTheDocument()

      // 1回目 poll (5000ms): processing 継続、まだ hasCompletion=false
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      // 2回目 poll (5000ms): processing 消滅 → hasCompletion=true → refresh + pull
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      // fake timer 環境: act 後すでに同期的に呼ばれているはず
      expect(mockRouterRefresh).toHaveBeenCalled()
      expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'ocr-complete' })
    },
    20000,
  )

  it('processing なし (initialStatuses={}) → runGuardedPull は呼ばれない', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ statuses: {} }),
    })

    render(
      <ExamStatusProvider initialStatuses={{}}>
        <div>ok</div>
      </ExamStatusProvider>,
    )

    // timer を進めても polling は起動しない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })

    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockRouterRefresh).not.toHaveBeenCalled()
  })
})
