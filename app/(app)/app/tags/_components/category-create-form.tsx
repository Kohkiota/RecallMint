'use client'

// tag manager 左 column の新規カテゴリ作成 form。
// - name input (必須) + select_type radio (single / multi、 default multi) + 追加 button
// - submit:
//   1. crypto.randomUUID() で id 採番 (newId() helper 経由)
//   2. enqueueEntityMutation({entity_type:'tag_category', op:'create',
//      patch:{name, select_type}}) を発行
//   3. runGuardedEntityMutationFlush() で drain
//   4. form reset (name 空 / select_type=multi)
//   5. onCreated(newId) callback で親に通知 (active 切替 hook)
// - select_type は作成後 immutable (spec §1.2)、 作成時のみ選択可能
// - カテゴリ name は UNIQUE 制約なし (spec §1.2) のため client / server 共に重複 OK
//
// Tag-4a スコープ: color / sort_key は省略 (palette 変更 / D&D 並べ替えは Tag-4e)。
// registry の zod (entity-mutation-registry.ts:193-202) は color / sort_key を
// optional に許容するためここは name + select_type のみで通る。

import * as React from 'react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { newId, enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { getClientDb } from '@/lib/client-db'
import { logger } from '@/lib/logger'

type SelectType = 'single' | 'multi'

type Props = {
  // 作成成功時に新 id を親へ通知 (active 切替に使う)。 未指定でも form は動く。
  onCreated?: (id: string) => void
}

export function CategoryCreateForm({ onCreated }: Props) {
  const [name, setName] = React.useState('')
  const [selectType, setSelectType] = React.useState<SelectType>('multi')

  const trimmed = name.trim()
  const disabled = trimmed.length === 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (disabled) return

    const id = newId()

    // optimistic IDB put: mirror に即時行を挿入し useLiveQuery を即時再描画させる。
    // user_id は client から知る経路がない (Clerk 経由は server だけ) ため空文字、
    // server pull で正しい user_id に上書きされる。 sort_key は作成時 null。
    // enqueue より **先に** 発火 (UI 即反映の保証、 mock spy 順序で gate)。
    const now = new Date().toISOString()
    void getClientDb()
      .tag_categories.put({
        id,
        user_id: '',
        name: trimmed,
        select_type: selectType,
        color: null,
        sort_key: null,
        created_at: now,
        updated_at: now,
      })
      .catch((err) => {
        logger.warn({
          event: 'tag_category_create.mirror_put_failed',
          categoryId: id,
          err: String(err),
        })
      })

    void enqueueEntityMutation({
      entity_type: 'tag_category',
      entity_id: id,
      op: 'create',
      patch: { name: trimmed, select_type: selectType },
    }).catch((err) => {
      logger.warn({
        event: 'tag_category_create.enqueue_failed',
        categoryId: id,
        err: String(err),
      })
    })

    void runGuardedEntityMutationFlush().catch(() => {})

    // form reset (mutation 発行と独立に同期実行 — enqueue は fire-and-forget)。
    setName('')
    setSelectType('multi')

    onCreated?.(id)
  }

  // radio name は form 内 unique 必要 (同 page に複数 form 配置できる想定はないが defensive)。
  const radioName = React.useId()

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div>
        <Label htmlFor={`${radioName}-name`} className="sr-only">
          カテゴリ名
        </Label>
        <Input
          id={`${radioName}-name`}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新規カテゴリ名"
          aria-label="カテゴリ名"
          className="h-8 text-sm"
        />
      </div>

      <fieldset className="flex items-center gap-3">
        <legend className="sr-only">選択タイプ</legend>
        <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
          <input
            type="radio"
            name={radioName}
            value="multi"
            checked={selectType === 'multi'}
            onChange={() => setSelectType('multi')}
            aria-label="multi"
            className="cursor-pointer"
          />
          multi
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
          <input
            type="radio"
            name={radioName}
            value="single"
            checked={selectType === 'single'}
            onChange={() => setSelectType('single')}
            aria-label="single"
            className="cursor-pointer"
          />
          single
        </label>
      </fieldset>

      <Button
        type="submit"
        disabled={disabled}
        aria-label="カテゴリ追加"
        size="sm"
        className="w-full"
      >
        ＋ カテゴリ追加
      </Button>
    </form>
  )
}
