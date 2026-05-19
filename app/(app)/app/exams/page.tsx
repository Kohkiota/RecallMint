import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import {
  formatRelativeJa,
  getActiveExamsWithCardCount,
} from '@/lib/exams/list'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

// S1.7 T7: read-only exam 一覧 (archived_at IS NULL、 updated_at DESC)。
// 編集 / 削除 / 並び替えなし、 S2 で正式 CRUD を実装する。
export default async function ExamsListPage() {
  const user = await getCurrentUser()
  if (!user) return null
  const exams = await getActiveExamsWithCardCount(user.id)

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
          {exams.map((exam) => (
            <li key={exam.id}>
              <Card>
                <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{exam.name}</div>
                    <div className="text-xs text-slate-500">
                      カード {exam.cardCount} 件 ・ 最終更新 {formatRelativeJa(exam.updatedAt)}
                    </div>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/app/exams/${exam.id}`}>詳細を見る</Link>
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
