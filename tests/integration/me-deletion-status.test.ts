import { describe, it, expect, vi, beforeEach } from 'vitest'

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

function makeRequest(userId?: string): Request {
  const url = userId
    ? `http://localhost/api/me/deletion-status?userId=${userId}`
    : 'http://localhost/api/me/deletion-status'
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/me/deletion-status', () => {
  // Case 1: format violation (userId に user_ prefix なし) → 400 invalid
  it('userId format violation → 400 { error: "invalid" }', async () => {
    const req = makeRequest('foo')
    const res = await GET(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'invalid' })
    // DB は一切触らない
    expect(mockSelect).not.toHaveBeenCalled()
  })

  // Case 2: users 行なし → not_found
  it('users 行なし → 200 { status: "not_found" }', async () => {
    makeSelectChain([])
    const req = makeRequest('user_abc123')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'not_found' })
  })

  // Case 3: 行あり、deletedAt IS NULL → pending
  it('deletedAt IS NULL → 200 { status: "pending" }', async () => {
    makeSelectChain([{ clerkId: 'user_abc123', deletedAt: null, subscriptionStatus: 'active' }])
    const req = makeRequest('user_abc123')
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
    const req = makeRequest('user_abc123')
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
    const req = makeRequest('user_abc123')
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
    const req = makeRequest('user_abc123')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'completed' })
  })

  // Case 7: Cache-Control header が no-store を含む
  it('Cache-Control header が no-store を含む', async () => {
    makeSelectChain([])
    const req = makeRequest('user_abc123')
    const res = await GET(req)
    const cacheControl = res.headers.get('Cache-Control')
    expect(cacheControl).toContain('no-store')
  })
})
