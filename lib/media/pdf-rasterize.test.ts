// ②-4b T4: pdf-rasterize.ts の unit 検証。
//
// 本 file が担う契約:
//   ① 実 wasm + 実 fixture(tests/fixtures/ocr/mock-exam-3p.pdf・3p)で
//      pageCount / renderPageWebp の寸法(長辺 2048 scale)/ webp magic bytes
//   ② 壊れ bytes / 暗号化 PDF → PdfParseError(Codex I8)
//   ③ document 確保後の setup 失敗経路で destroy が呼ばれる(spy)
//   ④ renderPageWebp を並列呼出ししても実処理(sharp encode)は逐次(peak = 1・
//      handle 単位の内部直列化 queue を pin する)
//
// 実 wasm(PDFiumLibrary.init())は初回コストがあるため testTimeout に余裕を持たせる
// (T4 brief 前提)。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { PDFiumDocument, PDFiumPage } from '@hyzyla/pdfium'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  loadPdf,
  PdfHandleDestroyedError,
  PdfParseError,
} from '@/lib/media/pdf-rasterize'

const WASM_TEST_TIMEOUT_MS = 20_000

// 3p・A4(595×842pt)。 tests/fixtures/ocr/mock-exam-page1.pdf(架空・commit 済)を
// qpdf で 3 回連結した tracked fixture(生成コマンドは
// tests/fixtures/ocr/README.md 参照)。 元々使っていた
// scripts/ai/ocr-samples/mock-exam-set.pdf は gitignore 対象(実教材 drop-zone・
// README「golden fixture 用の擬似問題は tests/fixtures/ocr/ にある」)で fresh
// clone / CI で test が落ちるため、tracked fixture へ切り替えた(canonical
// review Critical 1 の是正)。
const FIXTURE_PDF = path.join(
  process.cwd(),
  'tests/fixtures/ocr/mock-exam-3p.pdf',
)

// tests/fixtures/ocr/mock-exam-page1.pdf(架空・commit 済)を qpdf --encrypt で
// 暗号化した fixture(新規・commit 対象)。 password なしで開こうとすると pdfium が
// PASSWORD error を投げる(Codex I8 の暗号化ケース)。
const ENCRYPTED_FIXTURE_PDF = path.join(
  process.cwd(),
  'tests/fixtures/ocr/mock-exam-page1-encrypted.pdf',
)

describe('pdf-rasterize — 実 wasm + 実 fixture', () => {
  it(
    'pageCount = 3(mock-exam-3p.pdf)',
    async () => {
      const buf = readFileSync(FIXTURE_PDF)
      const handle = await loadPdf(buf)
      try {
        expect(handle.pageCount).toBe(3)
      } finally {
        handle.destroy()
      }
    },
    WASM_TEST_TIMEOUT_MS,
  )

  it(
    'renderPageWebp(0) は長辺 2048 scale の寸法・webp magic bytes を返す',
    async () => {
      const buf = readFileSync(FIXTURE_PDF)
      const handle = await loadPdf(buf)
      try {
        const { webp, width, height } = await handle.renderPageWebp(0)
        // A4(595×842pt)→ 長辺 2048 scale ≈ 1447×2048(実測値・±2px 許容)。
        expect(width).toBeGreaterThanOrEqual(1445)
        expect(width).toBeLessThanOrEqual(1449)
        expect(height).toBeGreaterThanOrEqual(2046)
        expect(height).toBeLessThanOrEqual(2050)
        expect(webp.subarray(0, 4).toString('ascii')).toBe('RIFF')
        expect(webp.subarray(8, 12).toString('ascii')).toBe('WEBP')
      } finally {
        handle.destroy()
      }
    },
    WASM_TEST_TIMEOUT_MS,
  )

  it(
    '壊れ bytes → PdfParseError',
    async () => {
      const garbage = Buffer.from(
        'this is not a pdf file at all, just garbage bytes 1234567890',
        'utf-8',
      )
      await expect(loadPdf(garbage)).rejects.toBeInstanceOf(PdfParseError)
    },
    WASM_TEST_TIMEOUT_MS,
  )

  it(
    '暗号化 PDF → PdfParseError(Codex I8)',
    async () => {
      const buf = readFileSync(ENCRYPTED_FIXTURE_PDF)
      await expect(loadPdf(buf)).rejects.toBeInstanceOf(PdfParseError)
    },
    WASM_TEST_TIMEOUT_MS,
  )
})

describe('pdf-rasterize — 失敗経路の destroy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it(
    'document 確保後の setup 失敗(getPageCount 例外)で destroy が呼ばれる',
    async () => {
      const destroySpy = vi.spyOn(PDFiumDocument.prototype, 'destroy')
      vi.spyOn(PDFiumDocument.prototype, 'getPageCount').mockImplementationOnce(
        () => {
          throw new Error('injected getPageCount failure')
        },
      )

      const buf = readFileSync(FIXTURE_PDF)
      await expect(loadPdf(buf)).rejects.toBeInstanceOf(PdfParseError)
      expect(destroySpy).toHaveBeenCalledTimes(1)
    },
    WASM_TEST_TIMEOUT_MS,
  )
})

describe('pdf-rasterize — destroy 後の queue 安全性(Codex fix round 2 P1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it(
    'destroy() は冪等(2 回呼んでも安全)',
    async () => {
      const buf = readFileSync(FIXTURE_PDF)
      const handle = await loadPdf(buf)
      expect(() => {
        handle.destroy()
        handle.destroy()
      }).not.toThrow()
    },
    WASM_TEST_TIMEOUT_MS,
  )

  it(
    '並行呼出し中の 1 件が reject → finally で destroy → queue に残っていた分は' +
      ' document に触れず PdfHandleDestroyedError で reject する(use-after-free 防止)',
    async () => {
      const buf = readFileSync(FIXTURE_PDF)
      const handle = await loadPdf(buf)

      // page 0 の render() だけを「呼び出し側が明示的に解放するまで pending の
      // まま止める → その後 reject する」よう差し替える。 これにより
      // 「page 0 は document.getPage/getOriginalSize まで実行済み(= queue の
      // 先頭を消費中)だが、まだ確定していない」window を確定的に作れる
      // (setTimeout 競合に頼らない)。 getPage/render 呼出回数は spy で数え、
      // page1/page2 が document に一切触れていないことを直接証明する。
      let releasePage0Render: () => void = () => {}
      const page0RenderGate = new Promise<void>((resolve) => {
        releasePage0Render = resolve
      })
      const getPageSpy = vi.spyOn(PDFiumDocument.prototype, 'getPage')
      const renderSpy = vi
        .spyOn(PDFiumPage.prototype, 'render')
        .mockImplementationOnce(async () => {
          await page0RenderGate
          throw new Error('injected render failure for page 0')
        })

      const p0 = handle.renderPageWebp(0)
      const p1 = handle.renderPageWebp(1)
      const p2 = handle.renderPageWebp(2)

      // 保留中の microtask(page 0 が document.getPage → getOriginalSize →
      // render() 呼出〈= gate で pending〉まで進む分)を確実に処理しきる。
      await new Promise((resolve) => setTimeout(resolve, 0))

      // この時点で page 0 は「render() 呼出済み・確定はまだ」、page1/page2 は
      // queue の中で page 0 の後ろに並んだまま document に一切触れていない。
      // 呼び出し側の典型パターン(Promise.all(...).finally(() => handle.destroy()))
      // が「1 件の失敗が確定する前に」destroy を呼ぶケースを含めて再現する。
      handle.destroy()
      releasePage0Render()

      await expect(p0).rejects.toBeInstanceOf(PdfParseError)
      await expect(p1).rejects.toBeInstanceOf(PdfHandleDestroyedError)
      await expect(p2).rejects.toBeInstanceOf(PdfHandleDestroyedError)
      // page1/page2 は document に一切触れていない(getPage 呼出は page0 の
      // 1 回のみ・render 呼出も page0 の 1 回のみ) — use-after-free が
      // 発生していないことの直接証拠。
      expect(getPageSpy).toHaveBeenCalledTimes(1)
      expect(renderSpy).toHaveBeenCalledTimes(1)
    },
    WASM_TEST_TIMEOUT_MS,
  )
})

describe('pdf-rasterize — 逐次 pin', () => {
  afterEach(() => {
    vi.doUnmock('sharp')
    vi.resetModules()
  })

  it(
    'renderPageWebp を並列呼出ししても実 encode(sharp)は逐次(peak 同時実行 = 1)',
    async () => {
      // sharp を計測 mock に差し替える(既存様式 =
      // app/(app)/app/upload/_lib/upload-pipeline.test.ts の decode 逐次 pin と
      // 同じ in-flight 計測)。 他 test は実 sharp を使うため、ここだけ
      // vi.doMock + resetModules + 動的 import で局所化する。
      const sharpState = { inFlight: 0, peakInFlight: 0 }
      vi.doMock('sharp', () => ({
        default: () => ({
          webp: () => ({
            toBuffer: async () => {
              sharpState.inFlight += 1
              sharpState.peakInFlight = Math.max(
                sharpState.peakInFlight,
                sharpState.inFlight,
              )
              await new Promise((resolve) => setTimeout(resolve, 5))
              sharpState.inFlight -= 1
              return Buffer.from('fake-webp-bytes')
            },
          }),
        }),
      }))
      vi.resetModules()
      const { loadPdf: loadPdfWithMockSharp } = await import(
        '@/lib/media/pdf-rasterize'
      )

      const buf = readFileSync(FIXTURE_PDF)
      const handle = await loadPdfWithMockSharp(buf)
      try {
        await Promise.all([0, 1, 2].map((i) => handle.renderPageWebp(i)))
      } finally {
        handle.destroy()
      }

      expect(sharpState.peakInFlight).toBe(1)
    },
    WASM_TEST_TIMEOUT_MS,
  )
})
