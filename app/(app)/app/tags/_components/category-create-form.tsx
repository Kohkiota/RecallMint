'use client'

// tag manager 左 column の新規カテゴリ作成 form。
// - name input (必須) + select_type radio (single / multi、 default multi) + 追加 button
// - submit:
//   1. crypto.randomUUID() で id 採番 (newId() helper 経由)
//   2. enqueueEntityMutation({entity_type:'tag_category', op:'create',
//      patch:{name, select_type, sort_key}}) を発行
//   3. runGuardedEntityMutationFlush() で drain
//   4. form reset (name 空 / select_type=multi)
//   5. onCreated(newId) callback で親に通知 (active 切替 hook)
// - select_type は作成後 immutable (spec §1.2)、 作成時のみ選択可能
// - カテゴリ name は UNIQUE 制約なし (spec §1.2) のため client / server 共に重複 OK
//
// Tag-4c-2b §4.7: 末尾採番 (`nextSortKey`) を共有 helper で適用。 IDB put + enqueue
// patch の両方に sort_key を含める (null 混在を新規作成では作らない)。 既存 null は
// reindex (`lib/tags/reindex-sort-keys.ts`) で順次 0-based 整数に正規化される。 色変更 /
// D&D 並べ替えの manager 配備は Tag-4c-2c 範疇。

import * as React from 'react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { newId, enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { getClientDb } from '@/lib/client-db'
import { logger } from '@/lib/logger'
import { nextSortKey } from '@/lib/tags/next-sort-key'

type SelectType = 'single' | 'multi'

type Props = {
  // 作成成功時に新 id を親へ通知 (active 切替に使う)。 未指定でも form は動く。
  onCreated?: (id: string) => void
  // Tag-4c-2b T7: 親 (`CategoryList`) が `useLiveQuery` で解決した既存 sort_key 群。
  // 共有 `nextSortKey` に渡して末尾採番に使う (popover create 経路と同じ semantics)。
  // 未指定 or 空配列なら起点 `'0'` (新規 user の初回作成)。
  existingSortKeys?: (string | null | undefined)[]
}

export function CategoryCreateForm({ onCreated, existingSortKeys }: Props) {
  const [name, setName] = React.useState('')
  const [selectType, setSelectType] = React.useState<SelectType>('multi')

  const trimmed = name.trim()
  const disabled = trimmed.length === 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (disabled) return

    const id = newId()
    // Tag-4c-2b §4.7: 末尾採番 (共有 helper)。 IDB put + enqueue patch の両方に流す。
    const sortKey = nextSortKey(existingSortKeys ?? [])

    // optimistic IDB put: mirror に即時行を挿入し useLiveQuery を即時再描画させる。
    // user_id は client から知る経路がない (Clerk 経由は server だけ) ため空文字、
    // server pull で正しい user_id に上書きされる。
    // enqueue より **先に** 発火 (UI 即反映の保証、 mock spy 順序で gate)。
    const now = new Date().toISOString()
    void getClientDb()
      .tag_categories.put({
        id,
        user_id: '',
        name: trimmed,
        select_type: selectType,
        color: null,
        sort_key: sortKey,
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
      patch: { name: trimmed, select_type: selectType, sort_key: sortKey },
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
