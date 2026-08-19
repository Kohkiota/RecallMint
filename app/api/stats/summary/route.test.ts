// GET /api/stats/summary の unit test (Dash-1 Home v1 Task 8 / spec §10)。
// study-days/pull の route test pattern を踏襲: auth / 未 sync / 正常 / DB error /
// Cache-Control。本 route 固有の追加は **exam_id param の 400 契約** と
// **owner echo + exam_id echo** (client の遅着応答破棄がこの 2 つに依存する)。
//
// ここで pin しない範囲: 集計の中身 (閾値・30 日窓・順位・削除) は SQL 側の保証で、
// 実 PostgreSQL の iso (tests/integration/pg/weak-tags-summary.test.ts) が担当する。
// この file は getWeakTagsSummary を mock するので SQL は 1 文字も実行されない。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'
import type { WeakTagSummaryRow } from '@/lib/db/weak-tags-summary'

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/db/weak-tags-summary', () => ({
  getWeakTagsSummary: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
// RLS-P2: route は withTenantTx(userId, ...) で helper を包む。unit test では DB に
// 触れないよう getDb を stub し、withTenantTx は fn(fakeTx) を直呼びする。
vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }))
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: vi.fn(
    async (_userId: string, fn: (tx: unknown) => unknown) => fn({}),
  ),
}))

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getWeakTagsSummary } from '@/lib/db/weak-tags-summary'
import { GET } from './route'

const FAKE_USER = { id: 'user-uuid-1' } as unknown as User
const EXAM_ID = '11111111-1111-4111-8111-111111111111'

function req(query = `?exam_id=${EXAM_ID}`): Request {
  return new Request(`http://localhost/api/stats/summary${query}`)
}

const ROW: WeakTagSummaryRow = {
  option_id: '22222222-2222-4222-8222-222222222222',
  name: '循環器',
  category_name: '分野',
  review_accuracy: 42,
  card_count: 12,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/stats/summary', () => {
  it('未ログイン → 401 + no-store + 集計に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getWeakTagsSummary).not.toHaveBeenCalled()
  })

  it('exam_id 欠落 → 400 + no-store + 集計に触れない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await GET(req(''))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_exam_id' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getWeakTagsSummary).not.toHaveBeenCalled()
  })

  it('exam_id が uuid でない → 400 (DB へ素の文字列を渡さない)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await GET(req('?exam_id=not-a-uuid'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_exam_id' })
    expect(getWeakTagsSummary).not.toHaveBeenCalled()
  })

  it('exam_id が空文字 → 400', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await GET(req('?exam_id='))
    expect(res.status).toBe(400)
    expect(getWeakTagsSummary).not.toHaveBeenCalled()
  })

  it('候補 0 件 → 200 + weak_tags: [] (404 にしない)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getWeakTagsSummary).mockResolvedValue([])
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { weak_tags: WeakTagSummaryRow[] }
    expect(body.weak_tags).toEqual([])
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })

  it('正常応答: owner echo + exam_id echo + weak_tags 本体', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getWeakTagsSummary).mockResolvedValue([ROW])
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      owner_user_id: string
      exam_id: string
      weak_tags: WeakTagSummaryRow[]
    }
    expect(body.owner_user_id).toBe('user-uuid-1')
    expect(body.exam_id).toBe(EXAM_ID)
    expect(body.weak_tags).toEqual([ROW])
  })

  it('集計は (user.id, exam_id, tx, receivedAt) で 1 回だけ呼ばれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getWeakTagsSummary).mockResolvedValue([])
    await GET(req())
    expect(getWeakTagsSummary).toHaveBeenCalledTimes(1)
    expect(getWeakTagsSummary).toHaveBeenCalledWith(
      'user-uuid-1',
      EXAM_ID,
      expect.anything(),
      expect.any(Date),
    )
  })

  it('DB エラー → 500 + no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getWeakTagsSummary).mockRejectedValue(new Error('neon down'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })

  it('users 行が未 sync → 200 空 + owner/exam echo は載らない (静的リテラルの構造的帰結)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { weak_tags: WeakTagSummaryRow[] }
    expect(body.weak_tags).toEqual([])
    expect(body).not.toHaveProperty('owner_user_id')
    expect(body).not.toHaveProperty('exam_id')
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(getWeakTagsSummary).not.toHaveBeenCalled()
  })
})
