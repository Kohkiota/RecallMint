import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import {
  formatRelativeJa,
  getActiveExamsWithCardCount,
} from '@/lib/exams/list'
import {
  getExamStatusMap,
  reconcileStaleProcessing,
} from '@/lib/exams/source-doc-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DeleteExamButton } from './_components/delete-exam-button'

// S1.7 T7: read-only exam 一覧 (archived_at IS NULL、 updated_at DESC)。
// 編集 / 削除 / 並び替えなし、 S2 で正式 CRUD を実装する。
// S1.9.3 T4: render 冒頭で 15 分超 processing の cleanup を実行し、
//   各 exam 行に処理中 / 失敗バッジを表示する。
export default async function ExamsListPage() {
  const user = await getCurrentUser()
  if (!user) return null

  // cleanup を先に完了させ、その結果を後続の status fetch が読めるようにする。
  // best-effort (throw しない) なのでエラーハンドリングは不要。
  await reconcileStaleProcessing(user.id)

  // cleanup 後に並列取得。status map は cleanup 済みの DB 状態を反映する。
  const [exams, statusMap] = await Promise.all([
    getActiveExamsWithCardCount(user.id),
    getExamStatusMap(user.id),
  ])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">試験一覧</h1>

      {exams.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-slate-700">まだ試験がありません。</p>
            <Button asChild>
              <Link href="/app/upload">アップロードから始める</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {exams.map((exam) => {
            const status = statusMap.get(exam.id)
            return (
              <li key={exam.id}>
                <Card>
                  <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{exam.name}</span>
                        {/* completed exam (status = undefined) にはバッジを出さない */}
                        {status === 'processing' && (
                          <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700">
                            処理中
                          </span>
                        )}
                        {status === 'failed' && (
                          <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-600">
                            失敗
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">
                        カード {exam.cardCount} 件 ・ 最終更新 {formatRelativeJa(exam.updatedAt)}
                      </div>
                    </div>
                    <div className="flex items-start gap-2 shrink-0">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/app/exams/${exam.id}`}>詳細を見る</Link>
                      </Button>
                      <DeleteExamButton examId={exam.id} />
                    </div>
                  </CardContent>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
