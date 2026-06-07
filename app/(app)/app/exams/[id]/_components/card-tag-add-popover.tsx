'use client'

// CardTagAddPopover: 「+ タグを追加」 button trigger の 2 stage popover。
// stage 1: カテゴリ選択 (created_at ASC sort)
// stage 2: 選択カテゴリの option 選択 (CardTagOptionList)
// Esc 挙動 (Notion 方式): stage 2 → stage 1 / stage 1 → close。
// popover close 時は stage を 'category' にリセット (再開は常に stage 1)。
//
// 設計参照: docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md §4/§5

import * as React from 'react'
import Link from 'next/link'
import { Plus, CheckSquare, Circle, ChevronLeft, ChevronRight } from 'lucide-react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

import { CardTagOptionList } from './card-tag-option-list'

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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CardTagAddPopover({
  categories,
  options,
  allAssignedOptionIds,
  onToggle,
}: Props) {
  const [open, setOpen] = React.useState(false)
  const [stage, setStage] = React.useState<'category' | 'option'>('category')
  const [selectedCategoryId, setSelectedCategoryId] = React.useState<string | null>(null)

  // 親が pre-sort してくれている保証はないため描画前に created_at ASC に固定。
  const sortedCategories = React.useMemo(
    () =>
      [...categories].sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
      ),
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
      .sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
      )
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

  // footerを表示するかどうかの判定
  // 0 件のときは placeholder 内に既に link があるため footer を非表示にして重複を防ぐ。
  const showFooter =
    stage === 'category'
      ? sortedCategories.length > 0
      : categoryOptions.length > 0

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      // closed → 再開時は stage 1 から始まるようにリセット
      setStage('category')
      setSelectedCategoryId(null)
    }
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
          <span>タグを追加</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-auto max-w-sm p-0"
        onEscapeKeyDown={(e) => {
          // Notion 方式: stage 2 の Esc は stage 1 に戻るだけ (close しない)
          if (stage === 'option') {
            e.preventDefault()
            setStage('category')
          }
          // stage 'category' の Esc は shadcn 標準 (popover を close)
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
                      <li key={category.id}>
                        <button
                          type="button"
                          role="menuitem"
                          aria-label={`カテゴリ: ${category.name} (${category.select_type === 'multi' ? '複数選択' : '単一選択'})`}
                          onClick={() => {
                            setSelectedCategoryId(category.id)
                            setStage('option')
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-100"
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
