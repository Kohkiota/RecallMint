import { notFound } from 'next/navigation'
import { getAuthContext, getCurrentUser } from '@/lib/auth/ensure-user'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { getCardsForExam, getExamByIdForUser } from '@/lib/exams/list'
import { formatRelativeJa } from '@/lib/exams/format'
import { ExamDetailPullGate } from './_components/exam-detail-pull-gate'
import { ExamDetailView } from './_components/exam-detail-view'

// 試験詳細 page: 各 card の全情報 (question_label / title / 問題文 / 選択肢 + 各解説 /
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

  // exam 所有確認 + cards 取得を 1 tenant tx に包む (RLS-P2)。exam 不在時は tx 内で
  // notFound() を throw し、cards query を実行しない (従来挙動を保持)。
  const { exam, cards } = await withTenantTx(userId, async (tx) => {
    const exam = await getExamByIdForUser(userId, id, tx)
    if (!exam) notFound()
    const cards = await getCardsForExam(userId, id, tx)
    return { exam, cards }
  })

  return (
    <div className="w-full">
      {/* 詳細滞在中は ambient pull を抑止し、mount 時に入口 pull を kick する gate */}
      <ExamDetailPullGate examId={id} />

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
        // Task 3 fix round 1 (Critical): userId が live に変わっても (remount なしの
        // internal navigation) persistent layout tree はこの component instance を
        // 使い回すため、 下記 key prop なしだと mount-load effect (deps []) は再実行されず
        // 前 user の state のまま persist effect (deps に userId 追加済) が新 user の
        // sync_meta namespace に書いてしまう。 userId を key に渡すことで userId 変化を
        // instance の作り直しに変換し、 state/ref を丸ごとリセットする (列挙型の手動 reset
        // より構造的に安全 — 簡潔性規律)。
        key={userId}
        initialCards={cards}
        examId={id}
        userId={userId}
        examName={exam.name}
        createdLabel={formatRelativeJa(exam.createdAt)}
        updatedLabel={formatRelativeJa(exam.updatedAt)}
      />
    </div>
  )
}
