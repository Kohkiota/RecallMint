import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runBackfill, type BackfillDeps } from './backfill-clerk-metadata'

function makeDeps(
  overrides: Partial<BackfillDeps> = {},
): BackfillDeps & {
  fetchUsersMock: ReturnType<typeof vi.fn>
  syncMock: ReturnType<typeof vi.fn>
  sleepMock: ReturnType<typeof vi.fn>
  logMock: ReturnType<typeof vi.fn>
} {
  const fetchUsersMock = vi.fn().mockResolvedValue([])
  const syncMock = vi.fn().mockResolvedValue({ ok: true })
  const sleepMock = vi.fn().mockResolvedValue(undefined)
  const logMock = vi.fn()
  return {
    fetchUsers: fetchUsersMock,
    sync: syncMock,
    sleep: sleepMock,
    log: logMock,
    fetchUsersMock,
    syncMock,
    sleepMock,
    logMock,
    ...overrides,
  }
}

function mkRow(i: number) {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    clerkId: `user_${i}`,
    plan: 'free' as const,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runBackfill', () => {
  it('users 0 件: sync 呼出ゼロ + total/success/failed すべて 0', async () => {
    const deps = makeDeps()
    const result = await runBackfill({ dryRun: false }, deps)
    expect(result).toEqual({
      total: 0,
      success: 0,
      failed: 0,
      failedUsers: [],
    })
    expect(deps.syncMock).not.toHaveBeenCalled()
    expect(deps.sleepMock).not.toHaveBeenCalled()
  })

  it('dryRun=true: 全 user に対し sync は呼ばずに log のみ出力、 success カウント', async () => {
    const rows = [mkRow(1), mkRow(2), mkRow(3)]
    const deps = makeDeps()
    deps.fetchUsersMock.mockResolvedValueOnce(rows)

    const result = await runBackfill({ dryRun: true }, deps)
    expect(deps.syncMock).not.toHaveBeenCalled()
    expect(result.total).toBe(3)
    expect(result.success).toBe(3)
    expect(result.failed).toBe(0)
    // sleep は dry-run でも chunk 境界で呼ぶか / 呼ばないかは現実装次第。
    // 「実際の書込みをせず」 が spec、 sleep は API rate limit のための仕組み
    // なので skip しても問題なし。
  })

  it('apply path: 各 user に sync を 1 回呼出、 success カウント', async () => {
    const rows = [mkRow(1), mkRow(2)]
    const deps = makeDeps()
    deps.fetchUsersMock.mockResolvedValueOnce(rows)

    const result = await runBackfill({ dryRun: false }, deps)
    expect(deps.syncMock).toHaveBeenCalledTimes(2)
    expect(deps.syncMock).toHaveBeenCalledWith({
      clerkId: 'user_1',
      dbUserId: rows[0]!.id,
      plan: 'free',
    })
    expect(deps.syncMock).toHaveBeenCalledWith({
      clerkId: 'user_2',
      dbUserId: rows[1]!.id,
      plan: 'free',
    })
    expect(result.success).toBe(2)
    expect(result.failed).toBe(0)
  })

  it('chunkSize=10 / chunk 境界で sleep が呼ばれる (12 user で chunk 1 (10) → sleep → chunk 2 (2))', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => mkRow(i + 1))
    const deps = makeDeps()
    deps.fetchUsersMock.mockResolvedValueOnce(rows)

    await runBackfill(
      { dryRun: false, chunkSize: 10, sleepMs: 500 },
      deps,
    )
    expect(deps.syncMock).toHaveBeenCalledTimes(12)
    // 1 chunk 終了後に 1 回 sleep。 最終 chunk 後は sleep 不要 (next chunk が無い)。
    expect(deps.sleepMock).toHaveBeenCalledTimes(1)
    expect(deps.sleepMock).toHaveBeenCalledWith(500)
  })

  it('apply 中の sync 失敗: failed カウント + failedUsers に追加、 残 user は処理継続', async () => {
    const rows = [mkRow(1), mkRow(2), mkRow(3)]
    const deps = makeDeps()
    deps.fetchUsersMock.mockResolvedValueOnce(rows)
    // user_2 のみ失敗
    deps.syncMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true })

    const result = await runBackfill({ dryRun: false }, deps)
    expect(result.total).toBe(3)
    expect(result.success).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.failedUsers).toEqual([{ clerkId: 'user_2' }])
  })

  it('冪等性: 同 input で 2 回実行しても結果が一致 (sync は単に再呼出、 fetchUsers の戻りが同じなら同じ result)', async () => {
    const rows = [mkRow(1), mkRow(2)]
    const deps = makeDeps()
    deps.fetchUsersMock.mockResolvedValue(rows) // 毎回同じ

    const r1 = await runBackfill({ dryRun: false }, deps)
    const r2 = await runBackfill({ dryRun: false }, deps)
    expect(r1).toEqual(r2)
    expect(deps.syncMock).toHaveBeenCalledTimes(4) // 2 user × 2 run
  })
})
