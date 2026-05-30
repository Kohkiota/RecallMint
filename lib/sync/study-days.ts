// study-days sync helper — server `/api/study-days/pull` から user の直近 90 日分
// study_days を取得し、 Dexie `study_days` table を atomic に replace。
// S-perf-3 (dashboard 高速化、 streak / todayCount を Dexie 経由に切替)。
//
// 役割境界:
// - replace 戦略 (clear + bulkPut) + 失敗時不変性。 server endpoint は冪等
//   (90 日 window で常に full snapshot)、 client はローカルを置き換える。cursor は
//   持たない (full-window snapshot replace のみ)。
// - 失敗時 (network throw / non-2xx / body 不正): Dexie を touch しない。 dashboard
//   側は古い mirror を引き続き使う (= 一時的失敗は UX 影響なし)。

import { getClientDb, type ClientStudyDay } from '@/lib/client-db'

const STUDY_DAYS_PULL_ENDPOINT = '/api/study-days/pull'

export type PullApiClient = {
  get: (path: string) => Promise<{
    ok: boolean
    status: number
    body: {
      studyDays?: ClientStudyDay[]
      error?: string
    } | null
  }>
}

export type PullResult = {
  ok: boolean
  count: number
}

const defaultClient: PullApiClient = {
  get: async (path) => {
    try {
      const res = await fetch(path, { method: 'GET' })
      let body:
        | { studyDays?: ClientStudyDay[]; error?: string }
        | null = null
      try {
        body = (await res.json()) as typeof body
      } catch {
        body = null
      }
      return { ok: res.ok, status: res.status, body }
    } catch {
      return { ok: false, status: 0, body: null }
    }
  },
}

export async function pullAllStudyDays(
  client: PullApiClient = defaultClient,
): Promise<PullResult> {
  let response: Awaited<ReturnType<PullApiClient['get']>>
  try {
    response = await client.get(STUDY_DAYS_PULL_ENDPOINT)
  } catch {
    return { ok: false, count: 0 }
  }
  if (!response.ok || !response.body) {
    return { ok: false, count: 0 }
  }
  const { studyDays } = response.body
  if (!Array.isArray(studyDays)) {
    return { ok: false, count: 0 }
  }

  const db = getClientDb()
  await db.transaction('rw', db.study_days, async () => {
    await db.study_days.clear()
    if (studyDays.length > 0) {
      await db.study_days.bulkPut(studyDays)
    }
  })
  return { ok: true, count: studyDays.length }
}
