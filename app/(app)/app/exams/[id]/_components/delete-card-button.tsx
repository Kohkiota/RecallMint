'use client'

// per-card 削除ボタン (spec §3.4)。 confirm 2 段 UI + useTransition で
// deleteCard server action を呼ぶ。
//
// delete-exam-button.tsx と同じ 2-phase confirm パターン (idle → confirm →
// deleting / error) を card 粒度に適用。 undo なし。
// 成功時は router.refresh() で一覧を再取得 (tombstone + card 物理削除反映)。

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { deleteCard } from '../_actions/delete-card'
import { runGuardedPull } from '@/lib/sync/pull'

type Phase = 'idle' | 'confirm' | 'deleting' | 'error'

interface Props {
  cardId: string
}

export function DeleteCardButton({ cardId }: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const onConfirmDelete = () => {
    setPhase('deleting')
    setErrorMsg(null)
    startTransition(async () => {
      const result = await deleteCard(cardId)
      if (result.ok) {
        router.refresh()
        // 一覧が Dexie 参照のため、カード削除後に mirror を pull で最新化する。
        void runGuardedPull({ reason: 'card-delete' }).catch(() => {})
      } else {
        setErrorMsg(result.error)
        setPhase('error')
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
