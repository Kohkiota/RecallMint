'use client'

// 試験手動作成フォーム。
// 「＋ 手動で試験を作成」ボタンでインライン展開し、 名前入力 + 作成ボタンを表示。
// 作成成功時は router.push で試験詳細画面に遷移する。

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createExam } from '@/app/(app)/app/exams/_actions/create-exam'
import { runGuardedPull } from '@/lib/sync/pull'

type Phase = 'collapsed' | 'expanded' | 'submitting'

export function CreateExamForm() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('collapsed')
  const [name, setName] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const onOpen = () => {
    setPhase('expanded')
    setName('')
    setErrorMsg(null)
  }

  const onClose = () => {
    setPhase('collapsed')
    setName('')
    setErrorMsg(null)
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setErrorMsg(null)
    setPhase('submitting')
    startTransition(async () => {
      const result = await createExam(name)
      if (result.ok) {
        router.push(`/app/exams/${result.data?.examId}`)
        // 一覧が Dexie 参照のため、exam 作成後に mirror を pull で最新化する。
        // router.push で詳細へ遷移後も runGuardedPull は module-scope で継続し
        // mirror に新 exam を取り込むため、一覧に戻った時点で反映済み (即時表示は不要)。
        void runGuardedPull({ reason: 'exam-create' }).catch(() => {})
      } else {
        setErrorMsg(result.error)
        setPhase('expanded')
      }
    })
  }

  if (phase === 'collapsed') {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={onOpen}
        className="flex items-center gap-1"
        data-create-exam-trigger
      >
        <span aria-hidden>＋</span> 手動で試験を作成
      </Button>
    )
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col sm:flex-row items-start sm:items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3"
    >
      <Input
        type="text"
        placeholder="試験名"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={phase === 'submitting'}
        className="max-w-xs"
        autoFocus
        aria-label="試験名"
        aria-invalid={errorMsg !== null}
        aria-describedby={errorMsg ? 'create-exam-error' : undefined}
      />
      {errorMsg && (
        <p id="create-exam-error" className="text-red-600 text-xs sm:order-last w-full">
          {errorMsg}
        </p>
      )}
      <div className="flex gap-2 shrink-0">
        <Button
          type="submit"
          size="sm"
          disabled={phase === 'submitting'}
        >
          {phase === 'submitting' ? '作成中…' : '作成'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          disabled={phase === 'submitting'}
          aria-label="キャンセル"
        >
          ×
        </Button>
      </div>
    </form>
  )
}
