'use client'

// CardTagOptionList: 新規追加 popover (stage 2) と編集 popover の両方で使う
// option list 共通 sub-component。 このコンポーネント自体は popover を持たず、
// 親の PopoverContent 内にそのまま差し込まれる (Task 3/4 で配線)。
//
// 設計方針:
// - multi/single を selectType で切り替え。 multi は popover 開いたまま toggle、
//   single は toggle 後に onClose() を呼んで popover を閉じる。
// - 構造 separation: <div><ul></ul></div> として将来 Tag-4c の combobox 化 (検索
//   input 上部追加) に対応できる余地を残す。
// - 0 件のとき: placeholder + タグ管理 link。 1 件以上のとき: ul のみ。
// - a11y: role="menuitemcheckbox" (multi) / "menuitemradio" (single)、
//   aria-checked で選択状態を伝達。

import Link from 'next/link'
import { Check, Ellipsis } from 'lucide-react'

import type { ClientTagOption } from '@/lib/client-db'
import { colorToClass } from '@/lib/tags/color-palette'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  options: ClientTagOption[]
  selectedOptionIds: Set<string>
  selectType: 'single' | 'multi'
  onToggle: (optionId: string) => void
  /** single 選択時に popover を閉じるための callback。 親 popover から渡す。 */
  onClose?: () => void
  /** option 行末尾の kebab (「...」) click 時に optionId で呼ばれる callback。
   *  提供時のみ kebab を表示する。 Tag-4c-1 Task 3 で追加。 */
  onRowAction?: (optionId: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CardTagOptionList({
  options,
  selectedOptionIds,
  selectType,
  onToggle,
  onClose,
  onRowAction,
}: Props) {
  const handleClick = (optionId: string) => {
    onToggle(optionId)
    if (selectType === 'single') {
      onClose?.()
    }
  }

  if (options.length === 0) {
    return (
      <div className="px-2 py-3 text-center">
        <p className="mb-2 text-sm text-slate-500">
          このカテゴリには option がありません
        </p>
        <Link
          href="/app/tags"
          prefetch={false}
          className="text-sm text-slate-600 underline-offset-2 hover:underline"
        >
          タグ管理 →
        </Link>
      </div>
    )
  }

  return (
    <div>
      {/* 将来: <input> 検索 field (Tag-4c) */}
      <ul role="menu">
        {options.map((option) => {
          const selected = selectedOptionIds.has(option.id)
          const role =
            selectType === 'multi' ? 'menuitemcheckbox' : 'menuitemradio'

          return (
            <li key={option.id} className="flex items-center">
              <button
                type="button"
                role={role}
                aria-checked={selected}
                aria-label={option.name}
                onClick={() => handleClick(option.id)}
                className={cn(
                  'flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  'transition-colors hover:bg-slate-100',
                )}
              >
                {/* color pill */}
                <span
                  className={cn(
                    'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium',
                    colorToClass(option.color),
                  )}
                  aria-hidden="true"
                >
                  {option.name}
                </span>
                {/* check icon: selected のみ表示 */}
                {selected && (
                  <Check
                    className="ml-auto h-4 w-4 shrink-0 text-slate-700"
                    data-testid={`check-${option.id}`}
                    aria-hidden="true"
                  />
                )}
              </button>
              {/* kebab: onRowAction が渡されたときのみ表示 */}
              {onRowAction && (
                <button
                  type="button"
                  aria-label={`option 操作: ${option.name}`}
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRowAction(option.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation()
                      e.preventDefault()
                      onRowAction(option.id)
                    }
                  }}
                  className="ml-auto inline-flex h-7 w-7 items-center justify-center cursor-pointer hover:bg-slate-100 rounded"
                >
                  <Ellipsis className="h-4 w-4 text-slate-500" aria-hidden="true" />
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
