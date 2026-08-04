// ②-4a T14a fix round 3(Codex + canonical Critical, both reproduced against
// real PG17): real-PG verification of `isLiveUploadOperationCondition()`'s
// NULL-safety, exercised through the ACTUAL query
// `scripts/gc-abandoned-operations.ts` runs in production
// (`buildProductionDeps`), not a re-typed duplicate.
//
// Why this needs real PG (a DI-mock test structurally cannot catch this):
// `lease_expires_at IS NULL` is the DOMINANT abandoned state (prepare-upload
// never sets a lease; every retryable-failure path resets
// `leaseExpiresAt: null`). Pre-fix, `isLiveUploadOperationCondition()`'s
// lease branch (`leaseExpiresAt > now()`) evaluated to SQL NULL (not false)
// when the lease was null. For an aged-out row: `false OR NULL = NULL` →
// the whole predicate is NULL. The sweep's WHERE uses
// `not(isLiveUploadOperationCondition())` → `not(NULL) = NULL`, and Postgres
// WHERE treats NULL as false → the row was silently excluded — the sweep
// found nothing for exactly the case it exists to clean. A DI-mock test
// (`scripts/gc-abandoned-operations.test.ts`) can't model this: it fakes
// `fetchCandidates`/`terminate` directly, so it never evaluates real SQL
// three-valued logic.
//
// `buildProductionDeps` is bound to `getFixtureOwnerDb()` (schema-less owner
// connection to the real test DB) instead of `getAdminDb()` (which requires
// `DATABASE_URL_ADMIN` — unset in the iso harness, which only hard-sets
// `DATABASE_URL_APP`). `select`/`update` are not `TSchema`-generic-dependent
// in drizzle, so this is structurally valid (see the `SweepDb` type comment
// in the script) and exercises the identical query, not a duplicate.
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { exams, uploadOperations, users } from '@/lib/db/schema'
import { PREPARED_RETENTION_MS } from '@/lib/exams/derive-exam-statuses'
import {
  buildProductionDeps,
  runAbandonedOperationsSweep,
} from '@/scripts/gc-abandoned-operations'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

async function seedUser(): Promise<string> {
  const owner = getFixtureOwnerDb()
  const userId = randomUUID()
  await owner.insert(users).values({ id: userId, clerkId: `clerk_${userId}` })
  return userId
}

async function seedExam(userId: string): Promise<string> {
  const owner = getFixtureOwnerDb()
  const examId = randomUUID()
  await owner.insert(exams).values({ id: examId, userId, name: 'exam' })
  return examId
}

async function seedOp(
  userId: string,
  examId: string,
  overrides: Partial<{
    status:
      | 'awaiting_sources'
      | 'claimed'
      | 'prepared'
      | 'processing'
      | 'completed'
      | 'terminal_failed'
    createdAt: Date
    leaseExpiresAt: Date | null
  }> = {},
): Promise<string> {
  const owner = getFixtureOwnerDb()
  const operationId = randomUUID()
  await owner.insert(uploadOperations).values({
    id: operationId,
    userId,
    idempotencyKey: `idem-${operationId}`,
    examId,
    status: overrides.status ?? 'awaiting_sources',
    expectedSourceCount: 1,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {}),
  })
  return operationId
}

async function readOp(operationId: string) {
  const owner = getFixtureOwnerDb()
  const rows = await owner.select().from(uploadOperations).where(eq(uploadOperations.id, operationId))
  return rows[0]!
}

const PAST_RETENTION = new Date(Date.now() - PREPARED_RETENTION_MS - 60_000) // 7日+1分前
const WITHIN_RETENTION = new Date(Date.now() - (PREPARED_RETENTION_MS - 60_000)) // 7日-1分前

beforeEach(async () => {
  await truncateAllUserTables()
})

describe('gc-abandoned-operations — real-PG NULL-lease sweep (T14a fix round 3)', () => {
  it('THE CRITICAL CASE: an abandoned op past retention with lease_expires_at = NULL (the dominant abandoned state) IS swept to terminal_failed + payload NULL', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const operationId = await seedOp(userId, examId, {
      status: 'awaiting_sources',
      createdAt: PAST_RETENTION,
      leaseExpiresAt: null, // dominant abandoned state: never claimed, no lease ever set
    })
    const payload = { schemaVersion: 1, marker: 'should-be-nulled' }
    await getFixtureOwnerDb()
      .update(uploadOperations)
      .set({ preparedPayload: payload })
      .where(eq(uploadOperations.id, operationId))

    const db = getFixtureOwnerDb()
    const summary = await runAbandonedOperationsSweep(
      { dryRun: false, userId },
      buildProductionDeps(db, userId),
    )

    expect(summary).toEqual({ scanned: 1, terminated: 1, ids: [operationId] })
    const row = await readOp(operationId)
    expect(row.status).toBe('terminal_failed')
    expect(row.preparedPayload).toBeNull()
    expect(row.lastErrorCode).toBe('abandoned_retention_exceeded')
  })

  it('an abandoned op past retention with an EXPIRED (non-null) lease is also swept', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const operationId = await seedOp(userId, examId, {
      status: 'claimed',
      createdAt: PAST_RETENTION,
      leaseExpiresAt: new Date(Date.now() - 60_000), // expired, but not null
    })

    const db = getFixtureOwnerDb()
    const summary = await runAbandonedOperationsSweep(
      { dryRun: false, userId },
      buildProductionDeps(db, userId),
    )

    expect(summary).toEqual({ scanned: 1, terminated: 1, ids: [operationId] })
    expect((await readOp(operationId)).status).toBe('terminal_failed')
  })

  // 'processing' = ②-4a 単一 invocation 経路(submit-upload.ts)の実行中状態。
  // sweep の非終端集合に含まれないと、死んだ invocation が残した op が永久に
  // 掃かれず prepared_payload(PII)も NULL 化されない。
  it('an abandoned PROCESSING op (new single-invocation path) past retention is swept', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const operationId = await seedOp(userId, examId, {
      status: 'processing',
      createdAt: PAST_RETENTION,
      leaseExpiresAt: new Date(Date.now() - 60_000), // 失効済
    })

    const db = getFixtureOwnerDb()
    const summary = await runAbandonedOperationsSweep(
      { dryRun: false, userId },
      buildProductionDeps(db, userId),
    )

    expect(summary).toEqual({ scanned: 1, terminated: 1, ids: [operationId] })
    expect((await readOp(operationId)).status).toBe('terminal_failed')
  })

  it('a WITHIN-retention non-terminal op (null lease) is NOT swept (still resumable)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const operationId = await seedOp(userId, examId, {
      status: 'claimed',
      createdAt: WITHIN_RETENTION,
      leaseExpiresAt: null,
    })

    const db = getFixtureOwnerDb()
    const summary = await runAbandonedOperationsSweep(
      { dryRun: false, userId },
      buildProductionDeps(db, userId),
    )

    expect(summary).toEqual({ scanned: 0, terminated: 0, ids: [] })
    expect((await readOp(operationId)).status).toBe('claimed')
  })

  it('a past-retention op with a currently VALID lease is NOT swept (concurrently-advancing operation must not be clobbered)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const operationId = await seedOp(userId, examId, {
      status: 'claimed',
      createdAt: PAST_RETENTION,
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // valid
    })

    const db = getFixtureOwnerDb()
    const summary = await runAbandonedOperationsSweep(
      { dryRun: false, userId },
      buildProductionDeps(db, userId),
    )

    expect(summary).toEqual({ scanned: 0, terminated: 0, ids: [] })
    expect((await readOp(operationId)).status).toBe('claimed')
  })

  it('dry-run: reports the null-lease abandoned op as a would-be-terminated candidate but writes nothing', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const operationId = await seedOp(userId, examId, {
      status: 'awaiting_sources',
      createdAt: PAST_RETENTION,
      leaseExpiresAt: null,
    })

    const db = getFixtureOwnerDb()
    const summary = await runAbandonedOperationsSweep(
      { dryRun: true, userId },
      buildProductionDeps(db, userId),
    )

    expect(summary).toEqual({ scanned: 1, terminated: 0, ids: [operationId] })
    // no write: status/lease untouched.
    expect((await readOp(operationId)).status).toBe('awaiting_sources')
  })

  it('a terminal (completed) op is never a candidate, regardless of age or lease state', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const operationId = await seedOp(userId, examId, {
      status: 'completed',
      createdAt: PAST_RETENTION,
      leaseExpiresAt: null,
    })

    const db = getFixtureOwnerDb()
    const summary = await runAbandonedOperationsSweep(
      { dryRun: false, userId },
      buildProductionDeps(db, userId),
    )

    expect(summary).toEqual({ scanned: 0, terminated: 0, ids: [] })
    expect((await readOp(operationId)).status).toBe('completed')
  })
})
