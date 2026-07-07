import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import {
  getCardsForSourceDocument,
  getSourceDocumentForUser,
} from '@/lib/exams/list'
import { Card, CardContent } from '@/components/ui/card'
import { AppContainer } from '@/app/(app)/app/_components/app-container'
import { ResultActions } from './_components/result-actions'

// S1.9.2: OCR result page。 旧来 upload-form の success phase で描画していた
// preview を独立 route に切り出した。 page 遷移ごとに fresh server render される
// ため、 残量 banner stale 表示 (Bug B) が構造的に発生しない。
//
// 到達経路: processUpload 成功 → upload-form が router.push でここへ。
// URL 直叩き (他 user のリソース) は owner-scoped query が null → notFound()。
export default async function UploadResultPage({
  params,
}: {
  params: Promise<{ sourceDocumentId: string }>
}) {
  const { sourceDocumentId } = await params
  const user = await getCurrentUser()
  if (!user) return null

  const sourceDoc = await getSourceDocumentForUser(user.id, sourceDocumentId)
  if (!sourceDoc) notFound()

  const cards = await getCardsForSourceDocument(user.id, sourceDocumentId)

  return (
    <AppContainer>
      <div className="space-y-6">
        <section className="rounded-md bg-emerald-50 border border-emerald-200 p-4">
          <h1 className="text-lg font-bold mb-1">
            ✅ {cards.length} 問を抽出しました
          </h1>
          <p className="text-sm text-slate-700">
            試験「{sourceDoc.examName}」 に保存されました。
          </p>
        </section>

        <section>
          <h2 className="font-bold mb-2">抽出結果のプレビュー</h2>
          <ul className="space-y-2">
            {cards.map((c) => (
              <li key={c.id}>
                <Card>
                  <CardContent className="p-3">
                    <div className="font-medium text-sm mb-1">{c.title}</div>
                    <div className="text-xs text-slate-700 mb-1">
                      {c.questionTextSnippet}
                    </div>
                    <div className="text-xs text-slate-500">
                      選択肢 {c.optionCount} 件
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        <ResultActions />
      </div>
    </AppContainer>
  )
}
