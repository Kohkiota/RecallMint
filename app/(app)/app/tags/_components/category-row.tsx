'use client'

// tag manager 左 column のカテゴリ 1 行 component。
// - row 全体 click で `onSelect(category.id)` (active 切替)。 a11y のため
//   role="button" + tabIndex=0 + onKeyDown Enter/Space。 Tag-4a-fix Task 2 で
//   「name button が DOM 大部分を覆って rename 誤起動」 を解消した。
// - 名前は static `<span>` で表示し、 横の pen icon button (lucide Pencil、
//   aria-label="編集") を rename trigger として明示配置 (stopPropagation で row
//   click と分離)。 編集モードでは pen icon を消し input のみ表示。
// - rename 確定値は `enqueueEntityMutation({entity_type:'tag_category',
//   op:'update_field', patch:{field:'name', value}})` →
//   `runGuardedEntityMutationFlush()` で同期。 IDB は enqueue より先に
//   `getClientDb().tag_categories.update(...)` で optimistic 更新する。
// - select_type バッジは表示のみ (作成後 immutable、 spec §1.2)
// - 行末「カテゴリ削除」 button は親 (CategoryList) に onDelete callback で委譲
//   (影響範囲 count + ConfirmDialog 表示は親が orchestrate する)。 row click と
//   分離するため stopPropagation。
//
// 既存 inline-text-field.tsx の rename UX を踏襲しつつ、 タグ用は独立 component として
// コピー (OT 方針「タグ用は別実装」、 DRY より局所単純さ優先)。
// debounce drain は inline-text-field と同じ 500ms (連続編集の drain trigger 圧縮)。

import * as React from 'react'
import { Pencil } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { getClientDb, type ClientTagCategory } from '@/lib/client-db'

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

  const cancelEdit = () => {
    setEditing(false)
    setValue(category.name)
  }

  const commit = (next: string) => {
    // optimistic IDB update: mirror に即時反映 → useLiveQuery 即時再描画。
    // enqueue より **先に** 発火 (UI 即反映の保証、 mock spy 順序で gate)。
    void getClientDb()
      .tag_categories.update(category.id, {
        name: next,
        updated_at: new Date().toISOString(),
      })
      .catch((err) => {
        logger.warn({
          event: 'tag_category_inline.mirror_update_failed',
          categoryId: category.id,
          err: String(err),
        })
      })
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

  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // a11y: row 全体は role="button" tabIndex=0、 Enter / Space で active 切替
    // (pointer 操作との等価性確保)。 内部 button からの bubble は target check で
    // 弾く (input / pen icon / 削除 button が独自に preventDefault/stopPropagation
    // するため、 通常は到達しないが念のため)。
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(category.id)
    }
  }

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(category)
  }

  const handlePenClick = (e: React.MouseEvent) => {
    // row click と分離: stopPropagation で onSelect 抑止 + editing on。
    e.stopPropagation()
    setEditing(true)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      className={cn(
        'flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:bg-slate-50 cursor-pointer',
        active && 'bg-slate-100 border-slate-200',
      )}
    >
      <div className="flex-1 min-w-0 flex items-center gap-1">
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
          <>
            <span className="flex-1 text-left text-sm font-medium text-slate-900 truncate">
              {category.name}
            </span>
            <button
              type="button"
              onClick={handlePenClick}
              aria-label="編集"
              className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100"
            >
              <Pencil className="w-4 h-4" />
            </button>
          </>
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
