// ②-4a 単一 invocation Sprint Task S-2: runUploadPipeline(OCR phase)の実 PG 検証。
//
// Gemini(callGemini)を mock し(実 API 禁止・CLAUDE.md AI 絶対ルール 3)、sharp は
// 実実装のまま(実バイトの decode 検証が本 phase の要件そのもの)。R2 client は
// 全 export を spy にして「1 度も呼ばれない」ことを pin する — 新経路は request
// body のバイトだけで OCR を回し source を R2 に置かない(spec §2)。
//
// 検証対象: prepared_payload の fenced CAS commit(processing + lease_version 一致 →
// prepared)/ 失敗系の terminal 化(op terminal_failed + doc failed が同一 tx)/
// ai_usage が Gemini attempt ごとに +1。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/lib/db'
import { aiUsage, exams, sourceDocuments, uploadOperations, users } from '@/lib/db/schema'
import { todayInJst } from '@/lib/jst'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

const { mockCallGemini, ...r2Spies } = vi.hoisted(() => ({
  mockCallGemini: vi.fn(),
  presignPutUrl: vi.fn(),
  presignGetUrl: vi.fn(),
  headObject: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}))

vi.mock('@/lib/storage/r2', () => r2Spies)
// parseRetryAfterMs は実実装のまま(stage-prepared.test.ts と同じ importOriginal 方式)。
vi.mock('@/lib/ai/clients/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/clients/gemini')>()
  return { ...actual, callGemini: mockCallGemini }
})

// vi.mock は import より前に hoist される。
import { GEMINI_TIMEOUT_MS, type GeminiContentPart } from '@/lib/ai/clients/gemini'
import {
  runUploadPipeline,
  type UploadPipelineFile,
} from '@/app/(app)/app/upload/_lib/upload-pipeline'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

const VALID_CARD = {
  title: '問 1',
  question_text: '設問本文',
  options: [
    { id: 'a', text: '選択肢 A', is_correct: true },
    { id: 'b', text: '選択肢 B', is_correct: false },
  ],
}

function geminiOk(body: unknown = { cards: [VALID_CARD] }) {
  return {
    text: JSON.stringify(body),
    inputTokens: 10,
    outputTokens: 20,
    thoughtsTokens: 0,
  }
}

// transient(5xx)+ retry-after-ms:1 → callImageCropWithRetry が 1ms の backoff で
// 即 retry する(実 backoff 5s+jitter を待たずに「attempt ごとに +1」を観測する)。
function transientErrorWithFastRetry(): Error {
  const err = new Error('503 Service Unavailable')
  Object.assign(err, { headers: new Headers({ 'retry-after-ms': '1' }) })
  return err
}

async function pngBytes(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer()
}

describe('runUploadPipeline (S-2)', () => {
  let userAId: string
  let operationId: string
  let examId: string
  let sourceDocumentId: string
  let files: UploadPipelineFile[]
  const today = todayInJst()

  beforeEach(async () => {
    await truncateAllUserTables()
    mockCallGemini.mockReset()
    mockCallGemini.mockResolvedValue(geminiOk())
    for (const spy of Object.values(r2Spies)) spy.mockReset()

    const owner = getFixtureOwnerDb()
    await owner.delete(aiUsage).where(eq(aiUsage.date, today))

    userAId = randomUUID()
    await owner.insert(users).values({ id: userAId, clerkId: `clerk_A_${userAId}` })
    examId = randomUUID()
    await owner.insert(exams).values({ id: examId, userId: userAId, name: 'テスト試験' })
    sourceDocumentId = randomUUID()
    await owner.insert(sourceDocuments).values({
      id: sourceDocumentId,
      userId: userAId,
      examId,
      mode: 'new',
      fileType: 'image',
      filename: 'p1.png ほか 1 件',
      fileSizeBytes: 2000,
      status: 'processing',
      pagesTotal: 2,
    })
    operationId = randomUUID()
    await owner.insert(uploadOperations).values({
      id: operationId,
      userId: userAId,
      idempotencyKey: `idem-${operationId}`,
      examId,
      sourceDocumentId,
      status: 'processing',
      leaseVersion: 0,
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attemptCount: 0,
      expectedSourceCount: 2,
    })

    files = [
      { buffer: await pngBytes(8, 6), filename: 'p1.png' },
      { buffer: await pngBytes(10, 4), filename: 'p2.png' },
    ]
  })

  afterEach(async () => {
    await getFixtureOwnerDb().delete(aiUsage).where(eq(aiUsage.date, today))
  })

  // budgetMs の既定は「retry が実際に走る余裕」= 1 attempt(GEMINI_TIMEOUT_MS)の 2 倍
  // から導出する。literal を置くと GEMINI_TIMEOUT_MS を伸ばしたときに静かに
  // 「予算不足で 1 attempt」へ退化する(pre-call gate / retry 打ち切りの両方が
  // 残余 < GEMINI_TIMEOUT_MS を基準にするため)。
  function run(leaseVersion = 0, budgetMs = GEMINI_TIMEOUT_MS * 2): Promise<void> {
    return runUploadPipeline(
      userAId,
      { operationId, examId, sourceDocumentId },
      leaseVersion,
      files,
      new Date(Date.now() + budgetMs),
    )
  }

  async function readOperation() {
    const rows = await getFixtureOwnerDb()
      .select()
      .from(uploadOperations)
      .where(eq(uploadOperations.id, operationId))
    return rows[0]
  }

  async function readDocStatus(): Promise<string | undefined> {
    const rows = await getFixtureOwnerDb()
      .select({ status: sourceDocuments.status })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, sourceDocumentId))
    return rows[0]?.status
  }

  async function readAiUsage(): Promise<number> {
    const rows = await getFixtureOwnerDb()
      .select({ count: aiUsage.count })
      .from(aiUsage)
      .where(eq(aiUsage.date, today))
    return rows[0]?.count ?? 0
  }

  it('メモリのバイトで OCR し prepared_payload を commit する(R2 GET 0 回)', async () => {
    await run()

    const op = await readOperation()
    expect(op?.status).toBe('prepared')
    expect(op?.preparedSchemaVersion).toBe(1)
    expect(op?.preparedHash).toMatch(/^[0-9a-f]{64}$/)
    const payload = op?.preparedPayload as Record<string, unknown>
    expect(payload.schemaVersion).toBe(1)
    expect(payload.cardsTotal).toBe(1)
    expect((payload.cards as unknown[]).length).toBe(1)
    expect(op?.lastErrorCode).toBeNull()
    // 成功時点では source_document は processing のまま(publish = S-3 の責務)。
    expect(await readDocStatus()).toBe('processing')

    // R2 client は 1 度も呼ばれない(GET も PUT も無し)。
    for (const [name, spy] of Object.entries(r2Spies)) {
      expect(spy, `R2 client の ${name} が呼ばれた`).not.toHaveBeenCalled()
    }
  })

  it('Gemini が受け取る inlineData は渡した Buffer の base64 と一致する(受領順)', async () => {
    await run()

    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    const parts = mockCallGemini.mock.calls[0][0].parts as GeminiContentPart[]
    const images = parts.filter(
      (p): p is { inlineData: { mimeType: string; data: string } } => 'inlineData' in p,
    )
    expect(images.map((p) => p.inlineData.data)).toEqual(
      files.map((f) => f.buffer.toString('base64')),
    )
    // mime は実バイトの decode 結果(sharp)由来。
    expect(images.map((p) => p.inlineData.mimeType)).toEqual(['image/png', 'image/png'])
  })

  it('ai_usage は Gemini attempt ごとに +1(transient retry を含む)', async () => {
    mockCallGemini
      .mockRejectedValueOnce(transientErrorWithFastRetry())
      .mockResolvedValueOnce(geminiOk())

    await run()

    expect(mockCallGemini).toHaveBeenCalledTimes(2)
    expect(await readAiUsage()).toBe(2)
    expect((await readOperation())?.status).toBe('prepared')
  })

  it('429 は即停止(retry しない)で terminal + doc failed が同一 tx', async () => {
    mockCallGemini.mockRejectedValue(new Error('429 Too Many Requests'))

    await run()

    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(await readAiUsage()).toBe(1)
    const op = await readOperation()
    expect(op?.status).toBe('terminal_failed')
    expect(op?.lastErrorCode).toBe('gemini_rate_limited')
    expect(op?.leaseExpiresAt).toBeNull()
    expect(op?.preparedPayload).toBeNull()
    expect(await readDocStatus()).toBe('failed')
  })

  it('Gemini 呼出失敗(transient 尽き)は terminal(gemini_call_failed)', async () => {
    mockCallGemini.mockRejectedValue(new Error('400 Bad Request'))

    await run()

    const op = await readOperation()
    expect(op?.status).toBe('terminal_failed')
    expect(op?.lastErrorCode).toBe('gemini_call_failed')
    expect(await readDocStatus()).toBe('failed')
  })

  it('JSON が読めない応答は terminal(json_parse_failed)', async () => {
    mockCallGemini.mockResolvedValue({
      text: '{"cards": [',
      inputTokens: 1,
      outputTokens: 1,
      thoughtsTokens: 0,
    })

    await run()

    const op = await readOperation()
    expect(op?.status).toBe('terminal_failed')
    expect(op?.lastErrorCode).toBe('json_parse_failed')
    expect(await readDocStatus()).toBe('failed')
  })

  it('有効カード 0 は terminal(empty_cards)', async () => {
    mockCallGemini.mockResolvedValue(geminiOk({ cards: [] }))

    await run()

    const op = await readOperation()
    expect(op?.status).toBe('terminal_failed')
    expect(op?.lastErrorCode).toBe('empty_cards')
    expect(await readDocStatus()).toBe('failed')
  })

  it('decode できないバイトは Gemini を呼ばずに terminal(image_decode_failed)', async () => {
    // PNG magic は正しいが本体が壊れている = sniff は通り sharp decode で落ちる。
    files = [
      files[0],
      {
        buffer: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from('truncated'),
        ]),
        filename: 'broken.png',
      },
    ]

    await run()

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(await readAiUsage()).toBe(0)
    const op = await readOperation()
    expect(op?.status).toBe('terminal_failed')
    expect(op?.lastErrorCode).toBe('image_decode_failed')
    expect(await readDocStatus()).toBe('failed')
  })

  it('lease_version が一致しなければ payload を commit しない(fenced CAS)', async () => {
    // 実行中に takeover/supersede が起きて lease_version が進んだ状況。
    await getFixtureOwnerDb()
      .update(uploadOperations)
      .set({ leaseVersion: 1 })
      .where(eq(uploadOperations.id, operationId))

    await run(0)

    const op = await readOperation()
    expect(op?.status).toBe('processing')
    expect(op?.preparedPayload).toBeNull()
    expect(op?.preparedHash).toBeNull()
  })

  it('status が processing でなければ payload を commit しない(fenced CAS)', async () => {
    await getFixtureOwnerDb()
      .update(uploadOperations)
      .set({ status: 'terminal_failed', lastErrorCode: 'superseded' })
      .where(eq(uploadOperations.id, operationId))

    await run(0)

    const op = await readOperation()
    expect(op?.status).toBe('terminal_failed')
    expect(op?.lastErrorCode).toBe('superseded')
    expect(op?.preparedPayload).toBeNull()
  })

  it('失敗の terminal 化も fenced(既に別実行が終端化していれば上書きしない)', async () => {
    mockCallGemini.mockRejectedValue(new Error('429 Too Many Requests'))
    await getFixtureOwnerDb()
      .update(uploadOperations)
      .set({ status: 'terminal_failed', lastErrorCode: 'superseded' })
      .where(eq(uploadOperations.id, operationId))

    await run(0)

    const op = await readOperation()
    expect(op?.lastErrorCode).toBe('superseded')
  })
})
