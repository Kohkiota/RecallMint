// ocr-box2d-viz.ts の test。 実 API / 実 network は一切使わない
// (callGeminiRaw を vi.mock で完全に差し替える。 loadImageInline も差し替え、
// tests/fixtures/ocr/ には一切書き込まない — 画像 dir/out dir は各 test が OS
// tmpdir に作る)。
//
// renderOverlayHtml(pure)は mock 無しで直接呼ぶ。 orchestration(runViz)は
// callGeminiRaw/loadImageInline を mock し、429 halt・per-image error 続行・
// 画像毎の .html 出力・malformed regions 耐性のみを検証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

import { renderOverlayHtml, runViz, parseCliArgs } from './ocr-box2d-viz'

// ============================================================================
// renderOverlayHtml(pure)
// ============================================================================

describe('renderOverlayHtml', () => {
  it('有効な box → position:absolute な div が left/top/width/height% + escape 済 target ラベルを持つ', () => {
    const html = renderOverlayHtml('data:image/png;base64,AAAA', [
      { box_2d: [100, 200, 600, 700], target: 'question' },
    ])

    // boxToPercent([100,200,600,700]) = { left:20, top:10, width:50, height:50 }
    expect(html).toContain('position:absolute')
    expect(html).toContain('left:20%')
    expect(html).toContain('top:10%')
    expect(html).toContain('width:50%')
    expect(html).toContain('height:50%')
    expect(html).toContain('question')
    // 元画像の container / img も含む
    expect(html).toContain('position:relative')
    expect(html).toContain('data:image/png;base64,AAAA')
  })

  it('label 付きの有効な box → escape 済 label もラベルに含む', () => {
    const html = renderOverlayHtml('data:image/png;base64,AAAA', [
      { box_2d: [0, 0, 500, 500], target: 'option_a', label: '図1: グラフ' },
    ])
    expect(html).toContain('option_a')
    expect(html).toContain('図1: グラフ')
  })

  it('有効な box のラベルに raw box_2d 座標も文字列で併記する(EXIF/座標ズレを目視で気付けるように)', () => {
    const html = renderOverlayHtml('data:image/png;base64,AAAA', [
      { box_2d: [100, 200, 600, 700], target: 'question' },
    ])
    expect(html).toContain('[100,200,600,700]')
  })

  it('invalid box(ゼロ高さ)→ 補正した absolute box を描画せず、invalid リストに raw 値 + reason を出す', () => {
    const html = renderOverlayHtml('data:image/png;base64,AAAA', [
      { box_2d: [100, 200, 100, 700], target: 'explanation' },
    ])

    // invalid リストに raw 座標が出る
    expect(html).toContain('[100,200,100,700]')
    // boxToPercent の invalid reason(ゼロ/負の面積)がそのまま出る
    expect(html).toContain('zero or negative area')
    expect(html).toContain('explanation')

    // 補正(clamp/reorder)した box を描画していない: この box に対応する
    // position:absolute な box 要素が存在しない = ocr-box class の出現数が 0
    const boxDivCount = (html.match(/class="ocr-box"/g) ?? []).length
    expect(boxDivCount).toBe(0)
  })

  it('invalid box(要素数3)→ invalid リストに出て、box は描画されない', () => {
    const html = renderOverlayHtml('data:image/png;base64,AAAA', [
      { box_2d: [100, 200, 600], target: 'question' },
    ])
    expect(html).toContain('[100,200,600]')
    expect(html).toContain('must be an array of exactly 4 numbers')
    const boxDivCount = (html.match(/class="ocr-box"/g) ?? []).length
    expect(boxDivCount).toBe(0)
  })

  it('target に <script> が混入していても escape され、literal <script> は出力に現れない', () => {
    const html = renderOverlayHtml('data:image/png;base64,AAAA', [
      { box_2d: [0, 0, 500, 500], target: '<script>alert(1)</script>' },
    ])
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('invalid box の target に <script> が混入していても escape される', () => {
    const html = renderOverlayHtml('data:image/png;base64,AAAA', [
      { box_2d: [100, 200, 100, 700], target: '<script>evil()</script>' },
    ])
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>evil()</script>')
  })

  it('label が実行時に非 string(型を偽装した runtime 不正値)でも throw せず box は描画される(escapeHtml safety net・review Important3-b)', () => {
    const html = renderOverlayHtml('data:image/png;base64,AAAA', [
      { box_2d: [100, 200, 600, 700], target: 'question', label: 123 as unknown as string },
    ])
    expect(html).toContain('position:absolute')
    expect(html).toContain('question')
  })

  it('region が 0 件でも throw せず、invalid セクションは空である旨を出す', () => {
    const html = renderOverlayHtml('data:image/png;base64,AAAA', [])
    expect(html).toContain('position:relative')
    const boxDivCount = (html.match(/class="ocr-box"/g) ?? []).length
    expect(boxDivCount).toBe(0)
  })
})

// ============================================================================
// runViz(orchestration・callGeminiRaw/loadImageInline mock)
// ============================================================================

function makeImagesDir(filenames: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-box2d-viz-test-'))
  for (const f of filenames) writeFileSync(join(dir, f), 'dummy')
  return dir
}

const RAW_ONE_REGION = JSON.stringify({
  regions: [{ box_2d: [100, 200, 600, 700], target: 'question' }],
})

describe('runViz', () => {
  let imagesDir: string
  let outDir: string

  beforeEach(() => {
    mockCallGeminiRaw.mockReset()
    mockLoadImageInline.mockReset()
    mockLoadImageInline.mockReturnValue({ mimeType: 'image/png', data: 'base64data' })
    imagesDir = makeImagesDir(['img1.png', 'img2.png'])
    outDir = mkdtempSync(join(tmpdir(), 'ocr-box2d-viz-out-'))
  })

  afterEach(() => {
    rmSync(imagesDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  })

  it('画像毎に .html を out dir へ書く(出力名は元 filename 込み)', async () => {
    mockCallGeminiRaw.mockResolvedValue({
      text: RAW_ONE_REGION,
      finishReason: 'STOP',
      usage: {},
    })

    const outcome = await runViz({ imagesDir, outDir })

    expect(outcome.halted).toBe(false)
    expect(outcome.writtenPaths).toHaveLength(2)
    const files = readdirSync(outDir).sort()
    expect(files).toEqual(['img1.png.html', 'img2.png.html'])
    const html = readFileSync(join(outDir, 'img1.png.html'), 'utf8')
    expect(html).toContain('data:image/png;base64,base64data')
    expect(html).toContain('question')
  })

  it('同じ stem で拡張子違い(page.png / page.jpg)は互いの出力を上書きしない(review Important2)', async () => {
    // listImageFiles は sort() する(page.jpg < page.png)ため、呼び出し順は
    // page.jpg が先。 mockResolvedValueOnce の順番をそれに合わせる。
    mockCallGeminiRaw
      .mockResolvedValueOnce({
        text: JSON.stringify({ regions: [{ box_2d: [0, 0, 100, 100], target: 'from-jpg' }] }),
        finishReason: 'STOP',
        usage: {},
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ regions: [{ box_2d: [0, 0, 100, 100], target: 'from-png' }] }),
        finishReason: 'STOP',
        usage: {},
      })

    const dir = makeImagesDir(['page.png', 'page.jpg'])
    const outcome = await runViz({ imagesDir: dir, outDir })

    expect(outcome.writtenPaths).toHaveLength(2)
    const files = readdirSync(outDir).sort()
    expect(files).toEqual(['page.jpg.html', 'page.png.html'])
    const pngHtml = readFileSync(join(outDir, 'page.png.html'), 'utf8')
    const jpgHtml = readFileSync(join(outDir, 'page.jpg.html'), 'utf8')
    expect(pngHtml).toContain('from-png')
    expect(pngHtml).not.toContain('from-jpg')
    expect(jpgHtml).toContain('from-jpg')
    expect(jpgHtml).not.toContain('from-png')
  })

  it('.pdf は <img> で描画できないため warn して skip し、API も叩かず html も書かない(review Important1)', async () => {
    mockCallGeminiRaw.mockResolvedValue({
      text: RAW_ONE_REGION,
      finishReason: 'STOP',
      usage: {},
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const dir = makeImagesDir(['img1.png', 'doc1.pdf'])
    const outcome = await runViz({ imagesDir: dir, outDir })

    // img1.png のみ処理される。doc1.pdf は API を一切叩かない。
    expect(mockCallGeminiRaw).toHaveBeenCalledTimes(1)
    expect(mockLoadImageInline).toHaveBeenCalledTimes(1)
    expect(outcome.writtenPaths).toHaveLength(1)
    const files = readdirSync(outDir)
    expect(files).not.toContain('doc1.pdf.html')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('doc1.pdf'))

    warnSpy.mockRestore()
  })

  it('region の label が非 string(number)でも、その region 自体は valid box として描画され画像全体は drop されない(review Important3)', async () => {
    mockCallGeminiRaw.mockResolvedValue({
      text: JSON.stringify({
        regions: [{ box_2d: [100, 200, 600, 700], target: 'question', label: 123 }],
      }),
      finishReason: 'STOP',
      usage: {},
    })

    const outcome = await runViz({ imagesDir: makeImagesDir(['img1.png']), outDir })

    expect(outcome.halted).toBe(false)
    expect(outcome.writtenPaths).toHaveLength(1)
    const html = readFileSync(outcome.writtenPaths[0], 'utf8')
    const boxDivCount = (html.match(/class="ocr-box"/g) ?? []).length
    expect(boxDivCount).toBe(1)
    expect(html).toContain('question')
  })

  it('malformed regions JSON(JSON parse 失敗)は throw せず、zero region の file を出す', async () => {
    mockCallGeminiRaw.mockResolvedValue({
      text: 'not-json{{',
      finishReason: 'STOP',
      usage: {},
    })

    const outcome = await runViz({ imagesDir: makeImagesDir(['img1.png']), outDir })

    expect(outcome.halted).toBe(false)
    expect(outcome.writtenPaths).toHaveLength(1)
    const html = readFileSync(outcome.writtenPaths[0], 'utf8')
    const boxDivCount = (html.match(/class="ocr-box"/g) ?? []).length
    expect(boxDivCount).toBe(0)
  })

  it('regions フィールドが欠落/非配列でも throw せず zero region 扱いにする', async () => {
    mockCallGeminiRaw.mockResolvedValue({
      text: JSON.stringify({ regions: 'not-an-array' }),
      finishReason: 'STOP',
      usage: {},
    })

    const outcome = await runViz({ imagesDir: makeImagesDir(['img1.png']), outDir })

    expect(outcome.halted).toBe(false)
    expect(outcome.writtenPaths).toHaveLength(1)
    const html = readFileSync(outcome.writtenPaths[0], 'utf8')
    const boxDivCount = (html.match(/class="ocr-box"/g) ?? []).length
    expect(boxDivCount).toBe(0)
  })

  it('429 を受けたら以降の画像を一切処理せず即停止する', async () => {
    mockCallGeminiRaw
      .mockResolvedValueOnce({ text: RAW_ONE_REGION, finishReason: 'STOP', usage: {} })
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))

    const outcome = await runViz({ imagesDir, outDir })

    expect(mockCallGeminiRaw).toHaveBeenCalledTimes(2)
    expect(outcome.halted).toBe(true)
    // img1 は成功して書かれているが、img2 は 429 で失敗 → 書かれない
    expect(outcome.writtenPaths).toHaveLength(1)
  })

  it('429 以外の per-image error はログして次の画像へ続行する', async () => {
    mockCallGeminiRaw
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({ text: RAW_ONE_REGION, finishReason: 'STOP', usage: {} })

    const outcome = await runViz({ imagesDir, outDir })

    expect(mockCallGeminiRaw).toHaveBeenCalledTimes(2)
    expect(outcome.halted).toBe(false)
    // img1 は失敗(書かれない)、img2 は成功(書かれる)
    expect(outcome.writtenPaths).toHaveLength(1)
  })
})

// ============================================================================
// parseCliArgs
// ============================================================================

describe('parseCliArgs', () => {
  it('--images を要求する', () => {
    expect(() => parseCliArgs([])).toThrow(/--images/)
  })

  it('--images <dir> を parse する', () => {
    expect(parseCliArgs(['--images', '/tmp/foo'])).toEqual({ imagesDir: '/tmp/foo' })
  })
})
