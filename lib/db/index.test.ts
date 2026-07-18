import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import postgres from 'postgres'
import { getDb, getAdminDb, closeDb } from './index'

// postgres(url) is lazy (no real connection until a query runs), so calling
// getDb()/getAdminDb() with a fake URL would already be safe without mocking.
// We mock it anyway to make the closeDb() regression test deterministic: we
// need to control each client's .end() outcome independently (one rejects,
// one resolves) without touching a real socket.
//
// The fake client exposes only what drizzle-orm's postgres-js `construct()`
// touches at drizzle() call time (`client.options.parsers`/`.serializers`,
// mutated in place) plus `.end()` (what closeDb() calls) — nothing else is
// used by lib/db/index.ts.
vi.mock('postgres', () => ({
  default: vi.fn(() => ({
    options: { parsers: {}, serializers: {} },
    end: vi.fn(() => Promise.resolve()),
  })),
}))

// lib/db/index.ts memoizes _db/_client/_adminDb/_adminClient at module scope,
// evaluated lazily inside getDb()/getAdminDb() (not at module-load time), so
// (unlike e.g. lib/stripe/price-mapping.ts) a plain static import here is
// fine — we don't need vi.resetModules()/dynamic import() to see different
// env values. Isolation between tests is instead via explicit closeDb() (null
// out singletons) + restoring env, both in afterEach.
describe('lib/db getDb/getAdminDb/closeDb', () => {
  const ORIG_APP = process.env.DATABASE_URL_APP
  const ORIG_ADMIN = process.env.DATABASE_URL_ADMIN

  beforeEach(() => {
    vi.mocked(postgres).mockClear()
  })

  afterEach(async () => {
    // best-effort: some tests deliberately make .end() reject; don't let a
    // dangling mocked client leak into the next test's singleton state.
    await closeDb().catch(() => {})
    if (ORIG_APP === undefined) delete process.env.DATABASE_URL_APP
    else process.env.DATABASE_URL_APP = ORIG_APP
    if (ORIG_ADMIN === undefined) delete process.env.DATABASE_URL_ADMIN
    else process.env.DATABASE_URL_ADMIN = ORIG_ADMIN
  })

  it('getAdminDb() throws when DATABASE_URL_ADMIN is unset', () => {
    delete process.env.DATABASE_URL_ADMIN
    expect(() => getAdminDb()).toThrow('DATABASE_URL_ADMIN is not set')
  })

  it('getDb() throws when DATABASE_URL_APP is unset', () => {
    delete process.env.DATABASE_URL_APP
    expect(() => getDb()).toThrow('DATABASE_URL_APP is not set')
  })

  it('getDb()/getAdminDb() are independent memoized singletons', () => {
    process.env.DATABASE_URL_APP = 'postgresql://fake:fake@localhost:5432/fake_app'
    process.env.DATABASE_URL_ADMIN = 'postgresql://fake:fake@localhost:5432/fake_admin'

    expect(getDb()).toBe(getDb())
    expect(getAdminDb()).toBe(getAdminDb())
    expect(getDb()).not.toBe(getAdminDb())
  })

  // Regression for Fix 1: closeDb() must attempt closing BOTH clients even
  // when the first one's .end() rejects, and must clear both singletons
  // regardless. Before Fix 1, a per-client try/finally let the first client's
  // rejection propagate past the finally and skip the second client's `if`
  // block entirely — this test fails against that code (see report's red
  // 検証 section) and passes against the Promise.allSettled rewrite.
  it('closeDb() still closes the second client and clears singletons when the first client\'s .end() rejects', async () => {
    process.env.DATABASE_URL_APP = 'postgresql://fake:fake@localhost:5432/fake_app'
    process.env.DATABASE_URL_ADMIN = 'postgresql://fake:fake@localhost:5432/fake_admin'

    const appDb = getDb()
    const adminDb = getAdminDb()

    const mockedPostgres = vi.mocked(postgres)
    // getDb() constructs _client first, getAdminDb() constructs _adminClient
    // second — mock.results preserves that call order.
    const appClient = mockedPostgres.mock.results[0]!.value as { end: ReturnType<typeof vi.fn> }
    const adminClient = mockedPostgres.mock.results[1]!.value as { end: ReturnType<typeof vi.fn> }

    appClient.end.mockImplementation(() => Promise.reject(new Error('app end failed')))

    await expect(closeDb()).rejects.toThrow('app end failed')

    // (a) the second (admin) client's .end() was still called despite the
    // first rejecting.
    expect(adminClient.end).toHaveBeenCalledTimes(1)
    expect(appClient.end).toHaveBeenCalledTimes(1)

    // (c) singletons were cleared — next getDb()/getAdminDb() construct
    // fresh clients rather than returning the (rejected-close) old ones.
    const appDb2 = getDb()
    const adminDb2 = getAdminDb()
    expect(appDb2).not.toBe(appDb)
    expect(adminDb2).not.toBe(adminDb)
  })
})
