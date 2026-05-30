// GET /api/pull の unit test。
// app/api/cards/pull/route.test.ts の構造を踏襲: getCurrentUser と 3 DB 入口を
// mock し、 auth / 正常 / cursor / since parse / 独立ストリーム / Cache-Control を verify。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'
import type { ClientCard } from '@/lib/client-db'
import type { ClientExam } from '@/lib/client-db'
import type { ClientTombstone } from '@/lib/db/tombstones-pull'

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/db/cards-pull', () => ({
  getCardsDelta: vi.fn(),
}))
vi.mock('@/lib/db/exams-pull', () => ({
  getExamsDelta: vi.fn(),
}))
vi.mock('@/lib/db/tombstones-pull', () => ({
  getTombstonesDelta: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getCardsDelta } from '@/lib/db/cards-pull'
import { getExamsDelta } from '@/lib/db/exams-pull'
import { getTombstonesDelta } from '@/lib/db/tombstones-pull'
import { GET } from './route'

const FAKE_USER = { id: 'user-uuid-1' } as unknown as User

const EMPTY_BODY = {
  cards: [],
  exams: [],
  tombstones: [],
  cursors: { cards: null, exams: null, tombstone: null },
}

function fakeCardsDelta(
  rows: ClientCard[] = [],
  maxUpdatedAt: string | null = null,
) {
  return { rows, maxUpdatedAt }
}

function fakeExamsDelta(
  rows: ClientExam[] = [],
  maxUpdatedAt: string | null = null,
) {
  return { rows, maxUpdatedAt }
}

function fakeTombstonesDelta(
  rows: ClientTombstone[] = [],
  maxDeletedAt: string | null = null,
) {
  return { rows, maxDeletedAt }
}

function fakeCard(overrides?: Partial<ClientCard>): ClientCard {
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

function fakeExam(overrides?: Partial<ClientExam>): ClientExam {
  return {
    id: 'exam-1',
    user_id: 'user-uuid-1',
    name: 'Test Exam',
    question_no_format: null,
    archived_at: null,
    card_count: 0,
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    ...overrides,
  }
}

function fakeTombstone(overrides?: Partial<ClientTombstone>): ClientTombstone {
  return {
    entity_type: 'card',
    entity_id: 'card-deleted-1',
    deleted_at: '2026-05-03T00:00:00.000Z',
    ...overrides,
  }
}

function makeReq(url = 'http://x/api/pull'): Request {
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/pull', () => {
  // -------------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------------
  it('未ログイン → 401 + Cache-Control no-store + DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(getCardsDelta).not.toHaveBeenCalled()
    expect(getExamsDelta).not.toHaveBeenCalled()
    expect(getTombstonesDelta).not.toHaveBeenCalled()
  })

  it('予期しない auth エラー → 500 + no-store + DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('clerk down'))
    const res = await GET(makeReq())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(getCardsDelta).not.toHaveBeenCalled()
  })

  it('users 行が未 sync (null) → 200 + emptyBody + no-store + DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(EMPTY_BODY)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(getCardsDelta).not.toHaveBeenCalled()
    expect(getExamsDelta).not.toHaveBeenCalled()
    expect(getTombstonesDelta).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 正常系
  // -------------------------------------------------------------------------
  it('正常 (全 param なし): 3 DB 入口を user.id + undefined で呼ぶ', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    expect(getCardsDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
    expect(getExamsDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
    expect(getTombstonesDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
  })

  it('正常: レスポンス body が cards/exams/tombstones/cursors を含む', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const cardRows = [fakeCard({ id: 'c1' }), fakeCard({ id: 'c2' })]
    const examRows = [fakeExam({ id: 'e1' })]
    const tombstoneRows = [fakeTombstone({ entity_id: 't1' })]
    vi.mocked(getCardsDelta).mockResolvedValue(
      fakeCardsDelta(cardRows, '2026-05-02T00:00:00.000Z'),
    )
    vi.mocked(getExamsDelta).mockResolvedValue(
      fakeExamsDelta(examRows, '2026-05-02T00:00:00.000Z'),
    )
    vi.mocked(getTombstonesDelta).mockResolvedValue(
      fakeTombstonesDelta(tombstoneRows, '2026-05-03T00:00:00.000Z'),
    )
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cards).toHaveLength(2)
    expect(body.cards[0].id).toBe('c1')
    expect(body.exams).toHaveLength(1)
    expect(body.exams[0].id).toBe('e1')
    expect(body.tombstones).toHaveLength(1)
    expect(body.tombstones[0].entity_id).toBe('t1')
    expect(body.cursors).toEqual({
      cards: '2026-05-02T00:00:00.000Z',
      exams: '2026-05-02T00:00:00.000Z',
      tombstone: '2026-05-03T00:00:00.000Z',
    })
  })

  it('0 件の場合: cursor が全 null + 空配列', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    const res = await GET(makeReq())
    const body = await res.json()
    expect(body).toEqual(EMPTY_BODY)
  })

  // -------------------------------------------------------------------------
  // since param parse
  // -------------------------------------------------------------------------
  it('since_cards に有効 ISO8601 → getCardsDelta が (user.id, Date) で呼ばれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    await GET(
      makeReq('http://x/api/pull?since_cards=2026-05-25T00%3A00%3A00.000Z'),
    )
    expect(getCardsDelta).toHaveBeenCalledWith(
      'user-uuid-1',
      new Date('2026-05-25T00:00:00.000Z'),
    )
    // exams / tombstone は undefined (since_exams / since_tombstone 未指定)
    expect(getExamsDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
    expect(getTombstonesDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
  })

  it('since_exams に有効 ISO8601 → getExamsDelta が (user.id, Date) で呼ばれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    await GET(
      makeReq('http://x/api/pull?since_exams=2026-05-24T12%3A00%3A00.000Z'),
    )
    expect(getExamsDelta).toHaveBeenCalledWith(
      'user-uuid-1',
      new Date('2026-05-24T12:00:00.000Z'),
    )
    expect(getCardsDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
    expect(getTombstonesDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
  })

  it('since_tombstone に有効 ISO8601 → getTombstonesDelta が (user.id, Date) で呼ばれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    await GET(
      makeReq(
        'http://x/api/pull?since_tombstone=2026-05-23T06%3A00%3A00.000Z',
      ),
    )
    expect(getTombstonesDelta).toHaveBeenCalledWith(
      'user-uuid-1',
      new Date('2026-05-23T06:00:00.000Z'),
    )
    expect(getCardsDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
    expect(getExamsDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
  })

  it('3 ストリームすべてに since を渡す → 各々が Date で呼ばれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    await GET(
      makeReq(
        'http://x/api/pull?since_cards=2026-05-25T00%3A00%3A00.000Z&since_exams=2026-05-24T00%3A00%3A00.000Z&since_tombstone=2026-05-23T00%3A00%3A00.000Z',
      ),
    )
    expect(getCardsDelta).toHaveBeenCalledWith(
      'user-uuid-1',
      new Date('2026-05-25T00:00:00.000Z'),
    )
    expect(getExamsDelta).toHaveBeenCalledWith(
      'user-uuid-1',
      new Date('2026-05-24T00:00:00.000Z'),
    )
    expect(getTombstonesDelta).toHaveBeenCalledWith(
      'user-uuid-1',
      new Date('2026-05-23T00:00:00.000Z'),
    )
  })

  it('since_cards=bad (不正値) → getCardsDelta が (user.id, undefined) で呼ばれる (全件 fallback)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    await GET(makeReq('http://x/api/pull?since_cards=bad'))
    expect(getCardsDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
  })

  it('since_cards 欠落 → getCardsDelta が (user.id, undefined) で呼ばれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    await GET(makeReq('http://x/api/pull'))
    expect(getCardsDelta).toHaveBeenCalledWith('user-uuid-1', undefined)
  })

  // -------------------------------------------------------------------------
  // owner scope
  // -------------------------------------------------------------------------
  it('owner scope: 全 DB 入口の第 1 引数が user.id 固定', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    await GET(makeReq())
    expect(vi.mocked(getCardsDelta).mock.calls[0]![0]).toBe('user-uuid-1')
    expect(vi.mocked(getExamsDelta).mock.calls[0]![0]).toBe('user-uuid-1')
    expect(vi.mocked(getTombstonesDelta).mock.calls[0]![0]).toBe('user-uuid-1')
  })

  // -------------------------------------------------------------------------
  // DB エラー
  // -------------------------------------------------------------------------
  it('DB (delta) throw → 500 + no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockRejectedValue(new Error('neon down'))
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    const res = await GET(makeReq())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  // -------------------------------------------------------------------------
  // Cache-Control
  // -------------------------------------------------------------------------
  it('正常系でも Cache-Control: no-store ヘッダが付く', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockResolvedValue(fakeCardsDelta())
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    const res = await GET(makeReq())
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})
