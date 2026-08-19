'use client'

// HomeDashboard — Home(/app)の client root(spec §3.1)。
//
// この root だけが持つ責務:
// 1. **評価時刻を 1 回だけ取る**(§3.9)。ウィジェットごとに `new Date()` を呼ぶと、
//    JST 00:00 / due 到来 / 週境界の瞬間に W2・W3・W6 の数字が互いに矛盾する。
// 2. **1 read + 1 pass の共有集計**(§3.1)。cards を読むウィジェット(W2/W3/W5/W6)は
//    個別に Dexie を走査せず、ここで読んだ 1 つの配列を `aggregateHomeCards` に
//    通した結果を prop で受け取る。
// 3. **前段の制御状態と空状態の出し分け**(§5)。
//
// cards query を owner scope(選択試験ではなく user 全体)で引く理由: §3.1 の
// 「他の試験: 復習 n 件」は選択試験の外を数える行なので、選択試験だけを読む query
// では出せない。owner scope の 1 read で両方を賄うほうが「選択試験 + 他試験」の
// 2 read より安い(集計も同じ 1 pass で振り分ける)。試験切替では read をやり直さず
// 集計だけを回し直す。
//
// 出題プール(k / 実プール / nextAvailableAt)は `selectSessionPool` の返り値を
// そのまま配る(Ruling 4 — ここで数え直さない。表示と実出題がずれる余地を作らない)。

import { useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLiveQuery } from 'dexie-react-hooks'
import { Button } from '@/components/ui/button'
import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { getStreakStatsFromDexie } from '@/lib/client/streak'
import { getRecentElapsedMsSamples } from '@/lib/cards/get-quick-preset-cards'
import { selectSessionPool } from '@/lib/cards/domain/session-pool'
import { tenMinCount } from '@/lib/cards/domain/quick-preset-selection'
import { aggregateHomeCards } from '@/lib/dashboard/domain/home-aggregate'
import { estimateMedianMs } from '@/lib/dashboard/domain/estimate'
import { weeklySummary } from '@/lib/dashboard/domain/weekly'
import { buildExamUrl, useSelectedExam } from '@/lib/dashboard/use-selected-exam'
import { useOwnerExams } from '../use-owner-exams'
import { HomeHeader } from './home-header'
import { TodayStudy } from './today-study'
import { StateSummary } from './state-summary'
import { WeakTags } from './weak-tags'
import { QuickPractice } from './quick-practice'
import { WeekForecast } from './week-forecast'
import { WeekActivity } from './week-activity'

function HomeSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="読み込み中" className="space-y-3">
      <div className="h-8 w-40 animate-pulse rounded bg-muted" />
      <div className="h-44 w-full animate-pulse rounded-xl bg-muted" />
      <div className="h-28 w-full animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

/** §5「試験 0」— ウィジェットを描画せず作成導線だけを出す。 */
function NoExamsHero() {
  return (
    <div className="space-y-4 py-8 text-center">
      <h1 className="font-heading text-2xl font-bold">問題集を作るところから</h1>
      <p className="text-sm text-muted-foreground">
        手持ちの画像や PDF を読み込むと、選択式の問題に変換します。
      </p>
      <Button asChild size="lg">
        <Link href="/app/upload" prefetch={false}>
          画像や PDF から問題集を作る
        </Link>
      </Button>
    </div>
  )
}

/** §5 前段②「試験未選択」— 解決できないときは選択 UI だけを出す(spec §6)。 */
function ExamPicker({
  exams,
  onSelectExam,
}: {
  exams: readonly ClientExam[]
  onSelectExam: (examId: string) => void
}) {
  return (
    <div className="space-y-3">
      <h1 className="font-heading text-2xl font-bold">学習する試験を選んでください</h1>
      <ul className="space-y-2">
        {exams.map((e) => (
          <li key={e.id}>
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => onSelectExam(e.id)}
            >
              {e.name}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function HomeDashboard({
  userId,
  urlExamId,
  now: nowProp,
}: {
  userId: string
  /** RSC が searchParams から抽出した `exam`(billing と同型の受け渡し)。 */
  urlExamId: string | undefined
  /** test 注入用。production では mount 時に 1 回だけ確定する。 */
  now?: Date
}): React.JSX.Element {
  // mount 時に 1 回だけ確定させる(§3.9)。日跨ぎは再訪で更新する既存受容。
  const now = useMemo(() => nowProp ?? new Date(), [nowProp])
  const { exams, examIds } = useOwnerExams(userId)

  if (exams === undefined || examIds === undefined) return <HomeSkeleton />
  if (exams.length === 0) return <NoExamsHero />
  return (
    <ResolvedHome
      userId={userId}
      urlExamId={urlExamId}
      now={now}
      exams={exams}
      examIds={examIds}
    />
  )
}

function ResolvedHome({
  userId,
  urlExamId,
  now,
  exams,
  examIds,
}: {
  userId: string
  urlExamId: string | undefined
  now: Date
  exams: ClientExam[]
  examIds: string[]
}) {
  const router = useRouter()
  const resolution = useSelectedExam({ userId, urlExamId, examIds })

  // 明示切替も resolver と同じ URL 生成を通す(spec §6: 他 query param を保持する)。
  const selectExam = useCallback(
    (examId: string) => {
      const url = buildExamUrl(examId)
      if (url) router.replace(url)
    },
    [router],
  )

  const cards = useLiveQuery(
    async () => getClientDb().cards.where('user_id').equals(userId).toArray(),
    [userId],
  )
  // study_days は 90 日 mirror(最大 90 行)。同じ table を 2 度読んでいるのは、
  // streak の window 規則(61 日)を `lib/client/streak.ts` の 1 定義に残したまま
  // 週集計用の生の行も要るため — 行数が小さいのでコピーを作るより安い。
  const activity = useLiveQuery(async () => {
    const rows = await getClientDb().study_days.where('user_id').equals(userId).toArray()
    const streakStats = await getStreakStatsFromDexie(userId, now)
    return { rows, ...streakStats }
  }, [userId, now])
  // N の標本は user 全体スコープ(定義 doc §4-N)なので試験切替で取り直さない。
  const samples = useLiveQuery(async () => getRecentElapsedMsSamples(userId), [userId])

  const examId = resolution?.outcome === 'resolved' ? resolution.examId : undefined

  if (resolution === undefined) return <HomeSkeleton />
  if (examId === undefined) return <ExamPicker exams={exams} onSelectExam={selectExam} />
  if (cards === undefined || activity === undefined) return <HomeSkeleton />

  return (
    <HomeWidgets
      userId={userId}
      examId={examId}
      exams={exams}
      cards={cards}
      activity={activity}
      samples={samples}
      now={now}
      onSelectExam={selectExam}
    />
  )
}

function HomeWidgets({
  userId,
  examId,
  exams,
  cards,
  activity,
  samples,
  now,
  onSelectExam,
}: {
  userId: string
  examId: string
  exams: ClientExam[]
  cards: ClientCard[]
  activity: { rows: { day: string; review_count: number }[]; streak: number; todayCardCount: number }
  samples: (number | undefined)[] | undefined
  now: Date
  onSelectExam: (examId: string) => void
}) {
  const dailyNewTarget = exams.find((e) => e.id === examId)?.daily_new_target ?? null

  const agg = useMemo(
    () => aggregateHomeCards({ cards, examId, now }),
    [cards, examId, now],
  )
  const pool = useMemo(
    () => selectSessionPool({ cards, examId, dailyNewTarget, now }),
    [cards, examId, dailyNewTarget, now],
  )
  const week = useMemo(() => weeklySummary(activity.rows, now), [activity.rows, now])
  // 有効標本 0 でも既定値 20s/問で出す(定義 doc §4-N: この指標は非表示にしない)。
  // 読込中の `undefined` も同じ既定値に落ちる。
  const perCardMs = estimateMedianMs(samples ?? [])

  const hasCards = agg.totalCards > 0

  return (
    <div className="space-y-4">
      <HomeHeader
        exams={exams}
        examId={examId}
        otherExamsReviewDueToday={agg.otherExamsReviewDueToday}
        onSelectExam={onSelectExam}
      />

      <TodayStudy
        examId={examId}
        totalCards={agg.totalCards}
        newCards={agg.newCards}
        n={agg.reviewDueToday}
        m={agg.carryover}
        k={pool.newCount}
        poolSize={pool.pool.length}
        nextAvailableAt={pool.nextAvailableAt}
        perCardMs={perCardMs}
      />

      {/* カード 0 の試験ではカード由来のウィジェットを全て畳む(§5「他ウィジェットは
          非表示 = 母集合 0 の空」)。W7 も畳むのは、選択試験に何も無い画面に
          全試験の活動量だけが残ると「どの試験の数字か」が読めなくなるため。 */}
      {hasCards ? (
        <>
          {/* 並びは spec §3.1「構成順」を DOM 順で守る (W3 → W4 → W5 → W6 → W7)。
              密度のための 2 カラム化は順序を崩すため v1 では行わない。 */}
          <StateSummary
            examId={examId}
            newCards={agg.newCards}
            learningCards={agg.learningCards}
            matureCards={agg.matureCards}
            carryover={agg.carryover}
          />

          <WeakTags userId={userId} examId={examId} />

          <QuickPractice
            examId={examId}
            mistakeCards={agg.mistakeCards}
            unansweredCards={agg.unansweredCards}
            weakCards={agg.weakCards}
            tenMinCards={Math.min(tenMinCount(perCardMs), pool.pool.length)}
          />

          {/* W6 は母集合(state≠0)0 でウィジェットごと非表示(構造的な空)。 */}
          {agg.forecastPopulation > 0 ? (
            <WeekForecast
              forecast={agg.forecast}
              carryover={agg.carryover}
              now={now}
            />
          ) : null}

          <WeekActivity
            answers={week.answers}
            studyDays={week.studyDays}
            delta={week.delta}
            streak={activity.streak}
            todayCardCount={activity.todayCardCount}
          />
        </>
      ) : null}
    </div>
  )
}
