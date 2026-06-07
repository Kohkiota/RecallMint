'use client'

// tag manager 右 column の新規 option 作成 form。
// - name input (必須) + color picker (ColorPalettePopover) + 「追加」 button
// - submit:
//   1. crypto.randomUUID() (newId 経由) で id 採番
//   2. enqueueEntityMutation({entity_type:'tag_option', op:'create',
//      patch:{category_id, name, color}}) を発行
//   3. runGuardedEntityMutationFlush() で drain
//   4. form reset (name 空 / color null)
//
// UNIQUE 事前チェック: 親 (OptionList) が useLiveQuery で active カテゴリ配下の
// option name 一覧を解決し、 props `existingNames: string[]` で渡す。 trim 後の
// name が既存にあれば 「同名が既に存在します」 inline error 表示 + submit 抑止。
//
// activeCategoryId が null の場合は親が render しない契約 (props 必須)。
// color picker は ColorPalettePopover の trigger に独立 Button を差し込む形。

import * as React from 'react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { newId, enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { getClientDb } from '@/lib/client-db'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { colorToClass, type TagColorName } from '@/lib/tags/color-palette'

import { ColorPalettePopover } from './color-palette-popover'

type Props = {
  // 必須。 null の場合は親が render しない (placeholder UI で吸収)。
  activeCategoryId: string
  // UNIQUE 事前チェック用、 active カテゴリ配下の現存 option name (親 useLiveQuery)。
  existingNames: string[]
}

export function OptionCreateForm({ activeCategoryId, existingNames }: Props) {
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

    // optimistic IDB put: mirror に即時行を挿入し useLiveQuery を即時再描画させる。
    // user_id は client から知る経路がない (Clerk 経由は server だけ) ため空文字、
    // server pull で正しい user_id に上書きされる。
    // enqueue より **先に** 発火 (UI 即反映の保証、 mock spy 順序で gate)。
    const now = new Date().toISOString()
    void getClientDb()
      .tag_options.put({
        id,
        user_id: '',
        category_id: activeCategoryId,
        name: trimmed,
        color,
        sort_key: null,
        created_at: now,
        updated_at: now,
      })
      .catch((err) => {
        logger.warn({
          event: 'tag_option_create.mirror_put_failed',
          optionId: id,
          err: String(err),
        })
      })

    void enqueueEntityMutation({
      entity_type: 'tag_option',
      entity_id: id,
      op: 'create',
      patch: { category_id: activeCategoryId, name: trimmed, color },
    }).catch((err) => {
      logger.warn({
        event: 'tag_option_create.enqueue_failed',
        optionId: id,
        err: String(err),
      })
    })
    void runGuardedEntityMutationFlush().catch(() => {})

    // form reset (mutation は fire-and-forget)。
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
