// ExamCardTableAddFooter — テーブルビュー末尾「＋ カードを追加」footer 行。
// row-ux spec §8.1 / kickoff 決定 8。作成ロジック本体 (id 採番 + buildEmptyCard +
// mirror insert + outbox enqueue) は useAddCard hook (Row-UX sprint Task 3) を消費する
// だけ — ここに残るのは呼出側の関心 (gating / error UI) のみ。
//
// gating は 3 条件 (disabled = !dataReady || positionLocked || movePending):
//   - dataReady: 親の liveData 未解決中 (undefined) は data が [] に畳まれており、
//     この一瞬に click が通ると空 baseOrders で先頭に採番されてしまう。理由表示はしない
//     (読込中の一瞬であり「ロック」ではないため)。
//   - positionLocked: ソート/フィルタ適用中。新カードは表示条件に合致するとは限らず
//     「押したのに何も起きない」に見えるため理由を表示する。
//   - movePending: card_move と create は wire が別でも同じ base_order 空間を更新する。
//     move の snapshot 読取 → 再採番計算 → 書込の途中に並走 create が入ると、その新 card が
//     assignment から漏れて「末尾追加」の不変条件が破れる。理由表示はしない (一時状態)。
//
// 'use client' は付けない: 親 exam-card-table (= 'use client') からのみ import される子
// (exam-card-row-menu と同 pattern。 file 自体に付けると Next.js TS plugin が
// function 型 prop を Server Action として誤検出する)。

import { useState } from 'react'

import { useAddCard } from '../_hooks/use-add-card'

export const ADD_CARD_LOCKED_REASON =
  'ソート/フィルタ適用中はカードを追加できません(解除すると追加できます)'

type ExamCardTableAddFooterProps = {
  userId: string
  examId: string
  // buildEmptyCard 呼出契約 (lib/cards/empty-card.ts:22-23): 対象 exam の全 card の
  // base_order / 件数を渡すこと。 表示中のフィルタ後や sort 後の部分集合を渡してはならない
  // (末尾でない位置に採番される)。
  baseOrders: number[]
  count: number
  colSpan: number
  dataReady: boolean
  positionLocked: boolean
  movePending: boolean
}

export function ExamCardTableAddFooter({
  userId,
  examId,
  baseOrders,
  count,
  colSpan,
  dataReady,
  positionLocked,
  movePending,
}: ExamCardTableAddFooterProps) {
  const { addCard } = useAddCard({ userId, examId })
  const [error, setError] = useState<string | null>(null)

  // onIdMinted は使わない (spec scope 外: 追加後の auto-edit / auto-scroll はしない)。
  const disabled = !dataReady || positionLocked || movePending

  const handleClick = async () => {
    // click 冒頭で stale error をクリア (カードビュー handleAddCard と同 pattern —
    // 失敗後の再試行で古い error 表示を残さない)。
    setError(null)
    try {
      await addCard(baseOrders, count)
    } catch {
      // hook が rethrow した場合のみ到達。表示は呼出側の責務 (hook の JSDoc 契約)。
      setError('カードの追加に失敗しました。')
    }
  }

  return (
    <tfoot>
      <tr>
        {/* Fix-3 T1 の per-column 幅 CSS 変数 / td 密度 (py-1/px-1) test は tbody 内の
            per-column td を対象にしたもの (exam-card-table.test.tsx で tbody 限定に更新済)。
            この td は colSpan で全列を跨ぐ summary cell のため対象外。 */}
        <td colSpan={colSpan} className="border-t border-border p-1">
          {/* 横スクロール時も左端可視 (spec §8.1)。 */}
          <div className="sticky left-0 w-fit">
            <button
              type="button"
              onClick={handleClick}
              disabled={disabled}
              title={positionLocked ? ADD_CARD_LOCKED_REASON : undefined}
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              ＋ カードを追加
            </button>
            {positionLocked && (
              <p className="mt-1 text-xs text-muted-foreground">{ADD_CARD_LOCKED_REASON}</p>
            )}
            {error && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {error}
              </p>
            )}
          </div>
        </td>
      </tr>
    </tfoot>
  )
}
