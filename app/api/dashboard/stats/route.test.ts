// GET /api/dashboard/stats の unit test。
// 既存 `app/api/exams/status/route.test.ts` の pattern を踏襲: getCurrentUser /
// getReviewStatsForUser を mock し、 auth / 正常系 / 未 sync / DB エラーを検証。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/db/streak', () => ({
  getReviewStatsForUser: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
// RLS-P2: route は withTenantTx(userId, ...) で helper を包む。unit test では DB に
// 触れないよう getDb を stub し、withTenantTx は fn(fakeTx) を直呼びする。
vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }))
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: vi.fn(
    async (_userId: string, fn: (tx: unknown) => unknown) => fn({}),
  ),
}))

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getReviewStatsForUser } from '@/lib/db/streak'
import { GET } from './route'

const FAKE_USER = { id: 'user-uuid-1' } as unknown as User

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/dashboard/stats', () => {
  it('未ログイン (UnauthenticatedError) → 401、 DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await GET()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getReviewStatsForUser).not.toHaveBeenCalled()
  })

  it('users 行が未 sync (null) → 200 空 stats、 DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ todayCardCount: 0, streak: 0 })
    expect(getReviewStatsForUser).not.toHaveBeenCalled()
  })

  it('正常系: getReviewStatsForUser を user.id で呼び、 戻り値をそのまま返す', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getReviewStatsForUser).mockResolvedValue({
      todayCardCount: 7,
      streak: 4,
    })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ todayCardCount: 7, streak: 4 })
    expect(getReviewStatsForUser).toHaveBeenCalledWith(
      'user-uuid-1',
      expect.anything(),
    )
  })

  it('DB エラー → 500、 Cache-Control no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getReviewStatsForUser).mockRejectedValue(new Error('neon down'))
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })

  it('成功 / 401 / 500 すべてに Cache-Control no-store が付く', async () => {
    // 401 path
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new UnauthenticatedError())
    expect((await GET()).headers.get('Cache-Control')).toContain('no-store')
    // 200 (未 sync) path
    vi.mocked(getCurrentUser).mockResolvedValueOnce(null)
    expect((await GET()).headers.get('Cache-Control')).toContain('no-store')
    // 200 (正常) path
    vi.mocked(getCurrentUser).mockResolvedValueOnce(FAKE_USER)
    vi.mocked(getReviewStatsForUser).mockResolvedValueOnce({
      todayCardCount: 0,
      streak: 0,
    })
    expect((await GET()).headers.get('Cache-Control')).toContain('no-store')
  })
})
