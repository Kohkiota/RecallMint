'use client'

// tag manager 左 column のカテゴリ 1 行 component。
// - カテゴリ名 click で in-place rename (Enter / blur で確定、 Esc / 空文字でキャンセル)
// - 確定値は `enqueueEntityMutation({entity_type:'tag_category', op:'update_field',
//   patch:{field:'name', value}})` → `runGuardedEntityMutationFlush()` で同期
// - select_type バッジは表示のみ (作成後 immutable、 spec §1.2)
// - 行末「カテゴリ削除」 button は親 (CategoryList) に onDelete callback で委譲
//   (影響範囲 count + ConfirmDialog 表示は親が orchestrate する)
// - row 全体 click で `onSelect(category.id)` — rename input click はイベント停止して
//   active 切替が起きないようにする
//
// 既存 inline-text-field.tsx の rename UX を踏襲しつつ、 タグ用は独立 component として
// コピー (OT 方針「タグ用は別実装」、 DRY より局所単純さ優先)。
// debounce drain は inline-text-field と同じ 500ms (連続編集の drain trigger 圧縮)。

import * as React from 'react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import type { ClientTagCategory } from '@/lib/client-db'

type Props = {
  category: ClientTagCategory
  active: boolean
  onSelect: (id: string) => void
  // 親が ConfirmDialog 表示 + 削除 mutation 発行を担当する。
  onDelete: (category: ClientTagCategory) => void
}

const DEBOUNCE_MS = 500

export function CategoryRow({ category, active, onSelect, onDelete }: Props) {
  const [editing, setEditing] = React.useState(false)
  const [value, setValue] = React.useState(category.name)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // 編集中以外は外部 prop (server pull 反映) で display を同期する。
  React.useEffect(() => {
    if (editing) return
    setValue(category.name)
  }, [category.name, editing])

  React.useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [])

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const startEdit = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setValue(category.name)
  }

  const commit = (next: string) => {
    void enqueueEntityMutation({
      entity_type: 'tag_category',
      entity_id: category.id,
      op: 'update_field',
      patch: { field: 'name', value: next },
    }).catch((err) => {
      logger.warn({
        event: 'tag_category_inline.enqueue_failed',
        categoryId: category.id,
        err: String(err),
      })
    })
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void runGuardedEntityMutationFlush().catch(() => {})
    }, DEBOUNCE_MS)
  }

  const handleBlur = () => {
    setEditing(false)
    const trimmed = value.trim()
    // 空 / 値変更なしは commit しない (元値復元、 outbox 行を減らす)。
    if (trimmed.length === 0 || trimmed === category.name) {
      setValue(category.name)
      return
    }
    commit(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      // blur 経由で確定 (handleBlur が空 / 値変更なし short-circuit を担う)。
      ;(e.target as HTMLInputElement).blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  const handleRowClick = () => {
    onSelect(category.id)
  }

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(category)
  }

  return (
    <div
      onClick={handleRowClick}
      className={cn(
        'flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:bg-slate-50 cursor-pointer',
        active && 'bg-slate-100 border-slate-200',
      )}
    >
      <div className="flex-1 min-w-0">
        {editing ? (
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            aria-label="カテゴリ名 編集"
            className="h-8 text-sm"
          />
        ) : (
          <button
            type="button"
            onClick={startEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                startEdit(e)
              }
            }}
            aria-label="カテゴリ名 編集"
            className="w-full text-left text-sm font-medium text-slate-900 truncate hover:text-slate-700"
          >
            {category.name}
          </button>
        )}
      </div>

      <span
        className="shrink-0 rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600"
        aria-label={`タイプ: ${category.select_type}`}
      >
        {category.select_type}
      </span>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleDeleteClick}
        aria-label="カテゴリ削除"
        className="shrink-0 h-8 w-8 p-0 text-slate-500 hover:text-red-600"
      >
        ×
      </Button>
    </div>
  )
}
