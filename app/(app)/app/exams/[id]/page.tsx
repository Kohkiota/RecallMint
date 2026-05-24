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
import { InlineCardList } from './_components/inline-card-list'

// 試験詳細 page: 各 card の全情報 (sort_key / title / 問題文 / 選択肢 + 各解説 /
// 解説 / メモ) を inline 編集 cell として展開 (S2.0b-1 T3)。 「編集」 ボタン経由の
// /app/cards/[id] page への遷移は廃止 (全 inline で完結)、 ただし /app/cards/[id]
// 自体は残置 (深い編集が要る場合の保険、 S2.0b-1 scope 外)。
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
          <InlineCardList cards={cards} />
        )}
      </section>
    </div>
  )
}
