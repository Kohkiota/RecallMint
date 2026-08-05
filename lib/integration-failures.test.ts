import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- hoisted mocks ---
const { mockDbInsert, mockDbInsertValues, mockNotifyOps, mockLoggerError } =
  vi.hoisted(() => {
    const values = vi.fn().mockResolvedValue(undefined)
    return {
      mockDbInsertValues: values,
      mockDbInsert: vi.fn().mockReturnValue({ values }),
      mockNotifyOps: vi.fn().mockResolvedValue(undefined),
      mockLoggerError: vi.fn(),
    }
  })

// RLS-P3 (Task 1): DATABASE_URL_APP is set in vitest.setup.ts, so the app-role
// branch of the ternary now resolves via getNonTenantDb() instead of getDb()
// (same underlying connection — mechanical mock-target rename, assertions
// unchanged). getAdminDb is unused here since that branch isn't exercised.
vi.mock('@/lib/db', () => ({
  getNonTenantDb: () => ({ insert: mockDbInsert }),
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: mockLoggerError },
}))

import {
  INTEGRATION_FAILURE_CATALOG,
  recordIntegrationFailure,
  type IntegrationFailureKey,
} from './integration-failures'
import { integrationFailures } from './db/schema'

const CATALOG_KEYS = Object.keys(
  INTEGRATION_FAILURE_CATALOG,
) as IntegrationFailureKey[]

beforeEach(() => {
  vi.clearAllMocks()
  mockDbInsertValues.mockResolvedValue(undefined)
  mockNotifyOps.mockResolvedValue(undefined)
})

describe('recordIntegrationFailure', () => {
  // (a) each of the 7 catalog keys → the 4-axis values inserted match the catalog
  it('inserts the 4-axis values from the catalog for every key', async () => {
    for (const key of CATALOG_KEYS) {
      vi.clearAllMocks()
      await recordIntegrationFailure({
        key,
        subject: 'test subject',
        context: { foo: 'bar' },
      })
      expect(mockDbInsert).toHaveBeenCalledWith(integrationFailures)
      const inserted = mockDbInsertValues.mock.calls[0][0] as Record<
        string,
        unknown
      >
      const entry = INTEGRATION_FAILURE_CATALOG[key]
      expect(inserted.service).toBe(entry.service)
      expect(inserted.operation).toBe(entry.operation)
      expect(inserted.workflow).toBe(entry.workflow)
      expect(inserted.failureCode).toBe(entry.failureCode)
    }
  })

  // (b) refs + context inserted verbatim
  it('inserts typed refs, errorMessage, and context verbatim', async () => {
    const context = { targetPriceId: 'price_123', detail: { a: 1 } }
    await recordIntegrationFailure({
      key: 'stripe_release',
      userId: 'user-uuid',
      clerkId: 'user_clerk',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      scheduleId: 'sub_sched_1',
      errorMessage: 'boom',
      subject: 'test subject',
      context,
    })
    const inserted = mockDbInsertValues.mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(inserted.userId).toBe('user-uuid')
    expect(inserted.clerkId).toBe('user_clerk')
    expect(inserted.stripeCustomerId).toBe('cus_1')
    expect(inserted.stripeSubscriptionId).toBe('sub_1')
    expect(inserted.scheduleId).toBe('sub_sched_1')
    expect(inserted.errorMessage).toBe('boom')
    expect(inserted.context).toEqual(context)
  })

  // (c) INSERT-before-notifyOps call order
  it('inserts before calling notifyOps', async () => {
    const order: string[] = []
    mockDbInsertValues.mockImplementation(async () => {
      order.push('insert')
    })
    mockNotifyOps.mockImplementation(async () => {
      order.push('notify')
    })
    await recordIntegrationFailure({
      key: 'clerk_sync',
      subject: 'test subject',
      context: {},
    })
    expect(order).toEqual(['insert', 'notify'])
  })

  // (d) INSERT failure → throw-safe, logger.error, notifyOps still called w/ ledgerWriteError
  it('is throw-safe on INSERT failure and still notifies with ledgerWriteError', async () => {
    mockDbInsertValues.mockRejectedValue(new Error('db down'))
    const context = { foo: 'bar' }
    await expect(
      recordIntegrationFailure({
        key: 'deletion_data',
        subject: 'test subject',
        context,
      }),
    ).resolves.toBeUndefined()

    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    const errPayload = mockLoggerError.mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(errPayload.event).toBe('integration_failures.insert_failed')

    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    const notifyContext = mockNotifyOps.mock.calls[0][1] as Record<
      string,
      unknown
    >
    expect(notifyContext.ledgerWriteError).toBe('db down')
  })

  // (e) notifyOps throw propagates out of the helper
  it('propagates a notifyOps throw', async () => {
    mockNotifyOps.mockRejectedValue(new Error('OPS_DISCORD_WEBHOOK_URL must be set'))
    await expect(
      recordIntegrationFailure({
        key: 'stripe_gate_mismatch',
        subject: 'test subject',
        context: {},
      }),
    ).rejects.toThrow('OPS_DISCORD_WEBHOOK_URL must be set')
  })

  // (f) byte-invariance: success path passes context unchanged; failure path adds only ledgerWriteError; input not mutated
  it('passes context to notifyOps unchanged on success (byte-invariant)', async () => {
    const context = { a: 1, nested: { b: 2 } }
    await recordIntegrationFailure({
      key: 'stripe_release',
      subject: 'test subject',
      context,
    })
    const notifyContext = mockNotifyOps.mock.calls[0][1]
    expect(notifyContext).toEqual(context)
  })

  it('does not mutate the caller input context on the success path', async () => {
    const context = { a: 1 }
    const snapshot = { ...context }
    await recordIntegrationFailure({
      key: 'stripe_release',
      subject: 'test subject',
      context,
    })
    expect(context).toEqual(snapshot)
  })

  it('adds only ledgerWriteError on the INSERT-failure path and does not mutate input', async () => {
    mockDbInsertValues.mockRejectedValue(new Error('db down'))
    const context = { a: 1, b: 2 }
    const snapshot = { ...context }
    await recordIntegrationFailure({
      key: 'clerk_sync',
      subject: 'test subject',
      context,
    })
    // input untouched
    expect(context).toEqual(snapshot)
    // notifyOps got a derived object = input + ledgerWriteError only
    const notifyContext = mockNotifyOps.mock.calls[0][1] as Record<
      string,
      unknown
    >
    expect(notifyContext).toEqual({ ...snapshot, ledgerWriteError: 'db down' })
  })

  // (g) all catalog entries have unique 4-axis tuples
  it('has a unique 4-axis tuple for every catalog entry', () => {
    const tuples = CATALOG_KEYS.map((k) => {
      const e = INTEGRATION_FAILURE_CATALOG[k]
      return JSON.stringify([e.service, e.operation, e.workflow, e.failureCode])
    })
    expect(new Set(tuples).size).toBe(tuples.length)
    // RLS-P3 Task 7: rls_context_missing 追加で 8 → 9。
    // ②-4a T14b: r2_gc_delete_source 追加で 9 → 10。
    // ②-4a 単一 invocation S-2: ocr_pipeline 追加で 10 → 11。
    expect(tuples.length).toBe(11)
  })

  // r2_gc_delete: image-GC spec §4.6 の 4 軸 tuple 固定値
  it('r2_gc_delete has the 4-axis values pinned by spec §4.6', () => {
    expect(INTEGRATION_FAILURE_CATALOG.r2_gc_delete).toEqual({
      service: 'r2',
      operation: 'object.delete',
      workflow: 'asset_gc',
      failureCode: 'external_api_error',
    })
  })

  // r2_gc_delete_source: ②-4a T14b(source_assets GC sweep)の 4 軸 tuple 固定値。
  // r2_gc_delete(assets lane)とは workflow で区別する(source_asset_gc)。
  it('r2_gc_delete_source has the 4-axis values pinned by T14b', () => {
    expect(INTEGRATION_FAILURE_CATALOG.r2_gc_delete_source).toEqual({
      service: 'r2',
      operation: 'object.delete',
      workflow: 'source_asset_gc',
      failureCode: 'external_api_error',
    })
  })

  // ocr_pipeline: ②-4a 単一 invocation S-2(upload OCR pipeline の予期しない
  // throw の catch-all)の 4 軸 tuple 固定値。service='app' は「外部 service では
  // なく自コード内のバグ」を表す(deletion_data の service='db' と同じ扱い)。
  it('ocr_pipeline has the 4-axis values pinned by S-2', () => {
    expect(INTEGRATION_FAILURE_CATALOG.ocr_pipeline).toEqual({
      service: 'app',
      operation: 'upload.ocr_pipeline',
      workflow: 'upload_single_invocation',
      failureCode: 'unexpected_error',
    })
  })

  // rls_context_missing: RLS-P3 Task 7 の P0RLS loud alert 用 4 軸 tuple 固定値
  it('rls_context_missing has the 4-axis values pinned by RLS-P3 Task 7', () => {
    expect(INTEGRATION_FAILURE_CATALOG.rls_context_missing).toEqual({
      service: 'db',
      operation: 'rls.context_missing',
      workflow: null,
      failureCode: 'state_mismatch',
    })
  })
})
