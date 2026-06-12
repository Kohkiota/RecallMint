import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signDeletionToken } from '@/lib/security/deletion-token'

// ---------------------------------------------------------------------------
// Fake db: select().from().where() chain で rows を返す。
// テストごとに mockSelect の実装を差し替えて users 行の有無を制御する。
// ---------------------------------------------------------------------------
const { mockSelect } = vi.hoisted(() => {
  const mockSelect = vi.fn()
  return { mockSelect }
})

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({ select: mockSelect })),
}))

import { GET } from '@/app/api/me/deletion-status/route'

// users 行なし = [] を返す helper
function makeSelectChain(rows: unknown[]) {
  // .select().from().where() の chain を模倣
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  }
  mockSelect.mockReturnValue(chain)
  return chain
}

// T-A9 (audit §10.4 #11): token は signed token に統一。 旧 userId 直渡し API は廃止。
function makeRequest(token?: string): Request {
  const url = token
    ? `http://localhost/api/me/deletion-status?token=${encodeURIComponent(token)}`
    : 'http://localhost/api/me/deletion-status'
  return new Request(url)
}

function tokenFor(userId: string, now?: number): string {
  return signDeletionToken(userId, now)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/me/deletion-status', () => {
  // Case 1: token 欠落 → 400 invalid (DB アクセスなし)
  it('token 欠落 → 400 { error: "invalid" }', async () => {
    const req = makeRequest()
    const res = await GET(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'invalid' })
    expect(mockSelect).not.toHaveBeenCalled()
  })

  // Case 2: users 行なし → not_found
  it('users 行なし → 200 { status: "not_found" }', async () => {
    makeSelectChain([])
    const req = makeRequest(tokenFor('user_abc123'))
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'not_found' })
  })

  // Case 3: 行あり、deletedAt IS NULL → pending
  it('deletedAt IS NULL → 200 { status: "pending" }', async () => {
    makeSelectChain([{ clerkId: 'user_abc123', deletedAt: null, subscriptionStatus: 'active' }])
    const req = makeRequest(tokenFor('user_abc123'))
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'pending' })
  })

  // Case 4: deletedAt set、subscriptionStatus='active' → clerk_synced
  it('deletedAt set, subscriptionStatus=active → 200 { status: "clerk_synced" }', async () => {
    makeSelectChain([
      {
        clerkId: 'user_abc123',
        deletedAt: new Date('2026-04-28T00:00:00Z'),
        subscriptionStatus: 'active',
      },
    ])
    const req = makeRequest(tokenFor('user_abc123'))
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'clerk_synced' })
  })

  // Case 5: deletedAt set、subscriptionStatus='canceled' → completed
  it('deletedAt set, subscriptionStatus=canceled → 200 { status: "completed" }', async () => {
    makeSelectChain([
      {
        clerkId: 'user_abc123',
        deletedAt: new Date('2026-04-28T00:00:00Z'),
        subscriptionStatus: 'canceled',
      },
    ])
    const req = makeRequest(tokenFor('user_abc123'))
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'completed' })
  })

  // Case 6: deletedAt set、subscriptionStatus IS NULL → completed
  it('deletedAt set, subscriptionStatus=null → 200 { status: "completed" }', async () => {
    makeSelectChain([
      {
        clerkId: 'user_abc123',
        deletedAt: new Date('2026-04-28T00:00:00Z'),
        subscriptionStatus: null,
      },
    ])
    const req = makeRequest(tokenFor('user_abc123'))
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'completed' })
  })

  // Case 7: Cache-Control header が no-store を含む
  it('Cache-Control header が no-store を含む', async () => {
    makeSelectChain([])
    const req = makeRequest(tokenFor('user_abc123'))
    const res = await GET(req)
    const cacheControl = res.headers.get('Cache-Control')
    expect(cacheControl).toContain('no-store')
  })

  // Case 8 (T-A9 新規): token 不正 (format) → 401 unauthorized、 DB 触らない
  it('token format 不正 → 401 { error: "unauthorized" }', async () => {
    const req = makeRequest('not-a-valid-token')
    const res = await GET(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: 'unauthorized' })
    expect(mockSelect).not.toHaveBeenCalled()
    // 401 path も no-store
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })

  // Case 9 (T-A9 新規): token 期限切れ → 410 Gone、 DB 触らない
  it('token 期限切れ → 410 { error: "token_expired" }', async () => {
    // 25h 前に sign した token → exp_ts < now で expired
    const past = Date.now() - 25 * 60 * 60 * 1000
    const expiredToken = signDeletionToken('user_abc123', past)
    const req = makeRequest(expiredToken)
    const res = await GET(req)
    expect(res.status).toBe(410)
    const body = await res.json()
    expect(body).toEqual({ error: 'token_expired' })
    expect(mockSelect).not.toHaveBeenCalled()
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })
})
