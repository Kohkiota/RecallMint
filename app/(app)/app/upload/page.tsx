import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getActiveExamsForUser } from '@/lib/exams/list'
import { getCurrentMonthOcrPages } from '@/lib/ai-usage-mcq'
import { limitsFor } from '@/lib/auth/plan-limits'
import { UploadForm } from './_components/upload-form'

// Server Component: 認証確認 + active exam 一覧 + 月次 OCR 残量を取得し client に渡す。
// 残量表示 + ファイル選択時の合計 page との比較 + 超過警告 UI に使用 (S1.7 T3)。
export default async function UploadPage() {
  const user = await getCurrentUser()
  if (!user) return null

  const [existingExams, currentMonthPages] = await Promise.all([
    getActiveExamsForUser(user.id),
    getCurrentMonthOcrPages(user.id),
  ])
  const monthlyLimit = limitsFor(user.plan).ocrPagesPerMonth
  const remaining =
    monthlyLimit === null ? null : Math.max(monthlyLimit - currentMonthPages, 0)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">アップロード</h1>
      <p className="text-sm text-slate-600">
        試験問題の画像や PDF を選択すると、 AI が問題を抽出します。
        抽出結果は次の画面で確認 / 保存できます。
      </p>
      <UploadForm
        existingExams={existingExams}
        currentMonthPages={currentMonthPages}
        monthlyLimit={monthlyLimit}
        remaining={remaining}
        plan={user.plan}
      />
    </div>
  )
}
