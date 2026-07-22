import { describe, it, expect, vi, beforeEach } from 'vitest'

// recordIntegrationFailure を mock して「reportRlsContextFailure が正しい catalog key +
// PII 非搭載 context で呼ぶ / 非 P0RLS では呼ばない / 記録失敗を握って再 throw しない」
// を pin する。isP0RLS は実装 (lib/db/p0rls.ts) をそのまま使い、.cause chain walk の
// 実挙動を検証する。
const { mockRecord, mockLoggerError } = vi.hoisted(() => ({
  mockRecord: vi.fn().mockResolvedValue(undefined),
  mockLoggerError: vi.fn(),
}))

vi.mock('@/lib/integration-failures', () => ({
  recordIntegrationFailure: mockRecord,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: mockLoggerError },
}))

import { reportRlsContextFailure } from './report-rls-context-failure'

// SQLSTATE 'P0RLS' を top-level .code に持つ error。
function p0rlsTopLevel(): Error {
  const e = new Error('app_current_user_id: tenant context missing')
  ;(e as Error & { code: string }).code = 'P0RLS'
  return e
}

// drizzle wrap 相当: top-level は無害な wrapper、実 SQLSTATE は .cause に載る。
function p0rlsNestedInCause(): Error {
  const inner = new Error('P0RLS raise')
  ;(inner as Error & { code: string }).code = 'P0RLS'
  const outer = new Error('Failed query: ...') as Error & { cause: unknown }
  outer.cause = inner
  return outer
}

const CTX = { route: 'delete-exam', op: 'delete' } as const

beforeEach(() => {
  vi.clearAllMocks()
  mockRecord.mockResolvedValue(undefined)
})

describe('reportRlsContextFailure', () => {
  // (a) top-level P0RLS → 記録される。catalog key + context が route/op のみ。
  it('records with rls_context_missing key and a PII-free {route, op} context on a P0RLS error', async () => {
    await reportRlsContextFailure(p0rlsTopLevel(), CTX)

    expect(mockRecord).toHaveBeenCalledTimes(1)
    const arg = mockRecord.mock.calls[0][0] as Record<string, unknown>
    expect(arg.key).toBe('rls_context_missing')
    expect(arg.context).toEqual({ route: 'delete-exam', op: 'delete' })
  })

  // (a-nested) P0RLS が .cause に埋まっていても記録される (= .cause walk が効いている)。
  it('records when P0RLS is nested in the .cause chain (drizzle wrap shape)', async () => {
    await reportRlsContextFailure(p0rlsNestedInCause(), {
      route: 'review-events/bulk',
      op: 'ingest',
    })
    expect(mockRecord).toHaveBeenCalledTimes(1)
    const arg = mockRecord.mock.calls[0][0] as Record<string, unknown>
    expect(arg.key).toBe('rls_context_missing')
    expect(arg.context).toEqual({ route: 'review-events/bulk', op: 'ingest' })
  })

  // PII 非搭載の厳格 pin: context の key は route/op の 2 つだけ。userId 等は渡さない。
  it('does not leak PII: context keys are exactly [route, op] and no userId is passed', async () => {
    await reportRlsContextFailure(p0rlsTopLevel(), {
      route: 'entity-mutations/bulk',
      op: 'mutation',
    })
    const arg = mockRecord.mock.calls[0][0] as Record<string, unknown>
    const context = arg.context as Record<string, unknown>
    // context は route/op のみ (UUID / query 値 / userId の混入なし)
    expect(Object.keys(context).sort()).toEqual(['op', 'route'])
    // top-level args にも userId を渡さない (alert PII-free 契約)
    expect(arg.userId).toBeUndefined()
    // 念のため PII 系 key が args のどこにも無いこと
    for (const k of ['userId', 'clerkId', 'stripeCustomerId', 'errorMessage']) {
      expect(arg[k]).toBeUndefined()
    }
  })

  // (b) 非 P0RLS → 記録しない (通常の失敗経路に副作用ゼロ)。
  it('does NOT record on a non-P0RLS error (short-circuit)', async () => {
    const plain = new Error('serialization failure')
    ;(plain as Error & { code: string }).code = '40001'
    await reportRlsContextFailure(plain, CTX)
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('does NOT record on a bare Error with no code / cause', async () => {
    await reportRlsContextFailure(new Error('boom'), CTX)
    expect(mockRecord).not.toHaveBeenCalled()
  })

  // (c) recordIntegrationFailure が reject しても reportRlsContextFailure は throw しない
  //     (既存 catch の内側から呼ばれるため原例外を mask/変更してはならない)。
  it('swallows a recordIntegrationFailure rejection and does not throw', async () => {
    mockRecord.mockRejectedValue(new Error('OPS_DISCORD_WEBHOOK_URL must be set'))
    await expect(
      reportRlsContextFailure(p0rlsTopLevel(), CTX),
    ).resolves.toBeUndefined()
    // 握った失敗は log される (silent 消失しない)
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    const logArg = mockLoggerError.mock.calls[0][0] as Record<string, unknown>
    expect(logArg.event).toBe('rls.context_missing.report_failed')
  })
})
