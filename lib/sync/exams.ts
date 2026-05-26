// exams sync helper — server `/api/exams/pull` → Dexie `exams` table を atomic
// replace。 cards.ts と完全同 pattern (S-local-2 Task 5)。

import { getClientDb, type ClientExam } from '@/lib/client-db'
import { SYNC_META_KEYS } from './sync-meta'

const EXAMS_PULL_ENDPOINT = '/api/exams/pull'

export type PullApiClient = {
  get: (path: string) => Promise<{
    ok: boolean
    status: number
    body: { exams?: ClientExam[]; now?: string; error?: string } | null
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
      let body: { exams?: ClientExam[]; now?: string; error?: string } | null = null
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

export async function pullAllExams(
  client: PullApiClient = defaultClient,
): Promise<PullResult> {
  let response: Awaited<ReturnType<PullApiClient['get']>>
  try {
    response = await client.get(EXAMS_PULL_ENDPOINT)
  } catch {
    return { ok: false, count: 0 }
  }
  if (!response.ok || !response.body) {
    return { ok: false, count: 0 }
  }
  const { exams, now } = response.body
  if (!Array.isArray(exams) || typeof now !== 'string') {
    return { ok: false, count: 0 }
  }

  const db = getClientDb()
  await db.transaction('rw', db.exams, db.sync_meta, async () => {
    await db.exams.clear()
    if (exams.length > 0) {
      await db.exams.bulkPut(exams)
    }
    await db.sync_meta.put({ key: SYNC_META_KEYS.lastExamPullAt, value: now })
  })
  return { ok: true, count: exams.length }
}
