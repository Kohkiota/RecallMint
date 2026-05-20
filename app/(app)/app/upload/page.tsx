import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getActiveExamsForUser } from '@/lib/exams/list'
import { getCurrentMonthOcrPages } from '@/lib/ai-usage-mcq'
import { limitsFor } from '@/lib/auth/plan-limits'
import {
  reconcileStaleProcessing,
  hasActiveProcessingUpload,
} from '@/lib/exams/source-doc-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { UploadForm } from './_components/upload-form'

// Server Component: 認証確認 → stale cleanup → in-flight 判定 → 分岐描画。
//
// in-flight ジョブあり (hasActiveProcessingUpload = true):
//   UploadForm を出さず「処理中」案内を表示する。
//   並列 upload の UI 第一層 guard (advisory)。真の enforcement は
//   app/upload/process の server-side guard (S1.9.4 T1) が担う。
//
// in-flight なし (false):
//   従来どおり UploadForm を描画する (S1.7 T3 以降の既存ロジックを維持)。
//
// reconcileStaleProcessing は exams 一覧ページでも呼ばれており二重実行になるが、
// UPDATE RETURNING による冪等設計 (S1.9.3 で確認済) のため安全。
export default async function UploadPage() {
  const user = await getCurrentUser()
  if (!user) return null

  // stale (>15 分) な processing 行を failed に変換してから in-flight 判定する。
  // 死骸を先に片付けることで hasActiveProcessingUpload が誤 true を返さなくなる。
  // best-effort (throw しない) のでエラーハンドリングは不要。
  await reconcileStaleProcessing(user.id)

  const isProcessing = await hasActiveProcessingUpload(user.id)

  // --- 共通ヘッダー ---
  const header = (
    <>
      <h1 className="text-2xl font-bold">アップロード</h1>
      <p className="text-sm text-slate-600">
        試験問題の画像や PDF を選択すると、 AI が問題を抽出します。
        抽出結果は次の画面で確認 / 保存できます。
      </p>
    </>
  )

  // --- in-flight guard: UploadForm を出さず案内を表示 ---
  if (isProcessing) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <CardContent className="p-6 space-y-3">
            <p className="font-medium text-slate-800">
              現在 AI が問題を抽出中です。完了までしばらくお待ちください。
            </p>
            <p className="text-sm text-slate-600">
              処理状況は試験一覧で確認できます。
            </p>
            <Button asChild variant="outline">
              <Link href="/app/exams">試験一覧を見る</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // --- 通常描画: UploadForm ---
  // in-flight なし確定後に fetch する (処理中案内のときは不要な fetch を省く)。
  const [existingExams, currentMonthPages] = await Promise.all([
    getActiveExamsForUser(user.id),
    getCurrentMonthOcrPages(user.id),
  ])
  const monthlyLimit = limitsFor(user.plan).ocrPagesPerMonth
  const remaining =
    monthlyLimit === null ? null : Math.max(monthlyLimit - currentMonthPages, 0)

  return (
    <div className="space-y-6">
      {header}
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
