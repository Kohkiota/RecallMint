import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getAuthContext, getCurrentUser } from '@/lib/auth/ensure-user'
import { getCardsForExam, getExamByIdForUser } from '@/lib/exams/list'
import { formatRelativeJa } from '@/lib/exams/format'
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
      {/* 試験詳細のみ密度優先で共通 py-8 を page 限定で py-2 に上書き */}
      <AppContainer className="py-2">
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
        </div>
      </AppContainer>

      {/* ExamDetailView → InlineCardList (card view) / ExamCardTable (table view) の
          view 別 conditional unmount で表示を切り替える。 どちらの view でも内部の
          Dexie mirror useLiveQuery 直読みが真実。 件数も同 live 配列から算出するため
          追加/削除直後も即時整合する (論点B)。 initialCards は SSR / mirror 未 hydrate
          期間の bootstrap 用 fallback (InlineCardList のみ使用)。
          ExamDetailView は AppContainer の外 = full-width 領域に置く (Edit-1 T2)。
          S2-1: タイトル/日付は props で ExamDetailView に移管 (table view の app-shell
          chrome は client state 依存ゆえ client 側でしか組めない。 card view branch で
          現状同等スタイルを維持し視覚回帰ゼロ)。 */}
      <ExamDetailView
        initialCards={cards}
        examId={id}
        userId={userId}
        examName={exam.name}
        createdLabel={formatRelativeJa(exam.createdAt)}
        updatedLabel={formatRelativeJa(exam.updatedAt)}
        archivedAt={exam.archivedAt}
      />
    </div>
  )
}
