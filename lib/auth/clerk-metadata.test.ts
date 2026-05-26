import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Clerk SDK + ops module を hoisted mock。 clerk webhook test 同 pattern。
// ---------------------------------------------------------------------------
const { mockUpdateUserMetadata, mockNotifyOps } = vi.hoisted(() => ({
  mockUpdateUserMetadata: vi.fn(),
  mockNotifyOps: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({
    users: { updateUserMetadata: mockUpdateUserMetadata },
  }),
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
}))

import { syncClerkPublicMetadata } from './clerk-metadata'

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateUserMetadata.mockResolvedValue(undefined)
})

describe('syncClerkPublicMetadata', () => {
  it('dbUserId + plan を渡すと Clerk updateUserMetadata を 1 回呼出し ok:true を返す', async () => {
    const result = await syncClerkPublicMetadata({
      clerkId: 'user_1',
      dbUserId: 'db-uuid-1',
      plan: 'free',
    })
    expect(result.ok).toBe(true)
    expect(mockUpdateUserMetadata).toHaveBeenCalledTimes(1)
    expect(mockUpdateUserMetadata).toHaveBeenCalledWith('user_1', {
      publicMetadata: { dbUserId: 'db-uuid-1', plan: 'free' },
    })
  })

  it('plan のみ渡すと publicMetadata に plan のみが乗る (dbUserId 上書きしない)', async () => {
    const result = await syncClerkPublicMetadata({
      clerkId: 'user_1',
      plan: 'standard',
    })
    expect(result.ok).toBe(true)
    expect(mockUpdateUserMetadata).toHaveBeenCalledWith('user_1', {
      publicMetadata: { plan: 'standard' },
    })
  })

  it('dbUserId のみ渡すと publicMetadata に dbUserId のみが乗る', async () => {
    const result = await syncClerkPublicMetadata({
      clerkId: 'user_1',
      dbUserId: 'db-uuid-1',
    })
    expect(result.ok).toBe(true)
    expect(mockUpdateUserMetadata).toHaveBeenCalledWith('user_1', {
      publicMetadata: { dbUserId: 'db-uuid-1' },
    })
  })

  it('dbUserId / plan ともに未指定なら Clerk API を呼ばずに ok:true を返す (no-op)', async () => {
    const result = await syncClerkPublicMetadata({ clerkId: 'user_1' })
    expect(result.ok).toBe(true)
    expect(mockUpdateUserMetadata).not.toHaveBeenCalled()
  })

  it('Clerk API が throw したら notifyOps を呼び ok:false を返す (webhook 200 維持)', async () => {
    mockUpdateUserMetadata.mockRejectedValueOnce(new Error('Clerk 5xx'))
    const result = await syncClerkPublicMetadata({
      clerkId: 'user_1',
      plan: 'pro',
    })
    expect(result.ok).toBe(false)
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    const [, ctx] = mockNotifyOps.mock.calls[0]!
    expect((ctx as { clerkId: string }).clerkId).toBe('user_1')
    expect((ctx as { keys: string[] }).keys).toContain('plan')
  })

  it('Clerk API throw 時も throw せず resolve する (webhook 200 維持の不変条件)', async () => {
    mockUpdateUserMetadata.mockRejectedValueOnce(new Error('network'))
    await expect(
      syncClerkPublicMetadata({ clerkId: 'user_1', dbUserId: 'db' }),
    ).resolves.toEqual({ ok: false })
  })
})
