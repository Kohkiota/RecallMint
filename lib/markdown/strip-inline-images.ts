// 本文の markdown 画像記法(image / imageReference)を除去する pure 関数(②-3)。
// AST(mdast)でノードの position offset を取り、元文字列から後ろ向きに該当範囲だけ
// 削除する。AST を再文字列化しない(空白/改行/表整形を壊さない = 「改行 \n 保持」
// prompt ルール + segmentMdTables 不変条件と両立)。regex 字面除去は code span/block/
// escape/nested paren/reference を誤るため使わない。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false })

type MdNode = {
  type: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MdNode[]
}

function collectImageRanges(node: MdNode, out: Array<{ start: number; end: number }>): void {
  if (node.type === 'image' || node.type === 'imageReference') {
    const s = node.position?.start.offset
    const e = node.position?.end.offset
    if (typeof s === 'number' && typeof e === 'number' && e > s) out.push({ start: s, end: e })
  }
  for (const c of node.children ?? []) collectImageRanges(c, out)
}

// 画像ノード [start,end) を削除範囲へ拡張。行唯一(前後が空白のみ)なら行 + 末尾改行 1 個
// まで飲む(orphaned 空行を残さない)。それ以外(段落途中 / 表セル内)は構文のみ。
function expandRange(text: string, start: number, end: number): { from: number; to: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  let lineEnd = text.indexOf('\n', end)
  if (lineEnd === -1) lineEnd = text.length
  const lineSole =
    text.slice(lineStart, start).trim() === '' && text.slice(end, lineEnd).trim() === ''
  if (!lineSole) return { from: start, to: end }
  return { from: lineStart, to: lineEnd < text.length ? lineEnd + 1 : lineEnd }
}

export function stripInlineImages(text: string): string {
  if (!text.includes('![')) return text // fast path: 画像マーカー無しは parse しない
  const tree = processor.parse(text) as unknown as MdNode
  const raw: Array<{ start: number; end: number }> = []
  collectImageRanges(tree, raw)
  if (raw.length === 0) return text
  const expanded = raw
    .map((r) => expandRange(text, r.start, r.end))
    .sort((a, b) => b.from - a.from)
  let out = text
  let lastFrom = Infinity
  for (const { from, to } of expanded) {
    const clampedTo = Math.min(to, lastFrom) // 同一行複数画像等の重複を回避
    if (from >= clampedTo) continue
    out = out.slice(0, from) + out.slice(clampedTo)
    lastFrom = from
  }
  return out
}
