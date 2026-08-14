'use client'

// ExamListLive — 試験一覧の list / 空状態を Dexie mirror (useLiveQuery) から表示する
// client component。 page.tsx (RSC) から切り出すことで:
// - getActiveExamsWithCardCount の DB SELECT を撤去 (RSC → Dexie 参照に切替)
// - Dexie 書込み (delete 等) が即時 list に live 反映される (refresh 不要)
// - mount 直後の useLiveQuery undefined 期間は skeleton で layout shift を防ぐ
//
// card_count は exams.card_count を使わず cards mirror から動的集計する。
// これにより server 側の非正規化列との整合性ズレを気にしない local-first な
// 表示が可能になる。
//
// ExamStatusBadge は ExamStatusContext を購読するため、本 component は
// page.tsx の <ExamStatusProvider> の内側で render される必要がある。

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import { useLiveQuery } from 'dexie-react-hooks'
import { getClientDb } from '@/lib/client-db'
import { formatRelativeJa } from '@/lib/exams/format'
import { ActionToast } from '@/components/ui/action-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DeleteExamButton } from './delete-exam-button'
import { MergeExamButton } from './merge-exam-button'
import { OpenCreateExamButton } from './open-create-exam-button'
import { ExamStatusBadge } from '../../_components/exam-status-live'
import { useMoveCards, type MoveResult } from '../_hooks/use-move-cards'

// Grid-3 §7.3 / §7.5: 結合 (d) の完了 toast と undo。文言は exam 詳細側 (§7.1) と
// 同じ意味論を持つが、表示面ごとに閉じた定数として置く (共有はしない — 実重複 2 箇所)。
const UNDO_FAILURE_MESSAGE = {
  'source-exam-missing': '元の試験が削除されています',
  'cards-missing': '移動したカードの一部が削除されています',
} as const
const UNDO_FAILED_MESSAGE = '元に戻せませんでした。しばらくしてから再度お試しください。'

type MergeSuccess = MoveResult & { ok: true }
// 単一 slot の toast state。id は key に渡し、同一文言の連続表示 (別の行で同じ枚数を
// 結合した等) でも remount させる (ActionToast の契約: message 同値だと
// auto-dismiss timer が再カウントされない)。
type MergeToastState = { id: number; message: string; undo?: MergeSuccess }

export function ExamListLive({ userId }: { userId: string }) {
  const exams = useLiveQuery(async () => {
    const db = getClientDb()
    const allExams = await db.exams.where('user_id').equals(userId).toArray()

    const activeExams = allExams
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)) // ISO 文字列の辞書順 DESC

    // T-B4: per-exam materialize 0 の構造保証。
    // - compound index `[user_id+exam_id]` (Dexie v6) で第 1 要素 user_id を equals fix
    //   → 他 user の cards に index 経路で構造的に到達不能 (owner isolation 担保、
    //   既存 test #6 を index 構造で satisfy。 perf のためのガード撤去はしない)
    // - count() は filter 不要のため Dexie 内部で isPlainKeyRange true →
    //   native `IDBIndex.count(IDBKeyRange)` 直送 = row 本体 fetch なしの B-tree range count
    // - JS filter (.and() / .filter()) を絶対に乗せないこと (cursor 走査に落ちて
    //   materialize 0 が崩れ、 T-B4 の意味が消える。 spec §2.4 確証はこの形が前提)
    // - cards table への subscription は `where('[user_id+exam_id]')` 経由でも維持 →
    //   server pull / optimistic mutation 双方で自動再描画される
    const counts = await Promise.all(
      activeExams.map((e) =>
        db.cards.where('[user_id+exam_id]').equals([userId, e.id]).count(),
      ),
    )

    return activeExams.map((e, i) => ({
      id: e.id,
      name: e.name,
      updatedAt: e.updated_at,
      cardCount: counts[i],
    }))
  }, [userId])

  // 結合 (§7.3) の実行機構。移動そのものは行の MergeExamButton が moveCards で発行し、
  // **完了 toast と undo は一覧が持つ**: toast は一覧全体で単一 slot なので行ごとに
  // 持たせない (行は結合後も残るが、同時に 2 つ出す設計にしない)。
  const { moveCards, undoMove } = useMoveCards({ userId })
  const [mergeToast, setMergeToast] = useState<MergeToastState | null>(null)
  // undo は「どの toast (= どの結合操作) のものか」で持つ。単なる boolean にすると、
  // 古い undo の発行中に別の行が結合を完了させたとき、新しい toast の undo button まで
  // disabled になる (fix round 1 / Codex Imp)。
  const [undoPendingId, setUndoPendingId] = useState<number | null>(null)
  const toastSeqRef = useRef(0)

  const showMergeToast = useCallback((message: string, undo?: MergeSuccess) => {
    toastSeqRef.current += 1
    setMergeToast({ id: toastSeqRef.current, message, undo })
  }, [])

  // 成功枚数は要求枚数ではなく movedCount (mirror 不在を除いた実枚数・hook の契約)。
  const onMerged = useCallback(
    (result: MergeSuccess) => {
      showMergeToast(`${result.movedCount}枚を移動しました`, result)
    },
    [showMergeToast],
  )

  const onUndoMerge = useCallback(
    async (toastId: number, undo: MergeSuccess) => {
      setUndoPendingId(toastId)
      // undo の結果は **それを開始した toast** の slot にだけ書く。発行中に別の結合が
      // 新しい toast (= 別の undo 素材) を出していたら、古い結果で上書きすると新しい方の
      // undo が押せないまま失われる。閉じられていた場合も復活させない (dismiss = 破棄)。
      const settle = (message: string) => {
        setMergeToast((current) =>
          current?.id === toastId ? { id: toastId, message } : current,
        )
      }
      try {
        const result = await undoMove(undo)
        // 失敗は同じ slot を理由付き error 文言で置き換える (undo button は消える)。
        settle(result.ok ? '元に戻しました' : UNDO_FAILURE_MESSAGE[result.reason])
      } catch {
        settle(UNDO_FAILED_MESSAGE)
      } finally {
        // 自分より後に始まった undo の pending を消さない。
        setUndoPendingId((current) => (current === toastId ? null : current))
      }
    },
    [undoMove],
  )

  // undo 素材を optional chain 1 回で narrow しておく (JSX 側で非 null 断定を書かない)。
  const mergeToastUndo = mergeToast?.undo

  // 1) skeleton — useLiveQuery が Dexie からの値を解決するまで undefined を返す。
  //    dashboard-actions.tsx の role="status" + animate-pulse パターンに倣い、
  //    一覧相当の 3 行 skeleton card を出して layout shift を防ぐ。
  if (exams === undefined) {
    return (
      <div role="status" aria-label="読み込み中" className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[72px] w-full rounded-lg bg-slate-200 animate-pulse"
          />
        ))}
      </div>
    )
  }

  // 2) 空状態 CTA — active exam が 0 件のとき (page.tsx からの移植、文言・class 維持)
  if (exams.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center space-y-3">
          <p className="text-slate-700">まだ試験がありません。</p>
          {/* 空状態 CTA 2択 (spec §2.2): アップロード起点 / 手動作成起点。
              OpenCreateExamButton は page 上部の CreateExamForm の
              展開トリガーボタンに委譲する client component。 */}
          <div className="flex flex-col sm:flex-row justify-center gap-3">
            <Button asChild>
              <Link href="/app/upload" prefetch={false}>アップロードから始める</Link>
            </Button>
            <OpenCreateExamButton />
          </div>
        </CardContent>
      </Card>
    )
  }

  // 3) list — active exam の行一覧 (page.tsx からの移植、class/prefetch 維持)
  return (
    <>
      <ul className="space-y-2">
        {exams.map((exam) => (
          <li key={exam.id}>
            <Card>
              <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{exam.name}</span>
                    {/* 処理中 / 失敗バッジは ExamStatusContext (ExamStatusProvider wrap 済)
                        から取得。 completed exam は context に entry なし = 非表示。 */}
                    <ExamStatusBadge examId={exam.id} />
                  </div>
                  <div className="text-xs text-slate-500">
                    カード {exam.cardCount} 件 ・ 最終更新{' '}
                    {/* updatedAt は ISO 文字列 (Dexie 統一)、formatRelativeJa は Date を取る */}
                    {formatRelativeJa(new Date(exam.updatedAt))}
                  </div>
                </div>
                <div className="flex items-start gap-2 shrink-0">
                  <Button asChild variant="outline" size="sm">
                    {/* S-perf-1: 試験一覧 N 件分の Link が viewport 内で
                        並列 prefetch されると server SSR が N 件並列で走るため
                        prefetch={false}。 click 時の navigation 自体は維持、
                        遷移 fallback は loading.tsx で吸収。 */}
                    <Link href={`/app/exams/${exam.id}`} prefetch={false}>
                      詳細を見る
                    </Link>
                  </Button>
                  {/* 結合 (§7.3): 全カードを別の試験へ合流させる。元 exam は空で残す。 */}
                  <MergeExamButton
                    userId={userId}
                    examId={exam.id}
                    cardCount={exam.cardCount}
                    exams={exams}
                    moveCards={moveCards}
                    onMerged={onMerged}
                  />
                  <DeleteExamButton examId={exam.id} />
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {/* 結合の完了 toast (§7.5)。key = 操作 id で同一文言の連続表示でも
          auto-dismiss timer を張り直す (ActionToast の契約)。 */}
      {mergeToast && (
        <ActionToast
          key={mergeToast.id}
          message={mergeToast.message}
          actionLabel={mergeToastUndo ? '元に戻す' : undefined}
          onAction={
            mergeToastUndo
              ? () => void onUndoMerge(mergeToast.id, mergeToastUndo)
              : undefined
          }
          actionPending={undoPendingId === mergeToast.id}
          onClose={() => setMergeToast(null)}
        />
      )}
    </>
  )
}
