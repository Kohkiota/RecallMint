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
      now: string
    }
    expect(body.studyDays).toEqual([])
    expect(typeof body.now).toBe('string')
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getAllStudyDaysForUser).not.toHaveBeenCalled()
  })

  it('正常 (0 件): 空配列 + now は ISO8601 文字列', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllStudyDaysForUser).mockResolvedValue([])
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      studyDays: ClientStudyDay[]
      now: string
    }
    expect(body.studyDays).toEqual([])
    expect(body.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
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
      now: string
    }
    expect(body.studyDays).toHaveLength(2)
    expect(body.studyDays[0]?.day).toBe('2026-05-25')
    expect(getAllStudyDaysForUser).toHaveBeenCalledWith('user-uuid-1')
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
})
