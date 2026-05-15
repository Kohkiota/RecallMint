import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DB } from '@/lib/db'
import type { User } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// Clerk server module mock — only the auth() API is used now.
// (clerkClient was removed in R2 webhook-only sync; getCurrentUser no longer
// calls clerkClient.users.getUser — see spec §3.1.)
// ---------------------------------------------------------------------------
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}))

// `getDb()` is mocked per-test so getCurrentUser reads from a fake DB.
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { auth } from '@clerk/nextjs/server'
import { getDb } from '@/lib/db'

// ---------------------------------------------------------------------------
// Fake DB factory — produces a minimal Drizzle-shaped `select().from().where().limit()` chain.
// Returns the supplied rows from the single SELECT call getCurrentUser issues.
// ---------------------------------------------------------------------------
function makeFakeDb(rows: User[]) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(rows)),
      })),
    })),
  }))
  const insert = vi.fn()
  return { select, insert } as unknown as DB
}

// ---------------------------------------------------------------------------
// Helper to build a minimal User row
// ---------------------------------------------------------------------------
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    clerkId: 'user_1',
    email: 'test@example.com',
    stripeCustomerId: null,
    plan: 'free',
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// getCurrentUser — webhook-only sync (R2): pure DB lookup, returns User | null.
// ---------------------------------------------------------------------------
describe('getCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('userId が null なら UnauthenticatedError を throw', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never)

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const { UnauthenticatedError } = await import('@/lib/auth/errors')

    await expect(getCurrentUser()).rejects.toBeInstanceOf(UnauthenticatedError)
  })

  it('userId あり / DB に行あり / deletedAt null → User を返す', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_1' } as never)
    const row = makeUser({ clerkId: 'user_1', deletedAt: null })
    vi.mocked(getDb).mockReturnValue(makeFakeDb([row]) as never)

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const result = await getCurrentUser()

    expect(result).not.toBeNull()
    expect(result?.clerkId).toBe('user_1')
    expect(result?.deletedAt).toBeNull()
  })

  it('userId あり / DB に行あり / deletedAt セット → 行をそのまま返す（caller が判定）', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_1' } as never)
    const deletedAt = new Date('2026-01-01T00:00:00Z')
    const row = makeUser({ clerkId: 'user_1', deletedAt })
    vi.mocked(getDb).mockReturnValue(makeFakeDb([row]) as never)

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const result = await getCurrentUser()

    expect(result).not.toBeNull()
    expect(result?.deletedAt).toEqual(deletedAt)
  })

  it('userId あり / DB 行欠損（webhook race）→ null を返す', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_1' } as never)
    vi.mocked(getDb).mockReturnValue(makeFakeDb([]) as never)

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const result = await getCurrentUser()

    expect(result).toBeNull()
  })
})
