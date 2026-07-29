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
// - components.img は null(②-3: 本文に画像記法が現れない契約の描画側強制で <img> も alt も
//   出さない。通常は MdTableSegments の stripInlineImages で画像ノード除去済・これは防御)。
// - components.a 無効(children のみ描画・<a> を出さない = display 全体クリック編集と競合防止)。
// - singleTilde: false(セル内 ~x~ を打消し線にしない・GFM 準拠)。
// - rehype-raw 不使用ゆえセル内 raw HTML は要素化されない。

import * as React from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PluggableList } from 'unified'

import { segmentMdTables, type MdSegment } from '@/lib/markdown/segment-md-tables'
import { stripInlineImages } from '@/lib/markdown/strip-inline-images'

const REMARK_PLUGINS: PluggableList = [[remarkGfm, { singleTilde: false }]]

// 表 CSS(spec §3.5): 縦に伸びる・行数で切らない・省略記号なし・横スクロールなし・
// width 固定なし(shrink-to-fit)。セルに overflow-wrap:anywhere で min-content 寄与を潰し、
// テーブルビュー(table-layout auto)で外側列を押し広げない。
const COMPONENTS: Components = {
  // ②-3: inline 画像記法は本文に現れない契約(target 単位で images[] に紐づける確定設計の
  // 描画側強制)。旧挙動は alt を出したが、alt も出さず非表示にする。通常は MdTableSegments の
  // stripInlineImages で画像ノードが除去済ゆえここへ到達しないが、すり抜け時の防御として null。
  img: () => null,
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

// ②-3: card body の描画経路は inline 画像記法(![…](…) / 参照記法 ![x][id])を除去してから
// segment する。**complete document で strip**するため reference 記法の definition([id]: url)が
// 別行にあっても解決される(Codex r1)。strip 後の segments を hasTable 判定(<p>/<div>)と描画の
// 両方に使うため、wrapper 判定と render が常に一致する(画像除去で表構造が変わっても不整合しない・
// Codex r2)。画像なしは stripInlineImages が同一 string を返し segmentMdTables(value) と等価
// = DOM 不変(不変条件①)。
function segmentStrippedForRender(value: string): MdSegment[] {
  return segmentMdTables(stripInlineImages(value))
}

// 低レベル: 事前計算済みの(呼び出し側で strip 済)segments をそのまま描画する。二重パース回避・
// spec §3.3。画像除去は segmentStrippedForRender が担うため、ここは受け取った segments を素直に
// 描画する。**module 内部限定(非 export)**: 画像除去の不変条件は segmentStrippedForRender に
// 移ったため、直接 raw segments を渡す経路を外に開かない(外部は MdTableText / MdTableBlock を使う)。
function MdTableSegments({ segments }: { segments: MdSegment[] }) {
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
  const segments = React.useMemo(() => segmentStrippedForRender(value), [value])
  return <MdTableSegments segments={segments} />
}

// ブロック級 wrapper が <p> の call site 用(学習面 C/E・spec §3.3)。表を含む値では
// <p> を <div> に切替える(<p> 内 <table> は HTML パーサが <p> を auto-close して
// hydration を壊すため)。表 0 個は <p> 維持で DOM 同一(不変条件①)。segmentMdTables を
// 1 回だけ呼び tag 判定と描画で共有(二重パース回避)。className は call site の <p> と同一を渡す。
export function MdTableBlock({
  value,
  className,
}: {
  value: string
  className?: string
}) {
  const segments = React.useMemo(() => segmentStrippedForRender(value), [value])
  const hasTable = segments.some((s) => s.type === 'table')
  const Tag = hasTable ? 'div' : 'p'
  return (
    <Tag className={className}>
      <MdTableSegments segments={segments} />
    </Tag>
  )
}
