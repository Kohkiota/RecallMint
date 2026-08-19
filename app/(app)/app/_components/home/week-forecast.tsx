// WeekForecast(W6)— 今後 7 日の due 件数(定義 doc W6)。
//
// 集計(今日のバー = 持ち越し合算・New 除外)は `aggregateHomeCards` が済ませて
// あり、ここは描画だけを担う。
//
// 色に依存しない(Task 10 §11.4 / spec §12): 塗り同士の輝度比が小さいので、持ち越しの
// 区別は ①バー内の**分割位置**(下段が持ち越し)②斜線パターン ③「うち持ち越し ◯」の
// テキストの 3 つで冗長に表す。色は補助にすぎない。各バーには日付と件数の
// aria-label を付け、バーの高さを読まなくても値が取れるようにする。

import { addDays } from '@/lib/streak-core'
import { todayInJst } from '@/lib/jst'
import { WidgetCard } from '../widget-card'

interface WeekForecastProps {
  /** index 0 = 今日の 7 要素(`aggregateHomeCards` の forecast)。 */
  forecast: number[]
  /** 今日のバーに合算されている持ち越し件数。 */
  carryover: number
  now: Date
}

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const

/** 'YYYY-MM-DD' を UTC 深夜としてパースする既存慣例(streak-core.addDays と同じ)。 */
function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`)
}

export function WeekForecast({
  forecast,
  carryover,
  now,
}: WeekForecastProps): React.JSX.Element {
  const today = todayInJst(now)
  const max = Math.max(...forecast, 1)

  return (
    <WidgetCard
      header="今後 7 日"
      metric={
        <span className="inline-flex items-baseline gap-1">
          {forecast.reduce((a, b) => a + b, 0)}
          <span className="text-base font-normal text-muted-foreground">問</span>
        </span>
      }
    >
      <div data-testid="forecast-widget" className="space-y-2">
        <ul className="flex items-end justify-between gap-1.5">
          {forecast.map((count, i) => {
            const day = addDays(today, i)
            const parsed = parseDay(day)
            const weekday = WEEKDAY_LABELS[parsed.getUTCDay()]
            const carried = i === 0 ? Math.min(carryover, count) : 0
            const heightPct = (count / max) * 100
            const carriedPct = count === 0 ? 0 : (carried / count) * 100

            return (
              <li
                key={day}
                data-testid="forecast-bar"
                className="flex min-w-0 flex-1 flex-col items-center gap-1"
              >
                <span className="text-xs tabular-nums">{count}</span>
                <div
                  className="flex h-16 w-full flex-col justify-end overflow-hidden rounded-sm bg-muted/50"
                  aria-label={`${parsed.getUTCMonth() + 1}月${parsed.getUTCDate()}日（${weekday}） ${count} 件`}
                >
                  <div
                    className="flex w-full flex-col justify-end"
                    style={{ height: `${heightPct}%` }}
                  >
                    <div className="w-full flex-1 bg-chart-3" />
                    {carried > 0 ? (
                      <div
                        data-testid="forecast-carryover-segment"
                        className="w-full bg-carryover"
                        style={{
                          height: `${carriedPct}%`,
                          // 斜線: 色覚特性でも分割が読めるよう塗り分けにパターンを重ねる。
                          backgroundImage:
                            'repeating-linear-gradient(45deg, rgba(255,255,255,0.55) 0 2px, transparent 2px 5px)',
                        }}
                      />
                    ) : null}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">
                  {i === 0 ? '今日' : weekday}
                </span>
              </li>
            )
          })}
        </ul>
        {carryover > 0 ? (
          <p className="text-xs text-muted-foreground">
            今日のバーには持ち越しを合算しています（うち持ち越し {carryover} 件）。
          </p>
        ) : null}
      </div>
    </WidgetCard>
  )
}
