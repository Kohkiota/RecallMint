import { describe, it, expect, vi, beforeEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'

import { assets } from '@/lib/db/schema'
import {
  selectOrphanCandidates,
  runOrphanScanLane,
  ORPHAN_CUTOFF_MS,
  ORPHAN_ROW_CHECK_BATCH,
} from './orphan-scan'
import type { R2ObjectMeta } from './r2'

// 選定 pure 関数の test(plan Task 6 完了条件 ①)。I/O なし(mock 不要) — entries を
// 直接組み立てて渡すだけ。lane orchestration(②〜⑦)の test は file 後半
// (全 I/O mock + 時刻注入・src-sweep.test.ts の idiom 踏襲)。

// ---------------------------------------------------------------------------
// mock 群(vi.mock は file 全体に効くため import 直後に置く)。
//
// timeout 定数(LIST_TIMEOUT_MS / DELETE_TIMEOUT_MS)は importOriginal で実物を残す —
// 写すと r2.ts 側が変わったときに予算計算の pin が silent に古い値を見る。
//
// `./live-upload-check`(hasLiveUploadOperationForSweep)は意図的に mock しない —
// src-sweep.test.ts と同じ選択で、`@/lib/db/tenant-tx` の withTenantTx だけを mock し
// 本物の live 判定ロジック(isLiveUploadOperationCondition)を通す。本 lane 自身の
// 行不在確認クエリも同じ withTenantTx を経由するため、mock 側は「同一 userId への
// 1 回目呼出 = live check」「2 回目以降 = 行不在確認 batch」という**実際の呼出順**を
// 前提に応答を出し分ける(1 user につき候補は必ず 1 グループ = live check は必ず 1 回
// だけなので、呼出順で判別して壊れない)。
// ---------------------------------------------------------------------------
const {
  mockListObjectsWithMetaBounded,
  mockDeleteObject,
  mockWithTenantTx,
  mockRecordIntegrationFailure,
  mockLogger,
} = vi.hoisted(() => ({
  mockListObjectsWithMetaBounded: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockWithTenantTx: vi.fn(),
  mockRecordIntegrationFailure: vi.fn(),
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('./r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./r2')>()),
  listObjectsWithMetaBounded: mockListObjectsWithMetaBounded,
  deleteObject: mockDeleteObject,
}))
vi.mock('@/lib/db/tenant-tx', () => ({ withTenantTx: mockWithTenantTx }))
vi.mock('@/lib/integration-failures', () => ({
  recordIntegrationFailure: mockRecordIntegrationFailure,
}))
vi.mock('@/lib/logger', () => ({ logger: mockLogger }))

const NOW_MS = Date.UTC(2026, 7, 10, 12, 0, 0) // 2026-08-10T12:00:00Z(固定 now)

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ASSET_A = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'
const KEY_A = `users/${USER_A}/${ASSET_A}.webp`

const USER_B = 'dddddddd-dddd-4ddd-bddd-dddddddddddd'
const ASSET_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const KEY_B = `users/${USER_B}/${ASSET_B}.png`

const USER_C = '11111111-1111-4111-8111-111111111111'

function meta(key: string, lastModifiedMs: number): R2ObjectMeta {
  return { key, lastModifiedMs }
}

// ---------------------------------------------------------------------------
// selectOrphanCandidates(完了条件 ①)
// ---------------------------------------------------------------------------

describe('selectOrphanCandidates — cutoff boundary(① age > cutoff, `>` 比較)', () => {
  it('age === ORPHAN_CUTOFF_MS ちょうどは候補外(patternMismatch にも入らない)', () => {
    const entries = [meta(KEY_A, NOW_MS - ORPHAN_CUTOFF_MS)]
    const result = selectOrphanCandidates(entries, NOW_MS)
    expect(result.candidates).toEqual([])
    expect(result.patternMismatch).toEqual([])
  })

  it('age === ORPHAN_CUTOFF_MS + 1ms は候補になる', () => {
    const entries = [meta(KEY_A, NOW_MS - ORPHAN_CUTOFF_MS - 1)]
    const result = selectOrphanCandidates(entries, NOW_MS)
    expect(result.candidates).toEqual([
      { userId: USER_A, keys: [KEY_A], oldestMs: NOW_MS - ORPHAN_CUTOFF_MS - 1 },
    ])
  })

  it('age === ORPHAN_CUTOFF_MS - 1ms(まだ新しい)は候補外', () => {
    const entries = [meta(KEY_A, NOW_MS - ORPHAN_CUTOFF_MS + 1)]
    const result = selectOrphanCandidates(entries, NOW_MS)
    expect(result.candidates).toEqual([])
  })
})

describe('selectOrphanCandidates — key 規約(① pattern 不一致の分離)', () => {
  const oldMs = NOW_MS - ORPHAN_CUTOFF_MS - 1 // 全 case で「age は十分古い」を固定し、判定差は key 形のみにする

  it('大文字 uuid セグメントは一致する(正例・case-insensitive)', () => {
    const upperUserId = USER_A.toUpperCase()
    const upperAssetId = ASSET_A.toUpperCase()
    const upperKey = `users/${upperUserId}/${upperAssetId}.webp`
    const result = selectOrphanCandidates([meta(upperKey, oldMs)], NOW_MS)
    expect(result.patternMismatch).toEqual([])
    expect(result.candidates).toEqual([{ userId: upperUserId, keys: [upperKey], oldestMs: oldMs }])
  })

  it('uuid 非 v4(version byte 不一致)は不一致', () => {
    // 3 グループ目の先頭は v4 なら常に '4' — ここを '1' にした v1 相当の見た目のみ uuid
    const v1LikeUserId = 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa'
    const key = `users/${v1LikeUserId}/${ASSET_A}.webp`
    const result = selectOrphanCandidates([meta(key, oldMs)], NOW_MS)
    expect(result.patternMismatch).toEqual([key])
    expect(result.candidates).toEqual([])
  })

  it('.WEBP(大文字拡張子)は不一致', () => {
    const key = `users/${USER_A}/${ASSET_A}.WEBP`
    const result = selectOrphanCandidates([meta(key, oldMs)], NOW_MS)
    expect(result.patternMismatch).toEqual([key])
    expect(result.candidates).toEqual([])
  })

  it('旧 users/{uid}/src/… (3 セグメント)は不一致', () => {
    const key = `users/${USER_A}/src/${ASSET_A}.pdf`
    const result = selectOrphanCandidates([meta(key, oldMs)], NOW_MS)
    expect(result.patternMismatch).toEqual([key])
    expect(result.candidates).toEqual([])
  })

  it('prefix が users/ でない場合は不一致', () => {
    const key = `other/${USER_A}/${ASSET_A}.webp`
    const result = selectOrphanCandidates([meta(key, oldMs)], NOW_MS)
    expect(result.patternMismatch).toEqual([key])
  })

  it('uuid 非形式(桁数違い)は不一致', () => {
    const key = `users/${USER_A}/not-a-uuid.webp`
    const result = selectOrphanCandidates([meta(key, oldMs)], NOW_MS)
    expect(result.patternMismatch).toEqual([key])
  })
})

describe('selectOrphanCandidates — user 別グルーピング + oldest 昇順', () => {
  it('同一 user 内は keys にまとめ、oldestMs = 最古の lastModifiedMs', () => {
    const asset2 = '12121212-1212-4121-8121-121212121212'
    const key2 = `users/${USER_A}/${asset2}.png`
    const oldestMs = NOW_MS - ORPHAN_CUTOFF_MS - 5000
    const entries = [
      meta(KEY_A, NOW_MS - ORPHAN_CUTOFF_MS - 1), // 新しい方
      meta(key2, oldestMs), // 古い方
    ]
    const result = selectOrphanCandidates(entries, NOW_MS)
    expect(result.candidates).toEqual([{ userId: USER_A, keys: [KEY_A, key2], oldestMs }])
  })

  it('複数 user は oldestMs 昇順(最古候補を持つ user が先)', () => {
    const entries = [
      meta(KEY_A, NOW_MS - ORPHAN_CUTOFF_MS - 1_000), // user A: 新しめ
      meta(KEY_B, NOW_MS - ORPHAN_CUTOFF_MS - 9_000), // user B: より古い
    ]
    const result = selectOrphanCandidates(entries, NOW_MS)
    expect(result.candidates.map((c) => c.userId)).toEqual([USER_B, USER_A])
  })
})

// ---------------------------------------------------------------------------
// lane orchestration(完了条件 ②〜⑦)
//
// 全 I/O(R2 listing / DELETE / DB 行確認 / live 判定 / 台帳記帳 / logger)を mock し、
// 時刻は `now: () => number` 注入で制御する(実 sleep なし)。
// ---------------------------------------------------------------------------

// live 判定の応答。既定 = live なし(rows 空)。
type LiveResult = { rows: { id: string }[] } | { error: Error }
// 行不在確認 batch の応答。既定(未設定) = 行なし(= 全 rowless)。
type RowCheckResult = { objectKey: string }[] | Error

let clock = NOW_MS
const injectedNow = () => clock
let liveByUser: Map<string, LiveResult>
let liveWhereByUser: Map<string, unknown>
let rowCheckQueueByUser: Map<string, RowCheckResult[]>
let rowCheckWhereByUser: Map<string, unknown>
let callCountByUser: Map<string, number>
let calls: string[] // spy 横断の呼び出し順(順序 pin 用)
let deleteCostMs: number
let recordCostMs: number
let rowCheckCostMs: number // 行不在確認 1 batch あたりの経過(Codex P2 の recheck test 用)
let liveCheckCostMs: number // live 判定 1 回あたりの経過(round 4 の post-loop check test 用)

// `select().from().where(cond)` の返り値が「直接 await できる(行不在確認)」かつ
// 「.limit() を持つ(live 判定 = hasLiveUploadOperationForSweep が .limit(1) を呼ぶ)」
// 両方を満たす形にする — 本 lane と live 判定が同じ withTenantTx mock を共有するため。
function fakeTx(rows: unknown[], captureWhere?: (cond: unknown) => void) {
  return {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          captureWhere?.(cond)
          const result = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>
          }
          result.limit = async () => rows
          return result
        },
      }),
    }),
  }
}

beforeEach(() => {
  clock = NOW_MS
  liveByUser = new Map()
  liveWhereByUser = new Map()
  rowCheckQueueByUser = new Map()
  rowCheckWhereByUser = new Map()
  callCountByUser = new Map()
  calls = []
  deleteCostMs = 0
  recordCostMs = 0
  rowCheckCostMs = 0
  liveCheckCostMs = 0
  vi.clearAllMocks()

  mockListObjectsWithMetaBounded.mockResolvedValue({ entries: [], truncated: false })
  mockDeleteObject.mockImplementation(async (objectKey: string) => {
    calls.push(`delete:${objectKey}`)
    clock += deleteCostMs
    return { ok: true, status: 204 }
  })
  mockRecordIntegrationFailure.mockImplementation(async (args: { key: string }) => {
    calls.push(`record:${args.key}`)
    clock += recordCostMs
  })
  mockWithTenantTx.mockImplementation(
    async (userId: string, fn: (tx: unknown) => Promise<unknown>) => {
      const count = (callCountByUser.get(userId) ?? 0) + 1
      callCountByUser.set(userId, count)
      if (count === 1) {
        // 1 回目 = live check(hasLiveUploadOperationForSweep が最初に呼ぶ)。
        calls.push(`live:${userId}`)
        clock += liveCheckCostMs
        const result = liveByUser.get(userId) ?? { rows: [] }
        if ('error' in result) throw result.error
        return fn(fakeTx(result.rows, (cond) => liveWhereByUser.set(userId, cond)))
      }
      // 2 回目以降 = 行不在確認 batch(呼出順に queue を消費)。
      calls.push(`rowcheck:${userId}:${count}`)
      clock += rowCheckCostMs
      const queue = rowCheckQueueByUser.get(userId) ?? []
      const next = queue.shift()
      if (next instanceof Error) throw next
      const rows = next ?? []
      return fn(fakeTx(rows, (cond) => rowCheckWhereByUser.set(`${userId}:${count}`, cond)))
    },
  )
})

// 規約一致 key(user ごとに assetId だけ変える)。
function orphanKey(userId: string, n: number, ext: 'webp' | 'png' | 'jpg' = 'webp'): string {
  const assetId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  return `users/${userId}/${assetId}.${ext}`
}
function aged(key: string, ageMs: number): R2ObjectMeta {
  return { key, lastModifiedMs: NOW_MS - ageMs }
}
function listing(entries: R2ObjectMeta[], truncated = false) {
  mockListObjectsWithMetaBounded.mockResolvedValue({ entries, truncated })
}
function setRowCheckRows(userId: string, ...batches: { objectKey: string }[][]) {
  rowCheckQueueByUser.set(userId, [...batches])
}
function recordedRow(key: string): Record<string, unknown> | undefined {
  const call = mockRecordIntegrationFailure.mock.calls.find(
    (c) => (c[0] as { key: string }).key === key,
  )
  return call?.[0] as Record<string, unknown> | undefined
}

const CANDIDATE_AGE = ORPHAN_CUTOFF_MS + 60_000 // cutoff 超(候補)
// 十分に広い予算(打ち切りが起きない run 用)。
const WIDE_DEADLINE = new Date(NOW_MS + 300_000)

function run(overrides: Partial<Parameters<typeof runOrphanScanLane>[0]> = {}) {
  return runOrphanScanLane({
    deadlineAt: WIDE_DEADLINE,
    now: injectedNow,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// ② 行あり key は削除されない(この lane の最重要不変条件)
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — 行あり key は削除されない(②)', () => {
  it('assets 行が実在する key は rowSkipped に計上し、当該 key の deleteObject を発行しない', async () => {
    const keyWithRow = orphanKey(USER_A, 1)
    const keyRowless = orphanKey(USER_A, 2)
    listing([aged(keyWithRow, CANDIDATE_AGE), aged(keyRowless, CANDIDATE_AGE)])
    setRowCheckRows(USER_A, [{ objectKey: keyWithRow }])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalledWith(keyWithRow, expect.anything())
    expect(mockDeleteObject).toHaveBeenCalledWith(keyRowless, expect.anything())
    expect(summary.candidates).toBe(2)
    expect(summary.rowSkipped).toBe(1)
    expect(summary.rowless).toBe(1)
    expect(summary.deleted).toBe(1)
  })

  it('全 key が行あり(0 rowless)なら DELETE を一切発行しない', async () => {
    const keyA = orphanKey(USER_A, 1)
    const keyB = orphanKey(USER_A, 2)
    listing([aged(keyA, CANDIDATE_AGE), aged(keyB, CANDIDATE_AGE)])
    setRowCheckRows(USER_A, [{ objectKey: keyA }, { objectKey: keyB }])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(summary.rowSkipped).toBe(2)
    expect(summary.rowless).toBe(0)
    expect(summary.deleted).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 行不在確認の throw は candidate 単位で skip する(canonical review Important #1)
//
// withTenantTx(行不在確認)が throw する(transient DB error)ケース。live check と
// 同じ fail-safe: 行の有無が分からないまま削除側へ倒れてはならない。**candidate 全体**
// を skip し(batch 途中まで成功していてもその部分結果は採用しない)、他 candidate の
// 処理・run 全体は継続する(live check の throw が他 user を巻き込まないのと対称)。
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — 行不在確認の throw は candidate 単位で skip する(canonical review Important #1)', () => {
  it('行不在確認の throw で当該 candidate 全体を skip し、他 candidate の DELETE は進む', async () => {
    const keyA1 = orphanKey(USER_A, 1)
    const keyB1 = orphanKey(USER_B, 1)
    rowCheckQueueByUser.set(USER_A, [new Error('db down')])
    listing([
      aged(keyA1, CANDIDATE_AGE + 10_000), // A の方が古い = 先に評価される
      aged(keyB1, CANDIDATE_AGE),
    ])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalledWith(keyA1, expect.anything())
    expect(mockDeleteObject).toHaveBeenCalledWith(keyB1, expect.anything())
    expect(summary.rowSkipped).toBe(0)
    expect(summary.rowless).toBe(1) // B のみ(A は行不在確認未了で候補に入らない)
    expect(summary.deleted).toBe(1)
    expect(summary.phase).toBe('row_check')
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'orphan_scan.row_check_failed', userId: USER_A }),
    )
    // run 全体は throw せず、r2_orphan_incomplete も書かれる(観測契約が壊れない)。
    expect(summary.error).toBeUndefined()
    expect(recordedRow('r2_orphan_incomplete')?.context).toMatchObject({ phase: 'row_check' })
  })

  it('複数 batch のうち後段が throw したら、先に成功した batch の部分結果も採用しない(all-or-nothing)', async () => {
    const entries = Array.from({ length: 501 }, (_, i) =>
      aged(orphanKey(USER_A, i + 1), CANDIDATE_AGE),
    )
    listing(entries)
    // 1 batch 目(500 件)は成功(1 件だけ行あり)、2 batch 目(1 件)で throw。
    rowCheckQueueByUser.set(USER_A, [[{ objectKey: orphanKey(USER_A, 1) }], new Error('db down')])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalled()
    // 1 batch 目で確定したはずの rowSkipped=1 / rowless=499 も破棄される。
    expect(summary.rowSkipped).toBe(0)
    expect(summary.rowless).toBe(0)
    expect(summary.phase).toBe('row_check')
  })
})

// ---------------------------------------------------------------------------
// ③ live throw → user skip・DELETE 未発行
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — live 判定は skip に倒す(③)', () => {
  it('live 判定の throw で user 全体を skip し DELETE を一切発行しない(fail-safe)', async () => {
    liveByUser.set(USER_A, { error: new Error('db down') })
    listing([aged(orphanKey(USER_A, 1), CANDIDATE_AGE), aged(orphanKey(USER_A, 2), CANDIDATE_AGE)])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(summary.skippedLiveUsers).toBe(1)
    expect(summary.phase).toBe('live_check')
    expect(summary.rowless).toBe(0)
    expect(summary.rowSkipped).toBe(0)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'orphan_scan.live_check_failed' }),
    )
    expect(recordedRow('r2_orphan_incomplete')?.context).toMatchObject({ phase: 'live_check' })
  })

  it('live な user(rows あり)も候補を全て skip する(繰延・incomplete は書かない)', async () => {
    liveByUser.set(USER_A, { rows: [{ id: 'op-1' }] })
    listing([aged(orphanKey(USER_A, 1), CANDIDATE_AGE)])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(summary.skippedLiveUsers).toBe(1)
    expect(summary.phase).toBeNull()
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
  })

  it('live な user を skip しても他 user の DELETE は進む', async () => {
    liveByUser.set(USER_A, { rows: [{ id: 'op-1' }] })
    const keyB = orphanKey(USER_B, 1)
    listing([
      aged(orphanKey(USER_A, 1), CANDIDATE_AGE + 10_000), // A の方が古い = 先に評価される
      aged(keyB, CANDIDATE_AGE),
    ])

    const summary = await run()

    expect(calls).toEqual([`live:${USER_A}`, `live:${USER_B}`, `rowcheck:${USER_B}:2`, `delete:${keyB}`])
    expect(summary.deleted).toBe(1)
    expect(summary.skippedLiveUsers).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ④ 501 件超の候補で行確認が 500 ずつ 2 回に分かれる
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — 行不在確認の batch 分割(④)', () => {
  it('501 件の候補は行確認が ORPHAN_ROW_CHECK_BATCH(500)ずつ 2 batch に分かれる', async () => {
    expect(ORPHAN_ROW_CHECK_BATCH).toBe(500)
    const entries = Array.from({ length: 501 }, (_, i) =>
      aged(orphanKey(USER_A, i + 1), CANDIDATE_AGE),
    )
    listing(entries)

    const summary = await run()

    const rowCheckCalls = calls.filter((c) => c.startsWith(`rowcheck:${USER_A}`))
    expect(rowCheckCalls).toHaveLength(2)
    expect(summary.candidates).toBe(501)
    expect(summary.rowSkipped).toBe(0)
    expect(summary.rowless).toBe(501)
    expect(summary.deleted).toBe(501)
  })

  it('500 件ちょうどの候補は行確認が 1 batch で済む', async () => {
    const entries = Array.from({ length: 500 }, (_, i) =>
      aged(orphanKey(USER_A, i + 1), CANDIDATE_AGE),
    )
    listing(entries)

    await run()

    const rowCheckCalls = calls.filter((c) => c.startsWith(`rowcheck:${USER_A}`))
    expect(rowCheckCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// ⑤ deadline 打ち切り + incomplete
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — 予算と phase(⑤)', () => {
  it('残 slice が MIN_SLICE 未満になったら打ち切り、最古 user から処理し incomplete を記帳する', async () => {
    deleteCostMs = 2_000
    // workDeadline = deadlineAt(+15s) - TAIL_RESERVE(10s) = +5s。
    // DELETE 1 回 2s ゆえ 2 user 目までで slice 1s < MIN_SLICE(2s) → 3 user 目で打ち切り。
    const keyOldest = orphanKey(USER_C, 1)
    const keyMiddle = orphanKey(USER_A, 1)
    const keyNewest = orphanKey(USER_B, 1)
    listing([
      aged(keyNewest, CANDIDATE_AGE),
      aged(keyOldest, CANDIDATE_AGE + 20_000),
      aged(keyMiddle, CANDIDATE_AGE + 10_000),
    ])

    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    // 最古が残らない(oldest 昇順で処理する)
    expect(calls.filter((c) => c.startsWith('delete:'))).toEqual([
      `delete:${keyOldest}`,
      `delete:${keyMiddle}`,
    ])
    expect(summary.deleted).toBe(2)
    expect(summary.rowless).toBe(2) // keyOldest + keyMiddle(keyNewest は候補にすら入らない)
    expect(summary.phase).toBe('deadline')
    expect(recordedRow('r2_orphan_incomplete')?.context).toMatchObject({
      phase: 'deadline',
      listed: 3,
      deleteRequested: 2,
      // canonical review Important #2 の pin: rowless(2) - deleted(2) - failed(0) = 0。
      // 旧式 `candidateKeys - deleteRequested`(3-2=1)だと、行確認未了のまま候補にすら
      // 入っていない keyNewest 分を「未削除の真の orphan backlog」に誤算入してしまう。
      remaining: 0,
    })
    // 3 user 目(newest = 未処理)は打ち切り判定より前に評価さえされない — live check
    // (DB 読出し)や行不在確認を無駄撃ちしない(deadline チェックは各候補の**先頭**で行う)。
    expect(calls).not.toContain(`live:${USER_B}`)
  })

  it('listing の timeoutMs は 1 page ぶん(残 slice ÷ page 上限)・DELETE は残 slice で cap', async () => {
    const key = orphanKey(USER_A, 1)
    listing([aged(key, CANDIDATE_AGE)])

    // 開始時 slice = 15s - TAIL_RESERVE(10s) = 5s。
    await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    // 5s をそのまま渡すと 10 page で最悪 50s = 予算の 10 倍(src-sweep §2 と同じ危険)。
    expect(mockListObjectsWithMetaBounded).toHaveBeenCalledWith('users/', 10, {
      timeoutMs: 500,
    })
    expect(mockDeleteObject).toHaveBeenCalledWith(key, { timeoutMs: 5_000 })
  })

  it('listing の throw は phase list + errorMessage に畳み、削除は走らない', async () => {
    mockListObjectsWithMetaBounded.mockRejectedValue(new Error('listObjects failed: status=500'))

    const summary = await run()

    expect(summary.listed).toBe(0)
    expect(summary.phase).toBe('list')
    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(recordedRow('r2_orphan_incomplete')?.errorMessage).toBe(
      'Error: listObjects failed: status=500',
    )
  })

  it('phase は配列順で優先される(list_truncated が deadline に勝つ)', async () => {
    deleteCostMs = 4_000
    listing(
      [
        aged(orphanKey(USER_A, 1), CANDIDATE_AGE + 10_000),
        aged(orphanKey(USER_B, 1), CANDIDATE_AGE),
      ],
      true,
    )

    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    expect(summary.truncated).toBe(true)
    expect(summary.deleted).toBe(1)
    expect(summary.phase).toBe('list_truncated')
  })
})

// ---------------------------------------------------------------------------
// row-check 完了後の deadline recheck(Codex P2)
//
// delete loop 内の chunk ごとの check だけでは「row-check で残予算を使い切り、かつ
// 候補の全 key に行があった(rowlessKeys が空)」を検出できない — `for (let i = 0;
// i < rowlessKeys.length; …)` の body が一度も実行されないため。最後の candidate で
// これが起きると、候補 loop 先頭の check も(次候補が無いので)走らず、実際には
// deadline 超過しているのに `phase` が null のまま「完走」として報告される。
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — row-check 完了後の deadline recheck(Codex P2)', () => {
  it('最後の candidate で row-check 後に予算が尽き、かつ全 key に行がある(rowlessKeys 空)場合も phase=deadline を立てる', async () => {
    rowCheckCostMs = 4_000
    const keyWithRow = orphanKey(USER_A, 1)
    listing([aged(keyWithRow, CANDIDATE_AGE)])
    setRowCheckRows(USER_A, [{ objectKey: keyWithRow }])

    // workDeadline = deadlineAt(+15s) - TAIL_RESERVE(10s) = +5s。row-check で 4s
    // 消費後 slice = 1s < MIN_SLICE(2s)。rowlessKeys は空(唯一の key に行がある)ため
    // delete loop の body は一度も走らない — この recheck が無いと phase は null のまま。
    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(summary.rowSkipped).toBe(1)
    expect(summary.rowless).toBe(0)
    expect(summary.deleted).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.phase).toBe('deadline')
    expect(recordedRow('r2_orphan_incomplete')?.context).toMatchObject({
      phase: 'deadline',
      // 「超過したが残作業(真の orphan の未削除分)は無かった」という正直な記録。
      remaining: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// 終端 path の一様な overrun 検知(round 4・構造修正)
//
// round 3 までは「予算を消費しうる I/O の後ろ」に個別 check を足す方式だったが、同じ
// 失敗様式(予算を使い切ったまま loop が自然終了し `phase` が null のまま「完走」と
// 報告される)が 3 回連続で別々の path から見つかった(row-check 後に rowlessKeys が
// 空 / 最終 delete chunk が成功して予算を使い切る / 最終 candidate の live 判定が
// 予算を使い切って true を返す)。以下 2 本は後者 2 つを pin する — 候補 loop を
// 抜けた直後の post-loop check がこの 2 経路も一様に覆うことの確認。
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — 終端 path の一様な overrun 検知(round 4)', () => {
  it('最終 delete chunk が成功して予算を使い切っても phase=deadline を立てる', async () => {
    deleteCostMs = 4_000
    const key = orphanKey(USER_A, 1)
    listing([aged(key, CANDIDATE_AGE)])

    // workDeadline = deadlineAt(+15s) - TAIL_RESERVE(10s) = +5s。delete 成功後
    // clock が 4s 進み slice = 1s < MIN_SLICE(2s)。chunk loop は 1 key しか無いため
    // 次の chunk 頭 check には到達せず(body が自然終了)、candidate loop も自然終了する
    // — chunk 内の check は失敗時にしか走らないため、この経路は in-loop check では
    // 検出できない(post-loop check だけが拾う)。
    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    expect(summary.deleted).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.phase).toBe('deadline')
    expect(recordedRow('r2_orphan_incomplete')?.context).toMatchObject({ phase: 'deadline' })
  })

  it('最終 candidate の live 判定が予算を使い切って true を返しても phase=deadline を立てる', async () => {
    liveCheckCostMs = 4_000
    liveByUser.set(USER_A, { rows: [{ id: 'op-1' }] })
    listing([aged(orphanKey(USER_A, 1), CANDIDATE_AGE)])

    // workDeadline = +5s。live check で 4s 進み slice = 1s < MIN_SLICE(2s)。live=true
    // は正常な繰延(continue)であって fail-safe の phase は立てないため、これも
    // in-loop check では検出できない(post-loop check だけが拾う)。
    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(summary.skippedLiveUsers).toBe(1)
    expect(summary.phase).toBe('deadline')
    expect(recordedRow('r2_orphan_incomplete')?.context).toMatchObject({ phase: 'deadline' })
  })
})

// ---------------------------------------------------------------------------
// row-check batch loop 先頭の deadline check(round 5・class ①)
//
// 1 batch 目完了後・2 batch 目開始前に予算が尽きるケース。「次 batch を開始しない」
// (新しい I/O を始めない)だけでなく、**1 batch 目で確定していた部分結果
// (rowSkipped/rowlessKeys)も一切反映されない**ことが最重要 — 反映は batch loop を
// 完走してから初めて行う all-or-nothing 契約(round 2)を、deadline 経路でも壊さない。
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — row-check batch loop 先頭の deadline check(round 5)', () => {
  it('501 件(2 batch)で 1 batch 目完了後に予算が尽きたら、2 batch 目を発行せず部分結果も反映しない', async () => {
    rowCheckCostMs = 4_000
    const entries = Array.from({ length: 501 }, (_, i) =>
      aged(orphanKey(USER_A, i + 1), CANDIDATE_AGE),
    )
    listing(entries)
    // 1 batch 目(500 件)のうち 2 件は行あり — もし部分結果が漏れると
    // rowSkipped/rowless がここから非 0 になってしまう(漏れの検出力)。
    setRowCheckRows(USER_A, [
      { objectKey: orphanKey(USER_A, 1) },
      { objectKey: orphanKey(USER_A, 2) },
    ])

    // workDeadline = deadlineAt(+15s) - TAIL_RESERVE(10s) = +5s。1 batch 目の
    // row-check で 4s 消費 → slice = 1s < MIN_SLICE(2s)。2 batch 目の loop 先頭
    // check がここで検知し、2 batch 目の withTenantTx は発行されない。
    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    // ① row-check 呼び出しがちょうど 1 回(2 batch 目が発行されない)。
    const rowCheckCalls = calls.filter((c) => c.startsWith(`rowcheck:${USER_A}`))
    expect(rowCheckCalls).toHaveLength(1)
    // ② 部分結果が漏れていない(1 batch 目の 2 件・498 件も一切反映されない)。
    expect(summary.rowSkipped).toBe(0)
    expect(summary.rowless).toBe(0)
    // ③ DELETE 未発行。
    expect(mockDeleteObject).not.toHaveBeenCalled()
    // ④ phase='deadline' の incomplete 行が書かれる。
    expect(summary.phase).toBe('deadline')
    expect(recordedRow('r2_orphan_incomplete')?.context).toMatchObject({ phase: 'deadline' })
  })
})

// ---------------------------------------------------------------------------
// ⑥ mismatch 記帳 quota
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — pattern mismatch の記帳 quota(⑥)', () => {
  it('mismatch は 5 行で頭打ちになり、超過分は suppressedFailures に載る(実削除失敗の枠は消費しない)', async () => {
    const mismatchKeys = Array.from(
      { length: 6 },
      (_, i) => `users/${USER_A}/not-a-uuid-${i}.webp`,
    )
    listing(mismatchKeys.map((k) => aged(k, CANDIDATE_AGE)))

    const summary = await run()

    expect(summary.patternMismatch).toBe(6)
    expect(mockDeleteObject).not.toHaveBeenCalled()
    const mismatchRows = mockRecordIntegrationFailure.mock.calls.filter(
      (c) => (c[0] as { context: { reason?: string } }).context.reason === 'pattern_mismatch',
    )
    expect(mismatchRows).toHaveLength(5)
    expect(recordedRow('r2_orphan_incomplete')?.context).toMatchObject({ suppressedFailures: 1 })
    // quota 超過だけで打ち切り以外は起きていない(deadline/live_check ではない)。
    expect(summary.phase).toBeNull()
  })

  it('pattern 不一致は DELETE を試行しないまま reason 付きで記帳する', async () => {
    const mismatch = `users/${USER_A}/not-a-uuid.webp`
    listing([aged(mismatch, CANDIDATE_AGE)])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(summary.patternMismatch).toBe(1)
    expect(recordedRow('r2_orphan_delete')?.context).toEqual({
      objectKey: mismatch,
      status: null,
      reason: 'pattern_mismatch',
    })
  })
})

// ---------------------------------------------------------------------------
// ⑦ candidates / rowSkipped / rowless の関係
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — candidates/rowSkipped/rowless の関係(⑦)', () => {
  it('rowless = candidates − rowSkipped − live skip 分', async () => {
    const keyWithRow = orphanKey(USER_A, 1)
    const keyRowlessA1 = orphanKey(USER_A, 2)
    const keyRowlessA2 = orphanKey(USER_A, 3)
    const keyLiveB1 = orphanKey(USER_B, 1)
    const keyLiveB2 = orphanKey(USER_B, 2)
    liveByUser.set(USER_B, { rows: [{ id: 'op-1' }] })
    listing([
      aged(keyWithRow, CANDIDATE_AGE),
      aged(keyRowlessA1, CANDIDATE_AGE),
      aged(keyRowlessA2, CANDIDATE_AGE),
      aged(keyLiveB1, CANDIDATE_AGE),
      aged(keyLiveB2, CANDIDATE_AGE),
    ])
    setRowCheckRows(USER_A, [{ objectKey: keyWithRow }])

    const summary = await run()

    const liveSkipKeyCount = 2 // USER_B の 2 key は live 判定で全 skip(行確認に進まない)
    expect(summary.candidates).toBe(5)
    expect(summary.rowSkipped).toBe(1)
    expect(summary.rowless).toBe(2)
    expect(summary.rowless).toBe(summary.candidates - summary.rowSkipped - liveSkipKeyCount)
    expect(summary.deleted).toBe(2)
    expect(summary.skippedLiveUsers).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 制約: 行不在確認は user_id を明示する(CLAUDE.md 絶対ルール・RLS 下でも query 側に明示)
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — 行不在確認の query 形(規律)', () => {
  it('eq(userId, candidate.userId) と inArray(objectKey, batch) を where に含める', async () => {
    const keyA = orphanKey(USER_A, 1)
    const keyB = orphanKey(USER_A, 2)
    listing([aged(keyA, CANDIDATE_AGE), aged(keyB, CANDIDATE_AGE)])

    await run()

    expect(rowCheckWhereByUser.get(`${USER_A}:2`)).toEqual(
      and(eq(assets.userId, USER_A), inArray(assets.objectKey, [keyA, keyB])),
    )
  })
})


// ---------------------------------------------------------------------------
// 記帳失敗と never-throw
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — 記帳失敗と never-throw', () => {
  it('記帳の throw は後続処理を止めず recordErrors + logger.error に残る', async () => {
    mockRecordIntegrationFailure.mockImplementation(async (a: { key: string }) => {
      calls.push(`record:${a.key}`)
      if (a.key === 'r2_orphan_delete') throw new Error('notifyOps misconfigured')
    })
    mockDeleteObject.mockResolvedValue({ ok: false, status: 500 })
    listing([aged(orphanKey(USER_A, 1), CANDIDATE_AGE)])

    const summary = await run()

    expect(summary.failed).toBe(1)
    expect(summary.recordErrors).toBe(1)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'orphan_scan.record_failed', key: 'r2_orphan_delete' }),
    )
  })

  it('想定外の throw でも lane は throw せず summary.error(String(err) のみ)に畳む', async () => {
    mockDeleteObject.mockRejectedValue(new Error('boom'))
    listing([aged(orphanKey(USER_A, 1), CANDIDATE_AGE)])

    const summary = await run()

    expect(summary.error).toBe('Error: boom')
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'orphan_scan.failed' }),
    )
  })

  it('DELETE の 404 は成功系として deleted に計上し失敗行を書かない', async () => {
    mockDeleteObject.mockImplementation(async (objectKey: string) => {
      calls.push(`delete:${objectKey}`)
      return { ok: true, status: 404 }
    })
    listing([aged(orphanKey(USER_A, 1), CANDIDATE_AGE)])

    const summary = await run()

    expect(summary.deleted).toBe(1)
    expect(summary.failed).toBe(0)
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// summary の集約(readback)
// ---------------------------------------------------------------------------
describe('runOrphanScanLane — summary', () => {
  it('listing が空なら全カウント 0 の summary を返す', async () => {
    const summary = await run()
    expect(summary).toEqual({
      lane: 'asset_orphan_scan',
      listed: 0,
      candidates: 0,
      rowSkipped: 0,
      rowless: 0,
      deleted: 0,
      failed: 0,
      skippedLiveUsers: 0,
      patternMismatch: 0,
      truncated: false,
      phase: null,
      recordErrors: 0,
    })
  })
})
