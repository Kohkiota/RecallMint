// tombstones-pull test (S-delete-0)。
// getTombstonesDelta の DB query 部分を mock して検証。
// - canned 2 行から rows / maxDeletedAt が正しく返る
// - since 指定時に gte が呼ばれ、未指定時は呼ばれない
// - eq(tombstones.userId, userId) が必ず呼ばれる (owner-scope)
// - 0 行のとき rows=[] / maxDeletedAt=null

import { describe, it, expect, vi, beforeEach } from 'vitest'
// RLS-P2: helper は dbc を必須引数で受け取る。mock された getDb() を dbc として渡す。
import { getDb } from '@/lib/db'

// ── hoisted mocks ─────────────────────────────────────────────────────────────
// vi.hoisted は module 評価より前に実行されるため、外部定数を参照できない。
// canned rows は hoisted 内で定義する。
const { mockRows } = vi.hoisted(() => {
  type TsRow = {
    id: string
    userId: string
    entityType: 'card' | 'exam'
    entityId: string
    deletedAt: Date
    createdAt: Date
  }
  const cannedRows: TsRow[] = [
    {
      id: 'ts-uuid-1',
      userId: 'user-uuid',
      entityType: 'card',
      entityId: 'card-uuid-1',
      deletedAt: new Date('2026-05-01T10:00:00.000Z'),
      createdAt: new Date('2026-05-01T10:00:01.000Z'),
    },
    {
      id: 'ts-uuid-2',
      userId: 'user-uuid',
      entityType: 'exam',
      entityId: 'exam-uuid-1',
      deletedAt: new Date('2026-05-10T12:00:00.000Z'),
      createdAt: new Date('2026-05-10T12:00:01.000Z'),
    },
  ]
  return { mockRows: { value: cannedRows as TsRow[] | [] } }
})

// ── canned data (テスト assertions 用定数) ───────────────────────────────────
const CANNED_ROWS = [
  {
    id: 'ts-uuid-1',
    userId: 'user-uuid',
    entityType: 'card' as const,
    entityId: 'card-uuid-1',
    deletedAt: new Date('2026-05-01T10:00:00.000Z'),
    createdAt: new Date('2026-05-01T10:00:01.000Z'),
  },
  {
    id: 'ts-uuid-2',
    userId: 'user-uuid',
    entityType: 'exam' as const,
    entityId: 'exam-uuid-1',
    deletedAt: new Date('2026-05-10T12:00:00.000Z'),
    createdAt: new Date('2026-05-10T12:00:01.000Z'),
  },
]

// drizzle-orm: eq と gte をスパイ化し、実動作は real に委譲
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  const spyEq = vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args))
  const spyGte = vi.fn(
    (...args: Parameters<typeof real.gte>) => real.gte(...args),
  )
  return {
    ...real,
    eq: spyEq,
    gte: spyGte,
  }
})

// @/lib/db: getDb を mock し、select().from().where() が mockRows を返す
vi.mock('@/lib/db', () => {
  function makeSelectChain(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    obj['from'] = (_table: unknown) => {
      return {
        where: (_cond: unknown) => Promise.resolve(mockRows.value),
      }
    }
    return obj
  }

  return {
    getDb: () => ({
      select: () => makeSelectChain(),
    }),
  }
})

// ── helpers ───────────────────────────────────────────────────────────────────
async function getSpies() {
  const { eq, gte } = await import('drizzle-orm')
  return { spyEq: vi.mocked(eq), spyGte: vi.mocked(gte) }
}

async function importSubject() {
  return await import('./tombstones-pull')
}

beforeEach(async () => {
  const { spyEq, spyGte } = await getSpies()
  spyEq.mockClear()
  spyGte.mockClear()
  mockRows.value = CANNED_ROWS
})

// ── tests ─────────────────────────────────────────────────────────────────────
describe('toClientTombstone', () => {
  it('camelCase → snake_case + deletedAt を Z 付き UTC ISO 文字列化', async () => {
    const { toClientTombstone } = await importSubject()
    const row = CANNED_ROWS[0]
    const out = toClientTombstone(row)
    expect(out).toEqual({
      entity_type: 'card',
      entity_id: 'card-uuid-1',
      deleted_at: '2026-05-01T10:00:00.000Z',
    })
    // Z で終わる (UTC) ことを明示確認
    expect(out.deleted_at.endsWith('Z')).toBe(true)
  })

  it('entityType exam も正しく変換', async () => {
    const { toClientTombstone } = await importSubject()
    const out = toClientTombstone(CANNED_ROWS[1])
    expect(out.entity_type).toBe('exam')
    expect(out.entity_id).toBe('exam-uuid-1')
    expect(out.deleted_at).toBe('2026-05-10T12:00:00.000Z')
  })
})

describe('getTombstonesDelta', () => {
  it('(a) rows が toClientTombstone 適用済で返る', async () => {
    const { getTombstonesDelta } = await importSubject()
    const result = await getTombstonesDelta('user-uuid', getDb())
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toEqual({
      entity_type: 'card',
      entity_id: 'card-uuid-1',
      deleted_at: '2026-05-01T10:00:00.000Z',
    })
    expect(result.rows[1]).toEqual({
      entity_type: 'exam',
      entity_id: 'exam-uuid-1',
      deleted_at: '2026-05-10T12:00:00.000Z',
    })
  })

  it('(b) maxDeletedAt = 2 行のうち新しい deleted_at の ISO', async () => {
    const { getTombstonesDelta } = await importSubject()
    const result = await getTombstonesDelta('user-uuid', getDb())
    expect(result.maxDeletedAt).toBe('2026-05-10T12:00:00.000Z')
  })

  it('(c) since 指定時に gte(tombstones.deletedAt, since) が呼ばれる', async () => {
    const { getTombstonesDelta } = await importSubject()
    const { spyGte } = await getSpies()
    const since = new Date('2026-05-05T00:00:00.000Z')
    await getTombstonesDelta('user-uuid', getDb(), since)
    expect(spyGte).toHaveBeenCalled()
    const call = spyGte.mock.calls[0]
    // 第2引数が since と同一 Date
    expect(call[1]).toEqual(since)
  })

  it('(c) since 未指定時は gte が呼ばれない', async () => {
    const { getTombstonesDelta } = await importSubject()
    const { spyGte } = await getSpies()
    await getTombstonesDelta('user-uuid', getDb())
    expect(spyGte).not.toHaveBeenCalled()
  })

  it('(d) eq(tombstones.userId, userId) が必ず呼ばれる (owner-scope)', async () => {
    const { getTombstonesDelta } = await importSubject()
    const { spyEq } = await getSpies()
    const { tombstones } = await import('./schema')
    await getTombstonesDelta('user-uuid', getDb())
    expect(vi.mocked(spyEq)).toHaveBeenCalledWith(tombstones.userId, 'user-uuid')
  })

  it('(e) 0 行のとき rows=[] / maxDeletedAt=null', async () => {
    mockRows.value = []
    const { getTombstonesDelta } = await importSubject()
    const result = await getTombstonesDelta('user-uuid', getDb())
    expect(result.rows).toEqual([])
    expect(result.maxDeletedAt).toBeNull()
  })
})
