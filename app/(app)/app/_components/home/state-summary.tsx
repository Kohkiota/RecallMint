// StateSummary(W3)— 3 状態 + 別段の横断指標(定義 doc W3・OT 裁定 3)。
//
// 構造が仕様そのもの: 未学習 / 学習中 / 定着 は MECE な 1 つの尺度なので同じ行に
// 並べ、その下に定着度スケール(--maturity-1..3)の比率バーを 1 本だけ敷く。
// 「復習の持ち越し」はこの尺度と直交する横断指標なので、罫線で切った**別段**に
// 置く(同列 4 カウンタにしない)。token の軸分離(spec §12)を配置でも守る。
//
// 持ち越しの色は --carryover。塗りの上に文字を載せない(Task 10 §11.4 — foreground
// 対が定義されていない)ため、色は 3px の縦罫と小さな見出し前のドットだけに使い、
// 件数は通常の文字色で書く。

import Link from 'next/link'
import { WidgetCard } from '../widget-card'

interface StateSummaryProps {
  examId: string
  newCards: number
  learningCards: number
  matureCards: number
  carryover: number
}

function Counter({
  label,
  value,
  swatchClassName,
}: {
  label: string
  value: number
  swatchClassName: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={`size-2 rounded-full ${swatchClassName}`} aria-hidden="true" />
        {label}
      </span>
      <span className="text-2xl leading-none font-semibold tabular-nums">{value}</span>
    </div>
  )
}

export function StateSummary({
  examId,
  newCards,
  learningCards,
  matureCards,
  carryover,
}: StateSummaryProps): React.JSX.Element {
  const total = newCards + learningCards + matureCards
  const pct = (v: number) => (total === 0 ? 0 : (v / total) * 100)

  return (
    <WidgetCard
      header="カードの状態"
      metric={
        <span className="inline-flex items-baseline gap-1">
          {total}
          <span className="text-base font-normal text-muted-foreground">問</span>
        </span>
      }
    >
      <div data-testid="state-counters" className="grid grid-cols-3 gap-2">
        <Counter label="未学習" value={newCards} swatchClassName="bg-maturity-1" />
        <Counter label="学習中" value={learningCards} swatchClassName="bg-maturity-2" />
        <Counter label="定着" value={matureCards} swatchClassName="bg-maturity-3" />
      </div>

      {/* 3 区分の比率。順序尺度なので L 降順 + C 昇順の二重符号(Task 10 §11.3)が
          そのまま並びの意味になる。数値は上のカウンタが担うので装飾側に文字は置かない。 */}
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="bg-maturity-1" style={{ width: `${pct(newCards)}%` }} />
        <div className="bg-maturity-2" style={{ width: `${pct(learningCards)}%` }} />
        <div className="bg-maturity-3" style={{ width: `${pct(matureCards)}%` }} />
      </div>

      {carryover > 0 ? (
        <div
          data-testid="state-carryover"
          className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm"
        >
          <span className="flex items-center gap-2">
            <span className="h-4 w-1 rounded-full bg-carryover" aria-hidden="true" />
            持ち越し {carryover} 件
          </span>
          <Link
            href={`/app/study/smart?exam=${examId}&origin=home_today`}
            prefetch={false}
            className="underline underline-offset-4"
          >
            まとめて復習
          </Link>
        </div>
      ) : null}
    </WidgetCard>
  )
}
