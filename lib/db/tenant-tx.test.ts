import { describe, it, expect, vi } from 'vitest'
import { withTenantTx, setTenantContext, type TenantTx } from './tenant-tx'
import type { DB } from './index'

// RLS Phase 2 配管の中核 wrapper。 実 PG での GUC 可視性 / ROLLBACK 後の消滅 /
// savepoint 維持は Task 9 の real-PG 統合 test に集約する — ここでは
// `db.transaction` / `tx.execute` を mock した単体 test のみ (drizzle の実 SQL
// 実行はしない)。 不正 uuid の `::uuid` cast reject (22P02) も mock では評価
// されない (静的解析対象外) ため、 ここでは検証せず Task 9 に委譲する。

// sql`` テンプレートの queryChunks から static 文字列部分だけ抽出する (bind
// param の実値は無視し、 生成 SQL の語彙のみ検査する)。
function sqlText(query: { queryChunks: unknown[] }): string {
  return query.queryChunks
    .map((chunk) =>
      chunk && typeof chunk === 'object' && 'value' in chunk
        ? (chunk as { value: unknown[] }).value.join('')
        : '',
    )
    .join('')
}

function makeMockTx(onExecute?: () => void): TenantTx {
  return {
    execute: vi.fn(async () => {
      onExecute?.()
      return []
    }),
  } as unknown as TenantTx
}

function makeMockDb(tx: TenantTx): { db: DB; transaction: ReturnType<typeof vi.fn> } {
  const transaction = vi.fn((cb: (tx: TenantTx) => Promise<unknown>) => cb(tx))
  return { db: { transaction } as unknown as DB, transaction }
}

describe('setTenantContext', () => {
  it('SQL に set_config / app.user_id / ::uuid::text を含む', async () => {
    const tx = makeMockTx()

    await setTenantContext(tx, 'user-1')

    const call = vi.mocked(tx.execute).mock.calls[0]![0] as unknown as { queryChunks: unknown[] }
    const text = sqlText(call)
    expect(text).toContain('set_config')
    expect(text).toContain('app.user_id')
    expect(text).toContain('::uuid::text')
  })
})

describe('withTenantTx', () => {
  it('db.transaction を 1 回呼び、fn 本体より前に set_config (tx.execute) を発行する', async () => {
    const order: string[] = []
    const tx = makeMockTx(() => order.push('execute'))
    const { db, transaction } = makeMockDb(tx)

    await withTenantTx(db, 'user-1', async () => {
      order.push('fn')
      return 'result'
    })

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['execute', 'fn'])
  })

  it('fn の戻り値を透過する', async () => {
    const tx = makeMockTx()
    const { db } = makeMockDb(tx)

    const result = await withTenantTx(db, 'user-1', async () => 'ok')

    expect(result).toBe('ok')
  })

  it('fn が throw したら withTenantTx も同じ error で reject する', async () => {
    const tx = makeMockTx()
    const { db } = makeMockDb(tx)
    const boom = new Error('boom')

    await expect(
      withTenantTx(db, 'user-1', async () => {
        throw boom
      }),
    ).rejects.toThrow(boom)
  })
})
