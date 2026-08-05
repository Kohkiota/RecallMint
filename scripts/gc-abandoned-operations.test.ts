import { describe, it, expect, vi } from 'vitest'
import {
  runAbandonedOperationsSweep,
  parseUserFlag,
  type AbandonedOpCandidate,
  type AbandonedOpsSweepDeps,
} from './gc-abandoned-operations'

// ②-4a T14a fix round 2(Codex residual): unit test for the DI core
// (`runAbandonedOperationsSweep`), following the same style as
// `gc-image-assets.test.ts` (fake deps, no real DB — the underlying SQL
// predicate `isLiveUploadOperationCondition` this script's production deps
// reuse is already exhaustively iso-tested via reconcile-stale-processing.test.ts
// and getExamStatusMap's live-op tests; this file focuses on the sweep's own
// orchestration: dry-run vs write, count aggregation, and the fenced-CAS
// "raced away" (0-row terminate) case).

const OP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function makeCandidate(id: string, overrides: Partial<AbandonedOpCandidate> = {}): AbandonedOpCandidate {
  return {
    id,
    userId: USER_ID,
    status: 'processing',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function makeDeps(
  candidates: AbandonedOpCandidate[],
  overrides: Partial<AbandonedOpsSweepDeps> = {},
): AbandonedOpsSweepDeps & { terminateMock: ReturnType<typeof vi.fn>; logMock: ReturnType<typeof vi.fn> } {
  const terminateMock = vi.fn(async () => true)
  const logMock = vi.fn()
  return {
    fetchCandidates: vi.fn(async () => candidates),
    terminate: terminateMock,
    log: logMock,
    ...overrides,
    terminateMock,
    logMock,
  } as AbandonedOpsSweepDeps & { terminateMock: typeof terminateMock; logMock: typeof logMock }
}

describe('runAbandonedOperationsSweep', () => {
  it('dry-run: does not call terminate, reports scanned candidates as the would-be-terminated set, writes nothing', async () => {
    const candidates = [makeCandidate(OP_A), makeCandidate(OP_B)]
    const deps = makeDeps(candidates)

    const summary = await runAbandonedOperationsSweep({ dryRun: true }, deps)

    expect(summary).toEqual({ scanned: 2, terminated: 0, ids: [OP_A, OP_B] })
    expect(deps.terminateMock).not.toHaveBeenCalled()
    expect(deps.logMock).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'))
    expect(deps.logMock).toHaveBeenCalledWith(expect.stringContaining(OP_A))
  })

  it('dry-run with zero candidates: reports an empty summary without a dangling id list', async () => {
    const deps = makeDeps([])

    const summary = await runAbandonedOperationsSweep({ dryRun: true }, deps)

    expect(summary).toEqual({ scanned: 0, terminated: 0, ids: [] })
    expect(deps.terminateMock).not.toHaveBeenCalled()
  })

  it('real run: terminates every fetched candidate and reports the terminated id set', async () => {
    const candidates = [makeCandidate(OP_A), makeCandidate(OP_B)]
    const deps = makeDeps(candidates)

    const summary = await runAbandonedOperationsSweep({ dryRun: false }, deps)

    expect(deps.terminateMock).toHaveBeenCalledTimes(2)
    expect(deps.terminateMock).toHaveBeenNthCalledWith(1, OP_A, USER_ID)
    expect(deps.terminateMock).toHaveBeenNthCalledWith(2, OP_B, USER_ID)
    expect(summary).toEqual({ scanned: 2, terminated: 2, ids: [OP_A, OP_B] })
  })

  it('real run: a candidate raced away between fetch and terminate (fenced CAS returns false) is excluded from the terminated count/ids', async () => {
    const candidates = [makeCandidate(OP_A), makeCandidate(OP_B)]
    const terminateMock = vi.fn(async (id: string) => id !== OP_B) // OP_B "won" a re-claim race
    const deps = makeDeps(candidates, { terminate: terminateMock })

    const summary = await runAbandonedOperationsSweep({ dryRun: false }, deps)

    expect(summary).toEqual({ scanned: 2, terminated: 1, ids: [OP_A] })
  })

  it('real run with zero candidates: no-op, scanned/terminated both 0', async () => {
    const deps = makeDeps([])

    const summary = await runAbandonedOperationsSweep({ dryRun: false }, deps)

    expect(summary).toEqual({ scanned: 0, terminated: 0, ids: [] })
    expect(deps.terminateMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// parseUserFlag — identical contract to gc-image-assets.ts / backfill-card-
// asset-refs.ts (intentionally duplicated small CLI helper; same test shape).
// ---------------------------------------------------------------------------
describe('parseUserFlag', () => {
  it('returns undefined when --user is absent (all-users run)', () => {
    expect(parseUserFlag(['--dry-run'])).toBeUndefined()
  })

  it('returns the value following --user', () => {
    expect(parseUserFlag(['--user', USER_ID])).toBe(USER_ID)
  })

  it('throws when --user has no following value', () => {
    expect(() => parseUserFlag(['--user'])).toThrow(/requires a userId value/)
  })

  it('throws when --user is immediately followed by another flag (missing value footgun)', () => {
    expect(() => parseUserFlag(['--user', '--dry-run'])).toThrow(/requires a userId value/)
  })
})
