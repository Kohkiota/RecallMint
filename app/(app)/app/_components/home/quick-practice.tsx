// QuickPractice(W5)— さっと演習の 5 ボタン(定義 doc W5)。
//
// 母集合 0 は **非表示ではなく disable**(定義 doc W5 の明示要求)。ボタンに件数を
// 添えるのは、押す前に「何問あるか」が分かるようにするため — 押してから空セッションに
// 落ちる導線を作らない(W2 の実プール 0 と同じ方針)。
//
// 母集合の件数は `aggregateHomeCards` が `card-classification.ts` の述語で数えた値で、
// 実際の選定(`selectQuickPresetPopulation`)も同じ述語を使う。件数と出題内容の
// 定義が分岐しない(二重実装しない)。ten_min だけは母集合が W2 の出題プールそのもの
// なので `selectSessionPool` の pool 件数を受け取る。
//
// カスタムは母集合の定義を持たない(既存カスタム演習へ渡すだけ)ので常に有効。

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import type { QuickPreset } from '@/lib/cards/domain/quick-preset-selection'
import { WidgetCard } from '../widget-card'

interface QuickPracticeProps {
  examId: string
  mistakeCards: number
  unansweredCards: number
  weakCards: number
  /** 10分プリセットの母集合 = W2 の出題プール件数。 */
  tenMinCards: number
}

function PresetButton({
  examId,
  preset,
  label,
  count,
}: {
  examId: string
  preset: QuickPreset
  label: string
  count: number
}) {
  const content = (
    <>
      <span>{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </>
  )
  const className = 'h-auto flex-col gap-1 py-3'

  if (count === 0) {
    return (
      <Button variant="outline" className={className} disabled>
        {content}
      </Button>
    )
  }
  return (
    <Button asChild variant="outline" className={className}>
      <Link href={`/app/study/quick?exam=${examId}&preset=${preset}`} prefetch={false}>
        {content}
      </Link>
    </Button>
  )
}

export function QuickPractice({
  examId,
  mistakeCards,
  unansweredCards,
  weakCards,
  tenMinCards,
}: QuickPracticeProps): React.JSX.Element {
  return (
    <div id="quick-practice" className="scroll-mt-4">
      <WidgetCard
        header="さっと演習"
        metric={
          <span className="text-base font-normal text-muted-foreground">
            10 問前後で切り上げる短い演習
          </span>
        }
      >
        <div className="grid grid-cols-4 gap-2">
          <PresetButton
            examId={examId}
            preset="mistakes"
            label="間違い"
            count={mistakeCards}
          />
          <PresetButton
            examId={examId}
            preset="unanswered"
            label="未出題"
            count={unansweredCards}
          />
          <PresetButton examId={examId} preset="weak" label="苦手" count={weakCards} />
          <PresetButton
            examId={examId}
            preset="ten_min"
            label="10分"
            count={tenMinCards}
          />
        </div>
        <Button asChild variant="ghost" className="w-full">
          <Link href="/app/study/custom" prefetch={false}>
            カスタム
          </Link>
        </Button>
      </WidgetCard>
    </div>
  )
}
