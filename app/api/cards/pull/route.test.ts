// GET /api/cards/pull の unit test (S-local-2 Task 2)。
// `/api/dashboard/stats` の test pattern を踏襲: getCurrentUser /
// getAllCardsForUser を mock し、 auth / 正常 / tenant / since 無視 / Date 文字列
// / DB error / Cache-Control を verify。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'
import type { ClientCard } from '@/lib/client-db'

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/db/cards-pull', () => ({
  getAllCardsForUser: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getAllCardsForUser } from '@/lib/db/cards-pull'
import { GET } from './route'

const FAKE_USER = { id: 'user-uuid-1' } as unknown as User

function fakeClientCard(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: 'user-uuid-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: 'Q1',
    sort_key: null,
    question_text: 'Q',
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    custom_props: {},
    tags: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-05-26T10:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

function makeReq(url = 'http://x/api/cards/pull'): Request {
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/cards/pull', () => {
  it('未ログイン → 401 + Cache-Control no-store + DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getAllCardsForUser).not.toHaveBeenCalled()
  })

  it('users 行が未 sync → 200 空 cards + no-store + DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cards: ClientCard[]; now: string }
    expect(body.cards).toEqual([])
    expect(typeof body.now).toBe('string')
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getAllCardsForUser).not.toHaveBeenCalled()
  })

  it('正常 (0 件): 空配列 + now は ISO8601 文字列', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllCardsForUser).mockResolvedValue([])
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cards: ClientCard[]; now: string }
    expect(body.cards).toEqual([])
    expect(body.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('正常 (N 件): cards 配列 + getAllCardsForUser は user.id で呼ばれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const rows = [fakeClientCard({ id: 'c1' }), fakeClientCard({ id: 'c2' })]
    vi.mocked(getAllCardsForUser).mockResolvedValue(rows)
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cards: ClientCard[]; now: string }
    expect(body.cards).toHaveLength(2)
    expect(body.cards[0]?.id).toBe('c1')
    expect(getAllCardsForUser).toHaveBeenCalledWith('user-uuid-1')
    expect(getAllCardsForUser).toHaveBeenCalledTimes(1)
  })

  it('since query param を渡しても無視されて全件返る (Phase α は full snapshot のみ)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllCardsForUser).mockResolvedValue([])
    await GET(makeReq('http://x/api/cards/pull?since=2026-05-25T00%3A00%3A00.000Z'))
    // since を受け取っても getAllCardsForUser は user.id のみで呼ばれる
    expect(getAllCardsForUser).toHaveBeenCalledWith('user-uuid-1')
    expect(getAllCardsForUser).toHaveBeenCalledTimes(1)
  })

  it('DB エラー → 500 + Cache-Control no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getAllCardsForUser).mockRejectedValue(new Error('neon down'))
    const res = await GET(makeReq())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })
})
