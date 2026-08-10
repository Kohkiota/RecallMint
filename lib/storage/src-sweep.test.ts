import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'

import { uploadOperations } from '@/lib/db/schema'
import { isLiveUploadOperationCondition } from '@/lib/exams/source-doc-status'
import {
  selectSweepTargets,
  runSrcSweepLane,
  SWEEP_CUTOFF_MS,
  ALERT_AGE_MS,
} from './src-sweep'
import type { R2ObjectMeta } from './r2'

// 選定 pure 関数の test(②-4b spec §3.2/§3.3/§3.6・完了条件 ①〜④)。
// I/O なし(mock 不要) — entries を直接組み立てて渡すだけ。
// lane orchestration(Task 4)の test は file 後半(全 I/O mock + 時刻注入)。

// ---------------------------------------------------------------------------
// mock 群(vi.mock は file 全体に効くため import 直後に置く。実際に効くのは lane
// 節だけで、選定 pure 関数の節は I/O を一切踏まない)。
//
// timeout 定数(LIST_TIMEOUT_MS / DELETE_TIMEOUT_MS)は importOriginal で実物を残す —
// 写すと r2.ts 側が変わったときに予算計算の pin が silent に古い値を見る。
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

const NOW_MS = Date.UTC(2026, 7, 9, 12, 0, 0) // 2026-08-09T12:00:00Z(固定 now)

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_A = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'
const FILE_A = 'cccccccc-cccc-4ccc-accc-cccccccccccc'
const KEY_A = `src/${USER_A}/${SESSION_A}/${FILE_A}.pdf`

const USER_B = 'dddddddd-dddd-4ddd-bddd-dddddddddddd'
const SESSION_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const FILE_B = 'ffffffff-ffff-4fff-9fff-ffffffffffff'
const KEY_B = `src/${USER_B}/${SESSION_B}/${FILE_B}.pdf`

function meta(key: string, lastModifiedMs: number): R2ObjectMeta {
  return { key, lastModifiedMs }
}

describe('selectSweepTargets — cutoff boundary (① age > cutoff, `>` 比較)', () => {
  it('age === cutoffMs ちょうどは候補外(patternMismatch にも入らない)', () => {
    const entries = [meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates).toEqual([])
    expect(result.patternMismatch).toEqual([])
  })

  it('age === cutoffMs + 1ms は候補になる', () => {
    const entries = [meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS - 1)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates).toEqual([
      { userId: USER_A, keys: [KEY_A], oldestMs: NOW_MS - SWEEP_CUTOFF_MS - 1 },
    ])
  })

  it('age === cutoffMs - 1ms(まだ新しい)は候補外', () => {
    const entries = [meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS + 1)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates).toEqual([])
  })
})

describe('selectSweepTargets — pattern 不一致の分離(②)', () => {
  const oldMs = NOW_MS - SWEEP_CUTOFF_MS - 1 // 全 case で「age は十分古い」を固定し、判定差は key 形のみにする

  it('大文字 uuid は一致する(A6・正例)', () => {
    const upperUserId = USER_A.toUpperCase()
    const upperKey = `src/${upperUserId}/${SESSION_A.toUpperCase()}/${FILE_A.toUpperCase()}.pdf`
    const result = selectSweepTargets([meta(upperKey, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([])
    expect(result.candidates).toEqual([{ userId: upperUserId, keys: [upperKey], oldestMs: oldMs }])
  })

  it('.PDF(大文字拡張子)は不一致', () => {
    const key = `src/${USER_A}/${SESSION_A}/${FILE_A}.PDF`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
    expect(result.candidates).toEqual([])
  })

  it('セグメント欠落(2 個)は不一致', () => {
    const key = `src/${USER_A}/${FILE_A}.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })

  it('セグメント過多(4 個)は不一致', () => {
    const key = `src/${USER_A}/${SESSION_A}/${FILE_A}/extra.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })

  it('旧経路 users/{uuid}/src/... は不一致', () => {
    const key = `users/${USER_A}/src/${SESSION_A}/${FILE_A}.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })

  it('uuid 非形式(桁数違い)は不一致', () => {
    const key = `src/${USER_A}/${SESSION_A}/not-a-uuid.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })

  it('prefix が src/ でない場合は不一致', () => {
    const key = `other/${USER_A}/${SESSION_A}/${FILE_A}.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })
})

describe('selectSweepTargets — user 別グルーピング + oldest 昇順(③)', () => {
  it('同一 user 内は keys にまとめ、oldestMs = 最古の lastModifiedMs', () => {
    const session2 = '12121212-1212-4121-8121-121212121212'
    const file2 = '13131313-1313-4131-8131-131313131313'
    const key2 = `src/${USER_A}/${session2}/${file2}.pdf`
    const oldestMs = NOW_MS - SWEEP_CUTOFF_MS - 5000
    const entries = [
      meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS - 1), // 新しい方
      meta(key2, oldestMs), // 古い方
    ]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates).toEqual([
      { userId: USER_A, keys: [KEY_A, key2], oldestMs },
    ])
  })

  it('複数 user は oldestMs 昇順(最古候補を持つ user が先)', () => {
    const entries = [
      meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS - 1_000), // user A: cutoff+1000ms 前 = 新しめ
      meta(KEY_B, NOW_MS - SWEEP_CUTOFF_MS - 9_000), // user B: cutoff+9000ms 前 = より古い
    ]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates.map((c) => c.userId)).toEqual([USER_B, USER_A])
  })
})

describe('selectSweepTargets — overdue(④)', () => {
  it('age === ALERT_AGE_MS ちょうどは overdue でない', () => {
    const entries = [meta(KEY_A, NOW_MS - ALERT_AGE_MS)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).toBeNull()
  })

  it('age === ALERT_AGE_MS + 1ms は overdue', () => {
    const entries = [meta(KEY_A, NOW_MS - ALERT_AGE_MS - 1)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).not.toBeNull()
    expect(result.overdue?.count).toBe(1)
    expect(result.overdue?.oldestKey).toBe(KEY_A)
  })

  it('0 件で null', () => {
    const entries = [meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS - 1)] // candidate だが overdue ではない
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).toBeNull()
  })

  it('複数 overdue object から oldest を選定(count・oldestKey・oldestAgeHours)', () => {
    const olderMs = NOW_MS - ALERT_AGE_MS - 60 * 60 * 1000 // 73h 前
    const newerOverdueMs = NOW_MS - ALERT_AGE_MS - 1_000 // 72h ちょっと前
    const entries = [meta(KEY_A, newerOverdueMs), meta(KEY_B, olderMs)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).toEqual({
      count: 2,
      oldestKey: KEY_B,
      oldestAgeHours: 73,
    })
  })

  it('pattern 不一致 key も overdue 判定の対象(listing snapshot 全体を見る)', () => {
    const mismatchKey = `other/${USER_A}/${SESSION_A}/${FILE_A}.pdf`
    const entries = [meta(mismatchKey, NOW_MS - ALERT_AGE_MS - 1)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).toEqual({ count: 1, oldestKey: mismatchKey, oldestAgeHours: 72 })
  })

  it('cutoffMs を 15min に縮めても overdue 判定は不変(ALERT_AGE_MS 固定)', () => {
    const entries = [meta(KEY_A, NOW_MS - ALERT_AGE_MS - 1)]
    const defaultCutoffResult = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    const overrideCutoffResult = selectSweepTargets(entries, NOW_MS, 15 * 60 * 1000)
    expect(overrideCutoffResult.overdue).toEqual(defaultCutoffResult.overdue)
  })

  it('15min override 下でも 72h 未満の object は overdue にならない(閾値が cutoffMs へ横滑りしていないことの pin)', () => {
    // age = 2h: 既定 cutoff(6h)未満・15min override 超 — もし overdue 閾値が
    // ALERT_AGE_MS でなく cutoffMs 由来に化けていたら、override 側だけ
    // overdue が立ってしまう(non-null)。ALERT_AGE_MS(72h)には遠く及ばないため
    // 両方とも null が正しい。
    const entries = [meta(KEY_A, NOW_MS - 2 * 60 * 60 * 1000)]
    const defaultCutoffResult = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    const overrideCutoffResult = selectSweepTargets(entries, NOW_MS, 15 * 60 * 1000)
    expect(defaultCutoffResult.overdue).toBeNull()
    expect(overrideCutoffResult.overdue).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// lane orchestration(Task 4・spec §3.3/§3.4/§3.5 + 不変条件 3〜6/9)
//
// 全 I/O(R2 listing / DELETE / DB live 判定 / 台帳記帳 / logger)を mock し、
// 時刻は `now: () => number` 注入で制御する(実 sleep なし)。経過時間は
// `deleteCostMs`(DELETE 1 回あたりの進み)で作る。
// ---------------------------------------------------------------------------

const USER_C = '11111111-1111-4111-8111-111111111111'

// live 判定の応答。既定 = live なし(rows 空)。
type LiveResult = { rows: { id: string }[] } | { error: Error }

let clock = NOW_MS
const injectedNow = () => clock
let liveByUser: Map<string, LiveResult>
let liveWhereByUser: Map<string, unknown>
let calls: string[] // spy 横断の呼び出し順(順序 pin 用)
let deleteCostMs: number
let recordCostMs: number // 記帳 1 本あたりの経過(notifyOps の fetch 待ちに相当)

// live 判定 query が組まれる形(select→from→where→limit)だけを受ける軽量 tx。
// where 条件を捕まえて owner-scope(user_id 明示)を pin できるようにする。
function fakeTx(userId: string, rows: { id: string }[]) {
  return {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          liveWhereByUser.set(userId, cond)
          return { limit: async () => rows }
        },
      }),
    }),
  }
}

beforeEach(() => {
  clock = NOW_MS
  liveByUser = new Map()
  liveWhereByUser = new Map()
  calls = []
  deleteCostMs = 0
  recordCostMs = 0
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
      calls.push(`live:${userId}`)
      const result = liveByUser.get(userId) ?? { rows: [] }
      if ('error' in result) throw result.error
      return fn(fakeTx(userId, result.rows))
    },
  )
})

// 規約一致 key(user ごとに fileId だけ変える)。
function srcKey(userId: string, n: number): string {
  const fileId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  return `src/${userId}/${SESSION_A}/${fileId}.pdf`
}
function aged(key: string, ageMs: number): R2ObjectMeta {
  return { key, lastModifiedMs: NOW_MS - ageMs }
}
function listing(entries: R2ObjectMeta[], truncated = false) {
  mockListObjectsWithMetaBounded.mockResolvedValue({ entries, truncated })
}
function recordedKeys(): string[] {
  return mockRecordIntegrationFailure.mock.calls.map((c) => (c[0] as { key: string }).key)
}
function recordedRow(key: string): Record<string, unknown> | undefined {
  const call = mockRecordIntegrationFailure.mock.calls.find(
    (c) => (c[0] as { key: string }).key === key,
  )
  return call?.[0] as Record<string, unknown> | undefined
}

const CANDIDATE_AGE = SWEEP_CUTOFF_MS + 60_000 // cutoff 超(候補)
const OVERDUE_AGE = ALERT_AGE_MS + 60_000 // 72h 超(候補 かつ overdue)
// 十分に広い予算(打ち切りが起きない run 用)。
const WIDE_DEADLINE = new Date(NOW_MS + 300_000)

function run(overrides: Partial<Parameters<typeof runSrcSweepLane>[0]> = {}) {
  return runSrcSweepLane({
    deadlineAt: WIDE_DEADLINE,
    cutoffMs: SWEEP_CUTOFF_MS,
    now: injectedNow,
    ...overrides,
  })
}

describe('runSrcSweepLane — 順序(不変条件 3/4)', () => {
  it('overdue 記帳 → live check → DELETE の順に進む', async () => {
    const key = srcKey(USER_A, 1)
    listing([aged(key, OVERDUE_AGE)])

    await run()

    // overdue は「DELETE が成功しても消えない事実」ゆえ削除前に、live 判定は
    // 「その user の DELETE batch 直前」ゆえ DELETE の直前に来る。
    expect(calls).toEqual(['record:r2_sweep_overdue', `live:${USER_A}`, `delete:${key}`])
  })

  it('live check と DELETE は user ごとに交互に走る(一括前倒しではない)', async () => {
    // spec §3.3 が bound している TOCTOU 窓は「判定 → その user の DELETE」の数秒。
    // 全 user 分の live check を先に一括評価する形にすると、窓が listing + delete
    // pass 全体へ広がる(判定は正しいまま残るので count 系の assert では検出できない)。
    // live でない user を 2 人並べ、完全な交互実行そのものを pin する。
    const keyA = srcKey(USER_A, 1)
    const keyB = srcKey(USER_B, 1)
    listing([
      aged(keyA, CANDIDATE_AGE + 10_000), // A が古い = 先
      aged(keyB, CANDIDATE_AGE),
    ])

    await run()

    expect(calls).toEqual([
      `live:${USER_A}`,
      `delete:${keyA}`,
      `live:${USER_B}`,
      `delete:${keyB}`,
    ])
  })

  it('live 判定は user_id 条件を明示する(RLS 下でも query で絞る)', async () => {
    listing([aged(srcKey(USER_A, 1), CANDIDATE_AGE)])

    await run()

    expect(liveWhereByUser.get(USER_A)).toEqual(
      and(eq(uploadOperations.userId, USER_A), isLiveUploadOperationCondition()),
    )
  })
})

describe('runSrcSweepLane — live-op 除外(不変条件 3)', () => {
  it('live な user の候補は全て今回 skip する(DELETE を撃たない・繰延なので台帳も書かない)', async () => {
    liveByUser.set(USER_A, { rows: [{ id: 'op-1' }] })
    listing([aged(srcKey(USER_A, 1), CANDIDATE_AGE), aged(srcKey(USER_A, 2), CANDIDATE_AGE)])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(summary.skippedLiveUsers).toBe(1)
    expect(summary.deleted).toBe(0)
    expect(summary.candidates).toBe(2)
    // live による繰延は正常運転(翌日再考)— incomplete 行 = Discord 通知を鳴らさない。
    expect(summary.phase).toBeNull()
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
  })

  it('live 判定が失敗したら skip に倒し phase live_check を立てる(fail-safe)', async () => {
    liveByUser.set(USER_A, { error: new Error('db down') })
    listing([aged(srcKey(USER_A, 1), CANDIDATE_AGE)])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(summary.skippedLiveUsers).toBe(1)
    expect(summary.phase).toBe('live_check')
    expect(recordedRow('r2_sweep_incomplete')?.context).toMatchObject({
      phase: 'live_check',
      deleteRequested: 0,
      remaining: 1,
    })
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'src_sweep.live_check_failed' }),
    )
  })

  it('live な user を skip しても他 user の DELETE は進む', async () => {
    liveByUser.set(USER_A, { rows: [{ id: 'op-1' }] })
    const keyB = srcKey(USER_B, 1)
    listing([
      aged(srcKey(USER_A, 1), CANDIDATE_AGE + 10_000), // A の方が古い = 先に評価される
      aged(keyB, CANDIDATE_AGE),
    ])

    const summary = await run()

    expect(calls).toEqual([`live:${USER_A}`, `live:${USER_B}`, `delete:${keyB}`])
    expect(summary.deleted).toBe(1)
    expect(summary.skippedLiveUsers).toBe(1)
  })
})

describe('runSrcSweepLane — 予算と phase(不変条件 9 以外の §3.4)', () => {
  it('残 slice が MIN_SLICE 未満になったら打ち切り、最古 user から処理する', async () => {
    deleteCostMs = 2_000
    // workDeadline = deadlineAt - TAIL_RESERVE(10s) → 開始時 slice = 5s。
    // DELETE 1 回 2s ゆえ 2 user 目までで slice 1s < MIN_SLICE(2s) → 3 user 目で打ち切り。
    const keyOldest = srcKey(USER_C, 1)
    const keyMiddle = srcKey(USER_A, 1)
    const keyNewest = srcKey(USER_B, 1)
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
    expect(summary.phase).toBe('deadline')
    expect(recordedRow('r2_sweep_incomplete')?.context).toEqual({
      phase: 'deadline',
      listed: 3,
      deleteRequested: 2,
      remaining: 1,
    })
  })

  it('phase は配列順で優先される(list_truncated が deadline に勝つ)', async () => {
    deleteCostMs = 4_000
    listing(
      [
        aged(srcKey(USER_A, 1), CANDIDATE_AGE + 10_000),
        aged(srcKey(USER_B, 1), CANDIDATE_AGE),
      ],
      true,
    )

    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    expect(summary.truncated).toBe(true)
    expect(summary.deleted).toBe(1) // 2 user 目は打ち切り = deadline も該当している
    expect(summary.phase).toBe('list_truncated')
  })

  it('phase は配列順で優先される(live_check が deadline に勝つ)', async () => {
    deleteCostMs = 4_000
    liveByUser.set(USER_A, { error: new Error('db down') })
    listing([
      aged(srcKey(USER_A, 1), CANDIDATE_AGE + 20_000),
      aged(srcKey(USER_B, 1), CANDIDATE_AGE + 10_000),
      aged(srcKey(USER_C, 1), CANDIDATE_AGE),
    ])

    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    expect(summary.skippedLiveUsers).toBe(1)
    expect(summary.deleted).toBe(1)
    expect(summary.phase).toBe('live_check')
  })

  it('listing の timeoutMs は 1 page ぶん(残 slice ÷ page 上限)・DELETE は残 slice で cap', async () => {
    const key = srcKey(USER_A, 1)
    listing([aged(key, CANDIDATE_AGE)])

    // 開始時 slice = 15s - TAIL_RESERVE(10s) = 5s。
    await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    // 5s をそのまま渡すと 10 page で最悪 50s = 予算の 10 倍(②-4b §2 の実障害)。
    expect(mockListObjectsWithMetaBounded).toHaveBeenCalledWith('src/', 10, {
      timeoutMs: 500,
    })
    expect(mockDeleteObject).toHaveBeenCalledWith(key, { timeoutMs: 5_000 })
  })

  it('chunk 内の記帳でも残予算を見る(tail reserve を食い潰さない)', async () => {
    // 記帳は 1 本ずつ notifyOps の fetch(3s abort)を待つ。chunk 境界の check だけだと
    // chunk 内の最大 20 本が無防備になり、incomplete 行を書く前に予算が尽きる。
    recordCostMs = 2_000
    mockDeleteObject.mockImplementation(async (objectKey: string) => {
      calls.push(`delete:${objectKey}`)
      return { ok: false, status: 500 }
    })
    listing([
      aged(srcKey(USER_A, 1), CANDIDATE_AGE),
      aged(srcKey(USER_A, 2), CANDIDATE_AGE),
      aged(srcKey(USER_A, 3), CANDIDATE_AGE),
    ])

    // 開始時 slice = 5s。記帳 2 本で残 1s < MIN_SLICE(2s) → 3 本目は書かずに落とす。
    const summary = await run({ deadlineAt: new Date(NOW_MS + 15_000) })

    expect(summary.failed).toBe(3)
    expect(recordedKeys().filter((k) => k === 'r2_sweep_delete')).toHaveLength(2)
    expect(summary.phase).toBe('deadline')
    expect(recordedRow('r2_sweep_incomplete')?.context).toMatchObject({
      phase: 'deadline',
      suppressedFailures: 1,
    })
  })

  it('listing の throw は phase list + errorMessage に畳み、削除は走らない', async () => {
    mockListObjectsWithMetaBounded.mockRejectedValue(new Error('listObjects failed: status=500'))

    const summary = await run()

    expect(summary.listed).toBe(0)
    expect(summary.phase).toBe('list')
    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(recordedRow('r2_sweep_incomplete')?.errorMessage).toBe(
      'Error: listObjects failed: status=500',
    )
  })
})

describe('runSrcSweepLane — 台帳 quota(不変条件 9)', () => {
  it('実削除失敗は 20 行で頭打ちになり、超過分は suppressedFailures に載る', async () => {
    mockDeleteObject.mockImplementation(async (objectKey: string) => {
      calls.push(`delete:${objectKey}`)
      return { ok: false, status: 500 }
    })
    listing(Array.from({ length: 21 }, (_, i) => aged(srcKey(USER_A, i + 1), OVERDUE_AGE)))

    const summary = await run()

    expect(summary.failed).toBe(21)
    expect(recordedKeys().filter((k) => k === 'r2_sweep_delete')).toHaveLength(20)
    // quota で落ちても overdue / incomplete は書かれる(枠外)
    expect(recordedKeys()).toContain('r2_sweep_overdue')
    expect(recordedRow('r2_sweep_incomplete')?.context).toMatchObject({
      suppressedFailures: 1,
      deleteRequested: 21,
      remaining: 0,
    })
    // 打ち切りは起きていない(quota 超過だけで incomplete 行が出る)
    expect(summary.phase).toBeNull()
  })

  it('pattern 不一致は 5 行で頭打ちになり、実削除失敗の 20 枠を消費しない', async () => {
    mockDeleteObject.mockImplementation(async (objectKey: string) => {
      calls.push(`delete:${objectKey}`)
      return { ok: false, status: 500 }
    })
    listing([
      ...Array.from({ length: 21 }, (_, i) => aged(srcKey(USER_A, i + 1), CANDIDATE_AGE)),
      ...Array.from({ length: 6 }, (_, i) =>
        aged(`src/${USER_A}/${SESSION_A}/not-a-uuid-${i}.pdf`, CANDIDATE_AGE),
      ),
    ])

    const summary = await run()

    expect(summary.patternMismatch).toBe(6)
    const mismatchRows = mockRecordIntegrationFailure.mock.calls.filter(
      (c) =>
        (c[0] as { context: { reason?: string } }).context.reason === 'pattern_mismatch',
    )
    expect(mismatchRows).toHaveLength(5)
    expect(recordedKeys().filter((k) => k === 'r2_sweep_delete')).toHaveLength(25) // 5 mismatch + 20 実失敗
    expect(recordedRow('r2_sweep_incomplete')?.context).toMatchObject({
      suppressedFailures: 2, // mismatch 1 + 実失敗 1
    })
  })

  it('pattern 不一致は DELETE を試行しないまま reason 付きで記帳する', async () => {
    const mismatch = `src/${USER_A}/${SESSION_A}/not-a-uuid.pdf`
    listing([aged(mismatch, CANDIDATE_AGE)])

    const summary = await run()

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(summary.patternMismatch).toBe(1)
    expect(recordedRow('r2_sweep_delete')?.context).toEqual({
      objectKey: mismatch,
      status: null,
      reason: 'pattern_mismatch',
    })
  })
})

describe('runSrcSweepLane — 記帳失敗と never-throw(不変条件 5/6)', () => {
  it('記帳の throw は後続 DELETE を止めず recordErrors + logger.error に残る', async () => {
    mockRecordIntegrationFailure.mockImplementation(async (args: { key: string }) => {
      calls.push(`record:${args.key}`)
      if (args.key === 'r2_sweep_overdue') throw new Error('notifyOps misconfigured')
    })
    const key = srcKey(USER_A, 1)
    listing([aged(key, OVERDUE_AGE)])

    const summary = await run()

    expect(calls).toEqual(['record:r2_sweep_overdue', `live:${USER_A}`, `delete:${key}`])
    expect(summary.deleted).toBe(1)
    expect(summary.recordErrors).toBe(1)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'src_sweep.record_failed', key: 'r2_sweep_overdue' }),
    )
  })

  it('想定外の throw でも lane は throw せず summary.error(String(err) のみ)に畳む', async () => {
    mockDeleteObject.mockRejectedValue(new Error('boom'))
    listing([aged(srcKey(USER_A, 1), CANDIDATE_AGE)])

    const summary = await run()

    expect(summary.error).toBe('Error: boom')
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'src_sweep.failed' }),
    )
  })
})

describe('runSrcSweepLane — summary(§3.1 readback)', () => {
  it('DELETE の 404 は成功系として deleted に計上し失敗行を書かない', async () => {
    mockDeleteObject.mockImplementation(async (objectKey: string) => {
      calls.push(`delete:${objectKey}`)
      return { ok: true, status: 404 }
    })
    listing([aged(srcKey(USER_A, 1), CANDIDATE_AGE)])

    const summary = await run()

    expect(summary.deleted).toBe(1)
    expect(summary.failed).toBe(0)
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
  })

  it('各カウントを集計し cutoffOverrideMinutes を透過する', async () => {
    let call = 0
    mockDeleteObject.mockImplementation(async (objectKey: string) => {
      calls.push(`delete:${objectKey}`)
      call += 1
      return call === 1 ? { ok: true, status: 204 } : { ok: false, status: 500 }
    })
    liveByUser.set(USER_C, { rows: [{ id: 'op-1' }] })
    listing(
      [
        aged(srcKey(USER_A, 1), OVERDUE_AGE), // 候補 かつ overdue(最古 = 先頭)
        aged(srcKey(USER_A, 2), CANDIDATE_AGE),
        aged(srcKey(USER_C, 1), CANDIDATE_AGE),
        aged(`src/${USER_A}/${SESSION_A}/not-a-uuid.pdf`, CANDIDATE_AGE),
        aged(srcKey(USER_B, 1), 60_000), // cutoff 未満 = 候補外
      ],
      true,
    )

    const summary = await run({ cutoffOverrideMinutes: 15 })

    expect(summary).toEqual({
      lane: 'src_sweep',
      listed: 5,
      candidates: 3,
      deleted: 1,
      failed: 1,
      skippedLiveUsers: 1,
      patternMismatch: 1,
      overdueCount: 1,
      truncated: true,
      phase: 'list_truncated',
      recordErrors: 0,
      cutoffOverrideMinutes: 15,
    })
  })

  it('overdue 行は listing 上限で打ち切った run かどうかを partial で明示する', async () => {
    listing([aged(srcKey(USER_A, 1), OVERDUE_AGE)], true)

    await run()

    expect(recordedRow('r2_sweep_overdue')?.context).toEqual({
      count: 1,
      oldestKey: srcKey(USER_A, 1),
      oldestAgeHours: 72,
      partial: true,
    })
  })

  it('overdue が無い run では overdue 行を書かない', async () => {
    listing([aged(srcKey(USER_A, 1), CANDIDATE_AGE)])

    const summary = await run()

    expect(summary.overdueCount).toBe(0)
    expect(recordedKeys()).not.toContain('r2_sweep_overdue')
  })
})

// ---------------------------------------------------------------------------
// cron route(Task 5)の maxDuration drift pin
// ---------------------------------------------------------------------------
// route.ts を import せず readFileSync + regex で読む理由: route segment config は
// 静的解析される literal で、値そのものを読むのが素直(既存 precedent =
// app/(app)/app/upload/_actions/submit-upload.test.ts の maxDuration pin)。
// 「予算(lane 予算)が maxDuration より短い」という**関係式**の pin は、asset レーン
// 整合 sprint Task 7 で lane 予算が単一定数(`SWEEP_BUDGET_MS`)から 3 lane 分割後の
// per-lane offset に変わったことに伴い app/api/cron/sweep/route.test.ts 側へ移設した
// (offset の正本が route.ts にあるため・2026-08-10)。ここに残るのは maxDuration の
// 行そのものの存在・値の pin のみ。
describe('/api/cron/sweep route.ts の maxDuration', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '../../app/api/cron/sweep/route.ts'),
    'utf8',
  )
  const matched = source.match(/^export const maxDuration = (\d+)$/m)

  it('export const maxDuration の行が存在する', () => {
    // 行が消えると function は Vercel Dashboard の Function Max Duration(既定値)へ
    // 黙って戻る。値の不一致と同格の失敗として扱う。
    expect(matched).not.toBeNull()
  })

  it('値が 300 である', () => {
    expect(matched).not.toBeNull()
    expect(Number(matched![1])).toBe(300)
  })
})
