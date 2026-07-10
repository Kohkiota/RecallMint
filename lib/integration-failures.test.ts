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

vi.mock('@/lib/db', () => ({
  getDb: () => ({ insert: mockDbInsert }),
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

  // (g) all 7 catalog entries have unique 4-axis tuples
  it('has a unique 4-axis tuple for every catalog entry', () => {
    const tuples = CATALOG_KEYS.map((k) => {
      const e = INTEGRATION_FAILURE_CATALOG[k]
      return JSON.stringify([e.service, e.operation, e.workflow, e.failureCode])
    })
    expect(new Set(tuples).size).toBe(tuples.length)
    expect(tuples.length).toBe(7)
  })
})
