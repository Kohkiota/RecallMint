import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getAuthContext, getCurrentUser } from '@/lib/auth/ensure-user'
import {
  formatRelativeJa,
  getCardsForExam,
  getExamByIdForUser,
} from '@/lib/exams/list'
import { AppContainer } from '../../_components/app-container'
import { ExamDetailPullGate } from './_components/exam-detail-pull-gate'
import { ExamDetailView } from './_components/exam-detail-view'

// 試験詳細 page: 各 card の全情報 (sort_key / title / 問題文 / 選択肢 + 各解説 /
// 解説 / メモ) を inline 編集 cell として展開 (S2.0b-1 T3)。 旧 /app/cards/[id]
// page は廃止済 (cache-fix roadmap ④-3)、 card 編集は全 inline で完結する。
//
// C2: getAuthContext() で JWT 経由の dbUserId 読込に切替、 users SELECT を撤去。
// undefined 時は getCurrentUser() fallback。
export default async function ExamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const ctx = await getAuthContext()
  let userId: string | undefined = ctx.dbUserId
  if (userId === undefined) {
    const user = await getCurrentUser()
    if (!user) return null
    userId = user.id
  }

  const exam = await getExamByIdForUser(userId, id)
  if (!exam) notFound()

  const cards = await getCardsForExam(userId, id)

  return (
    <div className="w-full">
      <AppContainer>
        <div className="space-y-6 md:space-y-3">
          <div>
            <Link
              href="/app/exams"
              prefetch={false}
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              ← 試験一覧
            </Link>
          </div>

          {/* 詳細滞在中は ambient pull を抑止し、mount 時に入口 pull を kick する gate */}
          <ExamDetailPullGate examId={id} />

          <header className="space-y-1">
            <h1 className="text-2xl font-bold">{exam.name}</h1>
            <p className="text-xs text-slate-500">
              作成 {formatRelativeJa(exam.createdAt)} ・ 最終更新 {formatRelativeJa(exam.updatedAt)}
              {exam.archivedAt && <span className="ml-2 text-amber-700">(アーカイブ済)</span>}
            </p>
          </header>
        </div>
      </AppContainer>

      {/* ExamDetailView → InlineCardList (card view) / ExamCardTable (table view) の
          view 別 conditional unmount で表示を切り替える。 どちらの view でも内部の
          Dexie mirror useLiveQuery 直読みが真実。 件数も同 live 配列から算出するため
          追加/削除直後も即時整合する (論点B)。 initialCards は SSR / mirror 未 hydrate
          期間の bootstrap 用 fallback (InlineCardList のみ使用)。
          ExamDetailView は AppContainer の外 = full-width 領域に置く (Edit-1 T2)。 */}
      <ExamDetailView initialCards={cards} examId={id} userId={userId} />
    </div>
  )
}
