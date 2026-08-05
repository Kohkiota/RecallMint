import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { withTenantTx } from '@/lib/db/tenant-tx'
import {
  getCardsForSourceDocument,
  getLatestCompletedUploadSummary,
  getSourceDocumentForUser,
} from '@/lib/exams/list'
import { Card, CardContent } from '@/components/ui/card'
import { AppContainer } from '@/app/(app)/app/_components/app-container'
import {
  UPLOAD_INTERRUPTED_NOTICE,
  UPLOAD_PENDING_NOTICE,
  uploadCardsExtractedNotice,
  uploadFiguresAttachedNotice,
  uploadFiguresCappedNotice,
  uploadFiguresFailedNotice,
} from '../../_lib/constants'
import { buildUploadResultSummaryView } from '../../_lib/result-summary-view'
import { ResultActions } from './_components/result-actions'

// S1.9.2: OCR result page。 旧来 upload-form の success phase で描画していた
// preview を独立 route に切り出した。 page 遷移ごとに fresh server render される
// ため、 残量 banner stale 表示 (Bug B) が構造的に発生しない。
//
// 到達経路: upload 完了 → upload-form が router.push でここへ。
// URL 直叩き (他 user のリソース) は owner-scoped query が null → notFound()。
//
// ②-4a 単一 invocation Sprint Task S-3: **成功前提で描画しない**。 新経路の
// `submitUpload` は pipeline の成否を呼出側に返さない(失敗も含めて server 側で
// 終端化する契約)ため、 client は結果を知らずにこの page へ遷移する。 唯一の正は
// `source_documents.status` で、 `completed` **以外**(failed = spec §4.4 の全失敗
// クラス = Gemini rate limit / 呼出失敗 / JSON 不読 / 有効カード 0 / decode 不能 /
// 予算切れ / publish 失敗 / 予期しない throw、 processing = 未完了)は緑の成功
// パネルを出さない。
// この分岐は S-4(poll → 遷移)後も生きる — URL 直叩き / back-button でもここへ
// 到達しうるため、表示の正しさを page 側で閉じる。
export default async function UploadResultPage({
  params,
}: {
  params: Promise<{ sourceDocumentId: string }>
}) {
  const { sourceDocumentId } = await params
  const user = await getCurrentUser()
  if (!user) return null

  // source_document 所有確認 + cards 取得を 1 tenant tx に包む (RLS-P2)。不在時は
  // tx 内で notFound() を throw し、cards query を実行しない (従来挙動を保持)。
  //
  // ②-4a T16-a: 取り込み内訳 (upload_operations.result_summary) も同じ tx で引く
  // (tx を増やさない)。 成功面だけが出す情報なので `completed` 以外では引かない。
  const { sourceDoc, cards, summary } = await withTenantTx(
    user.id,
    async (tx) => {
      const sourceDoc = await getSourceDocumentForUser(
        user.id,
        sourceDocumentId,
        tx,
      )
      if (!sourceDoc) notFound()
      const cards = await getCardsForSourceDocument(
        user.id,
        sourceDocumentId,
        tx,
      )
      const summary =
        sourceDoc.status === 'completed'
          ? await getLatestCompletedUploadSummary(user.id, sourceDocumentId, tx)
          : null
      return { sourceDoc, cards, summary }
    },
  )

  // **完了以外はすべて成功パネルを出さない**(`!== 'completed'`)。 `failed` だけを
  // 弾く形にすると `processing` が「✅ 0 問を抽出しました」になる — S-3 では狭い race
  // (replay で in-flight op の 3 ID が返る / commit_raced / publish stale)経由でしか
  // 到達しないが、 S-4(after() + poll)では processing が常態になり同じ穴が主経路で
  // 開く。 クラスごと閉じておく。
  if (sourceDoc.status !== 'completed') {
    const failed = sourceDoc.status === 'failed'
    return (
      <AppContainer>
        <div className="space-y-6">
          <section
            role="alert"
            className={`rounded-md border p-4 ${
              failed ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'
            }`}
          >
            <h1
              className={`text-lg font-bold mb-1 ${
                failed ? 'text-red-800' : 'text-amber-900'
              }`}
            >
              {failed ? '⚠ 問題を抽出できませんでした' : '⏳ まだ処理中です'}
            </h1>
            {/* 公開文言(spec 論点 A): 待ち時間の数値は書かない / 試験の削除は案内
                しない。 失敗面 / 処理中面とも _lib/constants.ts の単一定義を使う
                (I-3(b): 同じ状況を別の言い方で説明しない)。 定数は**常に独立した
                1 文**として使い、述語として文中に連結しない — 連結すると定数の書換が
                他面では正しいまま この面だけ壊れた日本語になり、誰も気付かない
                (canonical M-2)。 exam 名はこの面だけが持てる情報なので併記する。 */}
            <p className="text-sm text-slate-700">
              {failed
                ? UPLOAD_INTERRUPTED_NOTICE
                : `${UPLOAD_PENDING_NOTICE}(取り込み先: 試験「${sourceDoc.examName}」)`}
            </p>
          </section>

          <ResultActions label="試験一覧へ" />
        </div>
      </AppContainer>
    )
  }

  // 見出しの件数は DB の実 card 行数のまま (それが正)。 summary は内訳ブロックにだけ
  // 使い、出すものが無ければ null が返る (「除外 0 件」を毎回見せない)。
  const summaryView = buildUploadResultSummaryView(summary)

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
          {/* 公開文言 (spec §13「loud failure over silent zero」): 除外が起きたことを
              画面に出す。 文言は _lib/constants.ts の単一定義で、各行は**独立した
              1 文**として使う (述語として連結しない — I-3(b))。 理由コードは出さず
              3 束 (取り込み / 取り込めなかった / 上限で省いた) に畳んだ言い方だけ。 */}
          {summaryView && (
            <ul className="mt-2 space-y-0.5 text-sm text-slate-700">
              {summaryView.cardsExcluded > 0 && (
                <li>
                  {uploadCardsExtractedNotice(
                    summaryView.cardsExtracted,
                    summaryView.cardsTotal,
                  )}
                </li>
              )}
              {summaryView.figuresAttached > 0 && (
                <li>{uploadFiguresAttachedNotice(summaryView.figuresAttached)}</li>
              )}
              {summaryView.figuresFailed > 0 && (
                <li>{uploadFiguresFailedNotice(summaryView.figuresFailed)}</li>
              )}
              {summaryView.figuresCapped > 0 && (
                <li>{uploadFiguresCappedNotice(summaryView.figuresCapped)}</li>
              )}
            </ul>
          )}
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
