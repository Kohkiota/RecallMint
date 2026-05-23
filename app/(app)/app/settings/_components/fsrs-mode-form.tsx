'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveFsrsMode } from '../_actions/save-fsrs-mode'

/**
 * FSRS モード toggle (S2.2 §T2)。
 *
 * UI: 既存 components/ui に Switch primitive が無いため、 native
 * `<input type="checkbox">` を toggle 風に CSS で装飾する。
 * 操作 → 即 saveFsrsMode action 呼び出し (save ボタン不要)。
 * 成功時: router.refresh() で server component の値を再取得。
 * 失敗時: error UI を表示し optimistic update を rollback。
 */
export function FsrsModeForm({ initial }: { initial: boolean }) {
  const [checked, setChecked] = useState<boolean>(initial)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const handleToggle = () => {
    const next = !checked
    // Optimistic update: UI を先に反映、 失敗時に rollback
    setChecked(next)
    setError(null)

    startTransition(async () => {
      const result = await saveFsrsMode(next)
      if (result.ok) {
        router.refresh()
      } else {
        setError(result.error)
        // rollback
        setChecked(!next)
      }
    })
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <span
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            checked ? 'bg-emerald-600' : 'bg-slate-300'
          } ${pending ? 'opacity-50' : ''}`}
        >
          <input
            type="checkbox"
            aria-label="FSRSモード (上級)"
            checked={checked}
            onChange={handleToggle}
            disabled={pending}
            className="sr-only"
          />
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              checked ? 'translate-x-5' : 'translate-x-0.5'
            }`}
            aria-hidden="true"
          />
        </span>
        <span className="text-sm text-slate-700">FSRSモード (上級)</span>
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
