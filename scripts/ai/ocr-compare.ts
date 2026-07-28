#!/usr/bin/env tsx
// モデル×arm 比較スクリプト(②-0 OCR regression 基盤 Task 6)。
//
// 目的: 同一画像群を複数モデル(arm A = 本番 prompt/schema)× 呼び出し方(arm A/B、
// arm B は 1 モデルのみ)に通し、致命的差分(否定/数値/単位/記号)が埋もれない
// 比較レポートを出す。**実行・観測・整形のみ**を行い、良し悪しの判定は OT が行う。
//
// 実行(OT 合図で実 API 呼出。GEMINI_API_KEY 必須・料金発生):
//   tsx scripts/ai/ocr-compare.ts --images <dir> [--models <csv>] --arm A|B|both [--arm-model <id>]
//
// arm semantics(review 2026-07-28 修正・重要):
// - `--arm A`    = arm A のみを `--models` に対して sweep する(baseline 比較の
//                  素材を集める。A/B 比較ペアは作らない)。
// - `--arm both` = **A/B 比較モード**。`--arm-model <id>` 必須。指定モデルの
//                  arm A leg を(`--models` に含まれていなくても)この 1 run 内で
//                  必ず用意した上で arm B を実行するため、常にペアが組める。
// - `--arm B`(単独)は **reject される**。1 run 内に arm A leg が無いと比較不能
//   (別 run の arm A 結果とファイル越しに突き合わせる機構は無い)ため、有料 API を
//   叩く前に `--arm both --arm-model <id>` へ誘導する。
// - 出力ファイル名には arm mode + arm-model + run 開始 timestamp を含む
//   (`compare-armA-<ts>.md` / `compare-both-<model>-<ts>.md` 等)。 固定名だと
//   後続 run が前の run の出力を上書きするため。
//
// 設計: PURE helper 群(alignCards/alignOptions/diffCardFields/extractEvalSignals/
// buildComparisonReport)は I/O を持たない。timestamp は orchestration 層
// (runCompare)からのみ渡され、pure helper 内で Date.now を呼ばない。
//
// 本番との不変条件: `lib/ai/prompts/ocr-extract.ts` の buildDiscoverPrompt() /
// `lib/ai/schemas/ocr-response.ts` の buildDiscoverResponseJsonSchema() は改変しない
// (arm A = 本番そのもの)。arm B の探索 schema/prompt は scripts/ai/lib/
// figure-detect-schema.ts 側にのみ持つ。

import { readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { buildDiscoverPrompt } from '@/lib/ai/prompts/ocr-extract'
import {
  buildDiscoverResponseJsonSchema,
  type ExtractedCard,
  type ExtractedOption,
} from '@/lib/ai/schemas/ocr-response'
import { parseOcrResponse } from '@/lib/ai/ocr'
import { isRateLimitError } from '@/lib/retry/transient-error'
import { callGeminiRaw, DEFAULT_TIMEOUT_MS, type GeminiRawUsage } from './lib/gemini-raw'
import { buildArmBResponseSchema, buildArmBPromptSuffix } from './lib/figure-detect-schema'
import { estimateUsdPerImage } from './lib/pricing'
import { analyzeTablesBlankLine } from './lib/blank-line-below-table'
import { loadImageInline } from './lib/load-images'
// SDK 版は provenance に記録する。 `@google/genai` の package.json は "exports" map で
// './package.json' subpath を公開していないため node_modules 経由の require は
// 失敗する — repo root package.json の pinned dependency 文字列を読む(このリポジトリは
// exact pin 運用のため install 済み実体と一致する)。
import rootPackageJson from '../../package.json' with { type: 'json' }

// ============================================================================
// 型
// ============================================================================

export type Arm = 'A' | 'B'

// callGeminiRaw が throw する error の分類。 429 は run 全停止(orchestration 側)。
// 残りは分類して記録し、次の call へ続行する。
export type ErrorCategory =
  | 'rate-limit'
  | 'model-not-found'
  | 'timeout'
  | 'http-status'
  | 'parse-failure'
  | 'empty-text'
  | 'unknown'

export type CardAlignment = { key: string; a?: ExtractedCard; b?: ExtractedCard }
export type OptionAlignment = { id: string; a?: ExtractedOption; b?: ExtractedOption }
export type FieldDiff = { field: string; aText: string | null; bText: string | null; changed: boolean }
export type EvalSignals = {
  negations: string[]
  numbers: string[]
  units: string[]
  symbols: string[]
  optionCount: number
  lastOptionId: string | null
}

// 1 回の (model, arm, image) 呼び出しの provenance。 ok=false のとき cards は無く、
// errorCategory がその失敗理由を持つ(parse-failure のときのみ rawText/finishReason/
// usage は call 成功後に得られた値を保持する)。
export type OcrCompareResult = {
  modelId: string
  arm: Arm
  imageFilename: string
  imageHash: string
  timestamp: number
  timeoutMs: number
  promptSchemaHash: string
  ok: boolean
  finishReason?: string
  usage?: GeminiRawUsage
  rawText?: string
  cards?: ExtractedCard[]
  errorCategory?: ErrorCategory
  errorMessage?: string
}

export type ComparisonReportInput = {
  generatedAtMs: number
  baselineModelId: string
  imageFilenames: string[]
  results: OcrCompareResult[]
}

type Comparison = { label: string; aResult: OcrCompareResult; bResult: OcrCompareResult }

// buildComparisons の戻り値。 skippedArmBModels は「arm B 結果はあるが対応する arm A
// leg が同じ run 内に無く、ペアを組めなかった」モデル(review 2026-07-28 Critical:
// 空 pairing を無言の "(no comparison pairs)" にすると「比較して差分無し」と区別が
// つかない = 危険な沈黙。明示的に理由を出す)。
type ArmPairing = { comparisons: Comparison[]; skippedArmBModels: string[] }

// ============================================================================
// 既定値
// ============================================================================

// spec §4-(b) の 5 モデル(安い順を含む、gemini-2.5-flash が現行 baseline)。
export const DEFAULT_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
]

export const BASELINE_MODEL_ID = 'gemini-2.5-flash'

export const OUT_DIR = join(process.cwd(), 'scripts/ai/ocr-samples/out')

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf'])

// provenance 用。 @google/genai の pinned version を package.json から動的読取して
// 記録する(②-0 では 1.50.1 固定、 ②-1 で 2.x へ bump 済。 この行は値を hardcode せず
// 常に現在の pinned 値を追随する)。
const GENAI_SDK_VERSION = (rootPackageJson.dependencies as Record<string, string>)[
  '@google/genai'
]

// ============================================================================
// 小さい pure ユーティリティ
// ============================================================================

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

// alignCards/alignOptions/diffCardFields/extractEvalSignals の主キー。 sort_key が
// あれば優先(数値的意味を持つ連番が多い)、無ければ title にフォールバックする。
function cardKey(card: ExtractedCard): string {
  return card.sort_key ?? card.title
}

function textOrNull(s: string | undefined): string | null {
  return s === undefined ? null : s
}

// ============================================================================
// PURE helper 1: alignCards
// ============================================================================
// sort_key→title で a/b を突き合わせる。 未マッチのカードは片側のみで出す
// (1 枚の欠落/挿入が後続カード全部を index ズレで巻き込まないため = 「missing-card
// no-cascade」)。 順序は決定論: a の出現順 → b のみに存在するキーは b の出現順。
export function alignCards(a: ExtractedCard[], b: ExtractedCard[]): CardAlignment[] {
  const bByKey = new Map<string, ExtractedCard>()
  for (const card of b) {
    const key = cardKey(card)
    // 重複キーは最初の出現のみを対応候補にする(OCR 抽出が同一 sort_key/title を
    // 複数返すことは想定外のケースであり、alignment 自体に「2 個目をどこへ置くか」の
    // 原理的な決着法が無いため単純化する)。
    if (!bByKey.has(key)) bByKey.set(key, card)
  }

  const matchedKeys = new Set<string>()
  const aligned: CardAlignment[] = []
  for (const card of a) {
    const key = cardKey(card)
    const match = bByKey.get(key)
    aligned.push(match ? { key, a: card, b: match } : { key, a: card })
    if (match) matchedKeys.add(key)
  }

  const emittedBOnly = new Set<string>()
  for (const card of b) {
    const key = cardKey(card)
    if (matchedKeys.has(key) || emittedBOnly.has(key)) continue
    aligned.push({ key, b: card })
    emittedBOnly.add(key)
  }

  return aligned
}

// ============================================================================
// PURE helper 2: alignOptions
// ============================================================================
// 選択肢は id で突き合わせる(index 比較は禁止 — 1 選択肢の挿入/削除で残り全部が
// ズレるため)。 alignCards と同型のロジック。
export function alignOptions(a: ExtractedOption[], b: ExtractedOption[]): OptionAlignment[] {
  const bById = new Map<string, ExtractedOption>()
  for (const opt of b) {
    if (!bById.has(opt.id)) bById.set(opt.id, opt)
  }

  const matchedIds = new Set<string>()
  const aligned: OptionAlignment[] = []
  for (const opt of a) {
    const match = bById.get(opt.id)
    aligned.push(match ? { id: opt.id, a: opt, b: match } : { id: opt.id, a: opt })
    if (match) matchedIds.add(opt.id)
  }

  const emittedBOnly = new Set<string>()
  for (const opt of b) {
    if (matchedIds.has(opt.id) || emittedBOnly.has(opt.id)) continue
    aligned.push({ id: opt.id, b: opt })
    emittedBOnly.add(opt.id)
  }

  return aligned
}

// ============================================================================
// PURE helper 3: diffCardFields
// ============================================================================
// field-level 原文 diff = 正本(致命的差分の判定はこの生テキスト比較を必ず経由する。
// 否定/数値/単位/記号抽出は強調のみで、ここでの changed 判定には使わない)。
// a/b いずれかの card が無い(alignCards で片側欠落)場合、その側の全 field は null。
export function diffCardFields(a?: ExtractedCard, b?: ExtractedCard): FieldDiff[] {
  const diffs: FieldDiff[] = []
  const push = (field: string, aText: string | null, bText: string | null): void => {
    diffs.push({ field, aText, bText, changed: aText !== bText })
  }

  push('question_text', a ? a.question_text : null, b ? b.question_text : null)
  push('explanation_text', textOrNull(a?.explanation_text), textOrNull(b?.explanation_text))

  const optionPairs = alignOptions(a?.options ?? [], b?.options ?? [])
  for (const pair of optionPairs) {
    push(`options[${pair.id}].text`, pair.a ? pair.a.text : null, pair.b ? pair.b.text : null)
    push(
      `options[${pair.id}].explanation`,
      textOrNull(pair.a?.explanation),
      textOrNull(pair.b?.explanation),
    )
  }

  return diffs
}

// ============================================================================
// PURE helper 4: extractEvalSignals
// ============================================================================
// SECONDARY highlight のみ(正本は diffCardFields の生テキスト比較)。 日本語否定 /
// 数値(全角・桁区切り・小数含む)/ 単位 / 記号 を小さい list で検出する。
// 意図的な簡略化: cue は独立に substring 判定するため、「正しくない」のような
// 長い cue が「ない」を内包していれば両方ヒットする(過剰検出はあっても見落としより
// 安全側 = STRUCTURE_PRESERVATION_RULES と同じ判断方針)。

const NEGATION_CUES = ['ではない', '正しくない', 'ない', 'なし'] as const
const UNIT_CUES = ['mg', 'mL', 'ml', 'kg', 'cm', 'mm', '%', '℃', 'g', 'L'] as const
const SYMBOL_CUES = ['±', '≧', '≦', 'µ', 'μ', '≠'] as const
// 半角/全角数字 + 桁区切りカンマ + 小数点(半角/全角)の連続を 1 トークンとして拾う。
const NUMBER_RE = /[0-9０-９][0-9０-９,，.．]*/g

function collectCues(text: string, cues: readonly string[]): string[] {
  const found: string[] = []
  for (const cue of cues) {
    if (text.includes(cue)) found.push(cue)
  }
  return found
}

function collectNumbers(text: string): string[] {
  const matches = text.match(NUMBER_RE) ?? []
  return Array.from(new Set(matches))
}

function cardSearchText(card: ExtractedCard): string {
  const parts = [card.question_text, card.explanation_text ?? '']
  for (const opt of card.options) {
    parts.push(opt.text, opt.explanation ?? '')
  }
  return parts.join('\n')
}

function extractTextSignals(text: string): Omit<EvalSignals, 'optionCount' | 'lastOptionId'> {
  return {
    negations: collectCues(text, NEGATION_CUES),
    numbers: collectNumbers(text),
    units: collectCues(text, UNIT_CUES),
    symbols: collectCues(text, SYMBOL_CUES),
  }
}

export function extractEvalSignals(card: ExtractedCard): EvalSignals {
  const signals = extractTextSignals(cardSearchText(card))
  const lastOption = card.options.length > 0 ? card.options[card.options.length - 1] : undefined
  return {
    ...signals,
    optionCount: card.options.length,
    lastOptionId: lastOption ? lastOption.id : null,
  }
}

// buildComparisonReport が「critical signal と交差する field diff」を判定するための
// field-level 版(extractEvalSignals はカード全体粒度のため、diff 1 件ごとの
// aText/bText を直接比較するにはこちらが要る)。
function sameStringSet(x: string[], y: string[]): boolean {
  if (x.length !== y.length) return false
  const set = new Set(x)
  return y.every((v) => set.has(v))
}

function fieldHasCriticalChange(aText: string | null, bText: string | null): boolean {
  const aSig = extractTextSignals(aText ?? '')
  const bSig = extractTextSignals(bText ?? '')
  return (
    !sameStringSet(aSig.negations, bSig.negations) ||
    !sameStringSet(aSig.numbers, bSig.numbers) ||
    !sameStringSet(aSig.units, bSig.units) ||
    !sameStringSet(aSig.symbols, bSig.symbols)
  )
}

// ============================================================================
// エラー分類(pure・呼び出し側の try/catch から使う)
// ============================================================================
// 429 は isRateLimitError(既存 lib/retry/transient-error.ts、CLAUDE.md AI ルール5)を
// 再利用。 それ以外は HTTP-status / model-not-found / timeout / empty-text /
// unknown に分類する(parse-failure は呼び出し側で JSON parse 段階の catch から
// 直接付与するため、ここには含めない)。
export function categorizeError(err: unknown): ErrorCategory {
  if (isRateLimitError(err)) return 'rate-limit'
  const msg = err instanceof Error ? err.message : String(err)
  if (/empty response\.text/i.test(msg)) return 'empty-text'
  if (/timeout/i.test(msg)) return 'timeout'
  if (/not[_ ]?found/i.test(msg)) return 'model-not-found'
  if (/\b[45]\d{2}\b/.test(msg)) return 'http-status'
  return 'unknown'
}

// ============================================================================
// PURE helper 5: buildComparisonReport
// ============================================================================

function fmtNum(n: number | undefined): string {
  return n === undefined ? 'N/A' : String(n)
}

function fmtUsd(n: number | null): string {
  return n === null ? 'N/A' : `$${n.toFixed(6)}`
}

function fmtUsdDelta(n: number | null): string {
  if (n === null) return 'N/A'
  const sign = n >= 0 ? '+' : ''
  return `${sign}$${n.toFixed(6)}`
}

// baseline(arm A・指定 modelId)vs 他モデル(arm A)、および --arm-model の
// arm A vs arm B の比較ペアを組み立てる。 画像単位(imageResults は 1 画像分のみ)。
// arm B 結果があるのに同じ modelId の arm A leg が imageResults に無ければ、その
// modelId を skippedArmBModels に積む(黙って捨てない — render 側が明示行を出す)。
function buildComparisons(imageResults: OcrCompareResult[], baselineModelId: string): ArmPairing {
  const comparisons: Comparison[] = []

  const baseline = imageResults.find(
    (r) => r.arm === 'A' && r.modelId === baselineModelId && r.ok,
  )
  if (baseline) {
    const otherArmA = imageResults.filter((r) => r.arm === 'A' && r.modelId !== baselineModelId)
    for (const r of otherArmA) {
      comparisons.push({
        label: `${r.modelId} (arm A) vs ${baselineModelId} (baseline, arm A)`,
        aResult: baseline,
        bResult: r,
      })
    }
  }

  const skippedArmBModels: string[] = []
  const armBModelIds = new Set(imageResults.filter((r) => r.arm === 'B').map((r) => r.modelId))
  for (const modelId of armBModelIds) {
    const armA = imageResults.find((r) => r.arm === 'A' && r.modelId === modelId)
    const armB = imageResults.find((r) => r.arm === 'B' && r.modelId === modelId)
    if (armA && armB) {
      comparisons.push({ label: `${modelId}: arm A vs arm B`, aResult: armA, bResult: armB })
    } else if (armB) {
      skippedArmBModels.push(modelId)
    }
  }

  return { comparisons, skippedArmBModels }
}

function renderCriticalDiffsSection(pairing: ArmPairing): string[] {
  const lines = ['### Critical field diffs (negation / number / unit / symbol)']
  for (const modelId of pairing.skippedArmBModels) {
    lines.push(`(no arm-A leg for ${modelId} — A/B comparison skipped)`)
  }
  if (pairing.comparisons.length === 0) {
    if (pairing.skippedArmBModels.length === 0) {
      lines.push('(no comparison pairs for this image)')
    }
    return lines
  }
  for (const cmp of pairing.comparisons) {
    lines.push(`#### ${cmp.label}`)
    if (!cmp.aResult.cards || !cmp.bResult.cards) {
      lines.push('(one or both sides have no parsed cards — see error sections below)')
      continue
    }
    const aligned = alignCards(cmp.aResult.cards, cmp.bResult.cards)
    let any = false
    for (const pair of aligned) {
      const diffs = diffCardFields(pair.a, pair.b)
      const critical = diffs.filter((d) => d.changed && fieldHasCriticalChange(d.aText, d.bText))
      if (critical.length === 0) continue
      any = true
      lines.push(`- Card \`${pair.key}\`:`)
      for (const d of critical) {
        lines.push(`  - \`${d.field}\`: "${d.aText ?? '(missing)'}" -> "${d.bText ?? '(missing)'}"`)
      }
    }
    if (!any) lines.push('(no critical diffs)')
  }
  return lines
}

// lastOptionId が違うだけで「MISSING TAIL OPTION」と呼ぶと、末尾が単に並べ替え/
// 改称されただけ(個数は同じ)のケースまで欠落扱いにしてしまう(canonical Minor)。
// 個数が実際に減っている(b が a より少ない)ときのみ欠落と呼び、それ以外は
// 「tail option id changed」(並べ替え/改称)とラベルする。二次的な強調に過ぎず、
// 正本は diffCardFields の生 field diff。
function tailOptionNote(
  aSig: EvalSignals | null,
  bSig: EvalSignals | null,
): string {
  if (!aSig || !bSig) return ''
  if (aSig.lastOptionId === null || bSig.lastOptionId === aSig.lastOptionId) return ''
  return bSig.optionCount < aSig.optionCount
    ? ' — MISSING TAIL OPTION'
    : ' — tail option id changed (reordered/relabeled)'
}

function renderOptionCountSection(pairing: ArmPairing): string[] {
  const lines = ['### Option counts / missing tail option']
  for (const modelId of pairing.skippedArmBModels) {
    lines.push(`(no arm-A leg for ${modelId} — A/B comparison skipped)`)
  }
  if (pairing.comparisons.length === 0) {
    if (pairing.skippedArmBModels.length === 0) {
      lines.push('(no comparison pairs for this image)')
    }
    return lines
  }
  for (const cmp of pairing.comparisons) {
    lines.push(`#### ${cmp.label}`)
    if (!cmp.aResult.cards || !cmp.bResult.cards) {
      lines.push('(one or both sides have no parsed cards)')
      continue
    }
    const aligned = alignCards(cmp.aResult.cards, cmp.bResult.cards)
    for (const pair of aligned) {
      const aSig = pair.a ? extractEvalSignals(pair.a) : null
      const bSig = pair.b ? extractEvalSignals(pair.b) : null
      lines.push(
        `- Card \`${pair.key}\`: a.optionCount=${aSig ? aSig.optionCount : 'N/A'} (lastId=${aSig?.lastOptionId ?? 'N/A'}), ` +
          `b.optionCount=${bSig ? bSig.optionCount : 'N/A'} (lastId=${bSig?.lastOptionId ?? 'N/A'})` +
          tailOptionNote(aSig, bSig),
      )
    }
  }
  return lines
}

function renderBlankLineSection(imageResults: OcrCompareResult[]): string[] {
  const lines = ['### Table blank-line check']
  let any = false
  for (const r of imageResults) {
    if (!r.cards) continue
    for (const card of r.cards) {
      const fields: Array<[string, string | undefined]> = [
        ['question_text', card.question_text],
        ['explanation_text', card.explanation_text],
        ...card.options.flatMap((o): Array<[string, string | undefined]> => [
          [`options[${o.id}].text`, o.text],
          [`options[${o.id}].explanation`, o.explanation],
        ]),
      ]
      for (const [fieldPath, text] of fields) {
        if (!text) continue
        const tables = analyzeTablesBlankLine(text)
        for (const t of tables) {
          any = true
          lines.push(
            `- ${r.modelId}/arm ${r.arm} card \`${cardKey(card)}\` field \`${fieldPath}\` table#${t.tableIndex}: hasBlankLineBelow=${t.hasBlankLineBelow}`,
          )
        }
      }
    }
  }
  if (!any) lines.push('(no tables detected)')
  return lines
}

function renderCostSection(imageResults: OcrCompareResult[], baselineModelId: string): string[] {
  const lines = [
    '### Cost (USD/image)',
    '',
    '| model | arm | usd/image | delta vs baseline |',
    '|---|---|---|---|',
  ]
  const baseline = imageResults.find((r) => r.arm === 'A' && r.modelId === baselineModelId)
  const baselineUsd = baseline?.usage ? estimateUsdPerImage(baseline.usage, baseline.modelId) : null
  for (const r of imageResults) {
    const usd = r.usage ? estimateUsdPerImage(r.usage, r.modelId) : null
    const delta = usd !== null && baselineUsd !== null ? usd - baselineUsd : null
    lines.push(`| ${r.modelId} | ${r.arm} | ${fmtUsd(usd)} | ${fmtUsdDelta(delta)} |`)
  }
  return lines
}

function renderUsageSection(imageResults: OcrCompareResult[]): string[] {
  const lines = [
    '### finishReason + token usage',
    '',
    '| model | arm | finishReason | prompt | candidates | thoughts | total |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const r of imageResults) {
    lines.push(
      `| ${r.modelId} | ${r.arm} | ${r.finishReason ?? 'N/A'} | ${fmtNum(r.usage?.promptTokenCount)} | ` +
        `${fmtNum(r.usage?.candidatesTokenCount)} | ${fmtNum(r.usage?.thoughtsTokenCount)} | ${fmtNum(r.usage?.totalTokenCount)} |`,
    )
  }
  return lines
}

// Markdown レポート本体。 致命的差分が埋もれないよう、画像ごとに
// 「critical diffs → option count/missing tail → table blank-line → cost → usage」
// の順で並べる(brief 必須順序)。timestamp は引数で受け取る(内部で Date.now しない)。
export function buildComparisonReport(input: ComparisonReportInput): string {
  const lines: string[] = []
  lines.push('# OCR Model Comparison Report')
  lines.push('')
  lines.push(`Generated: ${new Date(input.generatedAtMs).toISOString()}`)
  lines.push(`Baseline model: ${input.baselineModelId}`)

  for (const filename of input.imageFilenames) {
    const imageResults = input.results.filter((r) => r.imageFilename === filename)
    lines.push('')
    lines.push(`## Image: ${filename}`)
    lines.push('')

    const pairing = buildComparisons(imageResults, input.baselineModelId)

    lines.push(...renderCriticalDiffsSection(pairing))
    lines.push('')
    lines.push(...renderOptionCountSection(pairing))
    lines.push('')
    lines.push(...renderBlankLineSection(imageResults))
    lines.push('')
    lines.push(...renderCostSection(imageResults, input.baselineModelId))
    lines.push('')
    lines.push(...renderUsageSection(imageResults))
  }

  return lines.join('\n') + '\n'
}

// ============================================================================
// Orchestration(I/O・実 API 呼び出し・CLI)
// ============================================================================

// dir 列挙は決定論 sort(brief 要求)。 loadImageInline と同じ拡張子 allowlist。
function listImageFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort()
}

function promptSchemaIdentity(prompt: string, schema: Record<string, unknown>): string {
  return sha256Hex(prompt + ' ' + JSON.stringify(schema))
}

// CLI 引数(モデル ID 等)をファイル名断片に落とすため、path 破壊/衝突を招く文字を
// 潰す(review 2026-07-28: 固定ファイル名だと後続 run が前の run の出力を上書きし
// 破壊するため、run ごとに区別できる名前にする)。
function sanitizeForFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

// run を一意に特定できる出力 basename(拡張子なし)。 arm mode + arm-model(あれば)+
// timestamp を含めるため、同じ dir に複数 run を出力しても互いを上書きしない。
function outputBaseName(opts: RunCompareOptions, timestampMs: number): string {
  const armLabel =
    opts.arm === 'both' && opts.armModel
      ? `both-${sanitizeForFilename(opts.armModel)}`
      : `arm${opts.arm}`
  return `compare-${armLabel}-${timestampMs}`
}

export type RunCompareOptions = {
  imagesDir: string
  models: string[]
  arm: 'A' | 'B' | 'both'
  armModel?: string
  outDir?: string
  timeoutMs?: number
  // test 用の時刻差し替え口(default = Date.now)。 pure helper には渡さず、
  // orchestration 層でのみ呼ぶ(brief 制約: pure helper 内で Date.now しない)。
  now?: () => number
}

export type RunCompareOutcome = {
  results: OcrCompareResult[]
  halted: boolean
  reportPath: string
  jsonPath: string
}

type PlannedCall = { modelId: string; arm: Arm }

// arm semantics(review 2026-07-28 Critical/Important 修正後):
// - `--arm A` = arm A のみを `--models` 全体に対して sweep する(比較ペアは作らない)。
// - `--arm both` = **A/B 比較モード**。`--arm-model` 必須。 buildComparisons が
//   必ずペアを組めるよう、指定モデルの arm A leg を(`--models` に含まれていなくても)
//   この 1 run の中で必ず用意した上で arm B を実行する。
// - `--arm B`(単独)は **reject する**(このモードだけ選ぶと理由)。単独 run には
//   ペアを組める arm A leg が存在せず、結果は必ず「比較不能」になる ——
//   別 run で撮った arm A 結果とファイル越しに突き合わせる仕組みは無いため、
//   実行しても静かに空の比較しか出せない。 有料 API を叩く前に落として
//   `--arm both --arm-model <id>` へ誘導する(黙って空 pairing を作らない)。
function planCalls(opts: RunCompareOptions): PlannedCall[] {
  if (opts.arm === 'B') {
    throw new Error(
      '--arm B は単独では A/B 比較を生成できません(この run に arm A leg が存在しないため)。 ' +
        'A/B 比較には --arm both --arm-model <id> を使うこと。',
    )
  }

  if (opts.arm === 'A') {
    return opts.models.map((modelId) => ({ modelId, arm: 'A' as const }))
  }

  // opts.arm === 'both'
  if (!opts.armModel) {
    throw new Error('--arm-model is required when --arm is "both"(A/B 比較は 1 モデルのみ)')
  }
  const calls: PlannedCall[] = opts.models.map((modelId) => ({ modelId, arm: 'A' as const }))
  if (!opts.models.includes(opts.armModel)) {
    calls.push({ modelId: opts.armModel, arm: 'A' })
  }
  calls.push({ modelId: opts.armModel, arm: 'B' })
  return calls
}

// 比較 run 本体。 画像ごと × (model,arm) ごとに **逐次** 1 回ずつ callGeminiRaw する
// (単一画像・単一 (model,arm) の粒度が box_2d/比較に必須 = brief 制約)。
// 429 は結果を記録した上で run 全体を即停止する(以降の call を一切開始しない)。
// それ以外の失敗はカテゴライズして次の call へ続行する。
export async function runCompare(opts: RunCompareOptions): Promise<RunCompareOutcome> {
  const outDir = opts.outDir ?? OUT_DIR
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // run 開始時刻を出力ファイル名に使う(run が 429 で早期停止しても常に確定した
  // 値がある。 report 内 "Generated:" は従来どおり run 完了時の now() を使う)。
  const runStartedAtMs = now()

  const images = listImageFiles(opts.imagesDir)
  const calls = planCalls(opts)

  const armAPrompt = buildDiscoverPrompt()
  const armASchema = buildDiscoverResponseJsonSchema()
  const armBPrompt = `${armAPrompt}\n\n${buildArmBPromptSuffix()}`
  const armBSchema = buildArmBResponseSchema()
  const armAHash = promptSchemaIdentity(armAPrompt, armASchema)
  const armBHash = promptSchemaIdentity(armBPrompt, armBSchema)

  const results: OcrCompareResult[] = []
  let halted = false

  imageLoop: for (const filename of images) {
    const file = loadImageInline(join(opts.imagesDir, filename))
    const imageHash = sha256Hex(file.data)

    for (const call of calls) {
      const prompt = call.arm === 'A' ? armAPrompt : armBPrompt
      const schema = call.arm === 'A' ? armASchema : armBSchema
      const promptSchemaHash = call.arm === 'A' ? armAHash : armBHash
      const timestamp = now()

      try {
        const raw = await callGeminiRaw({
          modelId: call.modelId,
          files: [file],
          prompt,
          responseJsonSchema: schema,
          timeoutMs: opts.timeoutMs,
        })

        try {
          const cards = parseOcrResponse(raw.text)
          results.push({
            modelId: call.modelId,
            arm: call.arm,
            imageFilename: filename,
            imageHash,
            timestamp,
            timeoutMs,
            promptSchemaHash,
            ok: true,
            finishReason: raw.finishReason,
            usage: raw.usage,
            rawText: raw.text,
            cards,
          })
        } catch (parseErr) {
          results.push({
            modelId: call.modelId,
            arm: call.arm,
            imageFilename: filename,
            imageHash,
            timestamp,
            timeoutMs,
            promptSchemaHash,
            ok: false,
            finishReason: raw.finishReason,
            usage: raw.usage,
            rawText: raw.text,
            errorCategory: 'parse-failure',
            errorMessage: parseErr instanceof Error ? parseErr.message : String(parseErr),
          })
        }
      } catch (callErr) {
        const category = categorizeError(callErr)
        results.push({
          modelId: call.modelId,
          arm: call.arm,
          imageFilename: filename,
          imageHash,
          timestamp,
          timeoutMs,
          promptSchemaHash,
          ok: false,
          errorCategory: category,
          errorMessage: callErr instanceof Error ? callErr.message : String(callErr),
        })
        if (category === 'rate-limit') {
          // ルール 5(CLAUDE.md AI 絶対): 429 は保存後 run 全停止・以降の call を
          // 一切開始しない。
          halted = true
          break imageLoop
        }
        // 429 以外は分類して記録済みなので次の call へ続行する。
      }
    }
  }

  const reportInput: ComparisonReportInput = {
    generatedAtMs: now(),
    baselineModelId: BASELINE_MODEL_ID,
    imageFilenames: images,
    results,
  }
  const report = buildComparisonReport(reportInput)

  mkdirSync(outDir, { recursive: true })
  // 固定ファイル名だと後続 run が前の run の出力を上書きする(review 2026-07-28
  // Critical の一部)。 arm mode + arm-model + run 開始 timestamp を basename に
  // 含め、同じ outDir へ複数 run を書いても互いを破壊しない。
  const baseName = outputBaseName(opts, runStartedAtMs)
  const reportPath = join(outDir, `${baseName}.md`)
  const jsonPath = join(outDir, `${baseName}.json`)
  writeFileSync(reportPath, report, 'utf8')
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAtMs: reportInput.generatedAtMs,
        baselineModelId: BASELINE_MODEL_ID,
        sdkVersion: GENAI_SDK_VERSION,
        halted,
        results,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )

  return { results, halted, reportPath, jsonPath }
}

// ============================================================================
// CLI
// ============================================================================

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx === -1) return undefined
  return argv[idx + 1]
}

export function parseCliArgs(
  argv: string[],
): Pick<RunCompareOptions, 'imagesDir' | 'models' | 'arm' | 'armModel'> {
  const imagesDir = argValue(argv, '--images')
  if (!imagesDir) throw new Error('--images <dir> is required')

  const modelsCsv = argValue(argv, '--models')
  const models = modelsCsv
    ? modelsCsv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [...DEFAULT_MODELS]

  const armRaw = argValue(argv, '--arm') ?? 'A'
  if (armRaw !== 'A' && armRaw !== 'B' && armRaw !== 'both') {
    throw new Error(`--arm must be one of A|B|both (got "${armRaw}")`)
  }

  const armModel = argValue(argv, '--arm-model')

  return { imagesDir, models, arm: armRaw, armModel }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const parsed = parseCliArgs(argv)
  const outcome = await runCompare(parsed)
  console.log(`wrote ${outcome.reportPath}`)
  console.log(`wrote ${outcome.jsonPath}`)
  if (outcome.halted) {
    console.error(
      '[ocr-compare] halted after a 429 (rate limit) response — partial results were saved',
    )
    // review 2026-07-28 Minor: 429 halt でも exit 0 だと「全 call が正常完了した
    // clean run」と区別が付かない。 process.exitCode で明示的に non-zero を返す
    // (書き込み済みの console.log/report を potentially 打ち切る process.exit() では
    // なく exitCode 設定に留め、event loop が自然に drain してから終了させる)。
    process.exitCode = 1
  }
}

// process.argv[1] が本 file のとき = CLI 起動。 import(test 含む)時は走らない
// (ocr-capture-fixture.ts 踏襲の guard)。
if (process.argv[1]?.endsWith('ocr-compare.ts')) {
  main().catch((err) => {
    console.error('[ocr-compare] fatal:', err)
    process.exit(1)
  })
}
