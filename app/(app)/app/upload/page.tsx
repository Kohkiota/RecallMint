import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getActiveExamsForUser } from '@/lib/exams/list'
import { UploadForm } from './_components/upload-form'

// Server Component: 認証確認 + active exam 一覧を取得して client に渡す。
// destination selector (新規 exam / 既存 exam) で使用、 server action wiring は task 9。
export default async function UploadPage() {
  const user = await getCurrentUser()
  if (!user) return null
  const existingExams = await getActiveExamsForUser(user.id)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">アップロード</h1>
      <p className="text-sm text-slate-600">
        試験問題の画像や PDF を選択すると、 AI が問題を抽出します。
        抽出結果は次の画面で確認 / 保存できます。
      </p>
      <UploadForm existingExams={existingExams} />
    </div>
  )
}
