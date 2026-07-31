import { describe, it, expect } from 'vitest'
import { buildSourceIdInterleavedParts, type SourceIdImage } from './ocr-image-crop-parts'

function img(sourceId: string, data: string): SourceIdImage {
  return { sourceId, file: { mimeType: 'image/png', data } }
}

describe('buildSourceIdInterleavedParts', () => {
  it('1 画像: [text(source_id=X), image, text(prompt)] の順で返す', () => {
    const parts = buildSourceIdInterleavedParts([img('img1', 'AAA')], 'PROMPT')
    expect(parts).toEqual([
      { text: 'source_id=img1' },
      { inlineData: { mimeType: 'image/png', data: 'AAA' } },
      { text: 'PROMPT' },
    ])
  })

  it('N=3 画像: 各画像の直前に正しい source_id ラベルが interleave される (順序を厳密比較)', () => {
    const sources = [img('img1', 'AAA'), img('img2', 'BBB'), img('img3', 'CCC')]
    const parts = buildSourceIdInterleavedParts(sources, 'PROMPT')
    expect(parts).toEqual([
      { text: 'source_id=img1' },
      { inlineData: { mimeType: 'image/png', data: 'AAA' } },
      { text: 'source_id=img2' },
      { inlineData: { mimeType: 'image/png', data: 'BBB' } },
      { text: 'source_id=img3' },
      { inlineData: { mimeType: 'image/png', data: 'CCC' } },
      { text: 'PROMPT' },
    ])
  })

  it('各画像は自分の source_id ラベル (index 一致) の直後に来る — 誤対応が無いことを個別に検証', () => {
    const sources = [img('a-id', 'X1'), img('b-id', 'X2')]
    const parts = buildSourceIdInterleavedParts(sources, 'P')
    sources.forEach((s, i) => {
      const labelIdx = i * 2
      const imageIdx = i * 2 + 1
      expect(parts[labelIdx]).toEqual({ text: `source_id=${s.sourceId}` })
      expect(parts[imageIdx]).toEqual({
        inlineData: { mimeType: s.file.mimeType, data: s.file.data },
      })
    })
  })

  it('末尾は必ず prompt の text part のみ (画像の後に置かれる)', () => {
    const parts = buildSourceIdInterleavedParts(
      [img('img1', 'AAA'), img('img2', 'BBB')],
      'FINAL_PROMPT',
    )
    expect(parts[parts.length - 1]).toEqual({ text: 'FINAL_PROMPT' })
  })

  it('sources が空でも prompt だけの 1 要素配列を返す (縮退)', () => {
    const parts = buildSourceIdInterleavedParts([], 'ONLY_PROMPT')
    expect(parts).toEqual([{ text: 'ONLY_PROMPT' }])
  })

  it('返す配列長は 2N + 1 (N = source 数)', () => {
    const sources = [img('img1', 'A'), img('img2', 'B'), img('img3', 'C'), img('img4', 'D')]
    const parts = buildSourceIdInterleavedParts(sources, 'P')
    expect(parts).toHaveLength(sources.length * 2 + 1)
  })
})
