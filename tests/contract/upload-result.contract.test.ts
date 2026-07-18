/**
 * tests/contract/upload-result.contract.test.ts
 *
 * Wire-contract snapshot for processUpload() Server Action.
 *
 * Frozen faces (spec §3.2 upload row + P0 brief Task 5):
 *   1. ProcessUploadResult union shape — both variants:
 *        ok:true  → full ProcessResultData shape (sourceDocumentId, examId, examName,
 *                   cardsExtracted, ocrCostYen, modelChain, cards[])
 *        ok:false → code + error string + optional details
 *   2. All 11 error codes — each frozen with its user-facing error message
 *   3. revalidatePath('/app/upload') AND revalidatePath('/app') ALWAYS fire (finally block)
 *        — asserted on: success, error-return, AND _processUpload throw (production fail-fast)
 *   4. markFailed side-effect (OTHER path): sourceDocumentId + errorMessage captured in
 *        updatedSourceDocs + insertedUploadRecords — hard assertions, not snapshot
 *
 * ── Multi-branch inventory for §B handoff ────────────────────────────────────
 *
 * INVALID_INPUT (3 branches, all with distinct messages):
 *   Branch A: mode invalid/missing       → '投入先が指定されていません'           [FROZEN — representative]
 *   Branch B: mode=existing + no examId  → '既存の試験が選択されていません'        [documented only]
 *   Branch C: no files                  → 'ファイルが選択されていません'           [documented only]
 *   Rationale: all three messages differ; Task 9 §B should add B/C if message drift is a concern.
 *
 * EXAM_NOT_FOUND (2 branches, different messages — both frozen):
 *   Branch A: exam not found (found.length === 0) → '選択された試験が見つかりません'    [FROZEN]
 *   Branch B: exam archived (archivedAt !== null)  → 'アーカイブ済の試験には追加できません' [FROZEN]
 *
 * GEMINI_FAILED (2 branches, different messages):
 *   Branch A: OcrDeadlineError → '処理時間が長すぎました...'       [documented only]
 *   Branch B: other error      → '混み合っているようです...'         [FROZEN — representative]
 *
 * SAVE_FAILED (2 branches, same message):
 *   Branch A: cards INSERT failure (incl. applyOcrTags throw) → '抽出結果の保存に失敗しました' [FROZEN]
 *   Branch B: completion tx failure                           → '抽出結果の保存に失敗しました' [skipped — identical message]
 *
 * NOT frozen (§A-excluded):
 *   - Internal logger payloads (event/err fields)
 *   - notifyOps payloads (ops-channel content)
 *   - GEMINI_FAILED/OcrDeadlineError branch (same code; Branch B message frozen)
 *   - SAVE_FAILED completion-tx branch (same message as Branch A)
 *   - INVALID_INPUT branches B & C (same code; Task 9 §B records)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { stubClock, restoreClock } from '../fixtures/common'

// ─── Fixed deterministic values ───────────────────────────────────────────────
// Visually distinct from real UUIDs; used across all tests for repeatable .snap.
const FIXED_USER_ID        = 'aaaa0000-0000-4000-a000-000000000001' as const
const FIXED_SOURCE_DOC_ID  = 'sdoc0000-0000-4000-a000-000000000002' as const
const FIXED_EXAM_NEW_ID    = 'exam0000-0000-4000-a000-000000000003' as const
const FIXED_EXAM_EXIST_ID  = 'exex0000-0000-4000-a000-000000000004' as const
const FIXED_CARD_ID        = 'card0000-0000-4000-a000-000000000005' as const

// ─── Hoisted mock state (runs before vi.mock factories & module imports) ───────
const {
  mockGetCurrentUser,
  mockRunOcrPipeline,
  mockCanRunOcr,
  mockNotifyOps,
  mockPdfPageCount,
  mockIncrementAiUsage,
  mockGetTodayAiUsageGlobal,
  mockRevalidatePath,
  mockApplyOcrTags,
  dbState,
} = vi.hoisted(() => ({
  mockGetCurrentUser:        vi.fn(),
  mockRunOcrPipeline:        vi.fn(),
  mockCanRunOcr:             vi.fn(),
  mockNotifyOps:             vi.fn(),
  mockPdfPageCount:          vi.fn(),
  mockIncrementAiUsage:      vi.fn(),
  mockGetTodayAiUsageGlobal: vi.fn(),
  mockRevalidatePath:        vi.fn(),
  mockApplyOcrTags:          vi.fn(),
  dbState: {
    // Capture arrays (reset in beforeEach via resetDbState())
    insertedExams:        [] as Array<{ name: string; userId: string }>,
    insertedSourceDocs:   [] as Array<Record<string, unknown>>,
    insertedCards:        [] as Array<Record<string, unknown>>,
    insertedUploadRecords: [] as Array<Record<string, unknown>>,
    updatedSourceDocs:    [] as Array<Record<string, unknown>>,
    updatedExams:         [] as Array<Record<string, unknown>>,
    // DB state knobs
    selectedExam: null as { id: string; name: string; archivedAt: Date | null } | null,
    nextExamId:         'exam0000-0000-4000-a000-000000000003',
    nextSourceDocId:    'sdoc0000-0000-4000-a000-000000000002',
    nextCardIds:        ['card0000-0000-4000-a000-000000000005'],
    advisoryLockAcquired:   true,
    inflightProcessingDoc:  null as { id: string } | null,
    completionTxShouldFail: false,
  },
}))

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

// importOriginal ensures OcrDeadlineError class is real (instanceof checks work).
vi.mock('@/lib/ai/ocr', async (importOriginal) => {
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
  incrementAiUsage:      mockIncrementAiUsage,
  getTodayAiUsageGlobal: mockGetTodayAiUsageGlobal,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
}))

vi.mock('@/lib/tags/apply-ocr-tags', () => ({
  applyOcrTags: mockApplyOcrTags,
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// pdf-page-count is imported by process.ts as '../_lib/pdf-page-count' (relative
// to app/(app)/app/upload/_actions/). Vitest resolves both paths to the same
// absolute module, so this mock intercepts the import inside process.ts.
vi.mock('../../app/(app)/app/upload/_lib/pdf-page-count', () => ({
  pdfPageCount: mockPdfPageCount,
}))

// ─── DB chain mock ────────────────────────────────────────────────────────────
// Ported from the co-located process.test.ts (do NOT modify process.test.ts).
// Handles advisory lock, in-flight check, guard tx, cards INSERT, completion tx,
// and markFailed tx. Captures DB writes for contract assertions.
vi.mock('@/lib/db', () => {
  function chain(returnValue: unknown) {
    const obj: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'limit', 'set']) obj[m] = () => obj
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(returnValue).then(onFulfilled, onRejected)
    return obj
  }

  function dbApi(isGuardTx = false) {
    let guardSelectCallCount = 0
    return {
      // advisory xact lock — postgres-js returns RowList (Array-like)
      execute: (_sql: unknown) =>
        Promise.resolve([{ locked: dbState.advisoryLockAcquired }]),
      select: () => {
        let rv: unknown
        if (isGuardTx) {
          rv = guardSelectCallCount === 0
            ? (dbState.inflightProcessingDoc ? [dbState.inflightProcessingDoc] : [])
            : (dbState.selectedExam ? [dbState.selectedExam] : [])
          guardSelectCallCount++
        } else {
          rv = dbState.selectedExam ? [dbState.selectedExam] : []
        }
        return chain(rv)
      },
      insert: () => ({
        values: (rows: unknown) => {
          let rv: unknown
          if (Array.isArray(rows)) {
            // cards bulk INSERT
            dbState.insertedCards.push(...(rows as Record<string, unknown>[]))
            rv = dbState.nextCardIds.slice(0, rows.length).map((id, i) => ({
              id,
              title: (rows as { title: string }[])[i]?.title ?? '',
            }))
          } else {
            const row = rows as Record<string, unknown>
            if ('fileType' in row) {
              dbState.insertedSourceDocs.push(row)
              rv = [{ id: dbState.nextSourceDocId }]
            } else if ('name' in row) {
              dbState.insertedExams.push({ name: row.name as string, userId: row.userId as string })
              rv = [{ id: dbState.nextExamId }]
            } else if ('status' in row) {
              // upload_records
              dbState.insertedUploadRecords.push(row)
              rv = []
            } else {
              rv = []
            }
          }
          const c = chain(rv) as Record<string, unknown>
          c.returning = () => chain(rv)
          return c
        },
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          if ('cardCount' in vals) dbState.updatedExams.push(vals)
          else dbState.updatedSourceDocs.push(vals)
          // O1: completeUploadTx / markFailed が owner-scope 述語追加後に
          // .returning({ id }) で affected rows を確認するため returning を生やす。
          // mock は常に 1 行 affected を返し happy path の分岐を維持する。
          const c = chain(undefined) as Record<string, unknown>
          c.returning = () => chain([{ id: dbState.nextSourceDocId }])
          return c
        },
      }),
      delete: () => chain(undefined),
    }
  }

  return {
    getDb: () => {
      let localTxCallCount = 0
      return {
        ...dbApi(false),
        transaction: async (fn: (tx: ReturnType<typeof dbApi>) => Promise<unknown>) => {
          const isGuardTx = localTxCallCount === 0
          const txIndex   = localTxCallCount
          localTxCallCount++
          if (txIndex === 2 && dbState.completionTxShouldFail) {
            throw new Error('Neon connection lost during completion tx')
          }
          return await fn(dbApi(isGuardTx) as ReturnType<typeof dbApi>)
        },
      }
    },
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function importProcess() {
  return await import('@/app/(app)/app/upload/_actions/process')
}

function makeFormData(opts: {
  mode: 'new' | 'existing' | string | null
  examId?: string
  files: File[]
}): FormData {
  const fd = new FormData()
  if (opts.mode !== null) fd.set('mode', opts.mode)
  if (opts.examId) fd.set('examId', opts.examId)
  for (const f of opts.files) fd.append('files', f)
  return fd
}

const sampleImage = new File(['imagedata'], 'photo.jpg', { type: 'image/jpeg' })

const FAKE_USER = {
  id: FIXED_USER_ID,
  clerkId: 'clerk-contract-test',
  email: 'contract@test.example',
  plan: 'free' as const,
  billingInterval: null,
  deletedAt: null,
  stripeCustomerId: null,
}

// Deterministic OCR result used in success and some error paths.
// All field values are fixed constants — never random.
const MOCK_OCR_RESULT = {
  cards: [
    {
      title: 'Contract Test Card Title',
      question_text: 'What does the contract test verify?',
      options: [
        { id: 'opt-a', text: 'Union shape + 11 codes + revalidate', is_correct: true },
        { id: 'opt-b', text: 'Nothing', is_correct: false },
      ],
      correct_answer_ids: ['opt-a'],
      images: [],
      custom_props: { subject: 'contract' },
    },
  ],
  modelChain: ['gemini-2.5-flash'],
  costYen: 7,
  tokenUsage: [{ model: 'gemini-2.5-flash', inputTokens: 1000, outputTokens: 200 }],
}

function resetDbState() {
  dbState.insertedExams         = []
  dbState.insertedSourceDocs    = []
  dbState.insertedCards         = []
  dbState.insertedUploadRecords = []
  dbState.updatedSourceDocs     = []
  dbState.updatedExams          = []
  dbState.selectedExam          = null
  dbState.nextExamId            = FIXED_EXAM_NEW_ID
  dbState.nextSourceDocId       = FIXED_SOURCE_DOC_ID
  dbState.nextCardIds           = [FIXED_CARD_ID]
  dbState.advisoryLockAcquired  = true
  dbState.inflightProcessingDoc = null
  dbState.completionTxShouldFail = false
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Pin the clock: Date.now() / new Date() return 2026-07-06T00:00:00.000Z
  // todayInJst() → '2026-07-06', JST HH:mm → '09:00'
  // → examName for mode:new = 'アップロード 2026-07-06 09:00'
  vi.useFakeTimers()
  stubClock()

  mockGetCurrentUser.mockReset()
  mockRunOcrPipeline.mockReset()
  mockCanRunOcr.mockReset()
  mockNotifyOps.mockReset()
  mockPdfPageCount.mockReset()
  mockIncrementAiUsage.mockReset()
  mockGetTodayAiUsageGlobal.mockReset()
  mockRevalidatePath.mockReset()
  mockApplyOcrTags.mockReset()

  // Guard-passing defaults
  mockGetCurrentUser.mockResolvedValue(FAKE_USER)
  mockCanRunOcr.mockResolvedValue({ ok: true, remaining: 100 })
  mockGetTodayAiUsageGlobal.mockResolvedValue(0)
  mockIncrementAiUsage.mockResolvedValue(undefined)
  mockApplyOcrTags.mockResolvedValue(undefined)
  mockNotifyOps.mockResolvedValue(undefined)

  delete process.env.GEMINI_DAILY_LIMIT
  delete process.env.VERCEL_ENV

  resetDbState()
})

afterEach(() => {
  restoreClock()
  vi.restoreAllMocks()
  // Clean production env in case a test set it
  delete process.env.VERCEL_ENV
  delete process.env.GEMINI_DAILY_LIMIT
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('processUpload — wire contract', () => {

  // ─── 1. Success union variant ─────────────────────────────────────────────

  describe('ok:true — success data shape', () => {
    it('full ProcessResultData snapshot (mode:new, 1 card)', async () => {
      mockRunOcrPipeline.mockResolvedValueOnce(MOCK_OCR_RESULT)
      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)

      expect(result.ok).toBe(true)
      // Full union variant frozen: sourceDocumentId, examId, examName,
      // cardsExtracted, ocrCostYen, modelChain, cards[{ id, title,
      // questionTextSnippet, optionCount }]
      expect(result).toMatchSnapshot()
    })
  })

  // ─── 2. All 11 error codes ────────────────────────────────────────────────

  describe('ok:false — 11 error codes with user-facing messages', () => {

    it('AUTH: getCurrentUser returns null → { code: AUTH }', async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null)
      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      expect(result).toMatchSnapshot()
    })

    // INVALID_INPUT Branch A (representative): mode absent/invalid
    // Branch B (existing + no examId): '既存の試験が選択されていません' — documented, Task 9 §B
    // Branch C (no files):              'ファイルが選択されていません'   — documented, Task 9 §B
    it('INVALID_INPUT (Branch A — mode-invalid): { code: INVALID_INPUT, error: 投入先が指定されていません }', async () => {
      const fd = makeFormData({ mode: 'bad-value', files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      expect(result).toMatchSnapshot()
    })

    // EXAM_NOT_FOUND has 2 branches with distinct messages — both frozen.
    it('EXAM_NOT_FOUND (Branch A — not found): { code: EXAM_NOT_FOUND, error: 選択された試験が見つかりません }', async () => {
      // dbState.selectedExam = null → guard tx returns exam_not_found (archived:false)
      dbState.selectedExam = null
      const fd = makeFormData({ mode: 'existing', examId: FIXED_EXAM_EXIST_ID, files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      expect(result).toMatchSnapshot()
    })

    it('EXAM_NOT_FOUND (Branch B — archived): { code: EXAM_NOT_FOUND, error: アーカイブ済の試験には追加できません }', async () => {
      dbState.selectedExam = {
        id: FIXED_EXAM_EXIST_ID,
        name: '旧試験',
        archivedAt: new Date('2026-01-01T00:00:00.000Z'),
      }
      const fd = makeFormData({ mode: 'existing', examId: FIXED_EXAM_EXIST_ID, files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      expect(result).toMatchSnapshot()
    })

    it('UPLOAD_IN_PROGRESS (advisory lock fails): { code: UPLOAD_IN_PROGRESS }', async () => {
      dbState.advisoryLockAcquired = false
      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      expect(result).toMatchSnapshot()
    })

    it('PAGE_LIMIT_EXCEEDED (41 images): { code: PAGE_LIMIT_EXCEEDED }', async () => {
      const images = Array.from({ length: 41 }, (_, i) =>
        new File(['x'], `p${i}.jpg`, { type: 'image/jpeg' }),
      )
      const fd = makeFormData({ mode: 'new', files: images })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      expect(result).toMatchSnapshot()
    })

    it('SIZE_LIMIT_EXCEEDED (5MB file): { code: SIZE_LIMIT_EXCEEDED }', async () => {
      const bigFile = new File([new Uint8Array(5_000_001)], 'big.jpg', { type: 'image/jpeg' })
      const fd = makeFormData({ mode: 'new', files: [bigFile] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      expect(result).toMatchSnapshot()
    })

    it('QUOTA_EXCEEDED: { code: QUOTA_EXCEEDED, details: { current, limit, requested } }', async () => {
      mockCanRunOcr.mockResolvedValueOnce({
        ok: false, reason: 'exceeded', current: 30, limit: 30, requested: 1,
      })
      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      expect(result).toMatchSnapshot()
    })

    it('GEMINI_DAILY_LIMIT_EXCEEDED: { code: GEMINI_DAILY_LIMIT_EXCEEDED, details: { current, limit } }', async () => {
      process.env.GEMINI_DAILY_LIMIT = '5'
      mockGetTodayAiUsageGlobal.mockResolvedValueOnce(5)
      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      expect(result).toMatchSnapshot()
    })

    // GEMINI_FAILED Branch B (representative — non-deadline error)
    // Branch A (OcrDeadlineError): '処理時間が長すぎました...' — documented, same code
    it('GEMINI_FAILED (Branch B — non-deadline): { code: GEMINI_FAILED, details.rawError, details.sourceDocumentId }', async () => {
      mockRunOcrPipeline.mockRejectedValueOnce(new Error('flash-503: service unavailable'))
      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      // details.sourceDocumentId must be the fixed ID (determinism)
      if (!result.ok) {
        expect(result.details?.sourceDocumentId).toBe(FIXED_SOURCE_DOC_ID)
      }
      expect(result).toMatchSnapshot()
    })

    // SAVE_FAILED Branch A: cards INSERT failure via applyOcrTags throw
    // Branch B (completion tx failure): same message '抽出結果の保存に失敗しました' — skipped
    it('SAVE_FAILED (Branch A — cards INSERT/applyOcrTags failure): { code: SAVE_FAILED, details.* }', async () => {
      mockRunOcrPipeline.mockResolvedValueOnce(MOCK_OCR_RESULT)
      mockApplyOcrTags.mockRejectedValueOnce(new Error('NOT NULL violation in tag_options'))
      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.details?.sourceDocumentId).toBe(FIXED_SOURCE_DOC_ID)
      }
      expect(result).toMatchSnapshot()
    })

    // OTHER path: arrayBuffer() throws → markFailed is called, code=OTHER
    it('OTHER (file read failure — arrayBuffer throw): { code: OTHER, details.rawError, details.sourceDocumentId }', async () => {
      // Create a file that passes size/type filters but fails on arrayBuffer()
      const badFile = new File(['x'], 'bad.jpg', { type: 'image/jpeg' })
      // Override own property to shadow Blob.prototype.arrayBuffer
      ;(badFile as unknown as Record<string, unknown>).arrayBuffer =
        () => Promise.reject(new Error('disk read error'))

      const fd = makeFormData({ mode: 'new', files: [badFile] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.details?.sourceDocumentId).toBe(FIXED_SOURCE_DOC_ID)
      }
      expect(result).toMatchSnapshot()
    })
  })

  // ─── 3. revalidatePath always fires (finally block) ───────────────────────

  describe('revalidatePath ALWAYS fires — both calls, all paths', () => {

    it('fires on success path: exactly 2 calls (/app/upload + /app)', async () => {
      mockRunOcrPipeline.mockResolvedValueOnce(MOCK_OCR_RESULT)
      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()
      await processUpload(fd)

      expect(mockRevalidatePath).toHaveBeenCalledTimes(2)
      expect(mockRevalidatePath).toHaveBeenNthCalledWith(1, '/app/upload')
      expect(mockRevalidatePath).toHaveBeenNthCalledWith(2, '/app')
    })

    it('fires on error-return path (AUTH): exactly 2 calls (/app/upload + /app)', async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null)
      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)

      expect(result.ok).toBe(false)
      expect(mockRevalidatePath).toHaveBeenCalledTimes(2)
      expect(mockRevalidatePath).toHaveBeenNthCalledWith(1, '/app/upload')
      expect(mockRevalidatePath).toHaveBeenNthCalledWith(2, '/app')
    })

    // Production fail-fast causes _processUpload to throw (not error-return).
    // The finally block in processUpload must still fire BOTH revalidatePath calls
    // before the throw propagates.
    it('fires on throw path (_processUpload rejects — production GEMINI_DAILY_LIMIT fail-fast): exactly 2 calls', async () => {
      process.env.VERCEL_ENV = 'production'
      delete process.env.GEMINI_DAILY_LIMIT
      // canRunOcr passes so the guard tx reaches parseDailyLimit()
      mockCanRunOcr.mockResolvedValueOnce({ ok: true, remaining: 100 })

      const fd = makeFormData({ mode: 'new', files: [sampleImage] })
      const { processUpload } = await importProcess()

      // processUpload must reject (throw propagates through finally)
      await expect(processUpload(fd)).rejects.toThrow('GEMINI_DAILY_LIMIT must be set in production')

      // But revalidatePath was called in the finally block BEFORE the throw propagated
      expect(mockRevalidatePath).toHaveBeenCalledTimes(2)
      expect(mockRevalidatePath).toHaveBeenNthCalledWith(1, '/app/upload')
      expect(mockRevalidatePath).toHaveBeenNthCalledWith(2, '/app')
    })
  })

  // ─── 4. markFailed side-effect capture (OTHER path) ──────────────────────
  //
  // markFailed() is a private function inside process.ts; its effects are
  // observable via the DB mock: status='failed' update on source_documents
  // (with errorMessage) and a failed row in upload_records.
  // Hard assertions (not snapshot) — per brief: "freeze that markFailed is
  // invoked (captured args: sourceDocumentId present, error message)".

  describe('markFailed side-effect — OTHER path (file read failure)', () => {
    it('markFailed: status=failed update with errorMessage + failed upload_record inserted', async () => {
      const badFile = new File(['x'], 'bad.jpg', { type: 'image/jpeg' })
      ;(badFile as unknown as Record<string, unknown>).arrayBuffer =
        () => Promise.reject(new Error('disk read error'))

      const fd = makeFormData({ mode: 'new', files: [badFile] })
      const { processUpload } = await importProcess()
      const result = await processUpload(fd)

      expect(result.ok).toBe(false)

      // sourceDocumentId in result.details must match the fixed guard-tx sdoc id
      if (!result.ok) {
        expect(result.code).toBe('OTHER')
        expect(result.details?.sourceDocumentId).toBe(FIXED_SOURCE_DOC_ID)
        expect(result.details?.rawError).toBe('disk read error')
      }

      // markFailed wrote status='failed' + errorMessage to source_documents
      const failedUpdate = dbState.updatedSourceDocs.find(
        (u) => u['status'] === 'failed',
      )
      expect(failedUpdate).toBeDefined()
      expect(failedUpdate?.['errorMessage']).toBe('disk read error')

      // markFailed appended a status='failed' row to upload_records
      const failedRecord = dbState.insertedUploadRecords.find(
        (r) => r['status'] === 'failed',
      )
      expect(failedRecord).toBeDefined()
      expect(failedRecord?.['userId']).toBe(FIXED_USER_ID)
      expect(failedRecord?.['pagesProcessed']).toBe(0)
      expect(failedRecord?.['ocrCostYen']).toBe(0)
    })
  })
})
