#!/usr/bin/env tsx
// TEMP throwaway — 実験5(統合 discover+figure_regions)の保存結果を可視化する。
// API 呼び出しなし: out/exp5-cards.json + ページ PNG から、ページごとに
// 「box_2d overlay(gemini が crop しようとした赤枠)」×「抽出テキスト(question_text/
// options/解説/figure target)」を左右に並べた HTML を生成する。使い捨て、run 後削除。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { boxToPercent } from './lib/box-overlay'

const SAMPLES = join(process.cwd(), 'scripts/ai/ocr-samples')
const OUT = join(SAMPLES, 'out')
const PAGE_PNG = (n: number) => join(SAMPLES, `mock-exam-set-p-${n}.png`)

// この 5 ページ fixture 専用の card→page 対応(sort_key ベース・sample 固有・throwaway)。
// 図なし card も正しいページに載せるため明示 map(figure 無 card は figure page から
// 引けないため)。ページ構成は exp2 スクショで確認済。
const PAGE_BY_SORTKEY: Record<string, number> = {
  '1': 1, '2': 1,
  '3': 2, '4': 2,
  '5': 3, '6': 3,
  '7': 4, '8': 4,
  '9': 5, '10': 5, '11': 5,
}

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

function esc(input: unknown): string {
  const s = typeof input === 'string' ? input : String(input ?? '')
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function dataUri(path: string): string {
  const b64 = readFileSync(path).toString('base64')
  return `data:image/png;base64,${b64}`
}

function boxesHtml(figs: Fig[]): string {
  const out: string[] = []
  figs.forEach((f, i) => {
    const r = boxToPercent(f.box_2d)
    const raw = esc(JSON.stringify(f.box_2d))
    if (r.valid) {
      const lab = `${esc(f.target)}${f.label ? ': ' + esc(f.label) : ''} [${raw}]`
      out.push(
        `<div class="box" style="left:${r.left}%;top:${r.top}%;width:${r.width}%;height:${r.height}%;">` +
          `<span class="lab">#${i + 1} ${lab}</span></div>`,
      )
    } else {
      out.push(`<!-- invalid box #${i + 1}: ${raw} (${esc(r.reason)}) -->`)
    }
  })
  return out.join('\n')
}

function cardHtml(c: Card): string {
  const figs = Array.isArray(c.figure_regions) ? c.figure_regions : []
  const meta =
    `sort_key=${esc(c.sort_key ?? '-')} · opt=${(c.options ?? []).length} · fig=${figs.length} · ` +
    `images=${(c.images ?? []).length} · correct=[${esc((c.correct_answer_ids ?? []).join(','))}]`
  const figTags = figs.length
    ? `<div class="figtags">figure_regions: ` +
      figs
        .map(
          (f) =>
            `<span class="figtag">${esc(f.target)}${f.label ? '(' + esc(f.label) + ')' : ''} ${esc(JSON.stringify(f.box_2d))}</span>`,
        )
        .join(' ／ ') +
      `</div>`
    : `<div class="figtags nofig">figure_regions: なし</div>`
  const opts = (c.options ?? [])
    .map(
      (o) =>
        `<div class="opt${o.is_correct ? ' correct' : ''}">[${esc(o.id)}]${o.is_correct ? ' ✓' : ''} ${esc(o.text)}</div>`,
    )
    .join('')
  const exp = c.explanation_text
    ? `<div class="exp"><b>解説:</b>\n${esc(c.explanation_text)}</div>`
    : ''
  return [
    `<div class="card">`,
    `<h3>${esc(c.title ?? '')}</h3>`,
    `<div class="meta">${meta}</div>`,
    figTags,
    `<div class="qtext"><b>question_text:</b>\n${esc(c.question_text ?? '')}</div>`,
    opts ? `<div class="opts"><b>options:</b>${opts}</div>` : '',
    exp,
    `</div>`,
  ].join('\n')
}

function pageHtml(page: number, cards: Card[]): string {
  const figs = cards.flatMap((c) => (c.figure_regions ?? []).filter((f) => f.page === page))
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>exp5 page ${page}</title>`,
    '<style>',
    'body{font-family:sans-serif;margin:16px;color:#222;}',
    'h2{font-size:16px;}',
    '.wrap{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;}',
    '.imgcol{flex:1 1 520px;max-width:680px;}',
    '.container{position:relative;display:inline-block;width:100%;}',
    '.container img{width:100%;display:block;border:1px solid #ddd;}',
    '.box{position:absolute;border:2px solid #ff3b30;box-sizing:border-box;}',
    '.lab{position:absolute;top:-1.35em;left:0;background:#ff3b30;color:#fff;font:11px/1.4 monospace;padding:0 4px;white-space:nowrap;}',
    '.txtcol{flex:1 1 420px;max-width:620px;}',
    '.card{border:1px solid #ccc;border-radius:6px;padding:10px 12px;margin-bottom:12px;}',
    '.card h3{margin:0 0 6px;font-size:15px;}',
    '.meta{font:11px/1.5 monospace;color:#555;background:#f4f4f4;padding:3px 6px;border-radius:4px;}',
    '.figtags{font:11px/1.5 monospace;margin:6px 0;}',
    '.figtag{color:#b00;}',
    '.nofig{color:#999;}',
    '.qtext{white-space:pre-wrap;font-size:13px;background:#f7fbff;border-left:3px solid #4a90d9;padding:6px 8px;margin:6px 0;}',
    '.opts{font-size:13px;margin:6px 0;}',
    '.opt{padding:1px 0;}',
    '.opt.correct{font-weight:bold;color:#137333;}',
    '.exp{white-space:pre-wrap;font-size:12px;background:#fff8e1;border-left:3px solid #f0ad4e;padding:6px 8px;margin:6px 0;}',
    '</style></head><body>',
    `<h2>page ${page} — gemini が crop しようとした box_2d(赤枠)× 抽出テキスト(統合 exp5)</h2>`,
    '<div class="wrap">',
    '<div class="imgcol"><div class="container">',
    `<img src="${dataUri(PAGE_PNG(page))}">`,
    boxesHtml(figs),
    '</div></div>',
    '<div class="txtcol">',
    ...cards.map(cardHtml),
    '</div>',
    '</div></body></html>',
  ].join('\n')
}

function main(): void {
  mkdirSync(OUT, { recursive: true })
  const cards: Card[] = JSON.parse(readFileSync(join(OUT, 'exp5-cards.json'), 'utf8'))
  const written: string[] = []
  for (const page of [1, 2, 3, 4, 5]) {
    const onPage = cards.filter((c) => PAGE_BY_SORTKEY[c.sort_key ?? ''] === page)
    const p = join(OUT, `exp5-combined-page-${page}.html`)
    writeFileSync(p, pageHtml(page, onPage), 'utf8')
    written.push(p)
  }
  for (const p of written) console.log('wrote', p)
}

main()
