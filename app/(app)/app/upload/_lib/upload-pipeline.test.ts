// ②-4a 単一 invocation Sprint Task S-2 / S-3: runUploadPipeline の unit 検証。
//
// 本 file が担うのは「DB を張らずに観測できる契約」だけ:
//   ① decode / crop はどちらも**逐次**(計測 mock で peak 同時実行数 = 1)
//   ② source を R2 から読まない(source 走査)
//   ③ Gemini に渡す parts の順序・内容(受領順の source_id interleave)
//   ④ deadline 超過 / decode 失敗で Gemini を呼ばずに terminal へ落ちる
//   ⑤ 予期しない throw を外へ漏らさず integration_failures に PII-free で積む
//   ⑥ crop の失敗(個別 / phase 共通例外)で publish を止めない(spec §9-6)
// 実 PG 上の CAS / terminal 化 / ai_usage / 順序不変条件は
// tests/integration/pg/upload-pipeline.test.ts。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetObject, mockDeleteObject, r2State, mockLoadPdf, pdfState } = vi.hoisted(() => {
  // ②-4b T8: count/render phase の R2 mock。key → 応答 bytes の queue(2 件登録すれば
  // 1 回目(count の GET)/ 2 回目以降(render の再 GET)で別バイトを返せる — sha256
  // 不一致 test が使う)。1 件しか無ければ以後もその値を返し続ける。
  const r2State = {
    bytesByKey: new Map<string, Buffer[]>(),
    deleteResult: { ok: true, status: 200 } as { ok: boolean; status: number | null },
    // whole-branch review fix(必須3): key 単位の呼出回数(1-origin)を数え、
    // `nullAtCall` に登録された回数の呼出だけ null を返す。count phase(1 回目)は
    // 成功させたまま render phase(2 回目)の再 GET だけを不在にする、といった
    // call 順分岐の注入点(mockImplementation の恒久上書きだと後続 test に
    // 漏れるため、この状態ベースの形にする — beforeEach で毎回 clear する)。
    nullAtCall: new Map<string, number>(),
    callCountByKey: new Map<string, number>(),
  }
  const mockGetObject = vi.fn(async (key: string) => {
    const callNo = (r2State.callCountByKey.get(key) ?? 0) + 1
    r2State.callCountByKey.set(key, callNo)
    if (r2State.nullAtCall.get(key) === callNo) return null
    const queue = r2State.bytesByKey.get(key)
    if (!queue || queue.length === 0) return null
    const bytes = queue.length > 1 ? queue.shift()! : queue[0]
    return { bytes }
  })
  const mockDeleteObject = vi.fn(async (_key: string) => r2State.deleteResult)

  // pdf-rasterize mock: bytes(base64) → 各ページの webp buffer 列。count phase は
  // pageCount(= pages.length)だけを読み、render phase は renderPageWebp(i) で
  // 1 ページずつ取り出す。renderCalls は handle 個体を跨いだ**全呼出**を記録する
  // (「render を一度も呼ばない」を pin するにはグローバル集計が要る)。
  //
  // fix round 1(Important 1 の test 用): `renderErrorAt`(bytes b64 → page index)+
  // `renderErrorFactory` で特定ページの renderPageWebp だけを任意の Error で
  // 失敗させられる。**実 `PdfParseError` を投げたい**が、vi.hoisted のコールバックは
  // 通常の import より前に実行されるためモジュールトップレベルの import を直接
  // 参照できない — `renderErrorFactory` を test 本体(実行時 = import 解決済)側で
  // 差し込む間接化でこれを回避する。
  const pdfState = {
    pagesByBytesB64: new Map<string, Buffer[]>(),
    renderCalls: [] as string[],
    destroyCalls: 0,
    renderErrorAt: new Map<string, number>(),
    renderErrorFactory: null as (() => Error) | null,
    // fix round 4(deadline-in-loop test 用): renderPageWebp 呼出のたびに呼ばれる
    // 副作用フック(既定 no-op)。test 側がページ間で時計を進める(deadline 消費を
    // 模す)ために使う — 「残り予算が crop 最低予算を切ったら」既存 test と同じ
    // 「mock 内で共有 state を書き換える」手口。
    onRenderPage: null as ((b64: string, i: number) => void) | null,
    // whole-branch review fix(必須3 + Minor4): loadPdf 自体を b64 単位の呼出回数
    // (1-origin)で失敗させる。count phase(1 回目)と render phase(2 回目)は
    // 同じ b64 で loadPdf を呼ぶため、`renderErrorAt` と同様に「実 PdfParseError を
    // 投げたいが vi.hoisted からは import 不可」の間接化(loadErrorFactory)+
    // 呼出回数で「どちらの phase で落とすか」を分岐する。
    loadErrorAtCall: new Map<string, number>(),
    loadErrorFactory: null as (() => Error) | null,
    loadCallCountByB64: new Map<string, number>(),
  }
  const mockLoadPdf = vi.fn(async (buf: Buffer) => {
    const b64 = buf.toString('base64')
    const loadCallNo = (pdfState.loadCallCountByB64.get(b64) ?? 0) + 1
    pdfState.loadCallCountByB64.set(b64, loadCallNo)
    if (pdfState.loadErrorAtCall.get(b64) === loadCallNo && pdfState.loadErrorFactory) {
      throw pdfState.loadErrorFactory()
    }
    const pages = pdfState.pagesByBytesB64.get(b64) ?? []
    return {
      pageCount: pages.length,
      renderPageWebp: async (i: number) => {
        pdfState.renderCalls.push(`${b64.slice(0, 12)}:${i}`)
        pdfState.onRenderPage?.(b64, i)
        if (pdfState.renderErrorAt.get(b64) === i && pdfState.renderErrorFactory) {
          throw pdfState.renderErrorFactory()
        }
        return { webp: pages[i], width: 800, height: 1200 }
      },
      destroy: () => {
        pdfState.destroyCalls += 1
      },
    }
  })

  return {
    mockGetObject,
    mockDeleteObject,
    r2State,
    mockLoadPdf,
    pdfState,
  }
})

const {
  mockWithTenantTx,
  mockCallGemini,
  mockIncrementAiUsage,
  mockRecordIntegrationFailure,
  mockLoggerWarn,
  mockLoggerError,
  mockLoggerInfo,
  mockSharp,
  sharpState,
  mockCropFigureFromBuffer,
  cropState,
  mockPublishPreparedUploadTx,
} = vi.hoisted(() => {
  // crop の in-flight 計測 mock。decode と同じ規律(逐次)を pin する — Promise.all 化
  // すると crop 出力 Buffer が同時に複数メモリへ載る。
  const cropState = {
    inFlight: 0,
    peakInFlight: 0,
    calls: 0,
    outcome: 'stored' as string,
    // 指定 index(0-origin)の crop 呼出で throw させる(個別 figure 例外の注入点)。
    throwAt: null as number | null,
    // 全 crop 呼出で throw させる(台帳の丸め検証用)。
    throwAll: false,
  }
  const mockCropFigureFromBuffer = vi.fn(async () => {
    const index = cropState.calls++
    cropState.inFlight += 1
    cropState.peakInFlight = Math.max(cropState.peakInFlight, cropState.inFlight)
    await new Promise((r) => setTimeout(r, 0))
    cropState.inFlight -= 1
    if (cropState.throwAll || cropState.throwAt === index) throw new Error('crop exploded')
    return { outcome: cropState.outcome }
  })
  // sharp の in-flight 計測 mock(論点 B)。 decode 窓 = metadata() 開始 〜
  // toBuffer() 解決(verifyImageBytes がこの順で 1 画像を処理する)。 逐次なら
  // peak = 1、Promise.all 化すると同時に metadata() へ入るため peak = 枚数。
  const sharpState = {
    inFlight: 0,
    peakInFlight: 0,
    calls: 0,
    // metadata() を throw させる 0-origin index(decode 失敗の注入点)。
    failAt: null as number | null,
    // metadata() が返す EXIF orientation(0-origin index → 値)。 既定は未設定 =
    // `undefined` = EXIF 非搭載で、これが現行 client 経路(canvas 再エンコードで
    // EXIF が剥がれる)の形。 **実 sharp が本当にこの形を返すこと**は
    // source-image-verify.test.ts(実 sharp)が担保する。
    orientationAt: {} as Record<number, number>,
  }
  const mockSharp = vi.fn(() => {
    const index = sharpState.calls++
    let counted = false
    const enter = () => {
      sharpState.inFlight += 1
      counted = true
      sharpState.peakInFlight = Math.max(sharpState.peakInFlight, sharpState.inFlight)
    }
    const leave = () => {
      if (!counted) return
      sharpState.inFlight -= 1
      counted = false
    }
    return {
      metadata: async () => {
        enter()
        await new Promise((r) => setTimeout(r, 0))
        if (sharpState.failAt === index) {
          leave()
          throw new Error('corrupt header')
        }
        return { width: 100, height: 50, orientation: sharpState.orientationAt[index] }
      },
      toBuffer: async () => {
        await new Promise((r) => setTimeout(r, 0))
        leave()
        return { info: { format: 'png', width: 100, height: 50 } }
      },
    }
  })
  return {
    mockWithTenantTx: vi.fn(),
    mockCallGemini: vi.fn(),
    mockIncrementAiUsage: vi.fn(),
    mockRecordIntegrationFailure: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockSharp,
    sharpState,
    mockCropFigureFromBuffer,
    cropState,
    mockPublishPreparedUploadTx: vi.fn(),
  }
})

vi.mock('sharp', () => ({ default: mockSharp }))
// ②-4b T8: R2 import は getObject / deleteObject のみ(regex pin と同じ主張)。
vi.mock('@/lib/storage/r2', () => ({ getObject: mockGetObject, deleteObject: mockDeleteObject }))
vi.mock('@/lib/media/pdf-rasterize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/pdf-rasterize')>()
  return { ...actual, loadPdf: mockLoadPdf }
})
vi.mock('@/lib/db/tenant-tx', () => ({ withTenantTx: mockWithTenantTx }))
vi.mock('@/lib/ai-usage-counter', () => ({ incrementAiUsage: mockIncrementAiUsage }))
vi.mock('@/lib/integration-failures', () => ({
  recordIntegrationFailure: mockRecordIntegrationFailure,
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, error: mockLoggerError },
}))
// parseRetryAfterMs / 型は実実装のまま(stage-prepared.test.ts と同じ importOriginal 方式)。
vi.mock('@/lib/ai/clients/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/clients/gemini')>()
  return { ...actual, callGemini: mockCallGemini }
})
// 既定は実実装(normalize の契約は lib/ocr 側の test が担保)。 catch-all の
// 検証時だけ throw させるため spy でくるむ。
vi.mock('@/lib/ocr/normalize-prepared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ocr/normalize-prepared')>()
  return { ...actual, normalizePrepared: vi.fn(actual.normalizePrepared) }
})
// crop 本体は計測 mock(実 sharp / 実 R2 を叩かない)。 outcome → disposition の
// 翻訳規則は実実装(classifyCropOutcome)のまま — test 側で複製すると drift する。
vi.mock('@/lib/media/crop-and-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/crop-and-store')>()
  return {
    ...actual,
    cropFigureFromBuffer: mockCropFigureFromBuffer,
    // 既定は実実装(翻訳規則を test 側に複製しない)。 層 2(phase 共通 throw)の
    // 注入点としてだけ spy でくるむ — per-figure try の**外側**で呼ばれるため。
    classifyCropOutcome: vi.fn(actual.classifyCropOutcome),
  }
})
// publish tx は mock(実 DB を張らない)。 引数(cardImagesByCardId /
// resultSummary)の検証点として使う。
vi.mock('../_actions/publish-prepared', () => ({
  publishPreparedUploadTx: mockPublishPreparedUploadTx,
}))

// vi.mock は import より前に hoist される。
import { GEMINI_TIMEOUT_MS, type GeminiContentPart } from '@/lib/ai/clients/gemini'
import { classifyCropOutcome } from '@/lib/media/crop-and-store'
// PdfParseError は mock module が `...actual` で再 export する実クラス(vi.mock
// factory 参照)。production 側の `instanceof PdfParseError` と同一クラス参照。
import { PdfParseError } from '@/lib/media/pdf-rasterize'
import { sourcePdfObjectKey } from '@/lib/media/source-object-key'
import { normalizePrepared } from '@/lib/ocr/normalize-prepared'
import {
  runUploadPipeline,
  type UploadPipelineFile,
  type UploadPipelineSourceOrderEntry,
  type UploadPipelineSourcePdf,
} from './upload-pipeline'

// 実実装への参照(module mock の factory が `vi.fn(actual.classifyCropOutcome)` で
// くるんでいるので、初期 implementation がそれ)。
const realClassifyCropOutcome = vi
  .mocked(classifyCropOutcome)
  .getMockImplementation() as typeof classifyCropOutcome

const USER_ID = '00000000-0000-4000-8000-00000000000a'
const REFS = {
  operationId: '00000000-0000-4000-8000-00000000000b',
  examId: '00000000-0000-4000-8000-00000000000c',
  sourceDocumentId: '00000000-0000-4000-8000-00000000000d',
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// sniffMagicBytes(実実装)を通す最小の PNG-like バイト列。 decode 自体は
// mock 済 sharp が受け持つため中身は識別用の tag で足りる。
function pngLike(tag: string): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from(`-${tag}`, 'utf8')])
}

function filesOf(...tags: string[]): UploadPipelineFile[] {
  return tags.map((t) => ({ buffer: pngLike(t), filename: `${t}.png` }))
}

// ②-4b T8: rasterize 済みページを模した webp-like バイト列(RIFF....WEBP magic)。
// verifyImageBytes の sniffMagicBytes(実実装)が image/webp と判定できる最小形。
function webpLike(tag: string, padBytes = 0): Buffer {
  return Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46]), // 'RIFF'
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0x57, 0x45, 0x42, 0x50]), // 'WEBP'
    Buffer.from(`-${tag}`, 'utf8'),
    padBytes > 0 ? Buffer.alloc(padBytes) : Buffer.alloc(0),
  ])
}

const SESSION_ID = '00000000-0000-4000-8000-0000000000f0'

// R2 に置かれた PDF 原本を模した bytes(内容は sha256 の同一性判定にのみ使われ、
// pdf-rasterize 側は mock なので実 PDF 構造である必要はない)。
function pdfBytes(tag: string): Buffer {
  return Buffer.from(`FAKE-PDF-${tag}`, 'utf8')
}

// count/render 両 phase の getObject が読む R2 mock + pdf-rasterize mock の両方に
// 1 冊分を登録する。`pages` = renderPageWebp が返す webp buffer 列(pageCount は
// この長さ)。戻り値の `manifestEntry` はそのまま sourcePdfManifest に積める。
function registerPdf(
  fileId: string,
  pages: Buffer[],
  opts: { sessionId?: string; declaredBytes?: number } = {},
): UploadPipelineSourcePdf {
  const sessionId = opts.sessionId ?? SESSION_ID
  const key = sourcePdfObjectKey(USER_ID, sessionId, fileId)
  const bytes = pdfBytes(fileId)
  r2State.bytesByKey.set(key, [bytes])
  pdfState.pagesByBytesB64.set(bytes.toString('base64'), pages)
  return {
    fileId,
    filename: `${fileId}.pdf`,
    pageCount: pages.length,
    declaredBytes: opts.declaredBytes ?? bytes.length,
  }
}

function runWithPdf(
  files: UploadPipelineFile[],
  sourcePdfManifest: UploadPipelineSourcePdf[],
  sourceOrder: UploadPipelineSourceOrderEntry[],
  opts: { deadlineOffsetMs?: number; leaseVersion?: number; uploadSessionId?: string } = {},
): Promise<void> {
  return runUploadPipeline(
    USER_ID,
    REFS,
    opts.leaseVersion ?? 0,
    files,
    new Date(Date.now() + (opts.deadlineOffsetMs ?? GEMINI_TIMEOUT_MS * 2)),
    sourcePdfManifest,
    opts.uploadSessionId ?? SESSION_ID,
    sourceOrder,
  )
}

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

// figure_regions 付きの Gemini 応答。source_id は pipeline が実行時に採番するため、
// 受け取った parts から読み出して echo する(iso と同じ手口)。
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

// 軽量 fake tx: commitPreparedCas(`.returning()`)と terminalize(`.for('update')` +
// 素の await)の 2 形だけを満たす(crop-and-store.test.ts の fake tx と同じ方針)。
const txState = {
  // terminalize の fence 読取が返す行。phase に応じて test 側が差し替える。
  opRows: [{ status: 'processing', leaseVersion: 0 }] as Record<string, unknown>[],
  // commitPreparedCas の `.returning()`(0 行 = CAS 敗北)。
  commitReturning: [{ id: 'op' }] as Record<string, unknown>[],
  // 開始 CAS(S-4)の `.limit(1)`(0 行 = 行消滅 / lease_version 不一致)。
  startCasRows: [{ id: 'op' }] as Record<string, unknown>[],
}
const fakeTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        for: async () => txState.opRows,
        limit: async () => txState.startCasRows,
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        then: (resolve: (v: unknown) => void) => resolve(undefined),
        returning: async () => txState.commitReturning,
      }),
    }),
  }),
}

function phasesOf(warnSpy: { mock: { calls: unknown[][] } }): unknown[] {
  return warnSpy.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((p) => p.event === 'upload.pipeline.phase')
    .map((p) => p.phase)
}

// 既定の残余は 1 attempt(GEMINI_TIMEOUT_MS)の 2 倍から導出する — pre-call gate も
// retry 打ち切りも「残余 < GEMINI_TIMEOUT_MS」を基準にするため、literal を置くと
// 定数を伸ばしたときに全 test が静かに「予算不足」経路へ落ちる。
function run(
  files: UploadPipelineFile[],
  opts: { deadlineOffsetMs?: number; leaseVersion?: number } = {},
): Promise<void> {
  return runUploadPipeline(
    USER_ID,
    REFS,
    opts.leaseVersion ?? 0,
    files,
    new Date(Date.now() + (opts.deadlineOffsetMs ?? GEMINI_TIMEOUT_MS * 2)),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  sharpState.inFlight = 0
  sharpState.peakInFlight = 0
  sharpState.calls = 0
  sharpState.failAt = null
  sharpState.orientationAt = {}
  cropState.inFlight = 0
  cropState.peakInFlight = 0
  cropState.calls = 0
  cropState.outcome = 'stored'
  cropState.throwAt = null
  cropState.throwAll = false
  r2State.bytesByKey.clear()
  r2State.deleteResult = { ok: true, status: 200 }
  r2State.nullAtCall.clear()
  r2State.callCountByKey.clear()
  pdfState.pagesByBytesB64.clear()
  pdfState.renderCalls = []
  pdfState.destroyCalls = 0
  pdfState.renderErrorAt.clear()
  pdfState.renderErrorFactory = null
  pdfState.onRenderPage = null
  pdfState.loadErrorAtCall.clear()
  pdfState.loadErrorFactory = null
  pdfState.loadCallCountByB64.clear()
  // mockImplementationOnce / mockRejectedValue は clearAllMocks で戻らないため、
  // 層 2 の注入点(classifyCropOutcome)は毎回 実実装へ戻す。
  vi.mocked(classifyCropOutcome).mockImplementation(realClassifyCropOutcome)
  txState.opRows = [{ status: 'processing', leaseVersion: 0 }]
  txState.commitReturning = [{ id: 'op' }]
  txState.startCasRows = [{ id: 'op' }]
  mockWithTenantTx.mockImplementation(
    async (_userId: string, fn: (tx: unknown) => unknown) => fn(fakeTx),
  )
  mockPublishPreparedUploadTx.mockResolvedValue({ outcome: 'published' })
  mockCallGemini.mockResolvedValue(geminiOk())
  mockIncrementAiUsage.mockResolvedValue(undefined)
  mockRecordIntegrationFailure.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// 開始 CAS(S-4)
// ---------------------------------------------------------------------------
// after() の callback は応答の**後**に走るため、その間に op 行が消えている
// (exam 削除 cascade / GDPR 退会)ことがある。 Gemini を呼ぶ前に 1 回だけ確認して、
// 自分の op でなければ何もせず終わる = 課金だけ発生して置き場が無い状態を作らない。
describe('runUploadPipeline — 開始 CAS', () => {
  it('op 行が消えていたら decode も Gemini も行わずに静かに終わる', async () => {
    txState.startCasRows = [] // 行消滅(削除競合)

    await run(filesOf('a', 'b'))

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(sharpState.calls).toBe(0)
    // 「予期される失敗」ですらない(ユーザー起点の削除)ので terminal 化もしない。
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.start_cas_lost',
        operationId: REFS.operationId,
      }),
    )
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.failed' }),
    )
    // 台帳(予期しない失敗)にも積まない。
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
  })

  // 名前は主張に合わせている(canonical M-1): fake tx は WHERE を評価せず
  // `startCasRows` をそのまま返すため、この unit が pin できるのは「CAS の SELECT が
  // 0 行なら Gemini を呼ばない」まで。 **WHERE が実際に id + user_id + lease_version で
  // 絞れているか**は実 PG(tests/integration/pg/upload-pipeline.test.ts)の担当。
  it('開始 CAS が 0 行を返せば Gemini を呼ばない(WHERE の内容は iso で検証)', async () => {
    txState.startCasRows = []

    await run(filesOf('a'), { leaseVersion: 3 })

    expect(mockCallGemini).not.toHaveBeenCalled()
  })

  it('自分の op が残っていれば通常どおり Gemini まで進む', async () => {
    await run(filesOf('a'))

    expect(mockCallGemini).toHaveBeenCalledTimes(1)
  })
})

describe('runUploadPipeline — decode phase', () => {
  it('decode は逐次実行される(peak 同時 decode = 1・メモリ見積りの前提)', async () => {
    await run(filesOf('a', 'b', 'c'))

    expect(sharpState.calls).toBe(3)
    expect(sharpState.peakInFlight).toBe(1)
  })

  it('1 枚でも decode に失敗したら Gemini を呼ばずに終わる(upload 全体 terminal)', async () => {
    sharpState.failAt = 1 // 2 枚目

    await run(filesOf('a', 'b', 'c'))

    expect(mockCallGemini).not.toHaveBeenCalled()
    // 3 枚目の decode は試みない(失敗が確定した時点で打ち切る)。
    expect(sharpState.calls).toBe(2)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'image_decode_failed',
      }),
    )
  })
})

describe('runUploadPipeline — Gemini request', () => {
  it('parts は受領順に source_id ラベル + inlineData(渡した Buffer の base64)で組まれる', async () => {
    const files = filesOf('a', 'b')
    await run(files)

    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    const parts = mockCallGemini.mock.calls[0][0].parts as GeminiContentPart[]
    // [label1, image1, label2, image2, prompt]
    expect(parts).toHaveLength(5)

    const labels = parts.filter((p): p is { text: string } => 'text' in p)
    const images = parts.filter(
      (p): p is { inlineData: { mimeType: string; data: string } } => 'inlineData' in p,
    )
    expect(images.map((p) => p.inlineData.data)).toEqual(
      files.map((f) => f.buffer.toString('base64')),
    )
    // mimeType は decode 結果(sharp)由来 — client 申告や拡張子ではない。
    expect(images.map((p) => p.inlineData.mimeType)).toEqual(['image/png', 'image/png'])

    // source_id は server 採番(受領順)。 label は image の直前に置かれる。
    const sourceIds = labels
      .slice(0, 2)
      .map((p) => /^source_id=(.+)$/.exec(p.text)?.[1] ?? '')
    expect(sourceIds).toHaveLength(2)
    expect(new Set(sourceIds).size).toBe(2)
    // uuid v4 形であること自体が要件: 連番だとモデルが帰属を推測で埋めたときに
    // 「たまたま実在の source_id」となり誤った画像へ silent に紐付く(uuid なら
    // validSourceIds に弾かれ source_id_invalid として集計に出る)。
    for (const id of sourceIds) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
    }
    expect(parts[0]).toEqual({ text: `source_id=${sourceIds[0]}` })
    expect(parts[2]).toEqual({ text: `source_id=${sourceIds[1]}` })

    // 最後の part は prompt(空でない text)。
    const last = parts[4]
    expect('text' in last && last.text.length > 0).toBe(true)

    // normalizePrepared には採番した source_id 集合をそのまま渡す。
    expect(normalizePrepared).toHaveBeenCalledTimes(1)
    const passedIds = vi.mocked(normalizePrepared).mock.calls[0][1]
    expect([...passedIds].sort()).toEqual([...sourceIds].sort())
  })

  // I-1: pre-call gate だけでは retry ループ(最悪 3×220s + backoff)を止められない。
  // pipeline は deadlineAt を retry ループへ渡す責務を負う。
  it('deadlineAt を retry ループへ渡す(打ち切り判断を retry の内側でさせる)', async () => {
    await run(filesOf('a'))

    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    // callImageCropWithRetry は実実装(mock していない)。 retry ループが
    // deadlineAt を持つことは、残余不足で attempt が増えないことで観測する。
    mockCallGemini.mockClear()
    mockCallGemini.mockRejectedValue(new Error('503 Service Unavailable'))
    // 初回 attempt は通る残余(> GEMINI_TIMEOUT_MS)だが、backoff(5-7s)を引くと
    // 次の attempt を賄えない ⇒ retry ループの内側で打ち切られる
    // (deadlineAt を渡していなければ 3 attempts になる)。
    await run(filesOf('a'), { deadlineOffsetMs: GEMINI_TIMEOUT_MS + 1_000 })
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'gemini_call_failed',
      }),
    )
    // timeout を伸ばしてあるのは、deadlineAt の受け渡しが壊れた場合に「5s + 20s の
    // 実 backoff を経て 3 attempts」まで走り切らせ、test timeout ではなく attempt 数の
    // assertion で落とすため(緑の経路は backoff を 1 度も待たないので即終わる)。
  }, 40_000)

  it('残り予算が尽きていれば Gemini を呼ばずに terminal(deadline は action 入口起点)', async () => {
    await run(filesOf('a'), { deadlineOffsetMs: -1 })

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'deadline_exceeded',
      }),
    )
  })

  // 初回 attempt も retry と同じ基準で判断する: 残余 1ms でも 220s 掛かりうる call を
  // 始めると invocation が platform に打ち切られ、失敗理由がどこにも残らない。
  it('残余が 1 attempt 分(GEMINI_TIMEOUT_MS)に満たなければ初回 attempt も始めない', async () => {
    await run(filesOf('a'), { deadlineOffsetMs: GEMINI_TIMEOUT_MS - 1_000 })

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockIncrementAiUsage).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'deadline_exceeded',
      }),
    )
  })
})

describe('runUploadPipeline — phase 別所要時間 log', () => {
  it('warn level で出す(production の既定 log level が warn ゆえ info は不可視)', async () => {
    await run(filesOf('a'))

    const phaseLogs = mockLoggerWarn.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((p) => p.event === 'upload.pipeline.phase')
    expect(phaseLogs.map((p) => p.phase)).toEqual([
      'decode',
      'gemini',
      'normalize',
      'commit',
      // 順序不変条件(spec §7.3): crop / publish は commit の**後**にしか出ない。
      'crop',
      'publish',
      'total',
    ])
    // PII-free: operationId / phase 名 / ミリ秒のみ(filename・カード本文を含めない)。
    for (const p of phaseLogs) {
      expect(Object.keys(p).sort()).toEqual(['event', 'ms', 'operationId', 'phase'])
      expect(p.operationId).toBe(REFS.operationId)
      expect(typeof p.ms).toBe('number')
    }
    expect(mockLoggerInfo).not.toHaveBeenCalled()
  })

  // 較正でいちばん見たいのは「遅い / timeout する呼出」= 失敗する呼出そのもの。
  // 成功時にしか出ないと測りたい値が落ちる。
  it('失敗した phase の所要時間も残る(decode 失敗 / Gemini 失敗)', async () => {
    sharpState.failAt = 0
    await run(filesOf('a', 'b'))
    expect(phasesOf(mockLoggerWarn)).toEqual(['decode', 'total'])

    vi.clearAllMocks()
    mockCallGemini.mockRejectedValue(new Error('400 Bad Request'))
    await run(filesOf('a'))
    expect(phasesOf(mockLoggerWarn)).toEqual(['decode', 'gemini', 'total'])
  })

  it('normalize の失敗(JSON 不読 / 有効カード 0)でも normalize の所要時間が残る', async () => {
    mockCallGemini.mockResolvedValue({
      text: '{"cards": [',
      inputTokens: 1,
      outputTokens: 1,
      thoughtsTokens: 0,
    })
    await run(filesOf('a'))
    expect(phasesOf(mockLoggerWarn)).toEqual(['decode', 'gemini', 'normalize', 'total'])
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'json_parse_failed',
      }),
    )

    vi.clearAllMocks()
    mockCallGemini.mockResolvedValue(geminiOk({ cards: [] }))
    await run(filesOf('a'))
    expect(phasesOf(mockLoggerWarn)).toEqual(['decode', 'gemini', 'normalize', 'total'])
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'empty_cards',
      }),
    )
  })
})

describe('runUploadPipeline — crop phase(S-3)', () => {
  it('crop は逐次実行される(peak 同時 crop = 1・crop 出力 Buffer を溜めない前提)', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(3))

    await run(filesOf('a'))

    expect(cropState.calls).toBe(3)
    expect(cropState.peakInFlight).toBe(1)
  })

  it('prepared commit に負けた(CAS 0 行)ら crop も publish もしない(順序不変条件)', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(2))
    txState.commitReturning = []

    await run(filesOf('a'))

    expect(cropState.calls).toBe(0)
    expect(mockPublishPreparedUploadTx).not.toHaveBeenCalled()
    expect(phasesOf(mockLoggerWarn)).toEqual(['decode', 'gemini', 'normalize', 'commit', 'total'])
  })

  it('個別 figure の crop 失敗は publish を止めない(crop_failed 計上 + text card は publish)', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(2))
    // 'error'(R2 の技術的失敗)は旧経路では retryable だが、新経路に再試行主体が
    // 居ないため exclude(crop_failed)へ倒す — publish 自体は止めない。
    cropState.outcome = 'error'

    await run(filesOf('a'))

    expect(mockPublishPreparedUploadTx).toHaveBeenCalledTimes(1)
    const args = mockPublishPreparedUploadTx.mock.calls[0][1] as {
      cardImagesByCardId: Record<string, unknown[]>
      resultSummary: { figuresExcluded: Record<string, number>; cardsExtracted: number }
    }
    expect(Object.values(args.cardImagesByCardId).flat()).toHaveLength(0)
    expect(args.resultSummary.cardsExtracted).toBe(1)
    expect(args.resultSummary.figuresExcluded.crop_failed).toBe(2)
  })

  // 層 1(throw 版・canonical review M-1): 個別 figure の throw は**その figure だけ**を
  // crop_failed にして続行する(隔離原則: 1 figure の事故で残りを巻き込まない)。
  it('個別 figure の crop が throw しても他の figure は crop され publish へ進む', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(3))
    cropState.throwAt = 1 // 2 件目だけ throw

    await expect(run(filesOf('a'))).resolves.toBeUndefined()

    // 3 件すべて crop を試みる(2 件目で loop を打ち切らない)。
    expect(cropState.calls).toBe(3)
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.crop_figure_failed' }),
    )
    const args = mockPublishPreparedUploadTx.mock.calls[0][1] as {
      cardImagesByCardId: Record<string, unknown[]>
      resultSummary: { figuresExcluded: Record<string, number> }
    }
    expect(Object.values(args.cardImagesByCardId).flat()).toHaveLength(2)
    expect(args.resultSummary.figuresExcluded.crop_failed).toBe(1)
  })

  // I-2: ユーザー向けは縮退(publish 続行)でも**運用向けには黙らない**。
  // 台帳が無いと「全 upload が静かに text-only で completed」になり誰も気付けない。
  it('crop の予期しない throw は integration_failures に載せる(op は completed へ進む)', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(3))
    cropState.throwAt = 0

    await run(filesOf('a'))

    expect(mockRecordIntegrationFailure).toHaveBeenCalledTimes(1)
    const args = mockRecordIntegrationFailure.mock.calls[0][0] as Record<string, unknown>
    expect(args.key).toBe('ocr_pipeline')
    expect(args.userId).toBe(USER_ID)
    // PII-free(filename / base64 / payload を含めない)。
    expect(args.context).toEqual({
      operationId: REFS.operationId,
      errorCode: 'crop_phase_failed',
    })
    expect(JSON.stringify(args)).not.toContain('a.png')
    // terminal 化はしない = publish は走る(crop 失敗で OCR を巻き添えにしない)。
    expect(mockPublishPreparedUploadTx).toHaveBeenCalledTimes(1)
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.failed' }),
    )
  })

  it('台帳は 1 operation につき 1 行に丸める(figure ごとに 40 件鳴らさない)', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(3))
    cropState.throwAll = true

    await run(filesOf('a'))

    expect(mockCropFigureFromBuffer).toHaveBeenCalledTimes(3)
    expect(mockRecordIntegrationFailure).toHaveBeenCalledTimes(1)
  })

  // 層 2(backstop): loop 骨格側の throw。attach 済みは活かし、残りを crop_failed に
  // して publish へ進む。注入点は classifyCropOutcome(per-figure try の外側)。
  it('crop phase 共通の throw でも既 attach 分は採用し、残りだけ crop_failed で publish へ進む', async () => {
    mockCallGemini.mockImplementation(geminiWithFigures(3))
    vi.mocked(classifyCropOutcome)
      .mockImplementationOnce(() => 'success')
      .mockImplementationOnce(() => {
        throw new Error('phase exploded')
      })

    await expect(run(filesOf('a'))).resolves.toBeUndefined()

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.crop_phase_failed' }),
    )
    expect(mockRecordIntegrationFailure).toHaveBeenCalledTimes(1)
    expect(mockPublishPreparedUploadTx).toHaveBeenCalledTimes(1)
    const args = mockPublishPreparedUploadTx.mock.calls[0][1] as {
      cardImagesByCardId: Record<string, unknown[]>
      resultSummary: { figuresExcluded: Record<string, number> }
    }
    // 1 件目は attach 済み / 2 件目(例外)と 3 件目(未処理)は crop_failed。
    expect(Object.values(args.cardImagesByCardId).flat()).toHaveLength(1)
    expect(args.resultSummary.figuresExcluded.crop_failed).toBe(2)
  })

  it('残り予算が crop 最低予算を切ったら以降の figure は deadline_excluded(crop を試みない)', async () => {
    // crop の予算は **統合予算の残余**(OCR と共有)。Gemini が予算を食い潰した状況を
    // 作るため、Gemini mock の中で時計を進める(mock は瞬時に返るので実時間では作れない)。
    const realNow = Date.now.bind(Date)
    let clockOffset = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
    try {
      const withFigures = geminiWithFigures(2)
      mockCallGemini.mockImplementation(async (req: { parts: GeminiContentPart[] }) => {
        clockOffset += GEMINI_TIMEOUT_MS
        return withFigures(req)
      })

      // 初回 attempt の pre-call gate は通る(残余 = GEMINI_TIMEOUT_MS + 1s)が、
      // call 後の残余は 1s < CROP_MIN_REMAINING_MS(5s)。
      await run(filesOf('a'), { deadlineOffsetMs: GEMINI_TIMEOUT_MS + 1_000 })
    } finally {
      nowSpy.mockRestore()
    }

    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(cropState.calls).toBe(0)
    const args = mockPublishPreparedUploadTx.mock.calls[0][1] as {
      resultSummary: { figuresExcluded: Record<string, number> }
    }
    expect(args.resultSummary.figuresExcluded.deadline_excluded).toBe(2)
    expect(args.resultSummary.figuresExcluded.crop_failed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// EXIF orientation(T16-b)= **前提破綻の検知機構**であって、ユーザーのための除外ではない。
//
// **通常この分岐は発火しない**: client は upload 時に画像を無条件で canvas 再エンコード
// する(`upload-form.tsx` の `imageCompression(file, { fileType: 'image/webp' })`)ため
// EXIF は焼き込まれて剥がれ、EXIF≠1 のバイトは現行 UI 経路では server に到達しない。
// 発火しないこと自体が想定内で、発火したら **spec §4.3 の前提が壊れている**合図
// (client 圧縮の仕様変更 / UI を経由しない呼出 / ②-4b の PDF 経路)。
// `source_assets.rotation` 予約列が migration 0032 で消えた今、それを知る手段は
// pipeline の `logger.warn` しかない — ゆえに**本命の assert は warn**(除外計上は副次)。
// ---------------------------------------------------------------------------
describe('runUploadPipeline — EXIF orientation(前提破綻の検知)', () => {
  it('EXIF≠1 の source は warn を出す(本命・PII-free で orientation 値を載せる)', async () => {
    sharpState.orientationAt = { 1: 6 } // 2 枚目だけ回転

    await run(filesOf('a', 'b'))

    const warns = mockLoggerWarn.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((w) => w.event === 'upload.pipeline.source_orientation_unsupported')
    // 回転していない 1 枚目では鳴らさない(1 source につき最大 1 行)。
    expect(warns).toHaveLength(1)
    // context は operationId + orientation 値のみ(filename / バイト / payload を入れない)。
    expect(warns[0]).toEqual({
      event: 'upload.pipeline.source_orientation_unsupported',
      operationId: REFS.operationId,
      orientation: 6,
    })
    expect(JSON.stringify(warns[0])).not.toContain('b.png')
    // decode 自体は失敗させない — text 抽出は継続する(spec §4.5)。
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(mockPublishPreparedUploadTx).toHaveBeenCalledTimes(1)
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.failed' }),
    )
  })

  it('EXIF≠1 の source の figure は crop を呼ばずに orientation_unsupported へ計上する', async () => {
    // figure i は sources[i % 2] に紐づく(geminiWithFigures)。 2 枚目だけ回転させ、
    // 「片方だけ除外され、もう片方は通常どおり crop される」面にする。
    sharpState.orientationAt = { 1: 6 }
    mockCallGemini.mockImplementation(geminiWithFigures(2))

    await run(filesOf('a', 'b'))

    // 回転 source の figure には crop の CPU を使わない。
    expect(cropState.calls).toBe(1)
    const args = mockPublishPreparedUploadTx.mock.calls[0][1] as {
      cardImagesByCardId: Record<string, unknown[]>
      resultSummary: { figuresExcluded: Record<string, number> }
    }
    expect(args.resultSummary.figuresExcluded.orientation_unsupported).toBe(1)
    // crop を試みていない以上 crop 失敗ではない(理由を混ぜない)。
    expect(args.resultSummary.figuresExcluded.crop_failed).toBe(0)
    // 正立 source の figure は通常どおり card image になる。
    expect(Object.values(args.cardImagesByCardId).flat()).toHaveLength(1)
  })

  // Codex P2(fix round 3): orientation は **decode 段で判明**しており、その figure は
  // そもそも crop され得なかった。 予算判定より後ろで見ると deadline_excluded に食われ、
  // 画面には「**上限のため**省略しました」と出る — 束を「取り込めませんでした」に決めた
  // 理由(こちらが上限を決めて打ち切ったのではなく扱えなかった)を corner case で
  // ひっくり返す。 「稀だから」は本機構では受容理由にならない(機構全体が rare path の
  // 検知である)。
  it('予算枯渇後でも回転 source の figure は orientation_unsupported(deadline_excluded に食われない)', async () => {
    sharpState.orientationAt = { 0: 6 } // 1 枚目だけ回転
    // 予算は Gemini mock の中で時計を進めて枯渇させる(既存 deadline test と同手口)。
    const realNow = Date.now.bind(Date)
    let clockOffset = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
    try {
      const withFigures = geminiWithFigures(2)
      mockCallGemini.mockImplementation(async (req: { parts: GeminiContentPart[] }) => {
        clockOffset += GEMINI_TIMEOUT_MS
        return withFigures(req)
      })
      await run(filesOf('a', 'b'), { deadlineOffsetMs: GEMINI_TIMEOUT_MS + 1_000 })
    } finally {
      nowSpy.mockRestore()
    }

    expect(cropState.calls).toBe(0)
    const args = mockPublishPreparedUploadTx.mock.calls[0][1] as {
      resultSummary: { figuresExcluded: Record<string, number> }
    }
    // fig0 = 回転 source(向き未対応)/ fig1 = 正立 source(予算切れ)。 同じ run で
    // 「回転は食われない」と「回転でなければ従来どおり deadline」を同時に見る。
    expect(args.resultSummary.figuresExcluded.orientation_unsupported).toBe(1)
    expect(args.resultSummary.figuresExcluded.deadline_excluded).toBe(1)
  })

  it('EXIF=1 / EXIF 非搭載では何も起きない(warn 無し・除外 0・crop は通常どおり)', async () => {
    // 1 枚目 = EXIF orientation 1(正立の明示)/ 2 枚目 = EXIF 非搭載(undefined)。
    // **undefined を異常にすると全 PNG が誤検知**になるため、ここが通常経路の gate。
    sharpState.orientationAt = { 0: 1 }
    mockCallGemini.mockImplementation(geminiWithFigures(2))

    await run(filesOf('a', 'b'))

    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.source_orientation_unsupported' }),
    )
    expect(cropState.calls).toBe(2)
    const args = mockPublishPreparedUploadTx.mock.calls[0][1] as {
      resultSummary: { figuresExcluded: Record<string, number> }
    }
    expect(args.resultSummary.figuresExcluded.orientation_unsupported).toBe(0)
  })
})

describe('runUploadPipeline — publish phase(S-3)', () => {
  it('publish tx の失敗は terminal(publish_failed)— commit 後ゆえ fence は prepared', async () => {
    txState.opRows = [{ status: 'prepared', leaseVersion: 0 }]
    mockPublishPreparedUploadTx.mockRejectedValue(new Error('duplicate card id'))

    await expect(run(filesOf('a'))).resolves.toBeUndefined()

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.publish_tx_failed' }),
    )
    // 'raced' ではなく実際に terminal 化される(fence を processing 固定にすると
    // ここが 'raced' に化けて op が prepared + live lease のまま残る)。
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'publish_failed',
        outcome: 'terminalized',
      }),
    )
  })

  it('publish tx が stale(fencing 敗北)なら terminal 化しない', async () => {
    txState.opRows = [{ status: 'prepared', leaseVersion: 0 }]
    mockPublishPreparedUploadTx.mockResolvedValue({ outcome: 'stale' })

    await run(filesOf('a'))

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.publish_raced' }),
    )
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.failed' }),
    )
  })
})

describe('runUploadPipeline — 予期しない throw(catch-all)', () => {
  it('throw を外へ漏らさず integration_failures に PII-free で積む', async () => {
    vi.mocked(normalizePrepared).mockImplementationOnce(() => {
      throw new Error('boom')
    })

    await expect(run(filesOf('a'))).resolves.toBeUndefined()

    expect(mockRecordIntegrationFailure).toHaveBeenCalledTimes(1)
    const args = mockRecordIntegrationFailure.mock.calls[0][0] as Record<string, unknown>
    expect(args.key).toBe('ocr_pipeline')
    expect(args.userId).toBe(USER_ID)
    // context は operationId + errorCode のみ(filename / base64 / payload を含めない)。
    expect(args.context).toEqual({
      operationId: REFS.operationId,
      errorCode: 'pipeline_unexpected_error',
    })
    expect(JSON.stringify(args)).not.toContain('a.png')
    expect(JSON.stringify(args)).not.toContain(pngLike('a').toString('base64'))
  })

  it('DB が落ちていて terminal 化すらできなくても throw しない', async () => {
    mockWithTenantTx.mockRejectedValue(new Error('db down'))

    await expect(run(filesOf('a'))).resolves.toBeUndefined()

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.terminalize_failed' }),
    )
    expect(mockRecordIntegrationFailure).toHaveBeenCalledTimes(1)
  })

  it('integration_failures の記録自体が失敗しても throw しない', async () => {
    vi.mocked(normalizePrepared).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    mockRecordIntegrationFailure.mockRejectedValue(new Error('ledger down'))

    await expect(run(filesOf('a'))).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ②-4b T8: PDF count phase / render phase(spec D4/D6/D8/§6)
// ---------------------------------------------------------------------------
describe('runUploadPipeline — PDF count phase(spec D4/D8: 層 3 = 唯一の機械保証)', () => {
  it('合計(画像+Σ実ページ)が上限超過なら render を一度も呼ばず page_limit_exceeded で terminal', async () => {
    // 41 ページ 1 冊(pageCount echo は無視される値 — 正本は実ページ数)。
    const pdf = registerPdf(
      'aaaaaaaa-0000-4000-8000-000000000001',
      Array.from({ length: 41 }, (_, i) => webpLike(`p${i}`)),
    )

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(pdfState.renderCalls).toHaveLength(0)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'page_limit_exceeded',
      }),
    )
    // 出口 DELETE は render 0 呼出でも走る(spec §6 本線 2)。
    const key = sourcePdfObjectKey(USER_ID, SESSION_ID, pdf.fileId)
    expect(mockDeleteObject).toHaveBeenCalledWith(key)
  })

  it('画像枚数 + 複数 PDF の合算で判定する(count phase が実ページ数を数え直す)', async () => {
    const pdfA = registerPdf(
      'aaaaaaaa-0000-4000-8000-000000000002',
      Array.from({ length: 20 }, (_, i) => webpLike(`a${i}`)),
    )
    const pdfB = registerPdf(
      'aaaaaaaa-0000-4000-8000-000000000003',
      Array.from({ length: 20 }, (_, i) => webpLike(`b${i}`)),
    )
    // 画像 1 枚 + PDF 20p + PDF 20p = 41 > 40。
    await runWithPdf(filesOf('img'), [pdfA, pdfB], [
      { kind: 'image', fileIndex: 0 },
      { kind: 'pdf', fileId: pdfA.fileId },
      { kind: 'pdf', fileId: pdfB.fileId },
    ])

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'page_limit_exceeded',
      }),
    )
  })

  // fix round 4(canonical/Codex Critical 修正1): 上限超過が「途中の 1 冊」で確定したら
  // その場で return し、後続 PDF を 1 冊も GET しない(旧: loop を最後まで回してから
  // 判定していたため、超過確定後も残り全冊の GET/parse を続けていた)。
  it('途中の PDF でページ超過が確定したら後続 PDF を GET しない', async () => {
    const pdfA = registerPdf(
      'aaaaaaaa-0000-4000-8000-000000000013',
      Array.from({ length: 41 }, (_, i) => webpLike(`a${i}`)),
    )
    const pdfB = registerPdf('aaaaaaaa-0000-4000-8000-000000000014', [webpLike('b0')])

    await runWithPdf([], [pdfA, pdfB], [
      { kind: 'pdf', fileId: pdfA.fileId },
      { kind: 'pdf', fileId: pdfB.fileId },
    ])

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'page_limit_exceeded',
      }),
    )
    // pdfA(超過確定した冊)だけ GET され、pdfB は 1 度も GET されない。
    const keyA = sourcePdfObjectKey(USER_ID, SESSION_ID, pdfA.fileId)
    const keyB = sourcePdfObjectKey(USER_ID, SESSION_ID, pdfB.fileId)
    expect(mockGetObject).toHaveBeenCalledTimes(1)
    expect(mockGetObject).toHaveBeenCalledWith(keyA, expect.anything())
    expect(mockGetObject).not.toHaveBeenCalledWith(keyB, expect.anything())
    // 所有権があるため(raced ではない)出口 DELETE は両 key に対して通常どおり
    // 行われる(brief 要件 5: terminal + 所有権があれば DELETE)。
    expect(mockDeleteObject).toHaveBeenCalledWith(keyA)
    expect(mockDeleteObject).toHaveBeenCalledWith(keyB)
  })

  // whole-branch review 必須3(分岐①): count phase の GET null(upload-pipeline.ts
  // :255-256)が test でゼロだった。registerPdf を使わず r2State/pdfState どちらにも
  // 登録しない(= mockGetObject が null を返す既定挙動)。
  it('R2 GET が null(オブジェクト不在)を返したら pdf_source_unavailable で terminal', async () => {
    const fileId = 'aaaaaaaa-0000-4000-8000-000000000020'
    const pdf: UploadPipelineSourcePdf = {
      fileId,
      filename: 'missing.pdf',
      pageCount: 1,
      declaredBytes: 100,
    }

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId }])

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(pdfState.renderCalls).toHaveLength(0)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'pdf_source_unavailable',
      }),
    )
    // ユーザー起因の失敗 — 台帳(loud)には積まない(pdf_render_failed と同じ扱い)。
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
    // 所有権があるため出口 DELETE は通常どおり行われる。
    const key = sourcePdfObjectKey(USER_ID, SESSION_ID, fileId)
    expect(mockDeleteObject).toHaveBeenCalledWith(key)
  })

  // whole-branch review 必須3(分岐②): count phase の loadPdf が PdfParseError を
  // 投げるケース(upload-pipeline.ts :264-266)が test でゼロだった。
  it('loadPdf が PdfParseError を投げたら pdf_source_unavailable で terminal(壊れ/暗号化 PDF)', async () => {
    const fileId = 'aaaaaaaa-0000-4000-8000-000000000021'
    const pdf = registerPdf(fileId, [webpLike('p0')])
    const bytesB64 = pdfBytes(fileId).toString('base64')
    // 1 回目(count phase)の loadPdf 呼出だけを失敗させる。
    pdfState.loadErrorAtCall.set(bytesB64, 1)
    pdfState.loadErrorFactory = () => new PdfParseError('mock load failure (count phase)')

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockCallGemini).not.toHaveBeenCalled()
    // count phase で terminal 化するため render phase の renderPageWebp は呼ばれない。
    expect(pdfState.renderCalls).toHaveLength(0)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'pdf_source_unavailable',
      }),
    )
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
    const key = sourcePdfObjectKey(USER_ID, SESSION_ID, fileId)
    expect(mockDeleteObject).toHaveBeenCalledWith(key)
  })
})

describe('runUploadPipeline — PDF render phase: TOCTOU(spec §6/Codex C1)', () => {
  it('count phase の GET と render phase の再 GET で bytes の sha256 が変わっていたら terminal(source_changed)', async () => {
    const fileId = 'aaaaaaaa-0000-4000-8000-000000000004'
    const key = sourcePdfObjectKey(USER_ID, SESSION_ID, fileId)
    const countBytes = pdfBytes(fileId)
    const renderBytes = Buffer.from('DIFFERENT-BYTES-AFTER-REPUT')
    // count phase(1 回目の GET)は countBytes / render phase(2 回目以降)は renderBytes。
    r2State.bytesByKey.set(key, [countBytes, renderBytes])
    pdfState.pagesByBytesB64.set(countBytes.toString('base64'), [webpLike('p0'), webpLike('p1')])

    const pdf: UploadPipelineSourcePdf = {
      fileId,
      filename: 'x.pdf',
      pageCount: 2,
      declaredBytes: countBytes.length,
    }
    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId }])

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'source_changed',
      }),
    )
    // sha 不一致は loadPdf(render 用)より前に検出する — render 用 bytes で
    // renderPageWebp は 1 度も呼ばれない。
    expect(pdfState.renderCalls).toHaveLength(0)
  })
})

describe('runUploadPipeline — PDF render phase: webp 累計上限(spec D7 r4・loud)', () => {
  it('webp 累計が MAX_RENDERED_WEBP_TOTAL_BYTES を超えたら terminal(webp_limit_exceeded・loud 記帳)', async () => {
    const fileId = 'aaaaaaaa-0000-4000-8000-000000000005'
    // page0=10MB(累計 10MB・OK)/ page1=25MB(累計 35MB > 30MB・ここで打ち切り)/
    // page2 は到達しないことを確認するためのダミー。
    const pages = [
      webpLike('p0', 10_000_000),
      webpLike('p1', 25_000_000),
      webpLike('p2', 1_000_000),
    ]
    const pdf = registerPdf(fileId, pages)

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId }])

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'webp_limit_exceeded',
      }),
    )
    // page2 まで進んでいない(累計超過で即打ち切り)。
    expect(pdfState.renderCalls).toEqual([
      expect.stringContaining(':0'),
      expect.stringContaining(':1'),
    ])
    // loud: recordUnexpectedFailure 経由で integration_failures にも積む。
    expect(mockRecordIntegrationFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'ocr_pipeline',
        context: expect.objectContaining({ errorCode: 'webp_limit_exceeded' }),
      }),
    )
  })
})

// fix round 1(canonical Important 1): pdf-rasterize.ts は getPage/render/sharp
// encode のあらゆる失敗を PdfParseError に包む(count phase を通過した後でも
// 1 ページだけ壊れている PDF は render 呼出時にこれで失敗しうる)。ユーザー入力
// 起因の予期される失敗であり、integration_failures/Discord を鳴らすシステム障害
// ではない — この file 自身の規律(`:1052` 付近「台帳はユーザー起因の失敗で
// 埋めない」)に従い、terminal 化のみで台帳には積まないことを pin する。
describe('runUploadPipeline — PDF render phase: ページ単位の render 失敗(Important 1 fix)', () => {
  it('renderPageWebp が PdfParseError を投げたら terminal 化するだけで台帳には積まない', async () => {
    const fileId = 'aaaaaaaa-0000-4000-8000-000000000009'
    const pages = [webpLike('p0'), webpLike('p1')]
    const pdf = registerPdf(fileId, pages)
    const bytesB64 = pdfBytes(fileId).toString('base64')
    // 2 ページ目(index 1)の render で PdfParseError を投げる。
    pdfState.renderErrorAt.set(bytesB64, 1)
    pdfState.renderErrorFactory = () => new PdfParseError('mock render failure')

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId }])

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'pdf_render_failed',
      }),
    )
    // ユーザー入力起因 — 台帳(loud)には積まない(webp_limit_exceeded と異なる扱い)。
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
    // handle は失敗経路でも destroy される(既存 pdf-rasterize.ts の try/finally 契約
    // + 本 file の finally が呼ぶ)。
    expect(pdfState.destroyCalls).toBeGreaterThan(0)
  })
})

// whole-branch review 必須3(分岐③)+ Minor4 fix: render phase の再 GET null /
// loadPdf の PdfParseError が test でゼロだった(Minor4 fix はこの wave で
// render phase の loadPdf に catch を新設した分)。
describe('runUploadPipeline — PDF render phase: R2 再 GET null / loadPdf 失敗(必須3 + Minor4 fix)', () => {
  it('render phase の再 GET が null を返したら pdf_source_unavailable で terminal(必須3 分岐③)', async () => {
    const fileId = 'aaaaaaaa-0000-4000-8000-000000000022'
    const pdf = registerPdf(fileId, [webpLike('p0')])
    const key = sourcePdfObjectKey(USER_ID, SESSION_ID, fileId)
    // 1 回目(count phase の GET)は成功・2 回目(render phase の再 GET)だけ null。
    r2State.nullAtCall.set(key, 2)

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockCallGemini).not.toHaveBeenCalled()
    // render phase の再 GET で terminal 化するため renderPageWebp は呼ばれない。
    expect(pdfState.renderCalls).toHaveLength(0)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'pdf_source_unavailable',
      }),
    )
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
    expect(mockDeleteObject).toHaveBeenCalledWith(key)
  })

  // Minor4 fix 本体: render phase の loadPdf(count phase の loadPdf とは別呼出)が
  // PdfParseError を投げるケース。fix 前は catch が無く catch-all(予期しない
  // throw → integration_failures/Discord)に落ちていた。
  it('render phase の loadPdf が PdfParseError を投げたら pdf_source_unavailable で terminal(台帳には積まない)', async () => {
    const fileId = 'aaaaaaaa-0000-4000-8000-000000000023'
    const pdf = registerPdf(fileId, [webpLike('p0')])
    const bytesB64 = pdfBytes(fileId).toString('base64')
    // 1 回目(count phase)は成功・2 回目(render phase)の loadPdf だけ失敗させる。
    pdfState.loadErrorAtCall.set(bytesB64, 2)
    pdfState.loadErrorFactory = () => new PdfParseError('mock load failure (render phase)')

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(pdfState.renderCalls).toHaveLength(0)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'pdf_source_unavailable',
      }),
    )
    // fix 前はここが呼ばれてしまっていた(catch-all 経由の loud 記録)— fix 後は
    // ユーザー起因の失敗として静かに terminal 化するだけ。
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
    const key = sourcePdfObjectKey(USER_ID, SESSION_ID, fileId)
    expect(mockDeleteObject).toHaveBeenCalledWith(key)
  })
})

// fix round 1(canonical Minor 11): 既定 GET_TIMEOUT_MS(10s)への regression を
// 「型でも uuid 検証でも捕まらない」まま静かに戻さないための pin
// (PDF_SOURCE_GET_TIMEOUT_MS は upload-pipeline.ts の非 export 定数のため、
// ここでは spec 値 60_000 を直接期待値として持つ)。
describe('runUploadPipeline — PDF source GET timeout(spec D8: 既定 10s は 50MB PDF に不足しうる)', () => {
  it('count/render phase の getObject は timeoutMs:60000 を明示する', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-00000000000a', [pngLike('p0')])

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockGetObject).toHaveBeenCalledTimes(2) // count phase 1 回 + render phase 1 回
    const calls = mockGetObject.mock.calls as unknown as [string, { timeoutMs?: number }][]
    for (const [, opts] of calls) {
      expect(opts).toEqual({ timeoutMs: 60_000 })
    }
  })
})

// fix round 4(canonical/Codex Critical 修正2): 残余予算チェックは phase 開始前の
// 1 回だけでなく、count/render 両 phase の **loop 内**(各 PDF の GET 前・render は
// 各 renderPageWebp 前も)に置く — 修正1(in-loop 上限判定)だけでは「40 冊 × 1
// ページ」のように上限には収まったまま多数の GET を続けるケースを防げない。
// PDF_SOURCE_GET_TIMEOUT_MS(60_000ms・upload-pipeline.ts の非 export 定数)を
// loop 内チェックの閾値としても流用している(定数コメント参照)。
describe('runUploadPipeline — PDF count/render phase: loop 内 deadline チェック(fix round 4 Critical)', () => {
  it('count phase 中に予算が尽きたら次の PDF を GET せず deadline_exceeded で terminal(所有権があるため DELETE される)', async () => {
    const pdfA = registerPdf('aaaaaaaa-0000-4000-8000-000000000015', [pngLike('a0')])
    const pdfB = registerPdf('aaaaaaaa-0000-4000-8000-000000000016', [pngLike('b0')])
    const keyA = sourcePdfObjectKey(USER_ID, SESSION_ID, pdfA.fileId)
    const keyB = sourcePdfObjectKey(USER_ID, SESSION_ID, pdfB.fileId)

    const realNow = Date.now.bind(Date)
    let clockOffset = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
    try {
      mockGetObject.mockImplementation(async (key: string) => {
        const queue = r2State.bytesByKey.get(key)
        const bytes = queue && queue.length > 0 ? (queue.length > 1 ? queue.shift()! : queue[0]) : null
        if (key === keyA) {
          // pdfA の GET(count phase の 1 回目)が予算をほぼ使い切ったことにする —
          // pdfB の GET **前**の loop 内チェックが deadline_exceeded で落ちるはず。
          clockOffset += 61_000
        }
        return bytes ? { bytes } : null
      })

      await runWithPdf([], [pdfA, pdfB], [
        { kind: 'pdf', fileId: pdfA.fileId },
        { kind: 'pdf', fileId: pdfB.fileId },
      ], { deadlineOffsetMs: 65_000 })
    } finally {
      nowSpy.mockRestore()
    }

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'deadline_exceeded',
      }),
    )
    // pdfB は count phase で 1 度も GET されない。
    expect(mockGetObject).toHaveBeenCalledWith(keyA, expect.anything())
    expect(mockGetObject).not.toHaveBeenCalledWith(keyB, expect.anything())
    // 所有権があるため出口 DELETE は両 key に対して通常どおり行われる(要件5)。
    expect(mockDeleteObject).toHaveBeenCalledWith(keyA)
    expect(mockDeleteObject).toHaveBeenCalledWith(keyB)
  })

  it('render phase 中に予算が尽きたら次の PDF を GET しない', async () => {
    const pdfA = registerPdf('aaaaaaaa-0000-4000-8000-000000000017', [pngLike('a0')])
    const pdfB = registerPdf('aaaaaaaa-0000-4000-8000-000000000018', [pngLike('b0')])
    const keyA = sourcePdfObjectKey(USER_ID, SESSION_ID, pdfA.fileId)
    const keyB = sourcePdfObjectKey(USER_ID, SESSION_ID, pdfB.fileId)
    const bytesAB64 = pdfBytes(pdfA.fileId).toString('base64')

    const realNow = Date.now.bind(Date)
    let clockOffset = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
    try {
      // pdfA の(唯一の)page 0 が render された直後に予算をほぼ使い切ったことにする
      // — これで pdfA 自身の render は完走し、pdfB の GET **前**の loop 内チェック
      // だけが deadline_exceeded で落ちる(GET 直後に飛ばすと pdfA 自身の
      // renderPageWebp 前チェックまで巻き込んでしまうため、page render 側で
      // 飛ばす)。
      pdfState.onRenderPage = (b64: string) => {
        if (b64 === bytesAB64) {
          clockOffset += 61_000
        }
      }

      await runWithPdf([], [pdfA, pdfB], [
        { kind: 'pdf', fileId: pdfA.fileId },
        { kind: 'pdf', fileId: pdfB.fileId },
      ], { deadlineOffsetMs: 65_000 })
    } finally {
      nowSpy.mockRestore()
    }

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'deadline_exceeded',
      }),
    )
    // pdfA は自身の 1 ページを render し切る(renderCalls に現れる)。
    expect(pdfState.renderCalls).toHaveLength(1)
    // pdfA は count + render で計 2 回 GET されるが、pdfB は count phase の 1 回
    // だけで render phase の再 GET には至らない。
    expect(
      (mockGetObject.mock.calls as unknown as [string][]).filter(([k]) => k === keyA),
    ).toHaveLength(2)
    expect(
      (mockGetObject.mock.calls as unknown as [string][]).filter(([k]) => k === keyB),
    ).toHaveLength(1)
    // 所有権があるため出口 DELETE は両 key に対して通常どおり行われる(要件5)。
    expect(mockDeleteObject).toHaveBeenCalledWith(keyA)
    expect(mockDeleteObject).toHaveBeenCalledWith(keyB)
  })

  it('ページ間で予算が尽きたら次の renderPageWebp を呼ばない', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-000000000019', [
      pngLike('p0'),
      pngLike('p1'),
      pngLike('p2'),
    ])
    const key = sourcePdfObjectKey(USER_ID, SESSION_ID, pdf.fileId)

    const realNow = Date.now.bind(Date)
    let clockOffset = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
    try {
      pdfState.onRenderPage = (_b64: string, i: number) => {
        // page 0 の render 直後に予算をほぼ使い切ったことにする — page 1 の
        // renderPageWebp **前**の loop 内チェックが deadline_exceeded で落ちるはず。
        if (i === 0) {
          clockOffset += 61_000
        }
      }

      await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }], {
        deadlineOffsetMs: 65_000,
      })
    } finally {
      nowSpy.mockRestore()
    }

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'deadline_exceeded',
      }),
    )
    // page 0 だけ render され、page 1/2 は呼ばれない。
    expect(pdfState.renderCalls).toEqual([expect.stringContaining(':0')])
    // 所有権があるため出口 DELETE は通常どおり行われる(要件5)。
    expect(mockDeleteObject).toHaveBeenCalledWith(key)
  })
})

describe('runUploadPipeline — sourceOrder の合流(spec §2/D3)', () => {
  it('画像/PDF が混在した manifest 順どおりに Gemini parts へ合流する', async () => {
    const images = filesOf('imgA', 'imgB')
    // decode phase は mock 済 sharp が常に format:'png' を返す(source-image-verify.ts
    // の sniff/decode 一致検証を通すため、ここでは rasterize 済みページも
    // pngLike で表す — 実 webp 出力の形状は pdf-rasterize.test.ts(実 sharp)が
    // 別途保証する。本 test の主張は「合流順」であって mimeType の実値ではない)。
    const pdfX = registerPdf('aaaaaaaa-0000-4000-8000-000000000006', [
      pngLike('x0'),
      pngLike('x1'),
    ])
    const pdfY = registerPdf('aaaaaaaa-0000-4000-8000-000000000007', [pngLike('y0')])

    await runWithPdf(images, [pdfX, pdfY], [
      { kind: 'image', fileIndex: 0 },
      { kind: 'pdf', fileId: pdfX.fileId },
      { kind: 'image', fileIndex: 1 },
      { kind: 'pdf', fileId: pdfY.fileId },
    ])

    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    const parts = mockCallGemini.mock.calls[0][0].parts as GeminiContentPart[]
    const images_ = parts.filter(
      (p): p is { inlineData: { mimeType: string; data: string } } => 'inlineData' in p,
    )
    // 合流順 = imgA, x0, x1, imgB, y0(sourceOrder どおり)。
    expect(images_.map((p) => p.inlineData.data)).toEqual([
      images[0].buffer.toString('base64'),
      pngLike('x0').toString('base64'),
      pngLike('x1').toString('base64'),
      images[1].buffer.toString('base64'),
      pngLike('y0').toString('base64'),
    ])

    // fix round 1(canonical Important 2): 出口 DELETE が**全** source key を
    // 対象にすることを、単一 key への `toHaveBeenCalledWith` ではなく呼ばれた
    // key の**集合**(件数込み)で pin する — 単一 key 版では `keys[0]` だけ
    // 消す実装でも green になってしまう(検出力ゼロだった)。
    const deletedKeys = mockDeleteObject.mock.calls.map((c) => c[0])
    const expectedKeys = [
      sourcePdfObjectKey(USER_ID, SESSION_ID, pdfX.fileId),
      sourcePdfObjectKey(USER_ID, SESSION_ID, pdfY.fileId),
    ]
    expect(deletedKeys).toHaveLength(expectedKeys.length)
    expect(deletedKeys).toEqual(expect.arrayContaining(expectedKeys))
  })
})

// fix round 2(canonical Critical): 無条件 DELETE は所有権を失った invocation が
// 共有 source を消しうる(fence に負けた側が finally で消すと、count と render の
// 間にいる勝者の再 GET が null になり誤って terminal 化されうる)。「fence に負けたと
// 明示的に判明した経路」(start_cas_lost / count_cas_lost / commit_raced /
// publish_raced)でのみ DELETE を skip することを pin する。予期しない throw では
// 所有権喪失の証拠が無いため従来どおり削除する。
describe('runUploadPipeline — PDF 出口 DELETE: fence 敗北時は skip する(fix round 2 Critical)', () => {
  it('start_cas_lost では DELETE を skip する', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-00000000000b', [pngLike('p0')])
    txState.startCasRows = []

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.start_cas_lost' }),
    )
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('count_cas_lost では DELETE を skip する', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-00000000000c', [pngLike('p0')])
    // count-phase CAS(commitPdfCountCas)の `.returning()` も txState.commitReturning
    // を読む(fakeTx は table 非依存)。開始時点から空にしておけば、count phase 自体
    // (GET/loadPdf は tx を触らない)は正常に進み、CAS だけが 0 行で敗れる。
    txState.commitReturning = []

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.count_cas_lost' }),
    )
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('commit_raced(prepared payload CAS 敗北)では DELETE を skip する', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-00000000000d', [pngLike('p0')])
    // count-phase CAS は既定どおり成功させ、Gemini 呼出の中で(count-phase CAS
    // 通過後・prepared payload CAS 直前のタイミングで)txState.commitReturning を
    // 空にする — 既存「残り予算が crop 最低予算を切ったら」test と同じ「mock 内で
    // 共有 state を書き換える」手口。
    mockCallGemini.mockImplementation(async () => {
      txState.commitReturning = []
      return geminiOk()
    })

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.commit_raced' }),
    )
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('publish_raced(fencing 敗北)では DELETE を skip する', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-00000000000e', [pngLike('p0')])
    mockPublishPreparedUploadTx.mockResolvedValue({ outcome: 'stale' })

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.pipeline.publish_raced' }),
    )
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('予期しない throw では所有権喪失の証拠が無いため従来どおり DELETE する', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-00000000000f', [pngLike('p0')])
    vi.mocked(normalizePrepared).mockImplementationOnce(() => {
      throw new Error('boom')
    })

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockDeleteObject).toHaveBeenCalledWith(
      sourcePdfObjectKey(USER_ID, SESSION_ID, pdf.fileId),
    )
  })

  it('成功経路(publish 完了)では従来どおり DELETE する', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-000000000010', [pngLike('p0')])

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockDeleteObject).toHaveBeenCalledWith(
      sourcePdfObjectKey(USER_ID, SESSION_ID, pdf.fileId),
    )
  })

  // fix round 3(canonical/Codex Critical): fix round 2 が塞いだ 4 経路(start_cas_lost/
  // count_cas_lost/commit_raced/publish_raced)とは別に、`terminalize` 自身が内部で
  // 検知する fence 敗北(= 別の書き手が既にこの op を終端化済み)も所有権喪失の
  // 5 つ目のシグナル。`image_decode_failed` の terminalize 呼出を題材に、fence 確認
  // (txState.opRows)を「既に別の書き手が terminal_failed 済」に見せることで
  // raced を発火させる。
  it('terminalize が raced を返す(別 invocation が既に終端化済み)状況では DELETE を skip する', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-000000000011', [pngLike('p0')])
    sharpState.failAt = 0 // decode 失敗 → terminalize('image_decode_failed', PRE_COMMIT_FENCE)
    // PRE_COMMIT_FENCE = ['processing'] に含まれない status = raced。
    txState.opRows = [{ status: 'terminal_failed', leaseVersion: 0 }]

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'image_decode_failed',
        outcome: 'raced',
      }),
    )
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('terminalize が raced でない(通常の)場合は従来どおり DELETE する', async () => {
    const pdf = registerPdf('aaaaaaaa-0000-4000-8000-000000000012', [pngLike('p0')])
    sharpState.failAt = 0 // decode 失敗 → terminalize('image_decode_failed', PRE_COMMIT_FENCE)
    // txState.opRows は既定(processing・自分の lease)のまま = raced にならない。

    await runWithPdf([], [pdf], [{ kind: 'pdf', fileId: pdf.fileId }])

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'upload.pipeline.failed',
        errorCode: 'image_decode_failed',
        outcome: 'terminalized',
      }),
    )
    expect(mockDeleteObject).toHaveBeenCalledWith(
      sourcePdfObjectKey(USER_ID, SESSION_ID, pdf.fileId),
    )
  })
})

// ②-4b T8: PDF source は一時的に R2 に置く(spec §2/§6)ため、この file が R2 module
// から import してよいのは count/render phase の `getObject` と 出口 DELETE の
// `deleteObject` の 2 つだけに置き換える(旧: 完全非 import pin・submit-upload.ts:448
// の後継と同型)。`putObject` 不可 = source を server が書かない(server が書くのは
// crop-derived asset のみ・crop-and-store.ts の責務)。
describe('upload-pipeline.ts の R2 import は getObject / deleteObject のみ(spec §2/§6)', () => {
  // fix round 1(canonical Minor 1): `.match()` は最初の import 文しか見ないため、
  // 別の import 文で `putObject` 等を追加で import しても検出できなかった
  // (regex pin が「強制している」と主張する完全性が実際には部分的だった —
  // [[lesson_single_point_claims_decay]])。`matchAll` で全 import 文を集約し、
  // その**集合**が許可 2 export のみであることを検証する。
  it('許可された 2 export 以外を import していない(全 import 文を対象)', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, 'upload-pipeline.ts'),
      'utf8',
    )
    const matches = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*lib\/storage\/r2['"]/g),
    ]
    expect(matches.length).toBeGreaterThan(0)
    const imported = matches.flatMap((m) =>
      m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    expect(new Set(imported)).toEqual(new Set(['getObject', 'deleteObject']))
  })
})
