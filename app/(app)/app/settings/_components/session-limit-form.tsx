'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { saveSessionLimit } from '../_actions/save-session-limit'

const PRESETS = [10, 20, 50] as const
type Preset = (typeof PRESETS)[number]

type Message = { kind: 'ok' | 'err'; text: string }

export function SessionLimitForm({ initial }: { initial: number }) {
  const [value, setValue] = useState<number>(initial)
  const [message, setMessage] = useState<Message | null>(null)
  const [pending, startTransition] = useTransition()

  const handlePresetClick = (preset: Preset) => {
    setValue(preset)
    setMessage(null)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value)
    if (!Number.isNaN(n)) setValue(n)
    setMessage(null)
  }

  const handleSave = () => {
    setMessage(null)
    startTransition(async () => {
      const result = await saveSessionLimit(value)
      if (result.ok) {
        setMessage({ kind: 'ok', text: '保存しました' })
      } else {
        setMessage({ kind: 'err', text: result.error })
      }
    })
  }

  return (
    <div className="space-y-3">
      {/* Preset buttons */}
      <div className="flex gap-2">
        {PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={value === preset ? 'default' : 'outline'}
            onClick={() => handlePresetClick(preset)}
            disabled={pending}
          >
            {preset}
          </Button>
        ))}
      </div>

      {/* Free-form number input */}
      <Input
        type="number"
        min="1"
        max="200"
        value={value}
        onChange={handleInputChange}
        disabled={pending}
        className="w-32"
        aria-label="セッション枚数"
      />

      {/* Save button */}
      <Button type="button" size="sm" onClick={handleSave} disabled={pending}>
        保存
      </Button>

      {/* Inline feedback message */}
      {message && (
        <p
          role={message.kind === 'err' ? 'alert' : 'status'}
          className={
            message.kind === 'err'
              ? 'text-sm text-red-600'
              : 'text-sm text-emerald-600'
          }
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
