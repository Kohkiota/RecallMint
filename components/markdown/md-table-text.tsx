'use client'

// MdTableText — MD 表を read-only で <table> 描画する共有 renderer(Sprint T T3・spec §3.3)。
// 5 site(編集 A/B・学習 C/D/E)から import される 1 個の renderer。
//
// 設計の核(spec §3.1-3.3):
// - text セグメント = 素の text node(span 等を足さない)。各 call site の wrapper・class・
//   末尾改行 <br> 補償は call site に温存されるため、表 0 個入力では renderer 出力が text
//   node 1 個となり DOM が現状と同一(不変条件①)。
// - table セグメント = react-markdown。切り出しが表だけゆえフル MD で描いても表しか出ない。
//
// react-markdown 設定(spec §3.4・全体ルール4):
// - components.img 無効(alt テキストのみ描画・<img> を出さない = assetId 間接参照の迂回と
//   CSP img-src 違反を防ぐ。外部リクエスト 0 = 不変条件③)。
// - components.a 無効(children のみ描画・<a> を出さない = display 全体クリック編集と競合防止)。
// - singleTilde: false(セル内 ~x~ を打消し線にしない・GFM 準拠)。
// - rehype-raw 不使用ゆえセル内 raw HTML は要素化されない。

import * as React from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PluggableList } from 'unified'

import { segmentMdTables, type MdSegment } from '@/lib/markdown/segment-md-tables'

const REMARK_PLUGINS: PluggableList = [[remarkGfm, { singleTilde: false }]]

// 表 CSS(spec §3.5): 縦に伸びる・行数で切らない・省略記号なし・横スクロールなし・
// width 固定なし(shrink-to-fit)。セルに overflow-wrap:anywhere で min-content 寄与を潰し、
// テーブルビュー(table-layout auto)で外側列を押し広げない。
const COMPONENTS: Components = {
  // img: alt のみ(黙って消さず alt を出す)。src は DOM に到達しない。
  img: ({ alt }) => <>{alt ?? ''}</>,
  // a: children(リンク文字列)のみ。href は DOM に到達しない。
  a: ({ children }) => <>{children}</>,
  table: ({ children }) => (
    <table className="my-1 border-collapse text-sm">{children}</table>
  ),
  th: ({ children }) => (
    <th className="border border-slate-300 px-2 py-1 text-left align-top font-semibold [overflow-wrap:anywhere]">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-slate-300 px-2 py-1 align-top [overflow-wrap:anywhere]">
      {children}
    </td>
  ),
}

// 低レベル: 事前計算済みの segments を描画する。C/E(学習面)が segmentMdTables を 1 回だけ
// 呼び、tag 判定(p/div)と描画で結果を共有するために export(二重パース回避・spec §3.3)。
export function MdTableSegments({ segments }: { segments: MdSegment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          // 素の text node。key 付き Fragment は wrapper 要素を作らない。
          <React.Fragment key={i}>{seg.value}</React.Fragment>
        ) : (
          <Markdown key={i} remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
            {seg.value}
          </Markdown>
        ),
      )}
    </>
  )
}

export function MdTableText({ value }: { value: string }) {
  const segments = React.useMemo(() => segmentMdTables(value), [value])
  return <MdTableSegments segments={segments} />
}
