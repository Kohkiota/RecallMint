import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockGetCurrentUser,
  mockRunOcrPipeline,
  mockCanRunOcr,
  mockNotifyOps,
  mockPdfPageCount,
  dbState,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRunOcrPipeline: vi.fn(),
  mockCanRunOcr: vi.fn(),
  mockNotifyOps: vi.fn(),
  mockPdfPageCount: vi.fn(),
  // DB chain mock — track which operations were called and return preset values.
  dbState: {
    insertedExams: [] as Array<{ name: string; userId: string }>,
    insertedSourceDocs: [] as Array<Record<string, unknown>>,
    insertedCards: [] as Array<Record<string, unknown>>,
    updatedSourceDocs: [] as Array<Record<string, unknown>>,
    selectedExam: null as { id: string; name: string; archivedAt: Date | null } | null,
    nextExamId: 'exam-new-id',
    nextSourceDocId: 'sdoc-id',
    nextCardIds: ['card-1', 'card-2'],
  },
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/ai/ocr', () => ({
  runOcrPipeline: mockRunOcrPipeline,
}))

vi.mock('@/lib/ai-usage-mcq', () => ({
  canRunOcr: mockCanRunOcr,
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
}))

vi.mock('../_lib/pdf-page-count', () => ({
  pdfPageCount: mockPdfPageCount,
}))

// Chainable DB mock builder. Uses a real Promise-returning thenable to avoid
// Proxy/then quirks. Each chain method returns the same chain object, and the
// chain itself resolves to `returnValue` when awaited.
vi.mock('@/lib/db', () => {
  function chain(returnValue: unknown) {
    const obj: Record<string, unknown> = {}
    const passthrough = ['from', 'where', 'limit', 'set']
    for (const m of passthrough) obj[m] = () => obj
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(returnValue).then(onFulfilled, onRejected)
    return obj
  }
  return {
    getDb: () => ({
      select: () => chain(dbState.selectedExam ? [dbState.selectedExam] : []),
      insert: () => ({
        values: (rows: unknown) => {
          let returnValue: unknown
          if (Array.isArray(rows)) {
            // cards bulk INSERT
            dbState.insertedCards.push(...(rows as Record<string, unknown>[]))
            returnValue = dbState.nextCardIds
              .slice(0, rows.length)
              .map((id, idx) => ({
                id,
                title: (rows as { title: string }[])[idx]?.title ?? '',
              }))
          } else {
            const row = rows as Record<string, unknown>
            if ('fileType' in row) {
              dbState.insertedSourceDocs.push(row)
              returnValue = [{ id: dbState.nextSourceDocId }]
            } else if ('name' in row) {
              dbState.insertedExams.push({
                name: row.name as string,
                userId: row.userId as string,
              })
              returnValue = [{ id: dbState.nextExamId }]
            } else {
              returnValue = []
            }
          }
          return {
            returning: () => chain(returnValue),
          }
        },
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          dbState.updatedSourceDocs.push(vals)
          return chain(undefined)
        },
      }),
      delete: () => chain(undefined),
    }),
  }
})

async function importProcess() {
  return await import('./process')
}

function makeFormData(opts: {
  mode: 'new' | 'existing' | null
  examId?: string
  files: File[]
}): FormData {
  const fd = new FormData()
  if (opts.mode) fd.set('mode', opts.mode)
  if (opts.examId) fd.set('examId', opts.examId)
  for (const f of opts.files) fd.append('files', f)
  return fd
}

const sampleImage = new File(['imagedata'], 'photo.jpg', { type: 'image/jpeg' })

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockRunOcrPipeline.mockReset()
  mockCanRunOcr.mockReset()
  mockNotifyOps.mockReset()
  mockPdfPageCount.mockReset()
  dbState.insertedExams = []
  dbState.insertedSourceDocs = []
  dbState.insertedCards = []
  dbState.updatedSourceDocs = []
  dbState.selectedExam = null

  mockGetCurrentUser.mockResolvedValue({
    id: 'user-uuid',
    clerkId: 'clerk-user-1',
    email: 'test@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
})

describe('processUpload', () => {
  it('returns error when no files provided', async () => {
    const fd = makeFormData({ mode: 'new', files: [] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result).toEqual({
      ok: false,
      error: 'ファイルが選択されていません',
    })
  })

  it('returns error when mode is missing', async () => {
    const fd = makeFormData({ mode: null, files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result).toEqual({
      ok: false,
      error: '投入先が指定されていません',
    })
  })

  it('returns error when mode=existing without examId', async () => {
    const fd = makeFormData({ mode: 'existing', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result).toEqual({
      ok: false,
      error: '既存の試験が選択されていません',
    })
  })

  it('plan-limits exceeded → error before OCR runs', async () => {
    mockCanRunOcr.mockResolvedValueOnce({
      ok: false,
      reason: 'exceeded',
      current: 30,
      limit: 30,
      requested: 1,
    })
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/今月の OCR ページ上限/)
    }
    expect(mockRunOcrPipeline).not.toHaveBeenCalled()
  })

  it('happy path (new exam): OCR success → exam INSERT + cards INSERT + sourceDoc completed', async () => {
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockResolvedValueOnce({
      cards: [
        {
          title: '問1',
          question_text: 'リード文',
          options: [
            { id: 'a', text: '選択肢A', is_correct: true },
            { id: 'b', text: '選択肢B', is_correct: false },
          ],
          correct_answer_ids: ['a'],
          images: [],
          custom_props: { 試験回: '令和7年度' },
        },
      ],
      modelChain: ['flash'],
      costYen: 5,
      tokenUsage: [{ model: 'flash', inputTokens: 1000, outputTokens: 100 }],
    })
    dbState.nextCardIds = ['card-1']
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data?.cardsExtracted).toBe(1)
    expect(result.data?.ocrCostYen).toBe(5)
    expect(result.data?.modelChain).toEqual(['flash'])
    expect(result.data?.cards).toHaveLength(1)
    expect(result.data?.cards[0].customPropKeys).toEqual(['試験回'])
    // exam created with auto-name pattern
    expect(dbState.insertedExams).toHaveLength(1)
    expect(dbState.insertedExams[0].name).toMatch(/^アップロード \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(dbState.insertedExams[0].userId).toBe('user-uuid')
    // source_document INSERT + later COMPLETED update
    expect(dbState.insertedSourceDocs).toHaveLength(1)
    expect(dbState.updatedSourceDocs).toHaveLength(1)
    expect(dbState.updatedSourceDocs[0]).toMatchObject({
      status: 'completed',
      cardsExtracted: 1,
      ocrCostYen: 5,
    })
    // cards INSERT contains tags=[]
    expect(dbState.insertedCards).toHaveLength(1)
    expect(dbState.insertedCards[0].tags).toEqual([])
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('OCR pipeline failure → source_doc marked failed + notifyOps + generic error to user', async () => {
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockRejectedValueOnce(
      new Error('OCR pipeline failed (Flash: x; Pro: y)'),
    )
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error).toMatch(/混み合っているようです/)
    // source_doc was inserted then marked failed
    expect(dbState.insertedSourceDocs).toHaveLength(1)
    // markFailed updates with status:'failed'
    expect(
      dbState.updatedSourceDocs.some((u) => u.status === 'failed'),
    ).toBe(true)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'ocr pipeline failed',
      expect.objectContaining({
        userId: 'user-uuid',
        filename: 'photo.jpg',
      }),
    )
  })
})
