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
    // B1 (S2.0c): exams.card_count 更新 set() を sourceDocuments 更新と分けて
    // 記録する (mock の update() は set vals に cardCount を含むかで振り分ける)。
    updatedExams: [] as Array<Record<string, unknown>>,
    selectedExam: null as { id: string; name: string; archivedAt: Date | null } | null,
    nextExamId: 'exam-new-id',
    nextSourceDocId: 'sdoc-id',
    nextCardIds: ['card-1', 'card-2'],
    // S1.9.4: advisory xact lock の取得成否 (true = 取得成功、false = 他リクエストが保持中)
    advisoryLockAcquired: true,
    // S1.9.4: in-flight processing 行の有無 (null = 行なし = guard 通過)
    inflightProcessingDoc: null as { id: string } | null,
    // Min4 test: true のとき完了 tx を強制 throw する (B1 後は guard / cards
    // INSERT tx に続く 3 番目の transaction = txIndex 2)
    completionTxShouldFail: false,
  },
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/ai/ocr', async (importOriginal) => {
  // importActual で実 OcrDeadlineError class を使う (instanceof が正しく動くために必要)。
  const actual = await importOriginal<typeof import('@/lib/ai/ocr')>()
  return {
    runOcrPipeline: mockRunOcrPipeline,
    OcrDeadlineError: actual.OcrDeadlineError,
  }
})

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
// S1.9.4: execute() を追加 (advisory xact lock の pg_try_advisory_xact_lock 呼び出し)。
//         guard tx (1 回目の transaction 呼び出し) と後続 tx を呼び出し順で区別し、
//         guard tx 内の select は in-flight check (1 回目) と exam validate (2 回目)
//         を dbState.inflightProcessingDoc / dbState.selectedExam で使い分ける。
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
  function dbApi(isGuardTx = false) {
    // guard tx 内の select 呼び出し順を追跡するカウンタ
    //   0 回目 = in-flight check (source_documents WHERE status='processing')
    //   1 回目 = exam validate (exams WHERE id=...) — existing mode のみ
    let guardSelectCallCount = 0
    return {
      // postgres-js + drizzle: tx.execute() は RowList<T[]> (Array-like) を返す。
      // 実装側が `(lockResult as unknown as Array<{ locked: boolean }>)[0]?.locked`
      // で読む形式に合わせる (旧 Neon の `{ rows: [...] }` ラッピングは廃止)。
      execute: (_sqlTemplate: unknown) =>
        Promise.resolve([{ locked: dbState.advisoryLockAcquired }]),
      select: () => {
        let returnValue: unknown
        if (isGuardTx) {
          // guard tx 内: 呼び出し順で in-flight check / exam validate を区別
          if (guardSelectCallCount === 0) {
            returnValue = dbState.inflightProcessingDoc
              ? [dbState.inflightProcessingDoc]
              : []
          } else {
            returnValue = dbState.selectedExam ? [dbState.selectedExam] : []
          }
          guardSelectCallCount++
        } else {
          // guard tx 外: 完了 tx / markFailed tx など (select を使わないが念のため)
          returnValue = dbState.selectedExam ? [dbState.selectedExam] : []
        }
        return chain(returnValue)
      },
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
          // B1: card_count 更新 (set に cardCount を含む) は exams 更新、
          // それ以外 (status 等) は source_documents 更新として振り分ける。
          if ('cardCount' in vals) dbState.updatedExams.push(vals)
          else dbState.updatedSourceDocs.push(vals)
          return chain(undefined)
        },
      }),
      delete: () => chain(undefined),
    }
  }
  return {
    getDb: () => {
      // getDb() が呼ばれるたびに localTxCallCount をリセットすることで、
      // processUpload 呼び出し単位で「1 回目 = guard tx」判定が正しく動く。
      // vi.mock factory は module-scope で一度だけ評価されるが、 getDb() は
      // _processUpload 内で毎回呼ばれるため、 テスト間で count がリセットされる。
      let localTxCallCount = 0
      return {
        ...dbApi(false),
        transaction: async (
          fn: (tx: ReturnType<typeof dbApi>) => Promise<unknown>,
        ) => {
          // txIndex 0 = guard tx (advisory lock + in-flight check)
          // txIndex 1 = B1 cards INSERT tx (cards bulk + exams.card_count +N)
          // txIndex 2 = 完了 tx (source_documents completed + upload_records)
          const isGuardTx = localTxCallCount === 0
          const txIndex = localTxCallCount
          localTxCallCount++
          // Min4 test: 完了 tx (txIndex 2) を強制 throw。 markFailed は別 getDb()
          // インスタンスで localTxCallCount=0 から始まるため txIndex 2 に達せず、
          // この強制 throw の影響を受けない。
          if (txIndex === 2 && dbState.completionTxShouldFail) {
            throw new Error('Neon connection lost during completion tx')
          }
          return await fn(dbApi(isGuardTx) as ReturnType<typeof dbApi>)
        },
      }
    },
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
  dbState.updatedExams = []
  dbState.selectedExam = null
  // S1.9.4: guard tx の既定値 (guard 通過状態)
  dbState.advisoryLockAcquired = true
  dbState.inflightProcessingDoc = null
  dbState.completionTxShouldFail = false

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
    // exam created with auto-name pattern
    expect(dbState.insertedExams).toHaveLength(1)
    expect(dbState.insertedExams[0].name).toMatch(/^アップロード \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(dbState.insertedExams[0].userId).toBe('user-uuid')
    // source_document INSERT + later COMPLETED update
    expect(dbState.insertedSourceDocs).toHaveLength(1)
    // S1.9.2: source_documents に mode='new' が記録される
    expect(dbState.insertedSourceDocs[0].mode).toBe('new')
    expect(dbState.updatedSourceDocs).toHaveLength(1)
    expect(dbState.updatedSourceDocs[0]).toMatchObject({
      status: 'completed',
      cardsExtracted: 1,
      ocrCostYen: 5,
    })
    expect(dbState.insertedCards).toHaveLength(1)
    expect(mockNotifyOps).not.toHaveBeenCalled()
    // S1.9.1: 完了時 upload_records に status='completed' 行が append される
    expect(dbState.insertedUploadRecords).toHaveLength(1)
    expect(dbState.insertedUploadRecords[0]).toMatchObject({
      userId: 'user-uuid',
      status: 'completed',
      pagesProcessed: 1,
    })
  })

  it('B1: OCR 成功時 cards INSERT と同一 tx で exams.card_count を加算する', async () => {
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockResolvedValueOnce({
      cards: [
        {
          title: '問1',
          question_text: 'リード文1',
          options: [{ id: 'a', text: 'A', is_correct: true }],
          correct_answer_ids: ['a'],
          images: [],
          custom_props: {},
        },
        {
          title: '問2',
          question_text: 'リード文2',
          options: [{ id: 'a', text: 'A', is_correct: true }],
          correct_answer_ids: ['a'],
          images: [],
          custom_props: {},
        },
      ],
      modelChain: ['flash'],
      costYen: 3,
      tokenUsage: [{ model: 'flash', inputTokens: 200, outputTokens: 20 }],
    })
    dbState.nextCardIds = ['card-1', 'card-2']
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(true)
    // cards 2 件 INSERT → 同一 tx で exams.card_count 更新が 1 回入る
    expect(dbState.insertedCards).toHaveLength(2)
    expect(dbState.updatedExams).toHaveLength(1)
    expect(dbState.updatedExams[0]).toHaveProperty('cardCount')
    // updatedAt を明示 set し $onUpdate による updatedAt bump を抑止する
    expect(dbState.updatedExams[0]).toHaveProperty('updatedAt')
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

  it('processUpload always calls revalidatePath on completion (success path) — S-cache-2a 縮小: /app/upload + /app', async () => {
    // S-cache-2a: 旧来 `revalidatePath('/', 'layout')` は全 path 配下を一括 revalidate
    // する過剰スコープ。 真に必要な cross-page 影響は 2 件:
    //   - /app/upload (残量 banner 更新)
    //   - /app (dashboard dueCount: 新規 card 投入で due 件数が増える)
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
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app')
    expect(mockRevalidatePath).not.toHaveBeenCalledWith('/', 'layout')
    // 上記 2 path のみで scope creep を防ぐ (review minor #4 反映)
    expect(mockRevalidatePath).toHaveBeenCalledTimes(2)
  })

  it('processUpload calls revalidatePath on early-return path (QUOTA_EXCEEDED) — S-cache-2a 縮小', async () => {
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
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app')
    expect(mockRevalidatePath).not.toHaveBeenCalledWith('/', 'layout')
    expect(mockRevalidatePath).toHaveBeenCalledTimes(2)
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
    // S1.9.2: source_documents に mode='existing' が記録される
    expect(dbState.insertedSourceDocs[0].mode).toBe('existing')
  })

  it('OCR pipeline failure → GEMINI_FAILED with details, source_doc marked failed + notifyOps', async () => {
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockRejectedValueOnce(
      new Error('OCR pipeline failed (Flash: x)'),
    )
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('GEMINI_FAILED')
    expect(result.error).toMatch(/混み合っているようです/)
    expect(result.details?.rawError).toMatch(/Flash: x/)
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

  // S1.9.4: 並列 OCR ガード — advisory xact lock 取得失敗 (race loser)
  it('UPLOAD_IN_PROGRESS when advisory lock fails → no exam/sourceDoc INSERT', async () => {
    // advisory lock が false を返す = 別リクエストが同時にロックを保持している (ms 窓での race)
    dbState.advisoryLockAcquired = false
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('UPLOAD_IN_PROGRESS')
    expect(result.error).toMatch(/処理中の OCR/)
    // guard 失敗: exam INSERT も source_documents INSERT も走らない
    expect(dbState.insertedExams).toHaveLength(0)
    expect(dbState.insertedSourceDocs).toHaveLength(0)
    expect(mockRunOcrPipeline).not.toHaveBeenCalled()
    // guard は plan-limits / daily-limit より前 → quota / daily チェックは走らない
    expect(mockCanRunOcr).not.toHaveBeenCalled()
    expect(mockGetTodayAiUsageGlobal).not.toHaveBeenCalled()
  })

  // S1.9.4: 並列 OCR ガード — in-flight processing 行が存在 (先行ジョブ走行中)
  it('UPLOAD_IN_PROGRESS when in-flight processing doc exists → no exam/sourceDoc INSERT', async () => {
    // in-flight 行が存在 = 15 分以内に別 OCR ジョブが source_documents を processing 状態で保持している
    dbState.inflightProcessingDoc = { id: 'sdoc-inflight' }
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('UPLOAD_IN_PROGRESS')
    expect(result.error).toMatch(/処理中の OCR/)
    // guard 失敗: exam INSERT も source_documents INSERT も走らない
    expect(dbState.insertedExams).toHaveLength(0)
    expect(dbState.insertedSourceDocs).toHaveLength(0)
    expect(mockRunOcrPipeline).not.toHaveBeenCalled()
    // guard は plan-limits / daily-limit より前 → quota / daily チェックは走らない
    expect(mockCanRunOcr).not.toHaveBeenCalled()
    expect(mockGetTodayAiUsageGlobal).not.toHaveBeenCalled()
  })

  // Min4 (S2.0.5 sprint): OCR + cards INSERT 成功後の完了 tx が throw した場合、
  // 捕捉して markFailed で status='failed' を確定させる (stuck processing 防止)。
  it('completion tx failure → SAVE_FAILED, source_doc を failed 更新 + notifyOps', async () => {
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
      costYen: 5,
      tokenUsage: [{ model: 'flash', inputTokens: 1000, outputTokens: 100 }],
    })
    dbState.nextCardIds = ['card-1']
    dbState.completionTxShouldFail = true
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('SAVE_FAILED')
    expect(result.details?.sourceDocumentId).toBeDefined()
    // OCR 成功 → cards は INSERT 済み
    expect(dbState.insertedCards).toHaveLength(1)
    // 完了 tx 失敗 → status='completed' update は無く、 markFailed の
    // status='failed' update のみが入る
    expect(
      dbState.updatedSourceDocs.some((u) => u.status === 'completed'),
    ).toBe(false)
    expect(
      dbState.updatedSourceDocs.some((u) => u.status === 'failed'),
    ).toBe(true)
    // markFailed が upload_records に failed 行を append (実 cost / pages を計上)
    const failedRec = dbState.insertedUploadRecords.find(
      (r) => r.status === 'failed',
    )
    expect(failedRec).toMatchObject({ pagesProcessed: 1, ocrCostYen: 5 })
    // ops 通知が飛ぶ
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'completion transaction failed after ocr success',
      expect.objectContaining({ userId: 'user-uuid' }),
    )
  })

  it('OcrDeadlineError → GEMINI_FAILED with user-friendly message, errorMessage in source_doc is user-friendly', async () => {
    const { OcrDeadlineError } = await import('@/lib/ai/ocr')
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockRejectedValueOnce(new OcrDeadlineError())
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('GEMINI_FAILED')
    // user-friendly message (deadline 専用)
    expect(result.error).toMatch(/処理時間が長すぎました/)
    // source_documents.errorMessage も user-friendly (slice(0,500) は維持)
    const failedUpdate = dbState.updatedSourceDocs.find((u) => u.status === 'failed')
    expect(failedUpdate).toBeDefined()
    expect(failedUpdate?.errorMessage).toMatch(/処理時間が長すぎました/)
    // notifyOps は通常の OCR 失敗と同様に呼ばれる
    // かつ技術的メッセージ (OcrDeadlineError 本文) を受け取る — user-friendly 文言が漏れていないことを確認
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'ocr pipeline failed',
      expect.objectContaining({
        userId: 'user-uuid',
        error: expect.stringContaining('720000'),
      }),
    )
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'ocr pipeline failed',
      expect.objectContaining({
        error: expect.not.stringContaining('処理時間が長すぎました'),
      }),
    )
  })

  it('non-deadline OCR failure → GEMINI_FAILED with 混み合っている message (既存文言維持)', async () => {
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockRejectedValueOnce(new Error('some transient error'))
    const fd = makeFormData({ mode: 'new', files: [sampleImage] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('GEMINI_FAILED')
    expect(result.error).toMatch(/混み合っているようです/)
    // user-friendly deadline message は出ない
    expect(result.error).not.toMatch(/処理時間が長すぎました/)
  })

  // server-side hard cap (plan-limits とは独立)、 guard tx 前に early return
  // OCR_MAX_PAGES を超えた場合は guard transaction より前に early return し、
  // DB を一切触らない (exam / source_documents INSERT なし、 markFailed も不要)。
  it('PAGE_LIMIT_EXCEEDED (41 pages): early return before guard tx, no DB writes', async () => {
    // 41 枚の画像 = totalPages 41
    const images = Array.from({ length: 41 }, (_, i) =>
      new File(['img'], `page${i}.jpg`, { type: 'image/jpeg' }),
    )
    const fd = makeFormData({ mode: 'new', files: images })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('PAGE_LIMIT_EXCEEDED')
    expect(result.error).toMatch(/\d+ ページ/)
    // DB を一切触らない (guard transaction が呼ばれない)
    expect(dbState.insertedExams).toHaveLength(0)
    expect(dbState.insertedSourceDocs).toHaveLength(0)
    expect(dbState.insertedCards).toHaveLength(0)
    expect(dbState.insertedUploadRecords).toHaveLength(0)
    // plan-limits (canRunOcr) は呼ばれない (40-page check が先)
    expect(mockCanRunOcr).not.toHaveBeenCalled()
    expect(mockRunOcrPipeline).not.toHaveBeenCalled()
  })

  it('PAGE_LIMIT_EXCEEDED boundary: 40 pages passes, 41 pages fails', async () => {
    // 40 枚 → 通過 (canRunOcr + OCR を呼ぶ)
    const images40 = Array.from({ length: 40 }, (_, i) =>
      new File(['img'], `page${i}.jpg`, { type: 'image/jpeg' }),
    )
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 0 })
    mockRunOcrPipeline.mockResolvedValueOnce({
      cards: [],
      modelChain: ['flash'],
      costYen: 0,
      tokenUsage: [],
    })
    dbState.nextCardIds = []
    const fd40 = makeFormData({ mode: 'new', files: images40 })
    const { processUpload } = await importProcess()
    await processUpload(fd40)
    // 40 pages は guard を通過して OCR pipeline に至る (= canRunOcr が呼ばれる)
    expect(mockCanRunOcr).toHaveBeenCalledTimes(1)

    // 41 枚 → PAGE_LIMIT_EXCEEDED
    mockCanRunOcr.mockReset()
    dbState.insertedExams = []
    dbState.insertedSourceDocs = []
    const images41 = Array.from({ length: 41 }, (_, i) =>
      new File(['img'], `page${i}.jpg`, { type: 'image/jpeg' }),
    )
    const fd41 = makeFormData({ mode: 'new', files: images41 })
    const result41 = await processUpload(fd41)
    expect(result41.ok).toBe(false)
    if (result41.ok) throw new Error('expected fail')
    expect(result41.code).toBe('PAGE_LIMIT_EXCEEDED')
    expect(mockCanRunOcr).not.toHaveBeenCalled()
    expect(dbState.insertedExams).toHaveLength(0)
    expect(dbState.insertedSourceDocs).toHaveLength(0)
  })

  it('PAGE_LIMIT_EXCEEDED: canRunOcr=ok でも 40 超で弾かれる (独立 check)', async () => {
    // plan-limits は OK を返せる状態でも、 40 page 上限で独立に弾かれることを確認
    mockCanRunOcr.mockResolvedValue({ ok: true, remaining: 100 })
    const images = Array.from({ length: 41 }, (_, i) =>
      new File(['img'], `page${i}.jpg`, { type: 'image/jpeg' }),
    )
    const fd = makeFormData({ mode: 'new', files: images })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('PAGE_LIMIT_EXCEEDED')
    // canRunOcr は呼ばれない (40-page check が先に弾く)
    expect(mockCanRunOcr).not.toHaveBeenCalled()
  })

  it('PAGE_LIMIT_EXCEEDED: revalidatePath は early return でも呼ばれる (finally ブロック)', async () => {
    const images = Array.from({ length: 41 }, (_, i) =>
      new File(['img'], `page${i}.jpg`, { type: 'image/jpeg' }),
    )
    const fd = makeFormData({ mode: 'new', files: images })
    const { processUpload } = await importProcess()
    await processUpload(fd)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app')
    expect(mockRevalidatePath).toHaveBeenCalledTimes(2)
  })

  // server-side 合計サイズ上限 (client すり抜け防止)、 guard tx 前に early return。
  // SIZE_LIMIT_EXCEEDED: totalSize > TOTAL_UPLOAD_LIMIT_BYTES (4MB) の場合、
  // DB を一切触らずに返す (source_documents 未作成のため markFailed も不要)。
  it('SIZE_LIMIT_EXCEEDED (5MB): early return before getDb, no DB writes', async () => {
    // 5MB 相当のファイルを作る (File.size は content の byte 数で決まる)
    const bigContent = new Uint8Array(5_000_001)
    const bigFile = new File([bigContent], 'big.jpg', { type: 'image/jpeg' })
    const fd = makeFormData({ mode: 'new', files: [bigFile] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.code).toBe('SIZE_LIMIT_EXCEEDED')
    expect(result.error).toMatch(/4 MB/)
    // DB を一切触らない (getDb / guard transaction が呼ばれない)
    expect(dbState.insertedExams).toHaveLength(0)
    expect(dbState.insertedSourceDocs).toHaveLength(0)
    expect(dbState.insertedCards).toHaveLength(0)
    expect(dbState.insertedUploadRecords).toHaveLength(0)
    // plan-limits / OCR pipeline は呼ばれない
    expect(mockCanRunOcr).not.toHaveBeenCalled()
    expect(mockRunOcrPipeline).not.toHaveBeenCalled()
  })

  it('SIZE_LIMIT_EXCEEDED boundary: 4MB 以内は通過し OCR pipeline に至る', async () => {
    // 4MB ぴったり (= TOTAL_UPLOAD_LIMIT_BYTES) → 通過
    const content4mb = new Uint8Array(4_000_000)
    const file4mb = new File([content4mb], 'ok.jpg', { type: 'image/jpeg' })
    mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 29 })
    mockRunOcrPipeline.mockResolvedValueOnce({
      cards: [],
      modelChain: ['flash'],
      costYen: 0,
      tokenUsage: [],
    })
    dbState.nextCardIds = []
    const fd = makeFormData({ mode: 'new', files: [file4mb] })
    const { processUpload } = await importProcess()
    await processUpload(fd)
    // 4MB 以内は size check を通過して OCR pipeline に至る (= canRunOcr が呼ばれる)
    expect(mockCanRunOcr).toHaveBeenCalledTimes(1)
  })

  it('SIZE_LIMIT_EXCEEDED: page check と独立して弾く (40 ページ以内でもサイズ超過は弾く)', async () => {
    // 1 枚の画像でも 5MB 超ならば PAGE_LIMIT_EXCEEDED とは無関係に弾かれる
    const bigContent = new Uint8Array(5_000_001)
    const bigFile = new File([bigContent], 'single-big.jpg', { type: 'image/jpeg' })
    const fd = makeFormData({ mode: 'new', files: [bigFile] })
    const { processUpload } = await importProcess()
    const result = await processUpload(fd)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    // SIZE_LIMIT_EXCEEDED (not PAGE_LIMIT_EXCEEDED) — totalPages=1 だが size で弾かれる
    expect(result.code).toBe('SIZE_LIMIT_EXCEEDED')
    expect(mockCanRunOcr).not.toHaveBeenCalled()
    expect(dbState.insertedExams).toHaveLength(0)
    expect(dbState.insertedSourceDocs).toHaveLength(0)
  })

  it('SIZE_LIMIT_EXCEEDED: revalidatePath は early return でも呼ばれる (finally ブロック)', async () => {
    const bigContent = new Uint8Array(5_000_001)
    const bigFile = new File([bigContent], 'big.jpg', { type: 'image/jpeg' })
    const fd = makeFormData({ mode: 'new', files: [bigFile] })
    const { processUpload } = await importProcess()
    await processUpload(fd)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app')
    expect(mockRevalidatePath).toHaveBeenCalledTimes(2)
  })
})
