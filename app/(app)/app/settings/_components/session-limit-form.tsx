'use client'

import { useState, useTransition } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ActionResult } from '@/lib/actions/result'

const PRESETS = [10, 20, 50] as const
type Preset = (typeof PRESETS)[number]

// Message に value を同梱して atomic state 化 (S2.2.5 で savedValue を別 state にしていた
// 構造は、 transition 内 2 件の setState 順序が React 19 で稀に interleave されて
// 1/10 程度の race が残った)。 単一 state に集約することで commit 時に必ず {kind, text, value}
// が atomic に揃い、 部分 commit 由来の race を構造的に消す。
type Message = { kind: 'ok' | 'err'; text: string; value: string }

// 上限なし (null 送信) 時の message.value sentinel。
// 数値入力の value 文字列 (例: "20") と衝突しない文字列を選ぶ。
// 上限なし保存後に「保存しました」が表示される条件: unlimited=true かつ value==='∞'。
// ユーザーが unlimited を外して数値入力に戻ると value が変化するため message が即消える。
const UNLIMITED_SENTINEL = '∞'

/**
 * Free-form session_limit input。
 *
 * B1 fix (S2.2 §T2): value を string state で保持し、 onChange で
 * `replace(/^0+(?=\d)/, '')` で先頭ゼロを strip する。 空文字 / "0" は
 * temporal に許可 (途中編集を妨げないため)、 範囲 validation は server
 * action (1-200) に集約する。
 *
 * Props:
 *   initial  — DB から読み込んだ値 (null = 上限なし、数値 = 上限あり、行不在時は呼び出し側が 20 を渡す)
 *   onSaveAction   — 保存 action (number | null)。 モジュール直 import 不可、呼び出し側が渡す
 *   label    — フォーム上部の小見出し (スマート復習 / カスタム演習 等)
 */
export function SessionLimitForm({
  initial,
  onSaveAction,
  label,
}: {
  initial: number | null
  onSaveAction: (v: number | null) => Promise<ActionResult<void>>
  label?: string
}) {
  // unlimited: initial===null で上限なしモード開始、数値なら false
  const [unlimited, setUnlimited] = useState<boolean>(initial === null)
  // value: unlimited 時は UNLIMITED_SENTINEL を保持して message guard が機能するようにする
  const [value, setValue] = useState<string>(
    initial === null ? UNLIMITED_SENTINEL : String(initial),
  )
  const [message, setMessage] = useState<Message | null>(null)
  const [pending, startTransition] = useTransition()

  // 現在 value を number に変換した値 (preset active 比較 / save 送信用)。
  // 非数値・空文字は NaN、 ボタン disabled / save 拒否で扱う。
  const numericValue = value === '' || value === UNLIMITED_SENTINEL ? NaN : Number(value)

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

  const handleUnlimitedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked
    // flushSync で unlimited + value を同一フレームに commit し message.value guard との race を防ぐ
    flushSync(() => {
      setUnlimited(next)
      if (next) {
        // unlimited ON: sentinel にセットして成功 message guard が「∞」と比較できるようにする
        setValue(UNLIMITED_SENTINEL)
      } else {
        // unlimited OFF: 直前の initial (数値) を復元。 initial null だった場合は 20 をデフォルト
        setValue(String(initial ?? 20))
      }
    })
    // 上限なし toggle の操作で表示中の message をクリア (value が変わるので guard が消すが
    // unlimited 変更自体もユーザーの意図変更なので明示クリアしておく)
    setMessage(null)
  }

  const handleSave = () => {
    setMessage(null)
    // unlimited 時は UNLIMITED_SENTINEL を submittedValue にする。
    // 後で result が戻ったとき value === message.value の比較で
    // unlimited=true かつ value=UNLIMITED_SENTINEL → 表示 ON になる。
    const submittedValue = unlimited ? UNLIMITED_SENTINEL : value
    const submitArg: number | null = unlimited ? null : numericValue
    startTransition(async () => {
      const result = await onSaveAction(submitArg)
      // single atomic setState — kind/text/value が同時に commit され部分反映 race なし
      if (result.ok) {
        setMessage({ kind: 'ok', text: '保存しました', value: submittedValue })
      } else {
        setMessage({ kind: 'err', text: result.error, value: submittedValue })
      }
    })
  }

  return (
    <div className="space-y-1.5">
      {/* 任意ラベル (スマート復習 / カスタム演習 等) */}
      {label && <p className="text-xs font-medium text-slate-600">{label}</p>}

      {/* 横一列: preset / input / 上限なし toggle / 保存 — flex-wrap で 375px でも overflow しない */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Preset buttons — unlimited 時は disabled */}
        {PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={!unlimited && numericValue === preset ? 'default' : 'outline'}
            onClick={() => handlePresetClick(preset)}
            disabled={pending || unlimited}
          >
            {preset}
          </Button>
        ))}

        {/* Free-form number input — unlimited 時は disabled */}
        <Input
          type="number"
          min="1"
          max="200"
          value={unlimited ? '' : value}
          onChange={handleInputChange}
          disabled={pending || unlimited}
          className="w-20"
          aria-label="セッション枚数"
        />

        {/* 上限なし toggle */}
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            aria-label="上限なし"
            checked={unlimited}
            onChange={handleUnlimitedChange}
            disabled={pending}
            className="h-4 w-4 rounded border-slate-300 text-emerald-600 accent-emerald-600"
          />
          <span className="text-sm text-slate-700">上限なし</span>
        </label>

        {/* Save button */}
        <Button type="button" size="sm" onClick={handleSave} disabled={pending}>
          保存
        </Button>
      </div>

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
