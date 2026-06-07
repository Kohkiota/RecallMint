'use client'

// CardTagEditFields: popover 編集 stage (editCategory / editOption) 共通 sub-component。
// - rename input: Enter / Blur で onRename (空 / 変更なし short-circuit)、
//   Esc で値を元に戻しつつイベントを parent に bubble (stage 遷移は親 popover の
//   onEscapeKeyDown が担当)
// - color picker: ColorPalettePopover を pill trigger で wrap → onChange = onColorChange
// - 削除 button: click で countImpact() → DeleteConfirmDialog open → confirm で onDelete
// - inline error: errorMessage prop が非 null なら rename input 直下に赤テキスト
//
// mutation logic (rename / color / delete の実 API call) は parent から callback 経由
// で受領する純粋 presentation component。
//
// 設計参照: Tag-4c-1 Task 2

import * as React from 'react'
import { Trash2 } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { colorToClass, type TagColorName } from '@/lib/tags/color-palette'
import { ColorPalettePopover } from '@/app/(app)/app/tags/_components/color-palette-popover'
import { DeleteConfirmDialog } from '@/app/(app)/app/tags/_components/delete-confirm-dialog'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ImpactCount = {
  optionCount?: number // category kind: 配下 option 数
  cardCount: number // 両 kind: 紐付き card 数
}

type Props = {
  kind: 'category' | 'option'
  name: string // 現在の name (rename input 初期値、 prop 変化で再同期)
  color: string | null // 現在の color
  onRename: (next: string) => Promise<void> // rename 確定
  onColorChange: (next: TagColorName | null) => Promise<void> // color 選択
  onDelete: () => Promise<void> // 削除確定 (ConfirmDialog confirm 後)
  countImpact: () => Promise<ImpactCount> // 削除 button click で count 取得
  errorMessage: string | null // 親が inline 赤テキストとして表示する内容
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CardTagEditFields({
  kind,
  name,
  color,
  onRename,
  onColorChange,
  onDelete,
  countImpact,
  errorMessage,
}: Props) {
  const [value, setValue] = React.useState(name)
  const [focused, setFocused] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [impact, setImpact] = React.useState<ImpactCount | null>(null)
  const [countError, setCountError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  // name prop が外部から変化したとき、 入力中でなければ同期する。
  // (server pull 反映など)
  React.useEffect(() => {
    if (focused) return
    setValue(name)
  }, [name, focused])

  // ------------------------------------------------------------------
  // Rename handlers
  // ------------------------------------------------------------------

  const handleBlur = () => {
    setFocused(false)
    const trimmed = value.trim()
    // 空 / 変更なし → short-circuit (元値復元)
    if (trimmed.length === 0 || trimmed === name) {
      setValue(name)
      return
    }
    // 非同期 commit。エラーは親が errorMessage prop として注入する。
    void onRename(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // blur 経由で確定 (handleBlur が空 / 変更なし short-circuit を担う)
      ;(e.target as HTMLInputElement).blur()
    } else if (e.key === 'Escape') {
      // 値を元に戻す → blur 時 short-circuit で onRename は呼ばれない。
      // stopPropagation は呼ばない → 親 popover の onEscapeKeyDown で stage 遷移。
      setValue(name)
      ;(e.target as HTMLInputElement).blur()
    }
  }

  // ------------------------------------------------------------------
  // Delete handlers
  // ------------------------------------------------------------------

  const handleDeleteClick = async () => {
    if (kind === 'option') {
      // option 削除は確認 dialog 不要 (spec: 即削除)
      setCountError(null)
      try {
        await onDelete()
      } catch {
        // 親が errorMessage prop で表示する
      }
      return
    }
    // category: 件数取得 → dialog 経路
    setCountError(null)
    try {
      const i = await countImpact()
      setImpact(i)
      setDialogOpen(true)
    } catch {
      // countImpact 失敗: 0/0 で dialog を開くと「何も紐付いていない」と誤読させる
      // ため、 dialog は開かず inline error を表示する。
      setCountError('削除前の件数取得に失敗しました')
    }
  }

  const handleConfirm = async () => {
    setDialogOpen(false) // dialog を先に閉じる
    try {
      await onDelete()
      // 成功時: 親が stage を遷移させる (component はそのまま)
    } catch {
      // 親が errorMessage を注入する形で表示するため、 ここでは swallow。
      // dialog は既に閉じており、 inline error は次 render で表示される。
    }
  }

  const kindLabel = kind === 'category' ? 'カテゴリ' : 'option'

  return (
    <div className="space-y-2">
      {/* ---------------------------------------------------------------- */}
      {/* color picker + rename input の横並び行                          */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex items-center gap-2">
        {/* color picker trigger: 現在色の pill button */}
        <ColorPalettePopover value={color as TagColorName | null} onChange={onColorChange}>
          <button
            type="button"
            aria-label="色を変更"
            className={cn(
              'inline-flex shrink-0 items-center justify-center h-7 w-7 rounded-md border',
              colorToClass(color),
            )}
          />
        </ColorPalettePopover>

        {/* rename input */}
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          aria-label={`${kindLabel}名 編集`}
          className="h-8 text-sm flex-1"
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* inline error: errorMessage (parent-injected) 優先、 なければ     */}
      {/* countError (local: countImpact 失敗) を表示する。               */}
      {/* ---------------------------------------------------------------- */}
      {(errorMessage ?? countError) && (
        <p className="text-xs text-red-600 mt-1" role="alert">
          {errorMessage ?? countError}
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* delete button                                                     */}
      {/* ---------------------------------------------------------------- */}
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => { void handleDeleteClick() }}
        className="text-red-600 hover:text-red-700 hover:bg-red-50"
      >
        <Trash2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
        削除
      </Button>

      {/* ---------------------------------------------------------------- */}
      {/* DeleteConfirmDialog: category kind のみ mount する               */}
      {/* option kind は即削除 (dialog なし) のため mount しない。         */}
      {/* ---------------------------------------------------------------- */}
      {kind === 'category' && (
        <DeleteConfirmDialog
          open={dialogOpen}
          targetKind={kind}
          targetName={name}
          childOptionCount={impact?.optionCount ?? 0}
          cardCount={impact?.cardCount ?? 0}
          onConfirm={() => {
            void handleConfirm()
          }}
          onCancel={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
