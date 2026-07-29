import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { stripInlineImages } from './strip-inline-images'

// 性質ベース: 除去後に image/imageReference ノード 0 件
function imageNodeCount(text: string): number {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text) as {
    type: string
    children?: unknown[]
  }
  let n = 0
  const walk = (node: { type: string; children?: unknown[] }) => {
    if (node.type === 'image' || node.type === 'imageReference') n++
    for (const c of (node.children ?? []) as { type: string; children?: unknown[] }[]) walk(c)
  }
  walk(tree)
  return n
}

describe('stripInlineImages', () => {
  it('段落途中の画像は構文のみ除去(周囲 text 保持・日本語隣接は空白足さない)', () => {
    expect(stripInlineImages('図a![下図](q1-img-1)この図')).toBe('図aこの図')
  })
  it('行唯一の画像は行ごと除去(orphaned 空行を残さない)', () => {
    expect(stripInlineImages('選べ。\n\n![下図](q1-img-1)\n続き')).toBe('選べ。\n\n続き')
  })
  it('nested paren / angle URL / title を除去', () => {
    expect(stripInlineImages('![a](foo(bar))')).toBe('')
    expect(stripInlineImages('![a](<foo bar>)')).toBe('')
    expect(stripInlineImages('![a](url "t")')).toBe('')
  })
  it('reference 記法 ![a][id] を除去(definition 行は MVP 範囲外で残る)', () => {
    const out = stripInlineImages('前![a][id]後\n\n[id]: http://x')
    expect(out).toContain('前後')
    expect(out).not.toContain('![a]')
  })
  it('code span 内は残す(正解選択肢を消さない)', () => {
    expect(stripInlineImages('`![a](x)`')).toBe('`![a](x)`')
  })
  it('code block 内は残す', () => {
    const src = '```\n![a](x)\n```'
    expect(stripInlineImages(src)).toBe(src)
  })
  it('escape された \\![a](x) は残す(image でなく link 扱い)', () => {
    expect(stripInlineImages('\\![a](x)')).toBe('\\![a](x)')
  })
  it('非画像 link は残す', () => {
    expect(stripInlineImages('[link](url)')).toBe('[link](url)')
  })
  it('画像なしは no-op', () => {
    expect(stripInlineImages('ただの文\n本文が続く')).toBe('ただの文\n本文が続く')
  })
  it('表セル内画像 → セル空・区切り | 温存(行/列不変)', () => {
    expect(stripInlineImages('| A | ![x](p) |')).toBe('| A |  |')
  })
  it('冪等: strip(strip(x)) === strip(x)', () => {
    for (const i of [
      '図![a](x)図',
      '選べ。\n\n![a](x)\n続き',
      '`![a](x)`',
      '| A | ![x](p) |',
    ]) {
      const once = stripInlineImages(i)
      expect(stripInlineImages(once)).toBe(once)
    }
  })
  it('性質: 除去後に image/imageReference ノード 0', () => {
    for (const i of [
      '図![a](x)',
      '![a](<f b>)',
      '| A | ![x](p) |',
      '前![a][id]後\n\n[id]: http://x',
    ]) {
      expect(imageNodeCount(stripInlineImages(i))).toBe(0)
    }
  })
})
