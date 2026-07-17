// MD 文字列を [text][table][text]… のセグメント列に分割する pure 関数(Sprint T・spec §3.2)。
//
// 核(spec §3.1): パーサは全機能(CommonMark + GFM)で走らせ、結果のうち **root 直下の
// table ノードの位置(offset)だけ**を使う。残りの解釈は捨てる。table セグメントは
// react-markdown に、text セグメントは各 call site の現行 renderer に渡される。
//
// 不変条件(spec §4): segments の value 連結 === 入力(string 完全一致)。mdast の
// position.offset は UTF-16 code unit(JS string index)ゆえ、我々は返り値で String.slice
// するだけで byte でなく string として厳密一致する。

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

export type MdSegment = { type: 'text' | 'table'; value: string }

// remark-gfm は 5 機能一括。singleTilde: false は GFM 仕様準拠(単一チルダを打消し線に
// しない)。ここでは table ノードの位置のみ使うため他機能の解釈結果は参照しない。
const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false })

// parse 結果から必要な構造だけを読む最小型(@types/mdast は transitive のため直接依存
// しない)。root.children を走査し、type==='table' の position offset のみ使う。
type MdNode = {
  type: string
  position?: { start: { offset?: number }; end: { offset?: number } }
}
type MdRoot = { children?: MdNode[] }

// root 直下(depth 1)の table ノードの [start, end) offset を document 順で返す。
// blockquote / list 内の table は root.children でなく container の子ゆえ自然に除外される。
function rootTableRanges(text: string): Array<{ start: number; end: number }> {
  const tree = processor.parse(text) as unknown as MdRoot
  const ranges: Array<{ start: number; end: number }> = []
  for (const node of tree.children ?? []) {
    if (node.type !== 'table') continue
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (typeof start === 'number' && typeof end === 'number') {
      ranges.push({ start, end })
    }
  }
  return ranges
}

export function segmentMdTables(text: string): MdSegment[] {
  const ranges = rootTableRanges(text)
  // 表 0 個 → 入力そのものを 1 text セグメントに(空文字含む・現状描画と同一)。
  if (ranges.length === 0) {
    return [{ type: 'text', value: text }]
  }

  const segments: MdSegment[] = []
  let cursor = 0
  for (const { start, end } of ranges) {
    // 表の前の text。先頭の表では空になるため落とす(真に連続する 2 表は GFM 上 blank 行
    // 区切りが必須 = 間の text は "\n\n" で非空ゆえ、この空スキップは先頭表のみに効く)。
    if (start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, start) })
    }
    segments.push({ type: 'table', value: text.slice(start, end) })
    cursor = end
  }
  // 末尾の text(表が末尾で終わる時は空になるため落とす)。
  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) })
  }
  return segments
}
