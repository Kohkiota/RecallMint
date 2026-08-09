import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Stripe from 'stripe'

// --- hoisted mocks ---
const {
  mockSvixVerify,
  mockDbInsert,
  mockDbUpdate,
  mockDbSelect,
  mockDbDelete,
  mockDbExecute,
  mockDbTransaction,
  mockStripeListIterator,
  mockCancelWithRetry,
  mockNotifyOps,
  mockNotifyWebhookError,
  mockSyncClerkMetadata,
  mockListObjectsBounded,
  mockDeleteObject,
  mockLogger,
} = vi.hoisted(() => ({
  mockSvixVerify: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbDelete: vi.fn(),
  mockDbExecute: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockStripeListIterator: vi.fn(),
  mockCancelWithRetry: vi.fn().mockResolvedValue(undefined),
  mockNotifyOps: vi.fn().mockResolvedValue(undefined),
  mockNotifyWebhookError: vi.fn().mockResolvedValue(undefined),
  mockSyncClerkMetadata: vi.fn().mockResolvedValue({ ok: true }),
  mockListObjectsBounded: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('svix', () => ({
  Webhook: class {
    verify = mockSvixVerify
  },
}))

// RLS-P3 (Task 1): route.ts の event dedup と handle-clerk-event.ts の
// handleUserDeleted pre-tenant resolve は getNonTenantDb() へ、user.created 側の
// tenant 確立 withTenantTx(getDb(), ...) 呼出は getDb() のまま。同一 fake db を
// 両 export 経由で返す (mechanical infra follow — assertion / 挙動は不変)。
vi.mock('@/lib/db', () => {
  const fakeDb = {
    insert: mockDbInsert,
    update: mockDbUpdate,
    select: mockDbSelect,
    delete: mockDbDelete,
    execute: mockDbExecute,
    transaction: mockDbTransaction,
  }
  return {
    getDb: () => fakeDb,
    getNonTenantDb: () => fakeDb,
  }
})

vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    subscriptions: {
      list: (..._args: unknown[]) => mockStripeListIterator(),
    },
  },
  cancelWithRetry: mockCancelWithRetry,
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
  notifyWebhookError: mockNotifyWebhookError,
}))

vi.mock('@/lib/auth/clerk-metadata', () => ({
  syncClerkPublicMetadata: mockSyncClerkMetadata,
}))

// ②-4b §2: 退会 prefix purge が R2 を叩く。r2.ts は module load 時に R2_* env を
// fail-fast する (import しただけで throw する) ため、mock は必須 — hoisting を
// 誤ると suite 全体が import 時に落ちる。
vi.mock('@/lib/storage/r2', async (importOriginal) => {
  // 既定 timeout だけ実 module から取る (写すと divergence を検出できない)。全 spread
  // にしない — 未 override の export が実装のまま残ると、将来この経路から呼ばれたときに
  // loud に落ちず実 R2 へ request を投げてしまう。
  const { LIST_TIMEOUT_MS, DELETE_TIMEOUT_MS } =
    await importOriginal<typeof import('@/lib/storage/r2')>()
  return {
    LIST_TIMEOUT_MS,
    DELETE_TIMEOUT_MS,
    listObjectsBounded: mockListObjectsBounded,
    deleteObject: mockDeleteObject,
  }
})

// purge の記帳失敗 / 大域 catch は logger.error に落ちる。実 logger は console へ
// JSON を吐くだけ (never-throw) だが、負のケースを流す test で出力を汚さないため mock する。
vi.mock('@/lib/logger', () => ({ logger: mockLogger }))

import { POST } from './route'
import { purgeSourcePrefix } from '@/lib/clerk/handle-clerk-event'
import { LIST_TIMEOUT_MS, DELETE_TIMEOUT_MS } from '@/lib/storage/r2'
import { integrationFailures } from '@/lib/db/schema'
import { INTEGRATION_FAILURE_CATALOG } from '@/lib/integration-failures'

const SECRET = 'whsec_test_for_unit'

/**
 * Drizzle chain mock: 全 method を return-this で連結、`.then` で await 可能化。
 * .values() / .onConflictDoNothing() / .returning() / .set() / .where() /
 * .from() / .limit() のどこを await しても resolveTo に解決する。
 * test ごとに insert/update/select/delete の戻り値を mockReturnValueOnce で順次設定する。
 */
function chain(resolveTo: unknown = undefined) {
  const c: Record<string, unknown> = {}
  c.values = vi.fn().mockReturnValue(c)
  c.onConflictDoNothing = vi.fn().mockReturnValue(c)
  c.returning = vi.fn().mockReturnValue(c)
  c.set = vi.fn().mockReturnValue(c)
  c.where = vi.fn().mockReturnValue(c)
  c.from = vi.fn().mockReturnValue(c)
  c.limit = vi.fn().mockReturnValue(c)
  c.then = (onFulfilled: (v: unknown) => void) =>
    Promise.resolve(resolveTo).then(onFulfilled)
  return c
}

// RLS-P2 (Task 6): user.created の存在チェックと user.deleted の resolve は
// どちらも db/tx.execute(sql`... app_bootstrap_user_from_clerk(...)`) を叩き、
// setTenantContext は tx.execute(sql`... set_config(...)`)、scrub は
// tx.execute(sql`... app_scrub_deleted_user(...)`) を叩く。call 順が interleave
// するため mockReturnValueOnce では判別できない。drizzle SQL の静的 text + 補間値を
// 平坦化して substring / 引数を判定する。
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown })?.value
      if (Array.isArray(v)) return v.join('') // StringChunk (静的 text)
      if (typeof c === 'string') return c // 補間された primitive (param)
      if (typeof v === 'string') return v // Param.value
      return ''
    })
    .join('')
}

// bootstrap 関数 (app_bootstrap_user_from_clerk) が返す行。created の存在チェックと
// deleted の resolve が同一関数を叩くため、各 test が本値を設定して分岐を制御する
// (beforeEach で [] リセット = 未同期 / 新規)。
let bootstrapRows: unknown[] = []

// 目的の SQL を叩いた execute 呼び出しを substring で拾う (setTenantContext / scrub /
// resolve の発火と引数を pin する)。
function executeCallsMatching(substr: string): unknown[] {
  return mockDbExecute.mock.calls
    .map((c) => c[0])
    .filter((q) => sqlText(q).includes(substr))
}

// scrub (app_scrub_deleted_user) 実行時に err を throw する tx を返す (setTenantContext の
// set_config は成功)。DB transaction 内の scrub statement 失敗を realistic に再現する
// (旧 test の「tx.update が throw」の後継 — scrub が最初の書込 statement に移行した)。
function txThatThrowsOnScrub(err: unknown): Record<string, unknown> {
  return {
    execute: vi.fn((q: unknown) => {
      if (sqlText(q).includes('app_scrub_deleted_user')) throw err
      return Promise.resolve(undefined) // set_config は成功
    }),
    insert: mockDbInsert,
    update: mockDbUpdate,
    delete: mockDbDelete,
  }
}

// Sprint 2 dual-write: recordFailure が recordIntegrationFailure 経由で
// getDb().insert(integrationFailures).values({...}) を呼ぶ。mockDbInsert は
// clerk_events (idempotency) と integration_failures (ledger) の両方で呼ばれるため、
// 第 1 引数が integrationFailures の call だけを対象に row を拾う。
function integrationInsertRow(): Record<string, unknown> | undefined {
  const idx = mockDbInsert.mock.calls.findIndex((c) => c[0] === integrationFailures)
  if (idx === -1) return undefined
  const chainObj = mockDbInsert.mock.results[idx].value as {
    values: ReturnType<typeof vi.fn>
  }
  return chainObj.values.mock.calls[0]?.[0] as Record<string, unknown> | undefined
}

// W2: user 削除 tx は update(users) (PII scrub) と update(assets) (soft-delete
// deleting) の 2 件を発行する。呼び出し順に依存せず、table 引数 (第 1 引数) で
// 目的の update chain を引く。返す chain の .set.mock.calls[0][0] が SET payload。
function updateChainFor(table: unknown):
  | { set: ReturnType<typeof vi.fn>; where: ReturnType<typeof vi.fn> }
  | undefined {
  const idx = mockDbUpdate.mock.calls.findIndex((c) => c[0] === table)
  if (idx === -1) return undefined
  return mockDbUpdate.mock.results[idx].value as {
    set: ReturnType<typeof vi.fn>
    where: ReturnType<typeof vi.fn>
  }
}

// ②-4b §2: 台帳 INSERT された行を発行順に全件返す (purge は 1 回の退会で複数行
// 書きうるため単数版 integrationInsertRow では足りない)。beforeEach の
// mockDbInsert.mockReturnValue は同一 chain を使い回すので、chain 単位で重複排除して
// その chain の .values 呼出を全部拾う。
function integrationInsertRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  const seen = new Set<unknown>()
  mockDbInsert.mock.calls.forEach((c, i) => {
    if (c[0] !== integrationFailures) return
    const chainObj = mockDbInsert.mock.results[i].value as {
      values: ReturnType<typeof vi.fn>
    }
    if (seen.has(chainObj)) return
    seen.add(chainObj)
    for (const call of chainObj.values.mock.calls) {
      rows.push(call[0] as Record<string, unknown>)
    }
  })
  return rows
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CLERK_WEBHOOK_SECRET = SECRET
  // ②-4b §2: 既定 = purge 対象なし (listing 0 件) → 既存 test の台帳 / notifyOps
  // 件数 pin に影響しない。
  mockListObjectsBounded.mockResolvedValue({ keys: [], truncated: false })
  mockDeleteObject.mockResolvedValue({ ok: true, status: 204 })
  mockNotifyOps.mockResolvedValue(undefined)
  mockCancelWithRetry.mockResolvedValue(undefined)
  mockSyncClerkMetadata.mockResolvedValue({ ok: true })
  bootstrapRows = [] // 既定 = users 未同期 / 新規 (bootstrap 0 行)
  // ledger INSERT の default chain。idempotency INSERT の mockReturnValueOnce 消費後に
  // helper の integration_failures INSERT が undefined を返して throw-safe path
  // (ledgerWriteError) へ落ちないよう default を敷く。各 test は clerk_events を
  // mockReturnValueOnce で先に消費する。
  mockDbInsert.mockReturnValue(chain(undefined))
  // W2: user 削除 tx の drizzle update は assets (deleting soft-delete) の 1 件のみ
  // (users scrub は RLS-P2 で app_scrub_deleted_user 関数呼出 = tx.execute に移行)。
  // 呼び出しごとに新しい chain を返す。table 引数は mockDbUpdate.mock.calls に残るので
  // updateChainFor(table) で引ける。
  mockDbUpdate.mockImplementation(() => chain(undefined))
  // RLS-P2: db.execute / tx.execute の default router。app_bootstrap_user_from_clerk
  // (created 存在チェック / deleted resolve) は bootstrapRows を返し、setTenantContext の
  // set_config と app_scrub_deleted_user は no-op resolve する。
  mockDbExecute.mockImplementation((q: unknown) =>
    sqlText(q).includes('app_bootstrap_user_from_clerk')
      ? Promise.resolve(bootstrapRows)
      : Promise.resolve(undefined),
  )
  // デフォルト: transaction は callback をそのまま実行する (tx は db と同 shape)。
  // RLS-P2 で tx は execute (setTenantContext / scrub) と insert (created の users INSERT)
  // も受ける。
  mockDbTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: mockDbExecute,
        insert: mockDbInsert,
        update: mockDbUpdate,
        delete: mockDbDelete,
      }
      return await fn(tx)
    },
  )
})

function makeReq(body: unknown): Request {
  return new Request('https://test/api/webhooks/clerk', {
    method: 'POST',
    headers: {
      'svix-id': 'msg_test_1',
      'svix-timestamp': '0',
      'svix-signature': 'v1,sig',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function* asyncIterFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

describe('Clerk webhook user.created (publicMetadata sync)', () => {
  it('新規 (bootstrap 0 行): 事前採番 UUID で users INSERT (id 明示・RETURNING 非依存) → syncClerkPublicMetadata が同 id + clerkId + plan=free で呼ばれる → 200', async () => {
    mockSvixVerify.mockReturnValue({
      type: 'user.created',
      data: {
        id: 'user_new',
        email_addresses: [{ email_address: 'new@example.com' }],
      },
    })
    // 1st insert = clerk_events idempotency。bootstrapRows は beforeEach 既定 [] (新規)。
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }]))

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: {
          id: 'user_new',
          email_addresses: [{ email_address: 'new@example.com' }],
        },
      }),
    )

    expect(res.status).toBe(200)
    // users INSERT は withTenantTx 内の tx.insert (mockDbInsert 2 回目 = clerk_events の次)。
    expect(mockDbInsert).toHaveBeenCalledTimes(2)
    const usersInsertChain = mockDbInsert.mock.results[1]!.value as {
      values: ReturnType<typeof vi.fn>
    }
    const insertValues = usersInsertChain.values.mock.calls[0]![0] as Record<
      string,
      unknown
    >
    // 事前採番 pin: id を明示、clerkId / email も値どおり。RETURNING / onConflict 非使用。
    expect(insertValues.clerkId).toBe('user_new')
    expect(insertValues.email).toBe('new@example.com')
    const preNumberedId = insertValues.id as string
    expect(preNumberedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    // sync は RETURNING でなく事前採番 id を dbUserId として受ける。
    expect(mockSyncClerkMetadata).toHaveBeenCalledTimes(1)
    expect(mockSyncClerkMetadata).toHaveBeenCalledWith({
      clerkId: 'user_new',
      dbUserId: preNumberedId,
      plan: 'free',
    })
  })

  it('既存 (bootstrap が行を返す = re-fire 等): users INSERT を発行せず syncClerkPublicMetadata も skip (再配信安全)', async () => {
    // Clerk webhook の re-fire (同 svix-id ではないが users 行が他経路で先に作られた等)。
    // 事前採番の存在チェック (app_bootstrap_user_from_clerk) が既存行を検出 → INSERT せず
    // sync も skip。既存 publicMetadata の plan を free に上書きする race を防ぐ。
    mockSvixVerify.mockReturnValue({
      type: 'user.created',
      data: {
        id: 'user_dup',
        email_addresses: [{ email_address: 'dup@example.com' }],
      },
    })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_dup' }])) // clerk_events
    bootstrapRows = [{ id: '00000000-0000-0000-0000-0000000000e1' }] // 既存 users 行

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: {
          id: 'user_dup',
          email_addresses: [{ email_address: 'dup@example.com' }],
        },
      }),
    )

    expect(res.status).toBe(200)
    // clerk_events INSERT のみ (users INSERT は発行されない)。
    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
  })

  it('syncClerkPublicMetadata が ok:false でも webhook は 200 を返す (notifyOps は helper 側で発火)', async () => {
    mockSvixVerify.mockReturnValue({
      type: 'user.created',
      data: {
        id: 'user_meta_fail',
        email_addresses: [{ email_address: 'mf@example.com' }],
      },
    })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_2' }])) // clerk_events; bootstrapRows=[] 新規
    mockSyncClerkMetadata.mockResolvedValueOnce({ ok: false })

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: {
          id: 'user_meta_fail',
          email_addresses: [{ email_address: 'mf@example.com' }],
        },
      }),
    )

    expect(res.status).toBe(200)
    expect(mockSyncClerkMetadata).toHaveBeenCalledOnce()
    // helper 内で notifyOps が発火 (本 file の mock は helper を mock しているので
    // notifyOps は webhook handler 側からは呼ばれない)
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })
})

describe('Clerk webhook user.deleted (Webhook 駆動再設計)', () => {
  it('正常系: clerk_events INSERT → bootstrap resolve → Stripe sub cancel × N → DB transaction (setTenantContext + scrub 関数 + 10 delete + assets deleting) → 200', async () => {
    const internalUserId = '00000000-0000-0000-0000-0000000000a1'
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events idempotency
    // resolve は app_bootstrap_user_from_clerk (snake_case 2 列 id / stripe_customer_id)。
    bootstrapRows = [{ id: internalUserId, stripe_customer_id: 'cus_1' }]
    mockStripeListIterator.mockReturnValue(
      asyncIterFrom([
        { id: 'sub_a', status: 'active' },
        { id: 'sub_t', status: 'trialing' },
        { id: 'sub_c', status: 'canceled' },
      ]),
    )
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockDbInsert).toHaveBeenCalledTimes(1) // clerk_events のみ (失敗 0)
    expect(mockDbSelect).not.toHaveBeenCalled() // resolve は db.select → db.execute に移行
    expect(mockCancelWithRetry).toHaveBeenCalledTimes(2)
    expect(mockCancelWithRetry).toHaveBeenCalledWith('sub_a')
    expect(mockCancelWithRetry).toHaveBeenCalledWith('sub_t')
    expect(mockCancelWithRetry).not.toHaveBeenCalledWith('sub_c')
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    // drizzle update は assets deleting の 1 件のみ (users scrub は app_scrub_deleted_user
    // 関数呼出 = tx.execute に移行)。delete は Group I − assets = 10 件。
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockDbDelete).toHaveBeenCalledTimes(10)
    expect(mockNotifyOps).not.toHaveBeenCalled()
    // scrub は app_scrub_deleted_user(internalUserId) 経由 (drizzle UPDATE でない)。
    // PII を実際に NULL 化する保証は iso (rls-functions.test.ts) が実 PG で pin する。
    const scrubCalls = executeCallsMatching('app_scrub_deleted_user')
    expect(scrubCalls).toHaveLength(1)
    expect(sqlText(scrubCalls[0])).toContain(internalUserId)
    // setTenantContext が scrub の前に張られる (set_config が internalUserId で先行)。
    const setConfigIdx = mockDbExecute.mock.calls.findIndex((c) =>
      sqlText(c[0]).includes('set_config'),
    )
    const scrubIdx = mockDbExecute.mock.calls.findIndex((c) =>
      sqlText(c[0]).includes('app_scrub_deleted_user'),
    )
    expect(setConfigIdx).toBeGreaterThanOrEqual(0)
    expect(sqlText(mockDbExecute.mock.calls[setConfigIdx]![0])).toContain(internalUserId)
    expect(setConfigIdx).toBeLessThan(scrubIdx)
    // W2: assets は物理 DELETE でなく status='deleting' へ soft-delete される。
    const assetsUpdate = updateChainFor(schemaModule.assets)
    expect(assetsUpdate).toBeDefined()
    const assetsSet = assetsUpdate!.set.mock.calls[0]![0] as Record<string, unknown>
    expect(assetsSet.status).toBe('deleting')
  })

  it('GDPR PII scrub: scrub は app_scrub_deleted_user(internalUserId) 関数呼出で行い users を drizzle UPDATE しない (stripe_customer_id は関数が保持)、同 transaction で Group I 子テーブル DELETE + assets deleting も発火', async () => {
    // GDPR 要件: 退会と同 transaction で PII (email/clerk_id) を NULL 化する。RLS-P2 で
    // これは app_scrub_deleted_user (SECURITY DEFINER・冒頭で tenant context 自衛検査) に
    // 委譲された。実際の NULL 化 + stripe_customer_id 保持の behavioral 保証は iso
    // (rls-functions.test.ts) が実 PG で pin する。unit 側は「scrub が関数経由で発火し
    // users を drizzle UPDATE しない (= stripe_customer_id を上書きする経路が無い)」
    // 「Group I 削除が同 tx で atomic」を pin する。
    const internalUserId = '00000000-0000-0000-0000-0000000000cc'
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_scrub' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_scrub' }])) // clerk_events
    bootstrapRows = [{ id: internalUserId, stripe_customer_id: 'cus_keep' }]
    mockStripeListIterator.mockReturnValue(asyncIterFrom([])) // no subs
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_scrub' } }))

    expect(res.status).toBe(200)
    // scrub は関数呼出 (drizzle UPDATE でない)。internalUserId が引数。
    const scrubCalls = executeCallsMatching('app_scrub_deleted_user')
    expect(scrubCalls).toHaveLength(1)
    expect(sqlText(scrubCalls[0])).toContain(internalUserId)
    // users を drizzle で UPDATE しない (= stripe_customer_id を上書きする経路が無い)。
    expect(updateChainFor(schemaModule.users)).toBeUndefined()
    // atomicity: 同一 transaction 内で Group I の子テーブル削除も発火 (部分 commit 防止)。
    // assets は soft-delete (deleting UPDATE) ゆえ DELETE は 10 件。
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    expect(mockDbDelete).toHaveBeenCalledTimes(10)
    // W2: assets の soft-delete も同一 tx で発火 (deleting UPDATE)。
    const assetsUpdate = updateChainFor(schemaModule.assets)
    expect(assetsUpdate).toBeDefined()
    const assetsSet = assetsUpdate!.set.mock.calls[0]![0] as Record<string, unknown>
    expect(assetsSet.status).toBe('deleting')
  })

  it('GDPR scrub 冪等性: 同 svix-id 再送は clerk_events dedup で handler 不到達 → 二重 scrub 起きない', async () => {
    // scrub は UPDATE SET email=null/clerkId=null で値レベルでは冪等だが、
    // 二重実行自体が clerk_events.event_id (svix-id) PK の ON CONFLICT DO NOTHING
    // で抑止される。 1 回目で returning [{id}]、 2 回目 (returning []) で early
    // return = handler / tx.update に到達しない。
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_scrub_dup' } })
    mockDbInsert.mockReturnValueOnce(chain([])) // 2 回目: returning [] = dedup hit

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_scrub_dup' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('duplicate')
    expect(mockDbExecute).not.toHaveBeenCalled() // resolve / scrub 不到達
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('users 未同期 (bootstrap 0 行): notifyOps で観測性確保 (文言中立) + Stripe loop 不到達 + transaction 不到達 + 200', async () => {
    // F-5 fix-up (review M-1): user.created 未到達 / 既に scrub 済 (clerk_id NULL 化) で
    // user.deleted 受信 = bootstrap が 0 行。internalUserId が undefined になる →
    // silent skip させず notifyOps で OT 通知。RLS-P2 でデータ上は「未同期」と
    // 「削除済」を区別できないため文言を中立化 (spec §2.6)。
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_orphan' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
    bootstrapRows = [] // 0 rows (users 行なし or scrub 済)

    const res = await POST(
      makeReq({ type: 'user.deleted', data: { id: 'user_orphan' } }),
    )

    expect(res.status).toBe(200)
    // resolve (bootstrap) は 1 回発火するが scrub / tx へは進まない。
    expect(executeCallsMatching('app_bootstrap_user_from_clerk')).toHaveLength(1)
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockDbInsert).toHaveBeenCalledTimes(1) // clerk_events のみ、integration_failures に書かない
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'user.deleted received but users row not found (not-synced or already-deleted)',
    )
    const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
    expect(ctx.clerkUserId).toBe('user_orphan')
  })

  it('customerId なし (Free プラン): Stripe ループ skip → transaction のみ実行', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_free' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
    // resolve: stripe_customer_id = null (Free プラン)
    bootstrapRows = [
      { id: '00000000-0000-0000-0000-0000000000b1', stripe_customer_id: null },
    ]
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_free' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    // drizzle update × 1 (assets deleting soft-delete のみ) / delete × 10 (Group I − assets)
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockDbDelete).toHaveBeenCalledTimes(10)
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('transaction 失敗 (permanent error): integration_failures (deletion_data) → notifyOps subject="user data deletion failure", retry なし', async () => {
    // I-2 realistic harness: tx.update が permanent pg error (23505 = unique violation)
    // を throw する。transaction callback が reject → retry せず即 recordFailure。
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // integration_failures INSERT
    bootstrapRows = [
      { id: '00000000-0000-0000-0000-0000000000a1', stripe_customer_id: null },
    ]
    // scrub statement が permanent error を throw (callback 内 statement reject = realistic)
    const permanentErr = Object.assign(new Error('unique constraint violation'), { code: '23505' })
    mockDbTransaction.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(txThatThrowsOnScrub(permanentErr)),
    )

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    // permanent → retry なし = transaction は 1 回のみ
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    // integration_failures INSERT が呼ばれる
    expect(mockDbInsert).toHaveBeenCalledTimes(2)
    // Discord notify は byte 不変 (subject 別文言 + context の kind は旧 'data_deletion')
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe('user data deletion failure')
    const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
    expect(ctx.kind).toBe('data_deletion')
    // dual-write: ledger 行に catalog の 4 軸 (deletion_data) + 型付き ref。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.deletion_data
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      userId: '00000000-0000-0000-0000-0000000000a1',
      clerkId: 'user_1',
    })
    expect(row!.stripeSubscriptionId).toBeUndefined() // subId=null → helper が undefined 化 (ref 列を省略 = DB は NULL)
  })

  it('重複 svix-id (idempotency skip): 2 回目は handler 未到達で 200 "duplicate"', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    // returning [] = ON CONFLICT で skip
    mockDbInsert.mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('duplicate')
    expect(mockDbExecute).not.toHaveBeenCalled() // resolve / scrub 不到達
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('個別 cancel 失敗: integration_failures (deletion_cancel) + notifyOps を per-sub で呼び loop 継続 + transaction 実行', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // integration_failures (sub_a 失敗)
    bootstrapRows = [
      { id: '00000000-0000-0000-0000-0000000000a1', stripe_customer_id: 'cus_1' },
    ]
    mockStripeListIterator.mockReturnValue(
      asyncIterFrom([
        { id: 'sub_a', status: 'active' },
        { id: 'sub_b', status: 'active' },
      ]),
    )
    mockCancelWithRetry
      .mockRejectedValueOnce(new Error('stripe error mid-cancel'))
      .mockResolvedValueOnce(undefined)
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).toHaveBeenCalledTimes(2)
    expect(mockDbInsert).toHaveBeenCalledTimes(2) // clerk_events + integration_failures × 1
    // Discord notify は byte 不変 (subject / context 不変。context の kind は旧 'cancel')
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'stripe sub cancel failure during deletion',
    )
    expect(mockNotifyOps.mock.calls[0]![1]).toMatchObject({ kind: 'cancel' })
    // dual-write: ledger 行に catalog の 4 軸 (deletion_cancel) + 型付き ref。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.deletion_cancel
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      userId: '00000000-0000-0000-0000-0000000000a1',
      clerkId: 'user_1',
      stripeSubscriptionId: 'sub_a',
      errorMessage: 'Error: stripe error mid-cancel',
    })
    // Stripe 失敗後も transaction が走る (forward-only)
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
  })

  it('list 失敗 (customer_missing): integration_failures (deletion_customer_missing) で recordFailure + transaction 実行', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // integration_failures
    bootstrapRows = [
      { id: '00000000-0000-0000-0000-0000000000a2', stripe_customer_id: 'cus_gone' },
    ]
    const customerMissing = new Stripe.errors.StripeInvalidRequestError({
      message: 'No such customer',
      code: 'resource_missing',
      type: 'invalid_request_error',
    })
    mockStripeListIterator.mockImplementation(() => {
      throw customerMissing
    })
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    // Discord notify は byte 不変 (context の kind は旧 'customer_missing')
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'stripe sub cancel failure during deletion',
    )
    expect(mockNotifyOps.mock.calls[0]![1]).toMatchObject({
      kind: 'customer_missing',
    })
    // dual-write: ledger 行に catalog の 4 軸 (deletion_customer_missing) + 型付き ref。
    // subId=null ゆえ stripeSubscriptionId は null。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.deletion_customer_missing
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      userId: '00000000-0000-0000-0000-0000000000a2',
      clerkId: 'user_1',
    })
    expect(row!.stripeSubscriptionId).toBeUndefined() // subId=null → helper が undefined 化 (ref 列を省略 = DB は NULL)
    // customer_missing 後も transaction は実行される (forward-only)
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
  })

  it('outer catch (handler 内 throw): notifyWebhookError(handler=clerk, eventId=svixId, eventType, err, userId) + 200 swallow', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.created', data: { id: 'user_x' } })
    // 1st insert = clerk_events idempotency OK, 2nd insert = users INSERT が throw
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }]))
      .mockImplementationOnce(() => {
        throw new Error('boom: users insert down')
      })

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: {
          id: 'user_x',
          email_addresses: [{ email_address: 'x@example.com' }],
        },
      }),
    )

    expect(res.status).toBe(200)
    expect(mockNotifyWebhookError).toHaveBeenCalledTimes(1)
    const arg = mockNotifyWebhookError.mock.calls[0]![0] as {
      handler: string
      eventId: string
      eventType: string
      userId?: string
      err: unknown
    }
    expect(arg.handler).toBe('clerk')
    expect(arg.eventId).toBe('msg_test_1')
    expect(arg.eventType).toBe('user.created')
    expect(arg.userId).toBe('user_x')
    expect(arg.err).toBeInstanceOf(Error)
    expect((arg.err as Error).message).toBe('boom: users insert down')
    // Spec §2 invariant: environment / timestamp は callsite では渡さず helper 内部で
    // 自動付与する。callsite 引数に load されたら spec drift。
    expect(arg).not.toHaveProperty('environment')
    expect(arg).not.toHaveProperty('timestamp')
    // recordFailure path (notifyOps) は別経路、本ケースでは発火しない
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  // ---- T3 retry テスト ----

  describe('DB transaction retry (T3)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    // beforeEach でセットアップする共通の select / stripe ヘルパー
    function setupUserAndNoStripe(userId = '00000000-0000-0000-0000-000000000099') {
      mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      bootstrapRows = [{ id: userId, stripe_customer_id: null }]
    }

    it('① transient error (40P01 = deadlock) → 1 回失敗 → retry で成功', async () => {
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r1' } })
      setupUserAndNoStripe()

      const transientErr = Object.assign(new Error('deadlock detected'), { code: '40P01' })
      let callCount = 0
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          callCount++
          if (callCount === 1) {
            // 1 回目: scrub statement が transient error で throw
            return fn(txThatThrowsOnScrub(transientErr))
          }
          // 2 回目 (retry): 成功。default router execute で set_config / scrub は no-op。
          mockDbDelete.mockReturnValue(chain(undefined))
          const tx = {
            execute: mockDbExecute,
            insert: mockDbInsert,
            update: mockDbUpdate,
            delete: mockDbDelete,
          }
          return fn(tx)
        },
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r1' } }))
      // retry1 前の 500ms backoff を進める
      await vi.advanceTimersByTimeAsync(500)
      const res = await promise

      expect(res.status).toBe(200)
      expect(mockDbTransaction).toHaveBeenCalledTimes(2) // 初回 + 1 retry
      expect(mockNotifyOps).not.toHaveBeenCalled() // 成功したので recordFailure なし
    })

    it('② transient error (40P01) で 4 回全失敗 → recordFailure(data_deletion), errorMessage に試行回数 + code', async () => {
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r2' } })
      setupUserAndNoStripe()
      mockDbInsert.mockReturnValueOnce(chain(undefined)) // integration_failures INSERT

      const transientErr = Object.assign(new Error('deadlock detected'), { code: '40P01' })
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(txThatThrowsOnScrub(transientErr)),
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r2' } }))
      // 3 回の retry backoff: 500ms + 1000ms + 2000ms
      await vi.advanceTimersByTimeAsync(500 + 1000 + 2000)
      const res = await promise

      expect(res.status).toBe(200)
      expect(mockDbTransaction).toHaveBeenCalledTimes(4) // 初回 + 3 retries
      expect(mockNotifyOps).toHaveBeenCalledOnce()
      expect(mockNotifyOps.mock.calls[0]![0]).toBe('user data deletion failure')
      const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
      expect(ctx.kind).toBe('data_deletion')
      // errorMessage に試行回数と pg code が含まれる (I-3)
      const errMsg = String(ctx.error)
      expect(errMsg).toMatch(/4\s*(attempts|回)/)
      expect(errMsg).toMatch(/40P01/)
    })

    it('③ permanent error (23505 = unique violation) → retry せず即 recordFailure', async () => {
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r3' } })
      setupUserAndNoStripe()
      mockDbInsert.mockReturnValueOnce(chain(undefined)) // integration_failures INSERT

      const permanentErr = Object.assign(new Error('unique constraint'), { code: '23505' })
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(txThatThrowsOnScrub(permanentErr)),
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r3' } }))
      // permanent は即中断 — timer を進めても retry が走らないことを確認
      await vi.advanceTimersByTimeAsync(5000)
      const res = await promise

      expect(res.status).toBe(200)
      expect(mockDbTransaction).toHaveBeenCalledTimes(1) // retry なし
      expect(mockNotifyOps).toHaveBeenCalledOnce()
      const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
      expect(ctx.kind).toBe('data_deletion')
      // errorMessage に pg code が含まれる (I-3)
      expect(String(ctx.error)).toMatch(/23505/)
    })

    it.each([
      ['40001 (serialization failure)', Object.assign(new Error('serialization failure'), { code: '40001' })],
      ['08006 (connection failure)', Object.assign(new Error('connection failure'), { code: '08006' })],
      ['57P01 (admin shutdown)', Object.assign(new Error('admin shutdown'), { code: '57P01' })],
      ['code なし (connection 切断系)', new Error('connection closed unexpectedly')],
    ])('④ transient code %s が retry される', async (_label, transientErr) => {
      // 代表 transient codes が isTransientDbError=true → retry が発生し成功することを確認。
      // vi.clearAllMocks を loop 内で呼ばず it.each で独立テストにする (fake timer との競合回避)。
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r4' } })
      setupUserAndNoStripe()

      let callCount = 0
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          callCount++
          if (callCount === 1) {
            // 1 回目: scrub statement が transient error で throw
            return fn(txThatThrowsOnScrub(transientErr))
          }
          // 2 回目 (retry): 成功。default router execute で set_config / scrub は no-op。
          mockDbDelete.mockReturnValue(chain(undefined))
          const tx = {
            execute: mockDbExecute,
            insert: mockDbInsert,
            update: mockDbUpdate,
            delete: mockDbDelete,
          }
          return fn(tx)
        },
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r4' } }))
      await vi.advanceTimersByTimeAsync(500)
      const res = await promise

      expect(res.status).toBe(200)
      // retry が 1 回発生 = 合計 2 回呼ばれる
      expect(mockDbTransaction).toHaveBeenCalledTimes(2)
      expect(mockNotifyOps).not.toHaveBeenCalled() // 成功したので recordFailure なし
    })

    it('⑤ errorMessage に試行回数 + pg code が含まれる (I-3 診断値検証)', async () => {
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r5' } })
      setupUserAndNoStripe()
      mockDbInsert.mockReturnValueOnce(chain(undefined)) // integration_failures INSERT

      // permanent error で即停止 → errorMessage を検証
      const pgErr = Object.assign(new Error('FK violation'), { code: '23503', detail: 'foreign key constraint' })
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => fn(txThatThrowsOnScrub(pgErr)),
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r5' } }))
      await vi.advanceTimersByTimeAsync(0)
      const res = await promise

      expect(res.status).toBe(200)
      const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
      const errMsg = String(ctx.error)
      // I-3: pg code が明示されていること
      expect(errMsg).toMatch(/23503/)
      // I-3: 試行回数 1 (initial, no retries for permanent) が含まれること
      expect(errMsg).toMatch(/1\s*(attempt|回)/)
    })
  })

  it('page-level partial 失敗 (deletion_list): canceledIds + offset を error_message に詰める + transaction 実行', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // integration_failures (list 失敗)
    bootstrapRows = [
      { id: '00000000-0000-0000-0000-0000000000a1', stripe_customer_id: 'cus_1' },
    ]
    async function* failingIter(): AsyncGenerator<{
      id: string
      status: Stripe.Subscription.Status
    }> {
      yield { id: 'sub_a', status: 'active' }
      throw new Error('network reset on next page')
    }
    mockStripeListIterator.mockReturnValue(failingIter())
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).toHaveBeenCalledWith('sub_a')
    // Discord notify は byte 不変 (context の kind は旧 'list'・error 文言不変)
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'stripe sub cancel failure during deletion',
    )
    const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
    expect(ctx.kind).toBe('list')
    expect(String(ctx.error)).toMatch(/page fetch failed at offset 1/)
    expect(String(ctx.error)).toMatch(/Canceled before failure: \[sub_a\]/)
    // dual-write: ledger 行に catalog の 4 軸 (deletion_list) + 型付き ref。
    // subId=null ゆえ stripeSubscriptionId は null。errorMessage = notify context.error と同一。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.deletion_list
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      userId: '00000000-0000-0000-0000-0000000000a1',
      clerkId: 'user_1',
    })
    expect(row!.stripeSubscriptionId).toBeUndefined() // subId=null → helper が undefined 化 (ref 列を省略 = DB は NULL)
    expect(String(row!.errorMessage)).toMatch(/page fetch failed at offset 1/)
    // list 失敗後も transaction は実行される (forward-only)
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// ②-4b §2: 退会時の src/{userId}/ prefix purge
// ---------------------------------------------------------------------------
// spec: docs/superpowers/specs/2026-08-09-ocr-2-4b-s2-deletion-src-purge-design.md
// 配線 (route → handleEvent → handleUserDeleted → 外周 finally) をここで pin し、
// 予算 / 上限 / 台帳の細目は purgeSourcePrefix の直接 unit test (下の describe) で
// 時刻注入して pin する。

const PURGE_UID = '00000000-0000-0000-0000-0000000000d1'
const PURGE_PREFIX = `src/${PURGE_UID}/`

function srcKeys(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${PURGE_PREFIX}sess/${i}.pdf`)
}

// 台帳行を 4 軸の operation で振り分ける (delete 失敗行 = object.delete /
// 打ち切り行 = src_purge.incomplete)。
function purgeRows(operation: 'object.delete' | 'src_purge.incomplete') {
  return integrationInsertRows().filter(
    (r) => r.operation === operation && r.workflow === 'user_deletion',
  )
}

describe('Clerk webhook user.deleted: src/ prefix purge 配線 (②-4b §2)', () => {
  function setupDeleted(clerkId: string, stripeCustomerId: string | null = null) {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: clerkId } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_purge' }])) // clerk_events
    bootstrapRows = [{ id: PURGE_UID, stripe_customer_id: stripeCustomerId }]
    mockDbDelete.mockReturnValue(chain(undefined))
  }

  it('正常系: 末尾スラッシュ付き prefix で listing → 返った key 全件に deleteObject → 台帳行なし', async () => {
    setupDeleted('user_purge_ok')
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(3), truncated: false })

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_purge_ok' } }))

    expect(res.status).toBe(200)
    // 末尾スラッシュ必須 (`src/{uid}` だと別 uuid の前方一致を拾いうる)。
    expect(mockListObjectsBounded).toHaveBeenCalledTimes(1)
    expect(mockListObjectsBounded.mock.calls[0]![0]).toBe(PURGE_PREFIX)
    expect(mockDeleteObject).toHaveBeenCalledTimes(3)
    for (const key of srcKeys(3)) {
      expect(mockDeleteObject).toHaveBeenCalledWith(key, expect.anything())
    }
    // 成功のみ = 台帳不呼出 (clerk_events INSERT の 1 件だけ)
    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('bootstrap 0 行 (early return): prefix を導出できないので listing しない', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_orphan_p' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_purge' }]))
    bootstrapRows = []

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_orphan_p' } }))

    expect(res.status).toBe(200)
    expect(mockListObjectsBounded).not.toHaveBeenCalled()
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('不変条件 2: B (Stripe cancel の記帳) が throw しても purge は実行される (外周 finally)', async () => {
    // recordFailure → recordIntegrationFailure → notifyOps は production misconfig で
    // throw する契約 (lib/integration-failures.ts) = B は throw しうる。
    setupDeleted('user_purge_b', 'cus_p')
    mockStripeListIterator.mockReturnValue(asyncIterFrom([{ id: 'sub_a', status: 'active' }]))
    mockCancelWithRetry.mockRejectedValueOnce(new Error('stripe down'))
    mockNotifyOps.mockRejectedValue(new Error('OPS_DISCORD_WEBHOOK_URL must be set'))
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(1), truncated: false })

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_purge_b' } }))

    expect(res.status).toBe(200)
    // B の記帳 throw で DB tx へは進まない (既存挙動) が、purge は finally で到達する。
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockListObjectsBounded).toHaveBeenCalledTimes(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(srcKeys(1)[0], expect.anything())
  })

  it('不変条件 2: C (DB tx 失敗の記帳) が throw しても purge は実行される (外周 finally)', async () => {
    setupDeleted('user_purge_c')
    const permanentErr = Object.assign(new Error('unique constraint'), { code: '23505' })
    mockDbTransaction.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(txThatThrowsOnScrub(permanentErr)),
    )
    mockNotifyOps.mockRejectedValue(new Error('OPS_DISCORD_WEBHOOK_URL must be set'))
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(2), truncated: false })

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_purge_c' } }))

    // route は 200 を返し続ける (outer catch が notifyWebhookError で吸収)
    expect(res.status).toBe(200)
    expect(mockNotifyWebhookError).toHaveBeenCalledTimes(1)
    expect(mockListObjectsBounded).toHaveBeenCalledTimes(1)
    expect(mockDeleteObject).toHaveBeenCalledTimes(2)
  })

  it('予算の原点は POST() 冒頭: 先行処理が 55s 使っていたら listing すら開始せず no_budget', async () => {
    // 時間の消費を **svix 検証の時点** (= POST 冒頭より後・handleEvent 呼出より前) に
    // 置く。これにより「原点が POST 冒頭であること」を pin できる —
    //   - 原点が purge 開始 (handlerStart 伝播なし) なら 20s 予算で走ってしまう
    //   - 原点が handleEvent 呼出直前なら先行処理の 55s を数え落として走ってしまう
    // のどちらでも red になる。
    vi.useFakeTimers()
    try {
      setupDeleted('user_purge_slow')
      mockSvixVerify.mockImplementation(() => {
        vi.setSystemTime(new Date(Date.now() + 55_000))
        return { type: 'user.deleted', data: { id: 'user_purge_slow' } }
      })
      mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(3), truncated: false })

      const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_purge_slow' } }))

      expect(res.status).toBe(200)
      expect(mockListObjectsBounded).not.toHaveBeenCalled()
      expect(mockDeleteObject).not.toHaveBeenCalled()
      const rows = purgeRows('src_purge.incomplete')
      expect(rows).toHaveLength(1)
      expect((rows[0]!.context as Record<string, unknown>).phase).toBe('no_budget')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('purgeSourcePrefix (②-4b §2 spec §3.2 / §3.3)', () => {
  // 時刻注入: 実 sleep なしで予算切れを再現する。deadline は絶対時刻で渡す。
  let clockNow = 0
  const now = () => clockNow

  beforeEach(() => {
    clockNow = 0
  })

  // 予算たっぷり (workDeadline = 16_000 / floor 2_000) の既定 deadline。
  const AMPLE_DEADLINE = 20_000

  it('truncated: phase=list_truncated を 1 行 + 取れた分の DELETE は実行される', async () => {
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(2), truncated: true })

    await purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)

    expect(mockDeleteObject).toHaveBeenCalledTimes(2)
    const rows = purgeRows('src_purge.incomplete')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.failureCode).toBe('incomplete')
    expect(rows[0]!.context).toMatchObject({
      userId: PURGE_UID,
      phase: 'list_truncated',
      deleteRequested: 2,
      remaining: 0,
    })
    expect(purgeRows('object.delete')).toHaveLength(0)
  })

  it('listing throw: phase=list + errorMessage を 1 行にして飲む (throw しない)', async () => {
    mockListObjectsBounded.mockRejectedValue(
      new Error('listObjects failed: prefix=src/x/ status=500'),
    )

    await expect(purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)).resolves.toBeUndefined()

    expect(mockDeleteObject).not.toHaveBeenCalled()
    const rows = purgeRows('src_purge.incomplete')
    expect(rows).toHaveLength(1)
    expect((rows[0]!.context as Record<string, unknown>).phase).toBe('list')
    expect(String(rows[0]!.errorMessage)).toContain('listObjects failed')
  })

  it('上限: 失敗 20 件ちょうど → 個別 20 行のみ (打ち切り行を書かない)', async () => {
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(20), truncated: false })
    mockDeleteObject.mockResolvedValue({ ok: false, status: 500 })

    await purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)

    expect(purgeRows('object.delete')).toHaveLength(20)
    expect(purgeRows('src_purge.incomplete')).toHaveLength(0)
  })

  it('上限: 失敗 21 件 → 個別 19 行 + incomplete 1 行 (計 20) で suppressedFailures = 総数 - 19', async () => {
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(21), truncated: false })
    mockDeleteObject.mockResolvedValue({ ok: false, status: 500 })

    await purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)

    expect(purgeRows('object.delete')).toHaveLength(19)
    const rows = purgeRows('src_purge.incomplete')
    expect(rows).toHaveLength(1)
    expect((rows[0]!.context as Record<string, unknown>).suppressedFailures).toBe(2)
  })

  it('deadline: 残予算が floor を切ったら残 chunk を deleteObject せず phase=deadline を記録', async () => {
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(40), truncated: false })
    // 1 chunk (20 件) で 15s 消費 → 残 1s < floor 2s で 2 chunk 目に入らない。
    mockDeleteObject.mockImplementation(async () => {
      clockNow += 750
      return { ok: true, status: 204 }
    })

    await purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)

    expect(mockDeleteObject).toHaveBeenCalledTimes(20)
    const rows = purgeRows('src_purge.incomplete')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.context).toMatchObject({
      phase: 'deadline',
      deleteRequested: 20,
      remaining: 20,
    })
  })

  it('記帳の予算 gate: 残予算が尽きたら個別行の書き込みを止め、書けなかった分を suppressedFailures に計上する', async () => {
    // 記帳は 1 件あたり DB INSERT + notifyOps で最大数秒かかる。gate が無いと 19 回の
    // 記帳だけで workDeadline を大幅に超え、feature が守ろうとしている予算を自ら壊す。
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(5), truncated: false })
    mockDeleteObject.mockResolvedValue({ ok: false, status: 500 })
    // 記帳 1 本 = 6s 消費 (残予算 16s → 3 本で floor を割る)。
    mockNotifyOps.mockImplementation(async () => {
      clockNow += 6_000
    })

    await purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)

    expect(purgeRows('object.delete')).toHaveLength(3)
    const rows = purgeRows('src_purge.incomplete')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.context).toMatchObject({ phase: 'deadline', suppressedFailures: 2 })
  })

  it('phase 優先順位: list_truncated と deadline の同時成立は list_truncated 1 本に統合する', async () => {
    // truncated (2 page ≈ 1000 key 超) は chunk 数が多く deadline にも当たりやすい =
    // 構造的に最も起きやすい組合せ。より早い段階で諦めた事実 (list_truncated) を残す。
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(40), truncated: true })
    mockDeleteObject.mockImplementation(async () => {
      clockNow += 750
      return { ok: true, status: 204 }
    })

    await purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)

    expect(mockDeleteObject).toHaveBeenCalledTimes(20) // chunk 2 は deadline で skip
    const rows = purgeRows('src_purge.incomplete')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.context).toMatchObject({
      phase: 'list_truncated',
      deleteRequested: 20,
      remaining: 20,
    })
  })

  it('4 軸の意味: deadline 打ち切りは external_api_error で記録されない (R2 障害として集計しない)', async () => {
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(40), truncated: false })
    mockDeleteObject.mockImplementation(async () => {
      clockNow += 750
      return { ok: true, status: 204 }
    })

    await purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)

    const rows = integrationInsertRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.failureCode).toBe('incomplete')
    expect(rows[0]!.operation).toBe('src_purge.incomplete')
    expect(rows.some((r) => r.failureCode === 'external_api_error')).toBe(false)
  })

  it('no_budget: 開始時点で残予算が floor 未満なら listing すら開始しない', async () => {
    await purgeSourcePrefix(PURGE_UID, 1_000, now) // workDeadline = -3_000

    expect(mockListObjectsBounded).not.toHaveBeenCalled()
    expect(mockDeleteObject).not.toHaveBeenCalled()
    const rows = purgeRows('src_purge.incomplete')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.context).toMatchObject({
      phase: 'no_budget',
      deleteRequested: 0,
      remaining: 0,
    })
  })

  it('不変条件 7: 個別記帳が throw しても後続 key の DELETE は続く', async () => {
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(21), truncated: false })
    mockDeleteObject.mockImplementation(async (key: string) =>
      key === srcKeys(21)[0] ? { ok: false, status: 500 } : { ok: true, status: 204 },
    )
    // 記帳は notifyOps の throw を伝播する (= 記帳 1 本が throw する realistic な形)。
    mockNotifyOps.mockRejectedValue(new Error('OPS_DISCORD_WEBHOOK_URL must be set'))

    await expect(purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)).resolves.toBeUndefined()

    // chunk 1 (0..19) の記帳が throw した後も chunk 2 (20 件目) の DELETE が走る。
    expect(mockDeleteObject).toHaveBeenCalledTimes(21)
    expect(mockDeleteObject).toHaveBeenCalledWith(srcKeys(21)[20], expect.anything())
  })

  it('不変条件 1: 契約外の throw (deleteObject が throw) でも purge 自身は throw しない', async () => {
    // finally 内から throw すると B / C の元例外を握り潰すため never-throw は構造的に必須。
    // deleteObject は never-throw 契約 (r2.ts) だがそれに依存しない大域 catch を pin する。
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(1), truncated: false })
    mockDeleteObject.mockRejectedValue(new Error('contract violation'))

    await expect(purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)).resolves.toBeUndefined()
  })

  it('不変条件 7: list_truncated の記帳が throw しても取得済み key の DELETE は実行される', async () => {
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(3), truncated: true })
    mockNotifyOps.mockRejectedValue(new Error('OPS_DISCORD_WEBHOOK_URL must be set'))

    await expect(purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)).resolves.toBeUndefined()

    expect(mockDeleteObject).toHaveBeenCalledTimes(3)
  })

  it('不変条件 8: prefix 外の key は deleteObject せず記録する (破壊境界の二重関門)', async () => {
    const outside = 'src/00000000-0000-0000-0000-0000000000ff/sess/x.pdf'
    mockListObjectsBounded.mockResolvedValue({
      keys: [srcKeys(1)[0]!, outside],
      truncated: false,
    })

    await purgeSourcePrefix(PURGE_UID, AMPLE_DEADLINE, now)

    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(srcKeys(1)[0], expect.anything())
    expect(mockDeleteObject).not.toHaveBeenCalledWith(outside, expect.anything())
    // DELETE を試行していない行は context.reason で識別する (errorMessage の free text を
    // parse させない)。status===null は「fetch throw / timeout」の識別子なので、この行に
    // errorMessage は付けない (§3.3)。
    const rows = purgeRows('object.delete')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.context).toMatchObject({
      objectKey: outside,
      status: null,
      reason: 'prefix_mismatch',
    })
    expect(rows[0]!.errorMessage).toBeUndefined()
  })

  it('in-flight I/O の timeout: 残予算が十分なら既定 (LIST / DELETE それぞれの既定) が上限', async () => {
    // 既定値は literal で写さず r2.ts の export を照合相手にする (写すと divergence を
    // 検出できない)。LIST / DELETE は別々の既定を持ちうるので別々に照合する。
    // 残予算 26s → listing の 1 page 取り分 13s > 既定 10s ゆえ既定側が binding。
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(1), truncated: false })

    await purgeSourcePrefix(PURGE_UID, 30_000, now) // workDeadline 26_000

    expect(mockListObjectsBounded).toHaveBeenCalledWith(PURGE_PREFIX, 2, {
      timeoutMs: LIST_TIMEOUT_MS,
    })
    expect(mockDeleteObject).toHaveBeenCalledWith(srcKeys(1)[0], {
      timeoutMs: DELETE_TIMEOUT_MS,
    })
  })

  it('DELETE の timeout は min(既定, 残予算) — 残予算が既定より小さい場合', async () => {
    // DELETE は 1 回の呼出ごとに残予算を再評価する = 多重化しないので残予算そのままでよい。
    mockListObjectsBounded.mockResolvedValue({ keys: srcKeys(1), truncated: false })

    await purgeSourcePrefix(PURGE_UID, 12_000, now) // workDeadline 8_000 = 残予算 8s

    expect(mockDeleteObject).toHaveBeenCalledWith(srcKeys(1)[0], { timeoutMs: 8_000 })
  })

  it('listing の timeout は 1 page あたりの取り分 — maxPages 倍しても残予算を超えない', async () => {
    // listObjectsBounded の timeoutMs は **page ごとに** AbortSignal.timeout へ適用される
    // (全体の上限ではない)。残予算をそのまま渡すと最悪 maxPages 倍かかり workDeadline を
    // 超え、tail reserve ごと食い潰して incomplete 行すら書けなくなる。
    mockListObjectsBounded.mockResolvedValue({ keys: [], truncated: false })

    await purgeSourcePrefix(PURGE_UID, 12_000, now) // workDeadline 8_000 = 残予算 8s

    const [, maxPages, opts] = mockListObjectsBounded.mock.calls[0] as [
      string,
      number,
      { timeoutMs: number },
    ]
    expect(opts.timeoutMs * maxPages).toBeLessThanOrEqual(8_000)
    expect(opts.timeoutMs).toBe(4_000)
  })
})

// ---------------------------------------------------------------------------
// 削除網羅性 invariant test
// ---------------------------------------------------------------------------
// schema を真実 source として、 「user_id を direct FK で users.id に cascade
// するテーブル」 のうち、 親 cascade chain (exams / cards 経由など) で間接削除
// されない「Group I」 を機械的に列挙し、 handler の tx.delete(...) 集合と一致する
// ことを検証する。
//
// 目的: 将来 schema に user_id direct FK の新テーブルが追加されたとき、 handler
// (route.ts の handleUserDeleted の transaction body) に明示 DELETE を加え忘れたら
// このテストが落ちて気づける (handler 集約コメント参照)。
//
// 判定式 (handler 集約コメントと同じ):
//   table T は Group I (= 明示 DELETE 対象) ⟺
//     T.userId が users.id に references({ onDelete: 'cascade' }) を持ち、
//     かつ T の他の FK の中に、 onDelete='cascade' で parent が user cascade chain
//     を持つ (direct or transitive) ものが存在しない
//
describe('Clerk webhook user.deleted: 削除網羅性 invariant', () => {
  // W2 soft-delete 例外: assets は Group I (schema 上は user_id direct cascade FK・親 chain
  // なし) だが、 handler は物理 DELETE でなく status='deleting' への UPDATE で soft-delete
  // する (spec §4.8)。 理由 = R2 object への手掛かり (object_key) を保全し GC reconciler の
  // 優先 sweep に物理回収を委ねるため。 よって「明示 DELETE 集合 = Group I」 の不変条件から
  // assets のみを除外する。 assets 以外の新規 user_id FK テーブルが増えたら従来どおり明示
  // DELETE 必須 (assets だけが soft の例外) — 下の invariant がそれを検知し続ける。
  const SOFT_DELETED_GROUP_I = new Set([tableName(schemaModule.assets)])

  it('handler の tx.delete 集合 = Group I − soft-delete 例外 (新規 user_id FK テーブル追加検知)', async () => {
    // schema を読み Group I を機械算出。assets は依然 Group I (schema は不変) だが、
    // 期待 DELETE 集合からは soft-delete 例外として除外する。
    const groupINames = computeGroupITables().map(tableName)
    expect(groupINames.length).toBeGreaterThan(0) // sanity
    // 例外集合が実在 Group I の部分集合であること (綴り違い / 例外の陳腐化を検知)。
    for (const n of SOFT_DELETED_GROUP_I) {
      expect(groupINames).toContain(n)
    }
    const expectedDeleteNames = groupINames.filter(
      (n) => !SOFT_DELETED_GROUP_I.has(n),
    )
    // assets を除いた明示 DELETE 対象は依然 1 件以上 (invariant の本体が空にならない)。
    expect(expectedDeleteNames.length).toBeGreaterThan(0)

    // handler を 1 回走らせて tx.delete(...) と tx.update(...) の引数 (= table 識別子) を捕捉
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_inv' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_inv' }])) // clerk_events
    bootstrapRows = [
      { id: '00000000-0000-0000-0000-0000000000ff', stripe_customer_id: null },
    ]
    mockStripeListIterator.mockReturnValue(asyncIterFrom([]))

    const deleteCallTargets: unknown[] = []
    const updateCallTargets: unknown[] = []
    mockDbUpdate.mockImplementation((table: unknown) => {
      updateCallTargets.push(table)
      return chain(undefined)
    })
    mockDbDelete.mockImplementation((table: unknown) => {
      deleteCallTargets.push(table)
      return chain(undefined)
    })

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_inv' } }))
    expect(res.status).toBe(200)

    // 防御: handler が DELETE を 1 件も呼ばずに throughpath で抜けた regression
    // (e.g. tx.delete を別 API に書き換え) を「漏れ N 件」 でなく 「DELETE 自体ゼロ」 で
    // 明示検知する (M1 defense-in-depth)。
    expect(deleteCallTargets.length).toBeGreaterThan(0)
    // DELETE 集合一致を name ベースで diff (期待 = Group I − soft-delete 例外)。
    const actualDeleteNames = new Set(deleteCallTargets.map(tableName))
    const expectedDeleteSet = new Set(expectedDeleteNames)
    const missing = [...expectedDeleteSet].filter((n) => !actualDeleteNames.has(n))
    const surplus = [...actualDeleteNames].filter((n) => !expectedDeleteSet.has(n))
    expect({ missing, surplus }).toEqual({ missing: [], surplus: [] })

    // W2: soft-delete 例外の assets は DELETE でなく status='deleting' UPDATE で処理される。
    // (a) DELETE 集合に assets が混ざっていないこと (物理 DELETE への逆戻り regression 検知)。
    expect([...actualDeleteNames]).not.toContain(tableName(schemaModule.assets))
    // (b) assets が確かに deleting へ UPDATE されていること (soft-delete が実在)。
    const assetsUpdate = updateChainFor(schemaModule.assets)
    expect(assetsUpdate).toBeDefined()
    const assetsSet = assetsUpdate!.set.mock.calls[0]![0] as Record<string, unknown>
    expect(assetsSet.status).toBe('deleting')
  })
})

// schema 探索用 helper (test-scoped、 production code に染み出さない)
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import * as schemaModule from '@/lib/db/schema'

function isPgTable(v: unknown): v is PgTable {
  try {
    getTableConfig(v as PgTable)
    return true
  } catch {
    return false
  }
}

function tableName(t: unknown): string {
  try {
    return getTableConfig(t as PgTable).name
  } catch {
    return '<unknown>'
  }
}

function hasUserIdCascadeFK(table: PgTable): boolean {
  const cfg = getTableConfig(table)
  return cfg.foreignKeys.some((fk) => {
    const ref = fk.reference()
    const target = ref.foreignColumns[0]
    return target?.table === schemaModule.users && target.name === 'id' && fk.onDelete === 'cascade'
  })
}

// T の direct user_id FK 以外の FK が cascade で users 削除 chain に到達するか。
// 「親が user cascade chain を持つ」 = 親が hasUserIdCascadeFK (Group I/II のいずれか
// なら handler 流で親が消える) または 親自身がさらに別の親経由で chain を持つ。
function hasParentInUserCascadeChain(
  table: PgTable,
  visited: WeakSet<PgTable> = new WeakSet(),
): boolean {
  if (visited.has(table)) return false
  visited.add(table)
  const cfg = getTableConfig(table)
  for (const fk of cfg.foreignKeys) {
    const ref = fk.reference()
    const parent = ref.foreignColumns[0]?.table as PgTable | undefined
    if (!parent) continue
    if (parent === schemaModule.users) continue // direct user_id FK は precondition、 chain には数えない
    if (fk.onDelete !== 'cascade') continue
    if (hasUserIdCascadeFK(parent)) return true
    if (hasParentInUserCascadeChain(parent, visited)) return true
  }
  return false
}

function computeGroupITables(): PgTable[] {
  return Object.values(schemaModule)
    .filter(isPgTable)
    .filter((t) => t !== schemaModule.users)
    .filter((t) => hasUserIdCascadeFK(t) && !hasParentInUserCascadeChain(t))
}
