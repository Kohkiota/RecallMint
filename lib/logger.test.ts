import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { logger } from './logger'

describe('logger', () => {
  let logSpy: MockInstance
  let warnSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('logger.info routes to console.log only', () => {
    logger.info({ event: 'startup' })
    expect(logSpy).toHaveBeenCalledOnce()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logger.warn routes to console.warn only', () => {
    logger.warn({ event: 'ops.notify.fetch_failed' })
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logger.error routes to console.error only', () => {
    logger.error({ event: 'webhook.stripe.bad_signature' })
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('output JSON includes auto-attached level/timestamp/environment/event fields', () => {
    logger.error({ event: 'webhook.stripe.bad_signature', err: new Error('boom') })
    const json = errorSpy.mock.calls[0][0] as string
    const parsed = JSON.parse(json)
    expect(parsed).toMatchObject({
      level: 'error',
      event: 'webhook.stripe.bad_signature',
    })
    expect(parsed.environment).toBeDefined()
    // ISO 8601 round-trip 確認
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp)
  })

  it('expands Error to {name, message, stack} and replaces circular refs with [Circular]', () => {
    const err = new Error('boom')
    const circular: { foo: number; self?: unknown } = { foo: 1 }
    circular.self = circular
    logger.error({ event: 'x', err, ctx: circular })
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string)
    expect(parsed.err).toMatchObject({ name: 'Error', message: 'boom' })
    expect(typeof parsed.err.stack).toBe('string')
    expect(parsed.ctx).toEqual({ foo: 1, self: '[Circular]' })
  })

  it('does not throw on unsupported types (BigInt) and emits fallback', () => {
    expect(() => {
      logger.error({ event: 'x', big: BigInt(123) } as unknown as { event: string })
    }).not.toThrow()
    const lastCall = errorSpy.mock.calls[errorSpy.mock.calls.length - 1][0] as string
    expect(lastCall).toContain('[logger fallback]')
    expect(lastCall).toContain('event=x')
  })

  describe('warnFromError', () => {
    // Sync-fix-1 audit §10.2 (a) #11: 旧 `err: String(err)` boilerplate を helper
    // 1 行に置換、 Error を expandError 経由で構造化保持。

    it('routes to console.warn with event + ctx merged and Error expanded', () => {
      const err = new Error('boom')
      logger.warnFromError('tag_category_delete.count_failed', { categoryId: 'cat-1' }, err)
      expect(warnSpy).toHaveBeenCalledOnce()
      expect(logSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string)
      expect(parsed).toMatchObject({
        level: 'warn',
        event: 'tag_category_delete.count_failed',
        categoryId: 'cat-1',
        err: { name: 'Error', message: 'boom' },
      })
      // 旧 String(err) 経路では stack を捨てていた。 helper は Error を保持し expandError 展開する。
      expect(typeof parsed.err.stack).toBe('string')
    })

    it('handles non-Error err (string / unknown) without throwing', () => {
      logger.warnFromError('x', { ctxKey: 'v' }, 'plain string err')
      const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string)
      expect(parsed.err).toBe('plain string err')
      expect(parsed.ctxKey).toBe('v')
    })
  })
})
