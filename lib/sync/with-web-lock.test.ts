// with-web-lock helper の test。
// 3 caller (entity-mutation-flush / review-flush / pull) が共有する Web Locks 排他
// wrap pattern を 1 関数化したもの。 各 caller の挙動 (lock granted で body 実行 / 他タブ
// 保持で onLockBusy 実行 / 非対応 fallback で body 直接実行) を再現できることを確認する。

import { describe, it, expect, vi } from 'vitest'
import { withWebLock } from './with-web-lock'

function fakeLocks<T>(grant: boolean) {
  const calls: { name: string; ifAvailable: boolean | undefined }[] = []
  return {
    calls,
    request: (
      name: string,
      options: { ifAvailable?: boolean },
      cb: (lock: unknown) => Promise<T>,
    ): Promise<T> => {
      calls.push({ name, ifAvailable: options.ifAvailable })
      // grant=true: lock オブジェクトを渡す / grant=false: null (他タブ保持中)
      return Promise.resolve(grant ? cb({ name }) : cb(null))
    },
  }
}

describe('withWebLock — lock granted', () => {
  it('lock 取得成功 → run() を実行し戻り値を返す', async () => {
    const run = vi.fn(async () => 'ran-result' as const)
    const onLockBusy = vi.fn(() => 'lock-busy' as const)
    const locks = fakeLocks<'ran-result' | 'lock-busy'>(true)

    const result = await withWebLock({
      lockName: 'test-lock',
      run,
      onLockBusy,
      locks,
    })

    expect(result).toBe('ran-result')
    expect(run).toHaveBeenCalledTimes(1)
    expect(onLockBusy).not.toHaveBeenCalled()
    expect(locks.calls[0]).toEqual({ name: 'test-lock', ifAvailable: true })
  })
})

describe('withWebLock — lock busy', () => {
  it('他タブが lock 保持中 → onLockBusy() を実行し戻り値を返す (run は呼ばない)', async () => {
    const run = vi.fn(async () => 'ran-result' as const)
    const onLockBusy = vi.fn(() => 'lock-busy' as const)
    const locks = fakeLocks<'ran-result' | 'lock-busy'>(false)

    const result = await withWebLock({
      lockName: 'test-lock',
      run,
      onLockBusy,
      locks,
    })

    expect(result).toBe('lock-busy')
    expect(run).not.toHaveBeenCalled()
    expect(onLockBusy).toHaveBeenCalledTimes(1)
  })
})

describe('withWebLock — defensive fallback (locks=undefined)', () => {
  it('locks 明示 undefined → lock なしで run() を直接実行 (Web Locks 非対応環境を test)', async () => {
    const run = vi.fn(async () => 'ran-result' as const)
    const onLockBusy = vi.fn(() => 'lock-busy' as const)

    const result = await withWebLock({
      lockName: 'test-lock',
      run,
      onLockBusy,
      locks: undefined,
    })

    expect(result).toBe('ran-result')
    expect(run).toHaveBeenCalledTimes(1)
    expect(onLockBusy).not.toHaveBeenCalled()
  })
})

describe('withWebLock — no locks key (navigator.locks 経路)', () => {
  it('locks key 不在 → navigator.locks があれば使う', async () => {
    const run = vi.fn(async () => 'ran-result' as const)
    const onLockBusy = vi.fn(() => 'lock-busy' as const)

    // navigator.locks をモック。 jsdom / node env では navigator が無いか locks が
    // 無いため、 globalThis に最小 mock を仕込んで 'locks' key 不在経路を verify する。
    const requestSpy = vi.fn(
      (
        _name: string,
        _options: { ifAvailable?: boolean },
        cb: (lock: unknown) => Promise<'ran-result' | 'lock-busy'>,
      ) => cb({ name: _name }),
    )
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks: { request: requestSpy } },
      configurable: true,
      writable: true,
    })

    try {
      const result = await withWebLock({
        lockName: 'test-lock',
        run,
        onLockBusy,
        // locks key 不在 = navigator.locks 経路
      })

      expect(result).toBe('ran-result')
      expect(run).toHaveBeenCalledTimes(1)
      expect(requestSpy).toHaveBeenCalledTimes(1)
    } finally {
      // restore
      if (originalNavigator === undefined) {
        delete (globalThis as { navigator?: unknown }).navigator
      } else {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true,
          writable: true,
        })
      }
    }
  })

  it('locks key 不在 + navigator.locks も無い → run() を直接実行 (defensive)', async () => {
    const run = vi.fn(async () => 'ran-result' as const)
    const onLockBusy = vi.fn(() => 'lock-busy' as const)

    // navigator 自体を一時削除して "Web Locks 非対応環境" を再現
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    delete (globalThis as { navigator?: unknown }).navigator

    try {
      const result = await withWebLock({
        lockName: 'test-lock',
        run,
        onLockBusy,
      })

      expect(result).toBe('ran-result')
      expect(run).toHaveBeenCalledTimes(1)
      expect(onLockBusy).not.toHaveBeenCalled()
    } finally {
      if (originalNavigator !== undefined) {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true,
          writable: true,
        })
      }
    }
  })
})
