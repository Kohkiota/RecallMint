import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}))

import { auth } from '@clerk/nextjs/server'

describe('getAuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('userId が null なら UnauthenticatedError を throw', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null, sessionClaims: null } as never)

    const { getAuthContext } = await import('./ensure-user')
    const { UnauthenticatedError } = await import('./errors')

    await expect(getAuthContext()).rejects.toBeInstanceOf(UnauthenticatedError)
  })

  it('userId のみで sessionClaims null → clerkId + dbUserId/plan undefined を返す (template 未浸透の degraded mode)', async () => {
    vi.mocked(auth).mockResolvedValue({
      userId: 'user_1',
      sessionClaims: null,
    } as never)

    const { getAuthContext } = await import('./ensure-user')
    const ctx = await getAuthContext()

    expect(ctx).toEqual({
      clerkId: 'user_1',
      dbUserId: undefined,
      plan: undefined,
    })
  })

  it('userId + sessionClaims.dbUserId + sessionClaims.plan → 全 field を返す (通常 path)', async () => {
    vi.mocked(auth).mockResolvedValue({
      userId: 'user_1',
      sessionClaims: {
        dbUserId: '00000000-0000-0000-0000-000000000001',
        plan: 'standard',
      },
    } as never)

    const { getAuthContext } = await import('./ensure-user')
    const ctx = await getAuthContext()

    expect(ctx).toEqual({
      clerkId: 'user_1',
      dbUserId: '00000000-0000-0000-0000-000000000001',
      plan: 'standard',
    })
  })

  it('userId + sessionClaims.dbUserId のみ (plan 未浸透) → dbUserId 返し plan は undefined', async () => {
    vi.mocked(auth).mockResolvedValue({
      userId: 'user_1',
      sessionClaims: {
        dbUserId: '00000000-0000-0000-0000-000000000002',
      },
    } as never)

    const { getAuthContext } = await import('./ensure-user')
    const ctx = await getAuthContext()

    expect(ctx.dbUserId).toBe('00000000-0000-0000-0000-000000000002')
    expect(ctx.plan).toBeUndefined()
  })

  it('userId + sessionClaims.plan のみ (dbUserId 未浸透) → plan 返し dbUserId は undefined', async () => {
    vi.mocked(auth).mockResolvedValue({
      userId: 'user_1',
      sessionClaims: { plan: 'pro' },
    } as never)

    const { getAuthContext } = await import('./ensure-user')
    const ctx = await getAuthContext()

    expect(ctx.dbUserId).toBeUndefined()
    expect(ctx.plan).toBe('pro')
  })
})
