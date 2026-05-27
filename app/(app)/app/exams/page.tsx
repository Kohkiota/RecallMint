import Link from 'next/link'
import { getAuthContext, getCurrentUser } from '@/lib/auth/ensure-user'
import {
  formatRelativeJa,
  getActiveExamsWithCardCount,
} from '@/lib/exams/list'
import { getExamStatusMap } from '@/lib/exams/source-doc-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DeleteExamButton } from './_components/delete-exam-button'
import {
  ExamStatusBadge,
  ExamStatusProvider,
} from './_components/exam-status-live'

// S1.7 T7: read-only exam 一覧 (archived_at IS NULL、 updated_at DESC)。
// 編集 / 削除 / 並び替えなし、 S2 で正式 CRUD を実装する。
//
// S2.0.7: render 冒頭の reconcileStaleProcessing 呼び出しを撤去した。
//   無条件の書き込み tx がページ表示をブロックしていたため。stale processing
//   残骸の DB cleanup は polling endpoint (/api/exams/status) が担う。
//   処理中 / 失敗バッジは ExamStatusBadge (client) が初期値 statusMap を起点に
//   polling で live 更新する (OCR 完了後にバッジが自動で消える)。
//
// C2: getAuthContext() で JWT 経由の dbUserId 読込に切替、 users SELECT を撤去。
// JWT template 未浸透 / 旧セッションでは dbUserId undefined になるため、
// getCurrentUser() への fallback で旧 path に degrade する。 backfill 完了後は
// fallback path は traffic 上ほぼ発火しない。
export default async function ExamsListPage() {
  const ctx = await getAuthContext()
  let userId: string | undefined = ctx.dbUserId
  if (userId === undefined) {
    const user = await getCurrentUser()
    if (!user) return null
    userId = user.id
  }

  const [exams, statusMap] = await Promise.all([
    getActiveExamsWithCardCount(userId),
    getExamStatusMap(userId),
  ])

  return (
    <ExamStatusProvider initialStatuses={Object.fromEntries(statusMap)}>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">試験一覧</h1>

        {exams.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center space-y-3">
              <p className="text-slate-700">まだ試験がありません。</p>
              <Button asChild>
                <Link href="/app/upload" prefetch={false}>アップロードから始める</Link>
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
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{exam.name}</span>
                        {/* 処理中 / 失敗バッジは client が polling で live 更新。
                            completed exam は context に entry なし = 非表示。 */}
                        <ExamStatusBadge examId={exam.id} />
                      </div>
                      <div className="text-xs text-slate-500">
                        カード {exam.cardCount} 件 ・ 最終更新 {formatRelativeJa(exam.updatedAt)}
                      </div>
                    </div>
                    <div className="flex items-start gap-2 shrink-0">
                      <Button asChild variant="outline" size="sm">
                        {/* S-perf-1: 試験一覧 N 件分の Link が viewport 内で
                            並列 prefetch されると server SSR が N 件並列で走るため
                            prefetch={false}。 click 時の navigation 自体は維持、
                            遷移 fallback は loading.tsx で吸収。 */}
                        <Link href={`/app/exams/${exam.id}`} prefetch={false}>
                          詳細を見る
                        </Link>
                      </Button>
                      <DeleteExamButton examId={exam.id} />
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ExamStatusProvider>
  )
}
