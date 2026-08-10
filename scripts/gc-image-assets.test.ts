import { describe, it, expect, vi, beforeEach } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

import {
  runReconciler,
  buildReconcilerDeps,
  DEFAULT_GRACE_DAYS,
  COLLECT_LIMIT_PER_USER,
  type ReconcilerDeps,
  type ReconcilerOptions,
  type ReconcilerExec,
  type CollectCandidate,
} from '@/lib/storage/asset-gc'
import * as schema from '@/lib/db/schema'

import { parseUserFlag, parseGraceDays } from './gc-image-assets'

// buildReconcilerDeps(Task 2)の SQL 生成 test 用: 実 postgres 接続はしない。
// drizzle-orm/postgres-js 自身の内部 `import postgres`(node_modules は Vitest の
// module 変換対象外 = externalize される)は vi.mock を素通りするため、本 file 側で
// postgres(url) を先に呼んで client を作り、drizzle(client, {schema}) へ渡す
// (lib/db/index.ts の getDb() と同じ経路)ことで mock を効かせる
// (lib/db/index.test.ts と同技法)。
const { unsafeMock, recordIntegrationFailureMock } = vi.hoisted(() => ({
  unsafeMock: vi.fn((_query: string, _params: unknown[]) => ({
    values: () => Promise.resolve([]),
  })),
  recordIntegrationFailureMock: vi.fn(async () => {}),
}))

vi.mock('postgres', () => ({
  default: vi.fn(() => ({
    options: { parsers: {}, serializers: {} },
    unsafe: unsafeMock,
  })),
}))

// buildReconcilerDeps の recordFailure は exec を経由せず直接
// recordIntegrationFailure(@/lib/integration-failures)を呼ぶ実装のため、記帳 throw
// を再現するにはこちらを mock する(postgres mock とは独立の経路)。
vi.mock('@/lib/integration-failures', () => ({
  recordIntegrationFailure: recordIntegrationFailureMock,
}))

// fetchCollectCandidates 等が実際に発行する SQL(client.unsafe への引数)を検証する
// ための exec。owner 経路(scripts/gc-image-assets.ts の main())と同じ形
// (`(fn) => fn(db)`)。
function makeFakeExec(): ReconcilerExec {
  const client = postgres('postgresql://fake:fake@localhost:5432/fake', { prepare: false })
  const db = drizzle(client, { schema })
  return (fn) => fn(db)
}

const ASSET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ASSET_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// In-memory asset store: state machine を実条件で検証するため、DB を模した
// mutable store を deps の write 系に配線する(vacuous mock-call ではなく実状態
// 遷移を assert する)。refs は Set<assetId> で「現在参照されている asset」を表す。
// ---------------------------------------------------------------------------
type StoreAsset = {
  id: string
  userId: string
  objectKey: string
  status: string
  unreferencedAt: Date | null
}

function makeStore(initial: StoreAsset[], refs: Set<string> = new Set()) {
  const assets = new Map(initial.map((a) => [a.id, { ...a }]))
  return {
    assets,
    refs,
    candidates(): CollectCandidate[] {
      return [...assets.values()]
        .filter((a) => a.status === 'deleting' || a.status === 'deleted')
        .map((a) => ({ ...a }))
    },
  }
}

function makeDeps(
  store: ReturnType<typeof makeStore>,
  overrides: Partial<ReconcilerDeps> = {},
): ReconcilerDeps & {
  deleteObjectMock: ReturnType<typeof vi.fn>
  recordFailureMock: ReturnType<typeof vi.fn>
  restoreToReadyMock: ReturnType<typeof vi.fn>
  markDeletedMock: ReturnType<typeof vi.fn>
  deleteAssetRowMock: ReturnType<typeof vi.fn>
  markSetMock: ReturnType<typeof vi.fn>
  markClearMock: ReturnType<typeof vi.fn>
  promoteMock: ReturnType<typeof vi.fn>
  fetchPromoteCandidatesMock: ReturnType<typeof vi.fn>
  checkRefsPopulatedMock: ReturnType<typeof vi.fn>
} {
  const deleteObjectMock = vi.fn(async () => ({ ok: true, status: 200 }))
  const recordFailureMock = vi.fn(async () => {})
  const restoreToReadyMock = vi.fn(async (assetId: string) => {
    const a = store.assets.get(assetId)
    if (a) {
      a.status = 'ready'
      a.unreferencedAt = null
    }
  })
  const markDeletedMock = vi.fn(async (assetId: string) => {
    const a = store.assets.get(assetId)
    if (a) a.status = 'deleted'
  })
  const deleteAssetRowMock = vi.fn(async (assetId: string) => {
    // refs→assets RESTRICT を模す: refs が残っていれば DELETE を拒否(throw)。
    if (store.refs.has(assetId)) {
      throw new Error('restrict: card_asset_refs still references asset')
    }
    store.assets.delete(assetId)
  })
  const markSetMock = vi.fn(async () => 0)
  const markClearMock = vi.fn(async () => 0)
  const promoteMock = vi.fn(async () => 0)
  const fetchPromoteCandidatesMock = vi.fn(async () => [] as {
    unreferencedAt: Date | null
  }[])
  // 既定は store.refs をそのまま refRowCount とし、UUID image key は無し
  // (hasUuidImageKeys=false)→ guard は既定で abort しない。個々の test が override する。
  const checkRefsPopulatedMock = vi.fn(async () => ({
    refRowCount: store.refs.size,
    hasUuidImageKeys: false,
  }))

  const deps: ReconcilerDeps = {
    countScannedAssets: async () => ({
      scanned: store.assets.size,
      referenced: store.refs.size,
    }),
    markSet: markSetMock,
    markClear: markClearMock,
    promote: promoteMock,
    fetchPromoteCandidates: fetchPromoteCandidatesMock,
    checkRefsPopulated: checkRefsPopulatedMock,
    fetchCollectCandidates: async () => store.candidates(),
    fetchReferencedAssetIds: async (ids: string[]) =>
      new Set(ids.filter((id) => store.refs.has(id))),
    restoreToReady: restoreToReadyMock,
    markDeleted: markDeletedMock,
    deleteAssetRow: deleteAssetRowMock,
    deleteObject: deleteObjectMock,
    recordFailure: recordFailureMock,
    log: vi.fn(),
    ...overrides,
  }
  return Object.assign(deps, {
    deleteObjectMock,
    recordFailureMock,
    restoreToReadyMock,
    markDeletedMock,
    deleteAssetRowMock,
    markSetMock,
    markClearMock,
    promoteMock,
    fetchPromoteCandidatesMock,
    checkRefsPopulatedMock,
  })
}

function opts(overrides: Partial<ReconcilerOptions> = {}): ReconcilerOptions {
  return {
    sweep: false,
    dryRun: false,
    graceDays: DEFAULT_GRACE_DAYS,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// mark run(orphaned_at set / clear)
// ---------------------------------------------------------------------------
describe('runReconciler mark run', () => {
  it('mark のみ(sweep なし): markSet / markClear を呼び、promote/collect は走らない', async () => {
    const store = makeStore([])
    const deps = makeDeps(store)
    deps.markSetMock.mockResolvedValueOnce(3)
    deps.markClearMock.mockResolvedValueOnce(1)
    const fetchCandidatesSpy = vi.spyOn(deps, 'fetchCollectCandidates')

    const summary = await runReconciler(opts({ sweep: false }), deps)

    expect(summary.marked).toBe(3)
    expect(summary.cleared).toBe(1)
    expect(deps.promoteMock).not.toHaveBeenCalled()
    expect(fetchCandidatesSpy).not.toHaveBeenCalled()
  })

  it('dry-run(mark): markSet/markClear/promote を一切呼ばない(write ゼロ)', async () => {
    const store = makeStore([])
    const deps = makeDeps(store)

    const summary = await runReconciler(opts({ sweep: false, dryRun: true }), deps)

    expect(deps.markSetMock).not.toHaveBeenCalled()
    expect(deps.markClearMock).not.toHaveBeenCalled()
    expect(deps.promoteMock).not.toHaveBeenCalled()
    expect(summary.marked).toBe(0)
    expect(summary.cleared).toBe(0)
  })

  it('dry-run: countRefDivergence が呼ばれ summary に乖離が記録される', async () => {
    const store = makeStore([])
    const countRefDivergence = vi.fn(async () => ({
      imageUuidKeys: 5,
      refRows: 3,
    }))
    const deps = makeDeps(store, { countRefDivergence })

    const summary = await runReconciler(opts({ dryRun: true }), deps)

    expect(countRefDivergence).toHaveBeenCalledTimes(1)
    expect(summary.refDivergence).toEqual({ imageUuidKeys: 5, refRows: 3 })
  })

  it('本実行(非 dry-run)では countRefDivergence を呼ばない(毎 run の jsonb 全読回避)', async () => {
    const store = makeStore([])
    const countRefDivergence = vi.fn(async () => ({ imageUuidKeys: 0, refRows: 0 }))
    const deps = makeDeps(store, { countRefDivergence })

    await runReconciler(opts({ dryRun: false }), deps)

    expect(countRefDivergence).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// promote(grace 超 → deleting)
// ---------------------------------------------------------------------------
describe('runReconciler promote', () => {
  it('sweep: promote が graceDays 付きで呼ばれ、影響行数が summary.promoted になる', async () => {
    const store = makeStore([])
    const deps = makeDeps(store)
    deps.promoteMock.mockResolvedValueOnce(2)

    const summary = await runReconciler(opts({ sweep: true, graceDays: 30 }), deps)

    expect(deps.promoteMock).toHaveBeenCalledWith(30)
    expect(summary.promoted).toBe(2)
  })

  it('dry-run(sweep): promote(write)を呼ばず、isSweepEligible で予告件数を数える', async () => {
    const store = makeStore([])
    const deps = makeDeps(store)
    // grace=30。unreferencedAt が 40 日前(適格)/ 20 日前(未満)/ null(未マーク)。
    // isSweepEligible が strict older で判定 → 40 日前の 1 件のみ予告に計上される。
    deps.fetchPromoteCandidatesMock.mockResolvedValueOnce([
      { unreferencedAt: new Date(Date.now() - 40 * DAY_MS) }, // 適格
      { unreferencedAt: new Date(Date.now() - 20 * DAY_MS) }, // grace 未満
      { unreferencedAt: null }, // 未マーク
    ])

    const summary = await runReconciler(
      opts({ sweep: true, dryRun: true, graceDays: 30 }),
      deps,
    )

    // 本実行の promote(write)は呼ばれない。
    expect(deps.promoteMock).not.toHaveBeenCalled()
    // isSweepEligible が grace 境界を判定し、適格 1 件のみ予告。
    expect(deps.fetchPromoteCandidatesMock).toHaveBeenCalledTimes(1)
    expect(summary.promoted).toBe(1)
  })

  it('dry-run promote 予告: grace 境界ちょうど(= 未満扱い)は計上しない', async () => {
    const store = makeStore([])
    const deps = makeDeps(store)
    // 固定 now を注入して決定的にする。setup 時の Date.now() と runReconciler 内の
    // new Date() の間の経過(δ)で境界がずれる flakiness を排除: unreferencedAt を
    // 「注入した now ちょうど 30 日前」に置くと strict-older 判定が確実に境界になる。
    const fixedNow = new Date('2026-07-14T00:00:00.000Z')
    deps.fetchPromoteCandidatesMock.mockResolvedValueOnce([
      { unreferencedAt: new Date(fixedNow.getTime() - 30 * DAY_MS) }, // ちょうど 30 日
    ])

    const summary = await runReconciler(
      opts({ sweep: true, dryRun: true, graceDays: 30, now: fixedNow }),
      deps,
    )

    // ちょうど境界は grace 未満扱い(まだ猶予がある側)ゆえ予告に入らない。
    expect(summary.promoted).toBe(0)
  })

  it('dry-run promote 予告(固定 now): 境界 1ms 超は計上する(境界の対称性検証)', async () => {
    const store = makeStore([])
    const deps = makeDeps(store)
    const fixedNow = new Date('2026-07-14T00:00:00.000Z')
    deps.fetchPromoteCandidatesMock.mockResolvedValueOnce([
      // 30 日ちょうど + 1ms 古い = strict older を満たす(適格)。
      { unreferencedAt: new Date(fixedNow.getTime() - 30 * DAY_MS - 1) },
    ])

    const summary = await runReconciler(
      opts({ sweep: true, dryRun: true, graceDays: 30, now: fixedNow }),
      deps,
    )

    expect(summary.promoted).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// FIX 8: pre-sweep guard(refs 完全未投入 = W1 未 deploy / backfill 未実行の
// backstop)。refs 空 かつ UUID image key あり → --sweep を abort。
// ---------------------------------------------------------------------------
describe('runReconciler — pre-sweep guard', () => {
  it('--sweep + refs 空 + UUID image key あり → abort(promote/collect/deleteObject 未実行)', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)
    // refs 完全未投入 かつ cards.images に UUID key が存在する状態を注入。
    deps.checkRefsPopulatedMock.mockResolvedValueOnce({
      refRowCount: 0,
      hasUuidImageKeys: true,
    })

    await expect(runReconciler(opts({ sweep: true }), deps)).rejects.toThrow(
      /card_asset_refs is empty but cards\.images contains UUID image keys/,
    )

    // abort ゆえ destructive/promote 系は一切呼ばれない。
    expect(deps.promoteMock).not.toHaveBeenCalled()
    expect(deps.deleteObjectMock).not.toHaveBeenCalled()
    expect(deps.deleteAssetRowMock).not.toHaveBeenCalled()
  })

  it('--sweep + refs あり → 通常進行(guard は abort しない)', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)
    deps.checkRefsPopulatedMock.mockResolvedValueOnce({
      refRowCount: 5,
      hasUuidImageKeys: true,
    })

    const summary = await runReconciler(opts({ sweep: true }), deps)

    // guard を通過し collect が回る(A が回収される)。
    expect(store.assets.has(ASSET_A)).toBe(false)
    expect(summary.rowDeleteOk).toBe(1)
  })

  it('--sweep + refs 空 だが UUID image key 無し → 通常進行(未参照が真に空 = abort しない)', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)
    // refs 空だが cards.images に UUID key も無い(refs が空なのは正しい)。
    deps.checkRefsPopulatedMock.mockResolvedValueOnce({
      refRowCount: 0,
      hasUuidImageKeys: false,
    })

    const summary = await runReconciler(opts({ sweep: true }), deps)

    expect(store.assets.has(ASSET_A)).toBe(false)
    expect(summary.rowDeleteOk).toBe(1)
  })

  it('--sweep --dry-run: guard で abort しない(operator の観測手段)', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)
    // refs 未投入でも dry-run は gate されない。checkRefsPopulated すら呼ばれない。
    deps.checkRefsPopulatedMock.mockResolvedValue({
      refRowCount: 0,
      hasUuidImageKeys: true,
    })

    await expect(
      runReconciler(opts({ sweep: true, dryRun: true }), deps),
    ).resolves.toBeDefined()
    expect(deps.checkRefsPopulatedMock).not.toHaveBeenCalled()
  })

  it('mark-only(sweep なし): guard(checkRefsPopulated)を呼ばない', async () => {
    const store = makeStore([])
    const deps = makeDeps(store)

    await runReconciler(opts({ sweep: false }), deps)

    expect(deps.checkRefsPopulatedMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// collect の state machine(実状態遷移で検証)
// ---------------------------------------------------------------------------
describe('runReconciler collect — state machine', () => {
  it('deleting + refs 無し → deleteObject → deleted → 行 DELETE(store から消える)', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)

    const summary = await runReconciler(opts({ sweep: true }), deps)

    // decouple 順序: deleteObject → markDeleted → deleteAssetRow の順で呼ばれる。
    expect(deps.deleteObjectMock).toHaveBeenCalledWith('users/u/a.webp')
    expect(deps.markDeletedMock).toHaveBeenCalledWith(ASSET_A)
    expect(deps.deleteAssetRowMock).toHaveBeenCalledWith(ASSET_A)
    // 実状態: markDeleted が deleted を経由し、行が store から消える。
    expect(store.assets.has(ASSET_A)).toBe(false)
    expect(summary.r2DeleteOk).toBe(1)
    expect(summary.rowDeleteOk).toBe(1)
    expect(summary.reclaimed).toEqual([
      { assetId: ASSET_A, objectKey: 'users/u/a.webp' },
    ])
  })

  it('R2 が 404 を返す → success-equivalent 扱いで行 DELETE、r2Delete404 に計上', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)
    deps.deleteObjectMock.mockResolvedValueOnce({ ok: true, status: 404 })

    const summary = await runReconciler(opts({ sweep: true }), deps)

    expect(summary.r2Delete404).toBe(1)
    expect(summary.r2DeleteOk).toBe(0)
    expect(store.assets.has(ASSET_A)).toBe(false)
  })

  it('deleted lane(R2 済 crash マーカー): 行 DELETE のみ・R2 は再叩きしない', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleted',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)

    const summary = await runReconciler(opts({ sweep: true }), deps)

    // R2 は叩かない(既に済)。markDeleted も呼ばない(既に deleted)。
    expect(deps.deleteObjectMock).not.toHaveBeenCalled()
    expect(deps.markDeletedMock).not.toHaveBeenCalled()
    expect(deps.deleteAssetRowMock).toHaveBeenCalledWith(ASSET_A)
    expect(store.assets.has(ASSET_A)).toBe(false)
    expect(summary.deletedLaneProcessed).toBe(1)
    expect(summary.rowDeleteOk).toBe(1)
  })

  it('crash 再開: 前 run で deleting のまま残った asset を次 run が拾って回収する', async () => {
    // 「前 run が deleteObject 直後に crash」= 行 DELETE 未完で deleting のまま残置。
    // 次 run で同 asset を deleting として発見 → R2 再 DELETE(404 でも成功)→ 回収。
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting', // crash で残った
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)
    // R2 は既に消えているので 404(冪等再 DELETE)。
    deps.deleteObjectMock.mockResolvedValueOnce({ ok: true, status: 404 })

    const summary = await runReconciler(opts({ sweep: true }), deps)

    expect(deps.deleteObjectMock).toHaveBeenCalledTimes(1)
    expect(store.assets.has(ASSET_A)).toBe(false)
    expect(summary.rowDeleteOk).toBe(1)
  })

  it('複数 asset 混在: deleting 成功 / deleted lane / を 1 run で処理', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
      {
        id: ASSET_B,
        userId: USER_ID,
        objectKey: 'users/u/b.webp',
        status: 'deleted',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)

    const summary = await runReconciler(opts({ sweep: true }), deps)

    expect(store.assets.size).toBe(0)
    expect(summary.r2DeleteOk).toBe(1)
    expect(summary.deletedLaneProcessed).toBe(1)
    expect(summary.rowDeleteOk).toBe(2)
    expect(summary.reclaimed).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// R2 失敗: 行存置 + 台帳記録 + 他 asset 続行
// ---------------------------------------------------------------------------
describe('runReconciler collect — R2 failure', () => {
  it('deleteObject が ok:false(500) → 行存置(deleting のまま)+ recordFailure + 次 asset 続行', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
      {
        id: ASSET_B,
        userId: USER_ID,
        objectKey: 'users/u/b.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)
    // A は R2 失敗(500)、B は成功。
    deps.deleteObjectMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    const summary = await runReconciler(opts({ sweep: true }), deps)

    // A: 行存置(deleting のまま store に残る)、markDeleted / deleteAssetRow 未実行。
    expect(store.assets.get(ASSET_A)?.status).toBe('deleting')
    expect(deps.markDeletedMock).not.toHaveBeenCalledWith(ASSET_A)
    expect(deps.deleteAssetRowMock).not.toHaveBeenCalledWith(ASSET_A)
    // 台帳記録の引数検証(key context)。
    expect(deps.recordFailureMock).toHaveBeenCalledWith({
      userId: USER_ID,
      assetId: ASSET_A,
      objectKey: 'users/u/a.webp',
      status: 'deleting',
      errorMessage: 'R2 delete failed (status=500)',
    })
    // B: 失敗が run を止めず回収される。
    expect(store.assets.has(ASSET_B)).toBe(false)
    expect(summary.r2DeleteFailed).toBe(1)
    expect(summary.r2DeleteOk).toBe(1)
    expect(summary.rowDeleteOk).toBe(1)
  })

  it('R2 timeout(ok:false, status:null) → errorMessage に null が入る', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)
    deps.deleteObjectMock.mockResolvedValueOnce({ ok: false, status: null })

    await runReconciler(opts({ sweep: true }), deps)

    expect(deps.recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'R2 delete failed (status=null)' }),
    )
  })

  // FIX 6(per-asset isolation): recordFailure(recordIntegrationFailure → notifyOps)
  // が Ops config 欠落等で throw しても、その throw は run 全体を中断してはならない。
  // A の R2 失敗 → recordFailure が reject → 握って続行 → B が回収されることを検証。
  it('recordFailure が throw しても run を中断せず次 asset を処理する(台帳書込失敗の isolation)', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
      {
        id: ASSET_B,
        userId: USER_ID,
        objectKey: 'users/u/b.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store)
    // A: R2 失敗 → recordFailure が throw(notifyOps fail-fast を模す)。B: R2 成功。
    deps.deleteObjectMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    deps.recordFailureMock.mockRejectedValueOnce(new Error('notifyOps misconfig'))

    // throw が外に出ない(reject しない)ことを確認。
    const summary = await runReconciler(opts({ sweep: true }), deps)

    // A: 台帳書込は失敗したが行は deleting のまま残る(次 run が再試行)。
    expect(store.assets.get(ASSET_A)?.status).toBe('deleting')
    expect(summary.r2DeleteFailed).toBe(1)
    // B: A の台帳 throw に巻き込まれず回収される(isolation の核心)。
    expect(store.assets.has(ASSET_B)).toBe(false)
    expect(summary.rowDeleteOk).toBe(1)
  })

  it('行 DELETE 失敗(RESTRICT)→ 台帳に積まず summary.rowDeleteFailures に記録', async () => {
    // deleted lane(R2 済 crash マーカー)の行 DELETE が RESTRICT 等で拒否される極端系。
    // deleteAssetRow を無条件 throw の mock に差し替えて RESTRICT 拒否を再現する
    // (store.refs は使わない = self-heal 判定に依存しない純粋な行 DELETE 失敗経路)。
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleted', // R2 済ゆえ collect は行 DELETE のみを試みる
        unreferencedAt: null,
      },
    ])
    const deleteAssetRowMock = vi.fn(async () => {
      throw new Error('restrict violation')
    })
    const deps = makeDeps(store, { deleteAssetRow: deleteAssetRowMock })

    const summary = await runReconciler(opts({ sweep: true }), deps)

    expect(summary.rowDeleteFailed).toBe(1)
    expect(summary.rowDeleteFailures).toEqual([ASSET_A])
    // 行 DELETE 失敗は台帳に積まない(R2 台帳のみ)。
    expect(deps.recordFailureMock).not.toHaveBeenCalled()
    // 行は残る。
    expect(store.assets.has(ASSET_A)).toBe(true)
  })

  // FIX 2(spec §4.4): self-heal は deleting lane 限定。deleted(R2 実体が既に
  // 消えた)asset に参照が付いていても ready に戻してはならない(R2 object 不在の
  // 壊れた ready を鋳造しない)。deleted+refs は collectDeleteRow に落ち、RESTRICT /
  // logger で異常が表面化する。
  it('deleted + refs 存在 → ready 復元しない(collectDeleteRow に落ちる。壊れた ready を作らない)', async () => {
    const store = makeStore(
      [
        {
          id: ASSET_A,
          userId: USER_ID,
          objectKey: 'users/u/a.webp',
          status: 'deleted',
          unreferencedAt: null,
        },
      ],
      new Set([ASSET_A]), // fresh 参照が付いた(異常状態)
    )
    // refs 残存ゆえ RESTRICT で行 DELETE が拒否される(makeDeps の deleteAssetRow は
    // store.refs にあれば throw する)。
    const deps = makeDeps(store)

    const summary = await runReconciler(opts({ sweep: true }), deps)

    // ready に復元されない(status は deleted のまま)。selfHealed も計上されない。
    expect(deps.restoreToReadyMock).not.toHaveBeenCalled()
    expect(store.assets.get(ASSET_A)?.status).toBe('deleted')
    expect(summary.selfHealed).toBe(0)
    // collectDeleteRow に落ち、RESTRICT で行 DELETE 失敗として表面化する。
    expect(summary.rowDeleteFailed).toBe(1)
    expect(summary.rowDeleteFailures).toEqual([ASSET_A])
    // R2 は叩かない(deleted lane)。
    expect(deps.deleteObjectMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// self-heal(fresh 参照復活 → ready 戻し)
// ---------------------------------------------------------------------------
describe('runReconciler collect — self-heal', () => {
  it('collect 前に refs が実在する deleting asset → ready に戻し unreferenced_at=NULL・R2 未呼出', async () => {
    // 実 ref を store.refs に INSERT(promote×handleImages 並走 race の再現)。
    const store = makeStore(
      [
        {
          id: ASSET_A,
          userId: USER_ID,
          objectKey: 'users/u/a.webp',
          status: 'deleting',
          unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
        },
      ],
      new Set([ASSET_A]), // ← refs 復活
    )
    const deps = makeDeps(store)

    const summary = await runReconciler(opts({ sweep: true }), deps)

    // ready に戻り unreferenced_at がクリアされる(実状態検証)。
    const healed = store.assets.get(ASSET_A)
    expect(healed?.status).toBe('ready')
    expect(healed?.unreferencedAt).toBeNull()
    // R2 は叩かない。行 DELETE もしない。
    expect(deps.deleteObjectMock).not.toHaveBeenCalled()
    expect(deps.deleteAssetRowMock).not.toHaveBeenCalled()
    expect(summary.selfHealed).toBe(1)
    expect(summary.r2DeleteOk).toBe(0)
  })

  it('self-heal と回収の混在: refs 復活した A は ready 戻し / refs 無い B は回収', async () => {
    const store = makeStore(
      [
        {
          id: ASSET_A,
          userId: USER_ID,
          objectKey: 'users/u/a.webp',
          status: 'deleting',
          unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
        },
        {
          id: ASSET_B,
          userId: USER_ID,
          objectKey: 'users/u/b.webp',
          status: 'deleting',
          unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
        },
      ],
      new Set([ASSET_A]), // A のみ参照復活
    )
    const deps = makeDeps(store)

    const summary = await runReconciler(opts({ sweep: true }), deps)

    expect(store.assets.get(ASSET_A)?.status).toBe('ready')
    expect(store.assets.has(ASSET_B)).toBe(false)
    expect(summary.selfHealed).toBe(1)
    expect(summary.rowDeleteOk).toBe(1)
    // A は R2 未呼出、B のみ R2 DELETE。
    expect(deps.deleteObjectMock).toHaveBeenCalledTimes(1)
    expect(deps.deleteObjectMock).toHaveBeenCalledWith('users/u/b.webp')
  })
})

// ---------------------------------------------------------------------------
// dry-run: collect でも一切 write しない
// ---------------------------------------------------------------------------
describe('runReconciler collect — dry-run', () => {
  it('dry-run: deleteObject / markDeleted / deleteAssetRow / recordFailure を呼ばず reclaimed に予告のみ', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
      {
        id: ASSET_B,
        userId: USER_ID,
        objectKey: 'users/u/b.webp',
        status: 'deleted',
        unreferencedAt: null,
      },
    ])
    const deps = makeDeps(store)

    const summary = await runReconciler(opts({ sweep: true, dryRun: true }), deps)

    expect(deps.deleteObjectMock).not.toHaveBeenCalled()
    expect(deps.markDeletedMock).not.toHaveBeenCalled()
    expect(deps.deleteAssetRowMock).not.toHaveBeenCalled()
    expect(deps.recordFailureMock).not.toHaveBeenCalled()
    expect(deps.restoreToReadyMock).not.toHaveBeenCalled()
    // 実状態: store は不変。
    expect(store.assets.get(ASSET_A)?.status).toBe('deleting')
    expect(store.assets.get(ASSET_B)?.status).toBe('deleted')
    // 予告として reclaimed に両方積まれる。
    expect(summary.reclaimed).toHaveLength(2)
  })

  it('dry-run + self-heal 対象: restoreToReady を呼ばず状態不変(件数のみ計上)', async () => {
    const store = makeStore(
      [
        {
          id: ASSET_A,
          userId: USER_ID,
          objectKey: 'users/u/a.webp',
          status: 'deleting',
          unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
        },
      ],
      new Set([ASSET_A]),
    )
    const deps = makeDeps(store)

    const summary = await runReconciler(opts({ sweep: true, dryRun: true }), deps)

    expect(deps.restoreToReadyMock).not.toHaveBeenCalled()
    expect(store.assets.get(ASSET_A)?.status).toBe('deleting') // 不変
    expect(summary.selfHealed).toBe(1) // 件数は計上
  })
})

// ---------------------------------------------------------------------------
// FIX 4: mark-only / dry-run は R2(deleteObject)を一切呼ばない — production の
// main() が R2 module を実 sweep-collect でのみ dynamic import してよい根拠
// (mark-only / dry-run で R2 env fail-fast を持ち込まない)。core が deleteObject を
// 呼ばないことを、throw する deleteObject を注入して実証する(呼ばれれば test が
// throw で落ちる)。
// ---------------------------------------------------------------------------
describe('runReconciler — R2 module not required on mark/dry-run', () => {
  function throwingDeleteObject() {
    return async () => {
      throw new Error('deleteObject must not be called on mark-only/dry-run')
    }
  }

  it('mark-only(sweep なし): deleteObject を注入しても呼ばれない', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store, { deleteObject: throwingDeleteObject() })

    // mark-only は collect を走らせないため throw に到達しない。
    await expect(
      runReconciler(opts({ sweep: false }), deps),
    ).resolves.toBeDefined()
  })

  it('dry-run(sweep): collect 候補があっても deleteObject を呼ばない', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        unreferencedAt: new Date(Date.now() - 40 * DAY_MS),
      },
    ])
    const deps = makeDeps(store, { deleteObject: throwingDeleteObject() })

    await expect(
      runReconciler(opts({ sweep: true, dryRun: true }), deps),
    ).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 未知 status の防衛(CHECK なし列)
// ---------------------------------------------------------------------------
describe('runReconciler collect — unknown status defense', () => {
  it('AssetStatus union 外の status → warn して skip(unknownStatus 計上・write なし)', async () => {
    const store = makeStore([
      {
        id: ASSET_A,
        userId: USER_ID,
        objectKey: 'users/u/a.webp',
        status: 'archived', // union 外
        unreferencedAt: null,
      },
    ])
    // fetchCollectCandidates を上書きして union 外 status を collect に流し込む
    // (production の WHERE は deleting/deleted のみだが、CHECK なし列の防衛を検証)。
    const deps = makeDeps(store, {
      fetchCollectCandidates: async () => [
        {
          id: ASSET_A,
          userId: USER_ID,
          objectKey: 'users/u/a.webp',
          status: 'archived',
          unreferencedAt: null,
        },
      ],
    })

    const summary = await runReconciler(opts({ sweep: true }), deps)

    expect(summary.unknownStatus).toBe(1)
    expect(deps.deleteObjectMock).not.toHaveBeenCalled()
    expect(deps.deleteAssetRowMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
describe('parseUserFlag', () => {
  it('--user 無し: undefined', () => {
    expect(parseUserFlag(['node', 's.ts', '--sweep'])).toBeUndefined()
  })
  it('--user <値>: 値を返す', () => {
    expect(parseUserFlag(['node', 's.ts', '--user', 'u-1'])).toBe('u-1')
  })
  it('--user 値なし(末尾): fail-fast throw', () => {
    expect(() => parseUserFlag(['node', 's.ts', '--user'])).toThrow(
      /--user requires a userId value/,
    )
  })
  it('--user の直後が別 flag: fail-fast throw', () => {
    expect(() => parseUserFlag(['node', 's.ts', '--user', '--sweep'])).toThrow(
      /--user requires a userId value/,
    )
  })
})

describe('parseGraceDays', () => {
  it('--grace-days 無し: 既定 30', () => {
    expect(parseGraceDays(['node', 's.ts'], {})).toBe(DEFAULT_GRACE_DAYS)
  })
  it('--grace-days 7: 上書き値(非 production)', () => {
    expect(parseGraceDays(['node', 's.ts', '--grace-days', '7'], {})).toBe(7)
  })
  it('--grace-days 値なし: fail-fast throw', () => {
    expect(() => parseGraceDays(['node', 's.ts', '--grace-days'], {})).toThrow(
      /requires a non-negative integer/,
    )
  })
  it('--grace-days 非整数: fail-fast throw', () => {
    expect(() =>
      parseGraceDays(['node', 's.ts', '--grace-days', 'abc'], {}),
    ).toThrow(/non-negative integer/)
  })
  it('--grace-days 負数: fail-fast throw', () => {
    expect(() =>
      parseGraceDays(['node', 's.ts', '--grace-days', '-5'], {}),
    ).toThrow(/non-negative integer/)
  })

  // prod ガード
  it('prod ガード: VERCEL_ENV=production + grace 30 未満 → reject(throw)', () => {
    expect(() =>
      parseGraceDays(['node', 's.ts', '--grace-days', '0'], {
        VERCEL_ENV: 'production',
      }),
    ).toThrow(/production guard/)
  })
  it('prod ガード: NODE_ENV=production + grace 未満 → reject(throw)', () => {
    expect(() =>
      parseGraceDays(['node', 's.ts', '--grace-days', '10'], {
        NODE_ENV: 'production',
      }),
    ).toThrow(/production guard/)
  })
  it('prod ガード: production + grace 30 以上は許容', () => {
    expect(
      parseGraceDays(['node', 's.ts', '--grace-days', '30'], {
        VERCEL_ENV: 'production',
      }),
    ).toBe(30)
    expect(
      parseGraceDays(['node', 's.ts', '--grace-days', '60'], {
        VERCEL_ENV: 'production',
      }),
    ).toBe(60)
  })
  it('非 production では grace 0 も許容(stg 検証)', () => {
    expect(
      parseGraceDays(['node', 's.ts', '--grace-days', '0'], {
        VERCEL_ENV: 'preview',
      }),
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// buildReconcilerDeps(Task 2): collectLimit の LIMIT/ORDER BY 発行
// ---------------------------------------------------------------------------
describe('buildReconcilerDeps — fetchCollectCandidates SQL', () => {
  it('collectLimit 未指定: 現行 SQL と同一(ORDER BY / LIMIT を発行しない)', async () => {
    const deps = buildReconcilerDeps({
      exec: makeFakeExec(),
      deleteObject: async () => ({ ok: true, status: 200 }),
      log: vi.fn(),
    })

    await deps.fetchCollectCandidates()

    expect(unsafeMock).toHaveBeenCalledTimes(1)
    const [query] = unsafeMock.mock.calls[0] as [string, unknown[]]
    expect(query).not.toMatch(/order by/i)
    expect(query).not.toMatch(/limit/i)
  })

  it('collectLimit 指定: ORDER BY unreferenced_at NULLS FIRST, created_at, id + LIMIT が発行される', async () => {
    const deps = buildReconcilerDeps({
      exec: makeFakeExec(),
      collectLimit: COLLECT_LIMIT_PER_USER,
      deleteObject: async () => ({ ok: true, status: 200 }),
      log: vi.fn(),
    })

    await deps.fetchCollectCandidates()

    const [query, params] = unsafeMock.mock.calls[0] as [string, unknown[]]
    // NULLS FIRST の理由(退会由来 asset を最優先で回収)は lib/storage/asset-gc.ts の
    // buildReconcilerDeps doc comment 参照。
    expect(query).toMatch(
      /order by "assets"\."unreferenced_at" NULLS FIRST, "assets"\."created_at", "assets"\."id" limit/i,
    )
    expect(params).toEqual(['deleting', 'deleted', COLLECT_LIMIT_PER_USER])
  })
})

// ---------------------------------------------------------------------------
// buildReconcilerDeps(Task 2): recordFailure の onRecordError 集約 seam(B-4)。
// core(runReconciler)を無改造のまま lane が記帳失敗回数を集約できる唯一の経路。
// ---------------------------------------------------------------------------
describe('buildReconcilerDeps — recordFailure / onRecordError(B-4 seam)', () => {
  const neverCalledExec: ReconcilerExec = async () => {
    throw new Error('recordFailure must not use exec (bypasses DI, calls recordIntegrationFailure directly)')
  }

  it('記帳(recordIntegrationFailure)が throw → onRecordError が呼ばれ、throw は外に出ない(握って続行)', async () => {
    recordIntegrationFailureMock.mockRejectedValueOnce(new Error('notifyOps misconfig'))
    const onRecordError = vi.fn()
    const deps = buildReconcilerDeps({
      exec: neverCalledExec,
      deleteObject: async () => ({ ok: true, status: 200 }),
      onRecordError,
      log: vi.fn(),
    })

    await expect(
      deps.recordFailure({
        userId: USER_ID,
        assetId: ASSET_A,
        objectKey: 'users/u/a.webp',
        status: 'deleting',
        errorMessage: 'R2 delete failed (status=500)',
      }),
    ).resolves.toBeUndefined()

    expect(onRecordError).toHaveBeenCalledTimes(1)
  })

  it('記帳が成功 → onRecordError は呼ばれない', async () => {
    recordIntegrationFailureMock.mockResolvedValueOnce(undefined)
    const onRecordError = vi.fn()
    const deps = buildReconcilerDeps({
      exec: neverCalledExec,
      deleteObject: async () => ({ ok: true, status: 200 }),
      onRecordError,
      log: vi.fn(),
    })

    await deps.recordFailure({
      userId: USER_ID,
      assetId: ASSET_A,
      objectKey: 'users/u/a.webp',
      status: 'deleting',
      errorMessage: 'R2 delete failed (status=500)',
    })

    expect(onRecordError).not.toHaveBeenCalled()
  })
})
