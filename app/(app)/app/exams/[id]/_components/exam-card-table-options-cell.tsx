'use client'

// exam-card-table-options-cell — read-only 選択肢表示 cell 部品。
// 各選択肢を is_correct フラグで正解ハイライト (emerald 系)。
// 編集 UI / checkbox / mutation は一切持たない。

import * as React from 'react'
import type { ClientCardOption } from '@/lib/client-db'

export function OptionsReadonlyCell({
  options,
}: {
  options: ClientCardOption[]
}): React.JSX.Element {
  if (options.length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>
  }

  return (
    <ul className="space-y-1">
      {options.map((opt) => (
        <li
          key={opt.id}
          className={
            opt.is_correct
              ? 'rounded border border-emerald-300 bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-900'
              : 'rounded border border-border/60 px-2 py-0.5 text-xs text-slate-800'
          }
        >
          <span className="font-mono text-slate-500 mr-1">{opt.id}</span>
          {opt.text}
        </li>
      ))}
    </ul>
  )
}
