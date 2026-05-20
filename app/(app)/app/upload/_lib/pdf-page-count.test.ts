import { describe, it, expect } from 'vitest'
import { pdfPageCount } from './pdf-page-count'

// Minimal PDF binary builder for unit testing. We construct strings that
// contain `/Type /Page` markers and feed them as File objects.
function fakePdf(content: string): File {
  return new File([content], 'test.pdf', { type: 'application/pdf' })
}

describe('pdfPageCount', () => {
  it('returns 0 for a PDF with no Page objects', async () => {
    const pdf = fakePdf('%PDF-1.4\n/Type /Catalog\n')
    expect(await pdfPageCount(pdf)).toBe(0)
  })

  it('counts a single /Type /Page', async () => {
    const pdf = fakePdf('%PDF-1.4\n/Type /Page\n/Contents 1 0 R\n')
    expect(await pdfPageCount(pdf)).toBe(1)
  })

  it('does NOT count /Type /Pages (page tree root)', async () => {
    const pdf = fakePdf('%PDF-1.4\n/Type /Pages\n/Count 5\n/Type /Page\n')
    expect(await pdfPageCount(pdf)).toBe(1)
  })

  it('counts multiple page objects', async () => {
    const pdf = fakePdf(
      '%PDF-1.4\n/Type /Pages\n/Type /Page\n/Type /Page\n/Type /Page\n',
    )
    expect(await pdfPageCount(pdf)).toBe(3)
  })

  it('tolerates whitespace between /Type and /Page', async () => {
    const pdf = fakePdf(
      '%PDF-1.4\n/Type\n/Page\n/Type  /Page\n/Type\t/Page\n',
    )
    expect(await pdfPageCount(pdf)).toBe(3)
  })

  it('does NOT count /Type /PageTreeNode', async () => {
    // PageTreeNode 等 (`/Page` で始まり後続文字あり) は除外
    const pdf = fakePdf('%PDF-1.4\n/Type /PageTreeNode\n/Type /Page\n')
    expect(await pdfPageCount(pdf)).toBe(1)
  })
})
