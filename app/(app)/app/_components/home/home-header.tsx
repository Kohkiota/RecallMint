'use client'

// HomeHeader(W1)— 試験名 + 切替 + 他試験 1 行(spec §4 / §3.1)。
//
// 「あと◯日」は描画しない: `exams.exam_date` は現 schema に存在せず Dash-2 の前方参照
// (定義 doc W1)。列が来るまでこの行は無い。
//
// 切替は native `<select>`。repo の既存パターン(merge-exam-button.tsx 等)に倣うと
// 同時に keyboard 操作・screen reader・モバイルの OS picker が全て素で付いてくる
// (spec の a11y 要件「dropdown の keyboard 操作」を新 primitive なしで満たす)。
//
// 他試験 1 行は「他にもやることがある」ことの告知であって別ページへの導線ではない
// ため、切替そのものへフォーカスを渡す(spec §3.1「タップで試験切替を開く」)。

import { useRef } from 'react'
import type { ClientExam } from '@/lib/client-db'

interface HomeHeaderProps {
  exams: readonly ClientExam[]
  examId: string
  /** 選択中以外の全試験の n 合計。0 なら行ごと出さない。 */
  otherExamsReviewDueToday: number
  onSelectExam: (examId: string) => void
}

export function HomeHeader({
  exams,
  examId,
  otherExamsReviewDueToday,
  onSelectExam,
}: HomeHeaderProps): React.JSX.Element {
  const selectRef = useRef<HTMLSelectElement>(null)
  const current = exams.find((e) => e.id === examId)

  return (
    <header className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-heading text-2xl leading-tight font-bold">
          {current?.name ?? '試験'}
        </h1>
        {exams.length > 1 ? (
          <select
            ref={selectRef}
            aria-label="試験を切り替える"
            value={examId}
            onChange={(e) => onSelectExam(e.target.value)}
            className="max-w-[55%] truncate rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {otherExamsReviewDueToday > 0 ? (
        <button
          type="button"
          data-testid="other-exams"
          onClick={() => selectRef.current?.focus()}
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          他の試験: 復習 {otherExamsReviewDueToday} 件
        </button>
      ) : null}
    </header>
  )
}
