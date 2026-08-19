// TodayStudy(W2)— Home の主役であり唯一の primary CTA(定義 doc W2 / spec §4)。
//
// 本 component は数えない: y / n / m / k / 実プール件数 / nextAvailableAt は全て
// 上位(HomeDashboard)が `aggregateHomeCards` と `selectSessionPool` から得た値を
// prop で受け取る(Ruling 4 — 出題プールの返り値をここで再計算しない。表示と実出題が
// ずれる余地を作らない)。
//
// 状態は上から順に排他判定する:
//  ① 総カード 0        → 「この試験にはまだ問題がありません」+ 作成導線(spec §5)
//  ② 全カード未学習    → 「最初の◯問を解く」(◯ = min(QUICK_PRESET_N, k))。k=0 なら
//                        y も 0 になるので③へ自然に落ちる(K=0 と衝突させない・§5)
//  ③ y === 0           → 「いま解く対象はありません」。**完了とは主張しない**
//                        (y は毎回計算の「残り」で完了判定を定義していない)
//  ④ 実プール 0(y>0)→ CTA 無効 + 「次の復習は◯時頃」(§8.5 r2)。空セッションへ
//                        遷移させないため、この分岐では link を一切描画しない
//  ⑤ 通常             → 残り y 問・約◯分 + CTA + 内訳
//
// 「約◯分」は N(1 問あたり中央値)× y のカード数ベース近似。Learning/Relearning の
// 日内複数回答ぶん過小になりうるが「約」の範囲として受容する(定義 doc W2)。

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { QUICK_PRESET_N } from '@/lib/dashboard/domain/metric-constants'
import { WidgetCard } from '../widget-card'

interface TodayStudyProps {
  examId: string
  /** 選択試験の総カード数。 */
  totalCards: number
  /** 未学習(A)。 */
  newCards: number
  /** n = 復習(定義 doc W2)。 */
  n: number
  /** m = 持ち越し。n の内数。 */
  m: number
  /** k = 新規の残り枠(`selectSessionPool` の newCount)。 */
  k: number
  /** 実際に出題できるカードの件数(`selectSessionPool` の pool.length)。 */
  poolSize: number
  /** 未到来の Learning/Relearning の最小 due(該当なしは null)。 */
  nextAvailableAt: Date | null
  /** 1 問あたり所要の中央値(ms)。 */
  perCardMs: number
}

/** JST の「時」。Intl の locale 差に依存させず、repo の JST 規約(lib/jst.ts)に揃える。 */
function jstHour(at: Date): number {
  return new Date(at.getTime() + 9 * 3600 * 1000).getUTCHours()
}

/** 分に切り上げ・最小 1 分(§3.10)。 */
function estimatedMinutes(perCardMs: number, count: number): number {
  return Math.max(1, Math.ceil((perCardMs * count) / 60_000))
}

function smartHref(examId: string): string {
  return `/app/study/smart?exam=${examId}&origin=home_today`
}

/** metric slot 用の「◯ 問」。数字だけを大きく、単位は小さく muted に置く。 */
function Remaining({ value }: { value: number }) {
  return (
    <span data-testid="today-remaining" className="inline-flex items-baseline gap-1">
      <span className="text-5xl leading-none font-semibold tracking-tight">
        {value}
      </span>
      <span className="text-base font-normal text-muted-foreground">問</span>
    </span>
  )
}

export function TodayStudy({
  examId,
  totalCards,
  newCards,
  n,
  m,
  k,
  poolSize,
  nextAvailableAt,
  perCardMs,
}: TodayStudyProps): React.JSX.Element {
  const y = n + k

  // ① 総カード 0
  if (totalCards === 0) {
    return (
      <WidgetCard header="今日の学習" metric={<Remaining value={0} />}>
        <p className="text-sm text-muted-foreground">
          この試験にはまだ問題がありません。
        </p>
        <Button asChild size="lg" className="w-full">
          <Link href="/app/upload" prefetch={false}>
            画像や PDF から問題を作る
          </Link>
        </Button>
      </WidgetCard>
    )
  }

  // ② 全カード未学習 かつ 新規枠あり
  if (totalCards === newCards && k > 0) {
    const firstBatch = Math.min(QUICK_PRESET_N, k)
    return (
      <WidgetCard header="今日の学習" metric={<Remaining value={newCards} />}>
        <p className="text-sm text-muted-foreground">
          まだ 1 問も解いていません。教材の順に出題します。
        </p>
        <Button asChild size="lg" className="w-full">
          <Link href={smartHref(examId)} prefetch={false}>
            最初の {firstBatch} 問を解く
          </Link>
        </Button>
      </WidgetCard>
    )
  }

  // ③ 現在の対象なし
  if (y === 0) {
    return (
      <WidgetCard header="今日の学習" metric={<Remaining value={0} />}>
        <p className="text-sm text-muted-foreground">いま解く対象はありません。</p>
        <Button asChild variant="outline" size="lg" className="w-full">
          <Link href="#quick-practice">さっと演習を選ぶ</Link>
        </Button>
      </WidgetCard>
    )
  }

  // ④ 実プール 0(y > 0)。link を描画しない = 空セッションへ遷移しない。
  if (poolSize === 0) {
    return (
      <WidgetCard header="今日の学習" metric={<Remaining value={y} />}>
        <p className="text-sm text-muted-foreground">
          {nextAvailableAt === null
            ? 'いま出題できる問題はありません。'
            : `いま出題できる問題はありません。次の復習は ${jstHour(nextAvailableAt)} 時頃です。`}
        </p>
        <Button size="lg" className="w-full" disabled>
          学習を始める
        </Button>
      </WidgetCard>
    )
  }

  // ⑤ 通常
  return (
    <WidgetCard header="今日の学習" metric={<Remaining value={y} />}>
      <p className="text-sm text-muted-foreground">
        約 {estimatedMinutes(perCardMs, y)} 分
      </p>
      <Button asChild size="lg" className="w-full">
        <Link href={smartHref(examId)} prefetch={false}>
          学習を始める
        </Link>
      </Button>
      <div
        data-testid="today-breakdown"
        className="space-y-1 border-t border-border pt-3 text-sm"
      >
        <p className="tabular-nums">
          復習 {n}
          <span className="text-muted-foreground">（持ち越し {m}）</span>
          <span className="mx-2 text-border">/</span>
          新規 {k}
        </p>
        <p className="text-xs text-muted-foreground">
          新規は残り枠です。1 回のセッションで全部は出ません。
        </p>
      </div>
    </WidgetCard>
  )
}
