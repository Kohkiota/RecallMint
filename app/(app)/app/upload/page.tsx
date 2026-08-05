import Link from 'next/link'
import { getAuthContext, getCurrentUser } from '@/lib/auth/ensure-user'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { getActiveExamsForUser } from '@/lib/exams/list'
import { getCurrentMonthOcrPages } from '@/lib/ai-usage-mcq'
import { limitsForOrFree, type Plan } from '@/lib/auth/plan-limits'
import { hasLiveUploadOperation } from '@/lib/exams/source-doc-status'
import { AppContainer } from '../_components/app-container'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { UPLOAD_PENDING_NOTICE } from './_lib/constants'
import { UploadForm } from './_components/upload-form'

// Server Actions の実行時間上限 (秒)。 maxDuration は呼び出し page の route
// segment config に従うため、process.ts ('use server') ではなくここに宣言する。
// Vercel Pro Function timeout (900s) の内側で、かつ lease TTL (15 分) に対して
// 3 分の余裕を残す値として 720 を採る (②-4a 単一 invocation・OT 決定): 単一
// invocation が maxDuration いっぱい走っても lease が先に失効しないことが
// live-op gate の不変条件。値は Dashboard の Function Max Duration (既定値) を
// route segment config が上書きするため、この literal が実効値になる。
// literal 固定の理由 = route segment config は静的解析される (import 定数不可)。
// drift 検出 = _actions/submit-upload.test.ts の maxDuration pin (行の消失も fail)。
export const maxDuration = 720

// Server Component: 認証確認 → in-flight 判定 → 分岐描画。
//
// S2.0.7: render 冒頭の reconcileStaleProcessing 呼び出しを撤去した。
//   無条件の書き込み tx (stale 0 件でも BEGIN/UPDATE/COMMIT) がページ遷移を
//   ブロックしていたため。stale processing 残骸の DB cleanup は polling
//   endpoint (/api/exams/status) が担う。hasLiveUploadOperation は lease の
//   生死だけを見る (死んだ invocation の残骸は lease 失効で自動的に外れる) ため、
//   reconcile 撤去後も判定は正しい。
//
// live operation あり (hasLiveUploadOperation = true):
//   UploadForm を出さず「処理中」案内を表示する。
//   並列 upload の UI 第一層 guard (advisory)。真の enforcement は
//   submitUploadTx の live-op gate が担い、**両者は同じ述語を読む**
//   (S-5b 追加項目 A: 判定を共有して「form は出るが submit は拒否」を作らない)。
//
// live operation なし (false):
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

  const hasLiveOperation = await hasLiveUploadOperation(userId)

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
  if (hasLiveOperation) {
    return (
      <AppContainer>
        <div className="space-y-6">
          {header}
          <Card>
            <CardContent className="p-6 space-y-3">
              {/* I-3(b): **中断を主張せず再試行も勧めない**中立文言を出す。 根拠は
                  **まだ確定していない**こと — この gate(hasLiveUploadOperation)は
                  submit を弾く live-op gate と同じ述語(非終端 + valid lease)を読む
                  だけで、実行が本当に生きているか(hard-death かどうか)は誰にも
                  区別できない。 区別できない間は区別できないと言う、が設計判断
                  (_lib/constants.ts の分割根拠を参照)。 加えて gate が閉じている間は
                  UploadForm 自体を描画しないため、再試行の案内はそもそも行き場がない。
                  文言は _lib/constants.ts に単一定義(待ち時間の数値なし / 削除案内なし)。 */}
              <p className="font-medium text-slate-800">
                直前のアップロードがまだ完了していません。
              </p>
              <p className="text-sm text-slate-600">{UPLOAD_PENDING_NOTICE}</p>
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
    withTenantTx(userId, (tx) => getActiveExamsForUser(userId, tx)),
    // RLS-P3 Wave2: upload_records も RLS-on 化。tenant context 下で読む
    // (上の active exams read とは別 tx = snapshot を共有しない既存方針は不変)。
    withTenantTx(userId, (tx) => getCurrentMonthOcrPages(userId, tx)),
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
