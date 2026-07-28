#!/usr/bin/env tsx
// box_2d 可視化スクリプト(②-0 OCR regression 基盤 Task 7)。
//
// 目的: Gemini に図版 box_2d を検出させ、元画像に矩形 overlay した HTML を出す。
// OT が目視で box 精度を判定する(②-4 go/no-go)ための **実行・描画・書込のみ**を
// 行うスクリプト — 良し悪しの判定は一切しない。
//
// 実行(OT 合図で実 API 呼出。 GEMINI_API_KEY 必須・料金発生):
//   tsx scripts/ai/ocr-box2d-viz.ts --images <dir>
//
// 依存追加ゼロ: 画像は data URI で HTML に直接埋め込み、box は CSS % で絶対配置する
// (画像 library 不使用)。box_2d → % 変換は lib/box-overlay.ts の boxToPercent(T4)。
//
// invalid box(範囲外・ゼロ/負の面積・要素数不正等)は clamp/reorder で「それっぽく」
// 補正しない — boxToPercent が invalid を返したら描画せず、raw 座標 + reason を
// 明示的な invalid リストへ出す(異常を隠さず見せることが本 script の目的)。
//
// 本番との違い(T3 callGeminiRaw と同型の注意点): modelId は raw string 固定
// (本番 modelId() 変換を経由しない)、 retry は一切しない(1 回呼び出し)。
// 429 は CLAUDE.md AI 絶対ルール5(即停止・リトライ禁止)に従い run 全体を停止する。
// 429 以外の per-image error はログして次の画像へ続行する(1 画像の失敗が
// batch 全体を止めない)。

import { readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { isRateLimitError } from '@/lib/retry/transient-error'
import { callGeminiRaw } from './lib/gemini-raw'
import { buildBox2dVizSchema, buildBox2dVizPrompt } from './lib/figure-detect-schema'
import { loadImageInline } from './lib/load-images'
import { boxToPercent } from './lib/box-overlay'

// capture/compare と同様、本番 modelId() 変換を経由しない固定モデル(raw string)。
export const DEFAULT_MODEL_ID = 'gemini-2.5-flash'

export const OUT_DIR = join(process.cwd(), 'scripts/ai/ocr-samples/out')

// このスクリプトは HTML <img> タグで実際に描画できる形式のみを処理対象にする
// (review 2026-07-28 Important: loadImageInline/load-images.ts の MIME_BY_EXT は
// .pdf も allowlist に含むが、`<img src="data:application/pdf;...">` はブラウザで
// 空白になり overlay の box が「何も無い場所に浮く」— 本 script の目的(目視判定)を
// 壊す。 png/jpg/jpeg/webp のみを実処理対象にする)。
const RENDERABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

// loadImageInline 自体は読める(MIME_BY_EXT に含まれる)が <img> では描画できない
// 拡張子。 dir 列挙で見つけたら明示的に warn して skip する(黙って無視しない・
// 有料 API にも送らない)。 load-images.ts は内部 map を export していないため、
// ここでも小さな一覧を個別に持つ(ocr-compare.ts の IMAGE_EXTENSIONS と同型の
// 既存パターン — 3 箇所目の重複は canonical Minor として記録済み、共有化は
// scripts/ai/lib/** への変更を要するため本 task 範囲外)。
const NON_RENDERABLE_EXTENSIONS = new Set(['.pdf'])

// ============================================================================
// PURE helper: renderOverlayHtml
// ============================================================================
// I/O・Date.now なし。 model 由来のテキスト(target/label/raw box_2d 座標)は
// 必ず escape する(ローカル file であっても、悪意/破損した target 文字列が
// markup として解釈されないように)。

export type VizRegion = { box_2d: unknown; target: string; label?: string }

// HTML 特殊文字 escape。 & を最初に処理する(他の置換で生成される `&amp;` 等の
// `&` を二重 escape しないよう、置換対象文字のうち & を単独で先頭に置く)。
// 引数は unknown を受ける safety net(review 2026-07-28 Important3-b): 型上は
// string を要求する呼び出し元(VizRegion.label 等)でも、実データは JSON.parse
// 直後の model 応答由来で TypeScript の型保証を実効的にすり抜けうる。 非 string が
// 来ても .replace で throw せず String() 変換してから escape する(呼び出し元の
// parseRegions で label は既に sanitize 済みだが、二重の防御として残す)。
function escapeHtml(input: unknown): string {
  const str = typeof input === 'string' ? input : String(input)
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// raw box_2d を人間可読な文字列にして escape する。 box_2d は常に JSON.parse 済み
// レスポンスに由来するため(呼び出し元 = runViz の parseRegions)、循環参照や
// undefined は構造的に発生しない — 過剰な try/catch は付けない(簡潔性規律)。
function formatRawBox2d(box2d: unknown): string {
  return escapeHtml(JSON.stringify(box2d))
}

export function renderOverlayHtml(imageDataUri: string, regions: VizRegion[]): string {
  const boxDivs: string[] = []
  const invalidItems: string[] = []

  regions.forEach((region, index) => {
    const result = boxToPercent(region.box_2d)
    const targetEsc = escapeHtml(region.target)
    const labelEsc = region.label !== undefined ? escapeHtml(region.label) : undefined
    const rawEsc = formatRawBox2d(region.box_2d)

    if (result.valid) {
      const labelText = labelEsc ? `${targetEsc}: ${labelEsc}` : targetEsc
      boxDivs.push(
        `<div class="ocr-box" data-region-index="${index}" style="position:absolute; left:${result.left}%; top:${result.top}%; width:${result.width}%; height:${result.height}%;">` +
          `<span class="ocr-box-label">${labelText} [${rawEsc}]</span>` +
          `</div>`,
      )
    } else {
      const reasonEsc = escapeHtml(result.reason)
      invalidItems.push(
        `<li><strong>${targetEsc}</strong>${labelEsc ? ` (${labelEsc})` : ''} — box_2d: <code>${rawEsc}</code> — reason: ${reasonEsc}</li>`,
      )
    }
  })

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<title>box_2d overlay</title>',
    '<style>',
    'body { font-family: sans-serif; }',
    '.ocr-image-container { position:relative; display:inline-block; max-width:100%; }',
    '.ocr-image-container > img { width:100%; display:block; }',
    '.ocr-box { border:2px solid #ff3b30; box-sizing:border-box; }',
    '.ocr-box-label { position:absolute; top:-1.3em; left:0; background:#ff3b30; color:#fff; font:11px/1.4 monospace; padding:0 4px; white-space:nowrap; }',
    '.ocr-invalid-list { font:12px/1.5 monospace; }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="ocr-image-container" style="position:relative;">',
    `<img src="${imageDataUri}">`,
    ...boxDivs,
    '</div>',
    '<h2>Invalid regions</h2>',
    invalidItems.length > 0
      ? `<ul class="ocr-invalid-list">${invalidItems.join('')}</ul>`
      : '<p>(none)</p>',
    '</body>',
    '</html>',
  ].join('\n')
}

// ============================================================================
// Orchestration(I/O・実 API 呼び出し・CLI)
// ============================================================================

// dir 列挙は決定論 sort(brief 要求)。 ocr-compare.ts の listImageFiles と同型だが、
// ここでは「画像として読める」だけでなく「<img> で描画できる」ものに加え、
// 読めるが描画できない拡張子(.pdf)も一旦拾う — runViz 側で後者を明示的に
// warn+skip するため(黙って一覧から消すと「気付かれない silent skip」になる)。
function listImageFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => {
      const ext = extname(f).toLowerCase()
      return RENDERABLE_EXTENSIONS.has(ext) || NON_RENDERABLE_EXTENSIONS.has(ext)
    })
    .sort()
}

// モデル応答 text を defensive に JSON.parse し、.regions を読む。 欠落/非配列/
// parse 失敗はいずれも空配列として扱う(brief: 「tolerate a missing/malformed
// regions array — treat as empty + note」— note は呼び出し側 runViz が
// console.warn で出す)。 配列内の各要素も box_2d/target を持たない壊れた要素は
// 個別に弾く(1 要素の破損で全体を捨てない)。
// label は optional なので厳密でない(review 2026-07-28 Important3-a): box_2d/target
// が有効でも label だけ非 string(null/number/object 等)なら、その region 自体は
// 捨てずに label を undefined へ落とす — 壊れた cosmetic label 1 個で有効な
// box+target を巻き添えにしない。
function parseRegions(text: string): VizRegion[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const regions = (parsed as { regions?: unknown }).regions
  if (!Array.isArray(regions)) return []
  return regions
    .filter((r): r is { box_2d: unknown; target: string; label?: unknown } => {
      if (r === null || typeof r !== 'object') return false
      const candidate = r as { box_2d?: unknown; target?: unknown }
      return 'box_2d' in candidate && typeof candidate.target === 'string'
    })
    .map((r) => ({
      box_2d: r.box_2d,
      target: r.target,
      label: typeof r.label === 'string' ? r.label : undefined,
    }))
}

export type RunVizOptions = {
  imagesDir: string
  outDir?: string
  modelId?: string
}

export type RunVizOutcome = {
  writtenPaths: string[]
  halted: boolean
}

// 画像毎に逐次 1 回ずつ callGeminiRaw する。 429 は run 全体を即停止(以降の画像を
// 一切処理しない、CLAUDE.md AI 絶対ルール5)。 それ以外の per-image error は
// ログして次の画像へ続行する。
export async function runViz(opts: RunVizOptions): Promise<RunVizOutcome> {
  const outDir = opts.outDir ?? OUT_DIR
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID
  mkdirSync(outDir, { recursive: true })

  const images = listImageFiles(opts.imagesDir)
  const writtenPaths: string[] = []
  let halted = false

  for (const filename of images) {
    if (NON_RENDERABLE_EXTENSIONS.has(extname(filename).toLowerCase())) {
      // review 2026-07-28 Important1: .pdf 等は <img> data URI で空白になり、box が
      // 何も無い場所に浮く(本 script の目的=目視判定を壊す)。 明示的に warn して
      // skip する — loadImageInline/callGeminiRaw を一切呼ばない(有料 API に送らない)。
      console.warn(
        `[ocr-box2d-viz] "${filename}": skipped — not renderable via <img> data URI, not sent to the API`,
      )
      continue
    }

    try {
      const file = loadImageInline(join(opts.imagesDir, filename))
      const raw = await callGeminiRaw({
        modelId,
        files: [file],
        prompt: buildBox2dVizPrompt(),
        responseJsonSchema: buildBox2dVizSchema(),
      })

      const regions = parseRegions(raw.text)
      if (regions.length === 0) {
        console.warn(
          `[ocr-box2d-viz] "${filename}": regions missing/malformed in model response — treating as zero regions`,
        )
      }

      const imageDataUri = `data:${file.mimeType};base64,${file.data}`
      const html = renderOverlayHtml(imageDataUri, regions)
      // review 2026-07-28 Important2: basename(file, ext) だけだと同じ stem で
      // 拡張子違い(page.png / page.jpg)が同じ page.html に衝突し、後勝ちで無言
      // 上書きされる(writtenPaths には両方記録されるのに実体は 1 個しか残らない)。
      // 出力名に元 filename(拡張子込み)をそのまま使い、衝突を構造的に無くす。
      const outPath = join(outDir, `${filename}.html`)
      writeFileSync(outPath, html, 'utf8')
      writtenPaths.push(outPath)
    } catch (err) {
      if (isRateLimitError(err)) {
        // ルール5(CLAUDE.md AI 絶対): 429 は即停止・以降の call を一切開始しない。
        console.error(`[ocr-box2d-viz] halted after a 429 (rate limit) on image "${filename}"`)
        halted = true
        break
      }
      console.error(
        `[ocr-box2d-viz] "${filename}" failed, continuing to next image:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return { writtenPaths, halted }
}

// ============================================================================
// CLI
// ============================================================================

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx === -1) return undefined
  return argv[idx + 1]
}

export function parseCliArgs(argv: string[]): { imagesDir: string } {
  const imagesDir = argValue(argv, '--images')
  if (!imagesDir) throw new Error('--images <dir> is required')
  return { imagesDir }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const parsed = parseCliArgs(argv)
  const outcome = await runViz(parsed)
  for (const p of outcome.writtenPaths) console.log(`wrote ${p}`)
  if (outcome.halted) {
    console.error(
      '[ocr-box2d-viz] halted after a 429 (rate limit) response — partial output was saved',
    )
    process.exitCode = 1
  }
}

// process.argv[1] が本 file のとき = CLI 起動。 import(test 含む)時は走らない
// (ocr-compare.ts / ocr-capture-fixture.ts 踏襲の guard)。
if (process.argv[1]?.endsWith('ocr-box2d-viz.ts')) {
  main().catch((err) => {
    console.error('[ocr-box2d-viz] fatal:', err)
    process.exit(1)
  })
}
