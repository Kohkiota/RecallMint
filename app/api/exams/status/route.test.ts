import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { sourceDocuments, type User } from '@/lib/db/schema'
import { UnauthenticatedError } from '@/lib/auth/errors'

// ---------------------------------------------------------------------------
// Fake db: select().from().where() chain で rows を返す / reject する。
// mockRows は where mock を返し、owner-scope (user_id 絞り) を検証できるようにする。
// ---------------------------------------------------------------------------
const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({ select: mockSelect })),
}))
vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
// reconcileStaleProcessing のみ mock。deriveExamStatuses / STALE_PROCESSING_MS
// は純粋なので実物を使い、status 判定ロジックを本物で検証する。
vi.mock('@/lib/exams/source-doc-status', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/exams/source-doc-status')>()
  return { ...actual, reconcileStaleProcessing: vi.fn() }
})

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { reconcileStaleProcessing } from '@/lib/exams/source-doc-status'
import { GET } from '@/app/api/exams/status/route'

const FAKE_USER = { id: 'user-uuid-1' } as unknown as User

type Row = {
  examId: string
  status: 'processing' | 'completed' | 'failed'
  createdAt: Date
}

// rows を返す select chain を組み立て、where mock を返す。
function mockRows(rows: Row[]) {
  const where = vi.fn().mockResolvedValue(rows)
  mockSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({ where }),
  })
  return where
}
function mockDbError(err: Error) {
  mockSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockRejectedValue(err),
    }),
  })
}
function minutesAgo(min: number): Date {
  return new Date(Date.now() - min * 60 * 1000)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/exams/status', () => {
  it('未ログイン (UnauthenticatedError) → 401、DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await GET()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('users 行が未 sync (null) → 200 空 statuses、DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ statuses: {} })
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('SELECT が owner-scope (user_id = 当該ユーザー) で絞られている', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const where = mockRows([])
    await GET()
    // テナント分離: where は eq(source_documents.user_id, 当該 user.id) で呼ばれる。
    expect(where).toHaveBeenCalledWith(
      eq(sourceDocuments.userId, 'user-uuid-1'),
    )
  })

  it('completed のみ → 空 statuses、reconcile を呼ばない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', status: 'completed', createdAt: minutesAgo(1) }])
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ statuses: {} })
    expect(reconcileStaleProcessing).not.toHaveBeenCalled()
  })

  it('15 分以内の processing → processing、reconcile を呼ばない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', status: 'processing', createdAt: minutesAgo(3) }])
    const res = await GET()
    expect(await res.json()).toEqual({ statuses: { e1: 'processing' } })
    expect(reconcileStaleProcessing).not.toHaveBeenCalled()
  })

  it('failed → failed、reconcile を呼ばない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', status: 'failed', createdAt: minutesAgo(1) }])
    const res = await GET()
    expect(await res.json()).toEqual({ statuses: { e1: 'failed' } })
    expect(reconcileStaleProcessing).not.toHaveBeenCalled()
  })

  it('15 分超の processing 残骸 → failed 表示 + reconcile を user.id で呼ぶ', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', status: 'processing', createdAt: minutesAgo(20) }])
    const res = await GET()
    expect(await res.json()).toEqual({ statuses: { e1: 'failed' } })
    expect(reconcileStaleProcessing).toHaveBeenCalledTimes(1)
    expect(reconcileStaleProcessing).toHaveBeenCalledWith(
      'user-uuid-1',
      expect.any(Date),
    )
  })

  it('DB エラー → 500、Cache-Control no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockDbError(new Error('neon down'))
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })

  it('成功レスポンスに Cache-Control no-store が付く', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([])
    const res = await GET()
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })
})
