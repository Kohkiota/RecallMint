import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { GoogleGenAI } from '@google/genai'

import {
  buildResponseSchema,
  buildDiscoverResponseJsonSchema,
  type PropertySchema,
} from './schema'
import { buildPrompt, buildDiscoverPrompt } from './prompt'
import { estimateCostYen, modelId, type ModelKind } from './cost'

// リポジトリルートの .env.local を自動読み込み (dotenv は既存 process.env を
// 上書きしないので、shell で GEMINI_API_KEY を export した場合はそちらが優先)。
// quiet: true は v17 系で stdout に出る "injected env ..." バナー抑止
// (本 script の最終 stdout は JSON 出力なので混ぜたくない)。
loadEnv({
  path: resolve(dirname(new URL(import.meta.url).pathname), '../../.env.local'),
  quiet: true,
})

type Mode = 'schema' | 'discover'

type CliArgs = {
  exam: string
  mode: Mode
  model: ModelKind
  fallback: boolean
  simulateFlashFail: boolean
}

type RunResult = {
  cards: unknown[]
  meta: {
    exam: string
    mode: Mode
    model_used: string
    model_chain: ModelKind[]
    fallback_enabled: boolean
    simulated_flash_fail: boolean
    duration_ms: number
    input_tokens: number
    output_tokens: number
    estimated_cost_yen: number
    pdf_files: string[]
    property_schema_count: number
    flash_error?: string
  }
}

const HERE = dirname(new URL(import.meta.url).pathname)
const FIXTURES_DIR = resolve(HERE, 'fixtures')
const RESULTS_DIR = resolve(HERE, 'results')

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2)
  const positional = args.filter((a) => !a.startsWith('--'))
  const flags = new Set(args.filter((a) => a.startsWith('--')))

  if (positional.length === 0) {
    throw new Error('Usage: pnpm tsx scripts/ocr-poc/run.ts <exam> [--mode schema|discover] [--model flash|pro] [--fallback] [--simulate-flash-fail]')
  }

  let model: ModelKind = 'flash'
  let mode: Mode = 'schema'
  for (const f of flags) {
    if (f.startsWith('--model')) {
      const v = f.includes('=') ? f.split('=')[1] : args[args.indexOf(f) + 1]
      if (v !== 'flash' && v !== 'pro') throw new Error(`--model must be flash|pro (got: ${v})`)
      model = v
    } else if (f.startsWith('--mode')) {
      const v = f.includes('=') ? f.split('=')[1] : args[args.indexOf(f) + 1]
      if (v !== 'schema' && v !== 'discover') throw new Error(`--mode must be schema|discover (got: ${v})`)
      mode = v
    }
  }

  return {
    exam: positional[0],
    mode,
    model,
    fallback: flags.has('--fallback'),
    simulateFlashFail: flags.has('--simulate-flash-fail'),
  }
}

function loadFixture(exam: string, mode: Mode): {
  propertySchema: PropertySchema | null
  pdfPaths: string[]
} {
  const dir = join(FIXTURES_DIR, exam)
  if (!existsSync(dir)) {
    throw new Error(`fixture not found: ${dir}\nCreate scripts/ocr-poc/fixtures/${exam}/ with *.pdf and property_schema.json`)
  }

  let propertySchema: PropertySchema | null = null
  if (mode === 'schema') {
    const schemaPath = join(dir, 'property_schema.json')
    if (!existsSync(schemaPath)) throw new Error(`missing ${schemaPath}`)
    propertySchema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as PropertySchema
  }

  const pdfPaths = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .map((f) => join(dir, f))
    .sort()
  if (pdfPaths.length === 0) throw new Error(`no PDF files in ${dir}`)

  return { propertySchema, pdfPaths }
}

function pdfToInlinePart(path: string) {
  const data = readFileSync(path).toString('base64')
  return { inlineData: { data, mimeType: 'application/pdf' } }
}

async function callGemini(
  ai: GoogleGenAI,
  model: ModelKind,
  pdfPaths: string[],
  mode: Mode,
  propertySchema: PropertySchema | null,
): Promise<{ cards: unknown[]; inputTokens: number; outputTokens: number }> {
  const isDiscover = mode === 'discover'
  const prompt = isDiscover ? buildDiscoverPrompt() : buildPrompt(propertySchema!)
  const parts = [...pdfPaths.map(pdfToInlinePart), { text: prompt }]

  // schema モードは responseSchema (OpenAPI subset)、
  // discover モードは additionalProperties が必要なので responseJsonSchema を使う
  // (両者は排他、SDK 側でも片方のみ設定する想定)
  const config = isDiscover
    ? {
        responseMimeType: 'application/json',
        responseJsonSchema: buildDiscoverResponseJsonSchema(),
      }
    : {
        responseMimeType: 'application/json',
        // 動的 responseSchema 注入 (Tech Spec §7)
        responseSchema: buildResponseSchema(propertySchema!) as never,
      }

  const res = await ai.models.generateContent({
    model: modelId(model),
    contents: [{ role: 'user', parts }],
    config,
  })

  const text = res.text
  if (!text) throw new Error('empty response.text')

  let parsed: { cards?: unknown[] }
  try {
    parsed = JSON.parse(text) as { cards?: unknown[] }
  } catch (e) {
    throw new Error(`JSON parse failed: ${(e as Error).message}\n--- raw ---\n${text.slice(0, 500)}`)
  }

  const cards = parsed.cards ?? []
  if (!Array.isArray(cards)) throw new Error('response.cards is not an array')

  const usage = res.usageMetadata ?? {}
  return {
    cards,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  }
}

async function main() {
  const argv = parseArgs(process.argv)
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is required (set in .env.local or shell env)')

  const { propertySchema, pdfPaths } = loadFixture(argv.exam, argv.mode)
  const ai = new GoogleGenAI({ apiKey })

  const start = Date.now()
  const modelChain: ModelKind[] = []
  let cards: unknown[] = []
  let inputTokens = 0
  let outputTokens = 0
  let flashError: string | undefined

  const runOne = async (m: ModelKind) => {
    modelChain.push(m)
    const r = await callGemini(ai, m, pdfPaths, argv.mode, propertySchema)
    cards = r.cards
    inputTokens += r.inputTokens
    outputTokens += r.outputTokens
  }

  if (argv.fallback) {
    // Flash → 失敗時 Pro。--simulate-flash-fail で強制失敗させて fallback path を検証
    try {
      if (argv.simulateFlashFail) {
        modelChain.push('flash')
        throw new Error('simulated Flash failure (--simulate-flash-fail)')
      }
      await runOne('flash')
      if (cards.length === 0) throw new Error('Flash returned 0 cards')
    } catch (e) {
      flashError = (e as Error).message
      console.warn(`[fallback] Flash failed: ${flashError}. Retrying with Pro...`)
      cards = []
      await runOne('pro')
    }
  } else {
    await runOne(argv.model)
  }

  const durationMs = Date.now() - start

  const modelUsed = modelChain[modelChain.length - 1]
  const result: RunResult = {
    cards,
    meta: {
      exam: argv.exam,
      mode: argv.mode,
      model_used: modelUsed,
      model_chain: modelChain,
      fallback_enabled: argv.fallback,
      simulated_flash_fail: argv.simulateFlashFail,
      duration_ms: durationMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_yen: estimateCostYen(modelUsed, inputTokens, outputTokens),
      pdf_files: pdfPaths.map((p) => p.replace(`${FIXTURES_DIR}/`, '')),
      property_schema_count: propertySchema?.length ?? 0,
      ...(flashError ? { flash_error: flashError } : {}),
    },
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const modelLabel = modelChain.length > 1 ? modelChain.join('-then-') : modelChain[0]
  const outPath = join(RESULTS_DIR, `${argv.exam}_${argv.mode}_${modelLabel}_${timestamp}.json`)
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8')

  let csvPath: string | undefined
  if (argv.mode === 'discover') {
    csvPath = writeDiscoverKeysCsv(argv.exam, cards, RESULTS_DIR)
  }

  console.log(JSON.stringify({
    out: outPath.replace(`${process.cwd()}/`, ''),
    ...(csvPath ? { discover_keys_csv: csvPath.replace(`${process.cwd()}/`, '') } : {}),
    mode: argv.mode,
    cards: cards.length,
    model_chain: modelChain,
    duration_ms: durationMs,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_yen: result.meta.estimated_cost_yen,
  }, null, 2))
}

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// discover モード集計: 同 exam の今回 run で AI が返した custom_props のキー集合を
// 出現回数降順で CSV 出力する。複数 run を比較したい場合は、得られた CSV を手動で
// rename/退避して保管する想定 (上書き)。
function writeDiscoverKeysCsv(exam: string, cards: unknown[], outDir: string): string {
  const counts = new Map<string, { count: number; samples: Set<string> }>()
  for (const card of cards) {
    const props = (card as { custom_props?: Record<string, unknown> } | null)?.custom_props ?? {}
    for (const [key, value] of Object.entries(props)) {
      let entry = counts.get(key)
      if (!entry) {
        entry = { count: 0, samples: new Set() }
        counts.set(key, entry)
      }
      entry.count++
      const sampleStr = Array.isArray(value)
        ? value.map((v) => String(v)).join('|')
        : String(value)
      if (entry.samples.size < 5) entry.samples.add(sampleStr)
    }
  }

  const rows: string[][] = [['key', 'count', 'sample_values']]
  const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)
  for (const [key, { count, samples }] of sorted) {
    rows.push([csvEscape(key), String(count), csvEscape([...samples].join(' / '))])
  }

  const csvText = rows.map((r) => r.join(',')).join('\n') + '\n'
  const csvPath = join(outDir, `${exam}_discover_keys.csv`)
  writeFileSync(csvPath, csvText, 'utf-8')
  return csvPath
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})
