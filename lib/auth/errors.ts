/**
 * Thrown by `getCurrentUser()` when Clerk's `auth()` returns no `userId`.
 * Server Actions should use `instanceof UnauthenticatedError` to map to a
 * structured `ActionResult` (Rule H) rather than matching on `err.message`.
 */
export class UnauthenticatedError extends Error {
  constructor(message = 'UNAUTHENTICATED') {
    super(message)
    this.name = 'UnauthenticatedError'
  }
}
