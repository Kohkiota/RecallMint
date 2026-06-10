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
import { Pencil, CircleDot, CheckSquare } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { getClientDb, type ClientTagCategory } from '@/lib/client-db'
import { colorToClass, type TagColorName } from '@/lib/tags/color-palette'

import { ColorPalettePopover } from './color-palette-popover'

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

  // mutation 発行 + debounce flush の共通経路。 OptionRow の enqueueUpdate と
  // 同形 (Tag-4c-2c H3 で color picker を導入するに当たり rename / color を
  // 共通経路へ統合)。 optimistic IDB update は本 helper の **先頭** で発火
  // (UI 即反映の保証、 mock spy 順序で gate)。
  const enqueueUpdate = (field: 'name' | 'color', value: unknown) => {
    const now = new Date().toISOString()
    const mirrorPatch: Partial<ClientTagCategory> = {
      updated_at: now,
      ...(field === 'name'
        ? { name: value as string }
        : { color: value as string | null }),
    }
    void getClientDb()
      .tag_categories.update(category.id, mirrorPatch)
      .catch((err) => {
        logger.warn({
          event: 'tag_category_inline.mirror_update_failed',
          categoryId: category.id,
          field,
          err: String(err),
        })
      })
    void enqueueEntityMutation({
      entity_type: 'tag_category',
      entity_id: category.id,
      op: 'update_field',
      patch: { field, value },
    }).catch((err) => {
      logger.warn({
        event: 'tag_category_inline.enqueue_failed',
        categoryId: category.id,
        field,
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

  const commit = (next: string) => {
    enqueueUpdate('name', next)
  }

  const handleColorChange = (next: TagColorName | null) => {
    enqueueUpdate('color', next)
  }

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    // editing 中に color picker (popover) を開くと Radix の FocusScope が
    // popover content 内へ focus を移し、 input が blur する。 この場合は
    // editing を維持して popover 操作を継続できるようにする
    // (popover を閉じた / 外を click した場合は通常通り editing 解除 + commit)。
    const next = e.relatedTarget as HTMLElement | null
    if (next && next.closest('[data-slot="popover-content"]')) {
      return
    }
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
      {/*
        Tag-4c-2c H7b: color swatch を常時表示 (option 行と対称)。 H3 の
        編集モード限定 ColorPalettePopover はここに置換、 editing toggle と
        独立して row 最初の子に出す。 trigger は onClick で stopPropagation
        して row click (active 切替) と分離、 onMouseDown で input への
        blur を抑止 (編集モード中に swatch を開いた際の race 回避、
        handleBlur 側の popover-content gate と二段防御)。
      */}
      <ColorPalettePopover
        value={(category.color ?? null) as TagColorName | null}
        onChange={handleColorChange}
      >
        <button
          type="button"
          aria-label="カテゴリ色を変更"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            'shrink-0 h-5 w-5 rounded-full border transition-all hover:scale-110',
            colorToClass(category.color ?? null),
          )}
        />
      </ColorPalettePopover>
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

      {/*
        select_type icon (Tag-4c-2c H3): popover (card-tag-option-list の
        kind='category' 経路) と同視覚で single→CircleDot / multi→CheckSquare。
        aria-hidden + 隣接 sr-only text で読み上げ可能。 作成後 immutable。
      */}
      <span className="shrink-0 inline-flex items-center" aria-hidden="false">
        {category.select_type === 'single' ? (
          <CircleDot
            data-testid="category-select-type-icon-single"
            className="h-3.5 w-3.5 text-slate-500"
            aria-hidden="true"
          />
        ) : (
          <CheckSquare
            data-testid="category-select-type-icon-multi"
            className="h-3.5 w-3.5 text-slate-500"
            aria-hidden="true"
          />
        )}
        <span className="sr-only">タイプ: {category.select_type}</span>
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
