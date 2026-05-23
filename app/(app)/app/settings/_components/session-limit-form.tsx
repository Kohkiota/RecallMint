'use client'

import { useEffect, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { saveSessionLimit } from '../_actions/save-session-limit'

const PRESETS = [10, 20, 50] as const
type Preset = (typeof PRESETS)[number]

type Message = { kind: 'ok' | 'err'; text: string }

/**
 * Free-form session_limit input。
 *
 * B1 fix (S2.2 §T2): value を string state で保持し、 onChange で
 * `replace(/^0+(?=\d)/, '')` で先頭ゼロを strip する。 空文字 / "0" は
 * temporal に許可 (途中編集を妨げないため)、 範囲 validation は server
 * action saveSessionLimit (1-200) に集約する。
 */
export function SessionLimitForm({ initial }: { initial: number }) {
  const [value, setValue] = useState<string>(String(initial))
  const [message, setMessage] = useState<Message | null>(null)
  const [pending, startTransition] = useTransition()

  // 現在 value を number に変換した値 (preset active 比較 / save 送信用)。
  // 非数値・空文字は NaN、 ボタン disabled / save 拒否で扱う。
  const numericValue = value === '' ? NaN : Number(value)

  // value が変わったら message を reset (preset click / input change 共通)。
  // useEffect 経由にして React 19 transition と setState の batching 順序に依らず
  // deterministic に消す (S2.2 I-1 fix: 直接 setMessage(null) を並列に呼ぶと
  // 1/6 程度で flake していた)。
  useEffect(() => {
    setMessage(null)
  }, [value])

  const handlePresetClick = (preset: Preset) => {
    setValue(String(preset))
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // 先頭ゼロを strip (ただし "0" 単独 / "" は維持)。 (?=\d) で 1 桁の 0 を温存
    const stripped = e.target.value.replace(/^0+(?=\d)/, '')
    setValue(stripped)
  }

  const handleSave = () => {
    setMessage(null)
    startTransition(async () => {
      const result = await saveSessionLimit(numericValue)
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
            variant={numericValue === preset ? 'default' : 'outline'}
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
