import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClerkAPIResponseError } from '@clerk/nextjs/errors'

// ---------------------------------------------------------------------------
// Clerk SDK + integration-failures helper を hoisted mock。 Sprint 2 で site 3 は
// notifyOps を直接叩かず recordIntegrationFailure 経由の dual-write になったため、
// mock 対象を helper に切替 (INSERT→notifyOps は helper unit test で担保)。
// ---------------------------------------------------------------------------
const { mockUpdateUserMetadata, mockRecordIntegrationFailure } = vi.hoisted(() => ({
  mockUpdateUserMetadata: vi.fn(),
  mockRecordIntegrationFailure: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({
    users: { updateUserMetadata: mockUpdateUserMetadata },
  }),
}))

vi.mock('@/lib/integration-failures', () => ({
  recordIntegrationFailure: mockRecordIntegrationFailure,
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

  it('Clerk API が throw したら recordIntegrationFailure を呼び ok:false を返す (webhook 200 維持)', async () => {
    mockUpdateUserMetadata.mockRejectedValueOnce(new Error('Clerk 5xx'))
    const result = await syncClerkPublicMetadata({
      clerkId: 'user_1',
      dbUserId: 'db-uuid-1',
      plan: 'pro',
    })
    expect(result.ok).toBe(false)
    // Sprint 2 dual-write: catalog key clerk_sync + 型付き ref (clerkId / userId) +
    // errorMessage、 context は byte 不変 (clerkId / keys / error を verbatim)。
    expect(mockRecordIntegrationFailure).toHaveBeenCalledTimes(1)
    const [args] = mockRecordIntegrationFailure.mock.calls[0]!
    const a = args as {
      key: string
      clerkId: string
      userId?: string
      errorMessage: string
      subject: string
      context: { clerkId: string; keys: string[] }
    }
    expect(a.key).toBe('clerk_sync')
    expect(a.clerkId).toBe('user_1')
    expect(a.userId).toBe('db-uuid-1')
    expect(a.errorMessage).toBe('Clerk 5xx')
    expect(a.subject).toBe('clerk publicMetadata sync failed')
    expect(a.context.clerkId).toBe('user_1')
    expect(a.context.keys).toContain('plan')
    expect(a.context.keys).toContain('dbUserId')
  })

  it('dbUserId 未指定なら ref userId は undefined (ref は present 時のみ)', async () => {
    mockUpdateUserMetadata.mockRejectedValueOnce(new Error('Clerk 5xx'))
    await syncClerkPublicMetadata({ clerkId: 'user_1', plan: 'pro' })
    const [args] = mockRecordIntegrationFailure.mock.calls[0]!
    expect((args as { userId?: string }).userId).toBeUndefined()
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

    it('Clerk 404 では recordIntegrationFailure を fire せず (ledger 行なし) ok:true を返し、 console.debug を 1 回呼ぶ', async () => {
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

      // (1) recordIntegrationFailure が呼ばれていない = ledger 行なし (silent skip の
      // 中核。 404 = 同期対象不在 = 失敗でないので台帳に残さない)
      expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
      // (2) 戻り値は ok:true (user 不在 = 同期不要 = success の semantics)
      expect(result).toEqual({ ok: true })
      // (3) console.debug が 1 回呼出され、 第 1 引数に 'user not found' を含む
      expect(debugSpy).toHaveBeenCalledTimes(1)
      const [msg] = debugSpy.mock.calls[0]!
      expect(String(msg)).toContain('user not found')
    })
  })
})
