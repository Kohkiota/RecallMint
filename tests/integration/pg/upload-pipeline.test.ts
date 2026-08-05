// ②-4a 単一 invocation Sprint Task S-2 / S-3: runUploadPipeline の実 PG 検証。
//
// Gemini(callGemini)を mock し(実 API 禁止・CLAUDE.md AI 絶対ルール 3)、sharp は
// 実実装のまま(実バイトの decode / crop が本 phase の要件そのもの)。R2 client は
// 全 export を spy にする — **source は R2 に置かない**(spec §2)ので GET は 0 回で、
// PUT に出てよいのは crop-derived asset key(`users/{uid}/{assetId}.webp`)だけ。
//
// 検証対象: prepared_payload の fenced CAS commit(processing + lease_version 一致 →
// prepared)/ 失敗系の terminal 化(op terminal_failed + doc failed が同一 tx)/
// ai_usage が Gemini attempt ごとに +1 / **順序不変条件(spec §7.3): R2 PUT は
// payload commit の後にしか起きない** / crop 失敗で OCR を巻き添えにしない(§9-6)。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/lib/db'
import {
  aiUsage,
  assetDerivations,
  assets,
  cards,
  exams,
  integrationFailures,
  sourceDocuments,
  uploadOperations,
  uploadRecords,
  users,
} from '@/lib/db/schema'
import { todayInJst } from '@/lib/jst'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

const { mockCallGemini, mockNotifyOps, ...r2Spies } = vi.hoisted(() => ({
  mockCallGemini: vi.fn(),
  mockNotifyOps: vi.fn(),
  presignPutUrl: vi.fn(),
  presignGetUrl: vi.fn(),
  headObject: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}))

vi.mock('@/lib/storage/r2', () => r2Spies)
// **外部副作用の遮断**: I-2 の crop 台帳 test は実 `recordIntegrationFailure` を通るため、
// shell に OPS_DISCORD_WEBHOOK_URL が export された状態だと実 Discord へ送信されてしまう
// (vitest は .env.local を読まないので通常は no-op だが、test が外部副作用を持ちうる形
// 自体が不可)。遮断するのは**通知だけ** — `integration_failures` への書込は実 PG で検証
// し続ける(lifecycle-behavioral.test.ts と同型)。
vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
  notifyWebhookError: vi.fn(),
}))
// parseRetryAfterMs は実実装のまま(stage-prepared.test.ts と同じ importOriginal 方式)。
vi.mock('@/lib/ai/clients/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/clients/gemini')>()
  return { ...actual, callGemini: mockCallGemini }
})
// crop / publish は実実装のまま(実 sharp + 実 PG)。失敗注入が要る test だけ spy から
// 一度だけ throw させる。
vi.mock('@/lib/media/crop-and-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/crop-and-store')>()
  return {
    ...actual,
    cropFigureFromBuffer: vi.fn(actual.cropFigureFromBuffer),
    // 層 2(phase 共通 throw)の注入点。per-figure try の**外側**で呼ばれる。
    classifyCropOutcome: vi.fn(actual.classifyCropOutcome),
  }
})
// catch-all(予期しない throw)の注入点。crop の外側 = pipeline 本体で throw させる。
// 既定は実実装のまま(正規化契約は lib/ocr 側の test が担保)。
vi.mock('@/lib/ocr/normalize-prepared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ocr/normalize-prepared')>()
  return { ...actual, normalizePrepared: vi.fn(actual.normalizePrepared) }
})
vi.mock('@/app/(app)/app/upload/_actions/publish-prepared', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/(app)/app/upload/_actions/publish-prepared')>()
  return { ...actual, publishPreparedUploadTx: vi.fn(actual.publishPreparedUploadTx) }
})

// vi.mock は import より前に hoist される。
import { GEMINI_TIMEOUT_MS, type GeminiContentPart } from '@/lib/ai/clients/gemini'
import { classifyCropOutcome, cropFigureFromBuffer } from '@/lib/media/crop-and-store'
import { normalizePrepared } from '@/lib/ocr/normalize-prepared'
import { publishPreparedUploadTx } from '@/app/(app)/app/upload/_actions/publish-prepared'
import {
  runUploadPipeline,
  type UploadPipelineFile,
} from '@/app/(app)/app/upload/_lib/upload-pipeline'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

// module mock の factory が `vi.fn(actual.classifyCropOutcome)` でくるんでいるため、
// 初期 implementation が実実装。mockImplementationOnce は mockClear で戻らないので
// beforeEach でここへ戻す。
const realClassifyCropOutcome = vi
  .mocked(classifyCropOutcome)
  .getMockImplementation() as typeof classifyCropOutcome
const realNormalizePrepared = vi
  .mocked(normalizePrepared)
  .getMockImplementation() as typeof normalizePrepared

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

// source_id は pipeline が実行時に採番するため、渡された parts から読み出して
// figure_regions に echo する(client / test が source_id を決めない設計の帰結)。
function geminiWithFigures(figureCount: number) {
  return async (req: { parts: GeminiContentPart[] }) => {
    const sourceIds = req.parts
      .filter((p): p is { text: string } => 'text' in p)
      .map((p) => /^source_id=(.+)$/.exec(p.text)?.[1])
      .filter((id): id is string => id !== undefined)
    return geminiOk({
      cards: [
        {
          ...VALID_CARD,
          figure_regions: Array.from({ length: figureCount }, (_, i) => ({
            source_id: sourceIds[i % sourceIds.length],
            box_2d: [100, 100, 800, 800],
            target: 'question_text',
            label: `fig${i}`,
          })),
        },
      ],
    })
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

describe('runUploadPipeline (S-2 / S-3)', () => {
  let userAId: string
  let operationId: string
  let examId: string
  let sourceDocumentId: string
  let files: UploadPipelineFile[]
  const today = todayInJst()
  // R2 PUT の観測: key と「その PUT 時点の operation.status」を記録する
  // (spec §7.3 の順序不変条件を実測で pin するため)。
  let putKeys: string[]
  let opStatusAtPut: (string | undefined)[]

  beforeEach(async () => {
    await truncateAllUserTables()
    mockCallGemini.mockReset()
    mockCallGemini.mockResolvedValue(geminiOk())
    for (const spy of Object.values(r2Spies)) spy.mockReset()
    mockNotifyOps.mockReset()
    vi.mocked(cropFigureFromBuffer).mockClear()
    vi.mocked(publishPreparedUploadTx).mockClear()
    // mockImplementationOnce は mockClear で戻らないため実実装へ戻す。
    vi.mocked(classifyCropOutcome).mockImplementation(realClassifyCropOutcome)
    vi.mocked(normalizePrepared).mockImplementation(realNormalizePrepared)
    putKeys = []
    opStatusAtPut = []
    r2Spies.putObject.mockImplementation(async (key: string) => {
      putKeys.push(key)
      const rows = await getFixtureOwnerDb()
        .select({ status: uploadOperations.status })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, operationId))
      opStatusAtPut.push(rows[0]?.status)
      return 'success'
    })

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

  async function countCards(): Promise<number> {
    const rows = await getFixtureOwnerDb()
      .select({ id: cards.id })
      .from(cards)
      .where(eq(cards.userId, userAId))
    return rows.length
  }

  async function countAssets(): Promise<number> {
    const rows = await getFixtureOwnerDb()
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.userId, userAId))
    return rows.length
  }

  async function readAiUsage(): Promise<number> {
    const rows = await getFixtureOwnerDb()
      .select({ count: aiUsage.count })
      .from(aiUsage)
      .where(eq(aiUsage.date, today))
    return rows[0]?.count ?? 0
  }

  // --- 開始 CAS(S-4)---
  // after() の callback は応答の**後**に走るため、その間に op 行が消えることがある
  // (exam 削除 cascade / GDPR 退会)。Gemini を呼ぶ前に実 PG で 1 回だけ確認する。
  it('op 行が消えていたら Gemini を呼ばずに静かに終わる(削除競合の課金を削る)', async () => {
    await getFixtureOwnerDb()
      .delete(uploadOperations)
      .where(eq(uploadOperations.id, operationId))

    await run()

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(await readAiUsage()).toBe(0)
    // doc は触らない(ユーザーが exam ごと消した場合は doc も cascade で消えている)。
    expect(await countCards()).toBe(0)
  })

  it('lease_version が自分のものでなければ Gemini を呼ばない(開始 CAS)', async () => {
    // 実行開始前に takeover / supersede が入って lease_version が進んだ状況。
    await getFixtureOwnerDb()
      .update(uploadOperations)
      .set({ leaseVersion: 1 })
      .where(eq(uploadOperations.id, operationId))

    await run(0)

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(await readAiUsage()).toBe(0)
    const op = await readOperation()
    // 他の書き手の状態を上書きしない。
    expect(op?.status).toBe('processing')
    expect(op?.preparedPayload).toBeNull()
  })

  it('メモリのバイトで OCR → publish まで走り切る(図版なし: R2 は 1 度も呼ばれない)', async () => {
    await run()

    const op = await readOperation()
    expect(op?.status).toBe('completed')
    expect(op?.preparedSchemaVersion).toBe(1)
    expect(op?.preparedHash).toMatch(/^[0-9a-f]{64}$/)
    // publish tx が payload を NULL 化して finalize する(commit されていた証跡は
    // prepared_hash / result_summary 側に残る)。
    expect(op?.preparedPayload).toBeNull()
    const summary = op?.resultSummary as { schemaVersion: number; cardsExtracted: number }
    expect(summary.schemaVersion).toBe(1)
    expect(summary.cardsExtracted).toBe(1)
    expect(op?.lastErrorCode).toBeNull()
    expect(await readDocStatus()).toBe('completed')
    expect(await countCards()).toBe(1)

    // 図版が無い応答なので crop は 1 度も起きず、R2 client も一切呼ばれない。
    for (const [name, spy] of Object.entries(r2Spies)) {
      expect(spy, `R2 client の ${name} が呼ばれた`).not.toHaveBeenCalled()
    }
  })

  it('upload_records は受領 Buffer 合計と受領枚数で記帳する(source_assets を参照しない)', async () => {
    await run()

    const records = await getFixtureOwnerDb()
      .select()
      .from(uploadRecords)
      .where(eq(uploadRecords.userId, userAId))
    expect(records).toHaveLength(1)
    expect(records[0]!.fileSizeBytes).toBe(files.reduce((s, f) => s + f.buffer.length, 0))
    expect(records[0]!.pagesProcessed).toBe(files.length)
    expect(records[0]!.status).toBe('completed')
  })

  // spec §7.3: crop-derived asset 行・R2 object は prepared_payload commit **後**に
  // しか作らない。PUT のたびに operation.status を実測して pin する。
  it('R2 PUT は payload commit の後にしか起きず、key は crop asset のみ(src/ を含まない)', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(2))

    await run()

    expect(putKeys).toHaveLength(2)
    // commit 前(status='processing')の PUT は 1 件も無い。
    expect(opStatusAtPut).toEqual(['prepared', 'prepared'])
    // 新経路は source を R2 に置かない = `src/` prefix の key を作らない。
    for (const key of putKeys) {
      expect(key).toMatch(
        new RegExp(`^users/${userAId}/[0-9a-f-]{36}\\.webp$`),
      )
      expect(key).not.toContain('/src/')
    }
    // source の R2 GET も 0 回(バイトはメモリのまま crop する)。
    expect(r2Spies.getObject).not.toHaveBeenCalled()

    const op = await readOperation()
    expect(op?.status).toBe('completed')
    const cardRows = await getFixtureOwnerDb()
      .select()
      .from(cards)
      .where(eq(cards.userId, userAId))
    expect(cardRows[0]!.images).toHaveLength(2)
    // provenance は残るが source_asset_id は NULL(新経路に source_assets 行は無い)。
    const derivations = await getFixtureOwnerDb()
      .select()
      .from(assetDerivations)
      .where(eq(assetDerivations.userId, userAId))
    expect(derivations).toHaveLength(2)
    for (const d of derivations) expect(d.sourceAssetId).toBeNull()
  })

  it('crop 全滅(R2 PUT が全て失敗)でも text card は publish する(§8.3 / §9-6)', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(2))
    r2Spies.putObject.mockResolvedValue('error')

    await run()

    const op = await readOperation()
    expect(op?.status).toBe('completed')
    expect(await readDocStatus()).toBe('completed')
    expect(await countCards()).toBe(1)
    const summary = op?.resultSummary as {
      figuresAttached: number
      figuresExcluded: { crop_failed: number }
    }
    expect(summary.figuresAttached).toBe(0)
    expect(summary.figuresExcluded.crop_failed).toBe(2)
    // 失敗した crop の asset 行は作らない。
    expect(await countAssets()).toBe(0)
  })

  // 層 1(canonical review M-1): 個別 figure の throw はその figure だけを隔離する。
  it('個別 figure の crop が throw しても他の figure は crop され publish へ進む', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(2))
    vi.mocked(cropFigureFromBuffer).mockRejectedValueOnce(new Error('figure exploded'))

    await run()

    const op = await readOperation()
    expect(op?.status).toBe('completed')
    expect(await readDocStatus()).toBe('completed')
    expect(await countCards()).toBe(1)
    // 2 件目は正常に crop されて attach される(1 件の事故で巻き込まない)。
    expect(vi.mocked(cropFigureFromBuffer)).toHaveBeenCalledTimes(2)
    expect(await countAssets()).toBe(1)
    const summary = op?.resultSummary as {
      figuresAttached: number
      figuresExcluded: { crop_failed: number }
    }
    expect(summary.figuresAttached).toBe(1)
    expect(summary.figuresExcluded.crop_failed).toBe(1)
    // 運用シグナル(I-2): 予期しない throw は台帳に 1 行残る。
    const failures = await getFixtureOwnerDb()
      .select()
      .from(integrationFailures)
      .where(eq(integrationFailures.userId, userAId))
    expect(failures).toHaveLength(1)
    // 4 軸(catalog の 'ocr_pipeline')+ PII-free context。
    expect(failures[0]!.operation).toBe('upload.ocr_pipeline')
    expect(failures[0]!.context).toEqual({ operationId, errorCode: 'crop_phase_failed' })
    // 通知面まで到達する(実送信は mock で遮断済み)。
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
  })

  // 層 2(backstop): loop 骨格側の throw でも既 attach 分を活かして publish へ進む。
  it('crop phase 共通の例外でも text card は publish する(OCR を巻き添えにしない)', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(2))
    vi.mocked(classifyCropOutcome).mockImplementationOnce(() => {
      throw new Error('crop phase exploded')
    })

    await run()

    const op = await readOperation()
    expect(op?.status).toBe('completed')
    expect(await readDocStatus()).toBe('completed')
    expect(await countCards()).toBe(1)
    const summary = op?.resultSummary as { figuresExcluded: { crop_failed: number } }
    // 例外で phase ごと打ち切られた = 残り figure も含めて crop_failed。
    expect(summary.figuresExcluded.crop_failed).toBe(2)
    const failures = await getFixtureOwnerDb()
      .select()
      .from(integrationFailures)
      .where(eq(integrationFailures.userId, userAId))
    expect(failures).toHaveLength(1)
  })

  // S-2 fix round 1 M-6 の申し送り: commit 後の失敗を 'processing' 固定の fence に
  // 流すと 'raced' と誤分類され、terminal 化すべき op が prepared + live lease で残る。
  it('publish tx の失敗は raced と誤分類せず terminal(publish_failed)にする', async () => {
    vi.mocked(publishPreparedUploadTx).mockRejectedValueOnce(new Error('duplicate card id'))

    await run()

    const op = await readOperation()
    expect(op?.status).toBe('terminal_failed')
    expect(op?.lastErrorCode).toBe('publish_failed')
    expect(op?.leaseExpiresAt).toBeNull()
    expect(op?.preparedPayload).toBeNull()
    expect(await readDocStatus()).toBe('failed')
    expect(await countCards()).toBe(0)
  })

  // no-throw 契約の実体(spec §4.4 (b)): pipeline **内部**の catch-all が、予期しない
  // throw を「op terminal + doc failed(同一 tx)+ 台帳 1 行」へ変換する。after() 境界の
  // 防波堤はこの分類を持たない(持たせると二重化する)ので、ここが唯一の検証点。
  it('pipeline 内部の予期しない throw は op terminal + doc failed + 台帳 1 行になる', async () => {
    vi.mocked(normalizePrepared).mockImplementationOnce(() => {
      throw new Error('unexpected pipeline explosion')
    })

    await expect(run()).resolves.toBeUndefined()

    const op = await readOperation()
    expect(op?.status).toBe('terminal_failed')
    expect(op?.lastErrorCode).toBe('pipeline_unexpected_error')
    expect(op?.leaseExpiresAt).toBeNull()
    expect(op?.preparedPayload).toBeNull()
    // 同一 tx で doc も failed(「op terminal / doc processing」のねじれを残さない)。
    expect(await readDocStatus()).toBe('failed')
    expect(await countCards()).toBe(0)

    const failures = await getFixtureOwnerDb()
      .select()
      .from(integrationFailures)
      .where(eq(integrationFailures.userId, userAId))
    expect(failures).toHaveLength(1)
    expect(failures[0]!.operation).toBe('upload.ocr_pipeline')
    // PII-free: context は operationId + errorCode のみ。
    expect(failures[0]!.context).toEqual({
      operationId,
      errorCode: 'pipeline_unexpected_error',
    })
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
  })

  it('二重起動は fencing が拒否する(cards / assets が増えない)', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(1))

    await run()
    expect(await countCards()).toBe(1)
    expect(await countAssets()).toBe(1)

    // 同じ leaseVersion で再実行 = 二重起動。commit CAS が status='processing' を
    // 要求するため payload を書けず、crop / publish にも進まない。
    const putCallsAfterFirst = putKeys.length
    await run()

    expect(await countCards()).toBe(1)
    expect(await countAssets()).toBe(1)
    expect(putKeys).toHaveLength(putCallsAfterFirst)
    const records = await getFixtureOwnerDb()
      .select()
      .from(uploadRecords)
      .where(eq(uploadRecords.userId, userAId))
    expect(records).toHaveLength(1)
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
    expect((await readOperation())?.status).toBe('completed')
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
    // **開始 CAS の後**に takeover/supersede が起きて lease_version が進んだ状況を
    // 作る(Gemini 呼出の最中に bump)。開始時点で bump してしまうと開始 CAS で
    // 止まり、commit CAS の保証が検証されないまま緑になる。
    mockCallGemini.mockImplementation(async () => {
      await getFixtureOwnerDb()
        .update(uploadOperations)
        .set({ leaseVersion: 1 })
        .where(eq(uploadOperations.id, operationId))
      return geminiOk()
    })

    await run(0)

    expect(mockCallGemini).toHaveBeenCalledTimes(1)
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
