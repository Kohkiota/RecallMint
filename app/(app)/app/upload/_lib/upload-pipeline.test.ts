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
// publish tx は mock(実 DB を張らない)。 引数(cardImagesByCardId / fileSizeBytes /
// resultSummary)の検証点として使う。
vi.mock('../_actions/publish-prepared', () => ({
  publishPreparedUploadTx: mockPublishPreparedUploadTx,
}))

// vi.mock は import より前に hoist される。
import { GEMINI_TIMEOUT_MS, type GeminiContentPart } from '@/lib/ai/clients/gemini'
import { classifyCropOutcome } from '@/lib/media/crop-and-store'
import { normalizePrepared } from '@/lib/ocr/normalize-prepared'
import { runUploadPipeline, type UploadPipelineFile } from './upload-pipeline'

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
  it('upload_records の file_size_bytes は受領 Buffer の合計を渡す', async () => {
    const files = filesOf('a', 'b', 'c')

    await run(files)

    const args = mockPublishPreparedUploadTx.mock.calls[0][1] as { fileSizeBytes: number }
    expect(args.fileSizeBytes).toBe(files.reduce((s, f) => s + f.buffer.length, 0))
  })

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

describe('upload-pipeline.ts は R2 module を import しない(spec §2: source は R2 に置かない)', () => {
  it('source 上に @/lib/storage/r2 への import が存在しない', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, 'upload-pipeline.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/from\s+['"][^'"]*lib\/storage\/r2['"]/)
  })
})
