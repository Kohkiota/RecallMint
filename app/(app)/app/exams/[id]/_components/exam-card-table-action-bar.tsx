// ExamCardTableActionBar — Grid-2 T6: 選択 N 枚への一括操作 floating アクションバー。
//
// 画面下部固定 (fixed bottom) に「N件選択中」+ [タグ付与] [タグ除去] [移動] [削除] を出す。
//   - タグ付与/除去: CardTagAddPopover (本体無改造) を adapter で再利用。 onToggle を
//     「選択 N card に (categoryId, optionId) を bulk add/remove」に差し替える。 filter-bar
//     (T3) の adapter pattern を踏襲する。 bulk 文脈では「選択中」概念が無いので
//     allAssignedOptionIds=[] (Check 表示なし)。
//   - 削除: ExamCardBulkDeleteDialog を open し、 確定で onBulkDelete を呼ぶ。 dialog の
//     open state は本 component で持つ (useState)。
//   - 失敗 UI (BF-2 inline、 toast 非導入): lastResult.result.ok=false のとき inline 表示。
//     BulkResult は atomic all-or-nothing (T4/T5 の tx 設計) なので succeeded/failed は
//     全件/全件。 per-card 部分失敗の演出はしない。
//   - 移動 (Grid-3 §7.1): ExamCardMovePopover を同じ trigger 形で置く。 実行・toast・
//     undo は親 (ExamCardTable) が持ち、 本 bar は失敗文言 (moveError) の表示だけを担う。
//     成功時の toast を bar 配下に置けないのは、 移動で対象 card が現 exam から消えると
//     selection prune で bar 自体が unmount するため (失敗時は移動していない = 選択維持)。
//
// 'use client' は付けない: 親 ExamCardTable (= 'use client') からのみ import される子。
// file 自体に付けると Next.js TS plugin が function 型 prop を Server Action prop として
// 誤検出する (TagCell / filter-bar と同 pattern)。

import * as React from 'react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { TagEditCallbacks } from '@/lib/tags/tag-crud'
import type { BulkResult, BulkTagOp } from '../_hooks/use-bulk-card-tags'
import { CardTagAddPopover } from './card-tag-add-popover'
import { ExamCardBulkDeleteDialog } from './exam-card-bulk-delete-dialog'
import {
  ExamCardMovePopover,
  type MoveDispatch,
  type MoveDispatchOutcome,
} from './exam-card-move-popover'

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
  /** 移動 popover が mirror (exams / 移動先の card) を読むための owner scope。 */
  userId: string
  /** 現在表示中の exam (移動先の既定値)。 */
  examId: string
  /** ソート/フィルタ適用中 = 位置指定 gating (spec §7.4)。 */
  positionLocked: boolean
  /** 移動 / 切り出しの実行中 flag (popover 開閉で消えないよう親が持つ)。 */
  movePending: boolean
  /** 選択 N card を移動する (実行・toast・undo は親が持つ)。 */
  onMove: MoveDispatch
  /** 新規 exam を作って選択 N card を切り出す (spec §6.1)。 */
  onSplitOut: () => Promise<MoveDispatchOutcome>
  /** 移動系の失敗文言。 null = 表示なし。 */
  moveError: string | null
}

export function ExamCardTableActionBar({
  selectedIds,
  categories,
  options,
  tagEditCallbacks,
  onBulkTag,
  onBulkDelete,
  lastResult,
  userId,
  examId,
  positionLocked,
  movePending,
  onMove,
  onSplitOut,
  moveError,
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

        {/* 移動 (Grid-3 §7.1): 移動先 + 配置を選ぶ popover。 切り出し (b) も同 popover 内 */}
        <ExamCardMovePopover
          userId={userId}
          currentExamId={examId}
          selectedIds={selectedIds}
          positionLocked={positionLocked}
          pending={movePending}
          onMove={onMove}
          onSplitOut={onSplitOut}
          trigger={
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30"
            >
              移動
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

        {/* 移動系の失敗 (tx 失敗 / 移動先不在 / 切り出しの exam 作成失敗)。
            bulk の失敗枠とは文言の出所が違うため別 span で並べる。 */}
        {moveError && (
          <span
            data-testid="action-bar-move-error"
            className="text-xs text-red-600"
            role="alert"
          >
            {moveError}
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
