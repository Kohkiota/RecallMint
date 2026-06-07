'use client'

// CardTagAddPopover: 「+ タグを追加」 button trigger の 4 stage popover。
// stage 1 (category): カテゴリ選択 (created_at ASC sort)
// stage 2 (option): 選択カテゴリの option 選択 (CardTagOptionList)
// stage 3 (editCategory): カテゴリ編集 (CardTagEditFields)
// stage 4 (editOption): option 編集 (CardTagEditFields)
//
// Esc 挙動 (Notion 方式拡張):
//   editCategory → category / editOption → option / option → category / category → close
//
// popover close 時は全 state をリセット (stage='category', editTargetId=null, lastError=null)。
//
// 設計参照: docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md §4/§5
//           Tag-4c-1 Task 3

import * as React from 'react'
import Link from 'next/link'
import { Plus, CheckSquare, Circle, ChevronLeft, ChevronRight, Ellipsis } from 'lucide-react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

import { CardTagOptionList } from './card-tag-option-list'
import { CardTagEditFields } from './card-tag-edit-fields'
import type { TagEditCallbacks } from './card-tags-section'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  /** 本 card 全カテゴリ横断の付与済み option_id 配列 */
  allAssignedOptionIds: string[]
  /** (categoryId, optionId) で呼ばれる toggle callback */
  onToggle: (categoryId: string, optionId: string) => void
  /** 編集系 callback 群 (Task 1 で section から渡す) */
  tagEditCallbacks: TagEditCallbacks
}

// ---------------------------------------------------------------------------
// Stage type
// ---------------------------------------------------------------------------

type Stage = 'category' | 'option' | 'editCategory' | 'editOption'

// ---------------------------------------------------------------------------
// Sort helper (Fix C-3 軸 1): sort_key ASC NULLS LAST, created_at ASC
// export して card-tag-edit-popover.tsx からも使用する。
// ---------------------------------------------------------------------------

/**
 * sort_key ASC NULLS LAST, created_at ASC の comparator。
 * sort_key が null の entity は末尾に配置し、 tiebreak は created_at で解消。
 */
export function sortByKeyThenCreated<T extends { sort_key?: string | null; created_at: string }>(
  a: T,
  b: T,
): number {
  const ak = a.sort_key ?? null
  const bk = b.sort_key ?? null
  if (ak !== null && bk !== null) {
    if (ak !== bk) return ak < bk ? -1 : 1
  } else if (ak !== null) {
    return -1 // a has key, b doesn't → a first (NULLS LAST)
  } else if (bk !== null) {
    return 1 // b has key, a doesn't → b first
  }
  // both null or same sort_key: tiebreak by created_at ASC
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CardTagAddPopover({
  categories,
  options,
  allAssignedOptionIds,
  onToggle,
  tagEditCallbacks,
}: Props) {
  const [open, setOpen] = React.useState(false)
  const [stage, setStage] = React.useState<Stage>('category')
  const [selectedCategoryId, setSelectedCategoryId] = React.useState<string | null>(null)
  const [editTargetId, setEditTargetId] = React.useState<string | null>(null)
  const [lastError, setLastError] = React.useState<string | null>(null)

  // Fix C-3 軸 1: sort_key ASC NULLS LAST, created_at ASC で categories を並べる。
  const sortedCategories = React.useMemo(
    () => [...categories].sort(sortByKeyThenCreated),
    [categories],
  )

  const selectedCategory =
    stage === 'option' && selectedCategoryId !== null
      ? (categories.find((c) => c.id === selectedCategoryId) ?? null)
      : null

  const categoryOptions = React.useMemo(() => {
    if (!selectedCategoryId) return []
    return options
      .filter((o) => o.category_id === selectedCategoryId)
      .sort(sortByKeyThenCreated)
  }, [options, selectedCategoryId])

  const selectedOptionIds = React.useMemo(
    () =>
      new Set(
        allAssignedOptionIds.filter((id) =>
          categoryOptions.some((o) => o.id === id),
        ),
      ),
    [allAssignedOptionIds, categoryOptions],
  )

  // 編集対象の entity を解決する。 editTargetId が null または外部で削除済みのとき null。
  const editTarget = React.useMemo(() => {
    if (stage === 'editCategory') {
      return categories.find((c) => c.id === editTargetId) ?? null
    }
    if (stage === 'editOption') {
      return options.find((o) => o.id === editTargetId) ?? null
    }
    return null
  }, [stage, editTargetId, categories, options])

  // footerを表示するかどうかの判定
  // - stage='category': カテゴリ 0 件 placeholder 内に既に link があるため footer 非表示
  // - stage='option': option 0 件 placeholder 内に link があるため footer 非表示
  // - stage='editCategory' / 'editOption': 常に表示 (edit fields は 0 件になりえない)
  const showFooter =
    stage === 'category'
      ? sortedCategories.length > 0
      : stage === 'option'
        ? categoryOptions.length > 0
        : true // editCategory / editOption は常に footer 表示

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      // closed → 再開時は stage 1 から始まるようにリセット
      setStage('category')
      setSelectedCategoryId(null)
      setEditTargetId(null)
      setLastError(null)
    }
  }

  // kebab click handlers
  const handleCategoryKebabClick = (e: React.MouseEvent, categoryId: string) => {
    e.stopPropagation()
    setEditTargetId(categoryId)
    setStage('editCategory')
    setLastError(null)
  }

  const handleCategoryKebabKeyDown = (e: React.KeyboardEvent, categoryId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation()
      e.preventDefault()
      setEditTargetId(categoryId)
      setStage('editCategory')
      setLastError(null)
    }
  }

  const handleOptionRowAction = (optionId: string) => {
    setEditTargetId(optionId)
    setStage('editOption')
    setLastError(null)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="タグを追加"
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:text-slate-700 hover:border-slate-400"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          <span>タグ</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-auto max-w-sm p-0"
        onEscapeKeyDown={(e) => {
          // Notion 方式拡張:
          // editCategory → category / editOption → option / option → category
          // category の Esc は shadcn 標準 (popover を close)
          if (stage === 'editCategory') {
            e.preventDefault()
            setStage('category')
          } else if (stage === 'editOption') {
            e.preventDefault()
            setStage('option')
          } else if (stage === 'option') {
            e.preventDefault()
            setStage('category')
          }
          // stage 'category' の Esc は何もしない → shadcn 標準で popover close
        }}
      >
        {/* ------------------------------------------------------------------ */}
        {/* Stage 1: カテゴリ選択                                               */}
        {/* ------------------------------------------------------------------ */}
        {stage === 'category' && (
          <>
            <div className="py-1">
              {sortedCategories.length === 0 ? (
                <div className="px-2 py-3 text-center">
                  <p className="mb-2 text-sm text-slate-500">
                    カテゴリがありません。 タグ管理 → でカテゴリを作成してください
                  </p>
                  <Link
                    href="/app/tags"
                    prefetch={false}
                    className="text-sm text-slate-600 underline-offset-2 hover:underline"
                  >
                    タグ管理 →
                  </Link>
                </div>
              ) : (
                <ul role="menu">
                  {sortedCategories.map((category) => {
                    const TypeIcon =
                      category.select_type === 'multi' ? CheckSquare : Circle
                    return (
                      <li key={category.id} className="flex items-center">
                        <button
                          type="button"
                          role="menuitem"
                          aria-label={`カテゴリ: ${category.name} (${category.select_type === 'multi' ? '複数選択' : '単一選択'})`}
                          onClick={() => {
                            setSelectedCategoryId(category.id)
                            setStage('option')
                          }}
                          className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-100"
                        >
                          <TypeIcon
                            aria-hidden="true"
                            className="h-4 w-4 text-slate-500"
                            data-testid={`type-icon-${category.select_type}-${category.id}`}
                          />
                          <span className="flex-1 text-left">{category.name}</span>
                          <ChevronRight
                            aria-hidden="true"
                            className="h-4 w-4 text-slate-400"
                          />
                        </button>
                        {/* kebab: カテゴリ編集 stage への入口 */}
                        <button
                          type="button"
                          aria-label={`カテゴリ操作: ${category.name}`}
                          tabIndex={0}
                          onClick={(e) => handleCategoryKebabClick(e, category.id)}
                          onKeyDown={(e) => handleCategoryKebabKeyDown(e, category.id)}
                          className="inline-flex h-7 w-7 items-center justify-center cursor-pointer hover:bg-slate-100 rounded"
                        >
                          <Ellipsis className="h-4 w-4 text-slate-500" aria-hidden="true" />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Stage 2: option 選択                                                */}
        {/* ------------------------------------------------------------------ */}
        {stage === 'option' && selectedCategory !== null && (
          <>
            <div className="px-2 pt-2">
              <button
                type="button"
                onClick={() => setStage('category')}
                aria-label="カテゴリ選択へ戻る"
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <ChevronLeft aria-hidden="true" className="h-3 w-3" />
                <span>カテゴリ選択へ戻る</span>
              </button>
            </div>
            <div className="mt-1 border-t py-1">
              <CardTagOptionList
                options={categoryOptions}
                selectedOptionIds={selectedOptionIds}
                selectType={selectedCategory.select_type}
                onToggle={(optId) => onToggle(selectedCategory.id, optId)}
                onClose={() => setOpen(false)}
                onRowAction={handleOptionRowAction}
              />
            </div>
          </>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Stage 3: カテゴリ編集 (editCategory)                               */}
        {/* ------------------------------------------------------------------ */}
        {stage === 'editCategory' && editTargetId !== null && editTarget !== null && (
          <>
            <div className="px-2 pt-2">
              <button
                type="button"
                onClick={() => setStage('category')}
                aria-label="カテゴリ選択へ戻る"
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <ChevronLeft aria-hidden="true" className="h-3 w-3" />
                <span>カテゴリ選択へ戻る</span>
              </button>
            </div>
            <div className="mt-1 border-t px-3 py-3">
              <CardTagEditFields
                kind="category"
                name={editTarget.name}
                color={editTarget.color ?? null}
                onRename={async (n) => {
                  try {
                    await tagEditCallbacks.renameCategory(editTargetId, n)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onColorChange={async (c) => {
                  try {
                    await tagEditCallbacks.setCategoryColor(editTargetId, c)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onDelete={async () => {
                  try {
                    await tagEditCallbacks.deleteCategory(editTargetId)
                    setEditTargetId(null)
                    setStage('category')
                    setLastError(null)
                  } catch {
                    setLastError('削除に失敗しました')
                  }
                }}
                countImpact={async () => {
                  return await tagEditCallbacks.countCategoryImpact(editTargetId)
                }}
                errorMessage={lastError}
              />
            </div>
          </>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Stage 4: option 編集 (editOption)                                  */}
        {/* ------------------------------------------------------------------ */}
        {stage === 'editOption' && editTargetId !== null && editTarget !== null && (
          <>
            <div className="px-2 pt-2">
              <button
                type="button"
                onClick={() => setStage('option')}
                aria-label="option 一覧へ戻る"
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <ChevronLeft aria-hidden="true" className="h-3 w-3" />
                <span>option 一覧へ戻る</span>
              </button>
            </div>
            <div className="mt-1 border-t px-3 py-3">
              <CardTagEditFields
                kind="option"
                name={editTarget.name}
                color={editTarget.color ?? null}
                onRename={async (n) => {
                  try {
                    await tagEditCallbacks.renameOption(editTargetId, n)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onColorChange={async (c) => {
                  try {
                    await tagEditCallbacks.setOptionColor(editTargetId, c)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onDelete={async () => {
                  try {
                    await tagEditCallbacks.deleteOption(editTargetId)
                    setEditTargetId(null)
                    setStage('option')
                    setLastError(null)
                  } catch {
                    setLastError('削除に失敗しました')
                  }
                }}
                countImpact={async () => {
                  return await tagEditCallbacks.countOptionImpact(editTargetId)
                }}
                errorMessage={lastError}
              />
            </div>
          </>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Footer: タグ管理 link (0 件 placeholder に link があるときは非表示)  */}
        {/* ------------------------------------------------------------------ */}
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
