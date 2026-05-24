'use client'

import { useState, useTransition } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { saveSessionLimit } from '../_actions/save-session-limit'

const PRESETS = [10, 20, 50] as const
type Preset = (typeof PRESETS)[number]

// Message に value を同梱して atomic state 化 (S2.2.5 で savedValue を別 state にしていた
// 構造は、 transition 内 2 件の setState 順序が React 19 で稀に interleave されて
// 1/10 程度の race が残った)。 単一 state に集約することで commit 時に必ず {kind, text, value}
// が atomic に揃い、 部分 commit 由来の race を構造的に消す。
type Message = { kind: 'ok' | 'err'; text: string; value: string }

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

  // flushSync で setValue を sync commit。 後段 derived rendering
  // (value === message.value の比較) が次 frame まで遅延せず、 transition pending 中の
  // urgent update でも race なく即時反映される (S2.2.5 で derived state 化しても
  // 1/15 残った flake を構造的に解消)。
  const handlePresetClick = (preset: Preset) => {
    flushSync(() => setValue(String(preset)))
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // 先頭ゼロを strip (ただし "0" 単独 / "" は維持)。 (?=\d) で 1 桁の 0 を温存
    const stripped = e.target.value.replace(/^0+(?=\d)/, '')
    flushSync(() => setValue(stripped))
  }

  const handleSave = () => {
    setMessage(null)
    const submittedValue = value
    startTransition(async () => {
      const result = await saveSessionLimit(numericValue)
      // single atomic setState — kind/text/value が同時に commit され部分反映 race なし
      if (result.ok) {
        setMessage({ kind: 'ok', text: '保存しました', value: submittedValue })
      } else {
        setMessage({ kind: 'err', text: result.error, value: submittedValue })
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

      {/* Inline feedback message — value が message.value と一致する間のみ表示 */}
      {message && value === message.value && (
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
