/**
 * tests/contract/_determinism.contract.test.ts
 *
 * Minimal contract test that proves the shared fixture stubs (clock + UUID)
 * produce stable snapshots across consecutive runs.
 *
 * Purpose:
 *   1. Give `pnpm test:contract` something runnable from day one.
 *   2. Demonstrate the stubClock + stubUUID pattern that Tasks 2-6 will
 *      replicate in their per-route contract tests.
 *   3. Verify snapshot stability: running `pnpm test:contract` twice
 *      must produce identical .snap content (no -u churn).
 *
 * This test does NOT call any route handler. It only exercises the
 * fixture infrastructure itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  FIXED_TIMESTAMP,
  FIXED_NOW_MS,
  FIXED_UUID,
  FIXED_USER_ID,
  stubClock,
  restoreClock,
  stubUUID,
  makeGetReq,
  makePostReq,
} from '../fixtures/common'

describe('_determinism: fixture stubs produce stable snapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubClock()
    stubUUID()
  })

  afterEach(() => {
    restoreClock()
    vi.restoreAllMocks()
  })

  it('clock stub: Date.now() and new Date().toISOString() are pinned to FIXED_TIMESTAMP', () => {
    expect(Date.now()).toBe(FIXED_NOW_MS)
    expect(new Date().toISOString()).toBe(FIXED_TIMESTAMP)
  })

  it('uuid stub: crypto.randomUUID() returns FIXED_UUID', () => {
    expect(crypto.randomUUID()).toBe(FIXED_UUID)
  })

  it('deterministic output object → stable toMatchSnapshot (run twice = identical .snap)', () => {
    // All fields pinned: clock for timestamps, uuid stub for IDs.
    // This snapshot will be identical across every consecutive run.
    const output = {
      timestamp: new Date().toISOString(),
      nowMs: Date.now(),
      id: crypto.randomUUID(),
      userId: FIXED_USER_ID,
    }
    expect(output).toMatchSnapshot()
  })

  it('makeGetReq: produces a deterministic Request shape', () => {
    const req = makeGetReq('http://x/api/pull')
    // Snapshot the observable request properties (not the Request object itself)
    expect({
      url: req.url,
      method: req.method,
    }).toMatchSnapshot()
  })

  it('makePostReq: produces a deterministic POST Request shape', () => {
    const body = { mutations: [], timestamp: new Date().toISOString() }
    const req = makePostReq('http://localhost/api/entity-mutations/bulk', body)
    expect({
      url: req.url,
      method: req.method,
      contentType: req.headers.get('content-type'),
    }).toMatchSnapshot()
  })
})
