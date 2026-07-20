import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockTransactionBody, txCalls, getDbCalls } = vi.hoisted(() => ({
  // tx call history per invocation: array of { kind: 'aiUsage' | 'aiUsageUsers', values, conflictTarget, conflictSet }
  txCalls: [] as Array<Record<string, unknown>>,
  getDbCalls: { count: 0 },
  mockTransactionBody: vi.fn(),
}))

// 注意 (review I-2): この mock の transaction は rollback semantics を持たない
// (2 つ目の insert が throw しても 1 つ目を巻き戻さない)。 つまり「片方だけ
// 成功する状態を作らない」 ACID 保証は test では検証できず、 drizzle + Postgres
// 実 transaction に委ねている。 atomic 性が本当に効くかは staging smoke で確認。
vi.mock('@/lib/db', () => ({
  getDb: () => {
    getDbCalls.count += 1
    // 透過的 tx mock: db.transaction(async (tx) => { ... }) を実行、
    // tx.insert(...).values(...).onConflictDoUpdate(...) の chain を record。
    // RLS-P2: incrementAiUsage の tx 冒頭 setTenantContext(tx) が tx.execute を呼ぶため
    // no-op execute を生やす (set_config は txCalls に影響しない = 保証不変)。
    const tx = {
      execute: async () => [],
      insert: (table: { _: { name: string } } | { tableName?: string }) => {
        return {
          values: (vals: Record<string, unknown>) => ({
            onConflictDoUpdate: (conf: Record<string, unknown>) => {
              txCalls.push({
                table:
                  // drizzle pgTable は内部 metadata に名前を持つが、 test では
                  // 渡された table object 自体を識別子として扱う
                  (table as { _?: { name?: string } })._?.name ??
                  (table as { tableName?: string }).tableName ??
                  'unknown',
                values: vals,
                conflictTarget: conf.target,
                conflictSet: conf.set,
              })
              return Promise.resolve()
            },
          }),
        }
      },
    }
    return {
      transaction: async (fn: (txArg: typeof tx) => Promise<void>) => {
        await fn(tx)
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }
  },
}))

// schema は drizzle pgTable object をそのまま使う (lib 側で table 識別に利用)。
// test 側は import した同じ object reference を渡す前提。
import { incrementAiUsage, getTodayAiUsageGlobal } from './ai-usage-counter'
// RLS-P2 §6.6: getTodayAiUsageGlobal は dbc (接続) を必須引数で受け取るため、 mocked
// getDb() の戻りを dbc として渡す (assertion 不変)。
import { getDb } from '@/lib/db'

beforeEach(() => {
  txCalls.length = 0
  getDbCalls.count = 0
  mockTransactionBody.mockReset()
})

describe('incrementAiUsage', () => {
  it('UPSERTs both ai_usage (global) and ai_usage_users (per-user) in a single transaction with today JST date', async () => {
    // 2026-05-19 12:00 JST (= 2026-05-19 03:00 UTC) を固定
    const now = new Date('2026-05-19T03:00:00Z')
    await incrementAiUsage('user-uuid-1', 1, now)

    // 2 つの insert (ai_usage + ai_usage_users) が tx 内で発火
    expect(txCalls).toHaveLength(2)
    // global counter row
    const globalRow = txCalls[0]
    expect(globalRow.values).toMatchObject({ date: '2026-05-19', count: 1 })
    // per-user counter row
    const userRow = txCalls[1]
    expect(userRow.values).toMatchObject({
      userId: 'user-uuid-1',
      date: '2026-05-19',
      count: 1,
    })
    // 両方とも onConflictDoUpdate で count 加算する SQL を持つこと (sql 文字列の存在のみ確認、 中身は drizzle が組み立てる)
    expect(globalRow.conflictSet).toBeDefined()
    expect(userRow.conflictSet).toBeDefined()
  })

  it('count default = 1 when omitted', async () => {
    await incrementAiUsage('user-uuid-2')
    expect(txCalls).toHaveLength(2)
    expect((txCalls[0].values as { count: number }).count).toBe(1)
    expect((txCalls[1].values as { count: number }).count).toBe(1)
  })

  it('passes custom count (e.g. for batched call accounting)', async () => {
    const now = new Date('2026-05-19T03:00:00Z')
    await incrementAiUsage('user-uuid-3', 3, now)
    expect((txCalls[0].values as { count: number }).count).toBe(3)
    expect((txCalls[1].values as { count: number }).count).toBe(3)
  })

  it('JST 日境界: UTC 14:59 (= JST 23:59) の翌日切替前後で date が正しく分岐', async () => {
    // 2026-05-19 14:59 UTC = 2026-05-19 23:59 JST
    await incrementAiUsage('user-uuid', 1, new Date('2026-05-19T14:59:00Z'))
    expect((txCalls[0].values as { date: string }).date).toBe('2026-05-19')

    txCalls.length = 0

    // 2026-05-19 15:00 UTC = 2026-05-20 00:00 JST → 日付が変わる
    await incrementAiUsage('user-uuid', 1, new Date('2026-05-19T15:00:00Z'))
    expect((txCalls[0].values as { date: string }).date).toBe('2026-05-20')
  })
})

describe('getTodayAiUsageGlobal', () => {
  it('returns 0 when ai_usage has no row for today', async () => {
    const count = await getTodayAiUsageGlobal(getDb())
    expect(count).toBe(0)
  })
})
