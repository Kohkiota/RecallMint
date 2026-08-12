'use client'

// tag manager 右 column の option 1 行 component。
// - 名前は static `<span>` で表示、 横の pen icon button (lucide Pencil、
//   aria-label="編集") を rename trigger として明示配置 (Tag-4a-fix Task 2、
//   category-row と同 pattern)。 row 全体は active 切替対象でないため
//   role/tabIndex は付けない (右 panel に表示中の option は全 active 扱い)。
// - 編集モード: Enter / blur で確定、 Esc / 空文字でキャンセル
// - 確定値は `enqueueEntityMutation({entity_type:'tag_option', op:'update_field',
//   patch:{field:'name', value}})` → `runGuardedEntityMutationFlush(userId)` で同期
// - color pill click で ColorPalettePopover (Task 1) を開き、 選択で
//   `update_field` patch field='color' を発行
// - 「カテゴリ変更」 button click でカスタム controlled aria menu を開き、
//   現カテゴリ以外を列挙、 選択で `update_field` patch field='category_id' を発行
// - 行末「× ボタン」 で onDelete callback (親で ConfirmDialog + 削除 mutation)
// - UNIQUE 違反の二段防御:
//   - client: rename / カテゴリ移動の commit 前に IDB で同 category 内同名を逐次
//     check (`db.tag_options.where('category_id').equals(...).filter(...).count()`)。
//     違反検出で inline error 表示 + enqueue 抑止。 Dexie の compound index は
//     `[category_id+name]` が無い (v4 で `id, user_id, category_id, updated_at`) ため
//     where + filter で対応。
//   - server: 念のため race で同名が後勝ちで残った場合の対応は Tag-4a スコープ外
//     (UNIQUE 違反 inline 文言は client 事前 + 同 message を将来 failed 受領で再利用予定)
//
// 既存 inline-text-field.tsx の rename UX を踏襲しつつ、 タグ用は独立 component で
// コピー (DRY より局所単純さ優先)。 debounce drain は category-row と同じ 500ms。

import * as React from 'react'
import { Pencil } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
// カテゴリ変更 menu は shadcn DropdownMenu を使わずカスタム controlled aria-menu で実装。
// jsdom 上のポインタイベントベースのトグル試験がし辛いため、 controlled state +
// 自前 menu semantics を採用した (Tag-4a 設計選択)。
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { runOptimisticUpdate } from '@/lib/sync/optimistic-mutation'
import { cn } from '@/lib/utils'
import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { colorToClass, type TagColorName } from '@/lib/tags/color-palette'

import { ColorPalettePopover } from './color-palette-popover'

type Props = {
  // 認証主体 (server 解決値を OptionList から thread)。 outbox 行の owner と flush の
  // owner-scope 選別の両方に使う (描画対象 `option.user_id` は使わない)。
  userId: string
  option: ClientTagOption
  // カテゴリ変更 dropdown 用、 useLiveQuery 結果を親 (OptionList) から伝播。
  // 現カテゴリ以外を内部で filter する (props 時点では現カテゴリも含めて受ける)。
  allCategories: ClientTagCategory[]
  onDelete: (option: ClientTagOption) => void
}

const DEBOUNCE_MS = 500

// IDB で同 category 内同名 option を逐次検索する。 自分自身は除外。
// where('category_id').equals(...).filter(...).count() で対応 (compound index 無し)。
async function countSameNameInCategory(
  categoryId: string,
  name: string,
  excludeOptionId: string,
): Promise<number> {
  return getClientDb()
    .tag_options.where('category_id')
    .equals(categoryId)
    .filter((o) => o.name === name && o.id !== excludeOptionId)
    .count()
}

export function OptionRow({ userId, option, allCategories, onDelete }: Props) {
  const [editing, setEditing] = React.useState(false)
  const [value, setValue] = React.useState(option.name)
  const [renameError, setRenameError] = React.useState<string | null>(null)
  const [moveError, setMoveError] = React.useState<string | null>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)

  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // 編集中以外は外部 prop (server pull 反映) で display を同期する。
  // React 19 "store info from previous renders" pattern: useEffect を外し、
  // render 中の guarded setState で同期 (cascading render 回避)。
  const [lastSyncedName, setLastSyncedName] = React.useState(option.name)
  if (!editing && option.name !== lastSyncedName) {
    setLastSyncedName(option.name)
    setValue(option.name)
  }

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
    setValue(option.name)
    setRenameError(null)
  }

  // mutation 発行 + debounce flush の共通経路。
  // sync-fix-1 T2b: `runOptimisticUpdate` (skipInternalFlush=true) で mirror update +
  // enqueue を 1 Dexie rw tx に閉じる。 ordering (mirror→enqueue) は helper tx callback
  // 内で保証 (発行順序 test が `db.tag_options.update` spy → mockEnqueue spy 経路で gate)。
  // debounce drain (500ms) は caller 側で維持 (plan §全体ルール 3)。
  const enqueueUpdate = (
    field: 'name' | 'color' | 'category_id',
    value: unknown,
  ) => {
    const now = new Date().toISOString()
    const afterPatch: Partial<ClientTagOption> = {
      updated_at: now,
      ...(field === 'name'
        ? { name: value as string }
        : field === 'color'
          ? { color: value as string | null }
          : { category_id: value as string }),
    }
    const beforeValue: Partial<ClientTagOption> = {
      updated_at: option.updated_at,
      ...(field === 'name'
        ? { name: option.name }
        : field === 'color'
          ? { color: option.color ?? null }
          : { category_id: option.category_id }),
    }
    void runOptimisticUpdate({
      // owner は常に認証主体 (props の userId)。 `option.user_id` を載せてはいけない
      // (理由は CategoryRow と同じ — 認可境界の迂回)。
      userId,
      store: getClientDb().tag_options,
      rowKey: option.id,
      beforeValue,
      afterPatch,
      mutation: {
        entity_type: 'tag_option',
        entity_id: option.id,
        op: 'update_field',
        patch: { field, value },
      },
      logEvent: `tag_option_inline.${field}.tx_failed`,
      logContext: { optionId: option.id, field },
      skipInternalFlush: true,
    })
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void runGuardedEntityMutationFlush(userId).catch(() => {})
    }, DEBOUNCE_MS)
  }

  const commitRename = async (next: string) => {
    // UNIQUE 事前チェック (同 category 内同名、 自分自身除く)。
    const dup = await countSameNameInCategory(
      option.category_id,
      next,
      option.id,
    )
    if (dup > 0) {
      setRenameError('同名が既に存在します')
      // edit mode を継続して user に修正を促す。
      return
    }
    setRenameError(null)
    setEditing(false)
    enqueueUpdate('name', next)
  }

  const handleBlur = () => {
    const trimmed = value.trim()
    // 空 / 値変更なしは commit しない (元値復元、 outbox 行を減らす)。
    if (trimmed.length === 0 || trimmed === option.name) {
      setEditing(false)
      setValue(option.name)
      setRenameError(null)
      return
    }
    void commitRename(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.target as HTMLInputElement).blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  const handleColorChange = (next: TagColorName | null) => {
    enqueueUpdate('color', next)
  }

  const handleCategoryMove = async (targetCategoryId: string) => {
    // 移動先で同名 option 存在 → enqueue 抑止 + inline error 表示。
    const dup = await countSameNameInCategory(
      targetCategoryId,
      option.name,
      option.id,
    )
    if (dup > 0) {
      setMoveError('移動先に同名 option が存在します')
      setMenuOpen(false)
      return
    }
    setMoveError(null)
    setMenuOpen(false)
    enqueueUpdate('category_id', targetCategoryId)
  }

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(option)
  }

  const otherCategories = allCategories.filter(
    (c) => c.id !== option.category_id,
  )

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1.5',
        renameError || moveError
          ? 'border-red-300 bg-red-50'
          : 'border-transparent hover:bg-slate-50',
      )}
    >
      {/* color pill (popover trigger) */}
      <ColorPalettePopover
        value={(option.color ?? null) as TagColorName | null}
        onChange={handleColorChange}
      >
        <button
          type="button"
          aria-label="option 色を変更"
          className={cn(
            'shrink-0 h-5 w-5 rounded-full border transition-all hover:scale-110',
            colorToClass(option.color ?? null),
          )}
        />
      </ColorPalettePopover>

      <div className="flex-1 min-w-0">
        {editing ? (
          <div>
            <Input
              ref={inputRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                if (renameError) setRenameError(null)
              }}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              aria-label="option 名 編集"
              className={cn(
                'h-8 text-sm',
                renameError && 'border-red-400 focus-visible:ring-red-400',
              )}
            />
            {renameError ? (
              <p className="mt-0.5 text-xs text-red-600" role="alert">
                {renameError}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <span className="flex-1 text-left text-sm font-medium text-slate-900 truncate">
              {option.name}
            </span>
            <button
              type="button"
              onClick={(e) => {
                // 親 div には onClick が無いので stopPropagation 不要だが、
                // category-row との pattern 統一感のため明示。
                e.stopPropagation()
                setRenameError(null)
                setEditing(true)
              }}
              aria-label="編集"
              className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100"
            >
              <Pencil className="w-4 h-4" />
            </button>
          </div>
        )}
        {moveError ? (
          <p className="mt-0.5 text-xs text-red-600" role="alert">
            {moveError}
          </p>
        ) : null}
      </div>

      {/*
        カテゴリ変更 dropdown。 jsdom 上でポインタイベントベースの menu の
        トグル試験がし辛いため、 controlled state + 単純な aria menu semantics で
        カスタム実装する (shadcn DropdownMenu は使用していない)。
      */}
      <div className="relative">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="カテゴリ変更"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((o) => !o)
          }}
          className="shrink-0 h-8 px-2 text-xs text-slate-600 hover:text-slate-900"
        >
          移動
        </Button>
        {menuOpen ? (
          <>
            {/* backdrop: click 外で close。 z-index は menu より下。 */}
            <button
              type="button"
              aria-hidden="true"
              tabIndex={-1}
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 z-40 cursor-default bg-transparent"
            />
            <div
              role="menu"
              aria-label="カテゴリ移動先"
              className="absolute right-0 top-full z-50 mt-1 min-w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-md"
            >
              {otherCategories.length === 0 ? (
                <div
                  role="note"
                  className="px-2 py-1.5 text-xs text-slate-500"
                >
                  他のカテゴリがありません
                </div>
              ) : (
                otherCategories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      void handleCategoryMove(c.id)
                    }}
                    className="block w-full rounded-md px-2 py-1 text-left text-sm text-slate-700 hover:bg-slate-100"
                  >
                    {c.name}
                  </button>
                ))
              )}
            </div>
          </>
        ) : null}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleDeleteClick}
        aria-label="option 削除"
        className="shrink-0 h-8 w-8 p-0 text-slate-500 hover:text-red-600"
      >
        ×
      </Button>
    </div>
  )
}
