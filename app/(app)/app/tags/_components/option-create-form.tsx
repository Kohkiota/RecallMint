'use client'

// tag manager 右 column の新規 option 作成 form。
// - name input (必須) + color picker (ColorPalettePopover) + 「追加」 button
// - submit:
//   1. crypto.randomUUID() (newId 経由) で id 採番
//   2. `runOptimisticCreate` 経由で mirror put + enqueue を 1 Dexie rw tx に閉じる (sync-fix-1 T2b)
//   3. form reset (name 空 / color null)
//
// UNIQUE 事前チェック: 親 (OptionList) が useLiveQuery で active カテゴリ配下の
// option name 一覧を解決し、 props `existingNames: string[]` で渡す。 trim 後の
// name が既存にあれば 「同名が既に存在します」 inline error 表示 + submit 抑止。
//
// activeCategoryId が null の場合は親が render しない契約 (props 必須)。
// color picker は ColorPalettePopover の trigger に独立 Button を差し込む形。
//
// Tag-4c-2b §4.7: 末尾採番 (`nextSortKey`) を共有 helper で適用。 IDB put + enqueue
// patch の両方に sort_key を含める (null 混在を新規作成では作らない)。
// Sync-fix-1 T2b: 旧版の `user_id: ''` placeholder を排し、 server で解決した userId を
// props 経由で受け取る (空文字なら helper が fail-fast)。

import * as React from 'react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { newId } from '@/lib/sync/entity-mutations'
import { getClientDb } from '@/lib/client-db'
import { runOptimisticCreate } from '@/lib/sync/optimistic-mutation'
import { cn } from '@/lib/utils'
import { colorToClass, type TagColorName } from '@/lib/tags/color-palette'
import { nextSortKey } from '@/lib/tags/next-sort-key'

import { ColorPalettePopover } from './color-palette-popover'

type Props = {
  // Sync-fix-1 T2b: server で解決した users.id (UUID)。 空文字なら helper が早期 throw。
  userId: string
  // 必須。 null の場合は親が render しない (placeholder UI で吸収)。
  activeCategoryId: string
  // UNIQUE 事前チェック用、 active カテゴリ配下の現存 option name (親 useLiveQuery)。
  existingNames: string[]
  // Tag-4c-2b T7: 親 (`OptionList`) が `useLiveQuery` で解決した active category 配下の
  // 既存 sort_key 群。 共有 `nextSortKey` に渡して末尾採番に使う (popover create と同形)。
  // 未指定 or 空配列なら起点 `'0'` (active category 初回作成)。
  existingSortKeys?: (string | null | undefined)[]
}

export function OptionCreateForm({
  userId,
  activeCategoryId,
  existingNames,
  existingSortKeys = [],
}: Props) {
  const [name, setName] = React.useState('')
  const [color, setColor] = React.useState<TagColorName | null>(null)

  const trimmed = name.trim()
  const isEmpty = trimmed.length === 0
  // existingNames も trim 比較する (親側もそのまま入れる前提だが防御)。
  const isDup = !isEmpty && existingNames.some((n) => n.trim() === trimmed)
  const disabled = isEmpty || isDup

  const inputId = React.useId()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (disabled) return

    const id = newId()
    // Tag-4c-2b §4.7: 末尾採番 (共有 helper)。 IDB put + enqueue patch の両方に流す。
    const sortKey = nextSortKey(existingSortKeys)

    // helper 既定 (`throwOnError: false`) は catch 後 silent return + logger.warn 1 行。
    // ただし `userId === ''` の fail-fast (helper 入口の `throw new Error('empty user_id')`)
    // のみ caller に rethrow されるため、 unhandled rejection を作らないよう `.catch` で
    // 握りつぶす。 console.error は helper 内で既に出ているので追加 log は不要。
    void runOptimisticCreate({
      userId,
      id,
      mirrorStore: getClientDb().tag_options,
      buildRow: (newOptionId, nowIso) => ({
        id: newOptionId,
        user_id: userId,
        category_id: activeCategoryId,
        name: trimmed,
        color,
        sort_key: sortKey,
        created_at: nowIso,
        updated_at: nowIso,
      }),
      buildMutation: (newOptionId) => ({
        entity_type: 'tag_option',
        entity_id: newOptionId,
        op: 'create',
        patch: {
          category_id: activeCategoryId,
          name: trimmed,
          color,
          sort_key: sortKey,
        },
      }),
      logEvent: 'tag_option_create.tx_failed',
      logContext: { optionId: id },
    }).catch(() => {})

    // form reset (helper は fire-and-forget、 reset は sync で先行)。
    setName('')
    setColor(null)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex items-start gap-2">
        <ColorPalettePopover value={color} onChange={setColor}>
          <button
            type="button"
            aria-label="option 色を選択"
            className={cn(
              'shrink-0 h-8 w-8 rounded-full border transition-all hover:scale-110',
              colorToClass(color),
            )}
          />
        </ColorPalettePopover>

        <div className="flex-1">
          <Label htmlFor={inputId} className="sr-only">
            option 名
          </Label>
          <Input
            id={inputId}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="新規 option 名"
            aria-label="option 名"
            className={cn(
              'h-8 text-sm',
              isDup && 'border-red-400 focus-visible:ring-red-400',
            )}
          />
        </div>
      </div>

      {isDup ? (
        <p className="text-xs text-red-600" role="alert">
          同名が既に存在します
        </p>
      ) : null}

      <Button
        type="submit"
        disabled={disabled}
        aria-label="option 追加"
        size="sm"
        className="w-full"
      >
        ＋ option 追加
      </Button>
    </form>
  )
}
