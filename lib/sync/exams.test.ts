// exams sync helper test (S-local-2 Task 5)。 cards.test.ts と同 pattern、 exams
// table + last_exam_pull_at の atomic replace を verify。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getClientDb, type ClientExam } from '@/lib/client-db'
import { SYNC_META_KEYS, getSyncMeta } from './sync-meta'
import { pullAllExams, type PullApiClient } from './exams'

function fakeClientExam(overrides?: Partial<ClientExam>): ClientExam {
  return {
    id: 'exam-1',
    user_id: 'user-1',
    name: 'E',
    question_no_format: null,
    archived_at: null,
    card_count: 0,
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    ...overrides,
  }
}

function mockClient(
  response: Awaited<ReturnType<PullApiClient['get']>>,
): PullApiClient {
  return { get: vi.fn().mockResolvedValue(response) }
}

beforeEach(async () => {
  const db = getClientDb()
  await Promise.all([db.exams.clear(), db.sync_meta.clear()])
})

describe('pullAllExams', () => {
  it('成功 0 件: exams 空 + sync_meta set', async () => {
    const client = mockClient({
      ok: true,
      status: 200,
      body: { exams: [], now: '2026-05-26T01:00:00.000Z' },
    })
    const result = await pullAllExams(client)
    expect(result).toEqual({ ok: true, count: 0 })
    expect(await getClientDb().exams.count()).toBe(0)
    expect(await getSyncMeta(SYNC_META_KEYS.lastExamPullAt)).toBe(
      '2026-05-26T01:00:00.000Z',
    )
  })

  it('成功 N 件 + archived 含む: exams table に N 行', async () => {
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        exams: [
          fakeClientExam({ id: 'a' }),
          fakeClientExam({ id: 'b', archived_at: '2026-05-15T00:00:00.000Z' }),
        ],
        now: '2026-05-26T02:00:00.000Z',
      },
    })
    const result = await pullAllExams(client)
    expect(result).toEqual({ ok: true, count: 2 })
    const rows = await getClientDb().exams.toArray()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === 'b')?.archived_at).toBe(
      '2026-05-15T00:00:00.000Z',
    )
  })

  it('既存 2 件 → pull 3 件で replace', async () => {
    await getClientDb().exams.bulkPut([
      fakeClientExam({ id: 'old-1' }),
      fakeClientExam({ id: 'old-2' }),
    ])
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        exams: [
          fakeClientExam({ id: 'new-1' }),
          fakeClientExam({ id: 'new-2' }),
          fakeClientExam({ id: 'new-3' }),
        ],
        now: '2026-05-26T03:00:00.000Z',
      },
    })
    await pullAllExams(client)
    const rows = await getClientDb().exams.toArray()
    expect(rows.map((r) => r.id).sort()).toEqual(['new-1', 'new-2', 'new-3'])
  })

  it('HTTP 500: exams / sync_meta 不変', async () => {
    await getClientDb().exams.bulkPut([fakeClientExam({ id: 'keep' })])
    const client = mockClient({ ok: false, status: 500, body: null })
    const result = await pullAllExams(client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect((await getClientDb().exams.toArray()).map((r) => r.id)).toEqual([
      'keep',
    ])
    expect(await getSyncMeta(SYNC_META_KEYS.lastExamPullAt)).toBeUndefined()
  })

  it('fetch throw: silent return + 不変', async () => {
    await getClientDb().exams.bulkPut([fakeClientExam({ id: 'keep' })])
    const client: PullApiClient = {
      get: vi.fn().mockRejectedValue(new Error('network')),
    }
    const result = await pullAllExams(client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect(await getClientDb().exams.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.lastExamPullAt)).toBeUndefined()
  })

  it('response body shape 不正: silent fail + 不変', async () => {
    await getClientDb().exams.bulkPut([fakeClientExam({ id: 'keep' })])
    const client = mockClient({
      ok: true,
      status: 200,
      body: { exams: 'not-array', now: '2026-05-26T04:00:00.000Z' } as never,
    })
    const result = await pullAllExams(client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect(await getClientDb().exams.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.lastExamPullAt)).toBeUndefined()
  })
})
