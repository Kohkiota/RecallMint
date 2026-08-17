// GET /api/study-days/pull の unit test (S-perf-3)。
// /api/cards/pull の test pattern を踏襲: auth / 未 sync / 正常 / DB error /
// Cache-Control を verify。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'
import type { ClientStudyDay } from '@/lib/client-db'

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/db/study-days-pull', () => ({
  getAllStudyDaysForUser: vi.fn(),
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
import { getAllStudyDaysForUser } from '@/lib/db/study-days-pull'
import { GET } from './route'

const FAKE_USER = { id: 'user-uuid-1' } as unknown as User

function fakeStudyDay(overrides?: Partial<ClientStudyDay>): ClientStudyDay {
  return {
    user_id: 'user-uuid-1',
    day: '2026-05-26',
    review_count: 5,
    correct_count: 3,
    distinct_card_count: 4,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/study-days/pull', () => {
  it('未ログイン → 401 + Cache-Control no-store + DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await GET()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getAllStudyDaysForUser).not.toHaveBeenCalled()
  })

  it('users 行が未 sync → 200 空配列 + no-store + DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      studyDays: ClientStudyDay[]
    }
    expect(body.studyDays).toEqual([])
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getAllStudyDaysForUser).not.toHaveBeenCalled()
  })

  it('正常 (0 件): 空配列', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllStudyDaysForUser).mockResolvedValue([])
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      studyDays: ClientStudyDay[]
    }
    expect(body.studyDays).toEqual([])
  })

  it('正常 (N 件): studyDays 配列 + getAllStudyDaysForUser は user.id で呼ばれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const rows = [
      fakeStudyDay({ day: '2026-05-25' }),
      fakeStudyDay({ day: '2026-05-26' }),
    ]
    vi.mocked(getAllStudyDaysForUser).mockResolvedValue(rows)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      studyDays: ClientStudyDay[]
    }
    expect(body.studyDays).toHaveLength(2)
    expect(body.studyDays[0]?.day).toBe('2026-05-25')
    expect(getAllStudyDaysForUser).toHaveBeenCalledWith(
      'user-uuid-1',
      expect.anything(),
    )
    expect(getAllStudyDaysForUser).toHaveBeenCalledTimes(1)
  })

  it('DB エラー → 500 + Cache-Control no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllStudyDaysForUser).mockRejectedValue(new Error('neon down'))
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })

  // ---------------------------------------------------------------------------
  // owner echo (tag mirror hygiene sprint task 1 / spec §2, §9-1 pin ⑤)
  // ---------------------------------------------------------------------------
  it('正常応答の top-level に owner_user_id: user.id が載る', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllStudyDaysForUser).mockResolvedValue([])
    const res = await GET()
    const body = (await res.json()) as { owner_user_id?: string }
    expect(body.owner_user_id).toBe('user-uuid-1')
  })

  it('emptyBody (users 行未 sync) には owner_user_id が載らない (静的リテラルの構造的帰結)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await GET()
    const body = await res.json()
    expect(body).not.toHaveProperty('owner_user_id')
  })
})
