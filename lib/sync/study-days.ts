// study-days sync helper — server `/api/study-days/pull` から user の直近 90 日分
// study_days を取得し、 Dexie `study_days` table を owner 限定で atomic に replace。
// S-perf-3 (dashboard 高速化、 streak / todayCount を Dexie 経由に切替)。
// S-local-2 Task 5 (spec §6): owner による空間的分離。 store 全体 clear() は
// repo 唯一の破壊的 writer だったため、 owner 限定 delete に置換した。
//
// 役割境界:
// - replace 戦略 (owner 限定 delete + bulkPut) + 失敗時不変性。 server endpoint は
//   冪等 (90 日 window で常に full snapshot)、 client は自 owner 分のみ置き換える。
//   cursor は持たない (full-window snapshot replace のみ)。
// - 失敗時 (空 userId / network throw / non-2xx / body 不正 / owner 検証違反):
//   Dexie を touch しない。 dashboard 側は古い mirror を引き続き使う
//   (= 一時的失敗は UX 影響なし)。
// - server は owner 単一を強制済 (`app/api/study-days/pull/route.ts` が認証由来
//   user.id を渡し `lib/db/study-days-pull.ts` が WHERE user_id を強制)。 ここでの
//   行検証は defense-in-depth (server 契約 drift への fail-closed)。
// - 同一 owner の複数呼び出しが並走した場合、 古い snapshot が後着して新しい
//   snapshot を上書きする鮮度退行はここでは扱わない (既存挙動として受容・
//   次トリガーで自然回復。 spec §6)。

import { getClientDb, type ClientStudyDay } from '@/lib/client-db'
import { logger } from '@/lib/logger'

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
  userId: string,
  client: PullApiClient = defaultClient,
): Promise<PullResult> {
  // fail-closed: 空 userId は network にも Dexie にも触れずに FAIL
  // (未認証状態からの誤 kick を無 owner の delete/put に落とさない)。
  if (!userId) return { ok: false, count: 0 }

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

  // owner 検証: tx を開く前に完了し、 違反があれば batch 全体を reject する
  // (部分書込なし)。 検証した配列 (studyDays) をそのまま bulkPut に渡す
  // (検証後に別配列を組み立てない)。 log は event 名 + 件数のみ。
  if (studyDays.some((row) => row.user_id !== userId)) {
    logger.warn({ event: 'study_days.pull.owner_mismatch', count: studyDays.length })
    return { ok: false, count: 0 }
  }

  const db = getClientDb()
  await db.transaction('rw', db.study_days, async () => {
    await db.study_days.where('user_id').equals(userId).delete()
    if (studyDays.length > 0) {
      await db.study_days.bulkPut(studyDays)
    }
  })
  return { ok: true, count: studyDays.length }
}
