import Link from 'next/link'
import { getAuthContext, getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { getActiveExamsForUser } from '@/lib/exams/list'
import { getCurrentMonthOcrPages } from '@/lib/ai-usage-mcq'
import { limitsForOrFree, type Plan } from '@/lib/auth/plan-limits'
import { hasActiveProcessingUpload } from '@/lib/exams/source-doc-status'
import { AppContainer } from '../_components/app-container'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { UploadForm } from './_components/upload-form'

// Server Actions の実行時間上限 (秒)。 maxDuration は呼び出し page の route
// segment config に従うため、process.ts ('use server') ではなくここに宣言する。
// Vercel Pro Function timeout (900s) 内で OCR pipeline deadline (720s) をカバーする。
export const maxDuration = 800

// Server Component: 認証確認 → in-flight 判定 → 分岐描画。
//
// S2.0.7: render 冒頭の reconcileStaleProcessing 呼び出しを撤去した。
//   無条件の書き込み tx (stale 0 件でも BEGIN/UPDATE/COMMIT) がページ遷移を
//   ブロックしていたため。stale processing 残骸の DB cleanup は polling
//   endpoint (/api/exams/status) が担う。hasActiveProcessingUpload は
//   STALE_PROCESSING_MS (15 分) window を内蔵しており、reconcile 前の死骸を
//   in-flight と誤判定しないため、reconcile 撤去後も判定は正しい。
//
// in-flight ジョブあり (hasActiveProcessingUpload = true):
//   UploadForm を出さず「処理中」案内を表示する。
//   並列 upload の UI 第一層 guard (advisory)。真の enforcement は
//   app/upload/process の server-side guard (S1.9.4 T1) が担う。
//
// in-flight なし (false):
//   従来どおり UploadForm を描画する (S1.7 T3 以降の既存ロジックを維持)。
//
// C2: getAuthContext() で JWT 経由の dbUserId + plan 読込に切替、 users SELECT
// を撤去。 dbUserId / plan いずれか undefined (JWT template 未浸透) なら
// getCurrentUser() fallback に degrade する。 これにより /app/upload の Neon
// users SELECT 1 件 (cold +2s) が剥がれる。
export default async function UploadPage() {
  const ctx = await getAuthContext()
  let userId: string | undefined = ctx.dbUserId
  let plan: Plan | undefined = ctx.plan
  // dbUserId / plan の片方が undefined なら、 整合のため両方とも DB 由来で揃える
  // (= hybrid 由来を避けて読込 source を 1 系統に固定する設計判断、 review M2)。
  // どちらか片方が JWT に乗っていても fallback で上書き、 結果として 1 SELECT。
  if (userId === undefined || plan === undefined) {
    const user = await getCurrentUser()
    if (!user) return null
    userId = user.id
    plan = user.plan
  }

  const isProcessing = await hasActiveProcessingUpload(userId)

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
      <AppContainer>
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
                <Link href="/app/exams" prefetch={false}>試験一覧を見る</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppContainer>
    )
  }

  // --- 通常描画: UploadForm ---
  // in-flight なし確定後に fetch する (処理中案内のときは不要な fetch を省く)。
  const [existingExams, currentMonthPages] = await Promise.all([
    withTenantTx(getDb(), userId, (tx) => getActiveExamsForUser(userId, tx)),
    // RLS-P2 §6.6: uploadRecords は RLS-off ゆえ standalone getDb() で足りる
    // (上の active exams read とは別 read なので tx を共有しない)。
    getCurrentMonthOcrPages(userId, getDb()),
  ])
  // C2 (S-perf-3 follow-up): `limitsFor` ではなく safety net 版を使う。 plan が
  // null / 未知の文字列で runtime に漏れた場合 (JWT claim 不整合 / DB 値異常等)
  // でも free fallback で画面クラッシュを防ぐ (詳細: lib/auth/plan-limits.ts)。
  const monthlyLimit = limitsForOrFree(plan).ocrPagesPerMonth
  const remaining =
    monthlyLimit === null ? null : Math.max(monthlyLimit - currentMonthPages, 0)

  return (
    <AppContainer>
      <div className="space-y-6">
        {header}
        <UploadForm
          existingExams={existingExams}
          currentMonthPages={currentMonthPages}
          monthlyLimit={monthlyLimit}
          remaining={remaining}
          plan={plan}
        />
      </div>
    </AppContainer>
  )
}
