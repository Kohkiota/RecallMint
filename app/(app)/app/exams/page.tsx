import { getAuthContext, getCurrentUser } from '@/lib/auth/ensure-user'
import { getExamStatusMap } from '@/lib/exams/source-doc-status'
import { CreateExamForm } from './_components/create-exam-form'
import { ExamStatusProvider } from '../_components/exam-status-live'
import { ExamListLive } from './_components/exam-list-live'

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

  const statusMap = await getExamStatusMap(userId)

  return (
    <ExamStatusProvider initialStatuses={Object.fromEntries(statusMap)}>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">試験一覧</h1>

        {/* 手動作成導線 — 一覧上部に常時表示。クリックでインライン展開。 */}
        <CreateExamForm />

        {/* list / 空状態 / skeleton は ExamListLive (client) が Dexie mirror から
            useLiveQuery で live 表示。 page.tsx (RSC) の DB SELECT を撤去。 */}
        <ExamListLive userId={userId} />
      </div>
    </ExamStatusProvider>
  )
}
