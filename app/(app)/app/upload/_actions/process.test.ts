import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockGetCurrentUser,
  mockRunOcrPipeline,
  mockCanRunOcr,
  mockNotifyOps,
  mockPdfPageCount,
  mockIncrementAiUsage,
  mockGetTodayAiUsageGlobal,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRunOcrPipeline: vi.fn(),
  mockCanRunOcr: vi.fn(),
  mockNotifyOps: vi.fn(),
  mockPdfPageCount: vi.fn(),
  mockIncrementAiUsage: vi.fn(),
  mockGetTodayAiUsageGlobal: vi.fn(),
  mockRevalidatePath: vi.fn(),
  // DB chain mock — track which operations were called and return preset values.
  dbState: {
    insertedExams: [] as Array<{ name: string; userId: string }>,
    insertedSourceDocs: [] as Array<Record<string, unknown>>,
    insertedCards: [] as Array<Record<string, unknown>>,
    insertedUploadRecords: [] as Array<Record<string, unknown>>,
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

vi.mock('@/lib/ai-usage-counter', () => ({
  incrementAiUsage: mockIncrementAiUsage,
  getTodayAiUsageGlobal: mockGetTodayAiUsageGlobal,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
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
// S1.9.1: transaction() を追加 (完了更新 + upload_records append、 markFailed が
// transaction を使うため)。 tx は db と同じ API。 upload_records INSERT は
// .returning() なしで await されるため .values() 自体を thenable にする。
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
  function dbApi() {
    return {
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
            } else if ('status' in row) {
              // upload_records (status 持ち / fileType・name なし)
              dbState.insertedUploadRecords.push(row)
              returnValue = []
            } else {
              returnValue = []
            }
          }
          // .values() 自体を awaitable に + .returning() も生やす
          const c = chain(returnValue) as Record<string, unknown>
          c.returning = () => chain(returnValue)
          return c
        },
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          dbState.updatedSourceDocs.push(vals)
          return chain(undefined)
        },
      }),
      delete: () => chain(undefined),
    }
  }
  return {
    getDb: () => ({
      ...dbApi(),
      transaction: async (
        fn: (tx: ReturnType<typeof dbApi>) => Promise<unknown>,
      ) => await fn(dbApi()),
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
  mockIncrementAiUsage.mockReset()
  mockGetTodayAiUsageGlobal.mockReset()
  mockRevalidatePath.mockReset()
  // 既定: ai_usage counter は無風 (上限未到達 / increment 成功)
  mockGetTodayAiUsageGlobal.mockResolvedValue(0)
  mockIncrementAiUsage.mockResolvedValue(undefined)
  // GEMINI_DAILY_LIMIT は test 中で個別 override する場合がある
  delete process.env.GEMINI_DAILY_LIMIT

  dbState.insertedExams = []
  dbState.insertedSourceDocs = []
  dbState.insertedCards = []
  dbState.insertedUploadRecords = []
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
  it('returns INVALID_INPUT when no files provided', async () => {
    const fd = makeFormData({ mode: 'new', files: [] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_INPUT')
      expect(result.error).toBe('ファイルが選択されていません')
    }
  })

  it('returns INVALID_INPUT when mode is missing', async () => {
    const fd = makeFormData({ mode: null, files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_INPUT')
      expect(result.error).toBe('投入先が指定されていません')
    }
  })

  it('returns INVALID_INPUT when mode=existing without examId', async () => {
    const fd = makeFormData({ mode: 'existing', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_INPUT')
      expect(result.error).toBe('既存の試験が選択されていません')
    }
  })

  it('QUOTA_EXCEEDED → no DB writes, structured error with current/limit/requested', async () => {
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
      expect(result.code).toBe('QUOTA_EXCEEDED')
      expect(result.error).toMatch(/今月の OCR ページ上限/)
      expect(result.details).toEqual({
        current: 30,
        limit: 30,
        requested: 1,
      })
    }
    expect(mockRunOcrPipeline).not.toHaveBeenCalled()
    // kickoff Critical 1: 上限超過時は exam INSERT も source_documents INSERT も走らないこと
    expect(dbState.insertedExams).toHaveLength(0)
    expect(dbState.insertedSourceDocs).toHaveLength(0)
    expect(dbState.insertedCards).toHaveLength(0)
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
    // mode='new' → exam を auto 作成したので examWasAutoCreated=true (S1.9)
    expect(result.data?.examWasAutoCreated).toBe(true)
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
    // S1.9.1: 完了時 upload_records に status='completed' 行が append される
    expect(dbState.insertedUploadRecords).toHaveLength(1)
    expect(dbState.insertedUploadRecords[0]).toMatchObject({
      userId: 'user-uuid',
      status: 'completed',
      pagesProcessed: 1,
    })
  })

  it('GEMINI_DAILY_LIMIT_EXCEEDED: global daily count >= limit → no DB writes, no OCR run', async () => {
    process.env.GEMINI_DAILY_LIMIT = '5'
    mockGetTodayAiUsageGlobal.mockResolvedValueOnce(5)
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('GEMINI_DAILY_LIMIT_EXCEEDED')
      expect(result.error).toMatch(/本日のサービス全体の利用上限/)
      expect(result.details).toMatchObject({ current: 5, limit: 5 })
    }
    expect(mockRunOcrPipeline).not.toHaveBeenCalled()
    expect(dbState.insertedExams).toHaveLength(0)
    expect(dbState.insertedSourceDocs).toHaveLength(0)
  })

  it('GEMINI_DAILY_LIMIT unset → guard off (OCR proceeds even with high count)', async () => {
    delete process.env.GEMINI_DAILY_LIMIT
    mockGetTodayAiUsageGlobal.mockResolvedValueOnce(999_999)
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockResolvedValueOnce({
      cards: [
        {
          title: '問1',
          question_text: 'リード文',
          options: [{ id: 'a', text: 'A', is_correct: true }],
          correct_answer_ids: ['a'],
          images: [],
          custom_props: {},
        },
      ],
      modelChain: ['flash'],
      costYen: 1,
      tokenUsage: [{ model: 'flash', inputTokens: 100, outputTokens: 10 }],
    })
    dbState.nextCardIds = ['card-1']
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(true)
  })

  it('processUpload always calls revalidatePath on completion (success path)', async () => {
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockResolvedValueOnce({
      cards: [
        {
          title: '問1',
          question_text: 'リード文',
          options: [{ id: 'a', text: 'A', is_correct: true }],
          correct_answer_ids: ['a'],
          images: [],
          custom_props: {},
        },
      ],
      modelChain: ['flash'],
      costYen: 1,
      tokenUsage: [{ model: 'flash', inputTokens: 100, outputTokens: 10 }],
    })
    dbState.nextCardIds = ['card-1']
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    await processUpload(fd)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('processUpload calls revalidatePath on early-return path (QUOTA_EXCEEDED)', async () => {
    mockCanRunOcr.mockResolvedValueOnce({
      ok: false,
      reason: 'exceeded',
      current: 30,
      limit: 30,
      requested: 1,
    })
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    await processUpload(fd)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('happy path (existing exam): no exam INSERT, examWasAutoCreated=false', async () => {
    dbState.selectedExam = {
      id: 'exam-existing',
      name: '既存試験',
      archivedAt: null,
    }
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockResolvedValueOnce({
      cards: [
        {
          title: '問1',
          question_text: 'リード文',
          options: [{ id: 'a', text: 'A', is_correct: true }],
          correct_answer_ids: ['a'],
          images: [],
          custom_props: {},
        },
      ],
      modelChain: ['flash'],
      costYen: 2,
      tokenUsage: [{ model: 'flash', inputTokens: 100, outputTokens: 10 }],
    })
    dbState.nextCardIds = ['card-1']
    const fd = makeFormData({
      mode: 'existing',
      examId: 'exam-existing',
      files: [sampleImage],
    })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    // 既存 exam 利用 → exam INSERT は走らない
    expect(dbState.insertedExams).toHaveLength(0)
    expect(result.data?.examId).toBe('exam-existing')
    expect(result.data?.examName).toBe('既存試験')
    // mode='existing' → discard でも exam を残すため false (S1.9)
    expect(result.data?.examWasAutoCreated).toBe(false)
  })

  it('OCR pipeline failure → GEMINI_FAILED with details, source_doc marked failed + notifyOps', async () => {
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockRejectedValueOnce(
      new Error('OCR pipeline failed (Flash: x; Pro: y)'),
    )
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('GEMINI_FAILED')
    expect(result.error).toMatch(/混み合っているようです/)
    expect(result.details?.rawError).toMatch(/Flash: x; Pro: y/)
    expect(result.details?.sourceDocumentId).toBeDefined()
    // source_doc was inserted then marked failed
    expect(dbState.insertedSourceDocs).toHaveLength(1)
    // markFailed updates with status:'failed'
    expect(
      dbState.updatedSourceDocs.some((u) => u.status === 'failed'),
    ).toBe(true)
    // S1.9.1: 失敗時も upload_records に status='failed' 行が append される
    expect(dbState.insertedUploadRecords).toHaveLength(1)
    expect(dbState.insertedUploadRecords[0]).toMatchObject({
      userId: 'user-uuid',
      status: 'failed',
    })
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'ocr pipeline failed',
      expect.objectContaining({
        userId: 'user-uuid',
        filename: 'photo.jpg',
      }),
    )
  })
})
