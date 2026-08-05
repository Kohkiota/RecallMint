import { describe, it, expect, vi, beforeEach } from 'vitest'
import { and, desc, eq } from 'drizzle-orm'
import { sourceDocuments, type User } from '@/lib/db/schema'
import { UnauthenticatedError } from '@/lib/auth/errors'

// ---------------------------------------------------------------------------
// Fake db: D1 (S2.0c) 以降は selectDistinctOn().from().where().orderBy() chain。
// where mock を返し owner-scope (user_id 絞り) を検証できるようにする。
// ---------------------------------------------------------------------------
const { mockSelectDistinctOn, mockSelect } = vi.hoisted(() => ({
  mockSelectDistinctOn: vi.fn(),
  // ②-4a S-4 fix round 2: `?doc=<uuid>` の PK 引き 1 件(select→from→where→limit)。
  mockSelect: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({
    selectDistinctOn: mockSelectDistinctOn,
    select: mockSelect,
  })),
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

// RLS-P3 Wave2: source_documents read は withTenantTx で包まれた。RLS-P3 Task 2 で
// withTenantTx(userId, fn) 署名へ変更(getDb を内部取得)。unit では pass-through stub で
// query を素の mock db (selectDistinctOn) へ流す(GUC 挙動は iso で担保)。
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: (_userId: string, fn: (tx: unknown) => unknown) =>
    fn({ selectDistinctOn: mockSelectDistinctOn, select: mockSelect }),
}))

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { reconcileStaleProcessing } from '@/lib/exams/source-doc-status'
import { GET } from '@/app/api/exams/status/route'

const FAKE_USER = { id: 'user-uuid-1' } as unknown as User

type Row = {
  examId: string
  id?: string
  status: 'processing' | 'completed' | 'failed'
  createdAt: Date
}

// rows を返す selectDistinctOn chain を組み立て、where mock を返す。
// D1: chain は selectDistinctOn → from → where → orderBy (await で rows resolve)。
// id(source_document id)は docStatuses(②-4a S-4)の key。指定が無ければ exam 名から
// 導出する(既存 test の意図を変えずに doc 粒度の期待値も書けるようにするため)。
function mockRows(rows: Row[]) {
  const withIds = rows.map((r) => ({ ...r, id: r.id ?? `sd-${r.examId}` }))
  const orderBy = vi.fn().mockResolvedValue(withIds)
  const where = vi.fn().mockReturnValue({ orderBy })
  mockSelectDistinctOn.mockReturnValue({
    from: vi.fn().mockReturnValue({ where }),
  })
  return { where, orderBy }
}
function mockDbError(err: Error) {
  mockSelectDistinctOn.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockRejectedValue(err),
      }),
    }),
  })
}
function minutesAgo(min: number): Date {
  return new Date(Date.now() - min * 60 * 1000)
}

// `?doc=` の PK 引きが返す行を仕込み、where mock を返す(owner-scope の検証点)。
function mockDocLookup(rows: Array<Row & { id: string }>) {
  const limit = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ limit })
  mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) })
  return { where, limit }
}

function statusRequest(docId: string): Request {
  return new Request(
    `http://localhost/api/exams/status?doc=${encodeURIComponent(docId)}`,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // 既定は「param 無し」相当(呼ばれたら空を返す)。
  mockDocLookup([])
})

describe('GET /api/exams/status', () => {
  it('未ログイン (UnauthenticatedError) → 401、DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await GET()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(mockSelectDistinctOn).not.toHaveBeenCalled()
  })

  it('users 行が未 sync (null) → 200 空 statuses、DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ statuses: {}, docStatuses: {} })
    expect(mockSelectDistinctOn).not.toHaveBeenCalled()
  })

  it('SELECT が owner-scope (user_id) かつ DISTINCT ON (exam_id) で発行される', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const { where, orderBy } = mockRows([])
    await GET()
    // D1: exam ごと最新行のみ畳む DISTINCT ON (exam_id) + 3 列 projection。
    expect(mockSelectDistinctOn).toHaveBeenCalledWith(
      [sourceDocuments.examId],
      expect.objectContaining({
        examId: sourceDocuments.examId,
        status: sourceDocuments.status,
        createdAt: sourceDocuments.createdAt,
      }),
    )
    // テナント分離: where は eq(source_documents.user_id, 当該 user.id) で呼ばれる。
    expect(where).toHaveBeenCalledWith(eq(sourceDocuments.userId, 'user-uuid-1'))
    // DISTINCT ON の正しさは ORDER BY 先頭列 = exam_id に依存する。
    // created_at DESC が最新行を選ぶ tie-break。 順序が崩れると Postgres が
    // runtime で reject するため、 引数を明示的に固定する。
    expect(orderBy).toHaveBeenCalledWith(
      sourceDocuments.examId,
      desc(sourceDocuments.createdAt),
    )
  })

  it('completed のみ → 空 statuses、reconcile を呼ばない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', status: 'completed', createdAt: minutesAgo(1) }])
    const res = await GET()
    expect(res.status).toBe(200)
    // exam 粒度は完了 exam を落とすが、doc 粒度は completed を明示値で返す(S-4)。
    expect(await res.json()).toEqual({
      statuses: {},
      docStatuses: { 'sd-e1': 'completed' },
    })
    expect(reconcileStaleProcessing).not.toHaveBeenCalled()
  })

  it('15 分以内の processing → processing、reconcile を呼ばない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', status: 'processing', createdAt: minutesAgo(3) }])
    const res = await GET()
    expect(await res.json()).toEqual({
      statuses: { e1: 'processing' },
      docStatuses: { 'sd-e1': 'processing' },
    })
    expect(reconcileStaleProcessing).not.toHaveBeenCalled()
  })

  it('failed → failed、reconcile を呼ばない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', status: 'failed', createdAt: minutesAgo(1) }])
    const res = await GET()
    expect(await res.json()).toEqual({
      statuses: { e1: 'failed' },
      docStatuses: { 'sd-e1': 'failed' },
    })
    expect(reconcileStaleProcessing).not.toHaveBeenCalled()
  })

  it('15 分超の processing 残骸 → failed 表示 + reconcile を user.id で呼ぶ', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', status: 'processing', createdAt: minutesAgo(20) }])
    const res = await GET()
    // stale processing は exam 粒度・doc 粒度とも failed に倒れる(同じ規則を共有)。
    expect(await res.json()).toEqual({
      statuses: { e1: 'failed' },
      docStatuses: { 'sd-e1': 'failed' },
    })
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

// ---------------------------------------------------------------------------
// docStatuses(②-4a 単一 invocation S-4)
// ---------------------------------------------------------------------------
// upload page が自分の source_document 1 件を poll するための doc 粒度 map。
// **additive**: 既存 `statuses`(exam 粒度)の値は 1 つも変わらない — 既存 consumer
// (exam-status-live.tsx)を無改修で通す条件そのもの。
describe('GET /api/exams/status — docStatuses (S-4)', () => {
  it('processing / completed / failed を doc id key で同時に返し、既存 statuses は不変', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([
      { examId: 'e-run', id: 'sd-run', status: 'processing', createdAt: minutesAgo(1) },
      { examId: 'e-done', id: 'sd-done', status: 'completed', createdAt: minutesAgo(2) },
      { examId: 'e-bad', id: 'sd-bad', status: 'failed', createdAt: minutesAgo(3) },
    ])

    const body = (await (await GET()).json()) as {
      statuses: Record<string, string>
      docStatuses: Record<string, string>
    }

    // completed は「key 不在」ではなく明示値(poll する client が待ち続けないため)。
    expect(body.docStatuses).toEqual({
      'sd-run': 'processing',
      'sd-done': 'completed',
      'sd-bad': 'failed',
    })
    // exam 粒度は従来どおり completed exam を落とす(意味論を変えない)。
    expect(body.statuses).toEqual({ 'e-run': 'processing', 'e-bad': 'failed' })
  })

  it('docStatuses は要求ユーザーの doc だけを含む(SELECT の owner-scope が唯一の出所)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const { where } = mockRows([
      { examId: 'e1', id: 'sd-mine', status: 'processing', createdAt: minutesAgo(1) },
    ])

    const body = (await (await GET()).json()) as { docStatuses: Record<string, string> }

    // route は rows 以外から doc を組み立てない = 他テナントの id は原理的に載らない。
    expect(Object.keys(body.docStatuses)).toEqual(['sd-mine'])
    expect(where).toHaveBeenCalledWith(eq(sourceDocuments.userId, 'user-uuid-1'))
  })

  it('SELECT の projection に source_document id が含まれる(docStatuses の key 源)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([])
    await GET()
    expect(mockSelectDistinctOn).toHaveBeenCalledWith(
      [sourceDocuments.examId],
      expect.objectContaining({ id: sourceDocuments.id }),
    )
  })
})

// ---------------------------------------------------------------------------
// `?doc=<uuid>`(S-4 fix round 2 / Codex P2)
// ---------------------------------------------------------------------------
// 主 query は DISTINCT ON (exam_id) で exam ごと最新 1 件に縮約するため、同じ exam に
// 2 件目の upload が入ると 1 件目の doc が docStatuses から落ちる。 client は key 不在を
// 「まだ処理中」として扱うので、実際には completed でも絶対上限(20 分)まで待たされ、
// 縮退 banner に倒れる。 poll が自分の doc を名指しできれば、この DISTINCT ON への
// 構造的依存が切れる。
describe('GET /api/exams/status — ?doc=<uuid> (S-4 fix round 2)', () => {
  const MINE = '11111111-1111-4111-8111-111111111111'
  const OTHERS = '22222222-2222-4222-8222-222222222222'

  it('DISTINCT ON から漏れた自分の doc でも param 経由なら status が返る', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // 同じ exam に 2 件目の upload が入り、最新は sd-newer。 poll 対象の MINE は
    // rows に居ない(= これが Codex P2 の再現条件)。
    mockRows([
      { examId: 'e1', id: 'sd-newer', status: 'processing', createdAt: minutesAgo(1) },
    ])
    mockDocLookup([
      { examId: 'e1', id: MINE, status: 'completed', createdAt: minutesAgo(5) },
    ])

    const body = (await (await GET(statusRequest(MINE))).json()) as {
      statuses: Record<string, string>
      docStatuses: Record<string, string>
    }

    expect(body.docStatuses[MINE]).toBe('completed')
    // 既存の 2 map は無改変(additive):最新行由来の entry はそのまま残る。
    expect(body.docStatuses['sd-newer']).toBe('processing')
    expect(body.statuses).toEqual({ e1: 'processing' })
  })

  it('他 user の doc id を渡しても docStatuses に現れない(owner-scope を query でも明示)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([])
    // owner-scope の WHERE が効くので実 DB では 0 行。 mock でもそれを再現する。
    const { where } = mockDocLookup([])

    const body = (await (await GET(statusRequest(OTHERS))).json()) as {
      docStatuses: Record<string, string>
    }

    expect(body.docStatuses).toEqual({})
    // RLS 任せにせず query 自体でも user_id を絞る(CLAUDE.md 絶対ルール)。
    expect(where).toHaveBeenCalledWith(
      and(eq(sourceDocuments.id, OTHERS), eq(sourceDocuments.userId, 'user-uuid-1')),
    )
  })

  it('存在しない id(0 行)は key 不在で返り、poll は継続できる(500 にしない)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([])
    mockDocLookup([])

    const res = await GET(statusRequest(MINE))

    expect(res.status).toBe(200)
    expect((await res.json()).docStatuses).toEqual({})
  })

  it('uuid でない doc param は無視する(PK 比較に渡して 22P02 で 500 にしない)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([
      { examId: 'e1', id: 'sd-e1', status: 'processing', createdAt: minutesAgo(1) },
    ])

    const res = await GET(new Request('http://localhost/api/exams/status?doc=not-a-uuid'))

    expect(res.status).toBe(200)
    // 追加 query を撃たない = 素の文字列が PK 比較へ渡らない。
    expect(mockSelect).not.toHaveBeenCalled()
    // 既定の map はそのまま返る(poll は継続できる)。
    expect((await res.json()).docStatuses).toEqual({ 'sd-e1': 'processing' })
  })

  it('param の doc が既に rows に居るなら追加 query を撃たない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', id: MINE, status: 'completed', createdAt: minutesAgo(1) }])

    const body = (await (await GET(statusRequest(MINE))).json()) as {
      docStatuses: Record<string, string>
    }

    expect(mockSelect).not.toHaveBeenCalled()
    expect(body.docStatuses[MINE]).toBe('completed')
  })

  it('param 無しの呼出は従来どおり(追加 query なし・既存挙動不変)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    mockRows([{ examId: 'e1', id: 'sd-e1', status: 'failed', createdAt: minutesAgo(1) }])

    const body = (await (await GET()).json()) as {
      statuses: Record<string, string>
      docStatuses: Record<string, string>
    }

    expect(mockSelect).not.toHaveBeenCalled()
    expect(body.statuses).toEqual({ e1: 'failed' })
    expect(body.docStatuses).toEqual({ 'sd-e1': 'failed' })
  })
})
