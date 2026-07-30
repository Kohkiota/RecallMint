#!/usr/bin/env tsx
// TEMP throwaway (②-4 fact-finding round2) — 統合出力(本番 discover text 抽出 + 探索 figure_regions)の
// 相互作用と、検出粒度の run 間再現性。本番コード/prompt/schema は不触(read-only import のみ)。
// 使い捨て、run 後に削除する。実 API は OT 合図。429 は即停止・retry 禁止。出力は out/(gitignore)。

import { config } from 'dotenv'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRateLimitError } from '@/lib/retry/transient-error'
import { callGeminiRaw } from './lib/gemini-raw'
import { loadImageInline } from './lib/load-images'
import { buildDiscoverPrompt } from '@/lib/ai/prompts/ocr-extract'
import { buildDiscoverResponseJsonSchema } from '@/lib/ai/schemas/ocr-response'
import { buildArmBPromptSuffix } from './lib/figure-detect-schema'

config({ path: '.env.local' })

const MODEL_ID = 'gemini-3.1-flash-lite'
const SAMPLES = join(process.cwd(), 'scripts/ai/ocr-samples')
const OUT = join(SAMPLES, 'out')
const PDF = join(SAMPLES, 'mock-exam-set.pdf')

class HaltError extends Error {}

async function callOrHalt(
  label: string,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<{ text: string; usage: unknown; finishReason: string | undefined } | null> {
  try {
    const raw = await callGeminiRaw({
      modelId: MODEL_ID,
      files: [loadImageInline(PDF)],
      prompt,
      responseJsonSchema: schema,
    })
    console.log(`[${label}] usage=${JSON.stringify(raw.usage)} finishReason=${raw.finishReason}`)
    if (raw.finishReason && raw.finishReason !== 'STOP') {
      console.warn(`[${label}] ⚠ finishReason=${raw.finishReason}(truncation の可能性)`)
    }
    return raw
  } catch (err) {
    if (isRateLimitError(err)) {
      console.error(`[${label}] HALT: 429 rate limit — 即停止`)
      throw new HaltError('429')
    }
    console.error(`[${label}] error:`, err instanceof Error ? err.message : String(err))
    return null
  }
}

// ---- 統合 schema / prompt(throwaway: 本番 discover に figure_regions を注入)-------
function buildIntegratedSchema(): Record<string, unknown> {
  // buildDiscoverResponseJsonSchema() は毎回新規 object を返す stateless factory ゆえ mutate 安全。
  const schema = buildDiscoverResponseJsonSchema() as {
    properties: { cards: { items: { properties: Record<string, unknown> } } }
  }
  schema.properties.cards.items.properties.figure_regions = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        page: { type: 'number' },
        box_2d: { type: 'array', items: { type: 'number' } },
        target: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['page', 'box_2d', 'target'],
      additionalProperties: false,
    },
  }
  // card の required には figure_regions を足さない(optional・図なし card を壊さない)。
  return schema as unknown as Record<string, unknown>
}

const INTEGRATED_PROMPT = [
  buildDiscoverPrompt(),
  buildArmBPromptSuffix(),
  '【figure_regions への page 追加】各 figure_regions 要素に、その図版が存在するページ番号 page(1 始まり)を必ず含めること。',
].join('\n\n')

// ---- 図版のみ schema / prompt(exp6 = 前回 exp1 と同一条件で verbatim 複製)-------
const FIGURE_ONLY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    regions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page: { type: 'number' },
          box_2d: { type: 'array', items: { type: 'number' } },
          target: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['page', 'box_2d', 'target'],
        additionalProperties: false,
      },
    },
  },
  required: ['regions'],
  additionalProperties: false,
}
const FIGURE_ONLY_PROMPT = [
  'この PDF の全ページから、図・写真・グラフ等の図版領域のみを検出し regions[] として返すこと。',
  '文字のみの領域は対象外、座標を返さないこと。',
  '',
  '- page: その図版が存在するページ番号(1 始まり)',
  '- box_2d: [y_min, x_min, y_max, x_max](そのページを 0-1000 に正規化した座標、y が先)',
  '- target: 図が属する箇所。 "question" / "option_{id}" / "explanation" のいずれか',
  '- label: 図の簡潔な説明 (optional)',
  '- 図が無ければ regions は空配列で返す',
].join('\n')

// ---- helpers -----------------------------------------------------------------
type Fig = { page?: number; box_2d?: unknown; target?: string; label?: string }
type Card = {
  title?: string
  sort_key?: string
  question_text?: string
  options?: Array<{ id?: string; text?: string; is_correct?: boolean }>
  correct_answer_ids?: string[]
  explanation_text?: string
  images?: unknown[]
  figure_regions?: Fig[]
}

function coerceBox(box: unknown): [number, number, number, number] | null {
  if (!Array.isArray(box) || box.length !== 4) return null
  if (box.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null
  return box as [number, number, number, number]
}
function hasMdTable(s: string | undefined): boolean {
  if (!s) return false
  // 2 行以上に `|` を含む行があれば MD 表とみなす(区切り行 |---| or 複数 | 行)。
  const pipeLines = s.split('\n').filter((l) => (l.match(/\|/g) ?? []).length >= 2)
  return pipeLines.length >= 2
}
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const written: string[] = []
  const w = (name: string, content: string) => {
    const p = join(OUT, name)
    writeFileSync(p, content, 'utf8')
    written.push(p)
  }
  const summary: string[] = ['# ②-4 round2 — 統合出力 + 粒度再現性', '', `model: ${MODEL_ID}`, '']
  // selector: 引数 'exp5' / 'exp6' でどちらか一方のみ実行(503 リトライ等)。無指定は両方。
  const ONLY = process.argv.slice(2).find((a) => a === 'exp5' || a === 'exp6')

  try {
    // ===== 実験5: 統合出力(text + figure_regions 同時)========================
    const raw5 = (!ONLY || ONLY === 'exp5') ? await (async () => {
    console.log('\n===== 実験5: 統合 schema(discover text + figure_regions)=====')
    return callOrHalt('exp5-integrated', INTEGRATED_PROMPT, buildIntegratedSchema())
    })() : null
    if (raw5) {
      w('exp5-integrated.raw.json', raw5.text)
      const parsed = safeParse(raw5.text) as { cards?: Card[] } | null
      const cards: Card[] = Array.isArray(parsed?.cards) ? parsed!.cards! : []
      w('exp5-cards.json', JSON.stringify(cards, null, 2))

      const allFigs: Fig[] = []
      const recon: string[] = ['# 実験5 突合表(問ごと: text 側 vs figure_regions)', '']
      console.log(`\n--- 実験5: cards=${cards.length} ---`)
      cards.forEach((c, i) => {
        const figs = Array.isArray(c.figure_regions) ? c.figure_regions : []
        allFigs.push(...figs)
        const optLines = (c.options ?? [])
          .map((o) => `      - [${o.id}]${o.is_correct ? '✓' : ' '} ${o.text ?? ''}`)
          .join('\n')
        const figLines = figs
          .map((f) => `      - p${f.page} ${f.target} box=${JSON.stringify(f.box_2d)} "${f.label ?? ''}"`)
          .join('\n')
        const flags = [
          `opt=${(c.options ?? []).length}`,
          `mdTable=${hasMdTable(c.question_text)}`,
          `fig=${figs.length}`,
          `figTargets=[${figs.map((f) => f.target).join(',')}]`,
          `images=${(c.images ?? []).length}`,
          `correct=[${(c.correct_answer_ids ?? []).join(',')}]`,
        ].join(' ')

        // stdout(全文を残す — 欠落/重複判定は本文突合が要るため truncate しない)
        console.log(`\n[card ${i}] title="${c.title ?? ''}" sort_key="${c.sort_key ?? ''}" ${flags}`)
        console.log(`  question_text: ${JSON.stringify(c.question_text ?? '')}`)
        if (c.explanation_text) console.log(`  explanation_text: ${JSON.stringify(c.explanation_text)}`)
        if ((c.options ?? []).length) console.log(`  options:\n${optLines}`)
        if (figs.length) console.log(`  figure_regions:\n${figLines}`)

        recon.push(`## card ${i} — ${c.title ?? ''} (sort_key ${c.sort_key ?? '-'})`)
        recon.push(`- flags: ${flags}`)
        recon.push(`- question_text:\n\n\`\`\`\n${c.question_text ?? ''}\n\`\`\`\n`)
        if (c.explanation_text) recon.push(`- explanation_text:\n\n\`\`\`\n${c.explanation_text}\n\`\`\`\n`)
        if ((c.options ?? []).length) recon.push(`- options:\n${optLines}\n`)
        if (figs.length) recon.push(`- figure_regions:\n${figLines}\n`)
        recon.push('')
      })
      w('exp5-reconcile.md', recon.join('\n'))

      summary.push('## 実験5: 統合出力')
      summary.push(`- cards 件数: ${cards.length}`)
      summary.push(`- figure_regions 総数(全 card 合算): ${allFigs.length}`)
      summary.push(`- figure targets: [${allFigs.map((f) => f.target).join(', ')}]`)
      summary.push(`- figure pages: [${allFigs.map((f) => f.page).join(', ')}]`)
      summary.push('- 前回 figure-only probe(exp1)= 10 region と比較(検出数/座標の差は突合表参照)')
      summary.push('')
      console.log(`\n--- 実験5 figure 合算=${allFigs.length}（前回 figure-only=10）---`)
    }

    // ===== 実験6: 粒度再現性(figure-only を同一条件で 2 回追加)===============
    if (!ONLY || ONLY === 'exp6') {
    console.log('\n===== 実験6: 同一条件 re-run(粒度/枠位置の run 間揺れ)=====')
    summary.push('## 実験6: 図版のみ同一条件 re-run(前回 exp1=run1)')
    // run1 = 前回保存済み exp1
    let run1: Fig[] = []
    try {
      run1 = JSON.parse(readFileSync(join(OUT, 'exp1-pdf-regions.parsed.json'), 'utf8'))
    } catch {
      console.warn('  run1 baseline (exp1-pdf-regions.parsed.json) 読めず — run2/3 のみで比較')
    }
    const runs: Array<{ label: string; regions: Fig[] }> = [{ label: 'run1(前回exp1)', regions: run1 }]
    for (const n of [2, 3]) {
      const raw = await callOrHalt(`exp6-run${n}`, FIGURE_ONLY_PROMPT, FIGURE_ONLY_SCHEMA)
      if (!raw) continue
      const parsed = safeParse(raw.text) as { regions?: Fig[] } | null
      const regions = Array.isArray(parsed?.regions) ? parsed!.regions! : []
      w(`exp6-run${n}.json`, JSON.stringify(regions, null, 2))
      runs.push({ label: `run${n}`, regions })
    }

    // 比較: page5(問10 器具図 + グラフ)と page2(円グラフ y_max)を run 横断で並べる。
    for (const r of runs) {
      const p5 = r.regions.filter((f) => f.page === 5)
      const p2 = r.regions.filter((f) => f.page === 2)
      // 問10 器具図 = page5 の中で x 幅が広い/option_ target or label に「器具/設置/方向」。
      const devices = p5.filter(
        (f) => (f.target ?? '').startsWith('option') || /器具|設置|方向|イプシロン/.test(f.label ?? ''),
      )
      const circle = p2.find((f) => /円グラフ|投資|内訳/.test(f.label ?? ''))
      const circleBox = circle ? coerceBox(circle.box_2d) : null
      summary.push(`### ${r.label}`)
      summary.push(`- 総 region=${r.regions.length} / page5=${p5.length} / page2=${p2.length}`)
      summary.push(
        `- 問10(器具図)= ${devices.length} 枠 targets=[${devices.map((f) => f.target).join(',')}] boxes=${JSON.stringify(devices.map((f) => f.box_2d))}`,
      )
      summary.push(
        `- 円グラフ(page2)= ${circleBox ? `box=${JSON.stringify(circleBox)} y_max=${circleBox[2]}` : '未検出/該当なし'}`,
      )
      summary.push(`- page5 全 region: ${JSON.stringify(p5.map((f) => ({ t: f.target, b: f.box_2d, l: f.label })))}`)
      summary.push('')
      console.log(
        `  ${r.label}: total=${r.regions.length} p5=${p5.length} 問10枠=${devices.length}(${devices.map((f) => f.target).join(',')}) 円グラフy_max=${circleBox ? circleBox[2] : 'NA'}`,
      )
    }
    } // end exp6
  } catch (err) {
    if (err instanceof HaltError) {
      summary.push('', '> ⚠ 429 で run 途中停止。上記までが取得済み。', '')
      console.error('\n[HALTED] 429 停止・partial 保存済み。')
    } else {
      throw err
    }
  }

  w('SUMMARY-round2.md', summary.join('\n'))
  console.log('\n=== wrote ===')
  for (const p of written) console.log(' ', p)
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
