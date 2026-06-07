'use client'

// CardTagPill: 1 つのタグ option を pill (色付き + ×) で表示する presentational
// component。 option.color を colorToClass で Tailwind class に解決し、 ×
// button click で onRemove を呼ぶ。 onRemove の実体 (optimistic + enqueue) は
// 親 (Task 2: CardTagsRow) が担当する。

import type { ClientTagOption } from '@/lib/client-db'
import { colorToClass } from '@/lib/tags/color-palette'

type Props = {
  option: ClientTagOption
  onRemove: () => void
}

export function CardTagPill({ option, onRemove }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${colorToClass(option.color)}`}
    >
      <span>{option.name}</span>
      <button
        type="button"
        aria-label={`タグ削除: ${option.name}`}
        onClick={onRemove}
        className="ml-0.5 leading-none hover:text-slate-900"
      >
        ×
      </button>
    </span>
  )
}
