import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DB } from '@/lib/db'
import type { User } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// Clerk server module mock — only the auth() API is used now.
// (clerkClient was removed in R2 webhook-only sync; getCurrentUser no longer
// calls clerkClient.users.getUser — see spec §3.1.)
// ---------------------------------------------------------------------------
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}))

// `getDb()` is mocked per-test so getCurrentUser reads from a fake DB.
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { auth } from '@clerk/nextjs/server'
import { getDb } from '@/lib/db'

// ---------------------------------------------------------------------------
// Fake DB factory (claim-first wiring).
// getCurrentUser now:
//   1. (claim なし) db.execute(sql`SELECT id FROM app_bootstrap_user_from_clerk(...)`)
//      → 内部 id を解決 (`idRows`)。
//   2. withTenantTx(db, id, ...) = db.transaction(cb) 内で setTenantContext →
//      tx.select().from(users).where().limit() → full User 行 (`userRows`)。
// `_bootstrapExecute` は db-level の execute (bootstrap 呼分け pin 用の spy)。
// ---------------------------------------------------------------------------
function makeFakeDb(opts: { idRows?: Array<{ id: string }>; userRows?: User[] } = {}) {
  const bootstrapExecute = vi.fn(() => Promise.resolve(opts.idRows ?? []))
  // withTenantTx が張る tx: setTenantContext の execute は no-op resolve、
  // select 連鎖は userRows を返す。
  const txExecute = vi.fn(() => Promise.resolve(undefined))
  const txSelect = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(opts.userRows ?? [])),
      })),
    })),
  }))
  const tx = { execute: txExecute, select: txSelect }
  const transaction = vi.fn((cb: (t: typeof tx) => unknown) => cb(tx))
  const insert = vi.fn()
  return {
    execute: bootstrapExecute,
    transaction,
    insert,
    _bootstrapExecute: bootstrapExecute,
  } as unknown as DB & { _bootstrapExecute: ReturnType<typeof vi.fn> }
}

// ---------------------------------------------------------------------------
// Helper to build a minimal User row
// ---------------------------------------------------------------------------
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    clerkId: 'user_1',
    email: 'test@example.com',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    scheduledDowngradeScheduleId: null,
    scheduledTargetPriceId: null,
    scheduledChangeEffectiveAt: null,
    plan: 'free',
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAt: null,
    billingInterval: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// getCurrentUser — webhook-only sync (R2): pure DB lookup, returns User | null.
// ---------------------------------------------------------------------------
describe('getCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('userId が null なら UnauthenticatedError を throw', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never)

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const { UnauthenticatedError } = await import('@/lib/auth/errors')

    await expect(getCurrentUser()).rejects.toBeInstanceOf(UnauthenticatedError)
  })

  it('userId あり / DB に行あり / deletedAt null → User を返す', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_1' } as never)
    const row = makeUser({ clerkId: 'user_1', deletedAt: null })
    vi.mocked(getDb).mockReturnValue(
      makeFakeDb({ idRows: [{ id: row.id }], userRows: [row] }) as never,
    )

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const result = await getCurrentUser()

    expect(result).not.toBeNull()
    expect(result?.clerkId).toBe('user_1')
    expect(result?.deletedAt).toBeNull()
  })

  it('userId あり / claim の id が ghost (deletedAt セット・scrub 済) → isNull フィルタで 0 行 → null', async () => {
    // claim-present: dbUserId は削除前の JWT に残存 (60s window)。scrub は行を物理保持
    // + deleted_at set + clerk_id NULL 化するため、getCurrentUser の
    // isNull(deletedAt) 付き read は 0 行 → null (旧契約「行をそのまま返す」は撤回)。
    // mock は「フィルタ後の read 結果」を userRows:[] で表現する。WHERE の isNull が
    // 実際に効くこと自体は rls-functions.test.ts の実 PG 回帰 test が load-bearing に検証。
    vi.mocked(auth).mockResolvedValue({
      userId: 'user_1',
      sessionClaims: { dbUserId: '00000000-0000-0000-0000-0000000000bb' },
    } as never)
    vi.mocked(getDb).mockReturnValue(makeFakeDb({ userRows: [] }) as never)

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const result = await getCurrentUser()

    expect(result).toBeNull()
  })

  it('userId あり / DB 行欠損（webhook race）→ null を返す', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_1' } as never)
    // bootstrap が 0 行 (users 未同期) → 内部 id 未解決 → null。
    vi.mocked(getDb).mockReturnValue(makeFakeDb({ idRows: [] }) as never)

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const result = await getCurrentUser()

    expect(result).toBeNull()
  })

  // 分岐 pin (保証増・red 検証済): claim-first の呼分けを固定する。
  // RLS 依存の behavioral (ghost→null / claim あり ghost で fallback しない) は
  // RLS-off の mock では観測できず Task 10 の実 PG に委譲。ここでは「claim あり時
  // bootstrap を呼ばない / claim なし時 呼ぶ」の呼分けのみ pin する。
  it('sessionClaims.dbUserId あり → bootstrap 関数 (db.execute) を呼ばず claim の id を使う', async () => {
    const row = makeUser({
      id: '00000000-0000-0000-0000-0000000000aa',
      clerkId: 'user_1',
    })
    vi.mocked(auth).mockResolvedValue({
      userId: 'user_1',
      sessionClaims: { dbUserId: row.id },
    } as never)
    const fake = makeFakeDb({ userRows: [row] })
    vi.mocked(getDb).mockReturnValue(fake as never)

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const result = await getCurrentUser()

    expect(result?.id).toBe(row.id)
    expect(fake._bootstrapExecute).not.toHaveBeenCalled()
  })

  it('sessionClaims.dbUserId なし → bootstrap 関数 (db.execute) を 1 回呼ぶ', async () => {
    const row = makeUser({ clerkId: 'user_1' })
    vi.mocked(auth).mockResolvedValue({ userId: 'user_1' } as never)
    const fake = makeFakeDb({ idRows: [{ id: row.id }], userRows: [row] })
    vi.mocked(getDb).mockReturnValue(fake as never)

    const { getCurrentUser } = await import('@/lib/auth/ensure-user')
    const result = await getCurrentUser()

    expect(result?.id).toBe(row.id)
    expect(fake._bootstrapExecute).toHaveBeenCalledTimes(1)
  })
})
