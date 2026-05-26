// study-days sync helper test。 cards.test.ts と同 pattern。 fake-indexeddb +
// PullApiClient mock で atomic replace / sync_meta set / 失敗時の不変性を verify。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getClientDb, type ClientStudyDay } from '@/lib/client-db'
import { SYNC_META_KEYS, getSyncMeta } from './sync-meta'
import { pullAllStudyDays, type PullApiClient } from './study-days'

function fakeStudyDay(overrides?: Partial<ClientStudyDay>): ClientStudyDay {
  return {
    user_id: 'user-1',
    day: '2026-05-26',
    review_count: 5,
    correct_count: 3,
    distinct_card_count: 4,
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
  await Promise.all([db.study_days.clear(), db.sync_meta.clear()])
})

describe('pullAllStudyDays', () => {
  it('成功 0 件: study_days 空 + sync_meta set', async () => {
    const client = mockClient({
      ok: true,
      status: 200,
      body: { studyDays: [], now: '2026-05-26T01:00:00.000Z' },
    })
    const result = await pullAllStudyDays(client)
    expect(result).toEqual({ ok: true, count: 0 })
    expect(await getClientDb().study_days.count()).toBe(0)
    expect(await getSyncMeta(SYNC_META_KEYS.lastStudyDayPullAt)).toBe(
      '2026-05-26T01:00:00.000Z',
    )
  })

  it('成功 N 件: study_days table に N 行 + sync_meta set', async () => {
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        studyDays: [
          fakeStudyDay({ day: '2026-05-25' }),
          fakeStudyDay({ day: '2026-05-26' }),
        ],
        now: '2026-05-26T02:00:00.000Z',
      },
    })
    const result = await pullAllStudyDays(client)
    expect(result).toEqual({ ok: true, count: 2 })
    const rows = await getClientDb().study_days.toArray()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.day).sort()).toEqual(['2026-05-25', '2026-05-26'])
  })

  it('既存 2 件 → pull 3 件で replace (元 2 件は消える)', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({ day: '2026-04-01' }),
      fakeStudyDay({ day: '2026-04-02' }),
    ])
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        studyDays: [
          fakeStudyDay({ day: '2026-05-24' }),
          fakeStudyDay({ day: '2026-05-25' }),
          fakeStudyDay({ day: '2026-05-26' }),
        ],
        now: '2026-05-26T03:00:00.000Z',
      },
    })
    await pullAllStudyDays(client)
    const rows = await getClientDb().study_days.toArray()
    expect(rows.map((r) => r.day).sort()).toEqual([
      '2026-05-24',
      '2026-05-25',
      '2026-05-26',
    ])
  })

  it('HTTP 500: study_days / sync_meta いずれも不変', async () => {
    await getClientDb().study_days.bulkPut([fakeStudyDay({ day: '2026-05-20' })])
    const client = mockClient({ ok: false, status: 500, body: null })
    const result = await pullAllStudyDays(client)
    expect(result).toEqual({ ok: false, count: 0 })
    const rows = await getClientDb().study_days.toArray()
    expect(rows.map((r) => r.day)).toEqual(['2026-05-20'])
    expect(await getSyncMeta(SYNC_META_KEYS.lastStudyDayPullAt)).toBeUndefined()
  })

  it('fetch throw (network 不通): silent return + 不変', async () => {
    await getClientDb().study_days.bulkPut([fakeStudyDay({ day: '2026-05-20' })])
    const client: PullApiClient = {
      get: vi.fn().mockRejectedValue(new Error('network')),
    }
    const result = await pullAllStudyDays(client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect(await getClientDb().study_days.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.lastStudyDayPullAt)).toBeUndefined()
  })

  it('response body shape 不正 (studyDays が array でない): silent fail + 不変', async () => {
    await getClientDb().study_days.bulkPut([fakeStudyDay({ day: '2026-05-20' })])
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        studyDays: 'not-array',
        now: '2026-05-26T04:00:00.000Z',
      } as never,
    })
    const result = await pullAllStudyDays(client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect(await getClientDb().study_days.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.lastStudyDayPullAt)).toBeUndefined()
  })
})
