// GET /api/pdfprobe-pdfium — ②-4b T1: pdfium WASM stg 実証用の一時 probe route(chore)。
//
// 目的: OCR PDF ラスタライズ導入前に最大の未確定「WASM が Vercel の実 Node.js
// function に同梱されるか(NFT が拾うか)」を先に潰す(spec 2026-08-07-ocr-2-4b-
// pdf-rasterize §9)。埋込みの最小 1 ページ PDF を `@hyzyla/pdfium` で
// loadDocument→getPageCount し `{ pages: 1 }` を返すだけの read-only probe。
//
// 認証: Codex I14 指摘 — 無認証で WASM init を反復可能な公開 endpoint にしない。
// 既存の読み取り専用 route(app/api/exams/status/route.ts 等)と同型で
// withReadOnlyAuth を使う。 Clerk session 不在 → 401 JSON。
//
// 一時 route: T8(cleanup)で削除予定。route 名は private folder 規則
// (`_` prefix)を避けて routing から落ちないようにする(調査③の実測罠)。

import { PDFiumLibrary } from '@hyzyla/pdfium'
import { withReadOnlyAuth } from '@/lib/auth/with-read-only-auth'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

// 最小の 1 ページ PDF(%PDF-1.4・空 Resources・Contents なし)base64。正しい
// xref オフセットを持つ手組み PDF で、`@hyzyla/pdfium` の loadDocument→
// getPageCount()===1 を local 検証済み(task-1-report.md 参照)。
const MIN_PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8ID4+ID4+CmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMjAzCiUlRU9G'

export const GET = withReadOnlyAuth(
  {
    // Clerk session はあるが users 行が未 sync(sign-up race)。probe に user 行は
    // 不要だが、既存 read-only route と同型を保つため 200 + null pages を返す。
    emptyBody: { pages: null },
  },
  async (_user, headers) => {
    const buf = Buffer.from(MIN_PDF_BASE64, 'base64')
    let lib: Awaited<ReturnType<typeof PDFiumLibrary.init>> | undefined
    try {
      lib = await PDFiumLibrary.init()
      const doc = await lib.loadDocument(buf)
      try {
        const pages = doc.getPageCount()
        return Response.json({ pages }, { status: 200, headers })
      } finally {
        doc.destroy()
      }
    } catch (err) {
      logger.warn({ event: 'api.pdfprobe_pdfium.failed', err })
      return Response.json({ error: 'internal' }, { status: 500, headers })
    } finally {
      lib?.destroy()
    }
  },
)
