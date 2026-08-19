// WeekActivity(W7)— 今週(定義 doc §4-Q / §4-O / §4-R)。
//
// 値は全て `study_days` mirror(user 全体 = 全試験)由来なので、見出しに「全試験」を
// 明記する(OT 裁定 2)。選択試験のカードから作る他ウィジェットと母集合が違うことを
// 画面上で区別できないと数字が矛盾して見えるため、これは装飾ではなく必須表示。
//
// delta を v1 で出す判断(spec §4 / §16-2 の実装時判断): 「先週同期間比」だけでは
// 何と比べたか読めないため、ラベルに **「昨日まで」** を添えて期間の切り方まで
// 1 行で説明する(定義 doc §4-Q: 進行中の今日を含めると比較が常に不利に歪むので
// 完了した日だけを同じ日数で比べる)。説明できたので落とさない。
//
// delta の色分けはしない: 符号が主(§3.10)で、--success / --warn は輝度がほぼ同じで
// 色相だけでは区別できない(Task 10 §11.4)。加えて「今週少ない = 失敗」という含意を
// 色で押し付けない。

import { formatStreakDisplay } from '@/lib/client/streak'
import { WidgetCard } from '../widget-card'

interface WeekActivityProps {
  /** 今週(月曜〜今日)の回答数。 */
  answers: number
  /** 今週の学習日数。 */
  studyDays: number
  /** 先週同期間比。null なら出さない。 */
  delta: number | null
  /** 連続日数(61 で頭打ち)。 */
  streak: number
  /** 今日の学習量(distinct card 数・定義 doc §4-R)。 */
  todayCardCount: number
}

/** 符号付き整数(§3.10)。0 は ±0。 */
function formatDelta(delta: number): string {
  if (delta === 0) return '±0'
  return delta > 0 ? `+${delta}` : `${delta}`
}

function Stat({
  testId,
  label,
  children,
}: {
  testId: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div data-testid={testId} className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg leading-none font-medium tabular-nums">
        {children}
      </span>
    </div>
  )
}

export function WeekActivity({
  answers,
  studyDays,
  delta,
  streak,
  todayCardCount,
}: WeekActivityProps): React.JSX.Element {
  return (
    <WidgetCard
      header="今週（全試験）"
      metric={
        <span data-testid="week-answers" className="inline-flex items-baseline gap-1">
          {answers}
          <span className="text-base font-normal text-muted-foreground">問</span>
        </span>
      }
      delta={
        delta === null ? undefined : (
          <span data-testid="week-delta" className="text-muted-foreground">
            先週同期間比（昨日まで）
            <span className="ml-1 font-medium tabular-nums text-foreground">
              {formatDelta(delta)}
            </span>
          </span>
        )
      }
    >
      <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
        <Stat testId="week-study-days" label="学習日数">
          {studyDays} 日
        </Stat>
        <Stat testId="week-streak" label="連続">
          {formatStreakDisplay(streak)}
        </Stat>
        <Stat testId="week-today" label="今日">
          {todayCardCount} 問
        </Stat>
      </div>
    </WidgetCard>
  )
}
