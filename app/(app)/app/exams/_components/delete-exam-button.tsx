'use client'

// exam 削除ボタン。confirm 2 段 UI + useTransition で deleteExam server action を呼ぶ。
//
// Clerk reverification (useReverification) を使わない理由:
//   deleteExam は自前 DB の DELETE のみで Clerk API を一切呼ばない。
//   useReverification が必要なのは Clerk 側が sensitive action
//   (user.delete() 等) を要求する場合のみ。
//   account 削除 (settings/delete-button.tsx) が useReverification を使うのは
//   Clerk の user.delete() 側の要件であり、exam 削除には該当しない。

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { deleteExam } from '@/app/(app)/app/exams/_actions/delete-exam'

type Phase = 'idle' | 'confirm' | 'deleting' | 'error'

interface Props {
  examId: string
}

export function DeleteExamButton({ examId }: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const onConfirmDelete = () => {
    setPhase('deleting')
    setErrorMsg(null)
    startTransition(async () => {
      const result = await deleteExam(examId)
      if (result.ok) {
        // server action 内で revalidatePath 済みだが、client router cache も
        // 更新するため router.refresh() を呼ぶ。削除された exam 行ごと
        // unmount されるため phase 更新は不要。
        router.refresh()
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
          <p className="font-medium">この試験を削除しますか?</p>
          <p>含まれるカードと学習履歴もすべて削除され、元に戻せません。</p>
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
