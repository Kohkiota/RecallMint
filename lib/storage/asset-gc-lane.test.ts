import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { CollectCandidate, ReconcilerDeps } from './asset-gc'
import { COLLECT_LIMIT_PER_USER } from './asset-gc'
import { runAssetGcLane } from './asset-gc-lane'

// lane orchestration の test(asset レーン整合 sprint spec §3.3〜§3.5・plan Task 5
// 完了条件 ①〜⑦)。`runReconciler`(core・lib/storage/asset-gc.ts)は本物を使う
// (mock しない — lane と core の結合を検証するのが目的)。DB / R2 /
// recordIntegrationFailure は mock する。
//
// mock 境界(設計判断・報告 doc に明記): `buildReconcilerDeps` は mock する。
// buildReconcilerDeps 自体が発行する SQL の正しさは Task 2(scripts/gc-image-assets.test.ts)
// が既に pin しており、ここで同じ SQL 生成を再検証するのは範囲外の重複になる。
// 本 file の関心は「lane がどう deps を組み立て・runReconciler をどう呼び・結果を
// どう集約/記帳するか」— buildReconcilerDeps を in-memory fixture 駆動の
// ReconcilerDeps を返す fake に差し替え、**本物の runReconciler** がその fake deps に
// 対して実際に mark→promote→collect→self-heal の状態遷移を行う形で検証する。
// fake の `deleteObject` フィールドだけは buildReconcilerDeps への呼出引数
// (`args.deleteObject` = lane が組み立てた実 wiring)をそのまま使うため、
// `timeoutMs = min(DELETE_TIMEOUT_MS, slice())` の本物の配線を通す。
// 行 DELETE 失敗の再検索(withTenantTx 経由)は lane 自身のコードなので、
// こちらは `withTenantTx` を直接 mock する実境界で検証する。
const {
  mockGetNonTenantDb,
  mockExecute,
  mockWithTenantTx,
  mockDeleteObject,
  mockRecordIntegrationFailure,
  mockBuildReconcilerDeps,
  mockLogger,
} = vi.hoisted(() => ({
  mockGetNonTenantDb: vi.fn(),
  mockExecute: vi.fn(),
  mockWithTenantTx: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockRecordIntegrationFailure: vi.fn(),
  mockBuildReconcilerDeps: vi.fn(),
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/db', () => ({ getNonTenantDb: mockGetNonTenantDb }))
vi.mock('@/lib/db/tenant-tx', () => ({ withTenantTx: mockWithTenantTx }))
vi.mock('./r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./r2')>()),
  deleteObject: mockDeleteObject,
}))
vi.mock('@/lib/integration-failures', () => ({
  recordIntegrationFailure: mockRecordIntegrationFailure,
}))
vi.mock('@/lib/logger', () => ({ logger: mockLogger }))
vi.mock('./asset-gc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./asset-gc')>()),
  buildReconcilerDeps: mockBuildReconcilerDeps,
}))

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const NOW_MS = Date.UTC(2026, 7, 10, 12, 0, 0) // 2026-08-10T12:00:00Z(固定 now)

// buildReconcilerDeps に実際に渡る引数の型(import 循環を避けるためローカル定義。
// 実 signature は lib/storage/asset-gc.ts の buildReconcilerDeps 参照)。
type BuildDepsArgs = {
  exec: unknown
  userId?: string
  collectLimit?: number
  deleteObject: ReconcilerDeps['deleteObject']
  onRecordError?: () => void
  shouldRecord?: () => boolean
  onSuppressed?: () => void
  log: (msg: string) => void
}

type Fixture = {
  scanned?: number
  referenced?: number
  marked?: number
  cleared?: number
  promoted?: number
  candidates?: CollectCandidate[]
  rowDeleteFails?: Set<string>
  // 設定時、countScannedAssets が呼ばれた時点で throw する(per-user 例外 / guard
  // trip の再現。どの deps 関数が throw しても lane の catch 挙動は同じため、最も
  // 早く呼ばれる countScannedAssets を throw 源にする)。
  scanThrows?: Error
  // countScannedAssets 呼出時に時計を進める幅(deadline test 用)。
  costMs?: number
  // 設定時、fake の recordFailure が(本物の buildReconcilerDeps の recordFailure
  // 実装 B-4 seam を模して)recordIntegrationFailure を呼び、それが reject したら
  // `buildArgs.onRecordError?.()` を呼ぶ。lane が `onRecordError: () =>
  // recordErrors++` を正しく配線しているかの検証専用(review Important #2)。
  recordFailureThrows?: boolean
}

let clock = NOW_MS
const injectedNow = () => clock
let fixtures: Map<string, Fixture>
// per-user 行 DELETE 失敗の再検索(withTenantTx)への応答を呼出順に消費する queue。
let rowLookupQueue: Array<{ objectKey: string | null; status: string | null }[] | Error>

function candidate(
  assetId: string,
  userId: string,
  status: 'deleting' | 'deleted',
  objectKey?: string,
): CollectCandidate {
  return {
    id: assetId,
    userId,
    objectKey: objectKey ?? `users/${userId}/${assetId}.webp`,
    status,
    unreferencedAt: new Date(NOW_MS - 60 * 24 * 60 * 60 * 1000),
  }
}

function makeFakeDeps(buildArgs: BuildDepsArgs, fixture: Fixture): ReconcilerDeps {
  if (fixture.scanThrows) {
    const err = fixture.scanThrows
    return {
      countScannedAssets: async () => {
        throw err
      },
      markSet: async () => 0,
      markClear: async () => 0,
      promote: async () => 0,
      fetchPromoteCandidates: async () => [],
      checkRefsPopulated: async () => ({ refRowCount: 1, hasUuidImageKeys: false }),
      fetchCollectCandidates: async () => [],
      fetchReferencedAssetIds: async () => new Set(),
      restoreToReady: async () => {},
      markDeleted: async () => {},
      deleteAssetRow: async () => {},
      deleteObject: buildArgs.deleteObject,
      recordFailure: async () => {},
      log: buildArgs.log,
    }
  }

  const all = fixture.candidates ?? []
  const limited =
    buildArgs.collectLimit === undefined ? all : all.slice(0, buildArgs.collectLimit)

  return {
    countScannedAssets: async () => {
      clock += fixture.costMs ?? 0
      return { scanned: fixture.scanned ?? 0, referenced: fixture.referenced ?? 0 }
    },
    markSet: async () => fixture.marked ?? 0,
    markClear: async () => fixture.cleared ?? 0,
    promote: async () => fixture.promoted ?? 0,
    fetchPromoteCandidates: async () => [],
    checkRefsPopulated: async () => ({ refRowCount: 1, hasUuidImageKeys: false }),
    fetchCollectCandidates: async () => limited,
    fetchReferencedAssetIds: async () => new Set(),
    restoreToReady: async () => {},
    markDeleted: async () => {},
    deleteAssetRow: async (assetId: string) => {
      if (fixture.rowDeleteFails?.has(assetId)) {
        throw new Error(`restrict: ${assetId} still referenced`)
      }
    },
    deleteObject: buildArgs.deleteObject,
    // 本物の buildReconcilerDeps.recordFailure(asset-gc.ts)を模す最小限 mirror:
    // ① shouldRecord/onSuppressed(記帳の上限・review round 3)を最初に見る —
    //    未指定 or true なら通す(本物と同じ既定 = 常に記帳)。
    // ② `recordFailureThrows` 指定時のみ recordIntegrationFailure を呼び、reject
    //    したら onRecordError を呼ぶ(review Important #2 のための mirror)。
    recordFailure: async () => {
      if (buildArgs.shouldRecord && !buildArgs.shouldRecord()) {
        buildArgs.onSuppressed?.()
        return
      }
      if (!fixture.recordFailureThrows) return
      try {
        await mockRecordIntegrationFailure({
          key: 'r2_gc_delete',
          subject: 'R2 GC: object delete failed',
          context: {},
        })
      } catch {
        buildArgs.onRecordError?.()
      }
    },
    log: buildArgs.log,
  }
}

beforeEach(() => {
  clock = NOW_MS
  fixtures = new Map()
  rowLookupQueue = []
  vi.clearAllMocks()

  mockGetNonTenantDb.mockReturnValue({ execute: mockExecute })
  mockExecute.mockResolvedValue([])
  mockDeleteObject.mockResolvedValue({ ok: true, status: 200 })
  mockRecordIntegrationFailure.mockResolvedValue(undefined)
  mockBuildReconcilerDeps.mockImplementation((buildArgs: BuildDepsArgs) =>
    makeFakeDeps(buildArgs, fixtures.get(buildArgs.userId ?? '') ?? {}),
  )
  mockWithTenantTx.mockImplementation(
    async (_userId: string, fn: (tx: unknown) => Promise<unknown>) => {
      const next = rowLookupQueue.shift()
      if (next instanceof Error) throw next
      const rows = next ?? []
      const fakeTx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => rows,
            }),
          }),
        }),
      }
      return fn(fakeTx)
    },
  )
})

function listUsers(...userIds: string[]): void {
  mockExecute.mockResolvedValue(userIds.map((id) => ({ app_list_asset_gc_user_ids: id })))
}

function recordedCalls(key: string): Record<string, unknown>[] {
  return mockRecordIntegrationFailure.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((c) => c.key === key)
}

const WIDE_DEADLINE = new Date(NOW_MS + 300_000)

function run(overrides: Partial<Parameters<typeof runAssetGcLane>[0]> = {}) {
  return runAssetGcLane({
    deadlineAt: WIDE_DEADLINE,
    graceDays: 30,
    now: injectedNow,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// ① 複数 user の件数集約
// ---------------------------------------------------------------------------
describe('runAssetGcLane — 複数 user の集約(①)', () => {
  it('mark/clear/promote の ReconcilerSummary を合算する', async () => {
    listUsers(USER_A, USER_B)
    fixtures.set(USER_A, { scanned: 5, referenced: 2, marked: 1, cleared: 0, promoted: 1 })
    fixtures.set(USER_B, { scanned: 3, referenced: 1, marked: 0, cleared: 1, promoted: 0 })

    const summary = await run()

    expect(summary.usersListed).toBe(2)
    expect(summary.usersProcessed).toBe(2)
    expect(summary.usersSkipped).toBe(0)
    expect(summary.scanned).toBe(8)
    expect(summary.referenced).toBe(3)
    expect(summary.marked).toBe(1)
    expect(summary.cleared).toBe(1)
    expect(summary.promoted).toBe(1)
    expect(summary.phase).toBeNull()
    expect(summary.error).toBeUndefined()
  })

  it('collect(deleting/deleted)の r2Delete* / rowDelete* も合算する(本物の runReconciler 状態遷移)', async () => {
    listUsers(USER_A, USER_B)
    fixtures.set(USER_A, {
      candidates: [
        candidate('asset-a1', USER_A, 'deleting'),
        candidate('asset-a2', USER_A, 'deleted'),
      ],
    })
    fixtures.set(USER_B, { candidates: [candidate('asset-b1', USER_B, 'deleting')] })

    const summary = await run()

    // deleting 2 件(a1, b1)が R2 DELETE 成功 + deleted 1 件(a2)は R2 を叩かない。
    expect(summary.r2DeleteOk).toBe(2)
    expect(summary.deletedLaneProcessed).toBe(1)
    expect(summary.rowDeleteOk).toBe(3)
    expect(summary.rowDeleteFailed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ② user 境界の deadline 打ち切り
// ---------------------------------------------------------------------------
describe('runAssetGcLane — user 境界の deadline 打ち切り(②)', () => {
  it('残 slice が MIN_SLICE 未満なら次 user を起動せず打ち切り、incomplete を記帳する', async () => {
    listUsers(USER_A, USER_B)
    // workDeadline = deadlineAt(+15s) - TAIL_RESERVE(10s) = +5s。
    // user A の costMs=4s 消費後、slice = 5s-4s = 1s < MIN_SLICE(2s) → user B 未起動。
    fixtures.set(USER_A, { scanned: 1, costMs: 4_000 })
    fixtures.set(USER_B, { scanned: 100 })

    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    expect(summary.usersProcessed).toBe(1)
    expect(summary.usersSkipped).toBe(0)
    expect(summary.scanned).toBe(1) // user B の 100 は未反映
    expect(summary.phase).toBe('deadline')
    expect(mockBuildReconcilerDeps).toHaveBeenCalledTimes(1)
    expect(mockBuildReconcilerDeps).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_A }),
    )
    const incomplete = recordedCalls('r2_gc_incomplete')
    expect(incomplete).toHaveLength(1)
    expect(incomplete[0]?.context).toMatchObject({
      phase: 'deadline',
      usersProcessed: 1,
      usersSkipped: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// ③ per-user throw が後続 user を巻き込まない
// ---------------------------------------------------------------------------
describe('runAssetGcLane — per-user throw が後続 user を巻き込まない(③)', () => {
  it('user A の throw(guard trip 相当)を skip し user B は正常処理する', async () => {
    listUsers(USER_A, USER_B)
    fixtures.set(USER_A, { scanThrows: new Error('pre-sweep guard trip') })
    fixtures.set(USER_B, { scanned: 4, marked: 2 })

    const summary = await run()

    expect(summary.usersSkipped).toBe(1)
    expect(summary.usersProcessed).toBe(1)
    expect(summary.scanned).toBe(4)
    expect(summary.marked).toBe(2)
    expect(summary.phase).toBe('user_error')
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'asset_gc.user_error', userId: USER_A }),
    )
  })
})

// ---------------------------------------------------------------------------
// ④ rowDeleteFailures → r2_gc_row_delete 記帳(objectKey 解決成功 / 失敗→null)
// ---------------------------------------------------------------------------
describe('runAssetGcLane — 行 DELETE 失敗の台帳化(④)', () => {
  it('objectKey 解決成功(行あり)で assetId/objectKey/status を記帳する', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, {
      candidates: [candidate('asset-fail-1', USER_A, 'deleting', 'users/x/asset-fail-1.webp')],
      rowDeleteFails: new Set(['asset-fail-1']),
    })
    rowLookupQueue.push([{ objectKey: 'users/x/asset-fail-1.webp', status: 'deleting' }])

    const summary = await run()

    expect(summary.rowDeleteFailed).toBe(1)
    const rows = recordedCalls('r2_gc_row_delete')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: USER_A,
      context: {
        assetId: 'asset-fail-1',
        objectKey: 'users/x/asset-fail-1.webp',
        status: 'deleting',
      },
    })
  })

  it('再検索が throw する場合は objectKey: null / status: null で記帳する(失敗事実を落とさない)', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, {
      candidates: [candidate('asset-fail-2', USER_A, 'deleting')],
      rowDeleteFails: new Set(['asset-fail-2']),
    })
    rowLookupQueue.push(new Error('db down'))

    const summary = await run()

    expect(summary.rowDeleteFailed).toBe(1)
    const rows = recordedCalls('r2_gc_row_delete')
    expect(rows[0]?.context).toEqual({
      assetId: 'asset-fail-2',
      objectKey: null,
      status: null,
    })
  })

  it('再検索が 0 行の場合も objectKey: null / status: null で記帳する', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, {
      candidates: [candidate('asset-fail-3', USER_A, 'deleting')],
      rowDeleteFails: new Set(['asset-fail-3']),
    })
    rowLookupQueue.push([])

    await run()

    const rows = recordedCalls('r2_gc_row_delete')
    expect(rows[0]?.context).toEqual({
      assetId: 'asset-fail-3',
      objectKey: null,
      status: null,
    })
  })
})

// ---------------------------------------------------------------------------
// ⑤ 記帳 throw で recordErrors 加算・run 続行
// ---------------------------------------------------------------------------
describe('runAssetGcLane — 記帳失敗と never-throw(⑤)', () => {
  it('r2_gc_row_delete の記帳が throw しても recordErrors が増え、run は throw せず完走する', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, {
      candidates: [candidate('asset-fail-4', USER_A, 'deleting')],
      rowDeleteFails: new Set(['asset-fail-4']),
    })
    rowLookupQueue.push([{ objectKey: 'k', status: 'deleting' }])
    mockRecordIntegrationFailure.mockRejectedValueOnce(new Error('notifyOps fail-fast'))

    const summary = await run()

    expect(summary.error).toBeUndefined()
    expect(summary.recordErrors).toBe(1)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'asset_gc.record_failed', key: 'r2_gc_row_delete' }),
    )
  })
})

// ---------------------------------------------------------------------------
// ⑥ override 時のみ graceDaysOverride / userScope が summary に載る
// ---------------------------------------------------------------------------
describe('runAssetGcLane — override フィールド(⑥)', () => {
  it('未指定なら summary に graceDaysOverride/userScope が出現せず、user 横断列挙を打つ', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, { scanned: 1 })

    const summary = await run()

    expect(summary).not.toHaveProperty('graceDaysOverride')
    expect(summary).not.toHaveProperty('userScope')
    expect(mockGetNonTenantDb).toHaveBeenCalled()
  })

  it('指定時のみ summary に載り、userScope 指定時は横断列挙を打たない', async () => {
    fixtures.set(USER_C, { scanned: 7 })

    const summary = await run({ graceDaysOverride: 0, userScope: USER_C })

    expect(summary.graceDaysOverride).toBe(0)
    expect(summary.userScope).toBe(USER_C)
    expect(summary.usersListed).toBe(1)
    expect(summary.usersProcessed).toBe(1)
    expect(summary.scanned).toBe(7)
    expect(mockGetNonTenantDb).not.toHaveBeenCalled()
    expect(mockBuildReconcilerDeps).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_C }),
    )
  })
})

// ---------------------------------------------------------------------------
// ⑦ collectLimit が deps に渡り 21 件目は当 run で処理されない
// ---------------------------------------------------------------------------
describe('runAssetGcLane — collectLimit(⑦)', () => {
  it('COLLECT_LIMIT_PER_USER が deps に渡り、1 user 21 件目の候補は処理されない', async () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      candidate(`asset-many-${i}`, USER_A, 'deleting'),
    )
    listUsers(USER_A)
    fixtures.set(USER_A, { candidates: many })

    const summary = await run()

    expect(mockBuildReconcilerDeps).toHaveBeenCalledWith(
      expect.objectContaining({ collectLimit: COLLECT_LIMIT_PER_USER }),
    )
    expect(summary.r2DeleteOk).toBe(COLLECT_LIMIT_PER_USER)
    expect(mockDeleteObject).toHaveBeenCalledTimes(COLLECT_LIMIT_PER_USER)
  })
})

// ---------------------------------------------------------------------------
// 制約: deleteObject の timeoutMs wiring(静的 import + min(DELETE_TIMEOUT_MS, slice()))
// ---------------------------------------------------------------------------
describe('runAssetGcLane — deleteObject の timeoutMs wiring', () => {
  it('timeoutMs は DELETE_TIMEOUT_MS と残 slice の小さい方になる', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, { candidates: [candidate('asset-timeout', USER_A, 'deleting')] })

    // workDeadline = (+13s) - TAIL_RESERVE(10s) = +3s。costMs=0 のため slice() = 3_000。
    // DELETE_TIMEOUT_MS(10_000)より小さいので min は 3_000 になる。
    await run({ deadlineAt: new Date(NOW_MS + 13_000) })

    expect(mockDeleteObject).toHaveBeenCalledWith(
      expect.stringContaining('asset-timeout'),
      { timeoutMs: 3_000 },
    )
  })

  it('slice() が負でも timeoutMs は 0 に clamp され、lane は throw しない(review round 2)', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, {
      candidates: [candidate('asset-negative-slice', USER_A, 'deleting')],
      // per-user 処理(countScannedAssets)で残予算を使い切らせ、collect loop の
      // deleteObject 呼出時点では既に slice() が負になっている状況を作る。
      costMs: 5_000,
    })

    // workDeadline = (+12s) - TAIL_RESERVE(10s) = +2s。user 境界 check は
    // costMs 消費前(slice=2_000)なので通過する(`slice() < MIN_SLICE_MS` は
    // 2_000 < 2_000 = false)。costMs=5_000 消費後、deleteObject 呼出時点の
    // slice() = 2_000 - 5_000 = -3_000(負)。
    const summary = await run({ deadlineAt: new Date(NOW_MS + 12_000) })

    expect(summary.error).toBeUndefined()
    expect(mockDeleteObject).toHaveBeenCalledWith(
      expect.stringContaining('asset-negative-slice'),
      { timeoutMs: 0 },
    )
  })
})

// ---------------------------------------------------------------------------
// 制約: 行 DELETE 失敗の台帳 quota(≤20、超過は suppressedFailures)
// ---------------------------------------------------------------------------
describe('runAssetGcLane — 行 DELETE 失敗の台帳 quota', () => {
  it('21 件の行 DELETE 失敗のうち 20 件のみ記帳し、超過 1 件は suppressedFailures に計上する', async () => {
    // COLLECT_LIMIT_PER_USER(20)が 1 user あたりの candidate 数を bound するため、
    // quota(20)超過を作るには複数 user に分けて計 21 件の行 DELETE 失敗を作る
    // (11 + 10 件・どちらも per-user LIMIT 20 未満)。
    const aCandidates = Array.from({ length: 11 }, (_, i) =>
      candidate(`asset-qa-${i}`, USER_A, 'deleting'),
    )
    const bCandidates = Array.from({ length: 10 }, (_, i) =>
      candidate(`asset-qb-${i}`, USER_B, 'deleting'),
    )
    listUsers(USER_A, USER_B)
    fixtures.set(USER_A, {
      candidates: aCandidates,
      rowDeleteFails: new Set(aCandidates.map((c) => c.id)),
    })
    fixtures.set(USER_B, {
      candidates: bCandidates,
      rowDeleteFails: new Set(bCandidates.map((c) => c.id)),
    })
    for (let i = 0; i < 21; i++) {
      rowLookupQueue.push([{ objectKey: `k${i}`, status: 'deleting' }])
    }

    const summary = await run()

    expect(summary.rowDeleteFailed).toBe(21)
    expect(recordedCalls('r2_gc_row_delete')).toHaveLength(20)
    const incomplete = recordedCalls('r2_gc_incomplete')
    expect(incomplete).toHaveLength(1)
    expect(incomplete[0]?.context).toMatchObject({ suppressedFailures: 1 })
    // suppressedFailures のみが理由(deadline/user_error は起きていない)ため phase は
    // context に出現しない。
    expect(incomplete[0]?.context).not.toHaveProperty('phase')
  })
})

// ---------------------------------------------------------------------------
// review Important #1: 行 DELETE 失敗の記帳 loop 自体にも deadline guard が要る
// (src-sweep.ts:391-400 と同型 — quota check だけでは、記帳 1 本ずつが
// notifyOps の fetch を待つコストを bound できない)。
// ---------------------------------------------------------------------------
describe('runAssetGcLane — 行 DELETE 失敗の記帳 loop の deadline guard(review Important #1)', () => {
  it('記帳 loop 中に残 slice が MIN_SLICE 未満になったら以降を suppressedFailures に畳み phase deadline を立てる', async () => {
    listUsers(USER_A)
    const many = Array.from({ length: 3 }, (_, i) =>
      candidate(`asset-dl-${i}`, USER_A, 'deleting'),
    )
    fixtures.set(USER_A, {
      candidates: many,
      rowDeleteFails: new Set(many.map((c) => c.id)),
      // per-user 処理(countScannedAssets)だけで残予算を MIN_SLICE 未満まで
      // 消費させる — 行 DELETE 失敗の記帳 loop に入った時点で既に deadline 超過。
      costMs: 4_000,
    })

    // workDeadline = (+15s) - TAIL_RESERVE(10s) = +5s。costMs=4s 消費後 slice=1s
    // < MIN_SLICE(2s)。per-user 境界 check(user 1 人しかいないので素通り)の後、
    // 行 DELETE 失敗の記帳 loop に入った時点で guard が効くはず。
    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    // runReconciler 自体は 3 件とも rowDeleteFailed を数える(core は無改造・
    // deadline を知らない)。台帳記帳だけが lane 側の guard で抑制される。
    expect(summary.rowDeleteFailed).toBe(3)
    expect(recordedCalls('r2_gc_row_delete')).toHaveLength(0)
    expect(mockWithTenantTx).not.toHaveBeenCalled() // 再検索 SELECT すら発行しない
    expect(summary.phase).toBe('deadline')
    const incomplete = recordedCalls('r2_gc_incomplete')
    expect(incomplete).toHaveLength(1)
    expect(incomplete[0]?.context).toMatchObject({
      phase: 'deadline',
      suppressedFailures: 3,
    })
  })
})

// ---------------------------------------------------------------------------
// review Important #2: onRecordError の配線(buildReconcilerDeps への引数として
// 渡ること + 実際に呼ばれたら summary.recordErrors に反映されること)。
// ---------------------------------------------------------------------------
describe('runAssetGcLane — onRecordError 配線(review Important #2)', () => {
  it('buildReconcilerDeps に onRecordError 関数を渡す', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, { scanned: 1 })

    await run()

    expect(mockBuildReconcilerDeps).toHaveBeenCalledWith(
      expect.objectContaining({ onRecordError: expect.any(Function) }),
    )
  })

  it('recordFailure(r2_gc_delete)の記帳が throw したら onRecordError 経由で recordErrors に反映される', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, {
      candidates: [candidate('asset-r2fail', USER_A, 'deleting')],
      recordFailureThrows: true,
    })
    mockDeleteObject.mockResolvedValueOnce({ ok: false, status: 500 })
    mockRecordIntegrationFailure.mockRejectedValueOnce(new Error('notifyOps fail-fast'))

    const summary = await run()

    expect(summary.r2DeleteFailed).toBe(1)
    expect(summary.recordErrors).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// review round 3: 記帳の上限(spec §3.3a 3 番目の bounding 手段)。R2 削除失敗の
// 記帳(core の collect loop 内・buildReconcilerDeps.recordFailure)にも、行
// DELETE 失敗の記帳 loop と同型の deadline guard が要る。
// ---------------------------------------------------------------------------
describe('runAssetGcLane — recordFailure の記帳上限(review round 3)', () => {
  it('slice 枯渇後の R2 削除失敗は記帳されず suppressedFailures に計上され phase=deadline になる', async () => {
    listUsers(USER_A)
    fixtures.set(USER_A, {
      candidates: [candidate('asset-r2-suppressed', USER_A, 'deleting')],
      // countScannedAssets で残予算を使い切らせ、collect loop の recordFailure
      // 呼出時点では既に slice() が MIN_SLICE 未満になっている状況を作る
      // (round 2 の負 slice test と同じ costMs 機構)。
      costMs: 5_000,
    })
    mockDeleteObject.mockResolvedValueOnce({ ok: false, status: 500 })

    // workDeadline = (+12s) - TAIL_RESERVE(10s) = +2s。user 境界 check は
    // costMs 消費前(slice=2_000)なので通過する。costMs=5_000 消費後、
    // recordFailure 呼出時点の slice() = 2_000 - 5_000 = -3_000(< MIN_SLICE)。
    const summary = await run({ deadlineAt: new Date(NOW_MS + 12_000) })

    expect(summary.error).toBeUndefined()
    expect(summary.r2DeleteFailed).toBe(1)
    // shouldRecord が false を返すため recordIntegrationFailure(r2_gc_delete)は
    // 一度も呼ばれない(suppressed の証明 — 記帳を試みてから失敗するのではなく、
    // 記帳自体を始めない)。
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'r2_gc_delete' }),
    )
    expect(summary.phase).toBe('deadline')
    const incomplete = recordedCalls('r2_gc_incomplete')
    expect(incomplete).toHaveLength(1)
    expect(incomplete[0]?.context).toMatchObject({
      phase: 'deadline',
      suppressedFailures: 1,
    })
  })
})
