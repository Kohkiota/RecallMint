'use client'

// CardTagEditPopover: バッジ click で開く popover。
// stage='option' (option list with kebab) → stage='editOption' (CardTagEditFields)。
//
// 内部 state:
//   open: popover 開閉
//   stage: 'option' | 'editOption'
//   editTargetId: kebab click で選択された option_id
//   lastError: onRename / onColorChange / onDelete が throw したときの inline error
//
// Esc 階層:
//   editOption → option (onEscapeKeyDown で preventDefault + setStage)
//   option → close (shadcn 標準)
//
// 設計参照: docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md §3/§5
//           Tag-4c-1 Task 4

import * as React from 'react'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

import { CardTagOptionList } from './card-tag-option-list'
import { CardTagEditFields } from './card-tag-edit-fields'
import type { TagEditCallbacks } from './card-tags-section'
import { sortByKeyThenCreated } from './card-tag-add-popover'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  category: ClientTagCategory
  /** 当該カテゴリ配下の全 option (created_at ASC 推奨) */
  categoryOptions: ClientTagOption[]
  /** 当該カテゴリで付与済みの option_id set */
  selectedOptionIds: Set<string>
  /** option toggle callback。 parent (section) で (optionId) => onToggle(cat.id, optionId) に bind */
  onToggle: (optionId: string) => void
  /** rename / color / delete の mutation callbacks (section から受け取る) */
  tagEditCallbacks: TagEditCallbacks
  /** trigger element (CardTagBadge)。 asChild で Radix trigger と merge される */
  children: React.ReactNode
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CardTagEditPopover({
  category,
  categoryOptions,
  selectedOptionIds,
  onToggle,
  tagEditCallbacks,
  children,
}: Props) {
  const [open, setOpen] = React.useState(false)
  const [stage, setStage] = React.useState<'option' | 'editOption'>('option')
  const [editTargetId, setEditTargetId] = React.useState<string | null>(null)
  const [lastError, setLastError] = React.useState<string | null>(null)

  // Fix C-3 軸 1: categoryOptions を sort_key ASC NULLS LAST, created_at ASC で並べる。
  // 親から unsorted で渡される可能性があるため、 描画前に正規化する。
  const sortedCategoryOptions = React.useMemo(
    () => [...categoryOptions].sort(sortByKeyThenCreated),
    [categoryOptions],
  )

  // editTarget: editOption stage かつ editTargetId が非 null のときのみ解決する。
  // categoryOptions から find して null に fallback (deleted option への defensive 対応)。
  const editTarget =
    stage === 'editOption' && editTargetId !== null
      ? (categoryOptions.find((o) => o.id === editTargetId) ?? null)
      : null

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      // popover を閉じるときに全 state をリセットする。
      // 再 open 時に option list から始まるよう保証する。
      setStage('option')
      setEditTargetId(null)
      setLastError(null)
    }
  }

  const handleRowAction = (optionId: string) => {
    setEditTargetId(optionId)
    setStage('editOption')
    setLastError(null)
  }

  // footer: option stage では sortedCategoryOptions.length > 0 の場合のみ表示。
  // editOption stage では常時表示 (back button と並存)。
  const showFooter = stage === 'option' ? sortedCategoryOptions.length > 0 : true

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-auto max-w-sm p-0"
        onEscapeKeyDown={(e) => {
          if (stage === 'editOption') {
            // Esc を consume して option stage に戻す。 popover は閉じない。
            e.preventDefault()
            setStage('option')
          }
          // stage='option' の Esc は shadcn 標準 (popover 閉じる)
        }}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Stage: option list                                                */}
        {/* ---------------------------------------------------------------- */}
        {stage === 'option' && (
          <>
            <div className="border-b px-3 py-2 text-sm font-medium text-slate-700">
              {category.name} を編集
            </div>
            <div className="py-1">
              <CardTagOptionList
                options={sortedCategoryOptions}
                selectedOptionIds={selectedOptionIds}
                selectType={category.select_type}
                onToggle={onToggle}
                onClose={() => setOpen(false)}
                onRowAction={handleRowAction}
              />
            </div>
          </>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Stage: editOption                                                 */}
        {/* editTarget が null (deleted option など) のときは何も描画しない。  */}
        {/* ---------------------------------------------------------------- */}
        {stage === 'editOption' && editTarget !== null && (
          <>
            <div className="px-2 pt-2">
              <button
                type="button"
                onClick={() => setStage('option')}
                aria-label="タグ一覧へ戻る"
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <ChevronLeft aria-hidden="true" className="h-3 w-3" />
                <span>タグ一覧へ戻る</span>
              </button>
            </div>
            <div className="mt-1 border-t px-3 py-2">
              <CardTagEditFields
                kind="option"
                name={editTarget.name}
                color={editTarget.color ?? null}
                onRename={async (n) => {
                  try {
                    await tagEditCallbacks.renameOption(editTargetId!, n)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onColorChange={async (c) => {
                  try {
                    await tagEditCallbacks.setOptionColor(editTargetId!, c)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onDelete={async () => {
                  try {
                    await tagEditCallbacks.deleteOption(editTargetId!)
                    // 削除成功時: parent の useLiveQuery が再描画してバッジ自体が
                    // unmount される → PopoverTrigger も消えて popover が自然に閉じる。
                    // 明示的な close は不要 (radix standard)。
                  } catch {
                    setLastError('削除に失敗しました')
                  }
                }}
                countImpact={() => tagEditCallbacks.countOptionImpact(editTargetId!)}
                errorMessage={lastError}
              />
            </div>
          </>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Footer: タグ管理 link                                             */}
        {/* option stage は categoryOptions.length > 0 のときのみ表示 (0 件   */}
        {/* は CardTagOptionList 内の placeholder に link が含まれる)。        */}
        {/* editOption stage は常時表示。                                      */}
        {/* ---------------------------------------------------------------- */}
        {showFooter && (
          <div className="border-t px-3 py-2">
            <Link
              href="/app/tags"
              prefetch={false}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              タグ管理 →
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
