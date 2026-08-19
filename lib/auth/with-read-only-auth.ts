import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { logger } from '@/lib/logger'
import type { User } from '@/lib/db/schema'

type CacheHeaders = { 'Cache-Control': string }

/**
 * Handler receives the authed user, no-store headers, and the original request.
 * Handlers that don't need the request (study-days/pull,
 * exams/status) may omit the third parameter — TypeScript allows functions with
 * fewer params to be assigned to function types with more params.
 */
type HandlerFn = (
  user: User,
  headers: CacheHeaders,
  req: Request,
) => Promise<Response>

interface ReadOnlyAuthOpts {
  /**
   * Response body returned (status 200 + no-store) when Clerk session is valid
   * but the users row is not yet synced (sign-up race → null from getCurrentUser).
   */
  emptyBody: unknown
  /**
   * logger.warn event name for unexpected (non-UnauthenticatedError) errors from
   * getCurrentUser. When undefined the error is rethrown (exams/status preserves
   * its current non-symmetric behavior: framework default 500, no Cache-Control).
   */
  authFailEvent?: string
}

/**
 * Wraps a read-only route handler with shared auth boilerplate:
 *   1. Sets Cache-Control: no-store on all responses produced by this wrapper.
 *   2. Calls getCurrentUser; on UnauthenticatedError → 401 + no-store.
 *   3. On other errors: if authFailEvent is set → logger.warn + 500 + no-store;
 *      else rethrows (preserving framework-default 500 without no-store).
 *   4. On null user (sign-up race) → 200 + opts.emptyBody + no-store.
 *   5. Delegates to handler(user, headers, req) for the success path.
 *
 * The returned function accepts an optional Request so that routes which don't
 * read query params can export it directly and tests can call GET() without
 * arguments while satisfying TypeScript strict mode.
 */
export function withReadOnlyAuth(
  opts: ReadOnlyAuthOpts,
  handler: HandlerFn,
): (req?: Request) => Promise<Response> {
  return async (
    req: Request = new Request('http://localhost'),
  ): Promise<Response> => {
    const headers: CacheHeaders = { 'Cache-Control': 'no-store' }

    let user: User | null
    try {
      user = await getCurrentUser()
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        return Response.json(
          { error: 'unauthenticated' },
          { status: 401, headers },
        )
      }
      if (opts.authFailEvent !== undefined) {
        logger.warn({ event: opts.authFailEvent, err })
        return Response.json({ error: 'internal' }, { status: 500, headers })
      }
      throw err
    }

    if (!user) {
      return Response.json(opts.emptyBody, { status: 200, headers })
    }

    return handler(user, headers, req)
  }
}
