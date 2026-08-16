// study-days sync helper test。 cards.test.ts と同 pattern。 fake-indexeddb +
// PullApiClient mock で atomic replace / 失敗時の不変性を verify。
// S-local-2 Task 5 (spec §6): owner 限定置換 (異 owner 生存 / mixed reject /
// 正常系 / 空 userId fail-closed / 検証と書込の配列同一性) の pin を追加。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getClientDb, type ClientStudyDay } from '@/lib/client-db'
import { pullAllStudyDays, type PullApiClient } from './study-days'

const USER_A = 'user-1'
const USER_B = 'user-2'

function fakeStudyDay(overrides?: Partial<ClientStudyDay>): ClientStudyDay {
  return {
    user_id: USER_A,
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
  it('成功 0 件: study_days 空 (now なし response でも mirror)', async () => {
    const client = mockClient({
      ok: true,
      status: 200,
      body: { studyDays: [] },
    })
    const result = await pullAllStudyDays(USER_A, client)
    expect(result).toEqual({ ok: true, count: 0 })
    expect(await getClientDb().study_days.count()).toBe(0)
  })

  it('成功 N 件: study_days table に N 行 (now なし response でも bulkPut)', async () => {
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        studyDays: [
          fakeStudyDay({ day: '2026-05-25' }),
          fakeStudyDay({ day: '2026-05-26' }),
        ],
      },
    })
    const result = await pullAllStudyDays(USER_A, client)
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
      },
    })
    await pullAllStudyDays(USER_A, client)
    const rows = await getClientDb().study_days.toArray()
    expect(rows.map((r) => r.day).sort()).toEqual([
      '2026-05-24',
      '2026-05-25',
      '2026-05-26',
    ])
  })

  it('HTTP 500: study_days 不変', async () => {
    await getClientDb().study_days.bulkPut([fakeStudyDay({ day: '2026-05-20' })])
    const client = mockClient({ ok: false, status: 500, body: null })
    const result = await pullAllStudyDays(USER_A, client)
    expect(result).toEqual({ ok: false, count: 0 })
    const rows = await getClientDb().study_days.toArray()
    expect(rows.map((r) => r.day)).toEqual(['2026-05-20'])
  })

  it('fetch throw (network 不通): silent return + 不変', async () => {
    await getClientDb().study_days.bulkPut([fakeStudyDay({ day: '2026-05-20' })])
    const client: PullApiClient = {
      get: vi.fn().mockRejectedValue(new Error('network')),
    }
    const result = await pullAllStudyDays(USER_A, client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect(await getClientDb().study_days.count()).toBe(1)
  })

  it('response body shape 不正 (studyDays が array でない): silent fail + 不変', async () => {
    await getClientDb().study_days.bulkPut([fakeStudyDay({ day: '2026-05-20' })])
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        studyDays: 'not-array',
      } as never,
    })
    const result = await pullAllStudyDays(USER_A, client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect(await getClientDb().study_days.count()).toBe(1)
  })
})

describe('pullAllStudyDays — owner 限定置換 (S-local-2 Task 5 / spec §6)', () => {
  it('① 異 owner 生存: A/B 両 seed 下で B の pull 後も A の行が全件不変', async () => {
    const db = getClientDb()
    await db.study_days.bulkPut([
      fakeStudyDay({ user_id: USER_A, day: '2026-05-01' }),
      fakeStudyDay({ user_id: USER_A, day: '2026-05-02' }),
      fakeStudyDay({ user_id: USER_B, day: '2026-05-01' }),
    ])
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        studyDays: [
          fakeStudyDay({ user_id: USER_B, day: '2026-05-10' }),
          fakeStudyDay({ user_id: USER_B, day: '2026-05-11' }),
        ],
      },
    })
    const result = await pullAllStudyDays(USER_B, client)
    expect(result).toEqual({ ok: true, count: 2 })

    const aRows = await db.study_days.where('user_id').equals(USER_A).toArray()
    expect(aRows.map((r) => r.day).sort()).toEqual(['2026-05-01', '2026-05-02'])

    const bRows = await db.study_days.where('user_id').equals(USER_B).toArray()
    expect(bRows.map((r) => r.day).sort()).toEqual(['2026-05-10', '2026-05-11'])
  })

  it('② mixed reject: payload に A の行 1 件混入 → {ok:false} + Dexie 完全不変 (B の既存行も置換されない)', async () => {
    const db = getClientDb()
    await db.study_days.bulkPut([
      fakeStudyDay({ user_id: USER_A, day: '2026-05-01' }),
      fakeStudyDay({ user_id: USER_B, day: '2026-05-01' }),
    ])
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        studyDays: [
          fakeStudyDay({ user_id: USER_B, day: '2026-05-20' }),
          fakeStudyDay({ user_id: USER_A, day: '2026-05-21' }), // 混入
        ],
      },
    })
    const result = await pullAllStudyDays(USER_B, client)
    expect(result).toEqual({ ok: false, count: 0 })

    // Dexie は完全不変: B の既存行 (2026-05-01) も新 snapshot の B 行 (2026-05-20) も
    // 反映されない (batch 全体 reject の証明)
    const rows = await db.study_days.toArray()
    expect(rows.map((r) => `${r.user_id}:${r.day}`).sort()).toEqual([
      `${USER_A}:2026-05-01`,
      `${USER_B}:2026-05-01`,
    ])
  })

  it('③ 正常系: B の行だけが新 snapshot に置換される', async () => {
    const db = getClientDb()
    await db.study_days.bulkPut([
      fakeStudyDay({ user_id: USER_B, day: '2026-04-01' }),
    ])
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        studyDays: [fakeStudyDay({ user_id: USER_B, day: '2026-05-30' })],
      },
    })
    const result = await pullAllStudyDays(USER_B, client)
    expect(result).toEqual({ ok: true, count: 1 })
    const rows = await db.study_days.where('user_id').equals(USER_B).toArray()
    expect(rows.map((r) => r.day)).toEqual(['2026-05-30'])
  })

  it('④ 空 userId: fetch 不呼・Dexie 不触', async () => {
    const db = getClientDb()
    await db.study_days.bulkPut([fakeStudyDay({ user_id: USER_A, day: '2026-05-01' })])
    const client = mockClient({
      ok: true,
      status: 200,
      body: { studyDays: [fakeStudyDay({ user_id: USER_A, day: '2026-06-01' })] },
    })
    const result = await pullAllStudyDays('', client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect(client.get).not.toHaveBeenCalled()
    const rows = await db.study_days.toArray()
    expect(rows.map((r) => r.day)).toEqual(['2026-05-01'])
  })

  it('検証と書込は同一配列に対して行う (bulkPut に渡る参照が response の studyDays 配列と同一)', async () => {
    const db = getClientDb()
    const studyDays = [fakeStudyDay({ user_id: USER_B, day: '2026-05-15' })]
    const client = mockClient({
      ok: true,
      status: 200,
      body: { studyDays },
    })
    const bulkPutSpy = vi.spyOn(db.study_days, 'bulkPut')
    await pullAllStudyDays(USER_B, client)
    expect(bulkPutSpy).toHaveBeenCalledTimes(1)
    // 参照同一性 (検証後に別配列を組み立てて bulkPut しない)
    expect(bulkPutSpy.mock.calls[0][0]).toBe(studyDays)
    bulkPutSpy.mockRestore()
  })
})
