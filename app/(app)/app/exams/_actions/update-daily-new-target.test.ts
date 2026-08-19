import { describe, it, expect, vi, beforeEach } from 'vitest'

// updateDailyNewTarget server action の test (Dash-1 Home v1 spec §8.1)。
// auth / zod 境界 (0..999 整数 + null) / owner-scope WHERE / 「UPDATE は
// daily_new_target 列のみ」/ 0 行更新 (他 owner) → failure / DB throw → failure +
// P0RLS alert を検証。 rename-exam.test.ts と同型の mock 構成。
//
// 0 は明示値であり null (既定追従) とは別 — `??` 前提の契約が `||` に化けていないかを
// 「setValues.dailyNewTarget を strict に 0 と比較する」形で pin する (falsy 実装だと
// この assertion が通らない)。

const {
  mockGetCurrentUser,
  mockReportRlsContextFailure,
  dbState,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockReportRlsContextFailure: vi.fn(async () => {}),
  dbState: {
    updateTables: [] as unknown[],
    setValues: null as Record<string, unknown> | null,
    whereArgs: [] as unknown[][],
    returningRows: [] as Record<string, unknown>[],
    throwOnReturning: false,
  },
}))

// drizzle-orm の eq をスパイ化 (実装は real のまま)。 WHERE から
// eq(exams.userId, user.id) が消える regression を検出するため
// (「他 owner の exam を更新できない」の根拠を型でなく実際の SQL WHERE で確認する)。
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  const spyEq = vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args))
  return { ...real, eq: spyEq }
})

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/db/report-rls-context-failure', () => ({
  reportRlsContextFailure: mockReportRlsContextFailure,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/db', () => {
  function updateChain(table: unknown) {
    dbState.updateTables.push(table)
    const obj: Record<string, unknown> = {}
    obj.set = (vals: Record<string, unknown>) => {
      dbState.setValues = vals
      return obj
    }
    obj.where = (...args: unknown[]) => {
      dbState.whereArgs.push(args)
      return obj
    }
    obj.returning = () => {
      if (dbState.throwOnReturning) {
        return Promise.reject(new Error('db boom'))
      }
      return Promise.resolve(dbState.returningRows)
    }
    return obj
  }
  return {
    getDb: () => ({ update: updateChain }),
  }
})

// create-exam.test.ts / rename-exam.test.ts と同じ passthrough (unit test では実 tx を張らない)。
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: async (_userId: string, fn: (tx: unknown) => unknown) => {
    const { getDb } = await import('@/lib/db')
    return fn(getDb())
  },
}))

async function importAction() {
  return await import('./update-daily-new-target')
}

beforeEach(async () => {
  mockGetCurrentUser.mockReset()
  mockReportRlsContextFailure.mockClear()
  dbState.updateTables = []
  dbState.setValues = null
  dbState.whereArgs = []
  dbState.returningRows = [{ id: 'exam-uuid' }]
  dbState.throwOnReturning = false
  const { eq } = await import('drizzle-orm')
  vi.mocked(eq).mockClear()
  mockGetCurrentUser.mockResolvedValue({
    id: 'user-uuid',
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
})

describe('updateDailyNewTarget', () => {
  it('auth fail → { ok:false, 認証が必要です }, no UPDATE', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { updateDailyNewTarget } = await importAction()
    const r = await updateDailyNewTarget('exam-uuid', 20)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('認証が必要です')
    expect(dbState.updateTables).toHaveLength(0)
  })

  it('境界値 0 → { ok: true }、 daily_new_target に strict に 0 が渡る (|| 混入の pin)', async () => {
    const { updateDailyNewTarget } = await importAction()
    const r = await updateDailyNewTarget('exam-uuid', 0)
    expect(r.ok).toBe(true)
    expect(dbState.setValues?.dailyNewTarget).toBe(0)
  })

  it('境界値 999 → { ok: true }', async () => {
    const { updateDailyNewTarget } = await importAction()
    const r = await updateDailyNewTarget('exam-uuid', 999)
    expect(r.ok).toBe(true)
    expect(dbState.setValues?.dailyNewTarget).toBe(999)
  })

  it('null → { ok: true }、 daily_new_target は null (既定追従)', async () => {
    const { updateDailyNewTarget } = await importAction()
    const r = await updateDailyNewTarget('exam-uuid', null)
    expect(r.ok).toBe(true)
    expect(dbState.setValues?.dailyNewTarget).toBeNull()
  })

  it('範囲外 (-1) → { ok:false, 0〜999で入力してください }, no UPDATE', async () => {
    const { updateDailyNewTarget } = await importAction()
    const r = await updateDailyNewTarget('exam-uuid', -1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('0〜999で入力してください')
    expect(dbState.updateTables).toHaveLength(0)
  })

  it('範囲外 (1000) → { ok:false, 0〜999で入力してください }, no UPDATE', async () => {
    const { updateDailyNewTarget } = await importAction()
    const r = await updateDailyNewTarget('exam-uuid', 1000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('0〜999で入力してください')
    expect(dbState.updateTables).toHaveLength(0)
  })

  it('非整数 (2.5) → { ok:false, 整数で入力してください }, no UPDATE', async () => {
    const { updateDailyNewTarget } = await importAction()
    const r = await updateDailyNewTarget('exam-uuid', 2.5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('整数で入力してください')
    expect(dbState.updateTables).toHaveLength(0)
  })

  it('非数値 (NaN — 数値欄の parse 失敗を模す) → { ok:false, 数値を入力してください }, no UPDATE', async () => {
    const { updateDailyNewTarget } = await importAction()
    const r = await updateDailyNewTarget('exam-uuid', NaN)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('数値を入力してください')
    expect(dbState.updateTables).toHaveLength(0)
  })

  it('UPDATE の SET は daily_new_target 列のみ (updated_at は $onUpdate 任せ)', async () => {
    const { updateDailyNewTarget } = await importAction()
    await updateDailyNewTarget('exam-uuid', 20)
    expect(Object.keys(dbState.setValues ?? {})).toEqual(['dailyNewTarget'])
  })

  it('owner-scope: WHERE に eq(exams.id, examId) と eq(exams.userId, user.id) が入る', async () => {
    const { updateDailyNewTarget } = await importAction()
    const { eq } = await import('drizzle-orm')
    const { exams } = await import('@/lib/db/schema')
    const r = await updateDailyNewTarget('exam-uuid', 20)
    expect(r.ok).toBe(true)
    const calls = vi.mocked(eq).mock.calls
    expect(calls).toContainEqual([exams.id, 'exam-uuid'])
    expect(calls).toContainEqual([exams.userId, 'user-uuid'])
    // WHERE は 1 回だけ (owner 条件を落とした別 UPDATE が同居しない)
    expect(dbState.whereArgs).toHaveLength(1)
  })

  it('他 owner の examId (0 行更新) → { ok: false } — tenant scoping (WHERE user_id) が実際に阻む', async () => {
    // owner-scope WHERE (eq(exams.userId, user.id)) がある限り、他 owner の行は
    // 0 件しか返らない。 型 (examId: string) は他 owner の id を弾けないため、
    // 実際の拒否は「WHERE 条件を満たす行が無い」という DB 側の帰結で確認する。
    dbState.returningRows = []
    const { updateDailyNewTarget } = await importAction()
    const { eq } = await import('drizzle-orm')
    const { exams } = await import('@/lib/db/schema')
    const r = await updateDailyNewTarget('other-owner-exam-uuid', 20)
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toBe(
        '試験が見つかりませんでした。画面を再読み込みしてください。',
      )
    // WHERE に owner 条件が実際に含まれていたことも同時に確認 (拒否が偶然でないこと)
    const calls = vi.mocked(eq).mock.calls
    expect(calls).toContainEqual([exams.userId, 'user-uuid'])
  })

  it('DB throw → { ok: false } + P0RLS alert 経路を通る (throw は外に漏れない)', async () => {
    dbState.throwOnReturning = true
    const { updateDailyNewTarget } = await importAction()
    const r = await updateDailyNewTarget('exam-uuid', 20)
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toBe(
        '新規/日の上限の変更に失敗しました。しばらくしてから再度お試しください。',
      )
    expect(mockReportRlsContextFailure).toHaveBeenCalledWith(expect.anything(), {
      route: 'update-daily-new-target',
      op: 'update',
    })
  })
})
