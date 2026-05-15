import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ops', () => ({ notifyOps: vi.fn() }))

import { notifyOps } from '@/lib/ops'
import { onRequestError } from './instrumentation'

const notifyMock = vi.mocked(notifyOps)

const baseRequest = {
  path: '/app/settings',
  method: 'POST',
  headers: {
    authorization: 'Bearer should-not-leak',
    cookie: '__session=should-not-leak',
  },
}

const baseContext = {
  routerKind: 'App Router' as const,
  routePath: '/app/settings/actions',
  routeType: 'action' as const,
  revalidateReason: undefined,
}

describe('onRequestError', () => {
  beforeEach(() => {
    notifyMock.mockClear()
  })

  it('forwards Error instances to notifyOps with structured context, omitting headers', async () => {
    const err = Object.assign(new Error('boom'), { digest: 'abc123' })
    await onRequestError(err, baseRequest, baseContext)
    expect(notifyMock).toHaveBeenCalledOnce()
    const [subject, ctx] = notifyMock.mock.calls[0]!
    expect(subject).toBe('unhandled server error')
    expect(ctx).toMatchObject({
      routerKind: 'App Router',
      routePath: '/app/settings/actions',
      routeType: 'action',
      requestPath: '/app/settings',
      requestMethod: 'POST',
      errorName: 'Error',
      errorMessage: 'boom',
      errorDigest: 'abc123',
    })
    // 機微情報 (Authorization / cookie) が context に含まれていない
    expect(JSON.stringify(ctx)).not.toContain('should-not-leak')
  })

  it('handles non-Error throws (e.g., string) without crashing', async () => {
    await onRequestError('plain string thrown', baseRequest, baseContext)
    expect(notifyMock).toHaveBeenCalledOnce()
    const [, ctx] = notifyMock.mock.calls[0]!
    expect(ctx).toMatchObject({ errorRaw: 'plain string thrown' })
    expect(ctx.errorName).toBeUndefined()
  })
})
