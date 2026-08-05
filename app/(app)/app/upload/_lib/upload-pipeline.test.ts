// ②-4a 単一 invocation Sprint Task S-2: runUploadPipeline(OCR phase)の unit 検証。
//
// 本 file が担うのは「DB を張らずに観測できる契約」だけ:
//   ① decode は**逐次**(論点 B: sharp を計測 mock にして peak 同時実行数 = 1)
//   ② R2 を一切使わない(source 走査)
//   ③ Gemini に渡す parts の順序・内容(受領順の source_id interleave)
//   ④ deadline 超過 / decode 失敗で Gemini を呼ばずに terminal へ落ちる
//   ⑤ 予期しない throw を外へ漏らさず integration_failures に PII-free で積む
// 実 PG 上の CAS / terminal 化 / ai_usage は tests/integration/pg/upload-pipeline.test.ts。
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
} = vi.hoisted(() => {
  // sharp の in-flight 計測 mock(論点 B)。 decode 窓 = metadata() 開始 〜
  // toBuffer() 解決(verifyImageBytes がこの順で 1 画像を処理する)。 逐次なら
  // peak = 1、Promise.all 化すると同時に metadata() へ入るため peak = 枚数。
  const sharpState = {
    inFlight: 0,
    peakInFlight: 0,
    calls: 0,
    // metadata() を throw させる 0-origin index(decode 失敗の注入点)。
    failAt: null as number | null,
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
        return { width: 100, height: 50 }
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

// vi.mock は import より前に hoist される。
import { GEMINI_TIMEOUT_MS, type GeminiContentPart } from '@/lib/ai/clients/gemini'
import { normalizePrepared } from '@/lib/ocr/normalize-prepared'
import { runUploadPipeline, type UploadPipelineFile } from './upload-pipeline'

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
  mockWithTenantTx.mockResolvedValue('committed')
  mockCallGemini.mockResolvedValue(geminiOk())
  mockIncrementAiUsage.mockResolvedValue(undefined)
  mockRecordIntegrationFailure.mockResolvedValue(undefined)
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
