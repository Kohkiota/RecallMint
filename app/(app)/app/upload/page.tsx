import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UploadForm } from './_components/upload-form'

// Server Component: 認証確認 + (将来) exam list 取得して client に渡す。
// task 7 では file picker UI のみ、 destination selector + server action wiring は
// task 8 / 9 で追加する。
export default async function UploadPage() {
  const user = await getCurrentUser()
  if (!user) return null

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">アップロード</h1>
      <p className="text-sm text-slate-600">
        試験問題の画像や PDF を選択すると、 AI が問題を抽出します。
        抽出結果は次の画面で確認 / 保存できます。
      </p>
      <UploadForm />
    </div>
  )
}
