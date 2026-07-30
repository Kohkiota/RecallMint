#!/usr/bin/env tsx
// TEMP throwaway (②-4 fact-finding) — PDF ネイティブ入力での box_2d 挙動を実 API で確かめる。
// 本番コード / prompt / schema には一切触らない。使い捨て前提、run 後に削除する。
//
// 実験:
//   1. mock-exam-set.pdf を rasterize せず 1 回で渡し、page 付き figure_regions を検出。
//   2. 返った box_2d を対照ページ画像 (mock-exam-set-p-N.png) に overlay した HTML を出す。
//   3. 各ページ画像を単体入力して box_2d を取り、PDF 入力の座標と各辺差分を比較。
//   4. 8p_textonly.pdf で figure_regions が空で返るか(幻矩形なし)を確認。
//
// 実 API 使用は OT 合図。429 は即停止・retry 禁止(callGeminiRaw が single call)。
// モデルは現行 gemini-3.1-flash-lite。出力は out/(gitignore)。

import { config } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRateLimitError } from '@/lib/retry/transient-error'
import { callGeminiRaw } from './lib/gemini-raw'
import { loadImageInline } from './lib/load-images'
import { buildBox2dVizSchema, buildBox2dVizPrompt } from './lib/figure-detect-schema'
import { renderOverlayHtml, type VizRegion } from './ocr-box2d-viz'

config({ path: '.env.local' })

const MODEL_ID = 'gemini-3.1-flash-lite'
const SAMPLES = join(process.cwd(), 'scripts/ai/ocr-samples')
const OUT = join(SAMPLES, 'out')
const PDF = join(SAMPLES, 'mock-exam-set.pdf')
const TEXTONLY_PDF = join(SAMPLES, '8p_textonly.pdf')
const PAGE_PNG = (n: number) => join(SAMPLES, `mock-exam-set-p-${n}.png`)
const PAGES = [1, 2, 3, 4, 5]

// ---- page 付き schema / prompt(throwaway・PDF 全ページ横断)-------------------
const PDF_SCHEMA: Record<string, unknown> = {
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
const PDF_PROMPT = [
  'この PDF の全ページから、図・写真・グラフ等の図版領域のみを検出し regions[] として返すこと。',
  '文字のみの領域は対象外、座標を返さないこと。',
  '',
  '- page: その図版が存在するページ番号(1 始まり)',
  '- box_2d: [y_min, x_min, y_max, x_max](そのページを 0-1000 に正規化した座標、y が先)',
  '- target: 図が属する箇所。 "question" / "option_{id}" / "explanation" のいずれか',
  '- label: 図の簡潔な説明 (optional)',
  '- 図が無ければ regions は空配列で返す',
].join('\n')

// ---- tolerant parser(page optional)-----------------------------------------
type ProbeRegion = { page?: number; box_2d: unknown; target: string; label?: string }

function parseRegions(text: string): { regions: ProbeRegion[]; parseError?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { regions: [], parseError: `JSON parse failed: ${(e as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object') return { regions: [], parseError: 'root not object' }
  const regions = (parsed as { regions?: unknown }).regions
  if (!Array.isArray(regions)) return { regions: [], parseError: 'regions not array' }
  const out: ProbeRegion[] = []
  for (const r of regions) {
    if (r === null || typeof r !== 'object') continue
    const c = r as Record<string, unknown>
    if (!('box_2d' in c) || typeof c.target !== 'string') continue
    out.push({
      page: typeof c.page === 'number' ? c.page : undefined,
      box_2d: c.box_2d,
      target: c.target,
      label: typeof c.label === 'string' ? c.label : undefined,
    })
  }
  return { regions: out }
}

// box_2d を [y_min,x_min,y_max,x_max] number[4] に coerce(不正は null)。
function coerceBox(box: unknown): [number, number, number, number] | null {
  if (!Array.isArray(box) || box.length !== 4) return null
  if (box.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null
  return box as [number, number, number, number]
}

function centerOf(b: [number, number, number, number]): { cx: number; cy: number } {
  const [yMin, xMin, yMax, xMax] = b
  return { cx: (xMin + xMax) / 2, cy: (yMin + yMax) / 2 }
}

// greedy nearest-center マッチ + 各辺差分(0-1000 単位)。
function matchAndDiff(
  pdf: ProbeRegion[],
  img: ProbeRegion[],
): {
  matched: Array<{
    pdf_box: number[]
    img_box: number[]
    pdf_target: string
    img_target: string
    edge_diffs: [number, number, number, number]
    center_dist: number
  }>
  img_unmatched: ProbeRegion[]
} {
  const pdfBoxes = pdf.map((r) => ({ r, b: coerceBox(r.box_2d) })).filter((x) => x.b) as {
    r: ProbeRegion
    b: [number, number, number, number]
  }[]
  const imgBoxes = img.map((r) => ({ r, b: coerceBox(r.box_2d) })).filter((x) => x.b) as {
    r: ProbeRegion
    b: [number, number, number, number]
  }[]
  const usedImg = new Set<number>()
  const matched: ReturnType<typeof matchAndDiff>['matched'] = []
  for (const p of pdfBoxes) {
    const pc = centerOf(p.b)
    let best = -1
    let bestDist = Infinity
    imgBoxes.forEach((im, i) => {
      if (usedImg.has(i)) return
      const ic = centerOf(im.b)
      const d = Math.hypot(pc.cx - ic.cx, pc.cy - ic.cy)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    })
    if (best >= 0) {
      usedImg.add(best)
      const im = imgBoxes[best]
      matched.push({
        pdf_box: p.b,
        img_box: im.b,
        pdf_target: p.r.target,
        img_target: im.r.target,
        edge_diffs: [
          Math.abs(p.b[0] - im.b[0]),
          Math.abs(p.b[1] - im.b[1]),
          Math.abs(p.b[2] - im.b[2]),
          Math.abs(p.b[3] - im.b[3]),
        ],
        center_dist: Math.round(bestDist * 10) / 10,
      })
    }
  }
  return {
    matched,
    img_unmatched: imgBoxes.filter((_, i) => !usedImg.has(i)).map((x) => x.r),
  }
}

function dataUri(path: string): string {
  const f = loadImageInline(path)
  return `data:${f.mimeType};base64,${f.data}`
}

function toVizRegions(rs: ProbeRegion[]): VizRegion[] {
  return rs.map((r) => ({ box_2d: r.box_2d, target: r.target, label: r.label }))
}

function rangeSummary(rs: ProbeRegion[]): string {
  const vals: number[] = []
  for (const r of rs) {
    const b = coerceBox(r.box_2d)
    if (b) vals.push(...b)
  }
  if (vals.length === 0) return 'no valid box values'
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const inRange = vals.every((v) => v >= 0 && v <= 1000)
  return `min=${min} max=${max} all_in_0_1000=${inRange}`
}

class HaltError extends Error {}

async function callOrHalt(
  label: string,
  files: { mimeType: string; data: string }[],
  prompt: string,
  schema: Record<string, unknown>,
): Promise<{ text: string; usage: unknown; finishReason: string | undefined } | null> {
  try {
    const raw = await callGeminiRaw({ modelId: MODEL_ID, files, prompt, responseJsonSchema: schema })
    console.log(`[${label}] usage=${JSON.stringify(raw.usage)} finishReason=${raw.finishReason}`)
    return raw
  } catch (err) {
    if (isRateLimitError(err)) {
      console.error(`[${label}] HALT: 429 rate limit — 即停止(retry しない)`)
      throw new HaltError('429')
    }
    console.error(`[${label}] error(continue):`, err instanceof Error ? err.message : String(err))
    return null
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const summary: string[] = ['# ②-4 PDF-native box_2d probe — 結果サマリ', '', `model: ${MODEL_ID}`, '']
  const written: string[] = []
  const w = (name: string, content: string) => {
    const p = join(OUT, name)
    writeFileSync(p, content, 'utf8')
    written.push(p)
  }

  try {
    // ---- 実験 1: PDF ネイティブ入力(page 付き)----------------------------
    console.log('\n=== 実験1: PDF 直接入力(page 付き figure 検出) ===')
    const pdfFile = loadImageInline(PDF) // application/pdf
    const raw1 = await callOrHalt('exp1-pdf', [pdfFile], PDF_PROMPT, PDF_SCHEMA)
    let pdfRegions: ProbeRegion[] = []
    if (raw1) {
      const parsed = parseRegions(raw1.text)
      pdfRegions = parsed.regions
      w('exp1-pdf-regions.raw.json', raw1.text)
      w('exp1-pdf-regions.parsed.json', JSON.stringify(pdfRegions, null, 2))
      const pagesReturned = pdfRegions.map((r) => r.page)
      const anyPage = pagesReturned.some((p) => typeof p === 'number')
      summary.push('## 実験1: PDF 直接入力')
      summary.push(`- regions 件数: ${pdfRegions.length}${parsed.parseError ? ` (parseError: ${parsed.parseError})` : ''}`)
      summary.push(`- page field 返却: ${anyPage ? 'あり' : 'なし'} — 値: [${pagesReturned.join(', ')}]`)
      summary.push(`- 座標値域: ${rangeSummary(pdfRegions)}`)
      summary.push(`- targets: [${pdfRegions.map((r) => r.target).join(', ')}]`)
      summary.push('')
      console.log(`  regions=${pdfRegions.length} pages=[${pagesReturned.join(',')}] range=${rangeSummary(pdfRegions)}`)
      for (const r of pdfRegions) console.log('   ', JSON.stringify(r))
    }

    // ---- 実験 2: PDF 座標をページ画像に overlay -----------------------------
    console.log('\n=== 実験2: PDF 由来 box_2d をページ画像に overlay ===')
    summary.push('## 実験2: PDF 座標 × ページ画像 overlay(HTML 目視)')
    for (const n of PAGES) {
      const onPage = pdfRegions.filter((r) => r.page === n)
      const html = renderOverlayHtml(dataUri(PAGE_PNG(n)), toVizRegions(onPage))
      w(`exp2-pdf-coords-on-page-${n}.html`, html)
      summary.push(`- page ${n}: PDF regions ${onPage.length} 件 → exp2-pdf-coords-on-page-${n}.html`)
    }
    // page 未指定 region があれば別掲(どのページにも置けない)
    const noPage = pdfRegions.filter((r) => typeof r.page !== 'number')
    if (noPage.length > 0) summary.push(`- ⚠ page 未指定 region ${noPage.length} 件(overlay 不能)`)
    summary.push('')

    // ---- 実験 3: 画像単体入力 + PDF 座標との差分 --------------------------
    console.log('\n=== 実験3: 画像単体入力での box_2d と PDF 入力の差分 ===')
    summary.push('## 実験3: 画像入力 vs PDF入力(各辺差分・0-1000 単位)')
    const compare: Record<string, unknown> = {}
    for (const n of PAGES) {
      const raw3 = await callOrHalt(`exp3-img-p${n}`, [loadImageInline(PAGE_PNG(n))], buildBox2dVizPrompt(), buildBox2dVizSchema())
      if (!raw3) {
        summary.push(`- page ${n}: 画像入力 呼び出し失敗(skip)`)
        continue
      }
      const imgRegions = parseRegions(raw3.text).regions
      w(`exp3-image-regions-page-${n}.json`, JSON.stringify(imgRegions, null, 2))
      w(`exp3-image-coords-on-page-${n}.html`, renderOverlayHtml(dataUri(PAGE_PNG(n)), toVizRegions(imgRegions)))
      const pdfOnPage = pdfRegions.filter((r) => r.page === n)
      const diff = matchAndDiff(pdfOnPage, imgRegions)
      compare[`page_${n}`] = {
        pdf_count: pdfOnPage.length,
        img_count: imgRegions.length,
        matched: diff.matched,
        img_unmatched_count: diff.img_unmatched.length,
      }
      summary.push(`- page ${n}: PDF ${pdfOnPage.length} / 画像 ${imgRegions.length} — matched ${diff.matched.length}`)
      for (const m of diff.matched) {
        summary.push(
          `    · edge_diffs[y0,x0,y1,x1]=[${m.edge_diffs.join(', ')}] center_dist=${m.center_dist} ` +
            `(pdf ${m.pdf_target} vs img ${m.img_target})`,
        )
      }
      console.log(`  page ${n}: matched ${diff.matched.length}`, JSON.stringify(diff.matched))
    }
    w('exp3-compare.json', JSON.stringify(compare, null, 2))
    summary.push('')

    // ---- 実験 4: 図なし PDF -----------------------------------------------
    console.log('\n=== 実験4: 図なし PDF(幻矩形が出ないか) ===')
    const raw4 = await callOrHalt('exp4-textonly', [loadImageInline(TEXTONLY_PDF)], PDF_PROMPT, PDF_SCHEMA)
    summary.push('## 実験4: 図なし PDF(8p_textonly.pdf)')
    if (raw4) {
      const r4 = parseRegions(raw4.text)
      w('exp4-textonly-regions.raw.json', raw4.text)
      summary.push(`- regions 件数: ${r4.regions.length}(期待=0)${r4.parseError ? ` parseError:${r4.parseError}` : ''}`)
      if (r4.regions.length > 0) for (const r of r4.regions) summary.push(`    · ${JSON.stringify(r)}`)
      console.log(`  regions=${r4.regions.length}`)
    }
    summary.push('')
  } catch (err) {
    if (err instanceof HaltError) {
      summary.push('', '> ⚠ 429 で run 途中停止。上記までが取得済み結果。', '')
      console.error('\n[HALTED] 429 で停止。partial 出力は保存済み。')
    } else {
      throw err
    }
  }

  w('SUMMARY.md', summary.join('\n'))
  console.log('\n=== wrote ===')
  for (const p of written) console.log(' ', p)
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
