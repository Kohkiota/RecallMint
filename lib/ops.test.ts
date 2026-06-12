import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { notifyOps, notifyWebhookError } from './ops'

describe('notifyOps', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  const ORIGINAL_URL = process.env.OPS_DISCORD_WEBHOOK_URL
  const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    if (ORIGINAL_URL === undefined) delete process.env.OPS_DISCORD_WEBHOOK_URL
    else process.env.OPS_DISCORD_WEBHOOK_URL = ORIGINAL_URL
    if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV
  })

  it('no-op when OPS_DISCORD_WEBHOOK_URL is not set', async () => {
    delete process.env.OPS_DISCORD_WEBHOOK_URL
    await notifyOps('test', { foo: 'bar' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts to Discord webhook with subject + serialized context when URL is set', async () => {
    process.env.OPS_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y'
    await notifyOps('subject-line', { key: 'value' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://discord.com/api/webhooks/x/y')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string) as { content: string }
    expect(body.content).toContain('**subject-line**')
    expect(body.content).toContain('"key"')
    expect(body.content).toContain('"value"')
  })

  it('does not throw when fetch rejects (silent failure with console.warn)', async () => {
    process.env.OPS_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y'
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(notifyOps('s', {})).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('handles Error instances and circular references in context (best-effort post)', async () => {
    process.env.OPS_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y'
    type Circ = { self?: Circ; err: Error }
    const circ: Circ = { err: new Error('boom') }
    circ.self = circ
    await expect(notifyOps('test', { circ })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { content: string }
    expect(body.content).toContain('[Circular]')
    expect(body.content).toContain('"name": "Error"')
    expect(body.content).toContain('"message": "boom"')
  })

  // I-baseline-2 (Phase 1 G-baseline-1): Discord fetch must carry a 3000ms
  // AbortSignal so a hung Discord webhook cannot consume the surrounding
  // Vercel function timeout (Hobby 10s / Pro 60s).
  it('passes an AbortSignal (3000ms timeout) to fetch', async () => {
    process.env.OPS_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y'
    await notifyOps('s', {})
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Signal has not aborted yet at call time (timer is 3000ms in the future).
    expect(init.signal?.aborted).toBe(false)
  })

  it('AbortError from fetch (e.g. 3000ms timeout fires) does not propagate', async () => {
    process.env.OPS_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y'
    const abortErr = new DOMException('aborted', 'AbortError')
    fetchMock.mockRejectedValueOnce(abortErr)
    await expect(notifyOps('s', {})).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  // T-A5 (audit §10.3 (b) #14): production fail-fast + 代替 error sink.
  // production で OPS_DISCORD_WEBHOOK_URL 未設定 = 設定漏れの deployment misconfig
  // なので silent no-op せず throw、 fetch 失敗時は logger.warn に加えて
  // logger.error も fire (warn が filter で消える可能性に備える)。
  it('throws when OPS_DISCORD_WEBHOOK_URL is missing in production (T-A5)', async () => {
    process.env.VERCEL_ENV = 'production'
    delete process.env.OPS_DISCORD_WEBHOOK_URL
    await expect(notifyOps('test', { foo: 'bar' })).rejects.toThrow(
      'OPS_DISCORD_WEBHOOK_URL must be set in production',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts successfully when URL is set in production (T-A5 happy path)', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.OPS_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y'
    await expect(notifyOps('test', { foo: 'bar' })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fires both warn (fetch_failed) and error (unreachable) on fetch failure in production (T-A5)', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.OPS_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y'
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(notifyOps('s', {})).resolves.toBeUndefined()
    // logger.warn (existing) routes to console.warn
    expect(warnSpy).toHaveBeenCalledOnce()
    const warnArg = warnSpy.mock.calls[0]?.[0] as string
    expect(warnArg).toContain('ops.notify.fetch_failed')
    // logger.error (new in T-A5) routes to console.error
    expect(errorSpy).toHaveBeenCalledOnce()
    const errorArg = errorSpy.mock.calls[0]?.[0] as string
    expect(errorArg).toContain('ops.notify.unreachable')
  })

  it('silent no-op when URL is missing and VERCEL_ENV is unset (non-prod, T-A5 regression)', async () => {
    delete process.env.VERCEL_ENV
    delete process.env.OPS_DISCORD_WEBHOOK_URL
    await expect(notifyOps('test', { foo: 'bar' })).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('notifyWebhookError', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  const ORIGINAL_URL = process.env.OPS_DISCORD_WEBHOOK_URL
  const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.OPS_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    warnSpy.mockRestore()
    if (ORIGINAL_URL === undefined) delete process.env.OPS_DISCORD_WEBHOOK_URL
    else process.env.OPS_DISCORD_WEBHOOK_URL = ORIGINAL_URL
    if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV
  })

  function parseBody(): { content: string } {
    return JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { content: string }
  }

  it('posts subject "<handler> webhook handler error" with required fields', async () => {
    await notifyWebhookError({
      handler: 'stripe',
      eventId: 'evt_123',
      eventType: 'customer.subscription.updated',
      err: new Error('boom'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = parseBody()
    expect(body.content).toContain('**stripe webhook handler error**')
    expect(body.content).toContain('"handler": "stripe"')
    expect(body.content).toContain('"eventId": "evt_123"')
    expect(body.content).toContain('"eventType": "customer.subscription.updated"')
    expect(body.content).toContain('"name": "Error"')
    expect(body.content).toContain('"message": "boom"')
  })

  it('auto-injects environment from VERCEL_ENV and ISO timestamp', async () => {
    process.env.VERCEL_ENV = 'production'
    await notifyWebhookError({
      handler: 'clerk',
      eventId: 'msg_abc',
      eventType: 'user.deleted',
      err: new Error('x'),
    })
    const body = parseBody()
    expect(body.content).toContain('"environment": "production"')
    // ISO 8601 timestamp e.g. 2026-04-29T...Z
    expect(body.content).toMatch(/"timestamp": "\d{4}-\d{2}-\d{2}T[\d:.]+Z"/)
  })

  it('falls back environment to NODE_ENV when VERCEL_ENV is unset', async () => {
    delete process.env.VERCEL_ENV
    await notifyWebhookError({
      handler: 'stripe',
      eventId: 'evt_x',
      eventType: 'foo',
      err: new Error('y'),
    })
    const body = parseBody()
    // NODE_ENV in vitest is typically 'test'
    expect(body.content).toContain(`"environment": "${process.env.NODE_ENV ?? 'unknown'}"`)
  })

  it('includes optional userId / customerId when provided', async () => {
    await notifyWebhookError({
      handler: 'clerk',
      eventId: 'msg_1',
      eventType: 'user.deleted',
      err: new Error('e'),
      userId: 'user_abc',
      customerId: 'cus_xyz',
    })
    const body = parseBody()
    expect(body.content).toContain('"userId": "user_abc"')
    expect(body.content).toContain('"customerId": "cus_xyz"')
  })

  it('omits userId / customerId from payload when not provided', async () => {
    await notifyWebhookError({
      handler: 'clerk',
      eventId: 'msg_1',
      eventType: 'user.created',
      err: new Error('e'),
    })
    const body = parseBody()
    expect(body.content).not.toContain('"userId"')
    expect(body.content).not.toContain('"customerId"')
  })

  it('no-op when OPS_DISCORD_WEBHOOK_URL is not set', async () => {
    delete process.env.OPS_DISCORD_WEBHOOK_URL
    await notifyWebhookError({
      handler: 'stripe',
      eventId: 'evt_1',
      eventType: 'foo',
      err: new Error('e'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
