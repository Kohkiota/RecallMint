// GET /api/exams/pull の unit test (S-local-2 Task 3)。
// `/api/cards/pull` と同 pattern。 auth / 正常 / tenant / since 無視 / DB error /
// Cache-Control を verify。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'
import type { ClientExam } from '@/lib/client-db'

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/db/exams-pull', () => ({
  getAllExamsForUser: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getAllExamsForUser } from '@/lib/db/exams-pull'
import { GET } from './route'

const FAKE_USER = { id: 'user-uuid-1' } as unknown as User

function fakeClientExam(overrides?: Partial<ClientExam>): ClientExam {
  return {
    id: 'exam-1',
    user_id: 'user-uuid-1',
    name: 'Exam',
    question_no_format: null,
    archived_at: null,
    card_count: 0,
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    ...overrides,
  }
}

function makeReq(url = 'http://x/api/exams/pull'): Request {
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/exams/pull', () => {
  it('未ログイン → 401 + no-store + DB 触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getAllExamsForUser).not.toHaveBeenCalled()
  })

  it('users 行が未 sync → 200 + 空 exams + no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { exams: ClientExam[]; now: string }
    expect(body.exams).toEqual([])
    expect(typeof body.now).toBe('string')
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getAllExamsForUser).not.toHaveBeenCalled()
  })

  it('正常 0 件: now は ISO 文字列', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllExamsForUser).mockResolvedValue([])
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { exams: ClientExam[]; now: string }
    expect(body.exams).toEqual([])
    expect(body.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('正常 N 件 + archived 含む: tenant は user.id で呼ばれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllExamsForUser).mockResolvedValue([
      fakeClientExam({ id: 'e1' }),
      fakeClientExam({ id: 'e2', archived_at: '2026-05-15T00:00:00.000Z' }),
    ])
    const res = await GET(makeReq())
    const body = (await res.json()) as { exams: ClientExam[]; now: string }
    expect(body.exams).toHaveLength(2)
    expect(body.exams[1]?.archived_at).toBe('2026-05-15T00:00:00.000Z')
    expect(getAllExamsForUser).toHaveBeenCalledWith('user-uuid-1')
    expect(getAllExamsForUser).toHaveBeenCalledTimes(1)
  })

  it('since query を渡しても無視されて全件返る', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllExamsForUser).mockResolvedValue([])
    await GET(makeReq('http://x/api/exams/pull?since=2026-05-25T00%3A00%3A00.000Z'))
    expect(getAllExamsForUser).toHaveBeenCalledWith('user-uuid-1')
    expect(getAllExamsForUser).toHaveBeenCalledTimes(1)
  })

  it('DB エラー → 500 + no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllExamsForUser).mockRejectedValue(new Error('neon down'))
    const res = await GET(makeReq())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })
})
