// ocr-compare.ts の test。 実 API / 実 network は一切使わない
// (callGeminiRaw を vi.mock で完全に差し替える。 loadImageInline も差し替え、
// tests/fixtures/ocr/ には一切書き込まない — 画像 dir は各 test が OS tmpdir に作る)。
//
// pure helper(alignCards/alignOptions/diffCardFields/extractEvalSignals/
// buildComparisonReport)は mock 無しで直接呼ぶ。 orchestration(runCompare)は
// callGeminiRaw/loadImageInline を mock し、429 halt・error 分類・arm A/B の
// schema/prompt 分岐のみを検証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtractedCard } from '@/lib/ai/schemas/ocr-response'
import { buildDiscoverPrompt } from '@/lib/ai/prompts/ocr-extract'
import { buildDiscoverResponseJsonSchema } from '@/lib/ai/schemas/ocr-response'
import { buildArmBResponseSchema, buildArmBPromptSuffix } from './lib/figure-detect-schema'

const { mockCallGeminiRaw, mockLoadImageInline } = vi.hoisted(() => ({
  mockCallGeminiRaw: vi.fn(),
  mockLoadImageInline: vi.fn(),
}))

vi.mock('./lib/gemini-raw', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gemini-raw')>()
  return { ...actual, callGeminiRaw: mockCallGeminiRaw }
})
vi.mock('./lib/load-images', () => ({
  loadImageInline: mockLoadImageInline,
}))

import {
  alignCards,
  alignOptions,
  diffCardFields,
  extractEvalSignals,
  buildComparisonReport,
  categorizeError,
  parseCliArgs,
  runCompare,
  DEFAULT_MODELS,
  BASELINE_MODEL_ID,
  type OcrCompareResult,
  type ComparisonReportInput,
} from './ocr-compare'

// ============================================================================
// fixture ヘルパ
// ============================================================================

function makeCard(overrides: Partial<ExtractedCard> = {}): ExtractedCard {
  return {
    title: overrides.title ?? 'サンプル問題',
    sort_key: overrides.sort_key,
    question_text: overrides.question_text ?? '問題文',
    options: overrides.options ?? [
      { id: 'a', text: '選択肢A', is_correct: false },
      { id: 'b', text: '選択肢B', is_correct: true },
    ],
    correct_answer_ids: overrides.correct_answer_ids ?? ['b'],
    explanation_text: overrides.explanation_text,
    images: overrides.images ?? [],
    custom_props: overrides.custom_props,
  }
}

// ============================================================================
// alignCards
// ============================================================================

describe('alignCards', () => {
  it('sort_key があれば sort_key を主キーとして突き合わせる', () => {
    const a = [makeCard({ sort_key: '001', title: '問1(A版)' })]
    const b = [makeCard({ sort_key: '001', title: '問1(B版タイトル違い)' })]
    const aligned = alignCards(a, b)
    expect(aligned).toEqual([{ key: '001', a: a[0], b: b[0] }])
  })

  it('sort_key が無ければ title へフォールバックする', () => {
    const a = [makeCard({ title: '問1', question_text: 'A版本文' })]
    const b = [makeCard({ title: '問1', question_text: 'B版本文' })]
    const aligned = alignCards(a, b)
    expect(aligned).toEqual([{ key: '問1', a: a[0], b: b[0] }])
  })

  it('1 枚欠落しても後続カードの整列を巻き込まない(missing-card no-cascade)', () => {
    const q1 = makeCard({ sort_key: '001', title: 'Q1' })
    const q2 = makeCard({ sort_key: '002', title: 'Q2' })
    const q3 = makeCard({ sort_key: '003', title: 'Q3' })
    const a = [q1, q2, q3]
    const b = [q1, q3] // q2 が b 側で欠落

    const aligned = alignCards(a, b)

    expect(aligned).toEqual([
      { key: '001', a: q1, b: q1 },
      { key: '002', a: q2 }, // b 側なし。q3 は index ズレせず正しく q3 と対応
      { key: '003', a: q3, b: q3 },
    ])
  })

  it('b にのみ存在するカード(挿入)は b のみで出る', () => {
    const q1 = makeCard({ sort_key: '001' })
    const q2New = makeCard({ sort_key: '002', title: '新規挿入カード' })
    const aligned = alignCards([q1], [q1, q2New])
    expect(aligned).toEqual([
      { key: '001', a: q1, b: q1 },
      { key: '002', b: q2New },
    ])
  })

  it('順序は決定論的: a の出現順 → b のみのキーは b の出現順', () => {
    const aX = makeCard({ sort_key: 'X' })
    const aY = makeCard({ sort_key: 'Y' })
    const bOnly1 = makeCard({ sort_key: 'Z1' })
    const bOnly2 = makeCard({ sort_key: 'Z2' })
    const aligned = alignCards([aY, aX], [bOnly1, aX, bOnly2])
    expect(aligned.map((e) => e.key)).toEqual(['Y', 'X', 'Z1', 'Z2'])
  })
})

// ============================================================================
// alignOptions
// ============================================================================

describe('alignOptions', () => {
  it('id で突き合わせる(index ではない)', () => {
    const a = [
      { id: 'a', text: 'A', is_correct: false },
      { id: 'b', text: 'B', is_correct: true },
    ]
    // b 側は順序が入れ替わっている
    const b = [
      { id: 'b', text: 'B改', is_correct: true },
      { id: 'a', text: 'A改', is_correct: false },
    ]
    const aligned = alignOptions(a, b)
    expect(aligned).toEqual([
      { id: 'a', a: a[0], b: b[1] },
      { id: 'b', a: a[1], b: b[0] },
    ])
  })

  it('片側にのみ存在する option id は片側のみで出る', () => {
    const a = [{ id: 'a', text: 'A', is_correct: false }]
    const b = [
      { id: 'a', text: 'A', is_correct: false },
      { id: 'c', text: 'C(末尾追加)', is_correct: false },
    ]
    const aligned = alignOptions(a, b)
    expect(aligned).toEqual([
      { id: 'a', a: a[0], b: b[0] },
      { id: 'c', b: b[1] },
    ])
  })
})

// ============================================================================
// diffCardFields
// ============================================================================

describe('diffCardFields', () => {
  it('否定語が変わった question_text を changed: true として検出する', () => {
    const a = makeCard({ question_text: '次のうち正しいものはどれか' })
    const b = makeCard({ question_text: '次のうち正しくないものはどれか' })
    const diffs = diffCardFields(a, b)
    const q = diffs.find((d) => d.field === 'question_text')
    expect(q).toEqual({
      field: 'question_text',
      aText: '次のうち正しいものはどれか',
      bText: '次のうち正しくないものはどれか',
      changed: true,
    })
  })

  it('数値が変わった option text を changed: true として検出する', () => {
    const a = makeCard({ options: [{ id: 'a', text: '10mg 投与する', is_correct: false }] })
    const b = makeCard({ options: [{ id: 'a', text: '100mg 投与する', is_correct: false }] })
    const diffs = diffCardFields(a, b)
    const opt = diffs.find((d) => d.field === 'options[a].text')
    expect(opt).toEqual({
      field: 'options[a].text',
      aText: '10mg 投与する',
      bText: '100mg 投与する',
      changed: true,
    })
  })

  it('同一 field は changed: false', () => {
    const a = makeCard({ question_text: '同じ本文' })
    const b = makeCard({ question_text: '同じ本文' })
    const diffs = diffCardFields(a, b)
    expect(diffs.find((d) => d.field === 'question_text')).toEqual({
      field: 'question_text',
      aText: '同じ本文',
      bText: '同じ本文',
      changed: false,
    })
  })

  it('片側の card が無ければ、その側の全 field が null', () => {
    const a = makeCard({ question_text: '本文', explanation_text: '解説' })
    const diffs = diffCardFields(a, undefined)
    expect(diffs.find((d) => d.field === 'question_text')).toEqual({
      field: 'question_text',
      aText: '本文',
      bText: null,
      changed: true,
    })
    expect(diffs.find((d) => d.field === 'explanation_text')).toEqual({
      field: 'explanation_text',
      aText: '解説',
      bText: null,
      changed: true,
    })
  })

  it('explanation_text が両側とも無ければ changed: false(null===null)', () => {
    const a = makeCard({ explanation_text: undefined })
    const b = makeCard({ explanation_text: undefined })
    const diffs = diffCardFields(a, b)
    expect(diffs.find((d) => d.field === 'explanation_text')).toEqual({
      field: 'explanation_text',
      aText: null,
      bText: null,
      changed: false,
    })
  })
})

// ============================================================================
// extractEvalSignals
// ============================================================================

describe('extractEvalSignals', () => {
  it('否定語(cue リスト内)を検出する', () => {
    const card = makeCard({ question_text: '次のうち正しくないものを選べ' })
    const signals = extractEvalSignals(card)
    expect(signals.negations).toEqual(['正しくない', 'ない'])
  })

  it('数値(全角・桁区切り含む)を検出する', () => {
    const card = makeCard({ question_text: '', options: [
      { id: 'a', text: '10mg を 1,500 回、全角は１２３', is_correct: false },
    ] })
    const signals = extractEvalSignals(card)
    expect(signals.numbers).toEqual(['10', '1,500', '１２３'])
  })

  it('単位を検出する', () => {
    const card = makeCard({ question_text: '体温は37℃、投与量は10mg、濃度は5%' })
    const signals = extractEvalSignals(card)
    expect(signals.units).toEqual(expect.arrayContaining(['℃', 'mg', '%']))
  })

  it('記号を検出する', () => {
    const card = makeCard({ question_text: '許容範囲は ±5、基準は ≧10 とする' })
    const signals = extractEvalSignals(card)
    expect(signals.symbols).toEqual(expect.arrayContaining(['±', '≧']))
  })

  it('optionCount と lastOptionId を返す', () => {
    const card = makeCard({
      options: [
        { id: 'a', text: 'A', is_correct: false },
        { id: 'b', text: 'B', is_correct: false },
        { id: 'c', text: 'C', is_correct: true },
      ],
    })
    const signals = extractEvalSignals(card)
    expect(signals.optionCount).toBe(3)
    expect(signals.lastOptionId).toBe('c')
  })

  it('options が空なら lastOptionId は null', () => {
    const card = makeCard({ options: [] })
    const signals = extractEvalSignals(card)
    expect(signals.optionCount).toBe(0)
    expect(signals.lastOptionId).toBeNull()
  })
})

// ============================================================================
// categorizeError
// ============================================================================

describe('categorizeError', () => {
  it('429 メッセージを rate-limit に分類する', () => {
    expect(categorizeError(new Error('429 Too Many Requests'))).toBe('rate-limit')
  })

  it('timeout メッセージを timeout に分類する', () => {
    expect(categorizeError(new Error('Gemini call timeout: 220000ms を超過しました'))).toBe(
      'timeout',
    )
  })

  it('empty response.text メッセージを empty-text に分類する', () => {
    expect(categorizeError(new Error('Gemini returned empty response.text'))).toBe('empty-text')
  })

  it('not found メッセージを model-not-found に分類する', () => {
    expect(categorizeError(new Error('model "gemini-9000" is not found'))).toBe('model-not-found')
  })

  it('4xx/5xx ステータスを http-status に分類する', () => {
    expect(categorizeError(new Error('503 Service Unavailable'))).toBe('http-status')
  })

  it('未知のエラーは unknown に分類する', () => {
    expect(categorizeError(new Error('something totally unexpected happened'))).toBe('unknown')
  })
})

// ============================================================================
// buildComparisonReport
// ============================================================================

describe('buildComparisonReport', () => {
  const FIXED_TIMESTAMP_MS = 1_772_000_000_000 // 固定注入 timestamp(pure 関数内で Date.now しない確認を兼ねる)

  function baseResult(overrides: Partial<OcrCompareResult>): OcrCompareResult {
    return {
      modelId: overrides.modelId ?? BASELINE_MODEL_ID,
      arm: overrides.arm ?? 'A',
      imageFilename: overrides.imageFilename ?? 'img1.png',
      imageHash: 'hash',
      timestamp: FIXED_TIMESTAMP_MS,
      timeoutMs: 220_000,
      promptSchemaHash: 'schemahash',
      ok: overrides.ok ?? true,
      finishReason: overrides.finishReason,
      usage: overrides.usage,
      rawText: overrides.rawText,
      cards: overrides.cards,
      errorCategory: overrides.errorCategory,
      errorMessage: overrides.errorMessage,
    }
  }

  it('注入した timestamp をそのまま Generated 行に出す(内部で Date.now しない)', () => {
    const input: ComparisonReportInput = {
      generatedAtMs: FIXED_TIMESTAMP_MS,
      baselineModelId: BASELINE_MODEL_ID,
      imageFilenames: [],
      results: [],
    }
    const report = buildComparisonReport(input)
    expect(report).toContain(`Generated: ${new Date(FIXED_TIMESTAMP_MS).toISOString()}`)
  })

  it('致命的差分(critical diffs)セクションが cost / usage セクションより前に出る(埋もれない順序)', () => {
    const baselineCard = makeCard({ sort_key: '001', question_text: '正しいものはどれか' })
    const otherCard = makeCard({ sort_key: '001', question_text: '正しくないものはどれか' })
    const results: OcrCompareResult[] = [
      baseResult({ modelId: BASELINE_MODEL_ID, arm: 'A', cards: [baselineCard] }),
      baseResult({ modelId: 'gemini-3.1-flash-lite', arm: 'A', cards: [otherCard] }),
    ]
    const report = buildComparisonReport({
      generatedAtMs: FIXED_TIMESTAMP_MS,
      baselineModelId: BASELINE_MODEL_ID,
      imageFilenames: ['img1.png'],
      results,
    })

    const criticalIdx = report.indexOf('### Critical field diffs')
    const optionCountIdx = report.indexOf('### Option counts')
    const blankLineIdx = report.indexOf('### Table blank-line check')
    const costIdx = report.indexOf('### Cost (USD/image)')
    const usageIdx = report.indexOf('### finishReason + token usage')

    expect(criticalIdx).toBeGreaterThanOrEqual(0)
    expect(criticalIdx).toBeLessThan(optionCountIdx)
    expect(optionCountIdx).toBeLessThan(blankLineIdx)
    expect(blankLineIdx).toBeLessThan(costIdx)
    expect(costIdx).toBeLessThan(usageIdx)

    // 致命的差分の本文(否定語変化)がそのセクション内に実際に出ている
    const criticalSection = report.slice(criticalIdx, optionCountIdx)
    expect(criticalSection).toContain('正しいものはどれか')
    expect(criticalSection).toContain('正しくないものはどれか')
  })

  it('cost が null(usage 欠測)のとき N/A を表示する', () => {
    const results: OcrCompareResult[] = [
      baseResult({ modelId: BASELINE_MODEL_ID, arm: 'A', usage: undefined }),
    ]
    const report = buildComparisonReport({
      generatedAtMs: FIXED_TIMESTAMP_MS,
      baselineModelId: BASELINE_MODEL_ID,
      imageFilenames: ['img1.png'],
      results,
    })
    const costSection = report.slice(
      report.indexOf('### Cost (USD/image)'),
      report.indexOf('### finishReason + token usage'),
    )
    expect(costSection).toContain(
      `| ${BASELINE_MODEL_ID} | A | N/A | N/A |`,
    )
  })

  it('usage が揃っているモデルは baseline との delta を数値で表示する(baseline 自身は delta 0)', () => {
    const results: OcrCompareResult[] = [
      baseResult({
        modelId: BASELINE_MODEL_ID,
        arm: 'A',
        usage: { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 0, totalTokenCount: 1500 },
      }),
    ]
    const report = buildComparisonReport({
      generatedAtMs: FIXED_TIMESTAMP_MS,
      baselineModelId: BASELINE_MODEL_ID,
      imageFilenames: ['img1.png'],
      results,
    })
    // baseline vs baseline の delta は 0(符号付き $0.000000 表記)
    expect(report).toMatch(/\| gemini-2\.5-flash \| A \| \$0\.\d{6} \| \+\$0\.000000 \|/)
  })

  it('arm B 結果はあるが同じ modelId の arm A leg が run 内に無い場合、無言の "(no comparison pairs)" ではなく理由を明示する', () => {
    // review 2026-07-28 Critical: この状態は「比較して差分無し」と区別が付かない
    // 沈黙になってはいけない。 明示的な skip 行が出ることを確認する。
    const results: OcrCompareResult[] = [
      baseResult({ modelId: 'gemini-3.5-flash-lite', arm: 'B', cards: [makeCard()] }),
    ]
    const report = buildComparisonReport({
      generatedAtMs: FIXED_TIMESTAMP_MS,
      baselineModelId: BASELINE_MODEL_ID,
      imageFilenames: ['img1.png'],
      results,
    })
    const criticalSection = report.slice(
      report.indexOf('### Critical field diffs'),
      report.indexOf('### Option counts'),
    )
    expect(criticalSection).toContain(
      '(no arm-A leg for gemini-3.5-flash-lite — A/B comparison skipped)',
    )
    expect(criticalSection).not.toContain('(no comparison pairs for this image)')
  })

  it('option 個数が実際に減った場合のみ MISSING TAIL OPTION、個数が同じで末尾 id だけ違う場合は reorder 扱いにする', () => {
    // review 2026-07-28 Minor: lastOptionId が違うだけで「欠落」と呼ぶと、
    // 単なる並べ替え/改称まで欠落扱いにしてしまう。
    const droppedCard = makeCard({
      sort_key: '001',
      options: [
        { id: 'a', text: 'A', is_correct: false },
        { id: 'b', text: 'B', is_correct: true },
      ],
    })
    const droppedOtherCard = makeCard({
      sort_key: '001',
      options: [{ id: 'a', text: 'A', is_correct: false }],
    })
    const reorderedCard = makeCard({
      sort_key: '002',
      options: [
        { id: 'a', text: 'A', is_correct: false },
        { id: 'b', text: 'B', is_correct: true },
      ],
    })
    const reorderedOtherCard = makeCard({
      sort_key: '002',
      options: [
        { id: 'b', text: 'B', is_correct: true },
        { id: 'a', text: 'A', is_correct: false },
      ],
    })
    const results: OcrCompareResult[] = [
      baseResult({
        modelId: BASELINE_MODEL_ID,
        arm: 'A',
        cards: [droppedCard, reorderedCard],
      }),
      baseResult({
        modelId: 'gemini-3.1-flash-lite',
        arm: 'A',
        cards: [droppedOtherCard, reorderedOtherCard],
      }),
    ]
    const report = buildComparisonReport({
      generatedAtMs: FIXED_TIMESTAMP_MS,
      baselineModelId: BASELINE_MODEL_ID,
      imageFilenames: ['img1.png'],
      results,
    })
    const optionCountSection = report.slice(
      report.indexOf('### Option counts'),
      report.indexOf('### Table blank-line check'),
    )
    expect(optionCountSection).toContain('Card `001`')
    expect(optionCountSection).toMatch(/Card `001`.*MISSING TAIL OPTION/)
    expect(optionCountSection).toMatch(
      /Card `002`.*tail option id changed \(reordered\/relabeled\)/,
    )
    expect(optionCountSection).not.toMatch(/Card `002`.*MISSING TAIL OPTION/)
  })
})

// ============================================================================
// parseCliArgs
// ============================================================================

describe('parseCliArgs', () => {
  it('--images 必須、既定 models/arm を補う', () => {
    const parsed = parseCliArgs(['--images', '/tmp/imgs'])
    expect(parsed.imagesDir).toBe('/tmp/imgs')
    expect(parsed.models).toEqual(DEFAULT_MODELS)
    expect(parsed.arm).toBe('A')
  })

  it('--images 無しは throw する', () => {
    expect(() => parseCliArgs([])).toThrow()
  })

  it('--models csv を分割する', () => {
    const parsed = parseCliArgs(['--images', 'dir', '--models', 'model-a, model-b'])
    expect(parsed.models).toEqual(['model-a', 'model-b'])
  })

  it('不正な --arm は throw する', () => {
    expect(() => parseCliArgs(['--images', 'dir', '--arm', 'C'])).toThrow()
  })
})

// ============================================================================
// runCompare(orchestration・callGeminiRaw/loadImageInline mock)
// ============================================================================

function makeImagesDir(filenames: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-compare-test-'))
  for (const f of filenames) writeFileSync(join(dir, f), 'dummy')
  return dir
}

const RAW_OK = JSON.stringify({
  cards: [{ title: 'Q', question_text: 'q', options: [], correct_answer_ids: [], images: [] }],
})

describe('runCompare', () => {
  let imagesDir: string
  let outDir: string

  beforeEach(() => {
    mockCallGeminiRaw.mockReset()
    mockLoadImageInline.mockReset()
    mockLoadImageInline.mockReturnValue({ mimeType: 'image/png', data: 'base64data' })
    imagesDir = makeImagesDir(['img1.png', 'img2.png'])
    outDir = mkdtempSync(join(tmpdir(), 'ocr-compare-out-'))
  })

  afterEach(() => {
    rmSync(imagesDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  })

  it('429 を受けたら結果を保存した上で run 全体を即停止し、以降の call を一切開始しない', async () => {
    // img1×modelA succeeds, img1×modelB は 429 → 停止。img2 側の call は一切発火しない。
    mockCallGeminiRaw
      .mockResolvedValueOnce({ text: RAW_OK, finishReason: 'STOP', usage: {} })
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))

    let counter = 1000
    const outcome = await runCompare({
      imagesDir,
      models: ['model-a', 'model-b'],
      arm: 'A',
      outDir,
      now: () => counter++,
    })

    expect(mockCallGeminiRaw).toHaveBeenCalledTimes(2)
    expect(outcome.halted).toBe(true)
    expect(outcome.results).toHaveLength(2)
    expect(outcome.results[0]).toMatchObject({ modelId: 'model-a', ok: true })
    expect(outcome.results[1]).toMatchObject({
      modelId: 'model-b',
      ok: false,
      errorCategory: 'rate-limit',
    })
    // 部分結果でもレポート/JSON は書かれる
    expect(readFileSync(outcome.reportPath, 'utf8')).toContain('img1.png')
    const json = JSON.parse(readFileSync(outcome.jsonPath, 'utf8'))
    expect(json.halted).toBe(true)
    expect(json.results).toHaveLength(2)
  })

  it('429 以外の失敗はカテゴライズして次の call へ続行する', async () => {
    mockCallGeminiRaw
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({ text: RAW_OK, finishReason: 'STOP', usage: {} })
      .mockResolvedValueOnce({ text: RAW_OK, finishReason: 'STOP', usage: {} })
      .mockResolvedValueOnce({ text: RAW_OK, finishReason: 'STOP', usage: {} })

    let counter = 2000
    const outcome = await runCompare({
      imagesDir,
      models: ['model-a', 'model-b'],
      arm: 'A',
      outDir,
      now: () => counter++,
    })

    // halt しない: img1×2model + img2×2model = 4 call 全部発火
    expect(mockCallGeminiRaw).toHaveBeenCalledTimes(4)
    expect(outcome.halted).toBe(false)
    expect(outcome.results).toHaveLength(4)
    expect(outcome.results[0]).toMatchObject({ ok: false, errorCategory: 'http-status' })
    expect(outcome.results[1]).toMatchObject({ ok: true })
  })

  it('parse 失敗も分類され、次の call へ続行する', async () => {
    mockCallGeminiRaw
      .mockResolvedValueOnce({ text: 'not-json', finishReason: 'STOP', usage: {} })
      .mockResolvedValueOnce({ text: RAW_OK, finishReason: 'STOP', usage: {} })

    const outcome = await runCompare({
      imagesDir: makeImagesDir(['img1.png']),
      models: ['model-a', 'model-b'],
      arm: 'A',
      outDir,
      now: () => 3000,
    })

    expect(outcome.results[0]).toMatchObject({ ok: false, errorCategory: 'parse-failure' })
    expect(outcome.results[1]).toMatchObject({ ok: true })
  })

  it('arm both: --arm-model が --models に含まれない場合、その arm A leg を追加した上で arm B を実行し、arm A schema/prompt とは別物を渡す', async () => {
    mockCallGeminiRaw.mockResolvedValue({ text: RAW_OK, finishReason: 'STOP', usage: {} })

    const outcome = await runCompare({
      imagesDir: makeImagesDir(['img1.png']),
      models: ['gemini-2.5-flash'],
      arm: 'both',
      armModel: 'gemini-3.5-flash-lite',
      outDir,
      now: () => 4000,
    })

    // gemini-2.5-flash(arm A・sweep)+ gemini-3.5-flash-lite(arm A・pairing 用に追加)+
    // gemini-3.5-flash-lite(arm B) = 3 call。 armModel が --models 外でも
    // buildComparisons が必ずペアを組めるよう arm A leg が補われている。
    expect(mockCallGeminiRaw).toHaveBeenCalledTimes(3)
    const calls = mockCallGeminiRaw.mock.calls.map((c) => c[0])
    expect(calls[0]).toMatchObject({ modelId: 'gemini-2.5-flash' })
    expect(calls[0].prompt).toBe(buildDiscoverPrompt())
    expect(calls[0].responseJsonSchema).toEqual(buildDiscoverResponseJsonSchema())

    expect(calls[1]).toMatchObject({ modelId: 'gemini-3.5-flash-lite' })
    expect(calls[1].prompt).toBe(buildDiscoverPrompt())
    expect(calls[1].responseJsonSchema).toEqual(buildDiscoverResponseJsonSchema())

    expect(calls[2]).toMatchObject({ modelId: 'gemini-3.5-flash-lite' })
    expect(calls[2].prompt).toBe(`${buildDiscoverPrompt()}\n\n${buildArmBPromptSuffix()}`)
    expect(calls[2].responseJsonSchema).toEqual(buildArmBResponseSchema())

    // mock-call の引数照合だけでなく、実際に buildComparisonReport を通して
    // gemini-3.5-flash-lite の arm A vs arm B の本物のペアが出ることを確認する
    // (review 2026-07-28: 「本当にペアが組めるか」が主眼で、mock 呼び出し確認だけでは
    // buildComparisons 側のペアリング失敗を見逃す)。
    const report = buildComparisonReport({
      generatedAtMs: 5000,
      baselineModelId: BASELINE_MODEL_ID,
      imageFilenames: ['img1.png'],
      results: outcome.results,
    })
    expect(report).toContain('gemini-3.5-flash-lite: arm A vs arm B')
    expect(report).not.toContain('no arm-A leg')
  })

  it('arm both: --arm-model が --models に含まれる場合は arm A leg を重複させない', async () => {
    mockCallGeminiRaw.mockResolvedValue({ text: RAW_OK, finishReason: 'STOP', usage: {} })

    await runCompare({
      imagesDir: makeImagesDir(['img1.png']),
      models: ['gemini-2.5-flash'],
      arm: 'both',
      armModel: 'gemini-2.5-flash',
      outDir,
      now: () => 4100,
    })

    // sweep の arm A 1 回 + arm B 1 回 = 2 call(重複 arm A を足さない)
    expect(mockCallGeminiRaw).toHaveBeenCalledTimes(2)
  })

  it('arm B(単独)は A/B 比較を生成できないため、実 API を叩く前に throw する', async () => {
    await expect(
      runCompare({
        imagesDir,
        models: ['model-a'],
        arm: 'B',
        armModel: 'model-a',
        outDir,
      }),
    ).rejects.toThrow(/--arm both --arm-model/)
    expect(mockCallGeminiRaw).not.toHaveBeenCalled()
  })

  it('--arm-model 無しで arm both を指定すると throw する(実 API を叩く前に)', async () => {
    await expect(
      runCompare({ imagesDir, models: ['model-a'], arm: 'both', outDir }),
    ).rejects.toThrow(/--arm-model/)
    expect(mockCallGeminiRaw).not.toHaveBeenCalled()
  })

  it('同じ outDir への 2 回の run は互いの出力を上書きしない(distinct filename)', async () => {
    mockCallGeminiRaw.mockResolvedValue({ text: RAW_OK, finishReason: 'STOP', usage: {} })

    const run1 = await runCompare({
      imagesDir: makeImagesDir(['img1.png']),
      models: ['model-a'],
      arm: 'A',
      outDir,
      now: () => 9000,
    })
    const run2 = await runCompare({
      imagesDir: makeImagesDir(['img1.png']),
      models: ['model-b'],
      arm: 'A',
      outDir,
      now: () => 9999,
    })

    expect(run1.reportPath).not.toBe(run2.reportPath)
    expect(run1.jsonPath).not.toBe(run2.jsonPath)
    // run2 実行後も run1 の出力が生き残っている(上書きされていない)
    expect(readFileSync(run1.reportPath, 'utf8')).toContain('model-a')
    expect(readFileSync(run2.reportPath, 'utf8')).toContain('model-b')
  })
})
