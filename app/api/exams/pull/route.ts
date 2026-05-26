// GET /api/exams/pull — S-local-2 Task 3 (§14.11 local-first MVP)。
// user の全 exams を full snapshot で返却。 archived も含めて全件 (client filter
// は別 sprint)。 `/api/cards/pull` と完全同 pattern。

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getAllExamsForUser } from '@/lib/db/exams-pull'
import { logger } from '@/lib/logger'
import type { User } from '@/lib/db/schema'

export const runtime = 'nodejs'

export async function GET(_req: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }

  let user: User | null
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return Response.json({ error: 'unauthenticated' }, { status: 401, headers })
    }
    logger.warn({ event: 'api.exams.pull.auth_failed', err })
    return Response.json({ error: 'internal' }, { status: 500, headers })
  }
  if (!user) {
    return Response.json(
      { exams: [], now: new Date().toISOString() },
      { status: 200, headers },
    )
  }

  try {
    const exams = await getAllExamsForUser(user.id)
    return Response.json(
      { exams, now: new Date().toISOString() },
      { status: 200, headers },
    )
  } catch (err) {
    logger.warn({ event: 'api.exams.pull.failed', userId: user.id, err })
    return Response.json({ error: 'internal' }, { status: 500, headers })
  }
}
