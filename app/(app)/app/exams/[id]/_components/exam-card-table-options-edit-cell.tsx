'use client'

// table cell 用に選択肢を縦積みで inline 編集する compact component。
// card-view の InlineOptionRow grid (md: responsive 分岐) は使わず、
// 240px 固定列に収まる縦積みレイアウトで render する。
// write path は useCardOptions hook に委譲 — このコンポーネントは handlers を
// wiring するだけで Dexie / outbox の直接呼び出しは一切しない。

import * as React from 'react'
import type { ClientCardOption } from '@/lib/client-db'
import { useCardOptions } from '../_hooks/use-card-options'
import { InlineOptionCell } from './inline-option-row'

export function CompactOptionsCell({
  cardId,
  options: serverOptions,
}: {
  cardId: string
  options: ClientCardOption[]
}): React.JSX.Element {
  const {
    options,
    autoEditOptionId,
    canDelete,
    handleCellSave,
    handleCheckboxToggle,
    handleAddOption,
    handleDeleteOption,
  } = useCardOptions(cardId, serverOptions)

  return (
    <div className="space-y-0.5">
      {options.map((opt, idx) => (
        <div
          key={opt.id}
          className={
            opt.is_correct
              ? 'rounded border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 text-sm'
              : 'rounded border border-border/60 px-1.5 py-0.5 text-sm'
          }
        >
          {/* 1 行目: checkbox + 本文 + 削除ボタン */}
          <div className="flex items-start gap-1">
            <label className="inline-flex min-h-8 min-w-8 md:min-h-6 md:min-w-6 shrink-0 cursor-pointer items-center justify-center">
              <input
                type="checkbox"
                aria-label="選択肢 正解フラグ 編集"
                checked={opt.is_correct}
                onChange={(e) => handleCheckboxToggle(idx, e.target.checked)}
                className="h-4 w-4 cursor-pointer accent-emerald-600"
              />
            </label>
            <div className="min-w-0 flex-1">
              <InlineOptionCell
                kind="text"
                ariaLabel="選択肢 本文 編集"
                value={opt.text}
                onSave={(value) => handleCellSave(idx, { ...opt, text: value })}
                displayClassName={
                  opt.is_correct
                    ? 'text-sm font-bold text-emerald-900 md:min-h-6 md:py-0.5'
                    : 'text-sm text-slate-800 md:min-h-6 md:py-0.5'
                }
                autoEditOnMount={opt.id === autoEditOptionId}
              />
            </div>
            <button
              type="button"
              aria-label="選択肢を削除"
              onClick={() => handleDeleteOption(idx)}
              disabled={!canDelete}
              className="inline-flex min-h-8 min-w-8 md:min-h-6 md:min-w-6 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
            >
              <span className="text-base leading-none" aria-hidden="true">
                ×
              </span>
            </button>
          </div>
          {/* 2 行目: 解説 (常時表示) */}
          <div className="mt-0.5">
            <InlineOptionCell
              kind="explanation"
              ariaLabel="選択肢 解説 編集"
              value={opt.explanation ?? ''}
              onSave={(value) => {
                // 空文字は jsonb から explanation key を drop する (payload bloat 防止)。
                // card-view の InlineOptionRow と同じ semantics。
                if (value === '') {
                  const { explanation: _drop, ...rest } = opt
                  handleCellSave(idx, rest)
                } else {
                  handleCellSave(idx, { ...opt, explanation: value })
                }
              }}
              displayClassName="text-xs text-slate-600 md:min-h-6 md:py-0.5"
              placeholder="解説 (クリックで追加)"
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={handleAddOption}
        className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        + 選択肢を追加
      </button>
    </div>
  )
}
