import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClerkAPIResponseError } from '@clerk/nextjs/errors'

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

  // -------------------------------------------------------------------------
  // cache-fix roadmap ④-4: Clerk Backend API 404 silent skip。
  // 削除済 user に対する metadata sync は end state 一致 (= 同期不要) なので
  // notifyOps を fire しない。 観測性は console.debug 1 行で確保 (Vercel
  // function logs に raw 残置)。 設計: docs/superpowers/specs/2026-05-27-notify-ops-404-silent-skip-design.md
  // -------------------------------------------------------------------------
  describe('404 silent skip', () => {
    let debugSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // 404 path 専用の spy。 default level 出力されない console.debug を
      // テスト中に拾うため、 mockImplementation で no-op 化しつつ呼出を記録。
      debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    })

    afterEach(() => {
      debugSpy.mockRestore()
    })

    it('Clerk 404 では notifyOps を fire せず ok:true を返し、 console.debug を 1 回呼ぶ', async () => {
      // ClerkAPIResponseError(status=404) を inject。 isClerkAPIResponseError
      // type guard を通すために実 SDK class を使用。
      const err = new ClerkAPIResponseError('Not Found', {
        data: [],
        status: 404,
        clerkTraceId: 'test-trace',
      })
      mockUpdateUserMetadata.mockRejectedValueOnce(err)

      const result = await syncClerkPublicMetadata({
        clerkId: 'user_deleted',
        plan: 'free',
      })

      // (1) notifyOps が呼ばれていない (silent skip の中核)
      expect(mockNotifyOps).not.toHaveBeenCalled()
      // (2) 戻り値は ok:true (user 不在 = 同期不要 = success の semantics)
      expect(result).toEqual({ ok: true })
      // (3) console.debug が 1 回呼出され、 第 1 引数に 'user not found' を含む
      expect(debugSpy).toHaveBeenCalledTimes(1)
      const [msg] = debugSpy.mock.calls[0]!
      expect(String(msg)).toContain('user not found')
    })
  })
})
