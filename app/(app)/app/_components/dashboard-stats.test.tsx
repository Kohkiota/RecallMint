// @vitest-environment jsdom
// DashboardStats client component test。
// fetch を hoisted mock で差し替え、 loading skeleton / 成功 / 失敗 / abort を検証。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

import { DashboardStats } from './dashboard-stats'

describe('DashboardStats', () => {
  it('mount 直後は skeleton (loading aria) を表示し、 値はまだ出ない', () => {
    // 永遠 pending な fetch
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as typeof fetch
    render(<DashboardStats />)
    expect(screen.getByRole('status', { name: /読み込み中/ })).toBeInTheDocument()
    expect(screen.queryByText('7')).not.toBeInTheDocument()
  })

  it('fetch 成功 → todayCardCount / streak を表示', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ todayCardCount: 7, streak: 4 }),
    })) as unknown as typeof fetch
    render(<DashboardStats />)
    await waitFor(() => {
      expect(screen.getByText('7')).toBeInTheDocument()
      expect(screen.getByText(/4\s*日/)).toBeInTheDocument()
    })
    // skeleton は消える
    expect(screen.queryByRole('status', { name: /読み込み中/ })).not.toBeInTheDocument()
  })

  it('fetch !ok → 数値部分は "--" + inline error 表示', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    })) as unknown as typeof fetch
    render(<DashboardStats />)
    await waitFor(() => {
      // 「--」 が 2 枚分 (today / streak) 出る
      const dashes = screen.getAllByText('--')
      expect(dashes.length).toBe(2)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/取得に失敗/)
  })

  it('fetch throw (network error) → "--" + inline error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network')
    }) as unknown as typeof fetch
    render(<DashboardStats />)
    await waitFor(() => {
      expect(screen.getAllByText('--')).toHaveLength(2)
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })

  it('unmount 時に AbortSignal が abort され、 fetch reject 後も error UI を render しない', async () => {
    // fetch を持ち越して unmount 後に reject 完了する形にし、 「unmount 後に setState
    // で error phase に倒れる regression」 を確実に lock する (review Important #2)。
    // 仕掛け: signal と reject を外部から取り出せる box (object 経由で
    // TypeScript の let-narrow-to-never 推論を回避)。
    const box: {
      signal: AbortSignal | null
      reject: ((err: Error) => void) | null
    } = { signal: null, reject: null }
    globalThis.fetch = vi.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          box.signal = init?.signal ?? null
          box.reject = (err) => reject(err)
        }),
    ) as unknown as typeof fetch

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount, container } = render(<DashboardStats />)
    // unmount 前は loading skeleton が出ている
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    unmount()
    // (a) AbortController.abort() が呼ばれて signal が aborted になった
    expect(box.signal?.aborted).toBe(true)
    // (b) fetch promise を AbortError で reject (実 fetch の挙動を模倣)
    const abortErr = new Error('aborted')
    ;(abortErr as Error & { name: string }).name = 'AbortError'
    box.reject?.(abortErr)
    await new Promise((r) => setTimeout(r, 20))
    // (c) unmount 済なので DOM には何も残らない (= error phase に倒れていない)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toBe('')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('AbortError 早期 return が逆転していると error phase に倒れる (regression guard、 直前 test の positive signal 補強)', async () => {
    // 上 test の対偶を assert: 「unmount **しない**まま AbortError が来た場合、
    // 早期 return で error にならず、 そのまま loading のままになる」
    // (= 早期 return の挙動 lock)。 もし catch から早期 return を消すと、
    // この test は失敗する。
    const box: { reject: ((err: Error) => void) | null } = { reject: null }
    globalThis.fetch = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          box.reject = (err) => reject(err)
        }),
    ) as unknown as typeof fetch

    const { container } = render(<DashboardStats />)
    const abortErr = new Error('aborted')
    ;(abortErr as Error & { name: string }).name = 'AbortError'
    box.reject?.(abortErr)
    await new Promise((r) => setTimeout(r, 20))
    // AbortError は早期 return で setState 不発火 → loading skeleton 維持
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
