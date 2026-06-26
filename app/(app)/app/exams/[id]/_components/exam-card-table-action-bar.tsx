// ExamCardTableActionBar — Grid-2 T6: 選択 N 枚への一括操作 floating アクションバー。
//
// 画面下部固定 (fixed bottom) に「N件選択中」+ [タグ付与] [タグ除去] [削除] を出す。
//   - タグ付与/除去: CardTagAddPopover (本体無改造) を adapter で再利用。 onToggle を
//     「選択 N card に (categoryId, optionId) を bulk add/remove」に差し替える。 filter-bar
//     (T3) の adapter pattern を踏襲する。 bulk 文脈では「選択中」概念が無いので
//     allAssignedOptionIds=[] (Check 表示なし)。
//   - 削除: ExamCardBulkDeleteDialog を open し、 確定で onBulkDelete を呼ぶ。 dialog の
//     open state は本 component で持つ (useState)。
//   - 失敗 UI (BF-2 inline、 toast 非導入): lastResult.result.ok=false のとき inline 表示。
//     BulkResult は atomic all-or-nothing (T4/T5 の tx 設計) なので succeeded/failed は
//     全件/全件。 per-card 部分失敗の演出はしない。
//
// 'use client' は付けない: 親 ExamCardTable (= 'use client') からのみ import される子。
// file 自体に付けると Next.js TS plugin が function 型 prop を Server Action prop として
// 誤検出する (TagCell / filter-bar と同 pattern)。

import * as React from 'react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { TagEditCallbacks } from './card-tags-section'
import type { BulkResult, BulkTagOp } from '../_hooks/use-bulk-card-tags'
import { CardTagAddPopover } from './card-tag-add-popover'
import { ExamCardBulkDeleteDialog } from './exam-card-bulk-delete-dialog'

export type ExamCardTableActionBarProps = {
  selectedIds: string[]
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  tagEditCallbacks: TagEditCallbacks
  /** 選択 N card に (categoryId, optionId) を op (add/remove) で bulk 適用する。 */
  onBulkTag: (categoryId: string, optionId: string, op: BulkTagOp) => Promise<void>
  /** 選択 N card を bulk 削除する (確認 modal 確定後に呼ばれる)。 */
  onBulkDelete: () => Promise<void>
  /** 直近 bulk 操作の結果 (失敗 UI 用)。 null = まだ操作なし。 */
  lastResult: { op: string; result: BulkResult } | null
}

export function ExamCardTableActionBar({
  selectedIds,
  categories,
  options,
  tagEditCallbacks,
  onBulkTag,
  onBulkDelete,
  lastResult,
}: ExamCardTableActionBarProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const count = selectedIds.length

  // adapter: popover の onToggle (categoryId, optionId) を bulk add/remove に差し替える。
  // 付与ボタンの popover は op='add'、 除去ボタンの popover は op='remove'。
  // void で fire (UI は失敗 state を lastResult 経由で反映)。
  const handleAddToggle = React.useCallback(
    (categoryId: string, optionId: string) => {
      void onBulkTag(categoryId, optionId, 'add')
    },
    [onBulkTag],
  )
  const handleRemoveToggle = React.useCallback(
    (categoryId: string, optionId: string) => {
      void onBulkTag(categoryId, optionId, 'remove')
    },
    [onBulkTag],
  )

  const handleDeleteConfirm = React.useCallback(() => {
    setDeleteDialogOpen(false)
    void onBulkDelete()
  }, [onBulkDelete])

  const failed =
    lastResult && !lastResult.result.ok ? lastResult.result.failed.length : 0

  return (
    <div
      data-testid="exam-card-table-action-bar"
      className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4"
    >
      <div className="flex max-w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 shadow-lg">
        <span className="text-sm font-medium text-foreground" data-testid="action-bar-count">
          {count}件選択中
        </span>

        {/* タグ付与: popover を adapter で再利用 (本体無改造) */}
        <CardTagAddPopover
          categories={categories}
          options={options}
          allAssignedOptionIds={[]}
          onToggle={handleAddToggle}
          tagEditCallbacks={tagEditCallbacks}
          trigger={
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30"
            >
              タグ付与
            </button>
          }
        />

        {/* タグ除去: popover を adapter で再利用 (op='remove')。 新規作成導線は不要なので selectOnly */}
        <CardTagAddPopover
          categories={categories}
          options={options}
          allAssignedOptionIds={[]}
          onToggle={handleRemoveToggle}
          tagEditCallbacks={tagEditCallbacks}
          selectOnly
          trigger={
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30"
            >
              タグ除去
            </button>
          }
        />

        {/* 削除: 確認 modal を open */}
        <button
          type="button"
          onClick={() => setDeleteDialogOpen(true)}
          className="rounded-md border border-red-200 bg-background px-2.5 py-1 text-sm text-red-600 hover:bg-red-50"
        >
          削除
        </button>

        {/* 失敗 UI (atomic all-or-nothing): ok=false のとき inline 表示 */}
        {failed > 0 && (
          <span
            data-testid="action-bar-error"
            className="text-xs text-red-600"
            role="alert"
          >
            {failed}件の{lastResult?.op}に失敗しました (再試行されます)
          </span>
        )}
      </div>

      <ExamCardBulkDeleteDialog
        open={deleteDialogOpen}
        count={count}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteDialogOpen(false)}
      />
    </div>
  )
}
