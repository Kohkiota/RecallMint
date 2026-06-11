'use client'

// per-card 削除ボタン (spec §3.4)。 confirm 2 段 UI + local-first 削除。
//
// delete-exam-button.tsx と同じ 2-phase confirm パターン (idle → confirm →
// deleting / error) を card 粒度に適用。 undo なし。
//
// Task 4.3: server action 直叩き / router.refresh() を廃止し local-first 化。
// mirror remove (楽観反映 → useLiveQuery が一覧から即座に消す) + outbox enqueue
// (op='delete') + 即時 drain。 最後の 1 枚削除も許容 (guard なし)。 card_count は
// mirror の card 行数で算出するため、 remove がそのまま件数表示に反映される
// (exam.card_count は別 decrement しない。 真の確定値は server 適用後の pull-back で収束)。

import { useState, useTransition } from 'react'
import { getClientDb } from '@/lib/client-db'
import { runOptimisticMutation } from '@/lib/sync/optimistic-mutation'
import { Button } from '@/components/ui/button'

type Phase = 'idle' | 'confirm' | 'deleting' | 'error'

interface Props {
  cardId: string
}

export function DeleteCardButton({ cardId }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const onConfirmDelete = () => {
    setPhase('deleting')
    setErrorMsg(null)
    startTransition(async () => {
      const db = getClientDb()
      try {
        // mirror remove + outbox enqueue (op='delete') を 1 Dexie rw tx に閉じる
        // (`runOptimisticMutation` helper)。 enqueue throw で Dexie auto-rollback により
        // mirror delete も巻き戻り、 user 通知 (error UI) を維持するため throwOnError=true。
        // 即時 drain は helper 内蔵 fire-and-forget。
        await runOptimisticMutation({
          stores: [db.cards],
          mutate: () => db.cards.delete(cardId),
          mutations: [
            {
              entity_type: 'card',
              entity_id: cardId,
              op: 'delete',
              patch: {},
            },
          ],
          logEvent: 'card_inline.delete.tx_failed',
          logContext: { cardId },
          throwOnError: true,
        })
      } catch {
        setErrorMsg('カードの削除に失敗しました。')
        setPhase('error')
        return
      }
    })
  }

  if (phase === 'idle') {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setPhase('confirm')}
        className="border-red-300 text-red-700 hover:bg-red-50"
      >
        削除
      </Button>
    )
  }

  if (phase === 'confirm') {
    return (
      <div className="space-y-2">
        <div className="text-xs text-red-700 space-y-1">
          <p className="font-medium">このカードを削除しますか?</p>
          <p>カードと学習履歴が削除され、元に戻せません。</p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onConfirmDelete}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            削除する
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPhase('idle')}
          >
            キャンセル
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'deleting') {
    return (
      <Button
        disabled
        size="sm"
        className="bg-red-600 text-white"
      >
        削除中…
      </Button>
    )
  }

  // phase === 'error'
  return (
    <div className="space-y-2">
      {errorMsg && <p className="text-red-600 text-xs">{errorMsg}</p>}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setPhase('confirm')
            setErrorMsg(null)
          }}
          className="border-red-300 text-red-700 hover:bg-red-50"
        >
          再試行
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setPhase('idle')
            setErrorMsg(null)
          }}
        >
          キャンセル
        </Button>
      </div>
    </div>
  )
}
