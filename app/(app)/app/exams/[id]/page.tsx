import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import {
  formatRelativeJa,
  getCardsForExam,
  getExamByIdForUser,
} from '@/lib/exams/list'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

// 試験詳細 page: 各 card の全情報 (問題文 / 全選択肢 + 正誤 / 解説) を read-only
// 展開表示 (S2.0 T7) + 各 card に編集 page への link (T3/T10)。
// フィルタ / 一括操作は S2.0b。
export default async function ExamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return null

  const exam = await getExamByIdForUser(user.id, id)
  if (!exam) notFound()

  const cards = await getCardsForExam(user.id, id)

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/app/exams"
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          ← 試験一覧
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{exam.name}</h1>
        <p className="text-xs text-slate-500">
          作成 {formatRelativeJa(exam.createdAt)} ・ 最終更新 {formatRelativeJa(exam.updatedAt)}
          {exam.archivedAt && <span className="ml-2 text-amber-700">(アーカイブ済)</span>}
        </p>
      </header>

      <section>
        <h2 className="text-lg font-bold mb-2">カード ({cards.length} 件)</h2>
        {cards.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center">
              <p className="text-sm text-slate-700">この試験にはまだカードがありません。</p>
              <div className="mt-3">
                <Button asChild>
                  <Link href="/app/upload">アップロードから追加</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <ul className="space-y-2">
            {cards.map((card) => (
              <li key={card.id}>
                <Card>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {card.sortKey && (
                          <span className="text-xs text-slate-500 font-mono shrink-0">
                            {card.sortKey}
                          </span>
                        )}
                        <span className="font-medium text-sm">{card.title}</span>
                      </div>
                      <Button asChild size="sm" className="shrink-0">
                        <Link href={`/app/cards/${card.id}`}>編集</Link>
                      </Button>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-slate-500">問題文</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">
                        {card.questionText}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-slate-500">
                        選択肢 ({card.options.length} 件)
                      </p>
                      <ul className="mt-1 space-y-1.5">
                        {card.options.map((opt) => (
                          <li
                            key={opt.id}
                            className={
                              opt.is_correct
                                ? 'rounded border border-emerald-300 bg-emerald-100 p-2 text-sm font-bold text-emerald-900'
                                : 'rounded border border-border/60 p-2 text-sm text-slate-800'
                            }
                          >
                            <p className="whitespace-pre-wrap">
                              <span className="mr-1.5">
                                {opt.is_correct ? '○' : '×'}
                              </span>
                              <span className="mr-2">{opt.id}</span>
                              {opt.text}
                            </p>
                            {opt.explanation && (
                              <p className="mt-1 whitespace-pre-wrap text-xs font-normal text-slate-500">
                                解説: {opt.explanation}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-slate-500">解説</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">
                        {card.explanationText ?? '(なし)'}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
