// 表 (GFM table) の直下に空行があるかを判定する pure 関数。
// ②-0 OCR regression 基盤(T6 compare / runbook が「表直下空行が無い」既知欠陥の検知に使う)。
//
// segmentMdTables (lib/markdown/segment-md-tables.ts) を再利用する — 独自 markdown parser は
// 書かない。 table セグメントの直後の text セグメントが空行で始まるかを見る。 Markdown の
// blank line は「空白/タブのみの行」も空行として扱うため(OCR/モデル出力は空行に不可視の
// 末尾空白を残すことが多い)、改行 2 個の間に水平空白(スペース/タブ)のみを許容する
// (改行文字そのものは挟まない = 実コンテンツ行は blank line と誤認しない)。
// 直後に text セグメントが無い(表が最後・または GFM が後続の非空行を表セグメントに吸収した
// 結果 text セグメントごと消える場合)は hasBlankLineBelow: false。
//
// **限界**: segmentMdTables 自体が root 直下(depth 1)の GFM table しか検出しないため、
// blockquote / list に入れ子の表はここでも対象外(今 sprint の scope 外。呼び出し側/runbook
// が注記する)。
import { segmentMdTables } from '@/lib/markdown/segment-md-tables'

const STARTS_WITH_BLANK_LINE = /^\r?\n[ \t]*\r?\n/

export function analyzeTablesBlankLine(
  text: string,
): Array<{ tableIndex: number; hasBlankLineBelow: boolean }> {
  const segments = segmentMdTables(text)
  const results: Array<{ tableIndex: number; hasBlankLineBelow: boolean }> = []

  let tableIndex = 0
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment.type !== 'table') continue

    const next = segments[i + 1]
    const hasBlankLineBelow = next?.type === 'text' && STARTS_WITH_BLANK_LINE.test(next.value)
    results.push({ tableIndex, hasBlankLineBelow })
    tableIndex++
  }

  return results
}
